import base64, hashlib, io, tempfile, unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from PIL import Image, UnidentifiedImageError
from reusable.chapter_script import acquire
from reusable.image_checkpoint import ChapterImageCheckpoint
from reusable.source_session import SourceAccessPaused

class ResourceMode(unittest.TestCase):
    def run_case(self, failure=None):
        url='https://reader.example.test/chapter/9/'
        items=[dict(key=str(i),order=i,url=f'https://images.example.test/{i}.jpg',filename=f'{i:04}.jpg',width=10,height=15) for i in range(1,26)]
        data=io.BytesIO();Image.new('RGB',(10,15)).save(data,format='WEBP');raw=data.getvalue()
        actions=[];positions=[];seen=set()
        with tempfile.TemporaryDirectory() as d:
            stage=Path(d);cp=ChapterImageCheckpoint(stage,'9',url)
            for x in items[:14]:
                path=stage/f"{x['order']:04}.webp";path.write_bytes(raw)
                cp.record_image(x['key'],x['order'],x['url'],path,dict(source_url=x['url'],sha256=hashlib.sha256(raw).hexdigest(),bytes=len(raw),width=10,height=15,format='webp'))
            def rpc(action,payload,timeout):
                actions.append(action)
                if action=='script_resource_prepare':return {'ready':True}
                if action=='script_scroll':return dict(url=url,height=1000,count=25,loaded=11,atBottom=True)
                if action=='script_plan':return dict(url=url,items=items,loaded=11)
                x=payload['items'][0];r=dict(key=x['key'],url=x['url'])
                self.assertGreater(x['order'],14)
                if action=='script_resource_position':positions.append(x['order']);return {'positioned':True}
                if action!='script_resource_read':raise AssertionError(action)
                if failure=='denied':return {**r,'state':'denied','status':403}
                if failure=='wrong':return {**r,'key':'99','state':'complete','base64':base64.b64encode(raw).decode()}
                if failure=='html':return {**r,'state':'complete','base64':base64.b64encode(b'<html>unavailable</html>').decode()}
                if x['order']==15 and 15 not in seen:seen.add(15);return {**r,'state':'pending'}
                return {**r,'state':'complete','base64':base64.b64encode(raw).decode(),'width':10,'height':15}
            bridge=SimpleNamespace(allowed_site='reader.example.test',allowed_cdn={'images.example.test'},validate_image=lambda x:x,rpc=rpc)
            page=SimpleNamespace(context=SimpleNamespace(bridge=bridge),content=lambda:'html');adapter=SimpleNamespace(CHAPTER_DOWNLOAD_JS='(()=>{})()',CHAPTER_DOWNLOAD_TRANSPORT='loaded-resource',READER_SELECTORS=['.reader'],IMAGE_ATTRIBUTES=['src'],script_download_expected=lambda *_:[(x['key'],x['url']) for x in items]);chapter=SimpleNamespace(url=url,chapter_id='9');config={'page_scan_steps':10,'page_scan_stability_steps':2,'max_pages_per_chapter':500,'github_max_file_bytes':1000000}
            with patch('reusable.chapter_script.time.sleep'):
                if failure:
                    cls={'denied':SourceAccessPaused,'wrong':RuntimeError,'html':UnidentifiedImageError}[failure]
                    with self.assertRaises(cls):acquire(page,chapter,stage,adapter,config,None,lambda *a,**k:None,lambda:'now','Chapter 9')
                    self.assertEqual(len(ChapterImageCheckpoint(stage,'9',url).data['images']),14)
                else:
                    files,manifest=acquire(page,chapter,stage,adapter,config,None,lambda *a,**k:None,lambda:'now','Chapter 9')
                    self.assertEqual([p.name for p in files],[f'{i:04}.webp' for i in range(1,26)])
                    self.assertEqual([x['order'] for x in manifest['images']],list(range(1,26)))
                    self.assertEqual(positions,[15]);self.assertEqual(len(ChapterImageCheckpoint(stage,'9',url).data['images']),25)
                    acquire(page,chapter,stage,adapter,config,None,lambda *a,**k:None,lambda:'now','Chapter 9')
                    self.assertEqual(actions.count('script_resource_read'),12)
            self.assertNotIn('script_download_start',actions);self.assertNotIn('image',actions);self.assertNotIn('recover_image',actions)
    def test_resume_all_25(self):self.run_case()
    def test_server_denied(self):self.run_case('denied')
    def test_wrong_receipt(self):self.run_case('wrong')
    def test_html_rejected(self):self.run_case('html')
