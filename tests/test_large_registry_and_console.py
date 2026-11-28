"""Offline regression for oversized Worker metadata and noninteractive consoles."""
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from reusable import open_reader as reader, open_reader_focused as focused, engine


class LargeRegistryTests(unittest.TestCase):
    def test_32_4_mib_registry_is_losslessly_sharded_and_verified(self):
        payload = {'version': 2, 'frontend_hash': 'test', 'comics': {'older': {'title': '旧作', 'metadata': '漢字' * 5662310}, 'new': {'chapters': [131]}}}
        expected = reader.canonical(payload)
        self.assertGreater(len(expected), reader.WORKER_ASSET_MAX_BYTES)
        with tempfile.TemporaryDirectory() as tmp:
            stage = Path(tmp)
            reader._stage_registry(stage, payload)
            self.assertFalse((stage/'registry.json').exists())
            index = json.loads((stage/reader.REGISTRY_INDEX).read_bytes())
            self.assertEqual(index['bytes'], len(expected))
            self.assertEqual(index['sha256'], hashlib.sha256(expected).hexdigest())
            result = bytearray()
            for part in index['parts']:
                raw = (stage/'registry-parts'/part['name']).read_bytes()
                self.assertLessEqual(len(raw), 8*1024*1024)
                self.assertEqual(hashlib.sha256(raw).hexdigest(), part['sha256'])
                result.extend(raw)
            self.assertEqual(result, expected)
            reader._validate_worker_asset_sizes(stage)
            inventory = focused._asset_inventory(stage)
            self.assertEqual(inventory['registry.json'], index['sha256'])
            self.assertIn('registry.json', focused._verification_plan(inventory,None,'comic','new'))
            self.assertEqual(set(inventory), {'registry.json', reader.REGISTRY_INDEX})
            # Shrinking the registry clears obsolete shard files.
            reader._stage_registry(stage, {'comics': {}})
            self.assertFalse((stage/'registry-parts').exists())
            self.assertEqual((stage/'registry.json').read_bytes(), reader.canonical({'comics': {}}))
    def test_exact_limit_and_unrelated_oversize_rejected_before_wrangler(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(reader,'WORKER_ASSET_MAX_BYTES',32):
            stage=Path(tmp)
            raw={'x':'a'*(32-len(reader.canonical({'x':''})))}
            reader._stage_registry(stage,raw)
            self.assertEqual((stage/'registry.json').stat().st_size,32)
            (stage/'bad.bin').write_bytes(b'a'*33)
            fake=SimpleNamespace(npx_wrangler=lambda *a,**kw: self.fail('must not deploy oversized file'))
            with self.assertRaisesRegex(RuntimeError,'bad.bin'):
                reader._deploy(fake,stage,{})
    def test_actual_deploy_receives_only_shards_not_oversized_registry(self):
        # Execute the real deploy entry point and inspect the actual Wrangler
        # config and the directory it would upload, without remote side effects.
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); stage=root/'stage'; stage.mkdir()
            worker=root/'reusable'/'worker_addon'/'panel_replacement_worker.mjs'
            worker.parent.mkdir(parents=True); worker.write_text('export default {}')
            payload={'comics': {'existing': {'metadata': 'x'*33973862}}}
            reader._stage_registry(stage,payload)
            def wrangler(args, **kwargs):
                self.assertEqual(args[:2],['deploy','--config'])
                config=json.loads(Path(args[2]).read_text())
                upload=Path(config['assets']['directory'])
                self.assertEqual(upload,stage)
                self.assertFalse((upload/'registry.json').exists())
                self.assertTrue((upload/reader.REGISTRY_INDEX).is_file())
                self.assertTrue(all(p.stat().st_size<=25*1024*1024 for p in upload.rglob('*') if p.is_file()))
                self.assertTrue(config['assets']['run_worker_first'])
                return SimpleNamespace(stdout='https://open-reader.test.workers.dev',stderr='')
            fake=SimpleNamespace(ROOT=root,npx_wrangler=wrangler)
            self.assertEqual(reader._deploy(fake,stage,{}),'https://open-reader.test.workers.dev')
    def test_console_options(self):
        self.assertEqual(engine._background_console_options(windows=True),{'creationflags':0x08000000})
        self.assertEqual(engine._background_console_options(windows=False),{})

if __name__ == '__main__': unittest.main()
