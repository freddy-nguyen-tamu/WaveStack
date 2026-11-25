"""Regression: never recrawl confirmed server gaps or reprocess later verified chapters."""
from __future__ import annotations
import sqlite3
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from reusable import engine as e
from reusable import shared_reader_volume as v

class ResumeTests(unittest.TestCase):
    def setUp(self):
        self.db=sqlite3.connect(':memory:')
        self.db.execute('CREATE TABLE chapters (chapter_id TEXT PRIMARY KEY,status TEXT)')
        self.stored=[SimpleNamespace(chapter_id=str(i),url=f'https://example.test/{i}') for i in range(82,100)]
        self.db.executemany('INSERT INTO chapters VALUES (?,?)',
            [(str(i), 'SOURCE_SERVER_DEFERRED' if i==82 else
              'DISCOVERED' if i==99 else 'ARCHIVED_PENDING_DEPLOYMENT') for i in range(82,100)])
    def tearDown(self): self.db.close()
    def test_next_is_99_not_82_or_83(self):
        self.assertEqual([x.chapter_id for x in e._source_resume_candidates(self.db,self.stored)], ['99'])
        self.assertEqual(self.db.execute("SELECT status FROM chapters WHERE chapter_id='82'").fetchone()[0],
                         'SOURCE_SERVER_DEFERRED')
    def test_earlier_downloader_failure_wins(self):
        self.db.execute("UPDATE chapters SET status='SOURCE_CAPTURE_FAILED' WHERE chapter_id='90'")
        self.assertEqual([x.chapter_id for x in e._source_resume_candidates(self.db,self.stored)],['90','99'])
    def test_no_source_requests_when_only_deferred(self):
        self.db.execute("UPDATE chapters SET status='ARCHIVED_PENDING_DEPLOYMENT' WHERE chapter_id='99'")
        self.assertEqual(e._source_resume_candidates(self.db,self.stored),[])
        self.assertEqual(self.db.execute("SELECT status FROM chapters WHERE chapter_id='82'").fetchone()[0],
                         'SOURCE_SERVER_DEFERRED')
    def test_opt_in_source_repair(self):
        self.assertEqual([x.chapter_id for x in e._source_resume_candidates(self.db,self.stored,
                           retry_server_failures=True)],['82','99'])
    def test_github_verified_needs_no_source(self):
        self.db.execute("UPDATE chapters SET status='ARCHIVED_VERIFIED' WHERE chapter_id='99'")
        self.assertEqual(e._source_resume_candidates(self.db,self.stored),[])
    def test_catalog_disagreement_fails_closed(self):
        with self.assertRaisesRegex(RuntimeError,'disagree'):
            e._source_resume_candidates(self.db,[SimpleNamespace(chapter_id='100')])

class VolumePreflightTests(unittest.TestCase):
    def test_verify_remote_manifest_fails_if_current_comic_missing(self):
        d=sqlite3.connect(':memory:');d.row_factory=sqlite3.Row
        d.execute('CREATE TABLE chapters (chapter_id TEXT, status TEXT, repository TEXT, pages_json TEXT, ordinal INTEGER DEFAULT 0)')
        d.execute("INSERT INTO chapters VALUES ('98','ARCHIVED_PENDING_DEPLOYMENT','a-vol-001', '{}', 98)")
        response=SimpleNamespace(status_code=200,raise_for_status=lambda:None,
                                 json=lambda:{'chapters':[{'id':'97'}]})
        with patch.object(e,'get_option',return_value='annoying-alice'), \
             patch.object(v.requests,'get',return_value=response):
            with self.assertRaisesRegex(RuntimeError,'omitted 1'):
                v.verify_current_in_shared_reader(e,d,'https://open-reader.example.workers.dev')
        d.close()
    def test_missing_image_host_failure_halts_before_worker(self):
        e_stub=SimpleNamespace(_reader_archive_rows=lambda db:[{'chapter_id':'98','repository':'r',
                                            'pages_json':'{"images": [], "remote_files": []}'}])
        with self.assertRaisesRegex(RuntimeError,'Invalid GitHub image manifest'):
            v.ensure_current_image_hosts(e_stub,None)


class SharedVolumeRetryTests(unittest.TestCase):
    """No repeated 700 MiB staging/upload after Cloudflare accepted a volume."""

    def setUp(self):
        import hashlib
        import json
        import tempfile
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = sqlite3.connect(':memory:')
        self.addCleanup(self.db.close)
        self.db.executescript('''
            CREATE TABLE options(key TEXT PRIMARY KEY,value TEXT);
            CREATE TABLE deployments(project TEXT PRIMARY KEY, product TEXT,
                production_url TEXT, deployed_at TEXT,files INTEGER,bytes INTEGER);
        ''')
        self.repo = 'fixture-vol-004'
        self.url = 'https://fixture-vol-004.pages.dev'
        digest = hashlib.sha256(b'image-1').hexdigest()
        self.rows = [{'chapter_id':'first', 'repository':self.repo,
                      'pages_json':json.dumps({'remote_files':['chapters/first/0001.png'],
                            'images':[{'sha256':digest,'bytes':7}]})}]
        self.values = {}
        self.calls = {'fetch':0,'upload':0,'list':0,'select':0,'verify':0}
        self.events = []
        self.host_error = False
        self.created_here = False
        self.existing = []
        holder = self
        class EngineStub:
            DATA = Path(holder.tmp.name)
            CONFIG = {'cloudflare_project_max_files':100}
            PAGES_LIMIT = 25 * 1024 * 1024
            def _reader_archive_rows(self, db): return holder.rows
            def _volume_fingerprint(self, rows): return 'fixture-fingerprint-v1'
            def get_option(self, db, key, default=None):
                record=db.execute('SELECT value FROM options WHERE key=?',(key,)).fetchone()
                return json.loads(record[0]) if record else default
            def set_option(self, db, key, value):
                with db:
                    db.execute('REPLACE INTO options VALUES(?,?)',(key,json.dumps(value)))
            def event(self, kind, **data): holder.events.append((kind,data))
            def select_cloudflare_account(self): holder.calls['select']+=1
            def credential_for_selected(self, db): return ('owner','token')
            def list_pages_projects(self):
                holder.calls['list']+=1
                return holder.existing
            def cloudflare_pages_url(self, project):
                return 'https://' + project['subdomain']
            def verify_cloudflare_asset(self, url, *, expected_sha256, attempts):
                holder.calls['verify']+=1
                if holder.host_error:
                    raise RuntimeError(f'Cloudflare verification failed for {url}: HTTP 522')
                if not url.startswith(holder.url + '/'):
                    raise RuntimeError('published SHA-256 did not match GitHub archive')
                return True
            def _fetch_verified_files(self, db, rows, target, owner):
                holder.calls['fetch']+=1
                path=target/'chapters'/'first'/'0001.png'
                path.parent.mkdir(parents=True,exist_ok=True)
                path.write_bytes(b'image-1')
                return [(path, {'sha256':digest,'bytes':7}, 'chapters/first/0001.png')]
            def deploy_cloudflare_assets(self, db, project, target, mode='pages'):
                holder.calls['upload']+=1
                return holder.url
            def utc(self): return '2026-11-22T00:00:00+00:00'
        self.engine=EngineStub()
        self.pending_key=f'pending_shared_volume_upload:pages:{self.repo}'
        self.fp_key=f'deployed_volume_fingerprint:pages:{self.repo}'

    def mark_created(self):
        log=Path(self.tmp.name)/'events.jsonl'
        log.write_text('\n'.join([
            json.dumps({'event':'CLOUDFLARE_PAGES_PROJECT_CREATED',
                        'project':self.repo}),
            json.dumps({'event':'OTHER', 'project':'another'})])+'\n',encoding='utf8')
        self.existing=[{'name':self.repo,'subdomain':self.repo+'.pages.dev'}]

    def test_adopts_existing_uploaded_volume_without_any_upload(self):
        self.mark_created()
        hosts=v.ensure_current_image_hosts(self.engine,self.db)
        self.assertEqual(hosts[self.repo],self.url)
        self.assertEqual(self.calls['fetch'],0)
        self.assertEqual(self.calls['upload'],0)
        self.assertEqual(self.engine.get_option(self.db,self.fp_key),'fixture-fingerprint-v1')

    def test_existing_cloudflare_522_never_triggers_690_mib_reupload(self):
        self.mark_created();self.host_error=True
        with self.assertRaisesRegex(RuntimeError,'without reupload'):
            v.ensure_current_image_hosts(self.engine,self.db)
        self.assertEqual(self.calls['fetch'],0)
        self.assertEqual(self.calls['upload'],0)

    def test_upload_checkpoint_persists_across_failure_and_restart(self):
        self.host_error=True
        with self.assertRaisesRegex(RuntimeError,'upload succeeded'):
            v.ensure_current_image_hosts(self.engine,self.db)
        self.assertEqual(self.calls['fetch'],1)
        self.assertEqual(self.calls['upload'],1)
        pending=self.engine.get_option(self.db,self.pending_key)
        self.assertEqual(pending['url'],self.url)
        self.assertEqual(pending['fingerprint'],'fixture-fingerprint-v1')
        self.assertFalse(self.db.execute('SELECT * FROM deployments').fetchall(),
                         'Unverified public Pages content cannot be recorded as verified')
        with self.assertRaisesRegex(RuntimeError,'no GitHub re-download'):
            v.ensure_current_image_hosts(self.engine,self.db)
        self.assertEqual(self.calls['fetch'],1)
        self.assertEqual(self.calls['upload'],1)
        self.host_error=False
        result=v.ensure_current_image_hosts(self.engine,self.db)
        self.assertEqual(result[self.repo],self.url)
        self.assertEqual(self.calls['fetch'],1)
        self.assertEqual(self.calls['upload'],1)
        self.assertIsNone(self.engine.get_option(self.db,self.pending_key))
        self.assertEqual(self.engine.get_option(self.db,self.fp_key),'fixture-fingerprint-v1')

    def test_verified_host_522_preserves_prior_deployment(self):
        self.db.execute('INSERT INTO deployments VALUES (?,?,?,?,?,?)',
                        (self.repo,'pages',self.url,'yesterday',1,7))
        self.engine.set_option(self.db,self.fp_key,'fixture-fingerprint-v1')
        self.host_error=True
        with self.assertRaisesRegex(RuntimeError,'Previously verified'):
            v.ensure_current_image_hosts(self.engine,self.db)
        self.assertEqual(self.calls['fetch'],0)
        self.assertEqual(self.calls['upload'],0)
        self.assertEqual(self.db.execute('SELECT production_url FROM deployments').fetchone()[0],
                         self.url)

    def test_unknown_project_is_not_silently_adopted(self):
        self.existing=[{'name':self.repo,'subdomain':self.repo+'.pages.dev'}]
        result=v.ensure_current_image_hosts(self.engine,self.db)
        self.assertEqual(result[self.repo],self.url)
        self.assertEqual(self.calls['fetch'],1)
        self.assertEqual(self.calls['upload'],1)
        self.assertEqual(self.calls['list'],0,
                         'No ownership evidence: keep existing Pages project safeguards')

if __name__=='__main__':unittest.main()
