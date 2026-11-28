"""Generic original-response readiness retry and permanent adapter contract."""
import base64
import io
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image
import run
from reusable import chapter_script, engine
from reusable.image_checkpoint import ChapterImageCheckpoint
from reusable.source_session import SourceAccessPaused
from site_specific import site_adapter


class ScriptResourceRetryTests(unittest.TestCase):
    def test_timeout_retains_first_image_and_resumes(self):
        url = 'https://reader.example.test/chapter/1/'
        items = [dict(key=str(i), order=i, url=f'https://cdn.example.test/{i}.jpg',
                      filename=f'{i:04d}.jpg', width=10, height=15) for i in (1, 2)]
        data = io.BytesIO()
        Image.new('RGB', (10, 15)).save(data, format='PNG')
        encoded = base64.b64encode(data.getvalue()).decode()
        actions = []
        now = [0]
        ready = [False]
        def rpc(action, payload, timeout):
            if action == 'script_resource_prepare': return {'ready': True}
            if action == 'script_scroll': return dict(url=url, height=100, count=2, loaded=1, atBottom=True)
            if action == 'script_plan': return dict(url=url, items=items, loaded=1)
            item = payload['items'][0]
            actions.append((action, item['order']))
            if action == 'script_resource_position': return {'positioned': True}
            if action != 'script_resource_read': raise AssertionError(action)
            receipt = dict(key=item['key'], url=item['url'])
            if item['order'] == 2 and not ready[0]:
                now[0] += 25
                return dict(receipt, state='pending')
            return dict(receipt, state='complete', base64=encoded, width=10, height=15)
        bridge = SimpleNamespace(allowed_site='reader.example.test', allowed_cdn={'cdn.example.test'}, validate_image=lambda x:x, rpc=rpc)
        page = SimpleNamespace(context=SimpleNamespace(bridge=bridge))
        chapter = SimpleNamespace(url=url, chapter_id='1')
        adapter = SimpleNamespace(CHAPTER_DOWNLOAD_JS='(()=>{})()', CHAPTER_DOWNLOAD_TRANSPORT='loaded-resource', READER_SELECTORS=['.reader'], IMAGE_ATTRIBUTES=['src'])
        config = dict(page_scan_steps=10, page_scan_stability_steps=2, max_pages_per_chapter=500, github_max_file_bytes=1000000)
        with tempfile.TemporaryDirectory() as d, patch.object(chapter_script.time, 'sleep'), patch.object(chapter_script.time, 'monotonic', side_effect=lambda:now[0]):
            folder = Path(d)
            def acquire(): return chapter_script.acquire(page, chapter, folder, adapter, config, None, lambda *a,**k:None, lambda:'now', 'Chapter 1')
            with self.assertRaisesRegex(RuntimeError, "original reader bytes unavailable"): acquire()
            self.assertEqual(set(ChapterImageCheckpoint(folder, '1', url).data['images']), {'1'})
            self.assertIn(('script_resource_position', 2), actions)
            ready[0] = True
            actions.clear()
            files, manifest = acquire()
            self.assertEqual([p.name for p in files], ['0001.png','0002.png'])
            self.assertEqual(actions, [('script_resource_read', 2)])
            self.assertEqual(len(manifest['images']), 2)
    def test_child_propagates_all_errors_without_classification(self):
        for error in (RuntimeError('missing reader bytes'), SourceAccessPaused('denied'), ValueError('invalid receipt')):
            with patch.object(engine, 'main', side_effect=error), patch.object(sys, 'argv', ['run.py']):
                with self.assertRaises(type(error)) as cm:
                    run._archive_retry_child(['--resume'])
                self.assertIs(cm.exception, error)

    def test_retry_parent_preserves_options(self):
        calls, delays = [], []
        def child(cmd, cwd):
            calls.append(cmd)
            return run._RETRY_CHILD_CODE if len(calls)==1 else 0
        run._run_archive_retry_loop(['--resume','--authorized','--shutdown-on-complete'], call=child, sleep=delays.append)
        self.assertEqual(delays,[5])
        self.assertIn('--skip-initial-github-check',calls[1])
        self.assertIn('--shutdown-on-complete',calls[1])
    def test_identical_permanent_contract(self):
        def block(module):
            source=Path(module.__file__).read_text(encoding='utf-8')
            return source.split('# === PERMANENT ADAPTER CONTRACT:',1)[1].split('# === END PERMANENT ADAPTER CONTRACT ===',1)[0]
        self.assertEqual(block(chapter_script),block(site_adapter))
        for marker in ('CHAPTER_DOWNLOAD_JS','loaded-resource','native','PERMANENT CORS WARNING','Never delete this comment block'):
            self.assertIn(marker,block(site_adapter))
