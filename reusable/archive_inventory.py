"""Read-only remote Git archive inventory and recovery.

All network-facing operations use the caller's isolated Git configuration.  The
module never creates repositories, rewrites branches, or accesses source sites.
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import tempfile
from pathlib import Path

from .progress import Progress, stop_progress


class ArchiveInventoryError(RuntimeError):
    pass


def _git(work: Path, env: dict, *args: str, binary: bool = False,
         progress_label: str | None = None) -> bytes | str:
    if progress_label:
        proc = subprocess.Popen(['git', *args], cwd=work, env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        progress = Progress(progress_label, interval=3.0)
        try:
            while True:
                try:
                    stdout, stderr = proc.communicate(timeout=3)
                    break
                except subprocess.TimeoutExpired:
                    progress.heartbeat(force=True)
            for stream in (proc.stdout, proc.stderr):
                if stream:
                    stream.close()
            result = subprocess.CompletedProcess(proc.args, proc.returncode, stdout, stderr)
            if result.returncode == 0:
                progress.complete('Git operation complete')
            else:
                stop_progress(progress, f'FAILED ({result.returncode})')
            proc = result
        except BaseException:
            if proc.poll() is None:
                proc.terminate()
            stop_progress(progress, 'INTERRUPTED')
            raise
        finally:
            for stream in (proc.stdout, proc.stderr):
                if stream and hasattr(stream, 'close'):
                    stream.close()
    else:
        proc = subprocess.run(['git', *args], cwd=work, env=env,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode:
        reason = proc.stderr.decode("utf-8", "replace")[-1200:]
        raise ArchiveInventoryError(f"Git archive inspection failed ({args[0]}): {reason}")
    return proc.stdout if binary else proc.stdout.decode("utf-8", "replace").strip()


def remote_tip(owner: str, repo: str, env: dict) -> str:
    """Cheap existence/branch check; does not download comic image contents."""
    with tempfile.TemporaryDirectory(prefix="comic-inventory-tip-") as tmp:
        work = Path(tmp)
        out = _git(work, env, "ls-remote", f"https://github.com/{owner}/{repo}.git", "refs/heads/main")
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
