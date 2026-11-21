"""Standalone regression test of generic streaming reader. No provider-specific selectors."""
import ast, json, re, types, unittest
from pathlib import Path
from urllib.parse import urljoin, urlsplit
from unittest.mock import Mock
P=Path(__file__).resolve().parents[1]/'reusable'/'engine.py'
tree=ast.parse(P.read_text()); func=next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='scan_browser_images')
ns={'json':json,'urljoin':urljoin,'urlsplit':urlsplit,'event':lambda *a,**k:None,
    'classify_browser_page':lambda page:None,
    'ADAPTER':types.SimpleNamespace(READER_SELECTORS=['main'],IMAGE_ATTRIBUTES=['src'],custom_page_snapshot=None),
    'RuntimeError':RuntimeError}
exec(compile(ast.Module(body=[func],type_ignores=[]),str(P),'exec'),ns)
scan=ns['scan_browser_images']
class SimPage:
  url='https://example.com/chap-1'
  def __init__(self,late=False,permuted=False,failed=False,omit_initial_url=False):
    self.y=0;self.scrolls=0;self.captures=[];self.recovered=[];self.late=late;self.permuted=permuted;self.failed=failed;self.omit_initial_url=omit_initial_url
  def evaluate(self,script):
    if 'scrollTo(' in script:
      self.scrolls += 1;self.y=min(self.y+500,1000);return 500
    keys=['1','2','3'] if not self.permuted else ['1','3','2']
    imgs=[]
    for idx,k in enumerate(keys):
      y=(int(k)-1)*550
      loaded = (self.y+600>=y and (not self.late or k!='2' or bool(self.recovered)))
      url='' if self.omit_initial_url and not self.scrolls and k=='1' else f'https://cdn.example.com/{k}.jpg'
      imgs.append(dict(key=k,url=url,width=100,height=200,loaded=loaded,pageY=y))
    return dict(imgs=imgs,total=3,readerCount=3,missingSlots=sum(not im['url'] for im in imgs),unloadedSlots=sum(not im['loaded'] for im in imgs), scrollY=self.y,bottom=1000,height=1800,viewportHeight=800,revision=0)
  def wait_for_timeout(self,ms):pass
  def recover_unloaded_image(self,key,url): self.recovered.append(key);return {'loaded':True,'reason':'simulated'}
class Tests(unittest.TestCase):
  def callback(self,page):
    saved={}; seen_order=[]
    def on_progress(info,slot_order,seen,at_bottom):
      for idx,key in enumerate(slot_order,1):
        im=next(im for im in info['imgs'] if im['key']==key)
        if key not in saved and im['loaded'] and im['url'] and (im['pageY']<=info['scrollY']+800 or at_bottom):
          saved[key]=f'{idx:04d}.jpg';seen_order.append(key)
      return set(saved)
    return saved,seen_order,on_progress
  def test_one_forward_scroll_preserves_original_order(self):
    p=SimPage();saved,seq,callback=self.callback(p)
    pages=scan(p,max_steps=25,stability=2,on_progress=callback)
    self.assertEqual(seq,['1','2','3'])
    self.assertEqual([x[0] for x in pages],['1','2','3'])
    self.assertEqual(list(saved.values()),['0001.jpg','0002.jpg','0003.jpg'])
    self.assertEqual(p.scrolls,2)
  def test_only_unloaded_image_gets_targeted_retry(self):
    p=SimPage(late=True);saved,seq,callback=self.callback(p)
    pages=scan(p,max_steps=25,stability=2,on_progress=callback)
    self.assertEqual(p.recovered,['2'])
    self.assertEqual([x[0] for x in pages],['1','2','3'])
    self.assertEqual(saved['2'],'0002.jpg')
  def test_late_url_preserves_slot_index_not_discovery_order(self):
    p=SimPage(omit_initial_url=True);saved,seq,callback=self.callback(p)
    pages=scan(p,max_steps=25,stability=2,on_progress=callback)
    self.assertEqual([x[0] for x in pages],['1','2','3'])
  def test_out_of_order_ordinals_rejected(self):
    p=SimPage(permuted=True);saved,seq,callback=self.callback(p)
    with self.assertRaisesRegex(RuntimeError,'not in exact'):
      scan(p,max_steps=25,stability=2,on_progress=callback)
  def test_transient_browser_recovery_stall_is_deferred_and_retry_succeeds(self):
    p=SimPage(late=True);attempts=[]
    def recover(key,url):
      attempts.append(key)
      if len(attempts)==1:
        raise RuntimeError('Browser recover_image failed: Selected-tab browser API stalled')
      p.recovered.append(key)
      return {'loaded':True,'reason':'loaded on next attempt'}
    p.recover_unloaded_image=recover
    saved,_,callback=self.callback(p)
    pages=scan(p,max_steps=30,stability=2,on_progress=callback)
    self.assertEqual(attempts,['2','2'])
    self.assertEqual([x[0] for x in pages],['1','2','3'])
    self.assertEqual(set(saved),{'1','2','3'})
  def test_persistent_browser_recovery_stall_never_publishes_missing_image(self):
    p=SimPage(late=True);attempts=[]
    def recover(key,url):
      attempts.append(key)
      raise RuntimeError('Browser recover_image failed: Selected-tab browser API stalled')
    p.recover_unloaded_image=recover
    saved,_,callback=self.callback(p)
    with self.assertRaisesRegex(RuntimeError,'Images still missing after targeted retries: 2'):
      scan(p,max_steps=30,stability=2,on_progress=callback)
    self.assertEqual(attempts,['2','2','2'])
    self.assertEqual(set(saved),{'1','3'})
  def test_failed_image_cannot_be_marked_complete(self):
    p=SimPage(late=True)
    def on_progress(info,slot_order,seen,bottom):return {'1','3'}
    with self.assertRaisesRegex(RuntimeError,'missing|exhausted|Missing|not verified'):
      scan(p,max_steps=25,stability=2,on_progress=on_progress)
if __name__=='__main__':unittest.main(verbosity=2)
