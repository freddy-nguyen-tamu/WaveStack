"""Real partial-fetch regression; manifests only, no image objects fetched."""
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from reusable import title_maintenance as title

class BatchRepair(unittest.TestCase):
    def test_226_titles_batched_readback_and_safe_resume(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            remote=root/'remote.git'; source=root/'source'; source.mkdir()
            env=dict(os.environ, GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=str(root/'gitconfig'),
                     GIT_AUTHOR_NAME='test',GIT_COMMITTER_NAME='test',
                     GIT_AUTHOR_EMAIL='test@example.invalid',GIT_COMMITTER_EMAIL='test@example.invalid')
            def git(*args, cwd=source):
                return subprocess.check_output(['git',*args], cwd=cwd, env=env,stderr=subprocess.PIPE).decode().strip()
            git('init','--bare',str(remote),cwd=root)
            git('config','uploadpack.allowFilter','true',cwd=remote)
            git('config','uploadpack.allowReachableSHA1InWant','true',cwd=remote)
            git('config','uploadpack.allowAnySHA1InWant','true',cwd=remote)
            git('init','-b','main'); updates={}
            for n in range(1,227):
                ch=source/'chapters'/str(n);ch.mkdir(parents=True)
                (ch/'panel.png').write_bytes(f'fake panel {n}'.encode())
                manifest={'chapter_id':str(n),'label':'Chapter 226','chapter_title':'Chapter 226',
                          'images':[{'sha256':f'{n:064x}'}], 'remote_files':[f'chapters/{n}/panel.png']}
                (ch/'manifest.json').write_text(json.dumps(manifest),encoding='utf8')
                updates[str(n)]=(manifest,f'Chapter {n}','source_native_catalog')
            git('add','.');git('commit','-m','archive');git('push',remote.as_uri(),'main')
            image_oids={line.split()[2] for line in git('ls-tree','-r','HEAD').splitlines() if line.endswith('/panel.png')}
            real=title._exec_git; calls=[]; image_fetches=[]
            def observe(work, e,*args,**kwargs):
                result=real(work,e,*args,**kwargs);calls.append(args)
                if 'fetch' in args or 'push' in args:
                    objects=set(git('cat-file','--batch-all-objects','--batch-check=%(objectname)',cwd=work).splitlines())
                    image_fetches.extend(objects & image_oids)
                return result
            buf=io.StringIO()
            with patch.object(title,'_exec_git',side_effect=observe),contextlib.redirect_stdout(buf):
                commit,result=title.update_manifest_titles('volume','test',updates,env,remote_url=remote.as_uri())
            self.assertEqual(len(result),226)
            self.assertEqual(sum('fetch' in c for c in calls),4)
            self.assertEqual(sum('cat-file' in c for c in calls),2)
            self.assertFalse(image_fetches)
            self.assertIn('independent readback of 226 manifests',buf.getvalue())
            self.assertIn('all manifest SHA-256 checks passed',buf.getvalue())
            git('fetch',remote.as_uri(),'main')
            self.assertEqual(commit,git('rev-parse','FETCH_HEAD'))
            self.assertEqual(image_oids,{line.split()[2] for line in git('ls-tree','-r','FETCH_HEAD').splitlines() if line.endswith('/panel.png')})
            calls.clear()
            with patch.object(title,'_exec_git',side_effect=observe),contextlib.redirect_stdout(io.StringIO()):
                sha,again=title.update_manifest_titles('volume','test',updates,env,remote_url=remote.as_uri())
            self.assertIsNone(sha);self.assertEqual(again,result)
            self.assertFalse(any('push' in c for c in calls))
            self.assertFalse(image_fetches)
            corrupted=dict(updates['1'][0],images=[{'sha256':'wrong'}])
            with contextlib.redirect_stdout(io.StringIO()),self.assertRaisesRegex(RuntimeError,'differs beyond title metadata'):
                title.update_manifest_titles('volume','test',{'1':(corrupted,'Chapter 1','source_native_catalog')},env,remote_url=remote.as_uri())

if __name__=='__main__':unittest.main()
