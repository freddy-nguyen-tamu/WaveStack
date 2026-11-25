"""Focused publishing and startup option regressions; no live network calls."""
import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
import run
from reusable import open_reader, engine
from reusable import open_reader_focused as focused

ROOT = Path(__file__).resolve().parents[1]
URL='https://open-reader.owner.workers.dev'

class ScopedUpdates(unittest.TestCase):
    def answers(self, answers, argv=()):
        iterator=iter(answers)
        with contextlib.redirect_stdout(io.StringIO()):
            return run._reader_workflow_choices(list(argv),interactive=True,prompt=lambda _:next(iterator))

    def test_comic_only_skips_historical(self):
        self.assertEqual(self.answers(['1','','n']),('comic',True,False))

    def test_site_only_avoids_old_scans_by_default(self):
        self.assertEqual(self.answers(['2','','']),('site',True,True))

    def test_full_default_preserves_remote_checks(self):
        self.assertEqual(self.answers(['3','','']),('full',False,True))

    def test_independent_yes_on_old_comics(self):
        self.assertEqual(self.answers(['1','y','n']),('comic',False,False))

    def test_explicit_noninteractive_no_questions(self):
        self.assertEqual(run._reader_workflow_choices(
            ['--open-reader-update-scope','site','--skip-initial-github-check'],
            interactive=False,prompt=lambda _:self.fail('prompted')),
            ('site',True,True))

    def test_invalid_choice_does_not_run(self):
        with self.assertRaises(SystemExit):
            self.answers(['zero'])

    def test_targeted_parser_scopes(self):
        for value in ('full','site','comic'):
            self.assertEqual(engine.build_parser().parse_args(
                ['--open-reader-update-scope',value]).open_reader_update_scope,value)

    def test_comic_with_changed_frontend_verifies_all_routes_only_current_images(self):
        old=self._comic('old')
        new=self._comic('new')
        live={'version':2,'comics':{'old':old},'frontend_hash':'oldhash'}
        state={'worker_url':URL,'comics':{'old':old}}
        engine_stub=SimpleNamespace(ROOT=ROOT,get_option=lambda *a:'new',
            credential_for_selected=lambda db:('owner','token'),
            select_cloudflare_account=lambda:None)
        payload={'version':2,'comics':{'old':old,'new':new},'frontend_hash':'newhash'}
        with mock.patch.object(focused.reader,'load_state',return_value=state), \
            mock.patch.object(focused.reader,'_public_json',return_value=live), \
            mock.patch.object(focused,'current_comic',return_value=new), \
            mock.patch.object(focused.reader,'_reader_hash',return_value='newhash'), \
            mock.patch.object(focused.reader,'_remote_shared_registry',return_value=(
                {'comics':live['comics']},'version_sha')), \
            mock.patch.object(focused.github_streaming,'load_mode',return_value=False), \
            mock.patch.object(focused.reader,'_validate_live_assets') as sample, \
            mock.patch.object(focused.reader,'stage_worker_assets',return_value=payload) as stage, \
            mock.patch.object(focused.reader,'_assert_no_unowned_existing_worker'), \
            mock.patch.object(focused.reader,'_deploy',return_value=URL) as deploy, \
            mock.patch.object(focused.reader,'_verify_published') as verify, \
            mock.patch.object(focused.reader,'save_state'), \
            mock.patch.object(focused.reader,'_checkpoint_shared_registry'), \
            mock.patch.object(focused,'_checkpoint_current'), \
            mock.patch.object(focused,'_target_readmes'):
            self.assertEqual(focused.publish(engine_stub,None,scope='comic'),URL)
            deploy.assert_called_once()
            self.assertEqual(verify.call_args.kwargs,
                             {'verify_slugs':None,'verify_image_slugs':{'new'}})
            self.assertEqual(stage.call_args.args[1]['comics']['old'],old)
            sample.assert_called_once_with(new,engine_stub)

    def test_interrupted_shared_deploy_rechecks_every_frontend_before_adoption(self):
        old=self._comic('old')
        new=self._comic('new')
        payload={'version':2,'comics':{'old':old,'new':new},'frontend_hash':'newhash'}
        engine_stub=SimpleNamespace(ROOT=ROOT,get_option=lambda *a:'new',
            credential_for_selected=lambda db:('owner','token'),
            select_cloudflare_account=lambda:None)
        with mock.patch.object(focused.reader,'load_state',return_value={
                'worker_url':URL,'comics':{'old':old},'verified_frontend_hash':'oldhash'}), \
            mock.patch.object(focused.reader,'_public_json',return_value=payload), \
            mock.patch.object(focused,'current_comic',return_value=new), \
            mock.patch.object(focused.reader,'_reader_hash',return_value='newhash'), \
            mock.patch.object(focused.reader,'_remote_shared_registry',return_value=(
                {'comics':{'old':old}},'version_sha')), \
            mock.patch.object(focused.github_streaming,'load_mode',return_value=False), \
            mock.patch.object(focused.reader,'_validate_live_assets'), \
            mock.patch.object(focused.reader,'stage_worker_assets',return_value=payload), \
            mock.patch.object(focused.reader,'_deploy') as deploy, \
            mock.patch.object(focused.reader,'_verify_published') as verify, \
            mock.patch.object(focused.reader,'save_state') as save, \
            mock.patch.object(focused.reader,'_checkpoint_shared_registry'), \
            mock.patch.object(focused,'_checkpoint_current'), \
            mock.patch.object(focused,'_target_readmes'):
            self.assertEqual(focused.publish(engine_stub,None,scope='comic'),URL)
            deploy.assert_not_called()
            self.assertEqual(verify.call_args.kwargs,{'verify_slugs':None,'verify_image_slugs':{'new'}})
            self.assertEqual(save.call_args.args[1]['verified_frontend_hash'],'newhash')

    def test_site_only_always_deploys_worker_even_if_registry_unchanged(self):
        live={'version':2,'frontend_hash':'same','comics':{'old':self._comic('old')}}
        state={'worker_url':URL,'comics':{'old':self._comic('old')}}
        engine_stub=SimpleNamespace(ROOT=ROOT,
            credential_for_selected=lambda db:('owner','token'),
            select_cloudflare_account=lambda:None)
        with mock.patch.object(focused.reader,'load_state',return_value=state), \
            mock.patch.object(focused.reader,'_public_json',return_value=live), \
            mock.patch.object(focused.reader,'_remote_shared_registry',return_value=(
                {'comics':live['comics']},'version_sha')), \
            mock.patch.object(focused.github_streaming,'load_mode',return_value=False), \
            mock.patch.object(focused.reader,'stage_worker_assets',return_value=live), \
            mock.patch.object(focused.reader,'_assert_no_unowned_existing_worker'), \
            mock.patch.object(focused.reader,'_deploy',return_value=URL) as deploy, \
            mock.patch.object(focused.reader,'_verify_published') as verify, \
            mock.patch.object(focused.reader,'save_state'), \
            mock.patch.object(focused.reader,'_checkpoint_shared_registry'):
            self.assertEqual(focused.publish(engine_stub,None,scope='site'),URL)
            deploy.assert_called_once()
            self.assertEqual(verify.call_args.kwargs['verify_slugs'],set())

    def test_live_registry_missing_fails_closed(self):
        with mock.patch.object(focused.reader,'load_state',return_value={
            'worker_url':'','comics':{}}):
            with self.assertRaisesRegex(RuntimeError,'previously verified'):
                focused.publish(SimpleNamespace(ROOT=ROOT),None,scope='site')

    @staticmethod
    def _comic(slug):
        return {'slug':slug,'title':slug,'chapters':[{'id':'1','label':'Chapter 1',
            'title':'Chapter 1','number':'1','images':[{'url':'https://example.pages.dev/1.png',
            'sha256':'a'*64,'height':100,'width':100}]}],'legacy_urls':[]}

    def test_focused_verification_skips_unrelated_comics(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td)
            (root/'index.html').write_text('Home')
            (root/'source-issues.json').write_text(json.dumps({
                'schema':'comicarchiver.source_issue_feed.v1','cases':[], 'resolved_ids':[]}))
            for slug in ('old','new'):
                d=root/'comics'/slug; d.mkdir(parents=True)
                (d/'index.html').write_text(slug)
            accessed=[]
            def getter(url,**_):
                accessed.append(url)
                relative=url.removeprefix(URL).lstrip('/')
                if relative=='api/reader-health':
                    return SimpleNamespace(status_code=200,json=lambda:{'script':'open-reader-panel-replacement-v1'})
                file=root/relative
                if file.is_dir():file=file/'index.html'
                return SimpleNamespace(status_code=200,content=file.read_bytes())
            with mock.patch.object(open_reader.requests,'get',side_effect=getter):
                open_reader._verify_published(URL,root,{'comics':{}},verify_slugs={'new'})
            self.assertFalse(any('/comics/old/' in x for x in accessed))
            self.assertTrue(any('/comics/new/' in x for x in accessed))
            self.assertTrue(any(x == URL + '/' for x in accessed))

    def test_site_only_skips_all_comic_verification(self):
        source=Path(open_reader.__file__).read_text()
        self.assertIn('verify_slugs is not None and relative.startswith',source)
        self.assertIn('verify_slugs is not None and slug not in',source)

if __name__=='__main__':unittest.main()
