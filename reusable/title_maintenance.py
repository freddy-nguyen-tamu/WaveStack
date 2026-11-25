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
import re
import time
import subprocess
import tempfile
from pathlib import Path

from .progress import Progress, stop_progress


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
              allow_failure: bool = False, data: bytes | None = None,
              progress=None, timeout: float = 300) -> bytes | str | None:
    # Bound every call, and show elapsed time even when Git emits no output.
    cmd = ['git', '-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=45', *args]
    proc = subprocess.Popen(cmd, cwd=work, env=env,
                            stdin=subprocess.PIPE if data is not None else subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    started = time.monotonic()
    try:
        while True:
            remaining = timeout - (time.monotonic() - started)
            if remaining <= 0:
                raise RuntimeError(f'Git title metadata operation {args[0]} timed out after {timeout:g}s; rerun safely')
            try:
                out, err = proc.communicate(input=data, timeout=min(5, remaining))
                break
            except subprocess.TimeoutExpired:
                data = None  # communicate retains the previously supplied input.
                if progress:
                    progress.heartbeat(detail='Git still working')
    except BaseException:
        if proc.poll() is None:
            proc.kill()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        raise
    finally:
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            if stream is not None:
                stream.close()
    if proc.returncode:
        if allow_failure:
            return None
        detail = err.decode('utf-8', errors='replace')[-1100:]
        raise RuntimeError(f'Git title metadata operation {args[0]} failed: {detail}')
    return out if raw else out.decode('utf-8', errors='replace').strip()


def _manifest_tree(git, commit, paths):
    """Read object IDs only; no image blobs or unrelated manifest blobs."""
    wanted = set(paths)
    found = {}
    for row in git('ls-tree', '-r', '-z', '--full-tree', commit, '--', 'chapters', raw=True).split(b'\0'):
        if not row:
            continue
        meta, name = row.split(b'\t', 1)
        path = name.decode('utf-8', 'surrogateescape')
        if path not in wanted:
            continue
        mode, kind, oid = meta.split()
        if mode != b'100644' or kind != b'blob' or not re.fullmatch(rb'[a-f0-9]{40}|[a-f0-9]{64}', oid):
            raise RuntimeError('Unexpected chapter manifest tree entry: '+path)
        found[path] = oid.decode('ascii')
    if set(found) != wanted:
        raise RuntimeError('Missing remote chapter manifests: '+repr(sorted(wanted-set(found))[:8]))
    return found


def _read_manifest_batch(git, entries):
    """One explicit object fetch, then one local cat-file read, not N lazy fetches."""
    oids = sorted(set(entries.values()))
    if not oids:
        return {}
    batch = ('\n'.join(oids)+'\n').encode('ascii')
    git('-c', 'fetch.negotiationAlgorithm=noop', 'fetch', '--no-tags',
        '--no-write-fetch-head', '--recurse-submodules=no', '--filter=blob:none',
        'origin', '--stdin', data=batch)
    raw = git('cat-file', '--batch', raw=True, data=batch)
    pos = 0
    by_oid = {}
    for oid in oids:
        end = raw.find(b'\n', pos)
        if end < 0:
            raise RuntimeError('Incomplete chapter manifest batch header')
        fields = raw[pos:end].split()
        if len(fields) != 3 or fields[0] != oid.encode('ascii') or fields[1] != b'blob':
            raise RuntimeError('Missing or invalid chapter manifest object: '+oid)
        size = int(fields[2]); pos = end+1
        if size < 0 or pos+size >= len(raw) or raw[pos+size:pos+size+1] != b'\n':
            raise RuntimeError('Incomplete chapter manifest batch payload: '+oid)
        by_oid[oid] = raw[pos:pos+size]; pos += size+1
    if pos != len(raw):
        raise RuntimeError('Unexpected trailing chapter manifest batch data')
    return {path: by_oid[oid] for path, oid in entries.items()}


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
    git_env['GCM_INTERACTIVE'] = '0'
    git_env['GIT_NO_LAZY_FETCH'] = '1'
    git_env['GIT_NO_REPLACE_OBJECTS'] = '1'
    phase = Progress(f'Title metadata {repo}: fetch remote tree')
    try:
        with tempfile.TemporaryDirectory(prefix='comic-title-update-') as temp:
            work = Path(temp)
            def git(*args, **kwargs):
                return _exec_git(work, git_env, *args, progress=phase, **kwargs)
            git('init', '-q', '-b', 'main')
            git('remote', 'add', 'origin', remote)
            git('fetch', '--depth=1', '--filter=blob:none', 'origin', 'main')
            parent = git('rev-parse', 'FETCH_HEAD')
            git('read-tree', parent)
            paths = {}
            for ident in sorted(updates):
                safe = re.sub(r'[^a-z0-9]+', '-', str(ident).casefold()).strip('-')[:45].rstrip('-') or 'comic'
                paths[ident] = f'chapters/{safe}/manifest.json'
            if len(set(paths.values())) != len(paths):
                raise RuntimeError('Chapter identity collision in title repair')
            entries = _manifest_tree(git, parent, paths.values())
            phase.complete('tree read')
            phase = Progress(f'Title metadata {repo}: fetch {len(entries)} manifests in one batch')
            originals = _read_manifest_batch(git, entries)
            phase.complete('manifest batch read')
            phase = Progress(f'Title metadata {repo}: compare manifests', len(updates), 'chapters')
            expected = {}
            final_by_id = {}
            for index, (ident, (saved_manifest, desired_title, source)) in enumerate(sorted(updates.items()), 1):
                path = paths[ident]
                try:
                    previous = json.loads(originals[path])
                except (TypeError, ValueError) as exc:
                    raise RuntimeError(f'{repo}/{path} is not a valid chapter manifest') from exc
                if not only_title_metadata_changed(saved_manifest, previous):
                    raise RuntimeError(f'Remote chapter {ident} differs beyond title metadata; no changes pushed')
                new = dict(previous)
                new['chapter_title'] = desired_title
                new['label'] = desired_title
                new['title_source'] = source
                final_by_id[ident] = new
                if new != previous:
                    expected[path] = json.dumps(new, indent=2, ensure_ascii=False).encode('utf-8')
                phase.update(index)
            phase.complete()
            if not expected:
                print(f'Title metadata {repo}: already correct remotely; no push.', flush=True)
                return None, final_by_id
            phase = Progress(f'Title metadata {repo}: stage {len(expected)} manifest blobs')
            names = []
            for index, blob in enumerate(expected.values()):
                name = f'title-{index:06d}.json'
                (work/name).write_bytes(blob)
                names.append(name)
            digests = git('hash-object', '-w', '--stdin-paths', data=('\n'.join(names)+'\n').encode('ascii')).splitlines()
            if len(digests) != len(expected) or any(not re.fullmatch(r'[a-f0-9]{40}|[a-f0-9]{64}', d) for d in digests):
                raise RuntimeError('Git did not return all staged manifest IDs')
            index_data = ''.join(f'100644 {digest}\t{path}\n' for path, digest in zip(expected, digests)).encode('ascii')
            git('update-index', '--index-info', data=index_data)
            tree = git('write-tree', '--missing-ok')
            commit = git('commit-tree', tree, '-p', parent, '-m', 'Backfill source-verified chapter titles')
            changed = set(git('diff-tree', '--no-commit-id', '--name-only', '-r', parent, commit).splitlines())
            if changed != set(expected):
                raise RuntimeError('Title-only commit changes unexpected GitHub files; refusing to push')
            phase.complete('only manifest paths changed')
            phase = Progress(f'Title metadata {repo}: push {len(expected)} manifests')
            if pace:
                pace(repo)
            git('push', 'origin', f'{commit}:refs/heads/main')
            tip_line = git('ls-remote', 'origin', 'refs/heads/main')
            if not tip_line or tip_line.split()[0] != commit:
                raise RuntimeError('Title metadata GitHub push remote SHA mismatch')
            phase.complete('remote tip confirmed')
            phase = Progress(f'Title metadata {repo}: independent readback of {len(expected)} manifests')
            with tempfile.TemporaryDirectory(prefix='comic-title-verify-') as vv:
                verify = Path(vv)
                def vg(*args, **kwargs):
                    return _exec_git(verify, git_env, *args, progress=phase, **kwargs)
                vg('init', '-q')
                vg('remote', 'add', 'origin', remote)
                vg('fetch', '--depth=1', '--filter=blob:none', 'origin', 'main')
                if vg('rev-parse', 'FETCH_HEAD') != commit:
                    raise RuntimeError('Title metadata remote verification got wrong commit')
                verified = _read_manifest_batch(vg, _manifest_tree(vg, commit, expected))
                for path, data in expected.items():
                    if hashlib.sha256(verified[path]).digest() != hashlib.sha256(data).digest():
                        raise RuntimeError(f'Remote title metadata checksum mismatch for {path}')
            phase.complete('all manifest SHA-256 checks passed')
            return commit, final_by_id
    except BaseException:
        stop_progress(phase, 'STOPPED; rerun safely')
        raise
