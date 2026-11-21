"""Mandatory fail-closed tests: no missing ordinal may be skipped, even on resume."""
import ast
import json
import types
import unittest
from pathlib import Path
from urllib.parse import urljoin, urlsplit

ROOT=Path(__file__).resolve().parents[1]
ENGINE=ROOT/'reusable'/'engine.py'
module=ast.parse(ENGINE.read_text(encoding='utf-8'))
scanner=next(n for n in module.body if isinstance(n,ast.FunctionDef) and n.name=='scan_browser_images')
seen_events=[]
ns={'json':json,'urljoin':urljoin,'urlsplit':urlsplit,
    'event':lambda name, **fields:seen_events.append((name,fields)),
    'classify_browser_page':lambda page:None,
    'ADAPTER':types.SimpleNamespace(READER_SELECTORS=['main'],IMAGE_ATTRIBUTES=['src'],custom_page_snapshot=None),
    'RuntimeError':RuntimeError,'SourceAccessPaused':type('SourceAccessPaused',(RuntimeError,),{})}
exec(compile(ast.Module(body=[scanner],type_ignores=[]),str(ENGINE),'exec'),ns)
scan=ns['scan_browser_images']

class Page:
    url='https://example.test/chapter/1'
    def __init__(self, *, load_after_reload=False, always_missing=False, decoded_failure=False):
        self.y=0
        self.reloads=0
        self.scrolls=0
        self.recoveries=[]
        self.load_after_reload=load_after_reload
        self.always_missing=always_missing
        self.decoded_failure=decoded_failure
    def evaluate(self,script):
        if 'scrollTo(' in script:
            self.y=min(400,self.y+400)
            self.scrolls+=1
            return 400
        loaded2=(not self.always_missing and self.reloads>0 and self.load_after_reload)
        return {'imgs':[
            {'key':'1','url':'https://img.example.test/1.jpg','loaded':True,'pageY':0,'width':80,'height':90},
            {'key':'2','url':'https://img.example.test/2.jpg','loaded':loaded2 or self.decoded_failure,'pageY':400,'width':80,'height':90},
            {'key':'3','url':'https://img.example.test/3.jpg','loaded':True,'pageY':800,'width':80,'height':90}],
            'total':3,'readerCount':3,'missingSlots':0,'unloadedSlots':int(not loaded2 and not self.decoded_failure),
            'scrollY':self.y,'bottom':400,'height':1200,'viewportHeight':800,'revision':self.reloads}
    def wait_for_timeout(self,ms):pass
    def goto(self,url,**kwargs):
        self.reloads+=1
        self.y=0
    def recover_unloaded_image(self,key,url,**kwargs):
        self.recoveries.append((key,kwargs))
        return {'loaded':False,'reason':'not decoded'}

class Tests(unittest.TestCase):
    def setUp(self):seen_events.clear()
    def progress(self,page, *, fail_decoded=False):
        saved=set()
        captures=[]
        def cb(info,slots,seen,bottom):
            cb.failed_key=None
            reach=info['scrollY']+info['viewportHeight']+120
            for k in slots:
                if k in saved:continue
                im=next(im for im in info['imgs'] if im['key']==k)
                if not im['loaded'] or im['pageY']>reach:break
                if fail_decoded and k=='2' and not page.recoveries:
                    cb.failed_key=k
                    break
                saved.add(k)
                captures.append(k)
            return saved
        return cb,saved,captures
    def test_hard_barrier_blocks_later_decoded_pages(self):
        p=Page(always_missing=True)
        cb,saved,captures=self.progress(p)
        with self.assertRaisesRegex(RuntimeError,'First missing image after natural lazy loading and targeted recovery'):
            scan(p,max_steps=30,stability=2,on_progress=cb)
        self.assertEqual(captures,['1'])
        self.assertEqual(saved,{'1'})
        self.assertEqual([r[0] for r in p.recoveries],['2']*6)
        self.assertEqual(p.reloads,1)
        self.assertTrue(all(name!='SOURCE_LAZY_SCROLL_COMPLETE' for name,_ in seen_events))
    def test_single_normal_reload_then_missing_image_succeeds(self):
        p=Page(load_after_reload=True)
        cb,saved,captures=self.progress(p)
        result=scan(p,max_steps=30,stability=2,on_progress=cb)
        self.assertEqual([k for k,_ in result],['1','2','3'])
        self.assertEqual(captures,['1','2','3'])
        self.assertEqual(p.reloads,1)
        self.assertEqual([r[0] for r in p.recoveries],['2']*3)
        self.assertEqual(saved,{'1','2','3'})
    def test_failure_never_continues_after_reload(self):
        p=Page(always_missing=True)
        cb,saved,captures=self.progress(p)
        with self.assertRaisesRegex(RuntimeError,'Chapter not published'):
            scan(p,max_steps=30,stability=2,on_progress=cb)
        self.assertEqual(captures,['1'])
        self.assertEqual(p.reloads,1)
        self.assertEqual(len(p.recoveries),6)
    def test_decoded_capture_failure_repositions_same_image(self):
        p=Page(decoded_failure=True)
        def rescue(key,url,**kw):
            p.recoveries.append((key,kw))
            return {'loaded':True}
        p.recover_unloaded_image=rescue
        cb,saved,captures=self.progress(p,fail_decoded=True)
        result=scan(p,max_steps=30,stability=2,on_progress=cb)
        self.assertEqual([k for k,_ in result],['1','2','3'])
        self.assertEqual(captures,['1','2','3'])
        self.assertEqual(p.recoveries[0][0],'2')
        self.assertTrue(p.recoveries[0][1]['force_position'])
        self.assertEqual(p.reloads,0)
    def test_explicit_source_pause_is_never_swallowed_by_image_retry(self):
        p=Page(always_missing=True)
        def paused(key,url,**kwargs):
            raise ns['SourceAccessPaused']('HTTP 429: site requested a pause')
        p.recover_unloaded_image=paused
        cb,saved,captures=self.progress(p)
        with self.assertRaisesRegex(ns['SourceAccessPaused'],'HTTP 429'):
            scan(p,max_steps=30,stability=2,on_progress=cb)
        self.assertEqual(captures,['1'])
        self.assertEqual(p.reloads,0)

    def test_network_evidence_is_observation_only(self):
        bg=(ROOT/'reusable/browser_bridge_extension/background.js').read_text()
        self.assertIn("action==='image_diagnostics'",bg)
        self.assertIn("method === 'Network.responseReceived'",bg)
        self.assertIn('imageNetworkStatus.get(key)',bg)
        # No second tab, synthetic cookie, or DevTools GUI automation is needed.
        diagnostic=bg.split("if(action==='image_diagnostics') {",1)[1].split('const type=',1)[0]
        self.assertNotIn('fetch(',diagnostic)
        self.assertNotIn('tabs.update',diagnostic)
    def test_resume_catalog_not_mistaken_for_physical_bottom(self):
        body=ENGINE.read_text()
        self.assertIn("info['physicalAtBottom'] = actual_bottom",body)
        self.assertIn("info.get('physicalAtBottom', at_bottom)",body)
        self.assertIn('break  # never attempt a later image after a capture error',body)

if __name__=='__main__':unittest.main(verbosity=2)
