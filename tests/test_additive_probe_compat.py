import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]

class AdditiveProbeContract(unittest.TestCase):
    def test_old_probe_retained_with_reader_fallback(self):
        bg=(ROOT/'reusable/browser_bridge_extension/background.js').read_text(encoding='utf-8')
        cs=(ROOT/'reusable/browser_bridge_extension/content.js').read_text(encoding='utf-8')
        bridge=(ROOT/'reusable/browser_bridge.py').read_text(encoding='utf-8')
        self.assertIn('origins:browserImageOrigins()',bg)
        self.assertIn("Array.isArray(payload?.reader_selectors)",bg)
        self.assertIn('if (!image && !Array.isArray(options))',cs)
        self.assertLess(cs.index('let image=[...document.images]'),cs.index('if (!image && !Array.isArray(options))'))
        self.assertIn("{'reader_selectors': list(reader_selectors)}",bridge)
        self.assertNotIn('tritinia.org',bg+cs+bridge)
    def test_fetch_first_then_render_only_on_failure(self):
        bg=(ROOT/'reusable/browser_bridge_extension/background.js').read_text(encoding='utf-8')
        self.assertLess(bg.index('const response=await fetch(u.href'),bg.index('originalFetchStatus:response.status'))
        self.assertIn('if (diagnostics.tabImage?.loaded)',bg)

if __name__=='__main__': unittest.main()
