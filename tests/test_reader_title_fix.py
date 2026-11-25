import unittest
from pathlib import Path
from bs4 import BeautifulSoup
from site_specific import site_adapter as adapter
from reusable import open_reader
class ReaderTitleFix(unittest.TestCase):
 def test_active_adapter_self_test(self):
  hook=getattr(adapter,'adapter_self_test',None)
  if not callable(hook): self.skipTest('Adapter has no self-test')
  self.assertTrue(hook())
 def test_captured_catalogue(self):
  hook=getattr(adapter,'captured_native_chapter_titles',None)
  if not callable(hook): self.skipTest('Adapter has no captured catalog')
  m=hook()
  self.assertTrue(m)
  validator=getattr(adapter,'accept_catalog_title',None)
  if callable(validator):
   self.assertTrue(all(validator(k,v) for k,v in m.items()))
 def test_stale_numeric_prefix(self):
  def comic(title):
   return {'slug':'sample','title':'Sample','chapters':[{'id':'native-chapter-2','number':'native-chapter-2','title':title,'label':title,'images':[{'url':'https://test.pages.dev/1.png','sha256':'a'*64,'width':2,'height':3}]}]}
  old,new=comic('Chapter 226'),comic('Chapter 2')
  merged=open_reader.merge_comics(old,new)['chapters'][0]
  self.assertEqual(merged['title'],'Chapter 2');self.assertEqual(merged['label'],'Chapter 2');self.assertEqual(merged['images'],old['chapters'][0]['images'])
 def test_id_order_and_images_unchanged_for_corrected_labels(self):
  def chapter(ident,title):
   return {'id':ident,'number':ident,'title':title,'label':title,
           'images':[{'url':'https://test.pages.dev/'+ident+'.png','sha256':'a'*64,'width':2,'height':3}]}
  a={'slug':'sample','title':'Sample','chapters':[chapter('1','Chapter 2'),chapter('2','Chapter 2')]}
  b={'slug':'sample','title':'Sample','chapters':[chapter('1','Chapter 1'),chapter('2','Chapter 2')]}
  merged=open_reader.merge_comics(a,b)['chapters']
  self.assertEqual([x['title'] for x in merged],['Chapter 1','Chapter 2'])
  self.assertEqual([x['images'] for x in merged],[x['images'] for x in a['chapters']])
if __name__=='__main__':unittest.main()
