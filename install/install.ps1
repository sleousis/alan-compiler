# Installs the Alan compiler to %LOCALAPPDATA%\alan and adds its bin folder to the user PATH.
# ALAN_VERSION picks a release (default: the latest). ALAN_BASE_URL points at
# another copy of the releases, which the CI tests use.
# Runs in Windows PowerShell 5.1 and PowerShell 7, from a file or through "irm ... | iex".
# The script block keeps its variables out of the caller's session.
& {
  $ErrorActionPreference = 'Stop'
  # The progress bar makes downloads many times slower in Windows PowerShell.
  $ProgressPreference = 'SilentlyContinue'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $base = if ($env:ALAN_BASE_URL) { $env:ALAN_BASE_URL } else { 'https://github.com/sleousis/alan-compiler/releases' }
  $dest = Join-Path $env:LOCALAPPDATA 'alan'
  $new = "$dest.new"
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("alan-install-" + [Guid]::NewGuid())

  try {
    $ver = $env:ALAN_VERSION
    if (-not $ver) {
      try {
        $ver = (Invoke-RestMethod -UseBasicParsing 'https://api.github.com/repos/sleousis/alan-compiler/releases/latest').tag_name
      } catch { $ver = $null }
      if (-not $ver) { throw 'Could not find the latest Alan release.' }
    }

    # OSArchitecture tells the truth in PowerShell 7 even under x64 emulation.
    # Older .NET Framework builds may lack it or report X64 there, so the
    # machine's own PROCESSOR_ARCHITECTURE in the registry decides as well.
    $arch = $null
    try { $arch = [string][System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture } catch { }
    $machine = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment').PROCESSOR_ARCHITECTURE
    $platform = if ($arch -eq 'Arm64' -or $machine -eq 'ARM64') { 'windows-arm64' } else { 'windows-x64' }

    $name = "alan-$ver-$platform.zip"
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
      Invoke-WebRequest -UseBasicParsing "$base/download/$ver/$name" -OutFile (Join-Path $tmp $name)
    } catch {
      $response = $_.Exception.Response
      if ($response -and [int]$response.StatusCode -eq 404) { throw "Alan $ver has no download for $platform." }
      throw "Could not download $name. Check your connection."
    }
    try {
      Invoke-WebRequest -UseBasicParsing "$base/download/$ver/SHA256SUMS" -OutFile (Join-Path $tmp 'SHA256SUMS')
    } catch { throw "Could not download the SHA256SUMS of Alan $ver." }

    $expected = $null
    foreach ($line in Get-Content (Join-Path $tmp 'SHA256SUMS')) {
      $parts = $line -split '\s+\*?', 2
      if ($parts.Count -eq 2 -and $parts[1] -eq $name) { $expected = $parts[0] }
    }
    $actual = (Get-FileHash -Algorithm SHA256 (Join-Path $tmp $name)).Hash
    if (-not $expected -or $actual -ine $expected) { throw "Checksum mismatch for $name. Nothing was installed." }

    # ZipFile unpacks the bundle's 20000 files three times faster than Expand-Archive.
    if (Test-Path $new) { Remove-Item -Recurse -Force $new }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory((Join-Path $tmp $name), $new)
    if (-not (Test-Path (Join-Path $new 'alan\bin\alanc.exe'))) { throw "$name does not hold alan\bin\alanc.exe. Nothing was installed." }
    if (Test-Path $dest) {
      try { Remove-Item -Recurse -Force $dest }
      catch { throw "Could not remove the old $dest. Close any program that uses it and try again." }
    }
    Move-Item (Join-Path $new 'alan') $dest

    # Only the user PATH changes. The registry value is read and written as
    # is, so entries such as %USERPROFILE%\... stay unexpanded.
    $bin = Join-Path $dest 'bin'
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    try {
      $userPath = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      $entries = @($userPath -split ';' | Where-Object { $_ -ne '' })
      $present = $entries | Where-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') -ieq $bin }
      if (-not $present) {
        $key.SetValue('Path', (($entries + $bin) -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
        # Setting a variable through .NET tells Explorer and new terminals to
        # reload the environment. The helper variable is removed right away.
        [Environment]::SetEnvironmentVariable('ALAN_INSTALL_REFRESH', '1', 'User')
        [Environment]::SetEnvironmentVariable('ALAN_INSTALL_REFRESH', $null, 'User')
      }
    } finally { $key.Close() }
    if (-not (($env:Path -split ';') | Where-Object { $_.TrimEnd('\') -ieq $bin })) { $env:Path = "$bin;$env:Path" }

    Write-Host "Installed Alan $ver ($platform). Run: alanc run hello.alan"
    Write-Host "Open a new terminal if alanc is not found."
    Write-Host "To uninstall: Remove-Item -Recurse -Force '$dest', then remove $bin"
    Write-Host "from Path under 'Edit environment variables for your account' in Windows settings."
  } catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    # From a file, fail the process. Through iex, keep the user's window open.
    if ($PSCommandPath) { exit 1 }
    $global:LASTEXITCODE = 1
  } finally {
    if (Test-Path $new) { Remove-Item -Recurse -Force $new -ErrorAction SilentlyContinue }
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
  }
}
