"""Generic scroll stability contracts: no website-specific assumptions."""
import ast
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]

class ScrollStability(unittest.TestCase):
    def test_checkpoints_process_missing_images_before_later_page_capture(self):
        src=(ROOT/'reusable/engine.py').read_text()
        self.assertIn('pending_key = next((key for key in slot_order if key not in saved_keys), None)',src)
        self.assertIn('break  # try this ordinal first, before later pages',src)
        self.assertIn('break  # never attempt a later image after a capture error',src)
        ast.parse(src)

    def test_browser_source_has_no_site_specific_urls_or_viewport_restoration(self):
        content=(ROOT/'reusable/browser_bridge_extension/content.js').read_text()
        background=(ROOT/'reusable/browser_bridge_extension/background.js').read_text()
        self.assertNotIn("type:'RESTORE_SCROLL'",background)
        self.assertNotIn('window.scrollTo({top:oldY',content)
        self.assertIn('Math.floor(innerHeight*.85)',content)
        self.assertIn('MAX_IMAGE_BYTES',background)
        self.assertNotIn('toongod',background.lower())
        self.assertNotIn('toongod',content.lower())

if __name__=='__main__':unittest.main()
