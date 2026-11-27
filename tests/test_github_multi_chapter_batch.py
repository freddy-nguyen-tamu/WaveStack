import hashlib
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from PIL import Image
from reusable import engine, partial_chapter_publish

class MultiChapterGit(unittest.TestCase):
    def test_native_multi_chapter_single_push_and_exact_paths(self):
        with tempfile.TemporaryDirectory() as t, sqlite3.connect(':memory:') as db:
            root=Path(t); bare=root/'remote.git'
            subprocess.run(['git','init','--bare',str(bare)],check=True,capture_output=True)
            db.execute('CREATE TABLE push_events(repository TEXT, ts REAL)')
            records=[]
            for n in range(1,8):
                folder=root/str(n);folder.mkdir();files=[];images=[]
                for i in range(1,4):
                    p=folder/f'{i:04d}.png';Image.new('RGB',(20,20),(n,i,33)).save(p);raw=p.read_bytes();files.append(p);images.append({'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()})
                records.append((engine.Chapter(str(n),f'Chapter {n}',f'https://example.invalid/{n}'),files,{'images':images,'chapter_id':str(n)}))
            commands=[];real=engine.git_run
            def spy(args,**kw):
                commands.append(args);return real(args,**kw)
            with patch.object(engine,'ensure_remote_repo',return_value=bare.as_uri()),patch.object(engine,'get_option',return_value='testuser'),patch.object(engine,'event'),patch.object(engine,'git_run',side_effect=spy):
                commit,_=engine.stage_one_chapter(db,'demo-vol-001',*records[0],'unused',additional=records[1:])
            self.assertEqual(sum(x[1]=='push' for x in commands),1)
            self.assertEqual(sum(x[1]=='hash-object' and '--stdin-paths' in x for x in commands),1)
            tree=subprocess.check_output(['git','--git-dir',str(bare),'ls-tree','-r','--name-only',commit]).decode().splitlines()
            for n in range(1,8):
                self.assertIn(f'chapters/{n}/manifest.json',tree)
                for i in range(1,4): self.assertIn(f'chapters/{n}/{i:04d}.png',tree)
            self.assertEqual(len(tree),29)

    def test_partial_panels_one_native_push_and_noop(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t);bare=root/'remote.git';work=root/'seed';work.mkdir()
            def run(*args,cwd=work):return subprocess.check_output(['git',*map(str,args)],cwd=cwd,stderr=subprocess.DEVNULL).decode().strip()
            run('init','-b','main');(work/'README.md').write_text('hello');run('add','README.md');run('-c','user.name=t','-c','user.email=t@example.test','commit','-m','init');run('init','--bare',bare);run('push',bare,'main')
            calls=[];real=engine.git_run
            def proxy(args,**kw):
                calls.append(args);args=[bare.as_uri() if x=='https://github.com/testuser/open-reader.git' else x for x in args];return real(args,**kw)
            files=[(f'partial/comic/1/{i:04d}.png',bytes([i%256])*70) for i in range(1,258)]
            with patch.object(engine,'git_run',side_effect=proxy):
                partial_chapter_publish._github_batch_verified(engine,'testuser','fixture-not-secret',files)
                partial_chapter_publish._github_batch_verified(engine,'testuser','fixture-not-secret',files)
            self.assertEqual(sum(c[1]=='push' for c in calls),1)
            for p,raw in files:self.assertEqual(subprocess.check_output(['git','--git-dir',str(bare),'show','main:'+p]),raw)
    def test_documented_native_budget_and_config_override(self):
        with patch.dict(engine.CONFIG,{'max_push_mib':4096}):
            self.assertEqual(engine.github_push_payload_budget(),1984*1024**2)
        with patch.dict(engine.CONFIG,{'max_push_mib':64}):
            self.assertEqual(engine.github_push_payload_budget(),64*1024**2)
if __name__=='__main__':unittest.main()
