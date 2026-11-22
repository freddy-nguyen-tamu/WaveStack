"""Bell actions and missing-chapter behavior; no network or remote mutation."""
from pathlib import Path
import json
import shutil
import subprocess
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]

class BellLinks(unittest.TestCase):
    def test_two_independent_destinations(self):
        js=(ROOT/'reader/reader-issues.js').read_text(encoding='utf-8')
        self.assertIn("'Open original source'",js)
        self.assertIn("'Open affected chapter'",js)
        self.assertIn("reader.href='/comics/'",js)
        self.assertNotIn("let destination=''",js)
        self.assertIn("source.target='_blank'",js)
        # Actually evaluate the link block with a DOM double in Node.
        start=js.index('      // Two independent destinations:')
        end=js.index('      for(const c of issues){',start)
        block=js[start:end]
        probe="""
const assert=require('node:assert/strict');
const source=process.argv[1];
const document={createElement:()=>({children:[],append(x){this.children.push(x)},get childElementCount(){return this.children.length}})};
const text=(tag,value,cl)=>({tag,value,className:cl});
const cases=[
  {work_slug:'comic-a',episode_id:'vol-12-ch-97',source_chapter_url:'https://source.example/chap/97'},
  {work_slug:'comic-a',episode_id:'vol-12-ch-98',source_chapter_url:''},
  {work_slug:'comic-a',episode_id:'vol-12-ch-99',source_chapter_url:'javascript:alert(1)'},
  {work_slug:'../../bad',episode_id:'vol-12-ch-99',source_chapter_url:'https://source.example/a'}
];
for(const first of cases){
  const group={children:[],append(x){this.children.push(x)}};
  new Function('first','group','document','text',source)(first,group,document,text);
  const actions=group.children[0]?.children||[];
  const reader=actions.find(x=>x.value==='Open affected chapter');
  const original=actions.find(x=>x.value==='Open original source');
  if(first.work_slug==='../../bad')assert.equal(reader,undefined);
  else assert.equal(reader.href,'/comics/comic-a/?chapter='+encodeURIComponent(first.episode_id));
  if(first.source_chapter_url.startsWith('https:')){
    assert.equal(original.href,first.source_chapter_url);
    assert.equal(original.target,'_blank');
  }else assert.equal(original,undefined);
}
"""
        p=subprocess.run(['node','-e',probe,block],capture_output=True,text=True,timeout=15)
        self.assertEqual(p.returncode,0,p.stderr)

    def test_unknown_chapter_is_not_replaced_by_first_chapter(self):
        js=(ROOT/'reusable/open_reader.py').read_text(encoding='utf-8')
        self.assertIn('Chapter not yet available',js)
        self.assertIn('if(chapterIndex<0 && params.has(\'chapter\'))',js)
        self.assertIn('Another chapter will not be substituted.',js)
        # The original app remains unchanged; generated routes add this guard.
        original=(ROOT/'reader/app.js').read_text(encoding='utf-8')
        self.assertNotIn('or-unpublished-chapter',original)

if __name__=='__main__': unittest.main()
