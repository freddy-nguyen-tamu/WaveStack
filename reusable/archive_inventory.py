"""Read-only remote Git archive inventory and recovery.

All network-facing operations use the caller's isolated Git configuration.  The
module never creates repositories, rewrites branches, or accesses source sites.
"""
from __future__ import annotations

import hashlib
import json
import os
import queue
import re
import subprocess
import tempfile
import threading
import time
from pathlib import Path

from .progress import Progress, stop_progress
from .github_cooldown import git_throttled, backoff, wait
from itertools import count


class ArchiveInventoryError(RuntimeError):
    pass


# Git normally suppresses transfer statistics when stderr is a pipe. Explicit
# --progress is necessary for a useful Windows CMD progress display.
_PROGRESS_LINE = re.compile(
    r"(?:remote:\s*)?(Enumerating objects|Counting objects|Compressing objects|"
    r"Receiving objects|Resolving deltas|Updating files|Finding sources|Checking objects)"
    r":\s*(?:(\d{1,3})%\s*\(\s*([\d,]+)/([\d,]+)\s*\))?",
    re.I,
)
_TRANSFER_RATE = re.compile(
    r"([\d.]+\s*[KMGT]?i?B)\s*\|\s*([\d.]+\s*[KMGT]?i?B/s)", re.I
)


def _git(work: Path, env: dict, *args: str, binary: bool = False,
         progress_label: str | None = None) -> bytes | str:
    for attempt in count():
        if not progress_label:
            proc = subprocess.run(['git', *args], cwd=work, env=env,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        else:
            command = ['git', *args]
            if args and args[0] == 'fetch' and '--progress' not in args:
                # Git doesn't show transfer progress through a pipe by default.
                command.insert(2, '--progress')
            child_env = dict(env)
            child_env.setdefault('GIT_PROGRESS_DELAY', '0')
            proc = _git_with_live_progress(command, work, child_env, progress_label)
        if not (proc.returncode and args and args[0] in ('fetch','ls-remote','show') and git_throttled(proc.stderr)):
            break
        wait(backoff(attempt),'GitHub archive inventory rate limit')
    if proc.returncode:
        reason = proc.stderr.decode('utf-8', 'replace')[-1200:]
        raise ArchiveInventoryError(f"Git archive inspection failed ({args[0]}): {reason}")
    return proc.stdout if binary else proc.stdout.decode('utf-8', 'replace').strip()


def _git_with_live_progress(command: list[str], work: Path, env: dict,
                            label: str) -> subprocess.CompletedProcess:
    """Display Git's *real* object/byte progress while draining both pipes.

    Reading Popen.communicate only after completion hides all progress for long
    filtered fetches. Separate pipe-draining threads work on Windows as well as
    POSIX and prevent stdout/stderr pipe deadlocks. The display is deliberately
    limited to Git's recognized progress events (not remote URLs or secrets).
    """
    proc = subprocess.Popen(command, cwd=work, env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            bufsize=0)
    display = Progress(label, interval=3.0)
    chunks = {'out': bytearray(), 'err': bytearray()}
    updates = queue.Queue()

    def consume(pipe, channel):
        try:
            pending = bytearray()
            # read(1) is deliberate: Windows buffered pipe.read(4096) can wait
            # for a full block, while Git emits short carriage-return updates.
            while True:
                raw = pipe.read(1)
                if not raw:
                    break
                chunks[channel].extend(raw)
                if channel == 'err':
                    if raw in (b'\r', b'\n'):
                        if pending:
                            updates.put(('line', bytes(pending).decode('utf-8', 'replace')))
                            pending.clear()
                    elif len(pending) < 8192:
                        pending.extend(raw)
            if pending:
                updates.put(('line', bytes(pending).decode('utf-8', 'replace')))
        finally:
            pipe.close()
            updates.put(('end', channel))

    threads = [threading.Thread(target=consume, args=(proc.stdout, 'out'), daemon=True),
               threading.Thread(target=consume, args=(proc.stderr, 'err'), daemon=True)]
    for thread in threads:
        thread.start()

    last_activity = time.monotonic()
    stages = {}
    current_stage = ''
    latest_detail = f'Git PID {proc.pid}; awaiting transfer reports'
    ended = set()
    # An unresponsive Git connection should not keep an unattended archive
    # running forever. Override with COMIC_GIT_METADATA_IDLE_SECONDS if needed.
    try:
        max_idle = max(60, int(env.get('COMIC_GIT_METADATA_IDLE_SECONDS', '480')))
    except (ValueError, TypeError):
        max_idle = 480
    try:
        while len(ended) < 2:
            try:
                kind, item = updates.get(timeout=3)
            except queue.Empty:
                kind, item = '', None
            now = time.monotonic()
            if kind == 'end':
                ended.add(item)
            elif kind == 'line':
                line = item.strip()
                if line:
                    last_activity = now
                    match = _PROGRESS_LINE.search(line)
                    if match:
                        stage = match.group(1)
                        if stage != current_stage:
                            current_stage = stage
                            display.label = f'{label} — {stage}'
                            display.total = None
                            display.current = 0
                            display.last_percent = -1
                        if match.group(2) and match.group(4):
                            completed = int(match.group(3).replace(',', ''))
                            total = int(match.group(4).replace(',', ''))
                            if total > 0:
                                display.total = total
                                display.unit = 'objects'
                                detail = _TRANSFER_RATE.search(line)
                                latest_detail = (f'{detail.group(1)} at {detail.group(2)}' if detail
                                                 else f'Git PID {proc.pid}; transfer active')
                                display.update(completed, latest_detail)
                                stages[stage] = (completed, total)
                        else:
                            latest_detail = f'Git PID {proc.pid}; {stage.lower()}'
                    else:
                        # Don't print arbitrary stderr (which can include URLs,
                        # headers or token-bearing error messages) to the UI.
                        latest_detail = f'Git PID {proc.pid}; transport responded'
            if not kind:
                silent = int(now - last_activity)
                if silent >= 30:
                    detail = (f'no Git transfer reports for {silent}s; '
                              f'Git PID {proc.pid}; check network/login')
                else:
                    detail = latest_detail
                display.heartbeat(force=True, detail=detail)
                if silent >= max_idle and proc.poll() is None:
                    proc.terminate()
                    raise ArchiveInventoryError(
                        f'Git metadata fetch made no observable progress for {silent}s. '
                        'Existing GitHub archives are unchanged. Check internet/GCM login '
                        'and rerun; set COMIC_GIT_METADATA_IDLE_SECONDS to adjust the limit.')
        proc.wait()
        for thread in threads:
            thread.join(timeout=3)
        if proc.returncode == 0:
            display.complete('Git metadata fetched successfully')
        else:
            stop_progress(display, f'Git fetch failed (exit {proc.returncode})')
        return subprocess.CompletedProcess(command, proc.returncode,
                                           bytes(chunks['out']), bytes(chunks['err']))
    except BaseException:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
        for thread in threads:
            thread.join(timeout=3)
        stop_progress(display, 'INTERRUPTED')
        raise

def remote_tip(owner: str, repo: str, env: dict) -> str:
    """Cheap existence/branch check; does not download comic image contents."""
    with tempfile.TemporaryDirectory(prefix="comic-inventory-tip-") as tmp:
        work = Path(tmp)
        out = _git(work, env, "ls-remote", f"https://github.com/{owner}/{repo}.git", "refs/heads/main",
                   progress_label=f'GitHub checking remote commit: {repo}')
        if not out:
            raise ArchiveInventoryError(f"The expected GitHub repo {owner}/{repo} has no main branch")
        return out.split()[0]


def read_remote_chapters(owner: str, repo: str, env: dict, trusted_manifests: dict[str, dict] | None = None, *, remote_url: str | None = None):
    """Fetch the remote tree and manifest *without* re-downloading trusted images.

    For chapters independently verified on a previous run, compare the remote
    manifest and image paths with SQLite.  For chapters missing in SQLite, read
    all the actual remote image bytes and verify SHA-256 before trusting recovery.
    This is used only for missing/partial state; normal completed runs take the
    cheap `remote_tip` path.
    """
    trusted_manifests = trusted_manifests or {}
    remote = remote_url or f"https://github.com/{owner}/{repo}.git"
    with tempfile.TemporaryDirectory(prefix="comic-inventory-read-") as tmp:
        work = Path(tmp)
        _git(work, env, "init", "-q", "-b", "main")
        _git(work, env, "remote", "add", "origin", remote)
        _git(work, env, 'fetch', '--depth=1', '--filter=blob:limit=65536',
             'origin', 'main', progress_label=f'GitHub archive metadata: {repo}')
        tip = _git(work, env, "rev-parse", "FETCH_HEAD")
        raw_tree = _git(work, env, "ls-tree", "-r", "--name-only", tip)
        paths = set(raw_tree.splitlines())
        manifest_paths = sorted(p for p in paths if p.startswith("chapters/") and p.endswith("/manifest.json"))
        chapters = []
        bar = Progress(f'Checking GitHub chapter manifests: {repo}',
                       total=len(manifest_paths), unit='chapters', interval=3.0)
        for manifest_path in manifest_paths:
            try:
                manifest = json.loads(_git(work, env, "show", f"{tip}:{manifest_path}"))
            except (ValueError, TypeError) as ex:
                raise ArchiveInventoryError(f"Invalid chapter manifest {repo}/{manifest_path}: {ex}") from ex
            ident = str(manifest.get("chapter_id", ""))
            images = manifest.get("images")
            image_paths = manifest.get("remote_files")
            if (not ident or not isinstance(images, list) or not images or
                    not isinstance(image_paths, list) or len(images) != len(image_paths)):
                raise ArchiveInventoryError(f"Incomplete remote chapter manifest: {repo}/{manifest_path}")
            root = manifest_path.rsplit("/", 1)[0] + "/"
            if any(not isinstance(path, str) or not path.startswith(root) or path not in paths
                   for path in image_paths):
                raise ArchiveInventoryError(f"Remote image path missing/unsafe: {repo}/{manifest_path}")
            if len(image_paths) != len(set(image_paths)):
                raise ArchiveInventoryError(f"Duplicate page path in remote manifest: {repo}/{manifest_path}")
            hashes = [im.get("sha256") for im in images]
            if any(not isinstance(h, str) or len(h) != 64 or
                   any(c not in "0123456789abcdefABCDEF" for c in h) for h in hashes):
                raise ArchiveInventoryError(f"Missing/invalid remote SHA-256 in {repo}/{manifest_path}")
            previous = trusted_manifests.get(ident)
            from .title_maintenance import only_title_metadata_changed
            previously_verified = (previous is not None and
                                   only_title_metadata_changed(previous, manifest))
            if not previously_verified:
                # Prove each byte on GitHub is recoverable, not merely listed.
                for image, path in zip(images, image_paths):
                    blob = _git(work, env, "show", f"{tip}:{path}", binary=True)
                    if hashlib.sha256(blob).hexdigest() != image["sha256"].lower():
                        raise ArchiveInventoryError(f"GitHub SHA-256 mismatch: {repo}/{path}")
                    if isinstance(image.get("bytes"), int) and image["bytes"] != len(blob):
                        raise ArchiveInventoryError(f"GitHub file-size mismatch: {repo}/{path}")
            chapters.append({"chapter_id": ident, "manifest": manifest,
                             "repository": repo, "tip_sha": tip,
                             "previously_verified": previously_verified})
            bar.update(len(chapters), detail=f'{ident} checked')
        bar.complete('all remote manifests checked')
        return chapters

