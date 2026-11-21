"""Regression: never recrawl confirmed server gaps or reprocess later verified chapters."""
from __future__ import annotations
import sqlite3
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
        response=SimpleNamespace(raise_for_status=lambda:None,
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
if __name__=='__main__':unittest.main()
