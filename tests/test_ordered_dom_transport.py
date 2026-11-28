"""New mode works with stable identities and preserves existing modes."""
import base64, io, tempfile, unittest, zipfile, json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from PIL import Image
from reusable import chapter_script as cs
from reusable.source_session import SourceAccessPaused
from reusable.image_checkpoint import ChapterImageCheckpoint

class OrderedDomTransportTests(unittest.TestCase):
    def setUp(self):
        self.url='https://reader.example.test/chapter/2/'
        self.items=[dict(key=str(i),order=i,url=self.url+'#reader-page-'+str(i),filename=f'{i:04d}.png',selector=f'img[data-index="{i}"]') for i in range(1,4)]
        b=io.BytesIO();Image.new('RGB',(10,20)).save(b,format='PNG');self.raw=b.getvalue()
        self.chapter=SimpleNamespace(url=self.url,chapter_id='2')
        self.adapter=SimpleNamespace(CHAPTER_DOWNLOAD_TRANSPORT='ordered-dom',CHAPTER_DOWNLOAD_JS='test',READER_SELECTORS=['.reader'],script_download_expected=lambda *_:[(x['key'],x['url']) for x in self.items])
        self.config=dict(max_pages_per_chapter=100,github_max_file_bytes=1000000)
        self.calls=[];self.fail=None;self.events=[]
    def rpc(self,action,payload,timeout):
        self.calls.append(action)
        if action=='script_dom_plan':return dict(url=self.url,items=self.items,total=3,loaded=1)
        self.assertEqual(action,'script_dom_read');x=payload['item'];self.calls.append(x['order'])
        r=dict(key=x['key'],url=x['url'])
        if x['order']==2 and self.fail:return dict(r,state=self.fail,reason='test failure')
        return dict(r,state='complete',via=['reader-blob-original','reader-decoded-png','reader-https-original'][x['order']-1],base64=base64.b64encode(self.raw).decode(),width=10,height=20)
    def acquire(self,folder):
        p=SimpleNamespace(context=SimpleNamespace(bridge=SimpleNamespace(rpc=self.rpc)),content=lambda:'HTML')
        return cs.acquire(p,self.chapter,folder,self.adapter,self.config,None,lambda k,**v:self.events.append((k,v)),lambda:'now','Chapter 2')
    def test_partial_restart_and_one_zip(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp);self.fail='unavailable'
            with self.assertRaisesRegex(RuntimeError,'checkpoints retained'):self.acquire(folder)
            self.assertFalse((folder/'chapter-complete.zip').exists());self.assertEqual(set(ChapterImageCheckpoint(folder,'2',self.url).data['images']),{'1'})
            self.fail=None;self.calls.clear();files,manifest=self.acquire(folder)
            self.assertEqual(self.calls,['script_dom_plan','script_dom_read',2,'script_dom_read',3])
            self.assertEqual([f.name for f in files],['0001.png','0002.png','0003.png'])
            with zipfile.ZipFile(folder/'chapter-complete.zip') as z:
                self.assertIsNone(z.testzip());self.assertEqual(z.namelist(),[f.name for f in files]+['_report.json']);self.assertEqual(z.read('0003.png'),self.raw)
                self.assertEqual(json.loads(z.read('_report.json'))['total'],3)
            self.assertEqual([im['acquisition_method'] for im in manifest['images']],['reader-blob-original','reader-decoded-png','reader-https-original'])
            self.calls.clear();self.acquire(folder);self.assertEqual(self.calls,['script_dom_plan'])
    def test_missing_receipt_recovers_same_page_after_resume(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp);self.fail='unavailable'
            with self.assertRaises(RuntimeError):self.acquire(folder)
            self.fail=None;self.calls.clear();self.events.clear();orig=self.rpc
            remaining=[True]
            def transient(action,payload,timeout):
                if action=='script_dom_read' and payload['item']['order']==2 and remaining:
                    remaining.pop();self.calls.extend([action,2])
                    return dict(key='2',url=self.items[1]['url'],state='pending',reason='missing inspect receipt')
                return orig(action,payload,timeout)
            self.rpc=transient
            with patch.object(cs.time,'sleep'):
                files,manifest=self.acquire(folder)
            self.assertEqual(self.calls,['script_dom_plan','script_dom_read',2,'script_dom_read',2,'script_dom_read',3])
            self.assertTrue(any(k=='ORDERED_DOM_PAGE_PENDING' and v['image']==2 and 'missing inspect' in v['reason'] for k,v in self.events))
            self.assertEqual(len(files),3)
            self.assertTrue((folder/'chapter-complete.zip').exists())

    def test_denial_never_falls_back(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.fail='denied'
            with self.assertRaises(SourceAccessPaused):self.acquire(Path(tmp))
            self.assertNotIn(3,self.calls)
    def test_wrong_catalog_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.adapter.script_download_expected=lambda *_:[]
            with self.assertRaisesRegex(RuntimeError,'HTML catalog'):self.acquire(Path(tmp))
            self.assertEqual(self.calls,['script_dom_plan'])
    def test_duplicate_selector_and_blob_identity_rejected(self):
        for bad in ([self.items[0],{**self.items[1],'selector':self.items[0]['selector']},self.items[2]], [{**self.items[0],'url':'blob:https://reader.example.test/temporary'},*self.items[1:]]):
            with self.assertRaises(RuntimeError):cs._ordered_dom_plan(dict(url=self.url,items=bad,total=3),self.url,100)
    def test_zip_format_receipt_validation(self):
        orig=self.rpc
        def wrong(action,payload,timeout):
            r=orig(action,payload,timeout)
            if action=='script_dom_read':r['width']=11
            return r
        self.rpc=wrong
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(RuntimeError,'dimensions differ'):self.acquire(Path(tmp))
    def test_mode_is_optional(self):
        self.assertFalse(cs.enabled(SimpleNamespace()))
        self.assertTrue(cs.enabled(self.adapter))

if __name__=='__main__':unittest.main()
