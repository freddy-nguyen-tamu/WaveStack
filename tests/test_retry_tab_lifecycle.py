import contextlib
import io
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
from reusable.browser_bridge import source_extension_context


class RetryTabLifecycle(unittest.TestCase):
    def test_original_exception_survives_release_before_listener_close(self):
        for release_failure in (False, True):
            with self.subTest(release_failure=release_failure), tempfile.TemporaryDirectory() as td:
                url='https://reader.example.test/chapter/21/'
                calls=[]
                fake=Mock(initial_chapter_url=url, tab_id=7)
                fake.ready.is_set.return_value=True
                fake.close.side_effect=lambda: calls.append('close')
                def rpc(action,payload,timeout):
                    calls.append(action)
                    if action=='script_capabilities':
                        return {'revision':'native-chapter-download-v2','loadedResource':True}
                    if release_failure: raise RuntimeError('extension gone')
                    return {'closed':True,'tab_id':7}
                fake.rpc.side_effect=rpc
                adapter=SimpleNamespace(IMAGE_ATTRIBUTES=['src'], CHAPTER_DOWNLOAD_JS='(()=>{})()',CHAPTER_DOWNLOAD_TRANSPORT='loaded-resource')
                with patch('reusable.browser_bridge.LocalBridge',return_value=fake),patch('reusable.browser_bridge.ensure_generated_extensions'),patch.dict('os.environ',{'COMIC_ARCHIVER_NO_AUTO_BROWSER':'1'}), contextlib.redirect_stdout(io.StringIO()):
                    with self.assertRaisesRegex(ValueError,'original error'):
                        with source_extension_context(Path(td),url,adapter=adapter) as ctx:
                            # Mirror engine._archive_run_once: its finally calls
                            # close BEFORE the outer contextmanager sees the error.
                            try:
                                raise ValueError('original error')
                            finally:
                                ctx.close()
                self.assertEqual(calls,['script_capabilities','release_managed_reader','close'])

    def test_real_focused_preflight(self):
        import run
        run._run_preflight(run_tests=False)

    def test_launcher_marker_matches_bootstrap_nonce(self):
        from reusable.normal_browser_launch import launch_normal_chrome
        nonce='b'*32
        cmd=launch_normal_chrome('https://reader.example.test/chapter/21/',startup_nonce=nonce,executable='chrome.exe',popen=lambda *a,**k:None)
        self.assertEqual(cmd[-1], 'about:blank#comicarchiver-'+nonce)
