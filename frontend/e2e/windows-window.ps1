param(
    [ValidateSet('main', 'message-windows', 'visible', 'close', 'tray-click')]
    [string]$Action,
    [long]$Target
)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class DesktopTestWindow {
    [DllImport("user32.dll", EntryPoint = "FindWindowExW", CharSet = CharSet.Unicode)]
    public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string className, string title);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll", EntryPoint = "PostMessageW")]
    public static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
}
'@

$zero = [IntPtr]::Zero
$handle = [IntPtr]$Target
switch ($Action) {
    'main' { (Get-Process -Id $Target).MainWindowHandle.ToInt64() }
    'message-windows' {
        $messageOnly = [IntPtr](-3)
        $anyText = [NullString]::Value
        $child = [DesktopTestWindow]::FindWindowEx($messageOnly, $zero, $anyText, $anyText)
        while ($child -ne $zero) {
            [uint32]$owner = 0
            $null = [DesktopTestWindow]::GetWindowThreadProcessId($child, [ref]$owner)
            if ($owner -eq $Target) { $child.ToInt64() }
            $child = [DesktopTestWindow]::FindWindowEx($messageOnly, $child, $anyText, $anyText)
        }
    }
    'visible' { [DesktopTestWindow]::IsWindowVisible($handle) }
    'close' {
        if (-not [DesktopTestWindow]::PostMessage($handle, 0x0010, $zero, $zero)) { throw 'WM_CLOSE failed' }
    }
    'tray-click' {
        # Wails assigns WM_USER + 1 to shell tray callbacks. WM_LBUTTONUP opens the window.
        if (-not [DesktopTestWindow]::PostMessage($handle, 0x0401, $zero, [IntPtr]0x0202)) { throw 'Tray callback failed' }
    }
}
