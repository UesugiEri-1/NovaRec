param(
  [string]$ProcessName = "NovaRec",
  [int]$TimeoutSec = 40,
  [string]$ShotPath = "artifacts\dist-launch.png"
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Write-Output "ROOT=$root"
$deadline = (Get-Date).AddSeconds($TimeoutSec)
$proc = $null
while ((Get-Date) -lt $deadline) {
  $cand = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
          Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle.Length -gt 0 } |
          Select-Object -First 1
  if ($cand) { $proc = $cand; break }
  Start-Sleep -Milliseconds 500
}
$allProcs = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue
Write-Output ("PROC_COUNT=" + @($allProcs).Count)
if (-not $proc) {
  Write-Output "NO_WINDOW"
  foreach ($p in @($allProcs)) { Write-Output ("PID_NO_TITLE=" + $p.Id) }
  exit 2
}
Write-Output ("WINDOW_PID=" + $proc.Id)
Write-Output ("WINDOW_TITLE=" + $proc.MainWindowTitle)
$hwnd = $proc.MainWindowHandle

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class NRWin2 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out NRRect rect);
  [StructLayout(LayoutKind.Sequential)] public struct NRRect { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
if ([NRWin2]::IsIconic($hwnd)) { [NRWin2]::ShowWindow($hwnd, 9) | Out-Null }
[NRWin2]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 1500
$rect = New-Object NRWin2+NRRect
[NRWin2]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
Write-Output ("WINDOW_RECT=" + $rect.Left + "," + $rect.Top + "," + $rect.Right + "," + $rect.Bottom)
Write-Output ("WINDOW_SIZE=" + ($rect.Right - $rect.Left) + "x" + ($rect.Bottom - $rect.Top))

$shotScript = Join-Path $PSScriptRoot "shot-screen.ps1"
& $shotScript | Out-Null
$shotSrc = Join-Path $root "artifacts\ui-shot.png"
$shotDst = if ([System.IO.Path]::IsPathRooted($ShotPath)) { $ShotPath } else { Join-Path $root $ShotPath }
if (Test-Path $shotSrc) {
  Copy-Item -Force $shotSrc $shotDst
  Write-Output ("SHOT_PATH=" + $shotDst)
  Write-Output ("SHOT_BYTES=" + (Get-Item $shotDst).Length)
} else {
  Write-Output "NO_SHOT"
  exit 3
}
exit 0
