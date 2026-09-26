# Builds alanc.exe and libalanrt.a for this Windows host into dist\<platform>\.
# Downloads the official LLVM release package into $env:RUNNER_TEMP (or
# %TEMP%) and uses win_flex_bison. The runtime is built with zig
# ($env:ALAN_ZIG, or zig on the PATH).
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Root = Split-Path -Parent $PSScriptRoot
$versions = @{}
foreach ($line in Get-Content (Join-Path $PSScriptRoot 'versions.env')) {
    if ($line -match '^\s*([A-Z_]+)=(.*)$') { $versions[$Matches[1]] = $Matches[2].Trim() }
}
$LlvmVersion = $versions['LLVM_VERSION']

switch ($env:PROCESSOR_ARCHITECTURE) {
    'AMD64' { $Arch = 'x86_64'; $Platform = 'windows-x64'; $VsArch = 'x64' }
    'ARM64' { $Arch = 'aarch64'; $Platform = 'windows-arm64'; $VsArch = 'ARM64' }
    default { throw "unsupported CPU: $env:PROCESSOR_ARCHITECTURE" }
}
$Target = "$Arch-windows-gnu"
$Zig = if ($env:ALAN_ZIG) { $env:ALAN_ZIG } else { 'zig' }
$Tmp = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }

# LLVM
$LlvmDir = $env:LLVM_DIR
if (-not $LlvmDir) {
    $name = "clang+llvm-$LlvmVersion-$Arch-pc-windows-msvc"
    $extract = Join-Path $Tmp $name
    if (-not (Test-Path $extract)) {
        $archive = Join-Path $Tmp "$name.tar.xz"
        Invoke-WebRequest -Uri "https://github.com/llvm/llvm-project/releases/download/llvmorg-$LlvmVersion/$name.tar.xz" -OutFile $archive
        # Clang, MLIR, LLDB and Flang libraries are not needed. The patterns
        # match whole paths, so none may match the top folder clang+llvm-*.
        tar -xf $archive -C $Tmp --exclude='*/lib/clang[A-Z]*' --exclude='*/lib/libclang*' `
            --exclude='*/lib/MLIR*' --exclude='*/lib/liblldb*' --exclude='*/lib/flang*' --exclude='*/lib/Fortran*'
        if ($LASTEXITCODE -ne 0) { throw 'extracting LLVM failed' }
        Remove-Item $archive
    }
    $LlvmDir = Join-Path $extract 'lib\cmake\llvm'
}

# win_flex_bison
$Bison = Get-Command win_bison.exe -ErrorAction SilentlyContinue
if (-not $Bison -and (Get-Command choco -ErrorAction SilentlyContinue)) {
    choco install winflexbison3 -y --no-progress
    if ($LASTEXITCODE -ne 0) { throw 'choco install winflexbison3 failed' }
    $env:PATH = [Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' + $env:PATH
    $Bison = Get-Command win_bison.exe -ErrorAction SilentlyContinue
}
if ($Bison) {
    $BisonExe = $Bison.Source
    $FlexExe = (Get-Command win_flex.exe).Source
} else {
    $wfb = Join-Path $Tmp 'win_flex_bison'
    if (-not (Test-Path (Join-Path $wfb 'win_bison.exe'))) {
        $zip = Join-Path $Tmp 'win_flex_bison.zip'
        Invoke-WebRequest -Uri 'https://github.com/lexxmark/winflexbison/releases/download/v2.5.25/win_flex_bison-2.5.25.zip' -OutFile $zip
        Expand-Archive -Path $zip -DestinationPath $wfb -Force
        Remove-Item $zip
    }
    $BisonExe = Join-Path $wfb 'win_bison.exe'
    $FlexExe = Join-Path $wfb 'win_flex.exe'
}

# alanc
Push-Location $Root
try {
    cmake -S . -B build -A $VsArch "-DLLVM_DIR=$LlvmDir" "-DBISON_EXECUTABLE=$BisonExe" "-DFLEX_EXECUTABLE=$FlexExe"
    if ($LASTEXITCODE -ne 0) { throw 'cmake configure failed' }
    cmake --build build --config Release --parallel
    if ($LASTEXITCODE -ne 0) { throw 'cmake build failed' }

    $dist = Join-Path 'dist' $Platform
    if (Test-Path $dist) { Remove-Item -Recurse -Force $dist }
    New-Item -ItemType Directory -Force (Join-Path $dist 'bin') | Out-Null
    Copy-Item 'build\Release\alanc.exe' (Join-Path $dist 'bin\alanc.exe')
    & (Join-Path $Root 'runtime\build.ps1') -Zig $Zig -Target $Target -OutDir (Join-Path $dist 'lib')
    Write-Host "built $dist"
} finally {
    Pop-Location
}
