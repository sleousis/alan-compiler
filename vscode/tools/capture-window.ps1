# Captures the VS Code window of a test instance, and nothing else on the
# screen. Called by tools/capture/driver.ts from inside that instance; see
# tools/capture-screenshots.mjs for how to regenerate the Marketplace images.
#
# The window is found from the extension host's process id: its parent chain
# leads to the main Code process, which owns the window. PrintWindow draws the
# window itself, so other windows over it never end up in the image.
#
#   -Setup                 move the window to 40,40 and size it to -Width x -Height
#   -Out file.png          save one capture
#   -FramesDir dir         save captures every -IntervalMs for -DurationMs, named
#                          by their time in ms; writes dir\ready when it starts
param(
  [Parameter(Mandatory = $true)][int]$ExtHostPid,
  [switch]$Setup,
  [int]$Width = 1280,
  [int]$Height = 800,
  [string]$Out,
  [string]$FramesDir,
  [int]$DurationMs = 5000,
  [int]$IntervalMs = 120
)
$ErrorActionPreference = 'Stop'

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

public static class CodeWindow {
  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hwnd);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int max);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int cmd);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT rect, int size);

  public static IntPtr Find(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != pid || !IsWindowVisible(h) || GetWindowTextLength(h) == 0) return true;
      var cls = new StringBuilder(64); GetClassName(h, cls, 64);
      if (cls.ToString() != "Chrome_WidgetWin_1") return true;
      found = h; return false;
    }, IntPtr.Zero);
    return found;
  }

  /** The visible frame, without the invisible resize borders of Windows 11. */
  static RECT Frame(IntPtr h) {
    RECT r;
    if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) GetWindowRect(h, out r);
    return r;
  }

  /** Sizes the window so its visible frame is w x h. */
  public static void Place(IntPtr h, int w, int hgt) {
    ShowWindow(h, 9); // SW_RESTORE, in case it opened maximized
    SetWindowPos(h, IntPtr.Zero, 40, 40, w, hgt, 0x0004 | 0x0010); // NOZORDER | NOACTIVATE
    RECT outer, frame; GetWindowRect(h, out outer); frame = Frame(h);
    int dw = (outer.Right - outer.Left) - (frame.Right - frame.Left);
    int dh = (outer.Bottom - outer.Top) - (frame.Bottom - frame.Top);
    if (dw != 0 || dh != 0) SetWindowPos(h, IntPtr.Zero, 40, 40, w + dw, hgt + dh, 0x0004 | 0x0010);
  }

  public static Bitmap Capture(IntPtr h) {
    RECT outer; GetWindowRect(h, out outer); RECT frame = Frame(h);
    int ow = outer.Right - outer.Left, oh = outer.Bottom - outer.Top;
    using (var full = new Bitmap(ow, oh, PixelFormat.Format32bppArgb)) {
      using (var g = Graphics.FromImage(full)) {
        IntPtr hdc = g.GetHdc();
        PrintWindow(h, hdc, 2); // PW_RENDERFULLCONTENT: needed for GPU-drawn windows
        g.ReleaseHdc(hdc);
      }
      var crop = new Rectangle(frame.Left - outer.Left, frame.Top - outer.Top, frame.Right - frame.Left, frame.Bottom - frame.Top);
      return full.Clone(crop, PixelFormat.Format24bppRgb);
    }
  }
}
'@

[CodeWindow]::SetProcessDPIAware() | Out-Null

# Walk up from the extension host to the main Code process.
$procs = @{}
Get-CimInstance Win32_Process | ForEach-Object { $procs[[int]$_.ProcessId] = $_ }
$mainPid = $ExtHostPid
while ($procs.ContainsKey($mainPid)) {
  $parent = [int]$procs[$mainPid].ParentProcessId
  if (-not $procs.ContainsKey($parent) -or $procs[$parent].Name -ne $procs[$ExtHostPid].Name) { break }
  $mainPid = $parent
}
$hwnd = [CodeWindow]::Find([uint32]$mainPid)
if ($hwnd -eq [IntPtr]::Zero) { throw "No VS Code window for process $mainPid." }

if ($Setup) { [CodeWindow]::Place($hwnd, $Width, $Height) }

if ($Out) {
  $bmp = [CodeWindow]::Capture($hwnd)
  $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

if ($FramesDir) {
  New-Item -ItemType Directory -Force $FramesDir | Out-Null
  Set-Content (Join-Path $FramesDir 'ready') ''
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $next = 0
  while ($clock.ElapsedMilliseconds -lt $DurationMs) {
    $t = $clock.ElapsedMilliseconds
    $bmp = [CodeWindow]::Capture($hwnd)
    $bmp.Save((Join-Path $FramesDir ('{0:D6}.png' -f $t)), [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    $next += $IntervalMs
    $wait = $next - $clock.ElapsedMilliseconds
    if ($wait -gt 0) { Start-Sleep -Milliseconds $wait }
  }
}
