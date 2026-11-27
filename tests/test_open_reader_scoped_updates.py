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
        self.assertEqual(self.answers(['1']),('comic',True,False))

    def test_site_only_avoids_old_scans_by_default(self):
        self.assertEqual(self.answers(['2']),('site',True,False))

    def test_full_default_preserves_remote_checks(self):
        self.assertEqual(self.answers(['3','','']),('full',False,True))

    def test_independent_yes_on_old_comics(self):
        self.assertEqual(self.answers(['1','y','n']),('comic',True,False))

    def test_explicit_noninteractive_no_questions(self):
        self.assertEqual(run._reader_workflow_choices(
            ['--open-reader-update-scope','site','--skip-initial-github-check'],
            interactive=False,prompt=lambda _:self.fail('prompted')),
            ('site',True,False))

    def test_invalid_choice_does_not_run(self):
        with self.assertRaises(SystemExit):
            self.answers(['zero'])

    def test_targeted_parser_scopes(self):
        for value in ('full','site','comic'):
            self.assertEqual(engine.build_parser().parse_args(
                ['--open-reader-update-scope',value]).open_reader_update_scope,value)

    def test_first_focused_run_does_not_audit_unrelated_comics(self):
        assets={'registry.json':'r','library.json':'l','add-comic/index.html':'a',
                'comics/new/manifest.json':'n','comics/new/app.js':'x',
                **{f'comics/old-{i}/app.js':'x' for i in range(1000)},
                'manual-pdf/cmaps/one.bcmap':'m'}
        self.assertEqual(focused._verification_plan(assets,None,'comic','new'),
                         {'registry.json','library.json','add-comic/index.html',
                          'comics/new/manifest.json','comics/new/app.js'})
        self.assertEqual(focused._verification_plan(assets,None,'site',None),
                         {'registry.json','library.json','add-comic/index.html'})

    def test_site_change_is_independent_of_library_size(self):
        old={'registry.json':'r','library.json':'l','add-comic/index.html':'a',
             **{f'comics/old-{i}/app.js':'x' for i in range(1000)}}
        assets={**old,'registry.json':'r2','add-comic/index.html':'b','manual-import.js':'new'}
        self.assertEqual(focused._verification_plan(assets,{'assets':old},'site',None),
                         {'registry.json','library.json','add-comic/index.html','manual-import.js'})

    def test_new_comic_checks_new_files_only(self):
        old={'registry.json':'r','library.json':'l','index.html':'home','comics/old/app.js':'x'}
        assets={**old,'registry.json':'r2','library.json':'l2','comics/new/app.js':'x',
                'comics/new/manifest.json':'m'}
        self.assertEqual(focused._verification_plan(assets,{'assets':old},'comic','new'),
                         {'registry.json','library.json','comics/new/app.js','comics/new/manifest.json'})

    def test_shared_reader_change_samples_one_comic(self):
        old={'registry.json':'r','library.json':'l','comics/a/app.js':'x','comics/b/app.js':'x'}
        assets={**old,'comics/a/app.js':'y','comics/b/app.js':'y'}
        self.assertEqual(focused._verification_plan(assets,{'assets':old},'site',None),
                         {'registry.json','library.json','comics/a/app.js'})

    def test_no_change_only_checks_indexes(self):
        assets={'registry.json':'r','library.json':'l','add-comic/index.html':'a'}
        self.assertEqual(focused._verification_plan(assets,{'assets':assets},'site',None),
                         {'registry.json','library.json'})

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
