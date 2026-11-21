"""An opt-in adapter confirmation must never swallow a local image failure."""
import ast, json, types, unittest
from pathlib import Path
from urllib.parse import urljoin, urlsplit
ROOT=Path(__file__).resolve().parents[1]
SOURCE=ROOT/'reusable/engine.py'
mod=ast.parse(SOURCE.read_text(encoding='utf-8'))
functions=[f for f in mod.body if isinstance(f,ast.FunctionDef) and f.name in ('adapter_confirmed_source_missing','scan_browser_images')]
url='https://reader.example.test/story/episode-82/'
img='https://images.example.test/panel-056.jpg'
seen_events=[]
adapter=types.SimpleNamespace(READER_SELECTORS=('main',),IMAGE_ATTRIBUTES=('src',),custom_page_snapshot=None,
    SOURCE_CONFIRMED_MISSING_PANELS={url:(2,3)})
ns={'json':json,'urljoin':urljoin,'urlsplit':urlsplit,
    'ADAPTER':adapter,'event':lambda n,**kw:seen_events.append((n,kw)),
    'classify_browser_page':lambda p:None,'RuntimeError':RuntimeError,
    'SourceAccessPaused':type('SourceAccessPaused',(RuntimeError,),{})}
exec(compile(ast.Module(body=functions,type_ignores=[]),str(SOURCE),'exec'),ns)
class FakePage:
    url=url
    y=0
    def __init__(self,decoded=False):self.decoded=decoded;self.recoveries=0;self.scrolls=0
    def evaluate(self,s):
        if 'scrollTo(' in s:
            self.scrolls+=1;self.y=min(400,self.y+400);return 400
        return {'imgs':[{'key':str(i),'url':f'https://images.example.test/{i}.jpg',
                 'loaded': self.decoded or i not in (2,3), 'pageY':0,'width':0,'height':0} for i in range(1,5)],
                'total':4,'readerCount':4,'missingSlots':0,
                'unloadedSlots': 0 if self.decoded else 2,
                'scrollY':self.y,'bottom':400,'height':1200,'viewportHeight':800,'revision':0}
    def recover_unloaded_image(self,*a,**kw):
        self.recoveries+=1;raise RuntimeError('transport stalled')
    def wait_for_timeout(self,*a):pass
class Checkpoint:
    chapter_id='82'
    def catalog_matches(self,*a):return False
    def verified_prefix(self,*a):return 0
class Tests(unittest.TestCase):
    def test_exact_url_and_key_and_decoded_required(self):
        fn=ns['adapter_confirmed_source_missing']
        record={url:(56,57)}
        self.assertIsNotNone(fn(url,'82','56',{'loaded':False},img,record))
        self.assertIsNone(fn(url,'82','58',{'loaded':False},img,record))
        self.assertIsNone(fn('https://reader.example.test/other/','82','56',{'loaded':False},img,record))
        self.assertIsNone(fn(url,'82','56',{'loaded':True},img,record))
        self.assertIsNone(fn(url,'82','56',{'loaded':False},'javascript:bad',record))
    def test_declared_broken_slots_do_not_invoke_stalled_recovery(self):
        page=FakePage();saved=set();failed={};captures=[]
        def progress(info,keys,seen,at_bottom):
            for k,im in zip(keys,info['imgs']):
                if k in saved or k in failed:continue
                if not im['loaded']:break
                saved.add(k);captures.append(k)
            return saved
        progress.server_missing_keys=failed
        def register(k,v):failed[k]=v
        progress.confirm_server_failure=register
        found=ns['scan_browser_images'](page,max_steps=30,stability=2,
               on_progress=progress,checkpoint=Checkpoint())
        self.assertEqual([k for k,_ in found],['1','2','3','4'])
        self.assertEqual(captures,['1','4']);self.assertEqual(set(failed),{'2','3'})
        self.assertEqual(page.recoveries,0)
    def test_decoded_images_are_never_excused_even_if_declared(self):
        page=FakePage(decoded=True);saved=set();failed={}
        def progress(info,keys,seen,at_bottom):
            for k in keys:saved.add(k)
            return saved
        progress.server_missing_keys=failed
        progress.confirm_server_failure=lambda k,v:failed.update({k:v})
        ns['scan_browser_images'](page,max_steps=30,stability=2,on_progress=progress,checkpoint=Checkpoint())
        self.assertEqual(failed,{})
if __name__=='__main__':unittest.main()
