"""Provider-agnostic build and guard against source URL leakage."""
import json
import tempfile
import types
import unittest
from pathlib import Path
from reusable.bridge_manifest import generate_installed_manifests

ROOT=Path(__file__).resolve().parents[1]

class Tests(unittest.TestCase):
    def test_no_provider_patterns_or_placeholder_urls_in_reusable(self):
        for relative in ('reusable/engine.py',
                         'reusable/extension_templates/content.template.js',
                         'reusable/browser_bridge_extension/manifest.chrome.json',
                         'reusable/browser_bridge_extension/manifest.firefox.json'):
            data=(ROOT/relative).read_text(encoding='utf-8').lower()
            for forbidden in ('toongod.org','tngcdn.com','webtoons.com','toptoon.com','annoying-alice','bg_transparency'):
                self.assertNotIn(forbidden,data,relative)

    def test_generated_site_patterns_come_from_adapter_only(self):
        with tempfile.TemporaryDirectory() as temp:
            temp=Path(temp)
            for browser in ('chrome','firefox'):
                src=temp/'reusable/browser_bridge_extension'/f'manifest.{browser}.json'
                src.parent.mkdir(parents=True,exist_ok=True)
                src.write_bytes((ROOT/'reusable/browser_bridge_extension'/f'manifest.{browser}.json').read_bytes())
            fake=types.SimpleNamespace(EXTENSION_MATCHES=['https://fictional-reader.example/episodes/*'],
                 ALLOWED_HOSTS=['fictional-reader.example'],BRIDGE_IMAGE_HOSTS=['pictures.example'])
            before=(temp/'reusable/browser_bridge_extension/manifest.chrome.json').read_bytes()
            changes=generate_installed_manifests(temp,fake)
            self.assertEqual(set(changes),{'chrome','firefox'})
            self.assertEqual(before,(temp/'reusable/browser_bridge_extension/manifest.chrome.json').read_bytes())
            for browser in ('chrome','firefox'):
                got=json.loads((temp/'browser_bridge'/browser/'manifest.json').read_text())
                self.assertEqual(got['content_scripts'][0]['matches'],fake.EXTENSION_MATCHES)
                self.assertIn('https://pictures.example/*',got.get('host_permissions',[])+got['permissions'])
            self.assertEqual(generate_installed_manifests(temp,fake),[])

    def test_rejects_invalid_pattern_and_host(self):
        with tempfile.TemporaryDirectory() as temp:
            fake=types.SimpleNamespace(EXTENSION_MATCHES=['http://example.com/*'],ALLOWED_HOSTS=['example.com'],BRIDGE_IMAGE_HOSTS=[])
            with self.assertRaises(ValueError):generate_installed_manifests(Path(temp),fake)
            fake.EXTENSION_MATCHES=['https://example.com/*'];fake.BRIDGE_IMAGE_HOSTS=['bad/host']
            with self.assertRaises(ValueError):generate_installed_manifests(Path(temp),fake)

    def test_bridge_runtime_generator_preserves_adapter_grants_and_permissions(self):
        from reusable.browser_bridge import ensure_generated_extensions
        import shutil
        with tempfile.TemporaryDirectory() as temp:
            temp = Path(temp)
            source = temp/'reusable/browser_bridge_extension'
            source.mkdir(parents=True)
            for asset in ('manifest.chrome.json', 'manifest.firefox.json',
                          'background.js','content.js','popup.html','popup.js'):
                shutil.copyfile(ROOT/'reusable/browser_bridge_extension'/asset,source/asset)
            fake=types.SimpleNamespace(EXTENSION_MATCHES=['https://fictional-reader.example/chapters/*'],
                 ALLOWED_HOSTS=['fictional-reader.example'],BRIDGE_IMAGE_HOSTS=['images.example'])
            out=ensure_generated_extensions(temp,fake,18766)
            self.assertEqual(out,temp/'browser_bridge')
            for browser in ('chrome','firefox'):
                man=json.loads((out/browser/'manifest.json').read_text(encoding='utf-8'))
                perms=man.get('host_permissions',[])+man['permissions']
                self.assertIn('http://127.0.0.1:18766/*',perms)
                self.assertIn('https://images.example/*',perms)
                self.assertEqual(man['content_scripts'][0]['matches'],fake.EXTENSION_MATCHES)
                self.assertEqual((out/browser/'content.js').read_bytes(),(source/'content.js').read_bytes())
            chrome=json.loads((out/'chrome/manifest.json').read_text())
            for perm in ('debugger','activeTab','scripting','alarms'):
                self.assertIn(perm,chrome['permissions'])
            before={p.name:p.read_bytes() for p in source.iterdir()}
            fake.EXTENSION_MATCHES=['https://new-reader.example/story/*']
            fake.ALLOWED_HOSTS=['new-reader.example']
            fake.BRIDGE_IMAGE_HOSTS=['newcdn.example']
            ensure_generated_extensions(temp,fake,18766)
            self.assertEqual(before,{p.name:p.read_bytes() for p in source.iterdir()},
                             'reusable source must never be modified by a site swap')
            changed=json.loads((out/'chrome/manifest.json').read_text())
            self.assertEqual(changed['content_scripts'][0]['matches'],fake.EXTENSION_MATCHES)
            self.assertIn('https://newcdn.example/*',changed['host_permissions'])
            self.assertNotIn('https://images.example/*',changed['host_permissions'])

if __name__=='__main__':unittest.main()
