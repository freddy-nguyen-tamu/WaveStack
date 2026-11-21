"""Regression for Wrangler's `Project Name` / `Project Domains` JSON columns.

Our caller already has 1,164 verified images; a project discovery failure must
not lead to re-archival, duplicate Pages project creation, or silent overwrite.
"""
from __future__ import annotations
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import comic_archiver as engine

VOLUME = 'the-stories-of-those-around-me-vol-001'
DOMAIN = VOLUME + '.pages.dev'
WRANGLER_4_OUTPUT = json.dumps([{
    'Project Name': VOLUME,
    'Project Domains': DOMAIN,
    'Git Provider': 'No',
    'Last Modified': 'just now'
}])


def response(stdout='[]', code=0):
    return SimpleNamespace(stdout=stdout, stderr='', returncode=code)


def memory_db():
    db = sqlite3.connect(':memory:')
    db.execute('CREATE TABLE deployments(project TEXT PRIMARY KEY)')
    return db


class PagesProjectDiscoveryRegression(unittest.TestCase):
    def test_official_wrangler_4_schema_normalized(self):
        with patch.object(engine, 'npx_wrangler', return_value=response(WRANGLER_4_OUTPUT)):
            projects = engine.list_pages_projects()
        self.assertEqual(len(projects), 1)
        self.assertEqual(projects[0]['name'], VOLUME)
        self.assertEqual(projects[0]['subdomain'], DOMAIN)
        self.assertEqual(engine.cloudflare_pages_url(projects[0]), 'https://' + DOMAIN)

    def test_api_schema_still_supported(self):
        raw = json.dumps({'result': [{'name': VOLUME, 'subdomain': DOMAIN}]})
        with patch.object(engine, 'npx_wrangler', return_value=response(raw)):
            self.assertEqual(engine.list_pages_projects()[0]['name'], VOLUME)

    def test_newly_created_project_reappears_and_is_not_recreated(self):
        calls = []
        def provider(args, **kwargs):
            calls.append(args)
            if args[:3] == ['pages','project','list']:
                # First list: missing; second: project now present.
                return response('[]' if len([x for x in calls if x[:3] == ['pages','project','list']]) == 1
                                else WRANGLER_4_OUTPUT)
            if args[:3] == ['pages','project','create']:
                return response(f"Successfully created '{VOLUME}' project")
            raise AssertionError(f'unexpected Wrangler command: {args}')
        db = memory_db()
        with patch.object(engine, 'npx_wrangler', side_effect=provider), \
             patch.object(engine, 'event'):
            project = engine.ensure_cloudflare_pages_project(VOLUME, db)
        self.assertEqual(project['name'], VOLUME)
        self.assertEqual(sum(x[:3] == ['pages','project','create'] for x in calls),1)
        db.close()

    def test_previous_run_created_empty_project_reuse_without_prompt(self):
        calls = []
        def provider(args, **kwargs):
            calls.append(args)
            if args[:3] == ['pages','project','list']:
                return response(WRANGLER_4_OUTPUT)
            if args[:3] == ['pages','deployment','list']:
                return response('[]')
            raise AssertionError(f'unexpected Wrangler command: {args}')
        db=memory_db()
        with patch.object(engine,'npx_wrangler',side_effect=provider), \
             patch.object(engine,'event'), \
             patch('builtins.input',side_effect=AssertionError('must not ask')):
            project=engine.ensure_cloudflare_pages_project(VOLUME,db)
        self.assertEqual(project['subdomain'], DOMAIN)
        self.assertFalse(any(x[:3] == ['pages','project','create'] for x in calls))
        db.close()

    def test_existing_deployed_project_not_silently_overwritten(self):
        def provider(args, **kwargs):
            if args[:3] == ['pages','project','list']:
                return response(WRANGLER_4_OUTPUT)
            if args[:3] == ['pages','deployment','list']:
                return response(json.dumps([{'id':'unrelated-live-deployment'}]))
            raise AssertionError(f'unexpected command: {args}')
        db=memory_db()
        with patch.object(engine,'npx_wrangler',side_effect=provider), \
             patch('builtins.input',return_value='NO'):
            with self.assertRaisesRegex(RuntimeError,'unconfirmed'):
                engine.ensure_cloudflare_pages_project(VOLUME,db)
        db.close()

    def test_unknown_wranger_schema_fails_safely(self):
        with patch.object(engine,'npx_wrangler',return_value=response('[{"unexpected":"x"}]')):
            with self.assertRaisesRegex(RuntimeError,'no recognizable name'):
                engine.list_pages_projects()

if __name__ == '__main__':
    unittest.main()
