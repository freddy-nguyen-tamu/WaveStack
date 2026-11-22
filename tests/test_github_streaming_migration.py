import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from reusable.github_streaming import convert_registry, archive_source, preferred_chapter, route
from reusable.open_reader import normalize_chapters

class TestGitHubStreamingMigration(unittest.TestCase):
    def setUp(self):
        self.slug='example-story'
        self.chapter='chapter-with-a-long-stable-id-unlike-git-path'
        self.sha='a'*64
        self.old={'id':self.chapter, 'images':[{
           'url':f'https://example-story-vol-001.pages.dev/chapters/{self.chapter[:45]}/0001.jpg',
           'sha256':self.sha,'width':600,'height':1200}]}

    def test_adopts_existing_archive_filename_without_guessing_full_identity(self):
        reg={'comics':{self.slug:{'title':'Example','chapters':[self.old]}}}
        self.assertEqual(convert_registry(reg),1)
        im=reg['comics'][self.slug]['chapters'][0]['images'][0]
        self.assertEqual(im['github']['repo'],'example-story-vol-001')
        self.assertEqual(im['github']['path'],f'chapters/{self.chapter[:45]}/0001.jpg')
        self.assertEqual(im['url'],route(self.slug,self.chapter,1,self.sha))
        self.assertEqual(convert_registry(reg),1)
        self.assertEqual(normalize_chapters([reg['comics'][self.slug]['chapters'][0]])[0]['images'][0],im)

    def test_keeps_old_pages_urls_when_streaming_mode_disabled(self):
        orig=self.old['images'][0]['url']
        self.assertEqual(self.old['images'][0]['url'],orig)

    def test_does_not_override_migrated_verified_with_stale_pages_manifest(self):
        before=json.loads(json.dumps(self.old))
        migrated={'comics':{self.slug:{'chapters':[self.old]}}}
        convert_registry(migrated)
        self.assertIs(preferred_chapter(before,self.old), self.old)

    def test_rejects_other_repo_and_unknown_subpaths(self):
        im={'url':'https://example-story-vol-001.pages.dev/chapters/xyz/0001.jpg','sha256':self.sha}
        self.assertEqual(archive_source(im,self.slug,self.chapter)['repo'],'example-story-vol-001')
        im['url']='https://bad-volume-vol-001.pages.dev/chapters/xyz/0001.jpg'
        with self.assertRaises(RuntimeError):archive_source(im,self.slug,self.chapter)

    def test_shortcut_respects_reader_existing_chapter_parameter(self):
        src=Path(__file__).parents[1]/'reader'/'app.js'
        self.assertIn("url.searchParams.set('chapter',next.id)",src.read_text(encoding='utf-8'))
        bell=(src.parent/'reader-issues.js').read_text(encoding='utf-8')
        self.assertIn('Open affected chapter',bell)
        self.assertIn('first.source_chapter_url',bell)

if __name__=='__main__':unittest.main()
