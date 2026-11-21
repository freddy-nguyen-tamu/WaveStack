"""Verify fast GitHub archive integrity using actual local bare Git remotes.

Never connects to a GitHub account or source website. Enforced by run.py.
"""
import hashlib
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image
from reusable import engine


def git(*args, cwd=None):
    result=subprocess.run(['git', *map(str,args)],cwd=cwd,check=True,
                          stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    return result.stdout.decode().strip()


class FastGitVerification(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='fast-git-test-')
        self.addCleanup(self.temp.cleanup)
        self.base=Path(self.temp.name)
        self.bare=self.base/'remote.git'
        git('init','--bare',self.bare)
        self.db=sqlite3.connect(':memory:')
        self.addCleanup(self.db.close)
        self.db.execute('CREATE TABLE push_events(repository TEXT, ts REAL)')
        self.remote='file://'+self.bare.as_posix()

    def images(self, n=8):
        paths=[]; manifest={'chapter_id':'1','label':'Chapter 1','images':[]}
        for index in range(1,n+1):
            path=self.base/f'{index:04d}.png'
            Image.new('RGB',(20+index,20),color=(index%255,90,40)).save(path)
            raw=path.read_bytes()
            manifest['images'].append({'order':index,'sha256':hashlib.sha256(raw).hexdigest(),
                                       'bytes':len(raw)})
            paths.append(path)
        return paths,manifest

    def stage(self, paths, manifest):
        chapter=engine.Chapter('1','Chapter 1','https://example.invalid/chapter/1')
        with patch.object(engine,'ensure_remote_repo',return_value=self.remote), \
             patch.object(engine,'get_option',return_value='testuser'), \
             patch.object(engine,'event'):
            return engine.stage_one_chapter(self.db,'demo-vol-001',chapter,paths,manifest,'unused')

    def test_actual_remote_tree_contains_exact_numbered_image_objects(self):
        files, manifest=self.images(9)
        commit, remote_paths=self.stage(files,manifest)
        self.assertEqual(len(remote_paths),9)
        self.assertEqual(remote_paths,[f'chapters/1/{n:04d}.png' for n in range(1,10)])
        self.assertEqual(git('--git-dir',self.bare,'rev-parse','refs/heads/main'),commit)
        remote_tree=git('--git-dir',self.bare,'ls-tree','-r','--name-only','main')
        self.assertTrue(all(p in remote_tree.splitlines() for p in remote_paths))
        self.assertIn('chapters/1/manifest.json', remote_tree)

    def test_remote_tree_rejects_wrong_blob_and_missing_path(self):
        files, manifest=self.images(2)
        commit, paths=self.stage(files,manifest)
        env=engine.isolated_git_environment()
        expected={paths[0]:'0'*40,paths[1]:'0'*40,'README.md':'0'*40,
                  'chapters/1/manifest.json':'0'*40}
        with self.assertRaisesRegex(RuntimeError,'object ID differs'):
            engine._verify_remote_chapter_tree(self.remote,env,commit,expected,'chapters/1/')
        expected.pop(paths[0])
        with self.assertRaisesRegex(RuntimeError,'file list mismatch'):
            engine._verify_remote_chapter_tree(self.remote,env,commit,expected,'chapters/1/')

    def test_changed_sha256_blocks_remote_push(self):
        files, manifest=self.images(3)
        manifest['images'][1]['sha256']='f'*64
        with self.assertRaisesRegex(RuntimeError,'Image bytes changed'):
            self.stage(files,manifest)
        proc=subprocess.run(['git','--git-dir',str(self.bare),'show-ref','--verify','refs/heads/main'],
                            capture_output=True)
        self.assertNotEqual(proc.returncode,0)

    def test_image_staging_uses_one_batch_not_a_process_per_image(self):
        files, manifest=self.images(20)
        all_calls=[]
        real_run=subprocess.run
        def watch(args,*pos,**kw):
            if isinstance(args,(tuple,list)) and args and args[0]=='git':
                all_calls.append(tuple(args))
            return real_run(args,*pos,**kw)
        with patch.object(engine.subprocess,'run',side_effect=watch):
            self.stage(files,manifest)
        hash_calls=[c for c in all_calls if len(c)>1 and c[1]=='hash-object']
        index_calls=[c for c in all_calls if len(c)>1 and c[1]=='update-index']
        self.assertEqual(len(hash_calls),3,hash_calls)
        self.assertEqual(len(index_calls),1,index_calls)
        self.assertIn('--stdin-paths',hash_calls[0])
        self.assertIn('--index-info',index_calls[0])
        self.assertFalse(any(c[1]=='show' and ':chapters/1/' in ' '.join(c)
                             for c in all_calls), 'verification must not refetch image blobs')

    def test_remote_tip_mismatch_rejected(self):
        files, manifest=self.images(1)
        commit,paths=self.stage(files,manifest)
        env=engine.isolated_git_environment()
        with self.assertRaisesRegex(RuntimeError,'remote branch SHA mismatch'):
            engine._verify_remote_chapter_tree(self.remote,env,'0'*len(commit),
                                               {paths[0]:'0'*len(commit)},'chapters/1/')


if __name__=='__main__':unittest.main()
