"""Browser-DOM regression: three in flight, ordinal reveal, no neighboring chapters."""
import ast
from pathlib import Path
import subprocess
import unittest
from tests.test_full_chapter_eager_load import SequentialAndUploadTests

ROOT=Path(__file__).resolve().parents[1]
class WindowedChapterTests(SequentialAndUploadTests):
    def test_six_panels_three_in_flight_ordered_reveal(self):
        tree=ast.parse((ROOT/'tests/test_full_chapter_eager_load.py').read_text('utf8'))
        js=None
        for node in ast.walk(tree):
            if isinstance(node,ast.FunctionDef) and node.name=='test_loader_simulated_in_order_with_and_without_placeholders':
                for child in node.body:
                    if isinstance(child,ast.Assign) and isinstance(child.value,ast.Constant) and isinstance(child.value.value,str):
                        if any(isinstance(t,ast.Name) and t.id=='js' for t in child.targets):js=child.value.value
        self.assertIsNotNone(js)
        source=js.split('(async()=>{',1)[0]
        orig="{id:'complete',images:[img('a'),img('b'),img('c')]}"
        self.assertIn(orig,source)
        source=source.replace(orig,"{id:'complete',images:[img('a'),img('b'),img('c'),img('d'),img('e'),img('f')]}")
        test=r'''
(async()=>{
 await flush();
 const names=['a','b','c','d','e','f'].map(n=>img(n).url);
 const pages=elem('#pages');
 assert.deepEqual(requested,names.slice(0,3),'only first 3 images requested initially');
 assert.equal(pages.children.length,1,'spinner only before first panel is decoded');
 async function until(fn){for(let i=0;i<35&&!fn();i++){await tick();await flush()}assert.ok(fn(),'queue did not progress')}
 // Complete panel 3 before panel 1. No out-of-order reveal is permitted.
 imgs[2].naturalWidth=10;imgs[2].onload();await tick();
 assert.equal(pages.children.length,1,'panel 3 cannot render before panel 1');
 assert.deepEqual(requested,names.slice(0,3));
 imgs[0].naturalWidth=10;imgs[0].onload();
 await until(()=>pages.children[0]?.tag==='figure');
 assert.equal(pages.children[0].children[0],imgs[0]);
 assert.deepEqual(requested,names.slice(0,4),'next panel starts after first visible');
 // Even with panel 3 decoded, it cannot display until 2 is ready.
 assert.equal(pages.children.filter(x=>x.tag==='figure').length,1);
 imgs[1].naturalWidth=10;imgs[1].onload();
 await until(()=>pages.children.filter(x=>x.tag==='figure').length>=3);
 assert.deepEqual(pages.children.filter(x=>x.tag==='figure').map(x=>x.children[0]),imgs.slice(0,3));
 assert.ok(requested.length<=6);
 for(let i=3;i<6;i++){
   // A request is in flight only for current chapter; it may start after
   // an earlier ordinal becomes visible and opens the bounded window.
   await until(()=>requested.includes(names[i]));
   imgs[i].naturalWidth=10;imgs[i].onload();
 }
 await until(()=>pages.children.length===6&&pages.children.every(x=>x.tag==='figure'));
 assert.deepEqual(requested,names);
 assert.deepEqual(pages.children.map(x=>x.children[0]),imgs,'all six visible in exact order');
 assert.equal(requested.some(x=>/prev|next/.test(x)),false,'neighbor chapters not fetched');
 console.log('PASS 3-wide current-chapter downloads, strict ordinal reveal, next only when slot frees');
})().catch(e=>{console.error(e);process.exitCode=1});
'''
        proc=subprocess.run(['node','-e',source+test,str(self.app),'complete'],text=True,capture_output=True,timeout=25)
        self.assertEqual(proc.returncode,0,proc.stdout+'\n'+proc.stderr)
        self.assertIn('PASS 3-wide',proc.stdout)
