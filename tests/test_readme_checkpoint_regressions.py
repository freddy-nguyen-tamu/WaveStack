"""Real-Git and crash-recovery regressions for Windows README byte mismatch.

Does not access GitHub, Cloudflare, or any user's real repositories.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from reusable import engine


def git(repo: Path, *args: str) -> bytes:
    proc = subprocess.run(['git', *args], cwd=repo, capture_output=True)
    if proc.returncode:
        raise AssertionError(proc.stderr.decode('utf-8', 'replace'))
    return proc.stdout.strip()


def seed_db(db, repo='demo-vol-001'):
    engine.set_option(db, 'series_title', 'Sample Comic')
    engine.set_option(db, 'series_slug', 'demo')
    engine.set_option(db, 'github_owner', 'tester')
    engine.set_option(db, 'github_credential_namespace', 'unittest')
    data = b'archive image bytes (test only)'
    sha = hashlib.sha256(data).hexdigest()
    manifest = dict(chapter_id='1', label='Ep. 1 - Sample',
                    chapter_title='Ep. 1 - Sample',
                    images=[{'sha256':sha,'width':10,'height':30,'bytes':len(data)}],
                    remote_files=['chapters/1/001.jpg'])
    db.execute('INSERT INTO chapters(chapter_id,label,url,ordinal,status,repository,pages_json) '
               'VALUES(?,?,?,?,?,?,?)',
               ('1','Ep. 1 - Sample','https://example.invalid/1',1,
                'ARCHIVED_PENDING_DEPLOYMENT',repo,json.dumps(manifest)))
    db.commit()
    return data, manifest


class ReadmeBytesTests(unittest.TestCase):
    def test_reader_repo_remote_readme_matches_exact_bytes_even_with_windows_text_emulation(self):
        with tempfile.TemporaryDirectory(prefix='comic-readme-integrity-') as tmp:
            root = Path(tmp)
            bare = root / 'origin.git'
            git(root, 'init', '--bare', '-q', str(bare))
            stage = root / 'stage'; stage.mkdir()
            (stage / 'index.html').write_bytes(b'<html>hello</html>')
            (stage / 'manifest.json').write_bytes(b'{"chapters":[]}')
            db = sqlite3.connect(':memory:')
            db.executescript('CREATE TABLE options(key TEXT PRIMARY KEY,value TEXT);'
                             'CREATE TABLE chapters(chapter_id TEXT,label TEXT,ordinal INT,repository TEXT);')
            engine.set_option(db,'github_owner','tester')
            engine.set_option(db,'series_title','Sample Comic')
            engine.set_option(db,'series_slug','demo')
            engine.set_option(db,'github_credential_namespace','test_namespace')
            db.execute('INSERT INTO chapters VALUES(?,?,?,?)',('1','Ep. 1 - Sample',1,'demo-vol-001'))
            db.commit()
            original_write_text = Path.write_text
            def emulate_windows_write_text(path, data, *args, **kwargs):
                if path.name == 'deployed-reader-README.md':
                    return path.write_bytes(data.replace('\n','\r\n').encode('utf-8'))
                return original_write_text(path, data, *args, **kwargs)
            with patch.object(engine, 'ensure_remote_repo', return_value=str(bare)), \
                 patch.object(engine, 'paced_push', return_value=None), \
                 patch.object(engine, 'event', return_value=None), \
                 patch.object(Path, 'write_text', emulate_windows_write_text):
                name, sha = engine.archive_reader_source(db, 'demo', stage, 'unused',
                    reader_url='https://demo-reader.pages.dev')
                self.assertEqual(name,'demo-reader')
                self.assertEqual(git(bare,'rev-parse','refs/heads/main').decode(),sha)
                # Rerunning after a transient verification failure must NOT push
                # a redundant commit when the existing remote tree is identical.
                name2, sha2 = engine.archive_reader_source(db,'demo',stage,'unused',
                    reader_url='https://demo-reader.pages.dev')
            self.assertEqual(name2,name)
            self.assertEqual(sha2,sha)
            live = subprocess.run(['git','show','main:README.md'], cwd=bare,
                                  check=True, capture_output=True).stdout
            self.assertEqual(live, engine.reader_repository_readme(db,
                'https://demo-reader.pages.dev').encode('utf-8'))
            publisher = subprocess.run(['git','show','main:publisher/README.md'],
                                       cwd=bare, check=True, capture_output=True).stdout
            self.assertEqual(publisher, (engine.ROOT/'README.md').read_bytes())
            db.close()

    def test_volume_readme_exact_bytes_and_no_second_commit_on_windows(self):
        with tempfile.TemporaryDirectory(prefix='comic-volume-readme-') as tmp:
            root=Path(tmp)
            remote=root/'origin.git'
            git(root,'init','--bare','-q',str(remote))
            wd=root/'work';wd.mkdir()
            git(wd,'init','-q','-b','main')
            git(wd,'config','user.name','Test')
            git(wd,'config','user.email','test@example.invalid')
            (wd/'README.md').write_bytes(b'# Sample Comic\n')
            (wd/'001.jpg').write_bytes(b'original archive blob')
            git(wd,'add','.')
            git(wd,'commit','-m','seed','-q')
            git(wd,'remote','add','origin',str(remote))
            git(wd,'push','-q','origin','main')
            original_blob=git(remote,'rev-parse','main:001.jpg')
            db=sqlite3.connect(':memory:')
            db.executescript('CREATE TABLE options(key TEXT PRIMARY KEY,value TEXT);'
                             'CREATE TABLE chapters(chapter_id TEXT,label TEXT,repository TEXT,ordinal INT);')
            engine.set_option(db,'github_owner','tester')
            engine.set_option(db,'series_slug','demo')
            engine.set_option(db,'series_title','Sample Comic')
            engine.set_option(db,'github_credential_namespace','test')
            db.execute('INSERT INTO chapters VALUES(?,?,?,?)',('1','Ep. 1','demo-vol-001',1))
            db.commit()
            original_write_text = Path.write_text
            def emulate_windows_write_text(path, data, *args, **kwargs):
                if path.name == 'README.md' and 'comic-volume-readme-' in str(path):
                    return path.write_bytes(data.replace('\n','\r\n').encode('utf-8'))
                return original_write_text(path, data, *args, **kwargs)
            with patch.object(engine,'paced_push',return_value=None), \
                 patch.object(engine,'event',return_value=None), \
                 patch.object(Path,'write_text',emulate_windows_write_text):
                self.assertTrue(engine.update_volume_readme(db,'demo-vol-001',
                    'https://demo-reader.pages.dev','https://demo-assets.pages.dev',
                    remote_url=str(remote)))
                updated=git(remote,'rev-parse','main')
                self.assertFalse(engine.update_volume_readme(db,'demo-vol-001',
                    'https://demo-reader.pages.dev','https://demo-assets.pages.dev',
                    remote_url=str(remote)))
            self.assertEqual(git(remote,'rev-parse','main'),updated)
            self.assertEqual(git(remote,'rev-parse','main:001.jpg'),original_blob)
            self.assertIn(b'https://demo-reader.pages.dev',git(remote,'show','main:README.md'))
            db.close()


class CloudflareCheckpointTests(unittest.TestCase):
    def test_documentation_crash_after_verified_deployment_never_redeploys(self):
        with tempfile.TemporaryDirectory(prefix='comic-docs-recovery-') as tmp, \
             patch.object(engine,'DATA',Path(tmp)):
            db=engine.init_db()
            image, manifest=seed_db(db)
            db.execute('REPLACE INTO deployments(project,product,production_url) VALUES(?,?,?)',
                       ('demo-vol-001','pages','https://demo-assets.pages.dev'))
            engine.set_option(db,'deployed_volume_fingerprint:pages:demo-vol-001',
                              engine._volume_fingerprint(engine._reader_archive_rows(db)))
            published = engine._reader_chapters_for_publication(
                engine._reader_archive_rows(db),
                {'demo-vol-001':'https://demo-assets.pages.dev'})
            live_payload={'chapters':published,'title':'Sample Comic','generated_at':'old'}
            resp=SimpleNamespace(content=json.dumps(live_payload).encode('utf-8'),
                                 json=lambda:live_payload)
            def fake_fetch(database, rows, target, owner):
                path = target/'chapters/1/001.jpg'
                path.parent.mkdir(parents=True,exist_ok=True)
                path.write_bytes(image)
                return [(path,manifest['images'][0], 'chapters/1/001.jpg')]
            calls=[]
            def fake_deploy(database, name, stage, mode='pages'):
                calls.append(name)
                return f'https://{name}.pages.dev'
            with patch.object(engine,'select_cloudflare_account',return_value=None), \
                 patch.object(engine,'_fetch_verified_files',side_effect=fake_fetch), \
                 patch.object(engine,'deploy_cloudflare_assets',side_effect=fake_deploy), \
                 patch.object(engine,'verify_cloudflare_asset',return_value=resp), \
                 patch.object(engine,'credential_for_selected',return_value=('tester','unused')), \
                 patch.object(engine,'_sync_reader_documentation',side_effect=RuntimeError('post-deploy GitHub transient failure')):
                with self.assertRaisesRegex(RuntimeError,'post-deploy'):
                    engine.deploy_run(db,mode='pages')
            self.assertEqual(calls,['demo-reader'])
            self.assertEqual(db.execute('SELECT status FROM chapters').fetchone()[0], 'PUBLISHED_VERIFIED')
            self.assertEqual(db.execute('SELECT production_url FROM deployments WHERE project=?',
                                        ('demo-reader',)).fetchone()[0], 'https://demo-reader.pages.dev')
            self.assertEqual(engine.get_option(db,'deployed_reader_fingerprint:pages'),
                             engine._reader_fingerprint(db))
            with patch.object(engine,'_live_reader_matches_local_archive',return_value=True), \
                 patch.object(engine,'_sync_reader_documentation',return_value=None) as synced, \
                 patch.object(engine,'select_cloudflare_account',side_effect=AssertionError('Cloudflare auth not needed')), \
                 patch.object(engine,'deploy_cloudflare_assets',side_effect=AssertionError('no redeploy')):
                engine.deploy_run(db, mode='pages')
            synced.assert_called_once()
            self.assertEqual(calls,['demo-reader'])
            db.close()

    def test_recovery_rejects_changed_chapter_title_even_with_same_count(self):
        with tempfile.TemporaryDirectory(prefix='comic-public-integrity-') as tmp, \
             patch.object(engine,'DATA',Path(tmp)):
            db=engine.init_db()
            seed_db(db)
            db.execute('REPLACE INTO deployments(project,product,production_url) VALUES(?,?,?)',
                       ('demo-vol-001','pages','https://demo-assets.pages.dev'))
            db.commit()
            expected=engine._reader_chapters_for_publication(engine._reader_archive_rows(db),
                       {'demo-vol-001':'https://demo-assets.pages.dev'})
            bad=json.loads(json.dumps(expected))
            bad[0]['title']='INCORRECT STALE TITLE'
            remote=SimpleNamespace(json=lambda:{'chapters':bad})
            with patch.object(engine,'verify_cloudflare_asset',return_value=remote):
                self.assertFalse(engine._live_reader_matches_local_archive(
                    db, 'pages','https://demo-reader.pages.dev'))
            db.close()

    def test_post_deploy_github_sync_recovers_from_saved_live_manifest_without_images(self):
        """Exercise the complete GitHub docs path against two REAL local remotes."""
        with tempfile.TemporaryDirectory(prefix='comic-real-docs-retry-') as tmp, \
             patch.object(engine,'DATA',Path(tmp)):
            home=Path(tmp)
            reader_remote=home/'reader.git'
            volume_remote=home/'volume.git'
            git(home,'init','--bare','-q',str(reader_remote))
            git(home,'init','--bare','-q',str(volume_remote))
            work=home/'volume-seed';work.mkdir()
            git(work,'init','-q','-b','main')
            git(work,'config','user.name','Test')
            git(work,'config','user.email','tester@example.invalid')
            (work/'README.md').write_bytes(b'# Sample Comic\n')
            (work/'chapters/1').mkdir(parents=True)
            (work/'chapters/1/001.jpg').write_bytes(b'archive image bytes (test only)')
            git(work,'add','.')
            git(work,'commit','-m','seed','-q')
            git(work,'remote','add','origin',str(volume_remote))
            git(work,'push','-q','origin','main')
            initial_blob=git(volume_remote,'rev-parse','main:chapters/1/001.jpg')
            db=engine.init_db()
            seed_db(db)
            db.execute('UPDATE chapters SET status=? WHERE chapter_id=?',('PUBLISHED_VERIFIED','1'))
            db.execute('REPLACE INTO deployments(project,product,production_url) VALUES(?,?,?)',
                       ('demo-vol-001','pages','https://demo-assets.pages.dev'))
            db.execute('REPLACE INTO deployments(project,product,production_url) VALUES(?,?,?)',
                       ('demo-reader','pages','https://demo-reader.pages.dev'))
            db.commit()
            volumes={'demo-vol-001':'https://demo-assets.pages.dev'}
            published=engine._reader_chapters_for_publication(engine._reader_archive_rows(db),volumes)
            manifest_bytes=json.dumps({'title':'Sample Comic','chapters':published},
                                      ensure_ascii=False).encode('utf-8')
            remote_manifest=SimpleNamespace(content=manifest_bytes,
                                            json=lambda:json.loads(manifest_bytes))
            real_update_volume=engine.update_volume_readme
            def update_volume(database,repo,url,volume_url):
                return real_update_volume(database,repo,url,volume_url,
                                          remote_url=str(volume_remote))
            with patch.object(engine,'credential_for_selected',return_value=('tester','unused')), \
                 patch.object(engine,'ensure_remote_repo',return_value=str(reader_remote)), \
                 patch.object(engine,'update_volume_readme',side_effect=update_volume), \
                 patch.object(engine,'verify_cloudflare_asset',return_value=remote_manifest), \
                 patch.object(engine,'update_local_readme_deployment',return_value=None), \
                 patch.object(engine,'paced_push',return_value=None), \
                 patch.object(engine,'event',return_value=None):
                engine._sync_reader_documentation(db,'pages','https://demo-reader.pages.dev',volumes)
                first_reader_tip=git(reader_remote,'rev-parse','main')
                first_volume_tip=git(volume_remote,'rev-parse','main')
                engine._sync_reader_documentation(db,'pages','https://demo-reader.pages.dev',volumes)
            self.assertEqual(first_reader_tip,git(reader_remote,'rev-parse','main'))
            self.assertEqual(first_volume_tip,git(volume_remote,'rev-parse','main'))
            self.assertEqual(initial_blob,git(volume_remote,'rev-parse','main:chapters/1/001.jpg'))
            self.assertIn(b'https://demo-reader.pages.dev',
                          subprocess.run(['git','show','main:README.md'],cwd=reader_remote,
                                         capture_output=True,check=True).stdout)
            self.assertIn(b'https://demo-reader.pages.dev',
                          subprocess.run(['git','show','main:README.md'],cwd=volume_remote,
                                         capture_output=True,check=True).stdout)
            self.assertTrue(git(reader_remote,'rev-parse','main:publisher/reusable/engine.py'))
            self.assertTrue(git(reader_remote,'rev-parse','main:publisher/site_specific/site_adapter.py'))
            db.close()

if __name__ == '__main__':
    unittest.main()
