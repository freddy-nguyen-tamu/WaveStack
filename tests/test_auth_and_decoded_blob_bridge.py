"""Generic GCM credential reuse and exact browser-decoded image transfer regressions."""
import base64
import io
import unittest
from unittest.mock import patch
from types import SimpleNamespace
from PIL import Image
from reusable import engine
from reusable.browser_bridge import BrowserResponse
from site_specific import site_adapter as adapter

CHAPTER = 'a2524342-07a7-4b9d-998d-c1ac081f7b3c'
URL = f'https://mangadex.org/chapter/{CHAPTER}/2'

def png():
    b=io.BytesIO(); Image.new('RGB',(40,50),(17,25,50)).save(b,format='PNG');return b.getvalue()

class BrowserBlobTransferTests(unittest.TestCase):
    def setUp(self):
        self.names=tuple(f'x{i}-abc{i}.png' for i in range(1,11))
        self.remote=tuple(f'https://uploads.mangadex.org/data/abc/{n}' for n in self.names)
        self.blobs=tuple(f'blob:https://mangadex.org/{i:04d}' for i in range(1,11))
        self.payload=png()
        self.session=SimpleNamespace()
        self.calls=[]
        self.session.rpc=self.rpc
        self.request=SimpleNamespace(reuses_loaded_page_images=False)
        self.ctx=SimpleNamespace(bridge=self.session, request=self.request)
        self.page=SimpleNamespace(url=URL,context=self.ctx)
        self.page.evaluate=lambda _: {'imgs':[{'key':str(i+1), 'url':self.blobs[i], 'loaded':True,'width':40,'height':50,'pageY':i*50} for i in range(10)],
            'total':10,'readerCount':10,'unloadedSlots':0,'scrollY':0,'bottom':0,'height':1000,'viewportHeight':500}
        self.page.content=lambda: '<div class="md--reader-pages">'+''.join(f'<img src="{b}" alt="{n}">' for n,b in zip(self.names,self.blobs))+'</div>'
        adapter._DOM.pop(CHAPTER,None)
        adapter._DECODED_BLOBS.pop(CHAPTER,None)

    def rpc(self, action, payload, timeout=0):
        self.calls.append((action,payload))
        self.assertEqual(action,'read_loaded_blob')
        self.assertEqual(tuple(payload['reader_selectors']),adapter.READER_SELECTORS)
        self.assertIn(payload['url'],self.blobs)
        return {'status':200, 'base64':base64.b64encode(self.payload).decode(), 'headers':{'content-type':'image/png'}}

    def test_every_one_of_ten_decoded_images_matches_its_verified_position(self):
        with patch.object(adapter,'_at_home',return_value=(self.names,self.remote)), \
             patch.object(adapter,'_http_image_get',side_effect=AssertionError('Do not re-request CDN when decoded blob is ready')):
            adapter.after_chapter_visit(self.page,URL)
            info=adapter.custom_page_snapshot(self.page)
            self.assertEqual([item['url'] for item in info['imgs']],list(self.remote))
            self.assertEqual(info['total'],10)
            for url in self.remote:
                resp=self.request.get(url)
                self.assertIsInstance(resp,BrowserResponse)
                self.assertEqual(resp.body(),self.payload)
                self.assertEqual(resp.capture_method,'decoded-source-tab-blob')
        self.assertEqual([p['url'] for _,p in self.calls],list(self.blobs))

    def test_second_chapter_rebinds_image_transfer_in_same_browser_context(self):
        next_id='b2524342-07a7-4b9d-998d-c1ac081f7b3c'
        next_url=f'https://mangadex.org/chapter/{next_id}'
        original_get=getattr(self.request,'get',None)
        with patch.object(adapter,'_at_home',return_value=(self.names,self.remote)):
            adapter.after_chapter_visit(self.page,URL)
            first_get=self.request.get
            self.assertIsNot(first_get,original_get)
            self.page.url=next_url
            adapter.after_chapter_visit(self.page,next_url)
            self.assertIsNot(self.request.get,first_get)
            # The second chapter can collect all panels, not just the first one.
            adapter.custom_page_snapshot(self.page)
            for url in self.remote:
                self.assertEqual(self.request.get(url).body(),self.payload)
        self.assertEqual(len(self.calls),10)

    def test_exact_http_path_remains_fallback_for_unavailable_blob(self):
        self.session.rpc=lambda *args, **kwargs: {'status':424,'reason':'browser blob already freed'}
        with patch.object(adapter,'_at_home',return_value=(self.names,self.remote)), \
             patch.object(adapter,'_http_image_get',return_value=BrowserResponse(self.remote[0],200,{},self.payload,'api-at-home')) as get_http:
            adapter.after_chapter_visit(self.page,URL)
            adapter.custom_page_snapshot(self.page)
            r=self.request.get(self.remote[0])
            self.assertEqual(r.capture_method,'api-at-home')
            get_http.assert_called_once()

    def test_unknown_remote_image_is_rejected_not_guessed(self):
        with patch.object(adapter,'_at_home',return_value=(self.names,self.remote)):
            adapter.after_chapter_visit(self.page,URL)
            with self.assertRaisesRegex(RuntimeError,'not in current MangaDex chapter manifest'):
                self.request.get('https://evil.invalid/abc.png')

class GcmReuseTests(unittest.TestCase):
    def test_child_git_uses_existing_namespace_and_never_auto_authenticates(self):
        with patch.object(engine,'_shared_github_auth_metadata',return_value=('avchatbot1-commits','comic-archiver-browser-existing')):
            env=engine.isolated_git_environment()
        self.assertEqual(env['GCM_NAMESPACE'],'comic-archiver-browser-existing')
        self.assertEqual(env['GCM_INTERACTIVE'],'0')
        self.assertEqual(env['GIT_TERMINAL_PROMPT'],'0')

    def test_missing_saved_credential_does_not_start_browser_login(self):
        vals={'github_owner':'avchatbot1-commits','github_credential_namespace':'old-namespace'}
        with patch.object(engine,'_inherit_shared_github_auth'), \
             patch.object(engine,'get_option',side_effect=lambda db,key: vals.get(key)), \
             patch.object(engine,'github_login',side_effect=AssertionError('unexpected OAuth')), \
             patch.object(engine.subprocess,'run',return_value=SimpleNamespace(returncode=1,stdout='',stderr='not found')) as subprocess_run:
            with self.assertRaisesRegex(RuntimeError,'credential lookup failed'):
                engine.credential_for_selected(object())
            self.assertEqual(subprocess_run.call_args.kwargs['env']['GCM_INTERACTIVE'],'0')

if __name__=='__main__':unittest.main()
