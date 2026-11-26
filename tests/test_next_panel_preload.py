"""Offline regression of the actual generated reader, never a source website."""
import subprocess
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from reusable import open_reader, open_reader_focused as focused

ROOT=Path(__file__).resolve().parents[1]

class NextPanelPreload(unittest.TestCase):
    def test_generated_reader_warm_and_cold_paths(self):
        # Isolate the project from the user's live streaming config, issue DBs,
        # registry, and other state. Exercise BOTH modes using real staging.
        for streaming in (False, True):
            with self.subTest(streaming=streaming), tempfile.TemporaryDirectory() as tmp:
                project=Path(tmp)/'project'
                stage=Path(tmp)/'stage'
                shutil.copytree(ROOT/'reader',project/'reader')
                shutil.copytree(ROOT/'reusable',project/'reusable',ignore=shutil.ignore_patterns('__pycache__','*.pyc'))
                image={'url':'https://sample-vol-001.pages.dev/chapters/1/0001.png','width':10,'height':10,'sha256':'a'*64}
                registry={'comics':{'sample':{'title':'Sample','slug':'sample','chapters':[
                    {'id':'1','title':'Sample title','label':'Chapter 1','number':'1','images':[image]}]}}}
                if streaming:
                    config=project/'.archiver_state/github_streaming_mode.json'
                    config.parent.mkdir(parents=True)
                    config.write_text(json.dumps({'mode':'github-on-demand-v1','owner':'fixture-owner','app_id':'1','installation_id':'2'}),encoding='utf8')
                    open_reader.github_streaming.convert_registry(registry)
                open_reader.stage_worker_assets(project,registry,stage)
                catalog=stage/'upload-catalog.json'
                self.assertEqual(catalog.exists(),streaming)
                if streaming:
                    self.assertEqual(json.loads(catalog.read_text(encoding='utf8'))['comics'][0]['chapters'],
                        [{'id':'1','title':'Sample title','count':1}])
                    self.assertTrue(json.loads((stage/'comics/sample/manifest.json').read_text(encoding='utf8'))['chapters'][0]['images'][0]['url'].startswith('/api/github-image/'))
                app=stage/'comics/sample/app.js'
                subprocess.run(['node','--check',str(app)],check=True,timeout=20)
                js=(ROOT/'tests/next_panel_preload.js').read_text(encoding='utf-8')
                for scenario in ('success','early','failure','timeout','stale','repair-busy'):
                    with self.subTest(scenario=scenario):
                        result=subprocess.run(['node','-e',js,str(app),'complete',scenario],capture_output=True,text=True,timeout=20)
                        self.assertEqual(result.returncode,0,result.stdout+'\n'+result.stderr)
    def test_site_only_shared_frontend_verifies_all_routes_without_image_sampling(self):
        comic={'slug':'old','title':'Old','chapters':[{'id':'1','label':'Chapter 1','title':'Chapter 1','number':'1','images':[{'url':'https://example.pages.dev/1.png','sha256':'a'*64,'height':100,'width':100}]}],'legacy_urls':[]}
        url='https://open-reader.owner.workers.dev'
        live={'version':2,'frontend_hash':'old','comics':{'old':comic}}
        state={'worker_url':url,'comics':live['comics'],'verified_frontend_hash':'old'}
        payload={**live,'frontend_hash':'new'}
        eng=SimpleNamespace(ROOT=ROOT,credential_for_selected=lambda db:('owner','token'),select_cloudflare_account=lambda:None)
        with patch.object(focused.reader,'load_state',return_value=state), \
             patch.object(focused.reader,'_public_json',return_value=live), \
             patch.object(focused.reader,'_remote_shared_registry',return_value=({'comics':live['comics']},'sha')), \
             patch.object(focused.github_streaming,'load_mode',return_value=False), \
             patch.object(focused.reader,'stage_worker_assets',return_value=payload), \
             patch.object(focused.reader,'_assert_no_unowned_existing_worker'), \
             patch.object(focused.reader,'_deploy',return_value=url), \
             patch.object(focused.reader,'_verify_published') as verify, \
             patch.object(focused.reader,'_validate_live_assets') as samples, \
             patch.object(focused.reader,'save_state') as save, \
             patch.object(focused.reader,'_checkpoint_shared_registry'):
            self.assertEqual(focused.publish(eng,None,scope='site'),url)
            verify.assert_called_once()
            self.assertEqual(verify.call_args.kwargs,{'verify_slugs':None,'verify_image_slugs':set()})
            samples.assert_not_called()
            self.assertEqual(save.call_args.args[1]['verified_frontend_hash'],'new')

if __name__=='__main__':unittest.main()
