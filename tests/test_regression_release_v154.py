"""Prevent the 1.5.3 Python bootstrap regression from resurfacing."""
from pathlib import Path
import unittest
import json

ROOT=Path(__file__).resolve().parents[1]
class ReleaseGuard(unittest.TestCase):
  def test_originless_extension_bootstrap_still_supported(self):
    s=(ROOT/'reusable/browser_bridge.py').read_text(encoding='utf-8')
    self.assertNotIn('Bootstrap requires a browser extension Origin',s)
    self.assertIn('X-Comic-Bridge-Bootstrap',s)
    self.assertIn('X-Comic-Bridge-Client',s)
    self.assertIn('extension_client',s)
    self.assertIn('def recover_unloaded_image',s)
  def test_new_content_protocol_and_screen_fallback_preserved(self):
    b=(ROOT/'reusable/browser_bridge_extension/background.js').read_text(encoding='utf-8')
    self.assertIn('bridgeContentProtocol===6',b)
    self.assertIn("recover_image:'RECOVER_IMAGE'",b)
    self.assertIn("screenshotBackend !== 'debugger'",b)
    self.assertIn("'X-Comic-Bridge-Client':chrome.runtime.id",b)
    self.assertIn("'X-Comic-Bridge-Bootstrap':'1'",b)
    c=(ROOT/'reusable/browser_bridge_extension/content.js').read_text(encoding='utf-8')
    self.assertIn('RECOVER_IMAGE',c)
    self.assertIn('const paintReady=await waitForPaintOrTimer()', c)
    self.assertIn('__comicBridgeContentLoadedVersion === 9', c)
    self.assertIn("if(payload?.type==='RECOVER_IMAGE' && chrome.scripting?.executeScript)",b)
  def test_versions_match_and_site_adapters_unmodified(self):
    for name in ('reusable/browser_bridge_extension/manifest.chrome.json','reusable/browser_bridge_extension/manifest.firefox.json','browser_bridge/chrome/manifest.json','browser_bridge/firefox/manifest.json'):
      manifest=json.loads((ROOT/name).read_text(encoding='utf-8'))
      self.assertEqual(manifest['version'],'1.5.17', name)
      if name.endswith('chrome.json') or name == 'browser_bridge/chrome/manifest.json':
        self.assertIn('debugger',manifest['permissions'])
        self.assertIn('http://127.0.0.1:18765/*',manifest['host_permissions'])
      else:
        self.assertIn('http://127.0.0.1:18765/*',manifest['permissions'])
if __name__=='__main__':unittest.main()
