import unittest
from pathlib import Path
from bs4 import BeautifulSoup
from site_specific import site_adapter as adapter
from reusable import open_reader
class ReaderTitleFix(unittest.TestCase):
 def test_dropdown_not_heading(self):
  html='<div class="navi"><div class="chapter-select"><select><option>Chapter 226</option><option>Chapter 2</option></select></div></div><div class="chapter-title"><h1>Relife : Chapter 2</h1></div>'
  self.assertEqual(adapter.chapter_title_from_html(BeautifulSoup(html,'html.parser'),'Chapter 2'),'Chapter 2')
 def test_mismatched_heading_uses_native_label(self):
  self.assertEqual(adapter.chapter_title_from_html(BeautifulSoup('<h1 class="current-book">Chapter 226</h1>','html.parser'),'Chapter 150.5'),'Chapter 150.5')
 def test_captured_catalogue(self):
  raw=(Path(__file__).resolve().parents[1]/'reader_title_catalog_fixture.html').read_text(encoding='utf-8')
  m=adapter.native_chapter_titles_from_catalog(raw,adapter.DEFAULT_START_URL)
  self.assertEqual(len(m),226)
  self.assertEqual(m['truyenqq-relife-chapter-150-5'],'Chapter 150.5')
  self.assertTrue(all(adapter.accept_catalog_title(k,v) for k,v in m.items()))
  self.assertFalse(adapter.accept_catalog_title('truyenqq-relife-chapter-2','Chapter 226'))
 def test_stale_numeric_prefix(self):
  def comic(title):
   return {'slug':'sample','title':'Sample','chapters':[{'id':'native-chapter-2','number':'native-chapter-2','title':title,'label':title,'images':[{'url':'https://test.pages.dev/1.png','sha256':'a'*64,'width':2,'height':3}]}]}
  old,new=comic('Chapter 226'),comic('Chapter 2')
  merged=open_reader.merge_comics(old,new)['chapters'][0]
  self.assertEqual(merged['title'],'Chapter 2');self.assertEqual(merged['label'],'Chapter 2');self.assertEqual(merged['images'],old['chapters'][0]['images'])
if __name__=='__main__':unittest.main()
