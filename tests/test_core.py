import os
import json
import hashlib
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import comic_archiver as a

FIXTURE='''<!doctype html><html><head><title>Demo Story · Ch. 2</title><link rel="canonical" href="https://demo.invalid/reader/2"/></head>
<body><div class="episode_lst"><ul>
<li data-episode-no="1"><a href="/reader/1">Chapter 1</a></li>
<li data-episode-no="2"><a href="/reader/2">Chapter 2</a></li></ul></div>
<a title="Next Episode" href="/reader/3">Next Episode</a>
<div id="_imageList"><img alt="image" data-url="https://images.invalid/01.jpg"/><img alt="image" data-url="https://images.invalid/02.jpg"/></div>
</body></html>'''

class CoreTests(unittest.TestCase):
    def test_native_chapter_order(self):
        a1,n=a.chapter_links(FIXTURE,'https://demo.invalid/reader/2')
        self.assertEqual([x.chapter_id for x in a1],['1','2'])
        self.assertEqual([x.chapter_id for x in n],['/reader/3'])
    def test_inspection(self):
        x=a.inspect_html(FIXTURE)
        self.assertEqual(x['native_chapter_list_count'],2)
        self.assertEqual(x['visible_reader_images'],2)
    def test_git_environment_isolated(self):
        e=a.isolated_git_environment()
        self.assertNotEqual(e['GIT_CONFIG_GLOBAL'],str(Path.home()/'.gitconfig'))
        self.assertIn('GCM_NAMESPACE',e)
    def test_safe_slug(self):
        self.assertEqual(a.safe_slug('Chapter 1.5 / Extra'), 'chapter-1-5-extra')
    def test_git_plumbing_and_remote_hash_check(self):
        # Actual local bare Git remote, no network and no GitHub credentials.
        with tempfile.TemporaryDirectory(prefix='archiver-unittest-') as tmp:
            bare=Path(tmp)/'origin.git'
            subprocess.run(['git','init','--bare',str(bare)],check=True,capture_output=True)
            image=Path(tmp)/'0001.png'
            from PIL import Image
            Image.new('RGB',(4,4)).save(image)
            content=image.read_bytes()
            sha=hashlib.sha256(content).hexdigest()
            manifest={'chapter_id':'1','label':'Chapter 1','images':[{'sha256':sha,'bytes':len(content)}]}
            db=a.init_db()
            with patch.object(a,'ensure_remote_repo',return_value='file://'+str(bare)), \
                 patch.object(a,'get_option',return_value='tester'):
                ch=a.Chapter('1','Chapter 1','https://demo.invalid/1')
                commit,paths=a.stage_one_chapter(db,'test-vol-001',ch,[image],manifest,'not-used')
            got=subprocess.run(['git','--git-dir',str(bare),'rev-parse','refs/heads/main'],capture_output=True,text=True,check=True)
            self.assertEqual(got.stdout.strip(),commit)
            self.assertEqual(paths,['chapters/1/0001.png'])

if __name__=='__main__': unittest.main()

class ReaderContractTests(unittest.TestCase):
    def test_reader_wheel_is_native(self):
        js=(Path(__file__).resolve().parents[1]/'reader/app.js').read_text()
        ext=(Path(__file__).resolve().parents[1]/'extension/content.js').read_text()
        self.assertNotIn("addEventListener('wheel'",js)
        self.assertNotIn("addEventListener('wheel'",ext)
        self.assertIn('requestAnimationFrame',js)
    def test_reader_required_keys(self):
        js=(Path(__file__).resolve().parents[1]/'reader/app.js').read_text()
        for key in ['ArrowRight','ArrowLeft','ArrowUp','ArrowDown','Enter']:
            self.assertIn(key,js)
