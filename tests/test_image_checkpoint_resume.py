"""Fail-closed tests of interruption, checksum, source identity, and fast resume."""
import ast
import hashlib
import json
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urljoin, urlsplit
from PIL import Image
from reusable.image_checkpoint import ChapterImageCheckpoint

ROOT=Path(__file__).resolve().parents[1]

class Tests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.folder=Path(self.tmp.name)
        self.url='https://example.com/chapter/1'
        self.cp=ChapterImageCheckpoint(self.folder,'1',self.url)

    def make_image(self, index=1, source_url=None):
        url=source_url or f'https://cdn.example.com/{index}.jpg'
        path=self.folder/f'{index:04d}.png'
        Image.new('RGB',(index+8,index+10), 'white').save(path)
        raw=path.read_bytes()
        meta={'source_url':url,'sha256':hashlib.sha256(raw).hexdigest(),
              'bytes':len(raw),'width':index+8,'height':index+10,'format':'png'}
        return url,path,meta

    def test_restart_reuses_verified_file_without_network(self):
        url,path,meta=self.make_image()
        self.cp.record_image('p1',1,url,path,meta)
        after=ChapterImageCheckpoint(self.folder,'1',self.url)
        assert after.reuse('p1',1,url)
        self.assertEqual(after.reuse('p1',1,url)[0],path)

    def test_rejects_corrupt_file(self):
        url,path,meta=self.make_image();self.cp.record_image('p1',1,url,path,meta)
        path.write_bytes(b'invalid')
        self.assertIsNone(ChapterImageCheckpoint(self.folder,'1',self.url).reuse('p1',1,url))

    def test_rejects_wrong_order_url_or_chapter(self):
        url,path,meta=self.make_image();self.cp.record_image('p1',1,url,path,meta)
        new=ChapterImageCheckpoint(self.folder,'1',self.url)
        self.assertIsNone(new.reuse('p1',2,url))
        self.assertIsNone(new.reuse('p1',1,'https://cdn.example.com/changed.jpg'))
        self.assertIsNone(ChapterImageCheckpoint(self.folder,'2',self.url).reuse('p1',1,url))
        self.assertIsNone(ChapterImageCheckpoint(self.folder,'1',self.url+'/other').reuse('p1',1,url))

    def test_rejects_unsafe_filename_and_forged_bytes(self):
        url,path,meta=self.make_image()
        with self.assertRaises(ValueError):self.cp.record_image('p1',2,url,path,meta)
        self.cp.record_image('p1',1,url,path,meta)
        obj=json.loads(self.cp.path.read_text());obj['images']['p1']['filename']='../../other.png'
        self.cp.path.write_text(json.dumps(obj))
        self.assertIsNone(ChapterImageCheckpoint(self.folder,'1',self.url).reuse('p1',1,url))

    def test_catalog_requires_exact_dom_order_and_complete_urls(self):
        seen={str(i):{'url':f'https://cdn.example.com/{i}.png'} for i in range(1,4)}
        self.assertTrue(self.cp.record_catalog(['1','2','3'],seen))
        self.assertTrue(ChapterImageCheckpoint(self.folder,'1',self.url).catalog_matches(['1','2','3'],seen,3))
        self.assertFalse(self.cp.catalog_matches(['1','3','2'],seen,3))
        self.assertFalse(self.cp.catalog_matches(['1','2','3'],seen,4))
        self.assertFalse(self.cp.record_catalog(['1','1'],seen))

    def test_actual_acquire_chapter_reuses_saved_images_after_interruption(self):
        from reusable import engine
        class Page:
            url='https://example.com/chapter/1'
            def goto(self,url,**_):self.url=url
            def content(self):return '<html><head><title>Test chapter</title></head><body></body></html>'
            def close(self):pass
        page=Page()
        ctx=types.SimpleNamespace(new_page=lambda:page,request=types.SimpleNamespace(reuses_loaded_page_images=True))
        chapter=engine.Chapter('1','Test chapter',self.url)
        imgs=[{'key':str(i),'url':f'https://cdn.example.com/{i}.jpg',
               'loaded':True,'pageY':i*100,'width':10,'height':10} for i in range(1,4)]
        info={'imgs':imgs,'total':3,'scrollY':1000,'bottom':900,'height':1900,
              'viewportHeight':800,'missingSlots':0}
        seen={im['key']:{'url':im['url'],'width':10,'height':10} for im in imgs}
        attempts=[]
        fail_third=True
        def fetch(ctx,url,dest,*args,**kw):
            nonlocal fail_third
            idx=int(url.rsplit('/',1)[-1].split('.')[0]);attempts.append(idx)
            if idx==3 and fail_third:raise RuntimeError('simulated browser termination')
            image=dest.with_suffix('.png');Image.new('RGB',(10,10),'white').save(image)
            raw=image.read_bytes()
            return image, {'source_url':url,'sha256':hashlib.sha256(raw).hexdigest(),
                           'bytes':len(raw),'width':10,'height':10,'format':'png'}
        def scan(*args,**kwargs):
            saved=kwargs['on_progress'](info,['1','2','3'],seen,True)
            if len(saved)!=3:raise RuntimeError('interrupted before third image')
            return [(str(i),seen[str(i)]) for i in range(1,4)]
        with patch.object(engine,'scan_browser_images',side_effect=scan),patch.object(engine,'image_download',side_effect=fetch), patch.object(engine.ADAPTER,'after_chapter_visit',None,create=True), patch.object(engine.ADAPTER,'CHAPTER_DOWNLOAD_JS',None,create=True):
            with self.assertRaisesRegex(RuntimeError,'interrupted'):
                engine.acquire_chapter(ctx,chapter,self.folder)
            self.assertEqual(attempts,[1,2,3])
            fail_third=False
            files,manifest=engine.acquire_chapter(ctx,chapter,self.folder)
        self.assertEqual(attempts,[1,2,3,3], 'already checkpointed images must never be refetched')
        self.assertEqual([file.name for file in files],['0001.png','0002.png','0003.png'])
        self.assertEqual([m['order'] for m in manifest['images']],[1,2,3])

    def test_interrupted_mid_scroll_jumps_over_verified_prefix(self):
        from urllib.parse import urljoin, urlsplit
        p=ROOT/'reusable'/'engine.py';tree=ast.parse(p.read_text())
        func=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='scan_browser_images')
        ns={'json':json,'urljoin':urljoin,'urlsplit':urlsplit, 'event':lambda *a,**k:None,
            'classify_browser_page':lambda page:None,
            'ADAPTER':types.SimpleNamespace(READER_SELECTORS=['main'],IMAGE_ATTRIBUTES=['src'],custom_page_snapshot=None),
            'RuntimeError':RuntimeError,'SourceAccessPaused':type('SourceAccessPaused',(RuntimeError,),{})}
        exec(compile(ast.Module(body=[func],type_ignores=[]),str(p),'exec'),ns)
        for i in (1,2):
            url,path,meta=self.make_image(i)
            self.cp.record_image(str(i),i,url,path,meta)
        class Page:
            url='https://example.com/chapter/1'
            def __init__(self):self.y=0;self.scrolls=0;self.recoveries=[]
            def evaluate(self,script):
                if 'scrollTo(' in script:
                    self.y=min(3600,self.y+700);self.scrolls+=1;return 700
                imgs=[{'key':str(i),'url':f'https://cdn.example.com/{i}.jpg',
                       'loaded':True,'width':15,'height':15,'pageY':(i-1)*700} for i in range(1,5)]
                return dict(imgs=imgs,total=4,readerCount=4,missingSlots=0,unloadedSlots=0,
                    scrollY=self.y,bottom=2100,height=2900,viewportHeight=800,revision=0)
            def recover_unloaded_image(self,key,url):
                self.recoveries.append(key);self.y=1400;return {'loaded':True}
            def wait_for_timeout(self,ms):pass
        page=Page();saved={'1','2'}
        def on_progress(info,order,seen,bottom):
            for key in order:
                if int(key)*700<=info['scrollY']+800:saved.add(key)
            return saved
        found=ns['scan_browser_images'](page,max_steps=20,stability=2,
                                          on_progress=on_progress,checkpoint=self.cp)
        self.assertEqual(page.recoveries,['3'])
        self.assertEqual(page.scrolls,1)  # begins at image 3, not image 1
        self.assertEqual([k for k,_ in found],['1','2','3','4'])

    def test_resume_fast_path_skips_full_scroll_and_only_tries_missing_slots(self):
        # Run the *real scan function* with an adapter-independent fake browser.
        p=ROOT/'reusable'/'engine.py'
        tree=ast.parse(p.read_text())
        func=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='scan_browser_images')
        logs=[]
        ns={'json':json,'urljoin':urljoin,'urlsplit':urlsplit, 'event':lambda *x,**kw:logs.append((x,kw)),
            'classify_browser_page':lambda page:None,
            'ADAPTER':types.SimpleNamespace(READER_SELECTORS=['main'],IMAGE_ATTRIBUTES=['src'],custom_page_snapshot=None),
            'RuntimeError':RuntimeError,'SourceAccessPaused':type('SourceAccessPaused',(RuntimeError,),{})}
        exec(compile(ast.Module(body=[func],type_ignores=[]),str(p),'exec'),ns)
        seen={str(i):{'url':f'https://cdn.example.com/{i}.jpg','width':100,'height':100} for i in range(1,4)}
        self.cp.record_catalog(['1','2','3'],seen)
        u,path,meta=self.make_image(1)
        self.cp.record_image('1',1,u,path,meta)
        class Page:
            url='https://example.com/chapter/1'
            def __init__(self):self.scrolls=0;self.recoveries=[];self.loaded=False;self.y=0
            def evaluate(self,script):
                if 'scrollTo(' in script:
                    self.scrolls+=1
                    self.y=min(10000,self.y+1000)
                    return 1
                imgs=[{'key':str(i),'url':f'https://cdn.example.com/{i}.jpg',
                        'width':100,'height':100,'loaded':i!=2 or self.loaded,'pageY':i*1000}
                      for i in range(1,4)]
                return {'imgs':imgs,'total':3,'scrollY':self.y,'bottom':10000,'height':10800,
                        'viewportHeight':800,'missingSlots':0,'unloadedSlots':int(not self.loaded),'revision':0}
            def recover_unloaded_image(self,key,url):
                self.recoveries.append(key)
                self.loaded=True
                self.y=1500  # physically moves the existing tab to the missing second image
                return {'loaded':True}
            def wait_for_timeout(self,ms):pass
        page=Page();saved={'1','3'}
        def progress(info,order,seen,bottom):
            for im in info['imgs']:
                if im['key']=='2' and im['loaded'] and im['pageY']<=info['scrollY']+800:
                    saved.add('2')
            return saved
        results=ns['scan_browser_images'](page,max_steps=20,stability=2,on_progress=progress,checkpoint=self.cp)
        self.assertEqual(page.scrolls,0)
        self.assertEqual(page.recoveries,['2'])
        self.assertEqual([k for k,_ in results],['1','2','3'])
        self.assertTrue(any(args[0]=='CHAPTER_RESUME_CATALOG_VERIFIED' for args,kw in logs))

if __name__=='__main__':unittest.main()
