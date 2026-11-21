"""Regression for the complete hands-free browser dependency set.

No real browser is launched. The checks prevent a partial overlay from
installing 1.5.10's run.py without 1.5.9's Python bridge/session/launcher.
"""
import inspect
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]


class BrowserReleaseDependencyContract(unittest.TestCase):
    def test_bootstrap_exposes_first_unfinished_chapter(self):
        from reusable.browser_bridge import LocalBridge
        bridge=LocalBridge('https://example.test/series/1',
                           initial_chapter_url='https://example.test/series/82',port=0)
        self.assertEqual(bridge.initial_chapter_url,'https://example.test/series/82')
        src=(ROOT/'reusable/browser_bridge.py').read_text(encoding='utf-8')
        self.assertIn("'startup_url': bridge.initial_chapter_url",src)

    def test_context_supports_hands_free_chapter_argument(self):
        from reusable.browser_bridge import source_extension_context
        from reusable.source_session import source_browser_context
        self.assertIn('initial_chapter_url',inspect.signature(source_extension_context).parameters)
        self.assertIn('initial_chapter_url',inspect.signature(source_browser_context).parameters)
        src=(ROOT/'reusable/source_session.py').read_text(encoding='utf-8')
        self.assertIn('initial_chapter_url=initial_chapter_url',src)

    def test_preflight_checks_complete_launch_dependencies(self):
        src=(ROOT/'run.py').read_text(encoding='utf-8')
        self.assertIn('Python source session does not forward the startup chapter',src)
        self.assertIn('normal Chrome launcher missing or incompatible',src)
        self.assertIn('Python bridge does not launch the selected chapter in normal Chrome',src)
        from reusable.normal_browser_launch import launch_normal_chrome
        self.assertTrue(callable(launch_normal_chrome))


if __name__=='__main__':
    unittest.main()
