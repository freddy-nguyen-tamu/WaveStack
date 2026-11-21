"""Archive-safe chapter-title maintenance.

This module is entirely source-site agnostic. It updates only small chapter
manifest JSON blobs in existing Git repositories; Git image blobs and the rest
of each remote tree are preserved unchanged. Source-specific title discovery
is delegated to site_specific/site_adapter.py by the calling engine.
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import tempfile
from pathlib import Path


TITLE_FIELDS = frozenset({'chapter_title', 'title_source', 'label'})


def immutable_manifest_data(manifest: dict) -> dict:
    """All content and identity metadata except the allowed mutable title fields."""
    return {k: v for k, v in manifest.items() if k not in TITLE_FIELDS}


def only_title_metadata_changed(previous: dict, incoming: dict) -> bool:
    return immutable_manifest_data(previous) == immutable_manifest_data(incoming)


def candidate_title(raw: object, max_length: int = 250) -> str | None:
    if not isinstance(raw, str):
        return None
    clean = ' '.join(raw.strip().split())
    if not clean or len(clean) > max_length or any(ord(ch) < 32 for ch in clean):
        return None
    return clean


def manifest_missing_title(manifest: dict) -> bool:
    return not candidate_title(manifest.get('chapter_title'))


def _exec_git(work: Path, env: dict, *args: str, raw: bool = False,
              allow_failure: bool = False) -> bytes | str | None:
    proc = subprocess.run(['git', *args], cwd=work, env=env,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode:
        if allow_failure:
            return None
        detail = proc.stderr.decode('utf-8', errors='replace')[-1100:]
        raise RuntimeError(f'Git title metadata operation {args[0]} failed: {detail}')
    return proc.stdout if raw else proc.stdout.decode('utf-8', errors='replace').strip()


def update_manifest_titles(repo: str, owner: str, updates: dict[str, tuple[dict, str, str]],
                           env: dict, pace=None, *, remote_url: str | None = None) -> tuple[str | None, dict]:
    """Atomically commit only title metadata to an existing remote repository.

    updates: {chapter_id: (trusted_local_manifest, new_native_title, title_source)}.
    Returns (new_remote_sha_or_None, verified_manifests_by_id).
    Existing Git image objects are NEVER loaded or uploaded by this function.
    """
    if not updates:
        return None, {}
    if not owner:
        raise ValueError('GitHub account must be explicitly selected')
    remote = remote_url or f'https://github.com/{owner}/{repo}.git'
    git_env = dict(env)
    git_env['GIT_AUTHOR_NAME'] = owner
    git_env['GIT_COMMITTER_NAME'] = owner
    git_env['GIT_AUTHOR_EMAIL'] = f'{owner}@users.noreply.github.com'
    git_env['GIT_COMMITTER_EMAIL'] = git_env['GIT_AUTHOR_EMAIL']
    git_env['GIT_TERMINAL_PROMPT'] = '0'
    with tempfile.TemporaryDirectory(prefix='comic-title-update-') as temp:
        work = Path(temp)
        def git(*args, raw=False, allow_failure=False):
            return _exec_git(work, git_env, *args, raw=raw, allow_failure=allow_failure)
        git('init', '-q', '-b', 'main')
        git('remote', 'add', 'origin', remote)
        git('fetch', '--depth=1', '--filter=blob:none', 'origin', 'main')
        parent = git('rev-parse', 'FETCH_HEAD')
        git('read-tree', parent)
        expected: dict[str, bytes] = {}
        final_by_id: dict[str, dict] = {}
        for ident, (saved_manifest, desired_title, source) in sorted(updates.items()):
            # Use the identical path determined by original manifest identity.
            import re
            safe = re.sub(r'[^a-z0-9]+', '-', str(ident).casefold()).strip('-')[:45].rstrip('-') or 'comic'
            path = f'chapters/{safe}/manifest.json'
            previous_bytes = git('show', f'{parent}:{path}', raw=True)
            try:
                previous = json.loads(previous_bytes)
            except (TypeError, ValueError) as exc:
                raise RuntimeError(f'{repo}/{path} is not a valid chapter manifest') from exc
            # A concurrent publication may have changed the remote title but
            # NEVER allow this metadata-only operation to alter image objects.
            if not only_title_metadata_changed(saved_manifest, previous):
                raise RuntimeError(f'Remote chapter {ident} differs beyond title metadata; no changes pushed')
            new = dict(previous)
            new['chapter_title'] = desired_title
            new['label'] = desired_title
            new['title_source'] = source
            final_by_id[ident] = new
            if new == previous:
                continue
            blob_data = json.dumps(new, indent=2, ensure_ascii=False).encode('utf-8')
            f = work / f'title-{len(expected):06d}.json'
            f.write_bytes(blob_data)
            digest = git('hash-object', '-w', str(f))
            git('update-index', '--add', '--cacheinfo', f'100644,{digest},{path}')
            expected[path] = blob_data
        if not expected:
            return None, final_by_id
        tree = git('write-tree')
        commit = git('commit-tree', tree, '-p', parent, '-m', 'Backfill source-verified chapter titles')
        # Prove ONLY intended manifest paths changed, not a single image path.
        changed = set(git('diff-tree', '--no-commit-id', '--name-only', '-r', parent, commit).splitlines())
        if changed != set(expected):
            raise RuntimeError('Title-only commit changes unexpected GitHub files; refusing to push')
        if pace:
            pace(repo)
        git('push', 'origin', f'{commit}:refs/heads/main')
        tip_line = git('ls-remote', 'origin', 'refs/heads/main')
        if not tip_line or tip_line.split()[0] != commit:
            raise RuntimeError('Title metadata GitHub push remote SHA mismatch')
        # Independently fetch and compare every modified manifest byte.
        with tempfile.TemporaryDirectory(prefix='comic-title-verify-') as vv:
            verify = Path(vv)
            def vg(*args, raw=False):
                return _exec_git(verify, git_env, *args, raw=raw)
            vg('init', '-q')
            vg('remote', 'add', 'origin', remote)
            vg('fetch', '--depth=1', '--filter=blob:none', 'origin', 'main')
            if vg('rev-parse', 'FETCH_HEAD') != commit:
                raise RuntimeError('Title metadata remote verification got wrong commit')
            for path, data in expected.items():
                got = vg('show', f'{commit}:{path}', raw=True)
                if hashlib.sha256(got).digest() != hashlib.sha256(data).digest():
                    raise RuntimeError(f'Remote title metadata checksum mismatch for {path}')
        return commit, final_by_id
