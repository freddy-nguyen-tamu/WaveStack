"""Live-queue behavior: an already uploaded replacement must load at its panel ordinal."""
import ast
import subprocess
import tempfile
import unittest
from pathlib import Path
from reusable import open_reader

ROOT=Path(__file__).resolve().parents[1]

class OrderedUploadedReplacementTests(unittest.TestCase):
    def test_staged_reader_loads_newly_repaired_panel_before_later_images(self):
        # Reuse the established browser-DOM fixture rather than creating a
        # weaker second fake browser with different image-loading semantics.
        tree=ast.parse((ROOT/'tests/test_full_chapter_eager_load.py').read_text('utf-8'))
        fixture=None
        for node in ast.walk(tree):
            if isinstance(node,ast.FunctionDef) and node.name=='test_loader_simulated_in_order_with_and_without_placeholders':
                for child in node.body:
                    if (isinstance(child,ast.Assign) and isinstance(child.value,ast.Constant) and
                        isinstance(child.value.value,str) and any(isinstance(x,ast.Name) and x.id=='js' for x in child.targets)):
                        fixture=child.value.value
        self.assertTrue(fixture,'previous browser DOM test fixture unavailable')
        # Real partial manifest now contains the uploaded replacement because
        # the Worker was asked to refresh only the selected chapter.
        old="fetch:async()=>({ok:true,json:async()=>manifest})"
        new="""fetch:async url=>{
   const u=new URL(String(url),location.href); 
   assert.equal(u.pathname,'/comics/sample/manifest.json');
   if(!u.searchParams.has('refresh-repairs-for'))
     return {ok:true,json:async()=>manifest};
   assert.equal(u.searchParams.get('refresh-repairs-for'),selected);
   const fresh=JSON.parse(JSON.stringify(manifest));
   fresh.chapters[1].images[1]={url:'https://reader.test/api/github-image/sample/partial/2?v='+('a'.repeat(64)),sha256:'a'.repeat(64),width:10,height:10};
   return new Promise(resolve=>{globalThis.releaseRepair=()=>resolve({ok:true,json:async()=>fresh})});
 }"""
        self.assertIn(old,fixture)
        fixture=fixture.replace(old,new,1)
        old="const expected=selected==='partial' ? [img('a').url,img('c').url]:[img('a').url,img('b').url,img('c').url];"
        new="const expected=selected==='partial' ? [img('a').url,'https://reader.test/api/github-image/sample/partial/2?v='+('a'.repeat(64)),img('c').url]:[img('a').url,img('b').url,img('c').url];"
        self.assertIn(old,fixture)
        fixture=fixture.replace(old,new,1)
        old=" if(selected==='partial')assert.equal(pages.children[1].className,'or-missing-panel','missing marker in exact second slot');\n"
        self.assertIn(old,fixture)
        fixture=fixture.replace(old,'',1)
        initial_assert=" assert.deepEqual(requested,expected,'max three current-chapter images request immediately');"
        self.assertIn(initial_assert,fixture)
        fixture=fixture.replace(initial_assert," assert.deepEqual(requested,[expected[0],expected[2]],'only two known sources start before repaired panel becomes available');"+"\n if(selected==='partial'){ assert.equal(typeof globalThis.releaseRepair,'function'); globalThis.releaseRepair(); await new Promise(r=>setImmediate(r)); }",1)
        fixture=fixture.replace(
            " assert.deepEqual(requested,expected,'early window remains bounded regardless of scrolling');",
            " assert.deepEqual(requested,[expected[0],expected[2],expected[1]],'three image requests, with replacement ordered for display');")
        fixture=fixture.replace(
            " assert.equal(requested.length,selected==='complete'?3:2,'only selected-chapter images requested');",
            " assert.equal(requested.length,3,'only three selected-chapter images requested');")
        fixture=fixture.replace("   assert.deepEqual(requested,expected,'three ordered chapter requests');",
            "   assert.deepEqual(requested,[expected[0],expected[2],expected[1]],'three requests stay within chapter');")
        fixture=fixture.replace(" assert.deepEqual(requested,expected);",
            " assert.deepEqual(requested,[expected[0],expected[2],expected[1]]);",1)
        # The repaired image is constructed when its ordinal is reached, after
        # the existing source image nodes have already been created.
        original_second=' imgs[1].naturalWidth=10;imgs[1].onload();await tick();'
        self.assertIn(original_second,fixture)
        fixture=fixture.replace(original_second," (selected==='partial'?imgs[2]:imgs[1]).naturalWidth=10;(selected==='partial'?imgs[2]:imgs[1]).onload();await tick();",1)
        original_third='   imgs[2].naturalWidth=10;imgs[2].onload();await tick();'
        self.assertIn(original_third,fixture)
        fixture=fixture.replace(original_third,"   (selected==='partial'?imgs[1]:imgs[2]).naturalWidth=10;(selected==='partial'?imgs[1]:imgs[2]).onload();for(let j=0;j<8 && pages.children.at(-1)?.tag!=='figure';j++)await tick();",1)
        self.assertEqual(fixture.count("selected==='complete'"),1)
        fixture=fixture.replace("selected==='complete'","selected==='partial'")
        # The third panel starts only after the repaired second image finishes.
        with tempfile.TemporaryDirectory() as td:
            project=Path(td)/'project'
            (project/'reader').mkdir(parents=True)
            (project/'reusable').mkdir(parents=True)
            import shutil
            for f in (ROOT/'reader').iterdir():
                if f.is_file():shutil.copy2(f,project/'reader'/f.name)
            for f in (ROOT/'reusable').iterdir():
                if f.suffix=='.py' or f.suffix in ('.css','.js'):
                    shutil.copy2(f,project/'reusable'/f.name)
            # The shared loader stage uses a few small supporting modules.
            (project/'reusable/worker_addon').mkdir()
            shutil.copy2(ROOT/'reusable/worker_addon/panel_replacement_worker.mjs',project/'reusable/worker_addon/panel_replacement_worker.mjs')
            images=lambda label: {'url':'https://images.invalid/'+label+'.png','width':10,'height':10}
            registry={'comics':{'sample':{'title':'Sample','slug':'sample','chapters':[
                {'id':'before','images':[images('prev')]},
                {'id':'partial','images':[images('a'),{'placeholder':True,'panel':2,'confirmed_missing':True},images('c')]},
                {'id':'complete','images':[images('a'),images('b'),images('c')]},
                {'id':'after','images':[images('next')]},
            ]}}}
            stage=Path(td)/'stage'
            open_reader.stage_worker_assets(project,registry,stage)
            app=stage/'comics/sample/app.js'
            proc=subprocess.run(['node','-e',fixture,str(app),'partial'],text=True,capture_output=True,timeout=25)
            self.assertEqual(proc.returncode,0,proc.stdout+'\n'+proc.stderr)
            self.assertIn('PASS sequential partial',proc.stdout)

if __name__=='__main__':unittest.main()
