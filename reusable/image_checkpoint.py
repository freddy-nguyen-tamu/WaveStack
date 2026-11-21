"""Durable, source-agnostic, per-image chapter resume state.

Only the adapter interprets a site's DOM. This module knows ordered keys,
URLs, local files and cryptographic image validation; it does not know hosts,
selectors, chapter numbering schemes, or publishers.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import re
import tempfile
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from PIL import Image


def _canonical(url: str) -> str:
    p = urlsplit(str(url))
    return urlunsplit((p.scheme.lower(), p.netloc.lower(), p.path, p.query, ''))


def _atomic_write(path: Path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    name = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent,
                                         prefix='.checkpoint-', suffix='.tmp', delete=False) as fp:
            name = fp.name
            json.dump(obj, fp, ensure_ascii=False, sort_keys=True)
            fp.flush()
            os.fsync(fp.fileno())
        os.replace(name, path)
    finally:
        if name and os.path.exists(name):
            os.unlink(name)


class ChapterImageCheckpoint:
    VERSION = 1

    def __init__(self, directory: Path, chapter_id: str, chapter_url: str):
        self.directory = Path(directory)
        self.chapter_id = str(chapter_id)
        self.chapter_url = _canonical(chapter_url)
        self.path = self.directory / '.image-checkpoint.json'
        self._verified = {}
        self.data = {'version': self.VERSION, 'chapter_id': self.chapter_id,
                     'chapter_url': self.chapter_url, 'images': {}, 'catalog': None}
        try:
            disk = json.loads(self.path.read_text(encoding='utf-8'))
            if (disk.get('version') == self.VERSION and
                disk.get('chapter_id') == self.chapter_id and
                disk.get('chapter_url') == self.chapter_url and
                isinstance(disk.get('images'), dict)):
                self.data = disk
        except (OSError, ValueError, AttributeError, TypeError):
            pass  # Untrusted or interrupted checkpoint is never reused.

    def _commit(self):
        _atomic_write(self.path, self.data)

    def record_image(self, key: str, order: int, source_url: str, path: Path, meta: dict):
        """Record only a fully validated image, after its bytes are durable."""
        key = str(key)
        path = Path(path)
        if path.parent.resolve() != self.directory.resolve() or not re.fullmatch(r'\d{4,}\.(jpg|jpeg|png|webp|gif|avif|bmp)', path.name, re.I):
            raise ValueError('Image must have a numbered filename in this chapter directory')
        if path.stem != f'{order:04d}' or meta['source_url'] != source_url:
            raise ValueError('Image identity or output order changed during transfer')
        raw = path.read_bytes()
        if len(raw) != int(meta['bytes']) or hashlib.sha256(raw).hexdigest() != meta['sha256']:
            raise ValueError('Image bytes changed before checkpoint was committed')
        with Image.open(io.BytesIO(raw)) as image:
            image.verify()
        item = {'key': key, 'order': int(order), 'url': source_url,
                'filename': path.name, 'meta': dict(meta)}
        self.data['images'][key] = item
        self._commit()
        result = (path, {'order': order, 'filename': path.name, **meta})
        self._verified[(key,order,source_url)] = result
        return result

    def reuse(self, key: str, order: int, source_url: str):
        """Never trust checkpoint alone; hash and decode the exact file once."""
        key = str(key)
        cache_key = (key, order, source_url)
        if cache_key in self._verified:
            return self._verified[cache_key]
        item = self.data.get('images', {}).get(key)
        if not isinstance(item, dict) or (item.get('key') != key or
                item.get('order') != order or item.get('url') != source_url):
            return None
        meta = item.get('meta')
        if not isinstance(meta, dict) or meta.get('source_url') != source_url:
            return None
        filename = item.get('filename', '')
        if not isinstance(filename, str) or not re.fullmatch(r'\d{4,}\.(jpg|jpeg|png|webp|gif|avif|bmp)', filename, re.I):
            return None
        if Path(filename).stem != f'{order:04d}':
            return None
        path = self.directory / filename
        try:
            raw = path.read_bytes()
            if len(raw) != meta.get('bytes') or hashlib.sha256(raw).hexdigest() != meta.get('sha256'):
                return None
            with Image.open(io.BytesIO(raw)) as img:
                if (img.size != (meta.get('width'), meta.get('height')) or
                        (img.format or '').lower() != str(meta.get('format', '')).lower().replace('jpg','jpeg')):
                    return None
                img.verify()
        except (OSError, ValueError, TypeError):
            return None
        result = (path, {'order': order, 'filename': filename, **meta})
        self._verified[cache_key] = result
        return result

    def verified_prefix(self, slot_order, seen):
        """Count validated leading pages whose current DOM keys and URLs match.

        A partial forward run may not have a full catalog yet. We can still
        jump to the first missing slot, but never skip an unverified prefix.
        """
        count = 0
        for i, key in enumerate(slot_order, 1):
            url = seen.get(key, {}).get('url')
            if not url or self.reuse(key, i, url) is None:
                break
            count += 1
        return count

    def record_catalog(self, slot_order, seen):
        """Only a complete, ordered, URL-bearing DOM at bottom can be cached."""
        if (not slot_order or len(set(slot_order)) != len(slot_order) or
                set(slot_order) != set(seen)):
            return False
        catalog = [{'key': str(key), 'url': str(seen[key]['url'])} for key in slot_order]
        if any(not x['url'].startswith(('https://','http://')) for x in catalog):
            return False
        if self.data.get('catalog') != catalog:
            self.data['catalog'] = catalog
            self._commit()
        return True

    def catalog_matches(self, slot_order, seen, expected):
        """Resume without forward scroll only if current DOM exactly matches
        a catalog observed at the true bottom on a previous run."""
        catalog = self.data.get('catalog')
        if not isinstance(catalog,list) or not catalog or len(catalog) != expected or len(slot_order) != expected:
            return False
        return catalog == [{'key':str(key), 'url':str(seen.get(key, {}).get('url',''))} for key in slot_order]
