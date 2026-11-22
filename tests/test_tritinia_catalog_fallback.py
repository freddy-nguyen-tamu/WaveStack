# TEST_TRITINIA_NATIVE_CATALOG_FALLBACK
import unittest
from site_specific import site_adapter as a

URL = a.DEFAULT_START_URL
class Chapter:
    def __init__(self, chapter_id, label, url):
        self.chapter_id, self.label, self.url = chapter_id, label, url

class SourceCatalogFallbackTests(unittest.TestCase):
    def reader(self):
        return ('<html><head><title>We May Be an Inexperienced Couple but… - Ch. 1 - Tritinia Scans</title>'
                '<link rel="canonical" href="'+URL+'"></head><body>'
                '<div class="reading-content"><div class="page-break">'
                '<img id="0" src="https://tritinia.org/panel.png"></div></div></body></html>')

    def test_reader_without_dropdown_uses_verified_native_html_catalog(self):
        with self.assertWarnsRegex(RuntimeWarning, '140 exact chapter URLs'):
            chapters=a.custom_chapters(self.reader(), URL, Chapter)
        self.assertEqual(len(chapters),140)
        self.assertEqual(len({c.url for c in chapters}),140)
        self.assertEqual(len({c.chapter_id for c in chapters}),140)
        self.assertEqual(chapters[0].url, URL)
        self.assertEqual({a._chapter_path(c.url)[0] for c in chapters}, set(range(1,17)))

    def test_actual_challenge_page_never_uses_catalog_snapshot(self):
        with self.assertRaisesRegex(RuntimeError, 'reader panels absent'):
            a.custom_chapters('<title>We May Be an Inexperienced Couple but…</title><div class="cf-challenge">Verify</div>', URL, Chapter)

    def test_different_chapter_canonical_refused(self):
        bad=self.reader().replace('href="'+URL+'"','href="https://tritinia.org/manga/other-comic/volume-1/ch-1/"')
        with self.assertRaisesRegex(RuntimeError, 'canonical URL not verified'):
            a.custom_chapters(bad,URL,Chapter)

    def test_unwrapped_native_options_are_supported(self):
        choices=''.join('<option data-redirect="%s">%s</option>'%(url,label)
                        for url,label in reversed(a._VERIFIED_NATIVE_CATALOG_FROM_HTML))
        raw='<html><select class="single-chapter-select">'+choices+'</select></html>'
        chapters=a.custom_chapters(raw,URL,Chapter)
        self.assertEqual(len(chapters),140)
        self.assertEqual(chapters[0].url,URL)

    def test_incomplete_native_options_still_refused(self):
        raw='<select class="single-chapter-select"><option data-redirect="'+URL+'">Ch. 1</option></select>'
        with self.assertRaisesRegex(RuntimeError,'incomplete'):
            a.custom_chapters(raw,URL,Chapter)

if __name__=='__main__':
    unittest.main()
