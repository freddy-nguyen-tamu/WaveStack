import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from reusable.reader_issue_feed import build_issue_feed, write_issue_feed

class IssueFeedTests(unittest.TestCase):
    def make(self, root, slug, title, chapters):
        state=root/'.archiver_state'/'sites'/slug
        state.mkdir(parents=True)
        con=sqlite3.connect(state/'state.sqlite')
        con.execute('CREATE TABLE options(key TEXT,value TEXT)')
        con.execute('CREATE TABLE chapters(chapter_id TEXT,label TEXT,url TEXT,status TEXT)')
        for k,v in [('series_title',title),('series_slug',slug)]:
            con.execute('INSERT INTO options VALUES (?,?)',(k,json.dumps(v)))
        for cid,name,status in chapters:
            con.execute('INSERT INTO chapters VALUES (?,?,?,?)',(cid,name,'https://example.invalid/chapter/'+cid,status))
        con.commit();con.close()
        return state

    def report(self,state,chapter,failures,saved=()):
        folder=state/'temporary_downloads'/chapter
        folder.mkdir(parents=True)
        (folder/'confirmed_server_failures.json').write_text(json.dumps({'chapter_id':chapter,'recorded_at':'2026-11-21T00:00:00+00:00','failures':failures}))
        (folder/'.image-checkpoint.json').write_text(json.dumps({'images':{str(n):{'order':n} for n in saved}}))

    def test_grouped_two_works_and_exact_panels(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            a=self.make(root,'comic-a','Comic A',[('82','Episode 82','SOURCE_SERVER_DEFERRED')]);
            b=self.make(root,'comic-b','Comic B',[('4','Ch 4','SOURCE_SERVER_DEFERRED')]);
            self.report(a,'82',{'56':{'status':404,'reason':'confirmed_image_http_404','debugger_confirmed':True},'57':{'status':503,'reason':'repeated_source_http_5xx_after_reload','debugger_confirmed':True}})
            self.report(b,'4',{'3':{'status':410,'reason':'confirmed_image_http_410','debugger_confirmed':True}})
            feed=build_issue_feed(root,reader_base='https://open-reader.example.workers.dev')
            self.assertEqual(3,feed['count']);self.assertEqual(2,feed['affected_works'])
            self.assertEqual({('Comic A','Episode 82',56),('Comic A','Episode 82',57),('Comic B','Ch 4',3)},
                 {(x['work'],x['episode'],x['panel']) for x in feed['cases']})
            self.assertTrue(all(x['reader_url'].startswith('https://open-reader.example.workers.dev/comics/') for x in feed['cases']))

    def test_not_marked_server_when_access_uncertain_or_local(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); a=self.make(root,'a','Work',[('1','E1','SOURCE_SERVER_DEFERRED')]);
            self.report(a,'1',{'1':{'status':403,'reason':'confirmed_image_http_403','debugger_confirmed':True},
               '2':{'status':404,'reason':'confirmed_image_http_404','debugger_confirmed':False},
               '3':{'status':200,'reason':'repeated_source_http_5xx_after_reload','debugger_confirmed':True}})
            self.assertEqual(0,build_issue_feed(root)['count'])

    def test_user_confirmed_source_placeholder_no_http_code(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); a=self.make(root,'a','Comic A',[('82','Episode 82','SOURCE_SERVER_DEFERRED')]);
            e={'url':'https://images.example.test/56.jpg',
               'status':None,'reason':'adapter_confirmed_origin_placeholder',
               'adapter_confirmed':True,'dom_unloaded':True}
            self.report(a,'82',{'56':e,'57':e})
            feed=build_issue_feed(root)
            self.assertEqual(2,feed['count'])
            self.assertIsNone(feed['cases'][0]['http_status'])

    def test_verified_and_published_cases_disappear(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); a=self.make(root,'a','Work',[('1','E1','SOURCE_SERVER_DEFERRED'),('2','E2','PUBLISHED_VERIFIED')]);
            e={'status':404,'reason':'confirmed_image_http_404','debugger_confirmed':True}
            self.report(a,'1',{'1':e,'2':e},saved=(1,));self.report(a,'2',{'5':e})
            self.assertEqual([2],[x['panel'] for x in build_issue_feed(root)['cases']])
            dest=root/'issues.json'; result=write_issue_feed(root,dest)
            self.assertEqual(result['cases'],json.loads(dest.read_text())['cases'])

if __name__=='__main__':unittest.main()
