# usage: build.ps1 -Zig <zig> -Target <target> -OutDir <outdir>
param([string]$Zig, [string]$Target, [string]$OutDir)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $OutDir | Out-Null
$objs = @()
foreach ($f in 'io', 'str', 'conv') {
    $obj = Join-Path $OutDir "$f.o"
    & $Zig cc -target $Target -O2 -std=c17 -c (Join-Path $PSScriptRoot "$f.c") -o $obj
    if ($LASTEXITCODE -ne 0) { throw "zig cc failed for $f.c" }
    $objs += $obj
}
$lib = Join-Path $OutDir 'libalanrt.a'
if (Test-Path $lib) { Remove-Item $lib }
& $Zig ar rcs $lib @objs
if ($LASTEXITCODE -ne 0) { throw 'zig ar failed' }
Remove-Item $objs
