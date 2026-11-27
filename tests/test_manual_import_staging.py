"""Stage actual old and new reader files and verify the additive import boundary."""
import copy
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from reusable import open_reader,manual_import

ROOT=Path(__file__).resolve().parents[1]
class ImportStaging(unittest.TestCase):
    def test_additive_stage_and_shared_css(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/'project';root.mkdir()
            shutil.copytree(ROOT/'reader',root/'reader')
            shutil.copytree(ROOT/'reusable',root/'reusable',ignore=shutil.ignore_patterns('__pycache__','*.pyc'))
            image={'url':'https://fixture.pages.dev/1.png','width':10,'height':10,'sha256':'a'*64}
            reg={'comics':{'old':{'slug':'old','title':'Old','chapters':[{'id':'1','title':'Chapter 1','label':'Chapter 1','number':'1','images':[image]}]}}}
            prior,new=Path(tmp)/'prior',Path(tmp)/'new'
            with patch.object(manual_import,'enabled',return_value=False):
                open_reader.stage_worker_assets(root,copy.deepcopy(reg),prior)
            open_reader.stage_worker_assets(root,copy.deepcopy(reg),new)
            for p in prior.rglob('*'):
                if p.is_file() and p.relative_to(prior).as_posix() not in ('index.html','registry.json'):
                    self.assertEqual(p.read_bytes(),(new/p.relative_to(prior)).read_bytes(),str(p))
            self.assertEqual(json.loads((new/'registry.json').read_text())['comics'],reg['comics'])
            self.assertEqual((new/'manual-reader-template/app.js').read_bytes(),(new/'comics/old/app.js').read_bytes())
            self.assertEqual((new/'manual-reader-template/style.css').read_bytes(),(new/'comics/old/style.css').read_bytes())
            self.assertIn('href="/comic-landing.css"',(new/'add-comic/index.html').read_text())
            self.assertIn('href="/add-comic/"',(new/'index.html').read_text())
            self.assertIn('manual-library',(new/'index.html').read_text())
            self.assertNotIn('manual-reader-template',(new/'library.json').read_text())
            self.assertIn('manual-edit',(new/'manual-reader-template/overview/index.html').read_text())
            self.assertNotIn('manual-edit',(new/'comics/old/overview/index.html').read_text())
            self.assertNotIn('manual-pdf/pdf.mjs',manual_import.hash_inputs(root))
            self.assertFalse((new/'manual-pdf').exists())
if __name__=='__main__':unittest.main()
