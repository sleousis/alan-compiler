# Installs the Alan compiler to %LOCALAPPDATA%\alan and adds its bin folder to the user PATH.
# ALAN_VERSION picks a release (default: the newest compiler release, whose
# tag is v and a digit). ALAN_BASE_URL and ALAN_API_URL point at another
# copy of the releases and of their list, which the CI tests use.
# Runs in Windows PowerShell 5.1 and PowerShell 7, from a file or through "irm ... | iex".
# The script block keeps its variables out of the caller's session.
& {
  $ErrorActionPreference = 'Stop'
  # The progress bar makes downloads many times slower in Windows PowerShell.
  $ProgressPreference = 'SilentlyContinue'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  # Deletes a folder. A junction or symbolic link loses only the link, never
  # the folder it points at.
  function Remove-Folder($path) {
    $item = Get-Item -LiteralPath $path -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { [IO.Directory]::Delete($path) }
    else { Remove-Item -LiteralPath $path -Recurse -Force }
  }

  # Puts the old install back after an interrupted swap, so the only working
  # install is never deleted.
  function Restore-Old($dest, $old) {
    if (-not (Test-Path -LiteralPath $dest) -and (Test-Path -LiteralPath $old)) {
      [IO.Directory]::Move($old, $dest)
    }
  }

  $base = if ($env:ALAN_BASE_URL) { $env:ALAN_BASE_URL } else { 'https://github.com/sleousis/alan-compiler/releases' }
  $api = if ($env:ALAN_API_URL) { $env:ALAN_API_URL } else { 'https://api.github.com/repos/sleousis/alan-compiler' }
  $dest = $null
  $new = $null
  $old = $null
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("alan-install-" + [Guid]::NewGuid())

  try {
    if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is not set.' }
    $dest = Join-Path $env:LOCALAPPDATA 'alan'
    $new = "$dest.new"
    $old = "$dest.old"
    New-Item -ItemType Directory -Path $tmp | Out-Null
    $ver = $env:ALAN_VERSION
    if (-not $ver) {
      # GitHub's "latest" release can be an extension release, so the list
      # decides: the newest release that is not a draft or a prerelease and
      # whose tag is v and a digit. GitHub lists the newest first.
      try {
        $list = Join-Path $tmp 'releases.json'
        Invoke-WebRequest -UseBasicParsing "$api/releases?per_page=100" -OutFile $list
        $releases = Get-Content -Raw -Encoding UTF8 $list | ConvertFrom-Json
        foreach ($release in $releases) {
          if (-not $release.draft -and -not $release.prerelease -and [string]$release.tag_name -cmatch '^v[0-9]') {
            $ver = $release.tag_name
            break
          }
        }
      } catch { $ver = $null }
      if (-not $ver) { throw 'Could not find an Alan compiler release. Check your connection, or set ALAN_VERSION to a tag such as v2.0.0.' }
    }

    # OSArchitecture tells the truth in PowerShell 7 even under x64 emulation.
    # Older .NET Framework builds may lack it or report X64 there, so the
    # machine's own PROCESSOR_ARCHITECTURE in the registry decides as well.
    $arch = $null
    try { $arch = [string][System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture } catch { }
    $machine = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment').PROCESSOR_ARCHITECTURE
    $platform = if ($arch -eq 'Arm64' -or $machine -eq 'ARM64') { 'windows-arm64' } else { 'windows-x64' }

    $name = "alan-$ver-$platform.zip"
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
      if ($parts.Count -eq 2 -and $parts[1] -ceq $name) { $expected = $parts[0] }
    }
    $actual = (Get-FileHash -Algorithm SHA256 (Join-Path $tmp $name)).Hash
    if (-not $expected) { throw "SHA256SUMS of Alan $ver has no line for $name. Nothing was installed." }
    if ($actual -ine $expected) { throw "Checksum mismatch for $name. Nothing was installed." }

    try { Restore-Old $dest $old }
    catch { throw "Could not move $old from an interrupted install back to $dest. Close any program that uses it and try again." }
    foreach ($leftover in $new, $old) {
      if (Test-Path -LiteralPath $leftover) {
        try { Remove-Folder $leftover }
        catch { throw "Could not remove $leftover from an earlier install. Close any program that uses it and try again." }
      }
    }
    # ZipFile unpacks the bundle's 20000 files three times faster than Expand-Archive.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory((Join-Path $tmp $name), $new)
    if (-not (Test-Path (Join-Path $new 'alan\bin\alanc.exe'))) { throw "$name does not hold alan\bin\alanc.exe. Nothing was installed." }
    # The old install moves aside first and comes back if the new one cannot
    # take its place, so a locked file never leaves a half-deleted install.
    $hadOld = Test-Path -LiteralPath $dest
    if ($hadOld) {
      try { [IO.Directory]::Move($dest, $old) }
      catch { throw "Could not replace $dest. Close any program that uses it and try again. Nothing was installed." }
    }
    try { [IO.Directory]::Move((Join-Path $new 'alan'), $dest) }
    catch {
      if ($hadOld) { [IO.Directory]::Move($old, $dest) }
      throw "Could not move the new install into $dest. The old one is still there."
    }
    if ($hadOld) {
      try { Remove-Folder $old }
      catch { Write-Host "Could not remove $old. Delete it later." -ForegroundColor Yellow }
    }

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
    if ($dest) { try { Restore-Old $dest $old } catch { } }
    foreach ($path in $new, $tmp) {
      if ($path -and (Test-Path -LiteralPath $path)) { try { Remove-Folder $path } catch { } }
    }
  }
}
