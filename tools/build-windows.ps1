# Builds alanc.exe and libalanrt.a for this Windows host into dist\<platform>\.
# Downloads the official LLVM release package and win_flex_bison, and builds
# zlib and zstd, in $env:RUNNER_TEMP (or %TEMP%). The runtime is built with
# zig ($env:ALAN_ZIG, or zig on the PATH).
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

# win_flex_bison 2.5.25 (bison 3.8.2, flex 2.6.4). The runners may have an
# older copy with bison 3.7 on the PATH, so always use this one. It is x64
# and runs under emulation on ARM64.
$wfb = Join-Path $Tmp 'win_flex_bison-2.5.25'
if (-not (Test-Path (Join-Path $wfb 'win_bison.exe'))) {
    $zip = Join-Path $Tmp 'win_flex_bison.zip'
    Invoke-WebRequest -Uri 'https://github.com/lexxmark/winflexbison/releases/download/v2.5.25/win_flex_bison-2.5.25.zip' -OutFile $zip
    Expand-Archive -Path $zip -DestinationPath $wfb -Force
    Remove-Item $zip
}
$BisonExe = Join-Path $wfb 'win_bison.exe'
$FlexExe = Join-Path $wfb 'win_flex.exe'

# Builds a static library with CMake and the static C runtime, like alanc,
# and installs it into $Tmp\<name>-<arch>. Returns the install folder.
function Install-StaticLibrary([string]$Name, [string]$Url, [string]$SourceDir, [string[]]$CMakeArgs) {
    $prefix = Join-Path $Tmp "$Name-$VsArch"
    if (-not (Test-Path (Join-Path $prefix 'lib'))) {
        $archive = Join-Path $Tmp "$Name.tar.gz"
        Invoke-WebRequest -Uri $Url -OutFile $archive
        tar -xf $archive -C $Tmp
        if ($LASTEXITCODE -ne 0) { throw "extracting $Name failed" }
        Remove-Item $archive
        $build = Join-Path $Tmp "$Name-build-$VsArch"
        cmake -S (Join-Path $Tmp $SourceDir) -B $build -A $VsArch "-DCMAKE_INSTALL_PREFIX=$prefix" `
            -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded -DCMAKE_POLICY_DEFAULT_CMP0091=NEW @CMakeArgs | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "$Name configure failed" }
        cmake --build $build --config Release --target install | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "$Name build failed" }
        Remove-Item -Recurse -Force (Join-Path $Tmp $SourceDir.Split('\')[0]), $build
    }
    return $prefix
}

# zlib and zstd, which the LLVM release libraries use.
$ZlibVersion = $versions['ZLIB_VERSION']
$zlib = Install-StaticLibrary "zlib-$ZlibVersion" `
    "https://github.com/madler/zlib/releases/download/v$ZlibVersion/zlib-$ZlibVersion.tar.gz" `
    "zlib-$ZlibVersion" @('-DZLIB_BUILD_SHARED=OFF', '-DZLIB_BUILD_TESTING=OFF')
$ZlibLib = @(Get-ChildItem (Join-Path $zlib 'lib') -Filter *.lib)[0].FullName
$ZstdVersion = $versions['ZSTD_VERSION']
$zstd = Install-StaticLibrary "zstd-$ZstdVersion" `
    "https://github.com/facebook/zstd/releases/download/v$ZstdVersion/zstd-$ZstdVersion.tar.gz" `
    "zstd-$ZstdVersion\build\cmake" @('-DZSTD_BUILD_SHARED=OFF', '-DZSTD_BUILD_PROGRAMS=OFF',
        '-DZSTD_BUILD_TESTS=OFF', '-DZSTD_USE_STATIC_RUNTIME=ON')
$ZstdLib = Join-Path $zstd 'lib\zstd_static.lib'

# The DIA SDK that comes with Visual Studio, which LLVMExports refers to.
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$DiaSdk = Join-Path (& $vswhere -latest -products * -property installationPath) 'DIA SDK'

# alanc
Push-Location $Root
try {
    cmake -S . -B build -A $VsArch "-DLLVM_DIR=$LlvmDir" "-DBISON_EXECUTABLE=$BisonExe" "-DFLEX_EXECUTABLE=$FlexExe" `
        "-DZLIB_INCLUDE_DIR=$zlib\include" "-DZLIB_LIBRARY=$ZlibLib" `
        "-Dzstd_INCLUDE_DIR=$zstd\include" "-Dzstd_LIBRARY=$ZstdLib" "-DMSVC_DIA_SDK_DIR=$DiaSdk"
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
