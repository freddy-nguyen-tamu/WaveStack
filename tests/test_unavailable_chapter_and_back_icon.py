"""Regressions: unpublished chapters remain a real reader navigation stop;
back icon matches transparent favicon and hides on five seconds idle.
"""
from pathlib import Path
from tempfile import TemporaryDirectory
import json
import shutil
import sqlite3
import subprocess
import unittest
from reusable import open_reader

ROOT = Path(__file__).resolve().parents[1]


class UnpublishedChapterTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.project = Path(self.tmp.name) / 'project'
        (self.project / 'reader').mkdir(parents=True)
        (self.project / 'reusable/worker_addon').mkdir(parents=True)
        for item in (ROOT / 'reader').iterdir():
            if item.is_file():
                shutil.copy2(item, self.project / 'reader' / item.name)
        for name in ('open_reader_homepage_addon.py', 'comic_landing.py',
                     'comic_landing.css', 'comic_landing.js', 'reader_progress.js',
                     'reader_chapter_enhancement.css', 'reader_chapter_enhancement.js',
                     'gold_favicon.py', 'github_streaming.py', 'github_upload_bell.js',
                     'partial_chapter_publish.py'):
            shutil.copy2(ROOT / 'reusable' / name, self.project / 'reusable' / name)
        shutil.copy2(ROOT / 'reusable/worker_addon/panel_replacement_worker.mjs',
                     self.project / 'reusable/worker_addon/panel_replacement_worker.mjs')
        scope = self.project / '.archiver_state/sites/comic-a'
        (scope / 'temporary_downloads/chapter-82').mkdir(parents=True)
        con = sqlite3.connect(scope / 'state.sqlite')
        with con:
            con.execute('CREATE TABLE options (key TEXT, value TEXT)')
            con.execute('CREATE TABLE chapters (chapter_id TEXT, label TEXT, url TEXT, status TEXT)')
            con.executemany('INSERT INTO options VALUES (?,?)',
                            [('series_title', json.dumps('Comic A')),
                             ('series_slug', json.dumps('comic-a'))])
            con.execute('INSERT INTO chapters VALUES (?,?,?,?)',
                        ('chapter-82', 'Chapter 82', 'https://example.org/chapter/82', 'SOURCE_SERVER_DEFERRED'))
        con.close()
        failure = {'status':None, 'reason':'adapter_confirmed_origin_placeholder',
                   'adapter_confirmed':True, 'dom_unloaded':True,
                   'url':'https://example.org/082.png'}
        (scope / 'temporary_downloads/chapter-82/confirmed_server_failures.json').write_text(
            json.dumps({'chapter_id':'chapter-82', 'recorded_at':'2026-11-22T01:00:00Z',
                        'failures':{'2':failure, '3':failure}}), encoding='utf-8')
        chapters = [{'id':f'chapter-{i}', 'label':f'Chapter {i}',
                     'title':f'Chapter {i}', 'number':str(i),
                     'images':[{'url':'https://sample.pages.dev/a.png',
                                'width':10,'height':10,'sha256':'a'*64}]}
                    for i in (81,83)]
        self.registry = {'comics': {'comic-a':{'slug':'comic-a',
                          'title':'Comic A','chapters':chapters}}}
        self.stage = Path(self.tmp.name) / 'stage'
        open_reader.stage_worker_assets(self.project, self.registry, self.stage)

    def test_82_is_navigable_between_81_and_83_with_no_fabricated_images(self):
        path = self.stage / 'comics/comic-a/manifest.json'
        manifest = json.loads(path.read_text(encoding='utf-8'))
        ids = [chapter['id'] for chapter in manifest['chapters']]
        self.assertEqual(ids, ['chapter-81','chapter-82','chapter-83'])
        self.assertEqual(manifest['chapters'][1]['unavailable_panels'], [2,3])
        self.assertTrue(manifest['chapters'][1]['source_unavailable'])
        self.assertEqual([x['panel'] for x in manifest['chapters'][1]['images']], [1,2,3])
        self.assertEqual([x['confirmed_missing'] for x in manifest['chapters'][1]['images']], [False,True,True])
        self.assertTrue(all(x['placeholder'] for x in manifest['chapters'][1]['images']))
        self.assertEqual(manifest['chapters'][0]['images'][0]['sha256'],'a'*64)
        self.assertEqual(manifest['chapters'][2]['images'][0]['sha256'],'a'*64)
        library = json.loads((self.stage / 'library.json').read_text(encoding='utf-8'))
        self.assertEqual(library['comics'][0]['chapters'], 3)
        self.assertEqual(library['comics'][0]['archived_chapters'],2)
        self.assertEqual(library['comics'][0]['unavailable_chapters'],1)
        # Staging is deterministic, even if called twice for the same run.
        before = path.read_bytes()
        open_reader.stage_worker_assets(self.project,self.registry,self.stage)
        self.assertEqual(path.read_bytes(),before)

    def test_source_changes_are_only_to_generated_reader(self):
        staged = (self.stage / 'comics/comic-a/app.js').read_text(encoding='utf-8')
        original = (self.project / 'reader/app.js').read_text(encoding='utf-8')
        self.assertIn('if(item?.placeholder===true)',staged)
        self.assertIn('Missing from original source',staged)
        self.assertIn('const ix=chapterIndex+dir;',staged)
        self.assertIn('const ix=chapterIndex+dir;',staged)
        self.assertNotIn('if(chapter.source_unavailable === true)',original)
        self.assertEqual((self.project/'reader/style.css').read_bytes(),
                         (self.stage/'comics/comic-a/style.css').read_bytes())
        for file in ('comics/comic-a/app.js','comic-landing.js','reader-chapter-enhancement.css'):
            if file.endswith('.js'):
                p=subprocess.run(['node','--check',str(self.stage/file)],capture_output=True,text=True,timeout=15)
                self.assertEqual(p.returncode,0,p.stderr)

    def test_icon_mouse_idle_and_navbar_behavior_in_node(self):
        source = (ROOT/'reusable/reader_chapter_enhancement.js').read_text(encoding='utf-8')
        prelude = source[:source.index('  // Trigger the animation')]
        probe = r'''
const assert=require('node:assert/strict');
const source=process.argv[1];
const listeners={};let obs,timerId=0;const timers=new Map();let home;
const panel={hidden:true};
const document={body:{append(el){if(el.id==='or-library-back')home=el}},
  documentElement:{classList:{add(){}}},
  createElement(tag){return {tag,hidden:false,handlers:{},setAttribute(){},addEventListener(k,v){this.handlers[k]=v}}}};
const window={matchMedia:()=>({matches:true}),addEventListener(k,v){listeners[k]=v}};
const location={assigned:null,assign(x){this.assigned=x}};
const MutationObserver=class{constructor(fn){obs=fn}observe(){}};
const setTimeout=(fn,ms)=>{const id=++timerId;timers.set(id,{fn,ms});return id};
const clearTimeout=(id)=>timers.delete(id);
new Function('$','document','window','location','setTimeout','clearTimeout','MutationObserver',source+'\n}')
  (s=>s==='#reader-panel'?panel:{},document,window,location,setTimeout,clearTimeout,MutationObserver);
assert.equal(home.hidden,true);
listeners.pointermove({pointerType:'touch'});assert.equal(home.hidden,true);
listeners.pointermove({pointerType:'mouse'});assert.equal(home.hidden,false);
let active=[...timers.values()].at(-1);assert.equal(active.ms,5000);active.fn();assert.equal(home.hidden,true);
panel.hidden=false;obs();assert.equal(home.hidden,false);
[...timers.values()].at(-1).fn();assert.equal(home.hidden,true);
home.handlers.click();assert.equal(location.assigned,'/');
'''
        p = subprocess.run(['node','-e',probe,prelude],capture_output=True,text=True,timeout=20)
        self.assertEqual(p.returncode,0,p.stderr)
        css=(ROOT/'reusable/reader_chapter_enhancement.css').read_text(encoding='utf-8')
        self.assertIn("url('/favicon.svg')",css)
        self.assertIn('background:transparent',css)

if __name__=='__main__': unittest.main()
