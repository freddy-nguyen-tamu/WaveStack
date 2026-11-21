"""Regression: restored historical lazy-scroll pass, strict sequential capture.

Replays the chapter-82 failure pattern: the first missing image is still
undecoded while browser-wide unloaded counts decrease. Recovery MUST wait for
actual progress to settle; checkpoint metadata must not fake scroll position.
"""
import ast
import json
import types
import unittest
from pathlib import Path
from urllib.parse import urljoin, urlsplit

ROOT=Path(__file__).resolve().parents[1]
ENGINE=ROOT/'reusable'/'engine.py'
ns={
    'json':json, 'urljoin':urljoin,'urlsplit':urlsplit,
    'event':lambda *args,**kwargs: None,
    'classify_browser_page':lambda page:None,
    'ADAPTER':types.SimpleNamespace(READER_SELECTORS=['main'],IMAGE_ATTRIBUTES=['src'],custom_page_snapshot=None),
    'RuntimeError':RuntimeError,'SourceAccessPaused':type('SourceAccessPaused',(RuntimeError,),{}),
}
tree=ast.parse(ENGINE.read_text(encoding='utf-8'))
scanfn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='scan_browser_images')
exec(compile(ast.Module(body=[scanfn],type_ignores=[]),str(ENGINE),'exec'),ns)
scan=ns['scan_browser_images']

class LazyPage:
    url='https://reader.example.test/chapter/1'
    def __init__(self, scenario='loads_while_scrolling'):
        self.scenario=scenario
        self.y=0
        self.scrolls=0
        self.polls_at_bottom=0
        self.recoveries=[]
        self.reloads=0
        self.waits=[]
    def evaluate(self,script):
        if 'scrollTo(' in script:
            self.y=min(1200,self.y+400)
            self.scrolls+=1
            return 400
        if self.y>=1200:
            self.polls_at_bottom+=1
        # The browser is still lazy-loading other images even though image 2
        # initially has naturalWidth=0, precisely as in the chapter 82 log.
        if self.scenario=='loads_while_scrolling':
            middle_loaded=self.scrolls>=2
        elif self.scenario=='loads_at_bottom':
            middle_loaded=self.polls_at_bottom>=5
        elif self.scenario=='loads_after_reload':
            middle_loaded=self.reloads>0 and self.scrolls>=2
        else:
            middle_loaded=False
        unloaded=0 if middle_loaded else max(1,10-self.scrolls-self.polls_at_bottom)
        imgs=[{'key':str(i),'url':f'https://cdn.example.test/{i}.jpg',
               'loaded':(i!=2 or middle_loaded),
               'width':100 if i!=2 or middle_loaded else 0,
               'height':100 if i!=2 or middle_loaded else 0,
               'pageY':(i-1)*400}
              for i in (1,2,3)]
        return dict(imgs=imgs,total=3,readerCount=3,missingSlots=0,
            unloadedSlots=unloaded,scrollY=self.y,bottom=1200,
            height=2000,viewportHeight=800,revision=int(middle_loaded))
    def recover_unloaded_image(self,key,url,**kwargs):
        self.recoveries.append(key)
        return {'loaded':False,'reason':'not yet decoded'}
    def goto(self,url,**kwargs):
        self.reloads+=1
        self.y=0
        self.scrolls=0
        self.polls_at_bottom=0
    def wait_for_timeout(self,ms):self.waits.append(ms)

class Tests(unittest.TestCase):
    @staticmethod
    def callback(page):
        saved=[]
        def progress(info,order,seen,at_bottom):
            # Mirrors the real callback: encounter first gap -> break, never
            # download or checkpoint a later image before the missing one.
            for key in order:
                if key in saved:continue
                im=next(x for x in info['imgs'] if x['key']==key)
                if not im['loaded'] or (not at_bottom and im['pageY']>info['scrollY']+800):break
                saved.append(key)
            return set(saved)
        return saved,progress

    def test_loading_at_real_scroll_position_is_not_preempted_by_recovery(self):
        page=LazyPage('loads_while_scrolling')
        saved,cb=self.callback(page)
        result=scan(page,max_steps=40,stability=2,on_progress=cb)
        self.assertEqual(saved,['1','2','3'])
        self.assertEqual([x[0] for x in result],['1','2','3'])
        self.assertGreaterEqual(page.scrolls,2)
        self.assertEqual(page.recoveries,[],'loading the source normally should not provoke recovery/reload')
        self.assertEqual(page.reloads,0)

    def test_decreasing_unloaded_count_at_bottom_grants_loading_grace(self):
        page=LazyPage('loads_at_bottom')
        saved,cb=self.callback(page)
        result=scan(page,max_steps=40,stability=2,on_progress=cb)
        self.assertEqual([x[0] for x in result],['1','2','3'])
        self.assertEqual(page.recoveries,[],'no targeted retry while site still loading')
        self.assertEqual(page.reloads,0)
        self.assertGreaterEqual(page.polls_at_bottom,5)
        self.assertTrue(any(ms>=1000 for ms in page.waits),
                        'missing image waits must be passive rather than repeated browser operations')

    def test_real_permanent_missing_page_blocks_later_images_and_publication(self):
        page=LazyPage('permanent')
        saved,cb=self.callback(page)
        with self.assertRaisesRegex(RuntimeError,'First missing image.*2; later images deliberately not attempted'):
            scan(page,max_steps=55,stability=2,on_progress=cb)
        self.assertEqual(saved,['1'])
        self.assertEqual(page.recoveries,['2']*6)
        self.assertEqual(page.reloads,1)

    def test_restore_historical_forward_scan_and_no_catalog_fake_bottom(self):
        source=ENGINE.read_text(encoding='utf-8')
        self.assertIn('recovery_phase = False',source)
        self.assertIn('bottom_no_progress = 0',source)
        self.assertIn('if not targeted_mode and not resume_jump',source)
        self.assertIn("info['physicalAtBottom'] = actual_bottom",source)
        self.assertIn('break  # try this ordinal first, before later pages',source)
        self.assertNotIn('targeted_mode = bool(actual_bottom or resume_catalog)',source)

if __name__=='__main__':unittest.main(verbosity=2)
