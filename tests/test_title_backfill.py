"""Native-title repair is adapter-only, optional, and image-immutable."""
from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from reusable import title_reconcile
from reusable.title_maintenance import update_manifest_titles, only_title_metadata_changed
from site_specific import site_adapter


class TitlesFromSourceTests(unittest.TestCase):
    def test_full_source_native_labels_with_descriptive_titles(self):
        fixture = Path(__file__).resolve().parents[2] / 'Pasted text(20261120-054834).txt'
        # Test against the copied source fixture if distributed; otherwise a compact equivalent.
        if fixture.exists():
            markup = fixture.read_text(encoding='utf-8')
            found = site_adapter.native_chapter_titles_from_catalog(markup, site_adapter.DEFAULT_START_URL)
            self.assertEqual(len(found), 60)
            self.assertEqual(found['46'], "Ep. 46 - Valentine's Day Post-Mortem")
            self.assertEqual(found['60'], 'Ep. 60 - The stories of those around me (Last Episode)')
            self.assertEqual(found['1'], 'Ep. 1')
        else:
            markup = """<ol id=topEpisodeList><li data-episode-no=46><a href='/viewer?episode_no=46'><span class=subj>Ep. 46 - Valentine's Day Post-Mortem</span></a></li></ol>"""
            self.assertEqual(site_adapter.native_chapter_titles_from_catalog(markup, site_adapter.DEFAULT_START_URL)['46'], "Ep. 46 - Valentine's Day Post-Mortem")

    def test_extraction_can_fail_without_completeness_regression(self):
        fake = SimpleNamespace(__file__=site_adapter.__file__, ALLOWED_HOSTS=site_adapter.ALLOWED_HOSTS,
            DEFAULT_START_URL=site_adapter.DEFAULT_START_URL,
            native_chapter_titles_from_catalog=lambda html, url: {},
            accept_catalog_title=lambda id, title: False)
        self.assertEqual(title_reconcile.extract_title_map(fake, '<html></html>', site_adapter.DEFAULT_START_URL), {})
        self.assertEqual(title_reconcile.fetch_catalog(fake,site_adapter.DEFAULT_START_URL, saved_html='<html></html>'), {})

    def test_one_adapter_only_contains_website_rules(self):
        root = Path(__file__).resolve().parents[1]
        shared = (root / 'reusable' / 'engine.py').read_text(encoding='utf-8')
        self.assertNotIn("ADAPTER.SOURCE_NAME != 'webtoon'", shared)
        self.assertNotIn('query.get(\'episode_no\'', shared)
        self.assertIn('getattr(ADAPTER, \'STATE_STORAGE_MODE\'', shared)
        self.assertIn('ADAPTER.chapter_identity(a, url, label)', shared)


class GitTitleMaintenanceTests(unittest.TestCase):
    def test_existing_image_blobs_unchanged_after_title_only_update(self):
        with tempfile.TemporaryDirectory(prefix='comic-title-real-git-') as tmp:
            root = Path(tmp)
            remote = root / 'origin.git'
            source = root / 'source'
            source.mkdir()
            def git(*args, cwd=source):
                out = subprocess.run(['git', *args], cwd=cwd, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, env=env)
                if out.returncode:
                    raise AssertionError(out.stderr.decode('utf-8', 'replace'))
                return out.stdout.decode('utf-8', 'replace').strip()
            env = os.environ.copy()
            env.update({'GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':str(root/'isolated.gitconfig'),
                        'GIT_AUTHOR_NAME':'test','GIT_COMMITTER_NAME':'test',
                        'GIT_AUTHOR_EMAIL':'test@example.invalid','GIT_COMMITTER_EMAIL':'test@example.invalid'})
            git('init','--bare',str(remote),cwd=root)
            git('init','-b','main')
            git('remote','add','origin',str(remote))
            (source/'chapters'/'46').mkdir(parents=True)
            content=b'image-binary-will-be-preserved-forever'
            (source/'chapters'/'46'/'001.png').write_bytes(content)
            manifest={'chapter_id':'46','label':'Ep. 46','chapter_title':'Ep. 46',
                      'images':[{'sha256': 'a'*64,'bytes':len(content)}],
                      'remote_files':['chapters/46/001.png'],'original_url':'https://example.invalid/46'}
            (source/'chapters'/'46'/'manifest.json').write_text(json.dumps(manifest),encoding='utf-8')
            git('add','.')
            git('commit','-m','Initial archiving')
            git('push','origin','main')
            before_sha=git('rev-parse','HEAD:chapters/46/001.png')
            commit, result = update_manifest_titles('volume', 'test', {'46':(manifest,"Ep. 46 - Valentine's Day Post-Mortem",'native_list')}, env,
                                                     remote_url=str(remote))
            self.assertTrue(commit)
            self.assertEqual(result['46']['chapter_title'],"Ep. 46 - Valentine's Day Post-Mortem")
            git('fetch','origin','main')
            self.assertEqual(git('rev-parse','FETCH_HEAD:chapters/46/001.png'),before_sha)
            self.assertEqual(git('show','FETCH_HEAD:chapters/46/001.png').encode(), content)
            check = json.loads(git('show','FETCH_HEAD:chapters/46/manifest.json'))
            self.assertTrue(only_title_metadata_changed(manifest,check))
            self.assertEqual(check['label'], "Ep. 46 - Valentine's Day Post-Mortem")

    def test_completed_archive_repaired_without_reopening_source_reader(self):
        with tempfile.TemporaryDirectory(prefix='comic-title-db-') as tmp:
            db=sqlite3.connect(':memory:')
            db.executescript('''CREATE TABLE chapters(chapter_id TEXT PRIMARY KEY,label TEXT,repository TEXT,pages_json TEXT,status TEXT,ordinal INTEGER,commit_sha TEXT);
                                CREATE TABLE repositories(name TEXT PRIMARY KEY,last_sha TEXT);''')
            manifest={'chapter_id':'46','label':'Ep. 46','chapter_title':'Ep. 46',
                      'images':[{'sha256':'a'*64}], 'remote_files':['chapters/46/001.webp']}
            db.execute('INSERT INTO chapters VALUES(?,?,?,?,?,?,?)',('46','Ep. 46','volume',json.dumps(manifest),'PUBLISHED_VERIFIED',46,'oldsha'))
            db.execute('INSERT INTO repositories VALUES(?,?)',('volume','oldsha'))
            options={'github_owner':'test','github_credential_namespace':'test-title-namespace'}
            events=[]
            mock_result={'46':dict(manifest,chapter_title="Ep. 46 - Valentine's Day Post-Mortem",label="Ep. 46 - Valentine's Day Post-Mortem")}
            with patch.object(title_reconcile,'fetch_catalog',return_value={'46':"Ep. 46 - Valentine's Day Post-Mortem"}) as fetch, \
                 patch.object(title_reconcile,'update_manifest_titles',return_value=('newsha',mock_result)) as put:
                outcome=title_reconcile.reconcile_native_titles(db,site_adapter,
                    get_option=lambda _,k:options.get(k),set_option=lambda _,k,v:options.__setitem__(k,v),
                    event=lambda name,**data:events.append((name,data)),
                    isolated_git_environment=lambda:{},paced_push=lambda *args:None,source_url=site_adapter.DEFAULT_START_URL)
            self.assertEqual(outcome['changed'],1)
            self.assertEqual(db.execute('SELECT status FROM chapters').fetchone()[0],'PUBLISHED_VERIFIED')
            self.assertEqual(db.execute('SELECT label FROM chapters').fetchone()[0],"Ep. 46 - Valentine's Day Post-Mortem")
            fetch.assert_called_once()
            put.assert_called_once()
            self.assertEqual(outcome['checked'],1)
            self.assertEqual(db.execute('SELECT last_sha FROM repositories').fetchone()[0], 'newsha')



class EngineTitleCallbackRegressionTests(unittest.TestCase):
    def test_engine_main_refresh_titles_passes_db_compatible_callbacks(self):
        """Exercise the actual engine -> title_reconcile call, not an isolated mock signature."""
        from reusable import engine
        import sys

        database = sqlite3.connect(':memory:')
        database.executescript("""
            CREATE TABLE options(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE chapters(
                chapter_id TEXT PRIMARY KEY, label TEXT, repository TEXT,
                pages_json TEXT, status TEXT, ordinal INTEGER, commit_sha TEXT
            );
            CREATE TABLE repositories(name TEXT PRIMARY KEY, last_sha TEXT);
        """)
        manifest = {
            'chapter_id':'46', 'label':'Ep. 46', 'chapter_title':'Ep. 46',
            'images':[{'sha256':'a'*64}], 'remote_files':['chapters/46/001.webp']
        }
        database.execute('INSERT INTO chapters VALUES(?,?,?,?,?,?,?)',
                         ('46','Ep. 46','volume',json.dumps(manifest),'PUBLISHED_VERIFIED',46,'oldsha'))
        database.execute('INSERT INTO repositories VALUES(?,?)', ('volume','oldsha'))
        engine.set_option(database,'github_owner','test-owner')
        engine.set_option(database,'github_credential_namespace','test-namespace')
        native_title = "Ep. 46 - Valentine's Day Post-Mortem"
        updated = dict(manifest, chapter_title=native_title, label=native_title)
        before_image_manifest = manifest['images'][:]
        try:
            with patch.object(sys,'argv',['comic_archiver.py','--refresh-titles']), \
                 patch.object(engine,'init_db', return_value=database), \
                 patch.object(engine,'status', return_value=None), \
                 patch.object(engine,'event', return_value=None), \
                 patch.object(engine,'isolated_git_environment', return_value={}), \
                 patch.object(title_reconcile,'fetch_catalog',return_value={'46':native_title}), \
                 patch.object(title_reconcile,'update_manifest_titles',return_value=('newsha',{'46':updated})) as git_update:
                engine.main()
            entry = database.execute('SELECT label,pages_json,status FROM chapters WHERE chapter_id=?',('46',)).fetchone()
            self.assertEqual(entry[0], native_title)
            self.assertEqual(entry[2], 'PUBLISHED_VERIFIED')
            self.assertEqual(json.loads(entry[1])['images'],before_image_manifest)
            self.assertEqual(engine.get_option(database, 'native_title_catalog_audited_revision'),
                             title_reconcile.adapter_revision(site_adapter))
            git_update.assert_called_once()
            # A second invocation should reuse the audited revision without another remote update.
            with patch.object(sys,'argv',['comic_archiver.py','--refresh-titles']), \
                 patch.object(engine,'init_db', return_value=database), \
                 patch.object(engine,'status', return_value=None), \
                 patch.object(engine,'event', return_value=None), \
                 patch.object(engine,'isolated_git_environment', return_value={}), \
                 patch.object(title_reconcile,'fetch_catalog', return_value={'46':native_title}), \
                 patch.object(title_reconcile,'update_manifest_titles',return_value=('newsha2',{})):
                # --refresh-titles intentionally forces a recheck, but title has not changed.
                engine.main()
        finally:
            database.close()


if __name__=='__main__': unittest.main()
