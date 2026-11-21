"""Regression: never strand an automatically clearing bot-check behind input().

All tests are offline; source site, Chrome, and GitHub are never contacted.
"""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from reusable import source_session as ss
from reusable.browser_bridge import BridgePage, BrowserBridgeError

URL = 'https://example.org/series/chapter-62/'


class FakeGuard:
    def __init__(self):
        self.events=[]
    def emit(self, name, **kwargs):
        self.events.append((name, kwargs))
    def before(self, *args, **kwargs):
        raise AssertionError('Passive polling must never request or navigate the source')
    def response(self, *args, **kwargs):
        raise AssertionError('Passive polling must never claim a network response')


class FakePage:
    def __init__(self):
        self.url=URL
        self.challenge=True
        self.login=False
        self.ready=False
        self.content_calls=0
        self.evaluate_calls=0
        self.ready_calls=0
    def goto(self, *args, **kwargs):
        raise AssertionError('Passive challenge check must not call goto')
    def content(self):
        self.content_calls+=1
        return '<html><body><main class="reader"><img src="picture.jpg"></main></body></html>'
    def evaluate(self, script):
        self.evaluate_calls+=1
        if 'iframe[src*="captcha"' in script:
            return {'title':'Just a moment...' if self.challenge else 'Reader',
                    'challenge':self.challenge,'login':self.login}
        raise AssertionError('Unexpected page manipulation / script')
    def reader_ready(self):
        self.ready_calls+=1
        return self.ready


class PassiveChallengeTests(unittest.TestCase):
    def test_two_idle_periods_then_resume_without_network(self):
        guard=FakeGuard(); page=FakePage(); sleeps=[]
        def sleeper(seconds):
            sleeps.append(seconds)
            self.assertEqual(seconds,20.0)
            # No browser work has taken place during this entire idle interval.
            self.assertEqual(page.content_calls,len(sleeps)-1)
            if len(sleeps)==2:
                page.challenge=False
                page.ready=True
        with patch.object(ss.time,'sleep',side_effect=sleeper), patch.object(ss,'_operator_requested_stop',return_value=False):
            result=ss.wait_for_manual_source_access(page, URL, guard)
        self.assertEqual(len(sleeps),2)
        self.assertEqual(result.url,URL)
        self.assertEqual(result.status,200)
        self.assertEqual(page.content_calls,2)
        self.assertEqual([e[0] for e in guard.events].count('SOURCE_PASSIVE_CHALLENGE_CLEARED'),1)

    def test_challenge_cleared_but_reader_unready_must_continue_sleeping(self):
        guard=FakeGuard(); page=FakePage(); intervals=[]
        def sleeper(t):
            intervals.append(t)
            if len(intervals)==1:
                page.challenge=False; page.ready=False
            if len(intervals)==2:
                page.ready=True
        with patch.object(ss.time,'sleep',side_effect=sleeper), patch.object(ss,'_operator_requested_stop',return_value=False):
            ss.wait_for_manual_source_access(page, URL, guard)
        self.assertEqual(len(intervals),2)
        self.assertIn('SOURCE_PASSIVE_CHALLENGE_PENDING',[e[0] for e in guard.events])

    def test_reader_at_wrong_path_never_resumes(self):
        guard=FakeGuard();page=FakePage();page.challenge=False;page.ready=True
        page.url='https://example.org/series/chapter-63/'
        visits=[]
        def sleeper(_):
            visits.append('tick')
            if len(visits)==2: raise KeyboardInterrupt()
        with patch.object(ss.time,'sleep',side_effect=sleeper), patch.object(ss,'_operator_requested_stop',return_value=False):
            with self.assertRaises(ss.SourceAccessPaused):
                ss.wait_for_manual_source_access(page,URL,guard)
        self.assertEqual(page.ready_calls,0)
        self.assertEqual(page.content_calls,1)

    def test_login_remains_blocked_until_reader_returns(self):
        guard=FakeGuard(); page=FakePage(); page.challenge=False; page.login=True;page.ready=True
        ticks=[]
        def sleeper(_):
            ticks.append(1)
            if len(ticks)==2:page.login=False
        with patch.object(ss.time,'sleep',side_effect=sleeper), patch.object(ss,'_operator_requested_stop',return_value=False):
            ss.wait_for_manual_source_access(page,URL,guard)
        self.assertEqual(len(ticks),2)
        self.assertEqual(page.ready_calls,1)

    def test_passive_check_read_failures_do_not_trigger_reload(self):
        guard=FakeGuard();page=FakePage();page.ready=True;page.challenge=False
        real_content=page.content
        calls=[]
        def fails_once():
            calls.append(1)
            if len(calls)==1:raise RuntimeError('document navigated')
            return real_content()
        page.content=fails_once
        with patch.object(ss.time,'sleep',return_value=None) as sleep, patch.object(ss,'_operator_requested_stop',return_value=False):
            ss.wait_for_manual_source_access(page,URL,guard)
        self.assertEqual(sleep.call_count,2)
        self.assertEqual(len(calls),2)

    def test_q_stops_with_checkpoint_preserved(self):
        guard=FakeGuard();page=FakePage()
        with patch.object(ss.time,'sleep',return_value=None) as sleep, patch.object(ss,'_operator_requested_stop',return_value=True):
            with self.assertRaisesRegex(ss.SourceAccessPaused,'checkpoint preserved'):
                ss.wait_for_manual_source_access(page,URL,guard)
        self.assertEqual(sleep.call_count,1)
        self.assertEqual(page.content_calls,0)

    def test_bridge_reader_uses_adapter_selectors_and_allowed_image_hosts(self):
        class Bridge:
            tab_url=URL
            def validate_image(self,u):
                if not u.startswith('https://example.org/'):
                    raise BrowserBridgeError('host not allowed')
            def rpc(self,action,payload=None,timeout=None):
                assert action=='snapshot'
                return {'imgs':[{'loaded':True,'url':'https://example.org/image.jpg',
                                 'width':100,'height':200}]}
        class Context:
            bridge=Bridge();reader_selectors=['.reader-body']; image_attributes=['src']
        p=BridgePage(Context())
        p.url=URL
        p._last_html='<html><article class="other"><img src="image.jpg"></article></html>'
        self.assertFalse(p.reader_ready())
        p._last_html='<html><article class="reader-body"><img src="image.jpg"></article></html>'
        self.assertTrue(p.reader_ready())

    def test_visit_source_page_resumes_after_automatic_challenge_clear(self):
        # This is the actual public entry point used by acquire_chapter(),
        # not merely a direct helper-unit test.
        from types import SimpleNamespace
        page=FakePage(); guard=FakeGuard(); actions=[]
        def goto(u, **kw):
            actions.append('goto')
            self.assertEqual(u,URL)
            self.assertEqual(actions,['before','goto'])
            return SimpleNamespace(url=u,status=200,headers={})
        page.goto=goto
        def before(u, **kw): actions.append('before')
        def response(*a): actions.append('response')
        guard.before=before
        guard.response=response
        def sleeper(t):
            self.assertEqual(t,20.0)
            self.assertEqual(actions,['before','goto','response'])
            page.challenge=False;page.ready=True
        with patch.object(ss.time,'sleep',side_effect=sleeper), patch.object(ss,'_operator_requested_stop',return_value=False):
            result=ss.visit_source_page(page,URL,guard)
        self.assertEqual(result.status,200)
        self.assertEqual(actions,['before','goto','response'])
        self.assertEqual(page.content_calls,1)
        self.assertIn('SOURCE_PASSIVE_CHALLENGE_CLEARED',[e[0] for e in guard.events])

    def test_extension_observation_follows_browser_redirect_without_navigating(self):
        # Live Chromium may change location.href after clearing the challenge;
        # BridgePage.url must refresh from PAGE before URL/reader verification.
        from reusable.browser_bridge import BridgePage
        class FakeBridge:
            tab_url=URL
            def __init__(self):self.operations=[]
            def validate_image(self,url):
                if not url.startswith('https://example.org/'):
                    raise AssertionError('wrong image origin')
                return url
            def rpc(self,action,payload=None,timeout=None):
                self.operations.append(action)
                if action=='page':
                    return {'url':URL,'html':'<html><article class="reader-body"><img src="https://example.org/1.jpg"></article></html>'}
                if action=='classify':
                    return {'title':'Episode Reader','challenge':False,'login':False}
                if action=='snapshot':
                    return {'imgs':[{'url':'https://example.org/1.jpg','loaded':True,'width':500,'height':900}]}
                raise AssertionError('Unexpected site-changing operation: '+action)
        class Ctx:
            bridge=FakeBridge();reader_selectors=['.reader-body'];image_attributes=['src']
        page=BridgePage(Ctx())
        page.url='https://example.org/verify/'
        guard=FakeGuard()
        with patch.object(ss.time,'sleep',return_value=None) as sl,patch.object(ss,'_operator_requested_stop',return_value=False):
            result=ss.wait_for_manual_source_access(page,URL,guard)
        self.assertEqual(result.url,URL)
        self.assertEqual(Ctx.bridge.operations,['page','classify','snapshot'])
        sl.assert_called_once_with(20.0)

    def test_no_navigation_or_blocking_input_inside_wait_function(self):
        import ast,inspect,textwrap
        tree=ast.parse(textwrap.dedent(inspect.getsource(ss.wait_for_manual_source_access)))
        for item in ast.walk(tree):
            if isinstance(item,ast.Call):
                self.assertFalse(isinstance(item.func,ast.Name) and item.func.id=='input')
                self.assertFalse(isinstance(item.func,ast.Attribute) and item.func.attr in ('goto','reload','click','scroll'))

    def test_noninteractive_tty_not_required(self):
        guard=FakeGuard();page=FakePage()
        def sleep(_):page.challenge=False; page.ready=True
        with patch.object(ss.sys.stdin,'isatty',return_value=False),patch.object(ss.time,'sleep',side_effect=sleep):
            result=ss.wait_for_manual_source_access(page,URL,guard)
        self.assertEqual(result.status,200)


if __name__=='__main__':unittest.main()
