"""Source failures may be tolerated only with affirmative source-origin evidence."""
import ast
import unittest
from pathlib import Path
from urllib.parse import urljoin, urlsplit

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / 'reusable' / 'engine.py'
node = ast.parse(SRC.read_text(encoding='utf-8'))
fn = next(n for n in node.body if isinstance(n, ast.FunctionDef) and n.name == 'classify_source_image_server_error')
namespace = {}
exec(compile(ast.Module(body=[fn], type_ignores=[]), str(SRC), 'exec'), namespace)
classify = namespace['classify_source_image_server_error']
URL='https://example.test/image.jpg'

def report(status, **extra):
    return {'url':URL,'debuggerReady':True,'capturedOriginal':False,
            'network':{'status':status},'dom':{'found':True,'loaded':False},**extra}

class ServerErrorClassification(unittest.TestCase):
    def test_404_and_410_are_confirmed(self):
        for n in (404,410):
            self.assertEqual(n, classify(URL, report(n))['status'])
    def test_5xx_only_after_second_observation_and_reload(self):
        self.assertIsNone(classify(URL, report(503)))
        self.assertIsNotNone(classify(URL, report(503), prior_status=502))
        self.assertIsNone(classify(URL, report(200), prior_status=503))
    def test_access_blocks_and_other_ambiguous_errors_never_tolerated(self):
        for n in (0,200,401,403,408,429,499):
            self.assertIsNone(classify(URL, report(n)))
    def test_image_is_loaded_or_original_was_captured(self):
        self.assertIsNone(classify(URL, report(404,dom={'found':True,'loaded':True})))
        self.assertIsNone(classify(URL, report(404,capturedOriginal=True)))
    def test_web_request_proves_server_error_without_debugger(self):
        observed=report(404,debuggerReady=False,network={'status':404,
           'source':'chrome.webRequest','observedInManagedTab':True})
        self.assertIsNotNone(classify(URL,observed))
        observed['network']['observedInManagedTab']=False
        self.assertIsNone(classify(URL,observed))

    def test_debugger_missing_url_mismatch_or_network_failure(self):
        self.assertIsNone(classify(URL, report(404,debuggerReady=False)))
        self.assertIsNone(classify(URL, report(404,url='https://other.test/img.jpg')))
        self.assertIsNone(classify(URL, report(404,network={'status':404,'failed':True})))
        self.assertIsNone(classify(URL, report(404,network={'status':404,'fromServiceWorker':True})))

if __name__ == '__main__': unittest.main()
