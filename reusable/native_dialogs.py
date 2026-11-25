"""Optional, managed-tab-scoped Windows recovery for Chrome's native repost prompt.

This is reusable browser infrastructure, not a site adapter. It never sends
keystrokes, accesses unpaired tabs, accepts login/CAPTCHA/permissions dialogs,
or changes the archiver's checkpoint/navigation rules. It only recognizes the
exact English Chrome 'Confirm Form Resubmission' warning during managed browser
I/O, then invokes its explicit Continue UI Automation button once.
"""
from __future__ import annotations

import base64
import os
import subprocess

# This native Chrome dialog is NOT a JavaScript dialog and isn't guaranteed to
# emit Page.javascriptDialogOpening. Windows UI Automation is a best-effort,
# fail-closed fallback. It
# searches for exactly one window matching the managed tab, regardless of focus.
_UIA_SCRIPT = r'''
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class ComicDialogWindow {
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
# Match the full document title and its browser-app suffix, not a prefix of
# another chapter title. Do not let foreground focus break ambiguity checks.
function Test-ManagedTitle([string]$name) {
  return ($name -eq $expected -or $name -eq ($expected+' - Google Chrome') -or $name -eq ($expected+' - Microsoft Edge') -or $name -eq ($expected+' - Chromium'))
}
function Test-NativeElement($element,$boundary) {
  # Website DOM can expose identically named headings/buttons via UIA. A
  # browser-owned native prompt must not live beneath a web Document node.
  $raw=[Windows.Automation.TreeWalker]::RawViewWalker
  for($depth=0;$depth -lt 32 -and $null -ne $element;$depth++) {
    if($element.Current.ControlType -eq [Windows.Automation.ControlType]::Document) {return $false}
    if($element.Equals($boundary)) {return $true}
    $element=$raw.GetParent($element)
  }
  return $false
}
$reportedError=$false
$invoked=$false
Write-Output 'BROWSER_DIALOG_UIA_READY'
while ([DateTime]::UtcNow -lt $until) {
  try {
    # Focus is irrelevant. Require exactly one matching browser window.
      $matches=New-Object System.Collections.ArrayList
      $desktop=[Windows.Automation.AutomationElement]::RootElement
      $windows=$desktop.FindAll([Windows.Automation.TreeScope]::Children,[Windows.Automation.Condition]::TrueCondition)
      for($i=0;$i -lt $windows.Count;$i++) {
        try {
          $window=$windows.Item($i)
          $name=[string]$window.Current.Name
          if($expected.Length -lt 18 -or -not (Test-ManagedTitle $name)) {continue}
          $processName=[Diagnostics.Process]::GetProcessById([int]$window.Current.ProcessId).ProcessName
          if($processName -notin @('chrome','msedge')) {continue}
          $candidate=[IntPtr]([int]$window.Current.NativeWindowHandle)
          if($candidate -eq [IntPtr]::Zero) {continue}
          $candidateClass=New-Object Text.StringBuilder 256
          [void][ComicDialogWindow]::GetClassName($candidate,$candidateClass,$candidateClass.Capacity)
          if($candidateClass.ToString() -ne 'Chrome_WidgetWin_1') {continue}
          [void]$matches.Add($candidate)
        } catch {if(-not $reportedError) {Write-Output ('BROWSER_DIALOG_UIA_ERROR: '+$_.Exception.Message);$reportedError=$true};continue}
      }
      # Do not select a random tab when two Chrome windows share a title.
      $hwnd=[IntPtr]::Zero
      if($matches.Count -eq 1) {$hwnd=$matches.Item(0)}
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
          if($expected.Length -ge 18 -and (Test-ManagedTitle $windowTitle)) {
            $headers=@($root.FindAll([Windows.Automation.TreeScope]::Subtree,$exactHeader) | Where-Object {Test-NativeElement $_ $root})
            $header=$null
            if($headers.Count -gt 0) {$header=$headers[0]}
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
                  if($popupProcess -notin @('chrome','msedge') -or $popup.Current.ProcessId -ne $pidValue) {continue}
                  $popupHeader=$popup.FindFirst([Windows.Automation.TreeScope]::Subtree,$exactHeader)
                  if($null -ne $popupHeader -and (Test-NativeElement $popupHeader $popup)) {[void]$owned.Add([pscustomobject]@{Root=$popup;Header=$popupHeader})}
                } catch {if(-not $reportedError) {Write-Output ('BROWSER_DIALOG_UIA_ERROR: '+$_.Exception.Message);$reportedError=$true};continue}
              }
              if($owned.Count -eq 1) {
                $root=$owned.Item(0).Root
                $header=$owned.Item(0).Header
              }
            }
            if($null -ne $header) {
              $walker=[Windows.Automation.TreeWalker]::RawViewWalker
              $container=$header
              for($level=0;$level -lt 12;$level++) {
                if($null -eq $container) {break}
                $atRoot=$container.Equals($root)
                $yes=@($container.FindAll([Windows.Automation.TreeScope]::Descendants,$continueCondition) | Where-Object {Test-NativeElement $_ $root})
                $no=@($container.FindAll([Windows.Automation.TreeScope]::Descendants,$cancelCondition) | Where-Object {Test-NativeElement $_ $root})
                if($yes.Count -eq 1 -and $no.Count -eq 1 -and $yes[0].Current.IsEnabled -and -not $yes[0].Current.IsOffscreen) {
                  # At the full browser root require the native warning text too;
                  # do not combine unrelated browser toolbar buttons with a heading.
                  if($atRoot -and $root.Current.NativeWindowHandle -eq $hwnd.ToInt64()) {
                    $messageFound=$false
                    $nativeText=$container.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Text))
                    foreach($item in $nativeText) {
                      if((Test-NativeElement $item $root) -and ([string]$item.Current.Name -match '(?i)information that you entered|action you took to be repeated|resubmit')) {$messageFound=$true;break}
                    }
                    if(-not $messageFound) {break}
                  }
                  # No keystrokes or coordinate clicks: invoke the specific native button.
                  $dialogHwnd=$root.Current.NativeWindowHandle
                  $pattern=$yes[0].GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)
                  Write-Output 'BROWSER_DIALOG_DETECTED kind=chrome_form_resubmission'
                  $invoked=$true
                  $pattern.Invoke()
                  Write-Output 'BROWSER_DIALOG_CONTINUE_INVOKED'
                  # Re-query the live native UI, not a stale cached element. Never
                  # invoke twice if the first action might already have worked.
                  for($check=0;$check -lt 20;$check++) {
                    Start-Sleep -Milliseconds 250
                    try {
                      $remaining=@($root.FindAll([Windows.Automation.TreeScope]::Subtree,$exactHeader) | Where-Object { (Test-NativeElement $_ $root) -and -not $_.Current.IsOffscreen })
                      if($remaining.Count -eq 0) {
                        Write-Output 'BROWSER_DIALOG_AUTO_ACCEPTED kind=chrome_form_resubmission'
                        exit 0
                      }
                    } catch [Windows.Automation.ElementNotAvailableException] {
                      # Owned popup was destroyed. The RPC still independently verifies readiness.
                      if($dialogHwnd -ne $hwnd.ToInt64()) {
                        Write-Output 'BROWSER_DIALOG_POPUP_REMOVED_VERIFY_RPC'
                        exit 0
                      }
                    } catch { Write-Output ('BROWSER_DIALOG_VERIFY_ERROR: '+$_.Exception.Message); exit 2 }
                  }
                  Write-Output 'BROWSER_DIALOG_DISMISSAL_UNVERIFIED'
                  exit 2
                }
                if($atRoot) {break}
                $container=$walker.GetParent($container)
              }
            }
          }
        }
      }
    }
  } catch {
    if(-not $reportedError -or $invoked) {Write-Output ('BROWSER_DIALOG_UIA_ERROR: '+$_.Exception.Message);$reportedError=$true}
    if($invoked) {exit 2}
  }
  Start-Sleep -Milliseconds 350
}
Write-Output 'BROWSER_DIALOG_MONITOR_TIMEOUT no_verified_dialog'
'''


def _title_key(value: str) -> str:
    """Use the full verified tab title (Chrome adds its browser suffix)."""
    clean = ' '.join(str(value or '').strip().split())
    if len(clean) < 18 or '\x00' in clean:
        return ''
    return clean[:200]


class ManagedNativeDialogWatcher:
    """One bounded, fail-closed monitor per navigation or slow managed-tab RPC."""

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
                stderr=subprocess.STDOUT, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            print('BROWSER_DIALOG_MONITOR_ARMED kind=chrome_form_resubmission title='+repr(self.title), flush=True)
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
        decoded = (output or b'').decode('utf-8', errors='replace')
        for line in decoded.splitlines():
            if line.strip():
                print(line[:500], flush=True)
        accepted = 'BROWSER_DIALOG_AUTO_ACCEPTED kind=chrome_form_resubmission' in decoded
        if isinstance(proc.returncode, int) and proc.returncode not in (0, -15):
            print('BROWSER_DIALOG_MONITOR_EXIT code='+str(proc.returncode), flush=True)
        return accepted
