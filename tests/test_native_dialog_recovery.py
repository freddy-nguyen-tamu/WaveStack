import ast
import io
import queue
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

from reusable import native_dialogs
from reusable.browser_bridge import LocalBridge

ROOT = Path(__file__).resolve().parent.parent


class NativeDialogRecoveryTests(unittest.TestCase):
    def test_dialog_monitor_is_bound_to_managed_tab_title(self):
        self.assertEqual(native_dialogs._title_key(''), '')
        self.assertEqual(native_dialogs._title_key('short'), '')
        self.assertEqual(native_dialogs._title_key('  Reading Childhood Friends - Chapter 00  '),
                         'Reading Childhood Friends - Chapter 00')
        self.assertIn("$windowTitle.Contains($expected)", native_dialogs._UIA_SCRIPT)
        self.assertIn("'Confirm Form Resubmission'", native_dialogs._UIA_SCRIPT)
        self.assertIn("'Continue'", native_dialogs._UIA_SCRIPT)
        self.assertIn("'Cancel'", native_dialogs._UIA_SCRIPT)
        self.assertIn("$klass.ToString() -eq 'Chrome_WidgetWin_1'", native_dialogs._UIA_SCRIPT)
        self.assertIn("$browserProcess -in @('chrome','msedge')", native_dialogs._UIA_SCRIPT)
        self.assertNotIn('SendKeys', native_dialogs._UIA_SCRIPT)
        self.assertNotIn('SendInput', native_dialogs._UIA_SCRIPT)

    def test_monitor_skips_when_not_on_windows(self):
        with mock.patch.object(native_dialogs, 'os') as operating_system, mock.patch.object(native_dialogs.subprocess, 'Popen') as spawn:
            operating_system.name='posix'
            watcher=native_dialogs.ManagedNativeDialogWatcher('Reading Childhood Friends - Chapter 00').start()
            self.assertFalse(watcher.close())
            spawn.assert_not_called()

    def test_monitor_is_one_shot_and_stops(self):
        process=mock.Mock()
        process.poll.return_value=None
        process.communicate.return_value=(b'BROWSER_DIALOG_AUTO_ACCEPTED kind=chrome_form_resubmission\n',b'')
        with mock.patch.object(native_dialogs, 'os') as operating_system, mock.patch.object(native_dialogs.subprocess, 'Popen',return_value=process) as spawn:
            operating_system.name='nt'
            watcher=native_dialogs.ManagedNativeDialogWatcher('Reading Childhood Friends - Chapter 00').start()
            self.assertEqual(spawn.call_count,1)
            with redirect_stdout(io.StringIO()) as log:
                self.assertTrue(watcher.close())
            self.assertIn('BROWSER_DIALOG_AUTO_ACCEPTED',log.getvalue())
            self.assertFalse(watcher.close())
            process.terminate.assert_called_once()

    def test_managed_navigation_invokes_monitor_and_preserves_rpc(self):
        bridge=LocalBridge('https://source.example/chapters/1',require_managed_tab=True)
        bridge.ready.set()
        bridge.tab_title='Reading Childhood Friends - Chapter 00 Prologue'
        bridge.last_heartbeat=__import__('time').monotonic()
        original_put=bridge.pending.put
        def send_with_result(payload):
            original_put(payload)
            bridge.responses[payload['id']].put({'ok':True,'data':{'url':'https://source.example/chapters/1','status':200}})
        bridge.pending.put=send_with_result
        with mock.patch('reusable.native_dialogs.ManagedNativeDialogWatcher') as watcher:
            watcher.return_value.start.return_value=watcher.return_value
            result=bridge.rpc('navigate',{'url':'https://source.example/chapters/1'},timeout=1)
            self.assertEqual(result['status'],200)
            watcher.assert_called_once()
            watcher.return_value.close.assert_called_once()
            self.assertEqual(bridge.responses,{})

    def test_non_navigation_never_starts_native_handler(self):
        bridge=LocalBridge('https://source.example/chapters/1',require_managed_tab=True)
        bridge.ready.set()
        bridge.tab_title='Reading Childhood Friends - Chapter 00 Prologue'
        original_put=bridge.pending.put
        def send_with_result(payload):
            original_put(payload)
            bridge.responses[payload['id']].put({'ok':True,'data':{'ok':True}})
        bridge.pending.put=send_with_result
        with mock.patch('reusable.native_dialogs.ManagedNativeDialogWatcher') as watcher:
            self.assertTrue(bridge.rpc('probe',{},timeout=1)['ok'])
            watcher.assert_not_called()

    def test_existing_reload_path_and_browser_dialog_type_guard_retained(self):
        js=(ROOT/'browser_bridge/chrome/background.js').read_text(encoding='utf-8')
        self.assertIn("call(chrome.tabs,'reload',tabId,{bypassCache:false})",js)
        self.assertIn('Same-URL reload did not finish loading',js)
        self.assertIn("method === 'Page.javascriptDialogOpening'",js)
        self.assertIn('Page.handleJavaScriptDialog',js)
        self.assertIn("kind==='alert'",js)
        self.assertIn("kind==='beforeunload' && dialogNavigationInFlight",js)
        self.assertIn('BROWSER_DIALOG_MANUAL_ACTION_REQUIRED',js)
        self.assertIn("action === 'read_loaded_blob'",js)

    def test_background_chrome_window_can_be_monitored_without_stealing_focus(self):
        script=native_dialogs._UIA_SCRIPT
        self.assertIn('GetForegroundWindow',script)
        self.assertIn('AutomationElement]::RootElement',script)
        self.assertIn('$windows=$desktop.FindAll',script)
        self.assertIn('$matches.Count -eq 1',script)
        self.assertIn('$windowTitle.Contains($expected)',script)
        self.assertIn("'Chrome_WidgetWin_1'",script)
        self.assertIn("@('chrome','msedge')",script)
        self.assertIn("'Confirm Form Resubmission'",script)
        self.assertIn("'Continue'",script)
        self.assertIn("'Cancel'",script)
        self.assertNotIn('SendKeys',script)
        self.assertNotIn('SendInput',script)

    def test_only_browser_owned_popup_widgets_are_considered(self):
        script=native_dialogs._UIA_SCRIPT
        self.assertIn('GetForegroundWindow()',script)
        self.assertIn('GetWindow($popupHwnd,4)',script)
        self.assertIn('$owned.Count -eq 1',script)
        self.assertIn('if(-not $foregroundIsManaged)',script)
        self.assertIn('$yes.Count -ne 1 -or $no.Count -ne 1',script)
        self.assertIn('InvokePattern',script)
        self.assertIn('BROWSER_DIALOG_AUTO_ACCEPTED',script)


if __name__=='__main__':unittest.main()
