import tempfile,unittest,hashlib,io
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from PIL import Image
from reusable.chapter_script import acquire,enabled,_validate_plan,_token,_receipt_path,_import
from reusable.image_checkpoint import ChapterImageCheckpoint

class NativeChapterTests(unittest.TestCase):
    def test_resume_and_real_format(self):
        url='https://reader.example.test/chapter/9/'
        items=[{'key':str(i),'order':i,'url':f'https://images.example.test/{i}.jpg','filename':f'{i:04d}.jpg','width':10,'height':15} for i in range(1,26)]
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);stage=root/'stage';stage.mkdir();cp=ChapterImageCheckpoint(stage,'9',url)
            for item in items[:14]:
                path=stage/f"{item['order']:04d}.png";Image.new('RGB',(10,15)).save(path);raw=path.read_bytes()
                cp.record_image(item['key'],item['order'],item['url'],path,{'source_url':item['url'],'sha256':hashlib.sha256(raw).hexdigest(),'bytes':len(raw),'width':10,'height':15,'format':'png'})
            started=[];actions=[]
            def rpc(action,payload,timeout):
                actions.append(action)
                if action=='script_scroll':return {'url':url,'height':1000,'count':25,'loaded':25,'atBottom':True}
                if action=='script_plan':return {'url':url,'items':items,'loaded':25}
                if action=='script_download_start':
                    for item in payload['items']:
                        started.append(item['order']);p=root/'ComicArchiver-script'/payload['token']/item['filename'];p.parent.mkdir(parents=True,exist_ok=True);Image.new('RGB',(10,15)).save(p,format='WEBP')
                    return {'started':True}
                if action=='script_download_status':
                    return {'receipts':[{'key':x['key'],'url':x['url'],'filename':x['filename'],'state':'complete','path':str(root/'ComicArchiver-script'/payload['token']/x['filename'])} for x in payload['items']]}
                raise AssertionError(action)
            bridge=SimpleNamespace(allowed_site='reader.example.test',allowed_cdn={'images.example.test'},validate_image=lambda x:x,rpc=rpc)
            page=SimpleNamespace(context=SimpleNamespace(bridge=bridge),content=lambda:'html');adapter=SimpleNamespace(CHAPTER_DOWNLOAD_JS='(()=>{})()',READER_SELECTORS=['.reader'],script_download_expected=lambda *_:[(x['key'],x['url']) for x in items]);chapter=SimpleNamespace(url=url,chapter_id='9');config={'page_scan_steps':10,'page_scan_stability_steps':2,'max_pages_per_chapter':500,'github_max_file_bytes':1000000}
            with patch('reusable.chapter_script.time.sleep'):
                files,manifest=acquire(page,chapter,stage,adapter,config,None,lambda *a,**k:None,lambda:'now','Chapter 9')
                self.assertEqual(started,list(range(15,26)));self.assertEqual([p.name for p in files],[f'{i:04d}.png' if i<=14 else f'{i:04d}.webp' for i in range(1,26)])
                self.assertEqual([x['order'] for x in manifest['images']],list(range(1,26)))
                files2,manifest2=acquire(page,chapter,stage,adapter,config,None,lambda *a,**k:None,lambda:'now','Chapter 9')
                self.assertEqual(files,files2);self.assertEqual(started,list(range(15,26)))
                self.assertEqual(manifest,manifest2)
            self.assertNotIn('recover_image',actions);self.assertNotIn('image',actions)
    def test_native_renamed_file_import(self):
        token='a'*32; url='https://reader.example.test/chapter/9/'
        item={'key':'15','order':15,'url':'https://images.example.test/15.jpg','filename':'0015.jpg','width':10,'height':15}
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); stage=root/'stage';stage.mkdir()
            cp=ChapterImageCheckpoint(stage,'9',url)
            managed=root/'ComicArchiver-script'/token/'server.webp';managed.parent.mkdir(parents=True)
            Image.new('RGB',(10,15)).save(managed,format='WEBP')
            rec={'key':'15','url':item['url'],'filename':item['filename'],'state':'complete','id':15,'idBound':True,'extensionOwned':True,'path':str(managed),'fileSize':managed.stat().st_size}
            with self.assertRaisesRegex(RuntimeError,'trusted native download ID'):
                _receipt_path({**rec,'idBound':False},item,token)
            with self.assertRaisesRegex(RuntimeError,'file size differs'):
                _receipt_path({**rec,'fileSize':0},item,token)
            path,meta=_import(rec,item,token,stage,cp,1000000)
            self.assertEqual(path.name,'0015.webp');self.assertEqual(meta['order'],15);self.assertFalse(managed.exists())
            external=root/'original browser name.webp';Image.new('RGB',(10,15)).save(external,format='WEBP')
            rec={**rec,'path':str(external),'fileSize':external.stat().st_size}
            with self.assertRaisesRegex(RuntimeError,'trusted native download ID'):
                _receipt_path({**rec,'extensionOwned':False},item,token)
            path,meta=_import(rec,item,token,stage,cp,1000000)
            self.assertEqual(path.name,'0015.webp');self.assertTrue(external.exists())
            with self.assertRaisesRegex(RuntimeError,'mismatched native download receipt'):
                _receipt_path({**rec,'url':'https://images.example.test/other.jpg'},item,token)
    def test_permanent_contract(self):
        from site_specific import site_adapter
        from reusable import chapter_script
        marker='PERMANENT ADAPTER CONTRACT: KEEP THIS COMMENT IN EVERY FUTURE ADAPTER'
        for module in (chapter_script, site_adapter):
            text=Path(module.__file__).read_text(encoding='utf-8')
            self.assertIn(marker,text)
            self.assertIn('PERMANENT CORS WARNING',text)
            self.assertIn('Access-Control-Allow-Origin',text)
    def test_reject_bad_plan(self):
        bridge=SimpleNamespace(allowed_site='reader.example.test',allowed_cdn={'images.example.test'},validate_image=lambda x:x)
        url='https://reader.example.test/chapter/1';item={'key':'1','order':1,'url':'https://images.example.test/1.jpg','filename':'0001.jpg'}
        self.assertEqual(_validate_plan({'url':url,'items':[item]},url,bridge,500),[item])
        for bad in ({**item,'filename':'0002.jpg'},{**item,'url':'https://wrong.example.test/a.jpg'},{**item,'key':'2'}):
            with self.assertRaises(RuntimeError):_validate_plan({'url':url,'items':[bad]},url,bridge,500)
        self.assertFalse(enabled(SimpleNamespace()));self.assertTrue(enabled(SimpleNamespace(CHAPTER_DOWNLOAD_JS='test')))
if __name__=='__main__':unittest.main()
