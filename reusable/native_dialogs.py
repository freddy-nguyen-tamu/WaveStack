"""Optional, managed-tab-scoped Windows recovery for Chrome's native repost prompt.

This is reusable browser infrastructure, not a site adapter. It never sends
keystrokes, accesses unpaired tabs, accepts login/CAPTCHA/permissions dialogs,
or changes the archiver's checkpoint/navigation rules. It only recognizes the
exact English Chrome 'Confirm Form Resubmission' warning during a requested
navigation, then invokes its explicit Continue UI Automation button once.
"""
from __future__ import annotations

import base64
import os
import subprocess

# This native Chrome dialog is NOT a JavaScript dialog and isn't guaranteed to
# emit Page.javascriptDialogOpening. Windows UI Automation is a best-effort,
# fail-closed fallback. It uses the foreground Chrome window when matching,
# otherwise searches for exactly one background window matching the managed tab.
_UIA_SCRIPT = r'''
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class ComicDialogWindow {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint command);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder name, int count);
}
'@
$expected=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__EXPECTED_TITLE__'))
$duration=__DURATION_SECONDS__
$until=[DateTime]::UtcNow.AddSeconds($duration)
$exactHeader=[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty,'Confirm Form Resubmission')
$continueCondition=[Windows.Automation.AndCondition]::new(
  [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Button),
  [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty,'Continue')
)
$cancelCondition=[Windows.Automation.AndCondition]::new(
  [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Button),
  [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty,'Cancel')
)
while ([DateTime]::UtcNow -lt $until) {
  try {
    $hwnd=[ComicDialogWindow]::GetForegroundWindow()
    # ADDITIVE: if the foreground app is Python/Command Prompt (or a different
    # browser window), locate the extension-managed Chrome window in the
    # Windows accessibility desktop tree without moving keyboard focus.
    $foregroundIsManaged=$false
    if($hwnd -ne [IntPtr]::Zero) {
      try {
        $front=[Windows.Automation.AutomationElement]::FromHandle($hwnd)
        $frontTitle=[string]$front.Current.Name
        $frontProcess=[Diagnostics.Process]::GetProcessById([int]$front.Current.ProcessId).ProcessName
        $frontClass=New-Object Text.StringBuilder 256
        [void][ComicDialogWindow]::GetClassName($hwnd,$frontClass,$frontClass.Capacity)
        $foregroundIsManaged=($expected.Length -ge 18 -and $frontTitle.Contains($expected) -and
          $frontClass.ToString() -eq 'Chrome_WidgetWin_1' -and $frontProcess -in @('chrome','msedge'))
      } catch { $foregroundIsManaged=$false }
    }
    if(-not $foregroundIsManaged) {
      $matches=New-Object System.Collections.ArrayList
      $desktop=[Windows.Automation.AutomationElement]::RootElement
      $windows=$desktop.FindAll([Windows.Automation.TreeScope]::Children,[Windows.Automation.Condition]::TrueCondition)
      for($i=0;$i -lt $windows.Count;$i++) {
        try {
          $window=$windows.Item($i)
          $name=[string]$window.Current.Name
          if($expected.Length -lt 18 -or -not $name.Contains($expected)) {continue}
          $processName=[Diagnostics.Process]::GetProcessById([int]$window.Current.ProcessId).ProcessName
          if($processName -notin @('chrome','msedge')) {continue}
          $candidate=[IntPtr]([int]$window.Current.NativeWindowHandle)
          if($candidate -eq [IntPtr]::Zero) {continue}
          $candidateClass=New-Object Text.StringBuilder 256
          [void][ComicDialogWindow]::GetClassName($candidate,$candidateClass,$candidateClass.Capacity)
          if($candidateClass.ToString() -ne 'Chrome_WidgetWin_1') {continue}
          [void]$matches.Add($candidate)
        } catch {continue}
      }
      # Do not select a random tab when two Chrome windows share a title.
      $hwnd=[IntPtr]::Zero
      if($matches.Count -eq 1) {$hwnd=$matches.Item(0)}
    }
    if($hwnd -ne [IntPtr]::Zero) {
      $pidValue=[uint32]0
      [void][ComicDialogWindow]::GetWindowThreadProcessId($hwnd,[ref]$pidValue)
      $klass=New-Object Text.StringBuilder 256
      [void][ComicDialogWindow]::GetClassName($hwnd,$klass,$klass.Capacity)
      if($klass.ToString() -eq 'Chrome_WidgetWin_1' -and $pidValue -gt 0) {
        $browserProcess=[Diagnostics.Process]::GetProcessById([int]$pidValue).ProcessName
        if($browserProcess -in @('chrome','msedge')) {
          $root=[Windows.Automation.AutomationElement]::FromHandle($hwnd)
          $windowTitle=[string]$root.Current.Name
          # The expected title is copied directly from the extension-owned tab.
          # Never operate on a different Chrome window (or unrelated app).
          if($expected.Length -ge 18 -and $windowTitle.Contains($expected)) {
            $header=$root.FindFirst([Windows.Automation.TreeScope]::Descendants,$exactHeader)
            # ADDITIVE: some Chrome versions put tab-modal prompts in a separate
            # Chrome_WidgetWin_1 owned by the matched managed-browser HWND.
            # Accept a popup ONLY when its Win32 owner is the verified browser.
            if($null -eq $header) {
              $owned=New-Object System.Collections.ArrayList
              $desktop=[Windows.Automation.AutomationElement]::RootElement
              $popups=$desktop.FindAll([Windows.Automation.TreeScope]::Children,[Windows.Automation.Condition]::TrueCondition)
              for($i=0;$i -lt $popups.Count;$i++) {
                try {
                  $popup=$popups.Item($i)
                  $popupHwnd=[IntPtr]([int]$popup.Current.NativeWindowHandle)
                  if($popupHwnd -eq [IntPtr]::Zero -or [ComicDialogWindow]::GetWindow($popupHwnd,4) -ne $hwnd) {continue} # GW_OWNER
                  $popupClass=New-Object Text.StringBuilder 256
                  [void][ComicDialogWindow]::GetClassName($popupHwnd,$popupClass,$popupClass.Capacity)
                  if($popupClass.ToString() -ne 'Chrome_WidgetWin_1') {continue}
                  $popupProcess=[Diagnostics.Process]::GetProcessById([int]$popup.Current.ProcessId).ProcessName
                  if($popupProcess -notin @('chrome','msedge')) {continue}
                  $popupHeader=$popup.FindFirst([Windows.Automation.TreeScope]::Descendants,$exactHeader)
                  if($null -ne $popupHeader) {[void]$owned.Add([pscustomobject]@{Root=$popup;Header=$popupHeader})}
                } catch {continue}
              }
              if($owned.Count -eq 1) {
                $root=$owned.Item(0).Root
                $header=$owned.Item(0).Header
              }
            }
            if($null -ne $header) {
              $walker=[Windows.Automation.TreeWalker]::ControlViewWalker
              $container=$header
              for($level=0;$level -lt 7;$level++) {
                $container=$walker.GetParent($container)
                if($null -eq $container -or $container.Equals($root)) {break}
                $yes=$container.FindAll([Windows.Automation.TreeScope]::Descendants,$continueCondition)
                $no=$container.FindAll([Windows.Automation.TreeScope]::Descendants,$cancelCondition)
                if($yes.Count -ne 1 -or $no.Count -ne 1) {continue}
                if(-not $yes.Item(0).Current.IsEnabled) {break}
                # Exactly one native dialog with exact title + both buttons.
                $pattern=$yes.Item(0).GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)
                $pattern.Invoke()
                Write-Output 'BROWSER_DIALOG_AUTO_ACCEPTED kind=chrome_form_resubmission'
                exit 0
              }
            }
          }
        }
      }
    }
  } catch {
    # Dialogs are transient; stale UIA objects are normal during reload.
    # Never act on an unverified or ambiguously matched Chrome window.
  }
  Start-Sleep -Milliseconds 350
}
'''


def _title_key(value: str) -> str:
    """Use a nonempty prefix to match Chrome's title (+ browser suffix)."""
    clean = ' '.join(str(value or '').strip().split())
    if len(clean) < 18 or '\x00' in clean:
        return ''
    return clean[:48]


class ManagedNativeDialogWatcher:
    """One short-lived, fail-closed monitor per explicit managed-tab navigation."""

    def __init__(self, tab_title: str, *, timeout: float = 105):
        self.title = _title_key(tab_title)
        self.timeout = max(1, min(float(timeout), 120))
        self.process = None

    def start(self):
        if os.name != 'nt':
            return self
        if not self.title:
            print('BROWSER_DIALOG_MONITOR_SKIPPED reason=managed_tab_title_missing', flush=True)
            return self
        encoded_title = base64.b64encode(self.title.encode('utf-8')).decode('ascii')
        script = (_UIA_SCRIPT.replace('__EXPECTED_TITLE__', encoded_title)
                 .replace('__DURATION_SECONDS__', str(int(self.timeout))))
        encoded_script = base64.b64encode(script.encode('utf-16le')).decode('ascii')
        try:
            self.process = subprocess.Popen(
                ['powershell.exe', '-NoProfile', '-NonInteractive',
                 '-EncodedCommand', encoded_script],
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            print('BROWSER_DIALOG_MONITOR_ARMED kind=chrome_form_resubmission', flush=True)
        except (OSError, ValueError) as exc:
            print('BROWSER_DIALOG_MONITOR_START_FAILED: '+type(exc).__name__, flush=True)
            # Native UIAutomation is optional and must never break normal
            # navigation on unsupported platforms or restricted Windows hosts.
            self.process = None
        return self

    def close(self):
        if self.process is None:
            return False
        proc, self.process = self.process, None
        if proc.poll() is None:
            proc.terminate()
        try:
            output, _ = proc.communicate(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()
            output, _ = proc.communicate(timeout=2)
        accepted = b'BROWSER_DIALOG_AUTO_ACCEPTED kind=chrome_form_resubmission' in (output or b'')
        if accepted:
            print('BROWSER_DIALOG_AUTO_ACCEPTED kind=chrome_form_resubmission', flush=True)
        elif proc.returncode not in (None, 0, -15, 1):
            print('BROWSER_DIALOG_MONITOR_EXIT code='+str(proc.returncode), flush=True)
        return accepted
