"""Regression for readable mixed chapters backed by verified local checkpoint pixels."""
from __future__ import annotations
import base64
import hashlib
import io
import json
import shutil
import sqlite3
from pathlib import Path
from tempfile import TemporaryDirectory
import subprocess
import unittest
from unittest.mock import patch
from PIL import Image
from reusable import partial_chapter_publish, open_reader

ROOT=Path(__file__).resolve().parents[1]

class Response:
    def __init__(self,status,record=None):
        self.status_code=status;self._record=record or {}
    def json(self): return self._record

class GitHub:
    GITHUB_API='https://api.github.test'
    def __init__(self):
        self.remote={};self.writes=[]
    def github_http(self,method,url,token,**kwargs):
        assert token=='secret'
        if url.endswith('/repos/owner/open-reader'):
            return Response(200,{'private':True,'owner':{'login':'owner'}})
        file=url.split('/contents/',1)[-1].split('?ref=',1)[0]
        if method=='GET':
            if file not in self.remote:return Response(404)
            return Response(200,{'type':'file','sha':partial_chapter_publish._git_blob_sha(self.remote[file])})
        if method=='PUT':
            self.remote[file]=base64.b64decode(kwargs['json']['content'])
            self.writes.append(file)
            return Response(201)
        raise AssertionError(method)

class PartialChapterTests(unittest.TestCase):
    def setUp(self):
        tmp=TemporaryDirectory();self.addCleanup(tmp.cleanup)
        self.root=Path(tmp.name)
        self.root.joinpath('reader').mkdir()
        self.root.joinpath('reusable/worker_addon').mkdir(parents=True)
        for f in (ROOT/'reader').iterdir():
            if f.is_file():shutil.copy2(f,self.root/'reader'/f.name)
        for name in ('open_reader_homepage_addon.py','gold_favicon.py',
                     'reader_chapter_enhancement.js','reader_chapter_enhancement.css',
                     'comic_landing.py','comic_landing.css','comic_landing.js','reader_progress.js',
                     'github_upload_bell.js','github_streaming.py','partial_chapter_publish.py'):
            shutil.copy2(ROOT/'reusable'/name,self.root/'reusable'/name)
        (self.root/'reusable/worker_addon/panel_replacement_worker.mjs').write_bytes(
             (ROOT/'reusable/worker_addon/panel_replacement_worker.mjs').read_bytes())
        state=self.root/'.archiver_state/sites/comic-a';state.mkdir(parents=True)
        with sqlite3.connect(state/'state.sqlite') as con:
            con.execute('CREATE TABLE options (key TEXT,value TEXT)')
            con.execute('CREATE TABLE chapters (chapter_id TEXT,label TEXT,url TEXT,status TEXT)')
            con.execute('INSERT INTO options VALUES (?,?)',('series_slug',json.dumps('comic-a')))
            con.execute('INSERT INTO options VALUES (?,?)',('series_title',json.dumps('Comic A')))
            con.execute('INSERT INTO chapters VALUES (?,?,?,?)',('chapter-82','Chapter 82',
                            'https://sample.example/chapter-82','SOURCE_SERVER_DEFERRED'))
        self.folder=state/'temporary_downloads/chapter-82';self.folder.mkdir(parents=True)
        failures={'2':{'status':404,'debugger_confirmed':True,'reason':'confirmed_image_http_404'}}
        (self.folder/'confirmed_server_failures.json').write_text(json.dumps({
            'chapter_id':'chapter-82','failures':failures}),encoding='utf-8')
        image=Image.new('RGB',(30,45),(200,30,50));blob=io.BytesIO();image.save(blob,format='PNG');raw=blob.getvalue()
        self.raw=raw
        (self.folder/'0001.png').write_bytes(raw)
        digest=hashlib.sha256(raw).hexdigest()
        meta={'width':30,'height':45,'bytes':len(raw),'sha256':digest,
              'format':'PNG','source_url':'https://sample.example/panel1.png'}
        (self.folder/'.image-checkpoint.json').write_text(json.dumps({
            'version':1,'chapter_id':'chapter-82','chapter_url':'https://sample.example/chapter-82',
            'catalog':[{'key':str(n),'url':'https://sample.example/x'} for n in range(1,5)],
            'images':{'1':{'key':'1','order':1,'filename':'0001.png',
               'url':meta['source_url'],'meta':meta}}}),encoding='utf-8')
        (self.root/'.archiver_state/github_streaming_mode.json').write_text(json.dumps({
            'mode':'github-on-demand-v1','owner':'owner','app_id':'123','installation_id':'456'}))
        self.registry={'comics':{'comic-a':{'slug':'comic-a','title':'Comic A',
            'chapters':[{'id':'chapter-81','number':'81','title':'Chapter 81',
                'images':[{'url':'https://x.pages.dev/1.png','width':30,'height':45,'sha256':'a'*64}]},
                {'id':'chapter-83','number':'83','title':'Chapter 83',
                'images':[{'url':'https://x.pages.dev/3.png','width':30,'height':45,'sha256':'b'*64}]}]}}}
        self.remote=GitHub()

    def test_verified_panel_and_missing_slot_render_in_same_chapter(self):
        records=partial_chapter_publish.publish_partial_checkpoints(self.root,self.remote,'owner','secret')
        self.assertEqual(len(self.remote.writes),1)
        self.assertEqual(len(records[('comic-a','chapter-82')]['images']),1)
        self.assertEqual(next(iter(self.remote.remote.values())),self.raw)
        stage=self.root/'stage'
        open_reader.stage_worker_assets(self.root,self.registry,stage,partial_records=records)
        manifest=json.loads((stage/'comics/comic-a/manifest.json').read_text())
        ids=[ch['id'] for ch in manifest['chapters']]
        self.assertEqual(ids,['chapter-81','chapter-82','chapter-83'])
        ch=manifest['chapters'][1]
        self.assertEqual(len(ch['images']),4)
        self.assertEqual(ch['images'][0]['github']['repo'],'open-reader')
        self.assertEqual(ch['images'][0]['width'],30)
        self.assertIn('/api/github-image/comic-a/chapter-82/1?v=',ch['images'][0]['url'])
        self.assertEqual([x['panel'] for x in ch['images'][1:]], [2,3,4])
        self.assertEqual([x['confirmed_missing'] for x in ch['images'][1:]], [True,False,False])
        js=(stage/'comics/comic-a/app.js').read_text()
        self.assertIn("if(item?.placeholder===true)",js)
        self.assertIn("figure.replaceChildren(svg)",js)
        self.assertIn("figure.style.aspectRatio='auto'",js)
        self.assertNotIn('or-missing-panel-content',js)
        self.assertNotIn("if(chapter.source_unavailable === true)",js)
        css=(stage/'reader-chapter-enhancement.css').read_text()
        self.assertIn('.or-missing-panel',css)
        self.assertIn('width:18px!important',css)
        self.assertIn('height:18px!important',css)
        self.assertNotIn('min-height:min(68vh,600px)',css)
        self.assertNotIn('/reader-issues.js', (stage/'comics/comic-a/index.html').read_text())
        upload=json.loads((stage/'upload-catalog.json').read_text())
        self.assertEqual([x['id'] for x in upload['comics'][0]['chapters']],['chapter-81','chapter-82','chapter-83'])
        for source in (stage/'comics/comic-a/app.js',ROOT/'reusable/worker_addon/panel_replacement_worker.mjs'):
            check=subprocess.run(['node','--check',str(source)],capture_output=True,text=True)
            self.assertEqual(check.returncode,0,check.stderr)
        # Rerunning a deployment must not re-upload the same verified bytes.
        records2=partial_chapter_publish.publish_partial_checkpoints(self.root,self.remote,'owner','secret')
        self.assertEqual(records,records2)
        self.assertEqual(len(self.remote.writes),1)

    def test_compact_marker_runtime_and_late_image_failure(self):
        # Exercise the actual generated reader JavaScript, not only its syntax.
        stage=self.root/'compact-stage'
        from reusable.open_reader import stage_worker_assets
        stage_worker_assets(self.root,self.registry,stage)
        source=(stage/'comics/comic-a/app.js').read_text(encoding='utf8')
        start=source.index('function missingGlyph(')
        end=source.index('function triggerNearby(){',start)
        js=source[start:end]
        probe=r"""
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(process.argv[2],'utf8');
const code=source.slice(source.indexOf('function missingGlyph('),source.indexOf('function triggerNearby(){'));
const document={createElementNS:(ns,tag)=>({ns,tag,attrs:{},setAttribute(k,v){this.attrs[k]=v}})};
const makeFigure=()=>({style:{},attrs:{},setAttribute(k,v){this.attrs[k]=v},replaceChildren(...x){this.children=x}});
const ctx={document,setTimeout(fn){fn()}};
vm.createContext(ctx);vm.runInContext(code,ctx);
let fig=makeFigure();ctx.missingGlyph(fig,2,'Not yet archived');
assert.equal(fig.className,'or-missing-panel');
assert.equal(fig.style.aspectRatio,'auto');
assert.equal(fig.children.length,1);
assert.equal(fig.children[0].attrs.width,'16');
assert.equal(fig.children[0].attrs.height,'16');
assert.match(fig.attrs['aria-label'],/Panel 2 unavailable/);
assert.equal(fig.children[0].tag,'svg');
let parent=makeFigure(),img={parentElement:parent};
let picture={status:'waiting',el:img,url:'https://example.test/001.png',order:0,failures:0};
ctx.needPreload(picture);
for(let i=0;i<5;i++)img.onerror();
assert.equal(picture.status,'loaded');
assert.equal(parent.className,'or-missing-panel');
assert.equal(parent.children[0].attrs.width,'16');
console.log('PASS compact native-style glyph on missing and failed panels');
"""
        runner=shutil.which('node')
        self.assertIsNotNone(runner,'Node.js is required for mandatory runtime check')
        test=stage/'compact-runtime-test.js';test.write_text(probe,encoding='utf8')
        run=subprocess.run([runner,str(test),str(stage/'comics/comic-a/app.js')],
                           capture_output=True,text=True,timeout=15)
        self.assertEqual(run.returncode,0,run.stderr)
        self.assertIn('PASS compact native-style glyph',run.stdout)

    def test_modified_checkpoint_bytes_cannot_be_published(self):
        (self.folder/'0001.png').write_bytes(b'corrupt bytes')
        records=partial_chapter_publish.publish_partial_checkpoints(self.root,self.remote,'owner','secret')
        self.assertEqual(records[('comic-a','chapter-82')]['images'],{})
        self.assertFalse(self.remote.writes)

    def test_rejected_remote_conflict(self):
        # Same immutable path occupied by different remote Git blob fails closed.
        self.remote.remote['partial/comic-a/chapter-82/0001-'+hashlib.sha256(self.raw).hexdigest()+'.png']=b'incorrect remote bytes'
        with self.assertRaisesRegex(RuntimeError,'conflicts'):
            partial_chapter_publish.publish_partial_checkpoints(self.root,self.remote,'owner','secret')

if __name__=='__main__':unittest.main()
