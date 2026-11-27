"""Persistent local Open Reader import companion. No source-document bytes leave this process.
Run from project root: python -m reusable.local_comic_uploader
"""
from __future__ import annotations
import argparse, contextlib, hashlib, json, os, re, secrets, shutil, sqlite3, subprocess, sys, tempfile, threading, time, uuid, webbrowser
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs
from datetime import datetime, timezone
# Use the project interpreter even when invoked through system Python.
if __name__ == '__main__':
    _venv=Path(__file__).resolve().parents[1]/'.venv'
    if Path(sys.prefix).resolve()!=_venv.resolve():
        _python=next((p for p in (_venv/'Scripts/python.exe',_venv/'bin/python') if p.is_file()),None)
        if _python is not None:
            raise SystemExit(subprocess.call([str(_python),'-m','reusable.local_comic_uploader',*sys.argv[1:]],cwd=Path(__file__).resolve().parents[1]))
import requests
import pymupdf as fitz
from PIL import Image, ImageOps
from .github_cooldown import response_delay as rate_delay, git_throttled, backoff
from itertools import count
try:
    from pillow_heif import register_heif_opener
    register_heif_opener()
except ImportError:
    pass

ROOT=Path(__file__).resolve().parents[1]
BASE=ROOT/'.archiver_state'/'local_comic_import'
ORIGIN='https://open-reader.av-chatbot1.workers.dev'
PORT=18766
MIB=1024**2
BATCH=128*MIB; VOLUME=700*MIB; MAX_IMAGE=12*MIB; MAX_PIXELS=24_000_000; LIMIT=2000
SLUG=re.compile(r'import-[a-f0-9]{32}\Z'); SHA=re.compile(r'[a-f0-9]{64}\Z'); CID=re.compile(r'ch-[a-f0-9]{32}\Z')

def digest(b): return hashlib.sha256(b).hexdigest()
def encode(x): return json.dumps(x,ensure_ascii=False,separators=(',',':')).encode('utf-8')
def atomic(path,b):
    path.parent.mkdir(parents=True,exist_ok=True)
    fd,tmp=tempfile.mkstemp(prefix='.import-',dir=path.parent)
    try:
        with os.fdopen(fd,'wb') as stream:
            stream.write(b);stream.flush();os.fsync(stream.fileno())
        os.replace(tmp,path)
    finally:
        Path(tmp).unlink(missing_ok=True)
def stat_signature(path):
    s=Path(path).stat();return [s.st_size,s.st_mtime_ns]
def require(condition,message):
    if not condition: raise RuntimeError(message)


class Journal:
    """Single durable job; every change is one SQLite transaction. No credentials."""
    def __init__(self,path):
        self.path=Path(path); self.path.parent.mkdir(parents=True,exist_ok=True)
        with contextlib.closing(self.connect()) as db:
            with db:db.execute('CREATE TABLE IF NOT EXISTS job (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)')
    def connect(self):
        c=sqlite3.connect(self.path,timeout=30)
        try:c.execute('PRAGMA synchronous=FULL')
        except BaseException:
            c.close();raise
        return c
    def get(self):
        with contextlib.closing(self.connect()) as c:
            r=c.execute('SELECT data FROM job WHERE id=1').fetchone();return json.loads(r[0]) if r else None
    def put(self,job):
        with contextlib.closing(self.connect()) as c:
            with c:c.execute('INSERT OR REPLACE INTO job VALUES(1,?)',(encode(job).decode(),))

class Renderer:
    """Open PDFs by pathname (not bytes), reuse only one open document."""
    def __init__(self):self.doc=None;self.key=None
    def close(self):
        doc=self.doc;self.doc=None;self.key=None
        if doc is not None:doc.close()
    def document(self,f):
        self.check(f)
        key=(f['path'],tuple(f['signature']))
        if self.key!=key:
            self.close(); doc=fitz.open(f['path'])
            try:
                if doc.needs_pass:raise RuntimeError('Password-protected PDF: unlock locally with your authorized password first.')
                require(len(doc)>0,'Empty document')
            except BaseException:
                doc.close();raise
            self.doc=doc;self.key=key
        return self.doc
    @staticmethod
    def check(f):require(stat_signature(f['path'])==f['signature'],'Source file changed since preview: '+f['name'])
    def probe(self,path):
        path=Path(path).resolve(strict=True);require(path.is_file(),'Not a file')
        f={'id':uuid.uuid4().hex,'path':str(path),'signature':stat_signature(path),'name':path.name,'size':path.stat().st_size,'type':'application/pdf' if path.suffix.lower()=='.pdf' else 'image','count':1}
        if f['type']=='application/pdf':
            try:f['count']=len(self.document(f))
            finally:self.close()
        elif path.suffix.lower()=='.svg':
            with fitz.open(str(path)) as d: require(len(d)==1,'Invalid SVG')
        else:
            with Image.open(path) as im: require(im.width>0 and im.height>0,'Invalid image')
        require(f['count']>0,'Empty PDF');return f
    def render(self,f,page,width,edge,thumbnail=False):
        self.check(f);require(type(page) is int and 0<=page<f['count'],'Invalid source page')
        if f['type']=='application/pdf' or Path(f['path']).suffix.lower()=='.svg':
            doc=self.document(f);p=doc[page];w,h=p.rect.width,p.rect.height
            require(w>0 and h>0,'Invalid PDF page geometry')
            scale=min(width/w,19998/w,19998/h,(MAX_PIXELS*.98/(w*h))**.5)
            pix=p.get_pixmap(matrix=fitz.Matrix(scale,scale),colorspace=fitz.csRGB,alpha=False)
            im=Image.frombytes('RGB',(pix.width,pix.height),pix.samples);del pix,p
            fitz.TOOLS.store_shrink(100)
        else:
            with Image.open(f['path']) as src:
                src.seek(0);w,h=src.size
                # Pillow refuses maliciously large source images; never disable its safety limit.
                if edge:src.thumbnail((edge,edge),Image.Resampling.LANCZOS)
                im=ImageOps.exif_transpose(src).convert('RGBA' if 'A' in src.getbands() or 'transparency' in src.info else 'RGB')
        import io
        try:
            if thumbnail:im.thumbnail((180,240),Image.Resampling.LANCZOS)
            else:
                scale=min(1,19998/im.width,19998/im.height,(MAX_PIXELS*.98/(im.width*im.height))**.5)
                if scale<1:im.thumbnail((max(1,int(im.width*scale)),max(1,int(im.height*scale))),Image.Resampling.LANCZOS)
            for _ in range(12):
                b=io.BytesIO();im.save(b,format='PNG',compress_level=6);raw=b.getvalue()
                if len(raw)<=MAX_IMAGE:
                    self.check(f)
                    with Image.open(io.BytesIO(raw)) as check:check.verify()
                    return raw,im.width,im.height
                im.thumbnail((max(1,int(im.width*.8)),max(1,int(im.height*.8))),Image.Resampling.LANCZOS)
            raise RuntimeError('Page cannot fit 12 MiB PNG limit')
        finally:im.close()

class GitHub:
    """Ordinary Git, using existing isolated OS-managed GCM credentials."""
    def __init__(self,owner,token,env,report,wait=time.sleep):
        self.owner=owner;self.token=token;self.env=dict(env);self.report=report;self.wait=wait
        for key in ('GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_COMMON_DIR','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES','GIT_NAMESPACE','GIT_PREFIX','GIT_QUARANTINE_PATH','GIT_CONFIG'):
            self.env.pop(key,None)
    def cooldown(self,seconds,reason):
        end=time.time()+seconds;self.report(f'{reason}; waiting until {datetime.fromtimestamp(end,timezone.utc).isoformat(timespec="seconds")} UTC',end)
        self.wait(seconds);self.report('Cooldown completed; resuming',None)
    def read(self,path):
        attempt=0;secondary=0
        while True:
            try:r=requests.get('https://api.github.com'+path,headers={'Authorization':'Bearer '+self.token,'Accept':'application/vnd.github+json'},timeout=(15,60),allow_redirects=False)
            except requests.exceptions.SSLError:raise
            except (requests.ConnectionError,requests.Timeout):
                attempt+=1;require(attempt<=8,'GitHub network unavailable after 8 retries');self.cooldown(min(300,2**min(attempt,8)),'GitHub network timeout');continue
            delay=rate_delay(r,secondary)
            if delay is not None:
                secondary+=1
                self.cooldown(delay,'GitHub API rate limit');continue
            if r.status_code in (408,500,502,503,504):
                attempt+=1;require(attempt<=8,'GitHub API temporarily unavailable');self.cooldown(min(300,2**min(attempt,8)),'GitHub API unavailable');continue
            return r
    def repo_info(self,name):
        r=self.read(f'/repos/{self.owner}/{name}')
        if r.status_code==404:return None
        require(r.status_code==200,f'GitHub repository lookup HTTP {r.status_code}')
        data=r.json();require(data.get('private') and data.get('owner',{}).get('login','').casefold()==self.owner.casefold(),'GitHub repository is not private or has wrong owner');return data
    def ensure_repo(self,name,marker):
        failures=0;rate_attempt=0
        while True:
            data=self.repo_info(name)
            if data is not None:
                require(data.get('description')==marker,'Volume name already belongs to another job; refusing overwrite');return
            try:r=requests.post('https://api.github.com/user/repos',headers={'Authorization':'Bearer '+self.token,'Accept':'application/vnd.github+json'},json={'name':name,'private':True,'auto_init':False,'description':marker},timeout=(15,60),allow_redirects=False)
            except requests.exceptions.SSLError:raise
            except (requests.ConnectionError,requests.Timeout):
                failures+=1;require(failures<=8,'Repository creation network unavailable; checkpoint retained');self.cooldown(min(300,2**failures),'Repository creation response lost; checking remote');continue
            delay=rate_delay(r,rate_attempt)
            if delay is not None:
                rate_attempt+=1;self.cooldown(delay,'Repository creation rate-limited; checking remote before retry');continue
            if r.status_code==422:
                data=self.repo_info(name)
                require(data is not None and data.get('description')==marker,'GitHub rejected repository creation (HTTP 422); check repository or account limits')
                return
            if r.status_code in (201,408,500,502,503,504):
                failures+=1;require(failures<=8,'Repository creation not verified; checkpoint retained')
                if r.status_code!=201:self.cooldown(min(300,2**failures),'Checking repository creation result')
                continue
            raise RuntimeError(f'GitHub repository creation HTTP {r.status_code}; authorize private repository creation and resume')
    def git(self,args,cwd,*,binary=False,timeout=600):
        p=subprocess.run(['git','-c','credential.username='+self.owner,'-c','core.autocrlf=false','-c','core.longpaths=true',*args],cwd=cwd,env=self.env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout)
        if p.returncode:
            msg=p.stderr.decode(errors='replace')[-1800:];raise GitError(msg)
        return p.stdout if binary else p.stdout.decode(errors='replace').strip()
    def remote_head(self,url,cwd):
        return self.git(['ls-remote',url,'refs/heads/main'],cwd,timeout=120).split('\t')[0]
    def push_verified(self,repo,verify,url,commit,parent,files):
        """Reconcile ambiguous push results by remote ref; no force push, no blind replay."""
        failures=0
        for attempt in count():
            try:
                head=self.remote_head(url,repo)
                if head!=commit:
                    require(head==parent,'Remote volume branch changed; refusing to overwrite')
                    # Pace normal writes even on different volumes.
                    self.git(['push',url,commit+':refs/heads/main'],repo,timeout=1800)
                require(self.remote_head(url,repo)==commit,'Remote commit not confirmed')
                verify.mkdir(parents=True,exist_ok=True)
                if not (verify/'HEAD').exists():self.git(['init','--bare'],verify)
                # Incremental independent remote fetch, never copy local objects.
                self.git(['fetch','--no-tags',url,'refs/heads/main:refs/heads/verified'],verify,timeout=1800)
                require(self.git(['rev-parse','refs/heads/verified'],verify)==commit,'Remote verification fetched a different commit')
                for path,sha,size in files:
                    b=self.git(['show',commit+':'+path],verify,binary=True)
                    require(len(b)==size and digest(b)==sha,'Remote SHA-256 mismatch: '+path)
                return
            except (GitError,subprocess.TimeoutExpired) as e:
                msg=str(e).lower()
                if isinstance(e,GitError) and not git_throttled(msg) and not any(x in msg for x in ('timed out','timeout','connection','remote end hung up','rpc failed','http 429','rate limit','http 500','http 502','http 503','http 504','error: 429','error: 503','early eof','could not resolve host','failed to connect','unexpected disconnect')):raise
                if git_throttled(msg):
                    self.cooldown(backoff(attempt),'GitHub Git rate limit; reconciling remote branch');continue
                failures+=1
                if failures>8:raise RuntimeError('Git transfer remained unavailable after 8 non-rate retries; checkpoint retained') from e
                self.cooldown(min(300,2**failures),'Git transport interrupted; reconciling remote branch')
class GitError(RuntimeError):pass

class Site:
    def __init__(self,origin,cookie,report):self.origin=origin;self.cookie=cookie;self.report=report
    def request(self,path,method='GET',body=None,*,retry=True,raw=False):
        require(re.fullmatch(r'/api/manual-comics(?:/import-[a-f0-9]{32}(?:/(?:local-init|local-index|pages/[a-f0-9]{64}))?)?',path) is not None,'Unsafe remote API path')
        failures=0;reauthenticated=False
        for attempt in count():
            try:r=requests.request(method,self.origin+path,json=body,headers={'Origin':self.origin,'Cookie':'reader_site='+self.cookie,'Cache-Control':'no-store'},timeout=(15,90),allow_redirects=False)
            except requests.exceptions.SSLError:raise
            except (requests.ConnectionError,requests.Timeout):
                failures+=1
                if not retry or failures>8:raise
                self.report('Metadata connection interrupted; waiting before retry',None);time.sleep(min(300,2**failures));continue
            # PUT publication is revision-guarded; caller reconciles a lost receipt.
            if r.ok:
                renewed=r.cookies.get('reader_site')
                if renewed and renewed!=self.cookie:
                    from . import open_reader_verify_auth as auth
                    auth._save(self.origin,renewed);self.cookie=renewed
            if raw:return r
            if r.ok:
                try:return r.json()
                except ValueError:raise RuntimeError('Reader returned invalid metadata')
            if r.status_code==401 and retry and not reauthenticated:
                from . import open_reader_verify_auth as auth
                self.report('Reader session expired; authenticate in the uploader terminal',None);self.cookie=auth._exchange_password(self.origin);reauthenticated=True;continue
            if r.status_code==429 and retry:
                delay=rate_delay(r,attempt) or 60;self.report('Reader metadata throttled; waiting',time.time()+delay);time.sleep(delay);continue
            if r.status_code in (408,500,502,503,504) and retry and method in ('GET','POST') and not (r.status_code==502 and path.endswith('/local-index')):
                failures+=1
                if failures<=8:
                    self.report('Reader metadata temporarily unavailable; waiting before retry',None);time.sleep(min(300,2**failures));continue
            try:message=r.json().get('error','')
            except ValueError:message=''
            raise SiteError(r.status_code,message or 'Reader metadata request failed')
        raise RuntimeError('Reader metadata unavailable')
class SiteError(RuntimeError):
    def __init__(self,status,message):super().__init__(f'HTTP {status}: {message}');self.status=status

class UploadJob:
    def __init__(self,root,journal,github,site,report,*,batch=BATCH,volume=VOLUME):
        self.root=Path(root);self.journal=journal;self.github=github;self.site=site;self.report=report;self.batch=batch;self.volume=volume
    def save(self,j):self.journal.put(j)
    def allocate(self,j,w):
        # Select a fresh volume, never adopt another job's repository.
        marker=f'Open Reader local import {j["id"]} {w["slug"]}'
        for n in range(w.get('next_volume',1),1000):
            name=w['slug']+f'-vol-{n:03d}'
            data=self.github.repo_info(name)
            if data is None:
                w['volume']={'n':n,'name':name,'bytes':0,'marker':marker,'parent':''};w['next_volume']=n+1;self.save(j);return w['volume']
        raise RuntimeError('Archive volume namespace exhausted')
    def flush(self,j,w):
        pending=w.get('pending',[])
        if not pending:return
        v=w['volume'];name=v['name'];folder=self.root/j['id']/name;repo=folder/'repo';verify=folder/'verify';repo.mkdir(parents=True,exist_ok=True)
        self.github.ensure_repo(name,v['marker']);url=f'https://github.com/{self.github.owner}/{name}.git'
        if not (repo/'.git').exists():
            require(not v['parent'],'Local volume repository missing; restore checkpoint directory')
            self.github.git(['init','-b','main'],repo)
        if not w.get('commit'):
            idx={'slug':w['slug'],'volume':v['n'],'pages':list({p['sha']:{k:p[k] for k in ('sha','width','height','size')} for p in pending}.values())}
            b=encode(idx);idxsha=digest(b);index='indexes/'+idxsha+'.json';atomic(repo/index,b)
            paths=[]
            for p in pending:
                dest='pages/'+p['sha']+'.png';src=self.root/j['id']/'spool'/p['sha']
                require(src.is_file() and src.stat().st_size==p['size'],'Missing local staged page')
                if dest not in paths:
                    raw=src.read_bytes();require(digest(raw)==p['sha'],'Local staged page checksum mismatch: '+p['sha']);atomic(repo/dest,raw);paths.append(dest)
            paths.append(index)
            self.github.git(['add','--',*paths],repo)
            # A crash after commit but before checkpoint: inspect HEAD and index.
            try:head=self.github.git(['rev-parse','HEAD'],repo)
            except GitError:head=''
            if head and head!=v['parent']:
                parent_line=self.github.git(['rev-list','--parents','-n','1',head],repo).split()
                require((parent_line[1] if len(parent_line)>1 else '')==v['parent'],'Unexpected local commit after interrupted batch')
                require(self.github.git(['show',head+':'+index],repo,binary=True)==b,'Interrupted local commit index differs')
                commit=head
            elif head and not self.github.git(['diff','--cached','--name-only'],repo):
                # Identical repeated pages/index: reuse the current commit.
                commit=head
            else:
                self.github.git(['-c','user.name=Open Reader Import','-c','user.email=open-reader-import@users.noreply.github.com','commit','-m','Add verified import batch '+idxsha[:16]],repo)
                commit=self.github.git(['rev-parse','HEAD'],repo)
            w['commit']={'sha':commit,'index':idxsha,'index_size':len(b)};self.save(j)
        c=w['commit'];files=list({p['sha']:('pages/'+p['sha']+'.png',p['sha'],p['size']) for p in pending}.values());files.append(('indexes/'+c['index']+'.json',c['index'],c['index_size']))
        self.report('Pushing and independently verifying '+name,None)
        self.github.push_verified(repo,verify,url,c['sha'],v['parent'],files)
        # Persist proof before touching Cloudflare; if registration fails, resume
        # verifies the existing commit instead of pushing it again.
        w['remote_verified']=True;self.save(j)
        self.site.request('/api/manual-comics/'+w['slug']+'/local-index','POST',{'owner':self.github.owner,'revision':w['revision'],'volume':v['n'],'index':c['index']})
        for p in pending:w['completed'][p['ordinal']]=p['sha']
        v['bytes']+=sum(p['size'] for p in pending)+c['index_size'];v['parent']=c['sha'];w['pending']=[];w.pop('commit',None);w.pop('remote_verified',None);self.save(j)
        # Only after Git readback AND durable registration/checkpoint.
        for p in pending:
            for file in (self.root/j['id']/'spool'/p['sha'],repo/'pages'/(p['sha']+'.png')):
                try:file.unlink(missing_ok=True)
                except OSError as exc:self.report('Verified page cleanup deferred: '+type(exc).__name__,None)
        self.report('Verified batch and registered metadata',None)
        self.github.wait(16) # no high-frequency push burst
    def run(self,j):
        require(j['owner'].casefold()==self.github.owner.casefold(),'Job belongs to another GitHub account')
        renderer=Renderer()
        try:
            for w in j['works']:
                if w.get('published'):continue
                endpoint='/api/manual-comics/'+w['slug']
                if not w.get('initialized'):
                    receipt=self.site.request(endpoint+'/local-init','POST',{'owner':self.github.owner,'metadata':w['metadata']})
                    require(receipt['revision']==w['revision'],'Import revision changed before upload');w['initialized']=True;self.save(j)
                if w.get('pending'):self.flush(j,w)
                for i,p in enumerate(w['flat']):
                    if w['completed'][i]:continue
                    f=j['sources'][p['source']]
                    self.report(f"{w['metadata']['title']} — rendering page {i+1}/{len(w['flat'])}",None)
                    b,width,height=renderer.render(f,p['page'],j['pdf_width'],j['image_limit']);sha=digest(b)
                    if not w.get('volume'):self.allocate(j,w)
                    v=w['volume'];pending=w.get('pending',[])
                    if pending and (sum(x['size'] for x in pending)+len(b)>self.batch or len(pending)>=100 or v['bytes']+sum(x['size'] for x in pending)+len(b)+128*1024>self.volume):self.flush(j,w)
                    if v['bytes']+len(b)+128*1024>self.volume:
                        old=self.root/j['id']/v['name'];w.pop('volume');self.save(j);shutil.rmtree(old,ignore_errors=True);v=self.allocate(j,w)
                    require(len(b)+128*1024<=self.volume,'Page exceeds volume size')
                    atomic(self.root/j['id']/'spool'/sha,b)
                    w.setdefault('pending',[]).append({'ordinal':i,'sha':sha,'width':width,'height':height,'size':len(b)});self.save(j);del b
                self.flush(j,w)
                ch=[];offset=0
                for c in w['chapters']:
                    n=c['count'];ch.append({'id':c['id'],'number':c['number'],'title':c['title'],'pages':w['completed'][offset:offset+n]});offset+=n
                require(offset==len(w['completed']) and all(w['completed']),'Incomplete local pages')
                body={'revision':w['revision'],'metadata':w['metadata'],'chapters':ch}
                # Recover an ambiguous successful publish; never overwrite edits.
                current=self.site.request(endpoint)
                if not (current['revision']==w['revision']+1 and current['publication']=='published' and current['metadata']==w['metadata'] and current['chapters']==ch):
                    require(current['revision']==w['revision'],'Comic changed during upload; reopen and review')
                    try:self.site.request(endpoint,'PUT',body)
                    except (SiteError,requests.ConnectionError,requests.Timeout):
                        current=self.site.request(endpoint)
                        if not (current['revision']==w['revision']+1 and current['publication']=='published' and current['metadata']==w['metadata'] and current['chapters']==ch):raise
                w['published']=True;self.save(j)
                if w.get('volume'):shutil.rmtree(self.root/j['id']/w['volume']['name'],ignore_errors=True)
            j['finished']=True;self.save(j);self.report('All comics uploaded, independently verified and published',None)
        finally:renderer.close()

class Companion:
    def __init__(self,origin,site,github,base=BASE):
        self.origin=origin;self.site=site;self.github=github;self.base=Path(base);self.journal=Journal(self.base/'job.sqlite');self.sources={};self.lock=threading.RLock();self.render_lock=threading.Lock();self.preview=Renderer();self.thread=None;self.status={'message':'Ready','wake':None};self.key=secrets.token_urlsafe(32)
        self.github.report=self.site.report=self.report
    def report(self,message,wake=None):
        with self.lock:self.status={'message':message,'wake':wake}
        print(message,flush=True)
    def snapshot(self):
        with self.lock:
            j=self.journal.get();running=bool(self.thread and self.thread.is_alive());done=total=0
            if j:
                total=sum(len(w['flat']) for w in j['works']);done=sum(sum(bool(s) for s in w['completed']) for w in j['works'])
            return {**self.status,'running':running,'job':bool(j),'finished':bool(j and j.get('finished')),'done':done,'total':total}
    def pick(self):
        # Native path selection avoids File.arrayBuffer(), HTTP bodies, or copying huge PDFs.
        with self.render_lock:
            # Tk interpreters must be created and destroyed on their owning main
            # thread. The HTTP handler is a worker thread; isolate the native UI.
            picker = """import json,sys,tkinter as tk
from tkinter import filedialog
root=tk.Tk()
try:
    root.withdraw();root.attributes('-topmost',True)
    paths=filedialog.askopenfilenames(parent=root,title='Select images and PDFs',filetypes=[('PDF and image files','*.pdf *.png *.jpg *.jpeg *.webp *.gif *.bmp *.tiff *.tif *.avif *.heic *.heif *.svg *.ico *.jp2 *.jxl *.jfif *.apng'),('All files','*.*')])
    sys.stdout.buffer.write(json.dumps(list(paths),ensure_ascii=False).encode('utf-8'))
finally:root.destroy()
"""
            process=subprocess.run([sys.executable,'-c',picker],capture_output=True,check=False)
            require(process.returncode==0,'Native file picker failed: '+process.stderr.decode('utf-8','replace')[-500:])
            paths=json.loads(process.stdout.decode('utf-8'));require(isinstance(paths,list) and all(isinstance(path,str) for path in paths),'Invalid file picker result')
            selected=[]
            try:
                for path in paths:
                    f=self.preview.probe(path);self.sources[f['id']]=f;selected.append({k:f[k] for k in ('id','name','size','type','count')})
            finally:self.preview.close()
            return selected
    def thumbnail(self,source,page):
        with self.render_lock:
            f=self.sources.get(source);require(f is not None,'Unknown local source')
            try:return self.preview.render(f,page,180,240,True)[0]
            finally:self.preview.close()
    def prepare(self,body):
        require(body.get('rights') is True,'Rights confirmation is required')
        width=body.get('pdf_width');edge=body.get('image_limit');require(type(width) is int and 600<=width<=4000 and type(edge) is int and 0<=edge<=20000,'Invalid render settings')
        works=body.get('works');require(isinstance(works,list) and 0<len(works)<=200,'Invalid comic count')
        sources={};out=[];slugs=set()
        for w in works:
            m=w.get('metadata');require(isinstance(m,dict),'Missing metadata');limits={'title':240,'author':240,'description':4000,'language':80,'status':80};metadata={}
            for k,maxlen in limits.items():
                value=m.get(k,'');require(isinstance(value,str) and len(value.strip())<=maxlen and (k!='title' or bool(value.strip())),'Invalid metadata: '+k);metadata[k]=value.strip()
            old=w.get('slug');slug=old or 'import-'+uuid.uuid4().hex;rev=w.get('revision',0)
            require(isinstance(slug,str) and SLUG.fullmatch(slug) and slug not in slugs and type(rev) is int and rev>=0,'Invalid import identity');slugs.add(slug)
            if old:
                current=self.site.request('/api/manual-comics/'+slug);require(current['revision']==rev,'Import changed; reopen it');existing={p['sha'] for p in current['pages']}
            else:existing=set()
            chapters=w.get('chapters');require(isinstance(chapters,list) and len(chapters)>0,'Empty comic');ids=set();flat=[];completed=[];ch=[]
            for c in chapters:
                cid=c.get('id');title=c.get('title');num=c.get('number');ps=c.get('pages')
                require(isinstance(cid,str) and CID.fullmatch(cid) and cid not in ids and isinstance(title,str) and 0<len(title.strip())<=320 and isinstance(num,str) and 0<len(num.strip())<=80 and isinstance(ps,list) and len(ps)>0,'Invalid chapter');ids.add(cid)
                ch.append({'id':cid,'number':num.strip(),'title':title.strip(),'count':len(ps)})
                for p in ps:
                    require(isinstance(p,dict),'Invalid page reference')
                    sha=p.get('sha')
                    if sha:
                        require(sha in existing,'Unknown existing page');flat.append({});completed.append(sha);continue
                    f=self.sources.get(p.get('source'));page=p.get('page');require(f is not None and type(page) is int and 0<=page<f['count'],'Unknown local page');Renderer.check(f);sources[f['id']]=f;flat.append({'source':f['id'],'page':page});completed.append(None)
                require(len(flat)<=LIMIT,'Maximum 2,000 pages per comic (PDF byte size is unrestricted)')
            # Test exact eventual payload size before rendering anything.
            require(len(encode({'revision':rev,'metadata':metadata,'chapters':[{'id':c['id'],'number':c['number'],'title':c['title'],'pages':['0'*64]*c['count']} for c in ch]}))<=512*1024,'Chapter metadata exceeds current reader manifest limit')
            out.append({'slug':slug,'revision':rev,'metadata':metadata,'chapters':ch,'flat':flat,'completed':completed,'pending':[]})
        return {'id':uuid.uuid4().hex,'owner':self.github.owner,'sources':sources,'works':out,'pdf_width':width,'image_limit':edge,'finished':False}
    def start(self,body=None):
        with self.lock:
            require(not (self.thread and self.thread.is_alive()),'An import is already running')
            j=self.journal.get()
            if body is not None:
                require(not j or j.get('finished'),'An unfinished job exists. Resume it first.');j=self.prepare(body);self.journal.put(j)
            else:require(j and not j.get('finished'),'No unfinished job')
            def run():
                try:UploadJob(self.base,self.journal,self.github,self.site,self.report).run(j)
                except Exception as e:self.report('Paused: '+str(e),None)
            self.thread=threading.Thread(target=run,daemon=True,name='local-import');self.thread.start()
            return {'ok':True}

class Handler(BaseHTTPRequestHandler):
    server_version='OpenReaderLocal/1.0'
    def log_message(self,*args):pass # never log the bootstrap key, path names or session cookies
    @property
    def app(self):return self.server.app
    def send(self,status,body=b'',mime='application/json; charset=utf-8',headers=None):
        self.send_response(status);self.send_header('Content-Type',mime);self.send_header('Content-Length',str(len(body)));self.send_header('Cache-Control','no-store');self.send_header('Referrer-Policy','no-referrer');self.send_header('X-Content-Type-Options','nosniff');self.send_header('X-Frame-Options','DENY');self.send_header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        for k,v in (headers or {}).items():self.send_header(k,v)
        self.end_headers();self.wfile.write(body)
    def body(self):
        length=int(self.headers.get('Content-Length','0'));require(0<length<=4*MIB,'Metadata body too large or missing');require(self.headers.get('Content-Type','').split(';')[0]=='application/json','JSON metadata required');return json.loads(self.rfile.read(length))
    def dispatch(self):
        host=f'127.0.0.1:{PORT}';origin='http://'+host;u=urlsplit(self.path);path=u.path
        if self.headers.get('Host')!=host:return self.send(403,encode({'error':'Invalid loopback host'}))
        if path=='/bootstrap' and self.command=='GET' and secrets.compare_digest(parse_qs(u.query).get('key',[''])[0],self.app.key):
            return self.send(303,headers={'Location':'/add-comic/','Set-Cookie':f'or_local={self.app.key}; HttpOnly; SameSite=Strict; Path=/'})
        cookie=dict(x.strip().split('=',1) for x in self.headers.get('Cookie','').split(';') if '=' in x)
        if not secrets.compare_digest(cookie.get('or_local',''),self.app.key):return self.send(403,b'Launch the local uploader from your terminal. Its authenticated tab will open automatically.','text/plain; charset=utf-8')
        if self.command!='GET' and self.headers.get('Origin')!=origin:return self.send(403,encode({'error':'Same-origin local session required'}))
        if self.command=='GET':
            if path=='/' or re.fullmatch(r'/comics/import-[a-f0-9]{32}/overview/',path):return self.send(303,headers={'Location':self.app.origin+path})
            assets={'/add-comic/':('manual_import.html','text/html; charset=utf-8'),'/manual-import.js':('manual_import.js','application/javascript; charset=utf-8'),'/manual-import.css':('manual_import.css','text/css; charset=utf-8'),'/comic-landing.css':('comic_landing.css','text/css; charset=utf-8')}
            if path in assets:
                file,mime=assets[path];return self.send(200,(ROOT/'reusable'/file).read_bytes(),mime)
            if path=='/local/status':return self.send(200,encode(self.app.snapshot()))
            m=re.fullmatch(r'/local/preview/([a-f0-9]{32})/([0-9]+)',path)
            if m:return self.send(200,self.app.thumbnail(m[1],int(m[2])),'image/png')
        if self.command=='POST':
            if path=='/local/pick':return self.send(200,encode({'files':self.app.pick()}))
            if path=='/local/start':return self.send(202,encode(self.app.start(self.body())))
            if path=='/local/resume':return self.send(202,encode(self.app.start()))
        # Preserve existing edit/delete and reading thumbnails; never proxy bulk bytes.
        m=re.fullmatch(r'/api/manual-comics(?:/import-[a-f0-9]{32}(?:/pages/[a-f0-9]{64})?)?',path)
        if m and self.command in ('GET','PUT','DELETE'):
            if self.command!='GET' and (path=='/api/manual-comics' or '/pages/' in path):return self.send(405)
            r=self.app.site.request(path,self.command,self.body() if self.command!='GET' else None,retry=False,raw=True)
            return self.send(r.status_code,r.content,r.headers.get('Content-Type','application/json; charset=utf-8'))
        return self.send(404,encode({'error':'Unknown local route'}))
    def do_GET(self):self.handle_safe()
    def do_POST(self):self.handle_safe()
    def do_PUT(self):self.handle_safe()
    def do_DELETE(self):self.handle_safe()
    def handle_safe(self):
        try:self.dispatch()
        except (BrokenPipeError,ConnectionResetError):pass
        except Exception as e:
            with contextlib.suppress(BrokenPipeError,ConnectionResetError):self.send(400,encode({'error':str(e)}))

def credentials():
    # Use the same shared GCM namespace as normal run.py; no credentials in
    # command arguments, repository URLs, job DB, browser or global Git config.
    from . import engine
    shared=engine._shared_github_auth_metadata()
    require(shared is not None,'Run python run.py --github-login to select your GitHub account first.')
    owner,namespace=shared;env=engine.isolated_git_environment();env['GCM_NAMESPACE']=namespace
    p=subprocess.run(['git','credential','fill'],input=f'protocol=https\nhost=github.com\nusername={owner}\n\n',text=True,env=env,capture_output=True,timeout=120)
    require(p.returncode==0,'Saved GitHub login unavailable; run python run.py --github-login')
    token=dict(line.split('=',1) for line in p.stdout.splitlines() if '=' in line).get('password');require(bool(token),'Missing GitHub credential')
    gh=GitHub(owner,token,env,lambda msg,wake=None:print(msg,flush=True));r=gh.read('/user');require(r.status_code==200 and r.json().get('login','').casefold()==owner.casefold(),'GitHub identity mismatch');return gh

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--origin',default=ORIGIN);args=parser.parse_args()
    from . import open_reader_verify_auth as auth
    origin=auth._safe_origin(args.origin);require(origin is not None,'Expected the configured Open Reader HTTPS Worker origin')
    github=credentials();cookie=auth._load(origin) or auth._exchange_password(origin)
    site=Site(origin,cookie,lambda *a:None)
    try:config=site.request('/api/manual-comics',retry=False)
    except SiteError as e:
        if e.status!=401:raise
        site.cookie=auth._exchange_password(origin);config=site.request('/api/manual-comics',retry=False)
    require(config.get('ready') and config.get('local_upload') and config.get('owner','').casefold()==github.owner.casefold(),'Deploy final Add Comic patch first and use the GitHub account configured for the reader')
    # Normalize case to the exact configured owner, while GitHub identity above is verified.
    github.owner=config['owner'];app=Companion(origin,site,github);server=ThreadingHTTPServer(('127.0.0.1',PORT),Handler);server.app=app
    print('Local Add Comic companion ready. Keep this terminal open. Existing unfinished jobs can be resumed from the page.',flush=True)
    webbrowser.open(f'http://127.0.0.1:{PORT}/bootstrap?key={app.key}')
    try:server.serve_forever()
    except KeyboardInterrupt:print('Stopped. Durable upload checkpoint retained.',flush=True)
    finally:
        server.server_close()
        if app.render_lock.acquire(blocking=False):
            try:app.preview.close()
            finally:app.render_lock.release()
if __name__=='__main__':main()
