"""Provider-neutral live code-vs-on-disk checks for decoded browser image transfer."""
import base64
import io
import unittest
from unittest.mock import Mock
from PIL import Image
from reusable.browser_bridge import (
    BLOB_TRANSFER_HANDLER_REVISION, BrowserBridgeError, verify_live_blob_transfer)


def png():
    buffer = io.BytesIO()
    Image.new('RGB', (12, 20), (123, 45, 67)).save(buffer, format='PNG')
    return buffer.getvalue()


class BlobRuntimeGateTests(unittest.TestCase):
    def setUp(self):
        self.url = 'blob:https://example.test/observed-uuid'
        self.tab = 'https://example.test/reader/chapter-1/'
        self.bridge = Mock(tab_url=self.tab)
        self.proof = {'url': self.url, 'via': 'rendered-png'}
        self.res = {
            'url': self.url, 'bridge_revision': BLOB_TRANSFER_HANDLER_REVISION,
            'base64': base64.b64encode(png()).decode('ascii'),
            'status': 200, 'via': 'rendered-png',
            'headers': {'content-type': 'image/png'}}

    def test_current_runtime_accepts_real_png(self):
        self.bridge.rpc.return_value = dict(self.res)
        result = verify_live_blob_transfer(self.bridge, self.proof, ('#imagesList',))
        self.assertEqual(result['dimensions'], (12, 20))
        self.bridge.rpc.assert_called_once()
        self.assertEqual(self.bridge.rpc.call_args.args[0], 'read_loaded_blob')
        self.assertEqual(self.bridge.rpc.call_args.args[1]['url'], self.url)

    def test_stale_runtime_detected_before_retry(self):
        old = dict(self.res)
        old.pop('bridge_revision')
        old.update(status=424, base64='', reason='Source document cannot read its decoded blob: TypeError: Failed to fetch')
        self.bridge.rpc.return_value = old
        with self.assertRaisesRegex(BrowserBridgeError, 'BROWSER_EXTENSION_STALE_RUNTIME'):
            verify_live_blob_transfer(self.bridge, self.proof, ('#imagesList',))
        self.bridge.rpc.assert_called_once()

    def test_current_runtime_exposes_exact_pixel_error(self):
        failed = dict(self.res)
        failed.update(status=424, base64='', reason='blob read failed',
                      diagnostics={'pixelFallbackError': 'Screenshot tab not active'})
        self.bridge.rpc.return_value = failed
        with self.assertRaisesRegex(BrowserBridgeError, 'Screenshot tab not active'):
            verify_live_blob_transfer(self.bridge, self.proof, ('#imagesList',))
        self.bridge.rpc.assert_called_once()

    def test_other_image_urls_are_not_reprobed(self):
        result = verify_live_blob_transfer(self.bridge, {'url': 'https://example.test/1.jpg'}, ('#imagesList',))
        self.assertIsNone(result)
        self.bridge.rpc.assert_not_called()

    def test_wrong_origin_fails_before_rpc(self):
        with self.assertRaisesRegex(BrowserBridgeError, 'origin'):
            verify_live_blob_transfer(self.bridge, {'url': 'blob:https://evil.test/x'}, ('#imagesList',))
        self.bridge.rpc.assert_not_called()

    def test_bad_image_bytes_fail(self):
        self.bridge.rpc.return_value = {**self.res, 'base64': base64.b64encode(b'not an image').decode()}
        with self.assertRaisesRegex(BrowserBridgeError, 'invalid image bytes'):
            verify_live_blob_transfer(self.bridge, self.proof, ('#imagesList',))

    def test_wrong_image_identity_fails(self):
        self.bridge.rpc.return_value = {**self.res, 'url':'blob:https://example.test/other-uuid'}
        with self.assertRaisesRegex(BrowserBridgeError, 'different source URL'):
            verify_live_blob_transfer(self.bridge, self.proof, ('#imagesList',))

    def test_screenshot_must_report_png(self):
        self.bridge.rpc.return_value = {**self.res, 'headers':{'content-type':'image/jpeg'}}
        with self.assertRaisesRegex(BrowserBridgeError, 'not truthful PNG'):
            verify_live_blob_transfer(self.bridge, self.proof, ('#imagesList',))

    def test_snapshot_source_identity_unmodified(self):
        import inspect
        from reusable import browser_bridge
        body = inspect.getsource(browser_bridge.verify_live_blob_transfer)
        self.assertNotIn('manhwaread', body)
        self.assertNotIn('childhood-friends', body)

if __name__=='__main__': unittest.main()
