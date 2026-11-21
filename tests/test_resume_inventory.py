"""Regression: previously GitHub-verified chapters NEVER trigger source crawling."""
from __future__ import annotations

import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import comic_archiver as engine
from reusable import archive_inventory


def run_git(where, *args):
    proc = subprocess.run(['git',*args],cwd=where,capture_output=True,text=True)
    if proc.returncode:
        raise AssertionError(proc.stderr)
    return proc.stdout.strip()


def manifest(chapter, data=b'\x89PNG\r\n\x1a\nexample-test-bytes'):
    return {'chapter_id':str(chapter), 'label':f'Episode {chapter}',
            'original_url':f'https://www.webtoons.com/x?episode_no={chapter}',
            'images':[{'order':1,'filename':'0001.png','bytes':len(data),
                       'sha256':hashlib.sha256(data).hexdigest(), 'width':1,'height':1}],
            'remote_files':[f'chapters/{chapter}/0001.png'], 'total_images':1}


class ResumeInventoryTests(unittest.TestCase):
    def test_real_local_git_recovery_and_trusted_no_image_refetch(self):
        with tempfile.TemporaryDirectory() as td:
            td=Path(td)
            bare=td/'volume.git'; local=td/'work'
            run_git(td,'init','--bare',str(bare)); local.mkdir(); run_git(local,'init','-b','main')
            run_git(local,'config','user.name','test'); run_git(local,'config','user.email','test@example.invalid')
            image=b'\x89PNG\r\n\x1a\nexpected bytes'
            ch=manifest('1',image)
            out=local/'chapters/1'; out.mkdir(parents=True)
            (out/'0001.png').write_bytes(image)
            (out/'manifest.json').write_text(json.dumps(ch),encoding='utf-8')
            run_git(local,'add','.');run_git(local,'commit','-m','archive one')
            run_git(local,'remote','add','origin',str(bare));run_git(local,'push','origin','main')
            original=archive_inventory._git
            image_shows=[]
            def spy(work,env,*args,**kw):
                if args[:1]==('show',) and str(args[1]).endswith('0001.png'):
                    image_shows.append(args)
                return original(work,env,*args,**kw)
            env=engine.isolated_git_environment()
            with patch.object(archive_inventory,'_git',side_effect=spy):
                found=archive_inventory.read_remote_chapters('test','volume',env,remote_url=str(bare))
            self.assertEqual(len(found),1)
            self.assertFalse(found[0]['previously_verified'])
            self.assertEqual(len(image_shows),1)
            image_shows.clear()
            with patch.object(archive_inventory,'_git',side_effect=spy):
                found=archive_inventory.read_remote_chapters('test','volume',env,{'1':ch},remote_url=str(bare))
            self.assertTrue(found[0]['previously_verified'])
            self.assertEqual(image_shows,[])  # already checked last run; no re-download

    def test_recover_old_repo_without_source_visits(self):
        with tempfile.TemporaryDirectory() as td, patch.object(engine,'DATA',Path(td)):
            db=engine.init_db()
            engine.set_option(db,'github_owner','testuser')
            engine.set_option(db,'series_slug','series')
            m1,m2=manifest('1'),manifest('2')
            def faux(owner,repo,env,trust):
                self.assertEqual(repo,'series-vol-001')
                self.assertTrue(set(trust).issubset({'1','2'}))
                return [dict(chapter_id=cid,manifest=m,repository=repo,tip_sha='ab'*20,
                             previously_verified=False) for cid,m in [('1',m1),('2',m2)]]
            with patch.object(engine,'credential_for_selected',return_value=('testuser','dummy')), \
                 patch.object(engine,'_existing_github_volumes',return_value=['series-vol-001']), \
                 patch.object(archive_inventory,'read_remote_chapters',side_effect=faux), \
                 patch.object(engine.ADAPTER,'ARCHIVED_SOURCE_CHAPTER_COUNT',2):
                result=engine.reconcile_github_archive(db)
                self.assertEqual(result['recovered'],2)
                self.assertTrue(engine.archive_is_complete(db))
                self.assertEqual(db.execute("SELECT COUNT(*) FROM chapters WHERE status='ARCHIVED_PENDING_DEPLOYMENT'").fetchone()[0],2)
                with patch('playwright.sync_api.sync_playwright',side_effect=AssertionError('browser must stay closed')), \
                     patch.object(archive_inventory, 'remote_tip', return_value='ab'*20):
                    engine.archive_run(db,None,None,1000,True)
            db.close()

    def test_previous_archived_manifest_is_not_rehashed_or_redownloaded(self):
        with tempfile.TemporaryDirectory() as td, patch.object(engine,'DATA',Path(td)):
            db=engine.init_db()
            engine.set_option(db,'github_owner','testuser')
            engine.set_option(db,'series_slug','series')
            m=manifest('1')
            db.execute("INSERT INTO chapters(chapter_id,label,url,ordinal,status,repository,commit_sha,pages_json) VALUES(?,?,?,?,?,?,?,?)",
                       ('1','One',m['original_url'],0,'ARCHIVED_PENDING_DEPLOYMENT','series-vol-001','aa'*20,json.dumps(m)))
            db.execute("INSERT INTO repositories(name,logical_bytes,file_count) VALUES(?,?,?)",('series-vol-001',len(b'x'),1))
            db.commit()
            with patch.object(engine,'credential_for_selected',return_value=('testuser','dummy')), \
                 patch.object(archive_inventory,'read_remote_chapters',return_value=[
                      dict(chapter_id='1',manifest=m,repository='series-vol-001',tip_sha='bb'*20,
                           previously_verified=True)]), \
                 patch.object(engine.ADAPTER,'ARCHIVED_SOURCE_CHAPTER_COUNT',1):
                result=engine.reconcile_github_archive(db)
                self.assertEqual(result['recovered'],0)
                self.assertEqual(db.execute('SELECT status FROM chapters').fetchone()[0],'ARCHIVED_PENDING_DEPLOYMENT')
                self.assertTrue(engine.archive_is_complete(db))
            db.close()

    def test_unexpectedly_missing_archive_fails_closed(self):
        with tempfile.TemporaryDirectory() as td, patch.object(engine,'DATA',Path(td)):
            db=engine.init_db()
            engine.set_option(db,'github_owner','testuser');engine.set_option(db,'series_slug','series')
            db.execute("INSERT INTO chapters(chapter_id,label,url,ordinal,status,repository) VALUES(?,?,?,?,?,?)",
                       ('1','One','https://invalid.invalid/1',0,'ARCHIVED_PENDING_DEPLOYMENT','series-vol-001'))
            db.commit()
            with patch.object(engine,'credential_for_selected',return_value=('testuser','dummy')), \
                 patch.object(engine,'_existing_github_volumes',return_value=['series-vol-001']), \
                 patch.object(archive_inventory,'read_remote_chapters',return_value=[]):
                with self.assertRaisesRegex(RuntimeError,'missing'):
                    engine.reconcile_github_archive(db)
            db.close()

    def test_saved_catalog_partial_needs_archive_but_no_rediscovery(self):
        with tempfile.TemporaryDirectory() as td, patch.object(engine,'DATA',Path(td)):
            db=engine.init_db()
            for i,status in ((1,'ARCHIVED_PENDING_DEPLOYMENT'),(2,'DISCOVERED')):
                db.execute('INSERT INTO chapters(chapter_id,label,url,ordinal,status) VALUES(?,?,?,?,?)',
                           (str(i),f'Episode {i}',f'https://webtoon.invalid/{i}',i-1,status))
            db.commit()
            engine.set_option(db,'chapter_catalog_complete',True)
            engine.set_option(db,'chapter_catalog_total',2)
            self.assertFalse(engine.archive_is_complete(db))
            self.assertEqual(len(engine._saved_chapters(db)),2)
            db.close()

    def test_published_reader_is_reused_without_any_cloudflare_write(self):
        with tempfile.TemporaryDirectory() as td, patch.object(engine,'DATA',Path(td)):
            db=engine.init_db()
            engine.set_option(db,'series_slug','series')
            m=manifest('1')
            db.execute("INSERT INTO chapters(chapter_id,label,url,ordinal,status,repository,pages_json,published_url) VALUES(?,?,?,?,?,?,?,?)",
                       ('1','One',m['original_url'],0,'PUBLISHED_VERIFIED','series-vol-001',json.dumps(m),
                        'https://series-reader.pages.dev/?chapter=1'))
            db.execute("INSERT INTO deployments(project,product,production_url) VALUES(?,?,?)",
                       ('series-reader','pages','https://series-reader.pages.dev'))
            db.execute("INSERT INTO deployments(project,product,production_url) VALUES(?,?,?)",
                       ('series-vol-001','pages','https://series-vol-001.pages.dev'))
            db.commit()
            engine.set_option(db,'deployed_reader_fingerprint:pages',engine._reader_fingerprint(db))
            with patch.object(engine,'_live_reader_matches_local_archive',return_value=True) as verified, \
                 patch.object(engine,'_sync_reader_documentation',return_value=None) as synced, \
                 patch.object(engine,'select_cloudflare_account',side_effect=AssertionError('unnecessary Cloudflare login')), \
                 patch.object(engine,'deploy_cloudflare_assets',side_effect=AssertionError('unnecessary deploy')):
                engine.deploy_run(db,mode='pages')
            self.assertEqual(verified.call_count,1)
            self.assertEqual(synced.call_count,1)
            db.close()

    def test_saved_partial_catalog_skips_expensive_discovery(self):
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as td, patch.object(engine,'DATA',Path(td)):
            db=engine.init_db()
            engine.set_option(db,'chapter_catalog_complete',True)
            engine.set_option(db,'chapter_catalog_total',2)
            engine.set_option(db,'series_slug','series')
            engine.set_option(db,'source_url','https://www.webtoons.com/example?episode_no=1')
            for i,stat in [(1,'ARCHIVED_PENDING_DEPLOYMENT'),(2,'DISCOVERED')]:
                db.execute('INSERT INTO chapters(chapter_id,label,url,ordinal,status) VALUES(?,?,?,?,?)',
                           (str(i),f'Episode {i}',f'https://www.webtoons.com/example?episode_no={i}',i-1,stat))
            db.commit()
            fake_page=object()
            fake_ctx=SimpleNamespace(pages=[fake_page],close=lambda:None)
            fake_p=SimpleNamespace()
            class CM:
                def __enter__(self):return fake_p
                def __exit__(self,*args):pass
            seen=[]
            def next_download(ctx,ch,*args,**kwargs):
                seen.append(ch.chapter_id)
                raise RuntimeError('missing chapter was selected without discovery')
            with patch.object(engine,'reconcile_github_archive',return_value={}), \
                 patch.object(engine,'credential_for_selected',return_value=('owner','test-token')), \
                 patch('playwright.sync_api.sync_playwright',return_value=CM()), \
                 patch.object(engine,'open_source_context',return_value=fake_ctx), \
                 patch.object(engine,'discover_from_live',side_effect=AssertionError('no rediscovery')), \
                 patch.object(engine,'acquire_chapter',side_effect=next_download), \
                 patch.object(engine,'should_run_headless',create=True,return_value=False):
                with self.assertRaisesRegex(RuntimeError,'missing chapter was selected'):
                    engine.archive_run(db,None,None,1000,True)
            self.assertEqual(seen,['2'])
            db.close()

    def test_legacy_discovery_log_is_migrated_without_site(self):
        with tempfile.TemporaryDirectory() as td, patch.object(engine,'DATA',Path(td)):
            db=engine.init_db()
            for i in range(2):
                db.execute('INSERT INTO chapters(chapter_id,label,url,ordinal,status) VALUES(?,?,?,?,?)',
                           (str(i),f'Episode {i}',f'https://example.invalid/{i}',i,'ARCHIVED_PENDING_DEPLOYMENT'))
            db.commit();engine.set_option(db,'series_title','My Series')
            (Path(td)/'events.jsonl').write_text(json.dumps({'event':'CHAPTER_DISCOVERY_COMPLETE','total':2,'title':'My Series'})+'\n')
            with patch.object(engine.ADAPTER,'ARCHIVED_SOURCE_CHAPTER_COUNT',None):
                self.assertTrue(engine.archive_is_complete(db))
                self.assertEqual(engine.get_option(db,'chapter_catalog_total'),2)
            db.close()

if __name__=='__main__': unittest.main()
