"""Paired, loopback-only WebExtension transport for an already-open normal browser.

The Python bridge never controls a browser through WebDriver or CDP. A separate,
user-approved Chromium extension may inspect already-loaded image responses in
the one explicitly paired tab. No cookie extraction, fingerprint changes,
challenge solving, remote listener, or access to unrelated tabs. Site extraction
belongs to the single site_adapter; only generic page/byte operations live here.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import queue
import secrets
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

BRIDGE_HOST = '127.0.0.1'
BRIDGE_PORT = 18765
BRIDGE_PROTOCOL = "visual-transfer-2"  # Requires working probe and rendered-image transport.
MAX_RESPONSE = 110 * 1024 * 1024


class BrowserBridgeError(RuntimeError):
    pass


def bridge_recovery_reason(exc):
    """Classify only transport failures, never access, image or integrity errors."""
    if not isinstance(exc, BrowserBridgeError):
        return None
    message = str(exc)
    if 'stopped responding during ' in message and '(no heartbeat)' in message:
        return 'lost_extension_heartbeat'
    if message == 'Browser extension not connected':
        return 'extension_disconnected'
    if message.startswith('Browser scroll failed:') and 'SCROLL_NOT_READY:' in message:
        return 'managed_tab_not_ready'
    # The scroll ledger deliberately stops on an ambiguous relative operation.
    # Keep its fail-closed behavior, and do not retry source/security failures.
    if 'SCROLL_OUTCOME_UNKNOWN' in message or 'SCROLL_DOCUMENT_CHANGED' in message or 'SCROLL_UNVERIFIED' in message or 'SCROLL_OUTCOME_UNVERIFIED' in message:
        return None
    if message.startswith(('Browser recover_image failed:', 'Browser image failed:',
                           'Browser snapshot failed:', 'Browser classify failed:',
                           'Browser page failed:', 'Browser scroll failed:',
                           'Browser probe failed:', 'Browser image_diagnostics failed:',
                           'Browser script_scroll failed:', 'Browser script_plan failed:',
                           'Browser script_download_status failed:', 'Browser script_capabilities failed:',
                           'Browser script_download_start failed:', 'Browser script_resource_prepare failed:',
                           'Browser script_resource_read failed:', 'Browser script_resource_position failed:')) and 'Selected-tab browser API stalled:' in message:
        return 'selected_tab_api_stalled'
    if message.startswith(('Browser recover_image did not respond within ',
                           'Browser page did not respond within ',
                           'Browser image_diagnostics did not respond within ',
                           'Browser probe did not respond within ',
                           'Browser script_scroll did not respond within ',
                           'Browser script_plan did not respond within ',
                           'Browser script_download_start did not respond within ',
                           'Browser script_download_status did not respond within ',
                           'Browser script_capabilities did not respond within ', 'Browser script_resource_prepare did not respond within ',
                           'Browser script_resource_read did not respond within ', 'Browser script_resource_position did not respond within ')):
        return 'browser_rpc_timeout'
    return None


class BrowserTransportUnavailable(BrowserBridgeError):
    """The live managed-tab transport, not the requested image, failed."""
    requires_bridge_reconnect = True


def _bridge_rpc_error(message):
    error = BrowserBridgeError(message)
    if bridge_recovery_reason(error):
        return BrowserTransportUnavailable(message)
    return error


class BrowserManagedTabRecycled(BrowserBridgeError):
    """The managed tab transport was resynchronized; restart the scan."""
    pass


@dataclass
class BrowserResponse:
    url: str
    status: int
    headers: dict
    data: bytes = b''
    capture_method: str = 'original-response'

    @property
    def ok(self):
        return 200 <= self.status < 300

    def body(self):
        return self.data


class LocalBridge:
    def __init__(self, source_url, *, reader_selectors=(), image_attributes=(),
                 image_hosts=(), port=BRIDGE_PORT, initial_chapter_url=None,
                 require_managed_tab=False, rendered_image_selector=None, rendered_image_validator=None):
        self.source = urlsplit(source_url)
        self.allowed_site = self.source.hostname.lower()
        self.allowed_cdn = {h.lower() for h in image_hosts}
        # Optional adapter opt-in; no new host permissions or HTTP access.
        self.rendered_image_selector = (rendered_image_selector if isinstance(rendered_image_selector, str)
                                        and 0 < len(rendered_image_selector) <= 180 else None)
        self.rendered_image_validator = rendered_image_validator
        self.initial_chapter_url = self.validate_chapter(initial_chapter_url or source_url)
        self.require_managed_tab = bool(require_managed_tab)
        self.tab_id = None
        self.reader_selectors = list(reader_selectors)
        self.image_attributes = list(image_attributes)
        self.port = port
        # Rotated for every run; the extension obtains it itself from /bootstrap.
        # Only a locally installed browser extension may request bootstrap.
        self.secret = secrets.token_urlsafe(32)
        # Unprivileged per-run identifier: a changed source or extension manifest
        # must take effect during THIS run, not only after restarting Python.
        self.startup_nonce = secrets.token_hex(16)
        self.require_startup_refresh = False
        self.startup_reader_verified = False
        self.startup_navigation_consumed = False
        self.pending = queue.Queue()
        self.responses = {}
        self.responses_lock = threading.Lock()
        self.ready = threading.Event()
        self.outdated_client = threading.Event()
        self.outdated_reason = ''
        self.outdated_first_seen = None
        self.last_heartbeat = time.monotonic()
        self.tab_url = None
        self.tab_title = ''  # Extension-owned Chrome tab title for native dialog isolation.
        self.server = None
        self.thread = None
        # Bound only after a protocol-valid /hello, never on an unauthenticated
        # bootstrap request. This prevents an outdated/abandoned extension from
        # monopolizing a newly started Python bridge.
        self.extension_origin = None
        self.extension_client = None
        self.extension_origin_lock = threading.Lock()

    def validate_chapter(self, url):
        parsed = urlsplit(url)
        # Do not cross domains or switch to HTTP from a normal HTTPS page.
        if parsed.scheme != 'https' or parsed.hostname != self.allowed_site:
            raise BrowserBridgeError('Chapter navigation outside the selected source domain')
        return url

    def validate_image(self, url):
        parsed = urlsplit(url)
        if parsed.scheme != 'https' or parsed.hostname not in ({self.allowed_site} | self.allowed_cdn):
            if not self.rendered_only_selector(url):
                raise BrowserBridgeError('Image host not authorized by the site adapter: ' + str(parsed.hostname))
        return url

    def rendered_only_selector(self, url):
        """Unknown CDN URLs may ONLY use the scoped decoded-reader pixel path."""
        try:
            parsed = urlsplit(url)
            port = parsed.port
        except (ValueError, TypeError):
            return None
        if parsed.hostname in ({self.allowed_site} | self.allowed_cdn):
            return None
        if (parsed.scheme == 'https' and not parsed.username and not parsed.password
                and port is None and self.rendered_image_selector
                and callable(self.rendered_image_validator) and self.rendered_image_validator(url)):
            return self.rendered_image_selector
        return None

    def start(self):
        bridge = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                return  # Prevent token and URLs in local access logs.

            def _origin(self):
                origin = self.headers.get('Origin', '')
                if not origin:
                    # Privileged background fetches sometimes omit Origin entirely.
                    # Authentication still requires a cryptographically random token.
                    return True
                return (origin.startswith('chrome-extension://') or
                        origin.startswith('moz-extension://')) and '\\' not in origin and '/' not in origin.split('://',1)[1]

            def _client_id(self):
                # The extension identity is not a secret; it separates browser
                # installations. The random per-run token remains authentication.
                client = self.headers.get('X-Comic-Bridge-Client', '')
                return client if (8 <= len(client) <= 200 and
                                  all(c.isascii() and (c.isalnum() or c in '._@{}-') for c in client)) else ''

            def _cors(self):
                origin = self.headers.get('Origin', '')
                if origin and self._origin():
                    self.send_header('Access-Control-Allow-Origin', origin)
                    self.send_header('Vary', 'Origin')
                    self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
                    self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Comic-Bridge-Token, X-Comic-Bridge-Bootstrap, X-Comic-Bridge-Client')
                    self.send_header('Access-Control-Max-Age', '300')
                self.send_header('Cache-Control', 'no-store')

            def _send(self, status, obj=None):
                payload = json.dumps(obj or {}, separators=(',', ':')).encode('utf-8')
                self.send_response(status)
                self._cors()
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def _auth(self):
                if not self._origin():
                    self._send(403, {'error': 'Only browser extension origins are allowed'})
                    return False
                client = self._client_id()
                if not client:
                    self._send(403, {'error': 'Comic Bridge 1.5.1+ extension required (missing client identity)'})
                    return False
                with bridge.extension_origin_lock:
                    if bridge.extension_client and client != bridge.extension_client:
                        self._send(403, {'error': 'Another Comic Bridge extension owns this Python run'})
                        return False
                    if (bridge.extension_origin and self.headers.get('Origin', '') and
                            self.headers.get('Origin') != bridge.extension_origin):
                        self._send(403, {'error': 'Another Comic Bridge extension origin owns this Python run'})
                        return False
                if not secrets.compare_digest(self.headers.get('X-Comic-Bridge-Token', ''), bridge.secret):
                    self._send(401, {'error': 'Expired local bridge token; reconnect automatically'})
                    return False
                return True

            def do_OPTIONS(self):
                if not self._origin():
                    self._send(403, {'error': 'Extension origin required'})
                    return
                self.send_response(204)
                self._cors()
                self.send_header('Content-Length', '0')
                self.end_headers()

            def do_GET(self):
                if self.path == '/bootstrap':
                    # Chrome/Edge extension background fetches sometimes omit
                    # Origin on localhost GET. A privileged extension provides
                    # two non-simple headers instead. Ordinary web pages cannot
                    # send these without a CORS preflight, which is *not*
                    # approved for web page origins. Never allow bare requests.
                    origin = self.headers.get('Origin', '')
                    if (self.headers.get('X-Comic-Bridge-Bootstrap') != '1' or
                            not self._client_id() or not self._origin()):
                        self._send(403, {'error':
                            'Bootstrap requires updated Comic Bridge extension headers; '
                            'reload the unpacked 1.5.1 extension'})
                        return
                    with bridge.extension_origin_lock:
                        if bridge.extension_client and self._client_id() != bridge.extension_client:
                            self._send(403, {'error': 'Another Comic Bridge extension owns this Python run'})
                            return
                        if bridge.extension_origin and origin and origin != bridge.extension_origin:
                            self._send(403, {'error': 'Another Comic Bridge origin owns this Python run'})
                            return
                    # Do not claim ownership here: only /hello with the current
                    # protocol and permitted chapter URL may claim ownership.
                    self._send(200, {'token': bridge.secret, 'port': bridge.port,
                                     'site': bridge.allowed_site,
                                     'startup_url': bridge.initial_chapter_url,
                                     'startup_nonce': bridge.startup_nonce,
                                     'protocol': BRIDGE_PROTOCOL})
                    return
                if not self._auth():
                    return
                if self.path == '/next':
                    bridge.last_heartbeat = time.monotonic()
                    try:
                        command = bridge.pending.get_nowait()
                    except queue.Empty:
                        self._send(200, {'command': None})
                    else:
                        self._send(200, {'command': command})
                elif self.path == '/health':
                    self._send(200, {'paired': bridge.ready.is_set()})
                else:
                    self._send(404, {'error': 'Unknown bridge endpoint'})

            def do_POST(self):
                if not self._auth():
                    return
                length = int(self.headers.get('Content-Length', '0') or '0')
                if length < 1 or length > MAX_RESPONSE:
                    self._send(413, {'error': 'Request size invalid'})
                    return
                try:
                    obj = json.loads(self.rfile.read(length))
                    if self.path == '/hello':
                        # Do NOT accept the /hello request from an older installed
                        # extension: it has no probe/image-byte protocol, and would
                        # previously report connected then crash before scrolling.
                        if (obj.get('bridge_protocol') != BRIDGE_PROTOCOL or
                                not {'probe', 'image', 'content-v2'}.issubset(set(obj.get('capabilities') or []))):
                            bridge.outdated_reason = 'Old image-transfer protocol or missing capabilities'
                            bridge.outdated_first_seen = bridge.outdated_first_seen or time.monotonic()
                            bridge.outdated_client.set()
                            self._send(409, {'error':
                                'OUTDATED COMIC BRIDGE EXTENSION: the running Chrome extension does not support '
                                'the image-transfer proof. Remove any previous Comic Bridge extension, load the '
                                'unpacked browser_bridge/chrome folder from this project, then restart run.py. '
                                'Do not refresh or close your comic webpage tab.'})
                            return
                        if (bridge.require_startup_refresh and
                                obj.get('startup_refresh_revision') != 1):
                            bridge.outdated_reason = 'Missing startup_refresh_revision: 1'
                            bridge.outdated_first_seen = bridge.outdated_first_seen or time.monotonic()
                            bridge.outdated_client.set()
                            self._send(409, {'error':
                                'OUTDATED COMIC BRIDGE STARTUP: extension runtime has not loaded the '
                                'automatic first-run refresh. Reload the unpacked Comic Bridge once '
                                'at chrome://extensions, then restart run.py. Future site/code '
                                'changes will refresh automatically.'})
                            return
                        if bridge.require_managed_tab and (
                                obj.get('tab_ownership') != 'extension-managed' or
                                not isinstance(obj.get('tab_id'), int) or
                                isinstance(obj.get('tab_id'), bool) or
                                obj['tab_id'] < 0):
                            bridge.outdated_reason = 'Missing or invalid extension-managed tab identity'
                            bridge.outdated_first_seen = bridge.outdated_first_seen or time.monotonic()
                            bridge.outdated_client.set()
                            self._send(409, {'error':
                                'Comic Bridge extension must own the automatic chapter tab. '
                                'Reload the updated unpacked extension at chrome://extensions '
                                'before restarting run.py.'})
                            return
                        url = bridge.validate_chapter(str(obj.get('url', '')))
                        # A resumed run may have 18 verified chapters but its saved
                        # source seed still names Chapter 00. Bind ONLY after the
                        # extension reaches the first unfinished chapter. Do not
                        # constrain later /hello calls used by tab recycling.
                        if bridge.require_managed_tab and not bridge.ready.is_set():
                            expected = urlsplit(bridge.initial_chapter_url)
                            original = bridge.source
                            if ((expected.path.rstrip('/'), expected.query) !=
                                    (original.path.rstrip('/'), original.query)):
                                actual = urlsplit(url)
                                if ((actual.path.rstrip('/'), actual.query) !=
                                        (expected.path.rstrip('/'), expected.query)):
                                    self._send(409, {'error':
                                        'BROWSER_RESUME_TARGET_NOT_READY: managed tab must first load the '
                                        'requested unfinished chapter before pairing; original seed is not a resume target'})
                                    return
                        with bridge.extension_origin_lock:
                            # Ownership begins only after validation succeeds.
                            # Locking the client also works if Chrome omits Origin.
                            client = self._client_id()
                            origin = self.headers.get('Origin', '')
                            if bridge.extension_client and bridge.extension_client != client:
                                self._send(403, {'error': 'Another Comic Bridge extension owns this Python run'})
                                return
                            if bridge.extension_origin and origin and bridge.extension_origin != origin:
                                self._send(403, {'error': 'Another Comic Bridge origin owns this Python run'})
                                return
                            bridge.extension_client = client
                            if origin:
                                bridge.extension_origin = origin
                        bridge.tab_id = obj.get('tab_id') if bridge.require_managed_tab else None
                        bridge.tab_url = url
                        bridge.tab_title = str(obj.get('tab_title') or '')[:200]
                        bridge.last_heartbeat = time.monotonic()
                        bridge.ready.set()
                        bridge.outdated_client.clear()
                        bridge.outdated_reason = ''
                        bridge.outdated_first_seen = None
                        self._send(200, {'ok': True, 'source': bridge.allowed_site,
                                         'bridge_protocol': BRIDGE_PROTOCOL})
                    elif self.path == '/heartbeat':
                        bridge.last_heartbeat = time.monotonic()
                        self._send(200, {'ok': True})
                    elif self.path == '/result':
                        bridge.last_heartbeat = time.monotonic()
                        ident = str(obj.get('id', ''))
                        with bridge.responses_lock:
                            dest = bridge.responses.get(ident)
                        if dest is None:
                            self._send(404, {'error': 'Unknown operation'})
                        else:
                            dest.put(obj)
                            self._send(200, {'ok': True})
                    else:
                        self._send(404, {'error': 'Unknown endpoint'})
                except (ValueError, TypeError, BrowserBridgeError) as exc:
                    self._send(400, {'error': str(exc)[:300]})

        try:
            self.server = ThreadingHTTPServer((BRIDGE_HOST, self.port), Handler)
        except OSError as exc:
            raise BrowserBridgeError('Local bridge port 18765 is already in use. Close another archiver or set '
                                     'COMIC_ARCHIVER_BRIDGE_PORT to an unused local port.') from exc
        self.port = self.server.server_port
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def wait_paired(self, timeout_seconds=None):
        # Only automatic transport recovery has a pairing deadline. Ordinary
        # first-run pairing keeps its existing unlimited human setup window.
        started_pairing = time.monotonic()
        print('\nBROWSER EXTENSION BRIDGE - USE YOUR CURRENT NORMAL BROWSER', flush=True)
        print(f'  Local port: {self.port}', flush=True)
        print('  AUTO CONNECT: no pairing code and no chapter-by-chapter reconnect.', flush=True)
        print('  Python starts normal Chrome; the extension opens its own chapter tab.', flush=True)
        print('  The installed extension connects ONLY to its managed tab.', flush=True)
        root = Path(__file__).resolve().parents[1]
        print('  CHROME / EDGE: chrome://extensions -> Developer mode -> Load unpacked:',
              str(root / 'browser_bridge' / 'chrome'), flush=True)
        print('  FIREFOX: about:debugging#/runtime/this-firefox -> Load Temporary Add-on ->',
              str(root / 'browser_bridge' / 'firefox' / 'manifest.json'), flush=True)
        if self.allowed_cdn:
            print('  IMPORTANT: This CDN-backed source requires Chrome/Edge (NOT Firefox).', flush=True)
            print('  Chrome can capture visible image pixels even when original image bytes cannot be inspected.', flush=True)
        print('  The installed extension selects or creates the requested chapter tab.', flush=True)
        print('  The local listener accepts extension traffic only on 127.0.0.1.', flush=True)
        last = 0
        while not self.ready.wait(0.5):
            if (timeout_seconds is not None and
                    time.monotonic() - started_pairing >= timeout_seconds):
                raise BrowserBridgeError(
                    'BROWSER_BRIDGE_RECONNECT_TIMEOUT: extension did not pair with the '
                    'requested unfinished chapter within the bounded recovery window. '
                    'Verified GitHub chapters and image checkpoints remain untouched. '
                    'Reload Comic Bridge in chrome://extensions then restart run.py.')
            if self.outdated_client.is_set():
                # A stale worker may answer first, before its self-refresh
                # completes. Keep rejecting its /hello; allow a NEW fully valid
                # /hello to pair within this bounded grace window.
                elapsed = time.monotonic() - (self.outdated_first_seen or started_pairing)
                if elapsed >= 25:
                    raise BrowserBridgeError(
                        'OUTDATED COMIC BRIDGE EXTENSION: no compatible re-pair within 25s. '
                        'Last rejected handshake: ' + (self.outdated_reason or 'unknown') +
                        '. Reload the existing unpacked extension; do not remove it.')
            if time.monotonic() - last > 30:
                print('Browser bridge: waiting for automatic extension connection (check extension is loaded)...', flush=True)
                last = time.monotonic()
        print('Browser bridge connected to:', self.tab_url, flush=True)
        if self.require_managed_tab:
            print('BROWSER_MANAGED_TAB_BOUND: tab_id=' + str(self.tab_id) +
                  ' (not an older manually opened tab)', flush=True)

    def rpc(self, action, payload=None, timeout=None):
        """Wait as long as the extension stays responsive; never cap total job time.

        JS has a separate short watchdog for a *single stalled browser API*.
        A dead service worker must not leave Python blocked forever, and any
        late reply to an abandoned operation is rejected by /result.
        """
        if not self.ready.is_set():
            raise _bridge_rpc_error('Browser extension not connected')
        ident = uuid.uuid4().hex
        q = queue.Queue(maxsize=1)
        with self.responses_lock:
            self.responses[ident] = q
        started = time.monotonic()
        native_dialog_watcher = None
        # Fast successful image/scroll RPCs do not start PowerShell. Arm an
        # independent watcher only for navigation or genuinely slow browser I/O.
        # Title is the latest verified managed-document title, not the seed.
        def arm_dialog_watcher():
            from .native_dialogs import ManagedNativeDialogWatcher
            return ManagedNativeDialogWatcher(
                self.tab_title, timeout=min(120, (timeout or 105) + 5)).start()
        try:
            if action == 'navigate' and self.require_managed_tab:
                native_dialog_watcher = arm_dialog_watcher()
            self.pending.put({'id': ident, 'action': action, 'payload': payload or {}})
            while True:
                try:
                    result = q.get(timeout=3.0)
                    break
                except queue.Empty as exc:
                    now = time.monotonic()
                    if (native_dialog_watcher is None and self.require_managed_tab
                            and action in ('scroll', 'recover_image', 'image', 'snapshot', 'page', 'classify')
                            and now - started >= 9):
                        native_dialog_watcher = arm_dialog_watcher()
                    if now - self.last_heartbeat > 30:
                        raise _bridge_rpc_error(
                            f'Comic Bridge stopped responding during {action} (no heartbeat); '
                            'the extension may have been suspended or its tab closed. '
                            'Restart run.py to resume this unverified chapter.') from exc
                    # Explicit caller timeouts remain available for short UI
                    # operations; image and scroll use timeout=None.
                    if timeout is not None and now - started > timeout:
                        raise _bridge_rpc_error(
                            f'Browser {action} did not respond within {timeout}s') from exc
            if not result.get('ok'):
                raise _bridge_rpc_error(f'Browser {action} failed: {str(result.get("error", "unknown"))[:500]}')
            data = result.get('data') or {}
            if (action == 'navigate' and self.require_managed_tab
                    and self.tab_id is not None and data.get('tab_id') == self.tab_id
                    and isinstance(data.get('tab_title'), str)):
                # A matching tab id is not enough: the reply must identify the
                # exact requested chapter, after the extension's destination PING.
                requested = urlsplit(str((payload or {}).get('url') or ''))
                actual = urlsplit(str(data.get('url') or ''))
                if (requested.scheme, requested.netloc, requested.path, requested.query) == (
                        actual.scheme, actual.netloc, actual.path, actual.query):
                    self.tab_title = data['tab_title'][:200]
                    print('BROWSER_DIALOG_TITLE_UPDATED: '+repr(self.tab_title), flush=True)
            return data
        finally:
            if native_dialog_watcher is not None:
                native_dialog_watcher.close()
            with self.responses_lock:
                self.responses.pop(ident, None)

    def close(self):
        if self.server:
            self.server.shutdown()
            self.server.server_close()
            self.thread.join(timeout=3)
            self.server = None


class BridgePage:
    is_native_firefox = False

    def __init__(self, context):
        self.context = context
        self.url = context.bridge.tab_url

    def goto(self, url, wait_until=None, timeout=50000):
        self.context.bridge.validate_chapter(url)
        # The extension already opened, paired with, and transferred verified
        # image bytes from the first unfinished chapter. Do not force a second
        # navigation to the SAME document on first acquisition: that redundant
        # reload can hang on a cold Chrome tab, despite a valid reader.
        bridge = self.context.bridge
        from urllib.parse import urlsplit
        def same_document(a, b):
            x, y = urlsplit(str(a or '')), urlsplit(str(b or ''))
            return ((x.scheme, x.netloc, x.path.rstrip('/'), x.query) ==
                    (y.scheme, y.netloc, y.path.rstrip('/'), y.query))
        if not bridge.startup_navigation_consumed:
            bridge.startup_navigation_consumed = True
            if (bridge.startup_reader_verified and
                    same_document(url, bridge.initial_chapter_url) and
                    same_document(url, bridge.tab_url) and
                    same_document(url, self.url)):
                print('BROWSER_STARTUP_DOCUMENT_REUSED: verified initial reader; no redundant reload', flush=True)
                return BrowserResponse(url, 200, {})
        data = bridge.rpc('navigate', {'url': url}, timeout=max(90, timeout / 1000 + 50))
        self.url = data.get('url', url)
        self.context.bridge.validate_chapter(self.url)
        return BrowserResponse(self.url, int(data.get('status', 200)), {})

    def content(self):
        data = self.context.bridge.rpc('page', timeout=90)
        self.url = data.get('url', self.url)
        self._last_html = data['html']
        return data['html']

    def reader_ready(self):
        """Read-only proof that the active tab contains a decoded reader image.

        Site selectors/hosts are injected from the single site adapter. No
        navigation, image request, forced loading, or scroll occurs here.
        """
        from urllib.parse import urljoin
        from bs4 import BeautifulSoup
        if self.context.reader_selectors:
            # content() has just refreshed this snapshot in the passive loop.
            current_html = getattr(self, '_last_html', '')
            if not current_html:
                return False
            try:
                soup = BeautifulSoup(current_html, 'html.parser')
                if not any(soup.select_one(selector) is not None
                           for selector in self.context.reader_selectors):
                    return False
            except Exception:
                return False
        data = self.context.bridge.rpc('snapshot', {
            'reader_selectors': self.context.reader_selectors,
            'image_attributes': self.context.image_attributes,
        }, timeout=30)
        for im in data.get('imgs') or []:
            if not (im.get('loaded') and int(im.get('width') or 0) > 0 and
                    int(im.get('height') or 0) > 0 and im.get('url')):
                continue
            try:
                self.context.bridge.validate_image(urljoin(self.url, im['url']))
                return True
            except BrowserBridgeError:
                # A decoded image can be an in-memory blob: created by the
                # *same* verified source tab (e.g. browser-native image viewer).
                # It must never be treated as an HTTP download URL. This is
                # passive readiness evidence only; image transfer still needs
                # actual bytes and SHA-256 verification by the generic engine.
                candidate = urlsplit(str(im['url']))
                if candidate.scheme == 'blob':
                    origin = urlsplit(candidate.path)
                    if (origin.scheme == 'https' and
                            origin.hostname == self.context.bridge.allowed_site):
                        return True
                continue
        return False

    def evaluate(self, script):
        # Intentional: never eval untrusted dynamic JavaScript in a browser
        # extension. Translate the reusable crawler's fixed operations.
        if 'iframe[src*="captcha"' in script or 'form input[type=password]' in script:
            return self.context.bridge.rpc('classify')
        if 'scrollTo(' in script or 'scrollBy(' in script:
            result = self.context.bridge.rpc('scroll')
            # A normal scroll returns its numeric scroll offset; only a
            # recycled-tab notification is a mapping. Do not call .get() on
            # a scalar success response (1.5.17 regression).
            if isinstance(result, dict) and result.get('transport_reset'):
                # Do not continue using the former document's DOM/order/cache.
                if result.get('url'):
                    self.url = self.context.bridge.validate_chapter(result['url'])
                raise BrowserManagedTabRecycled('Browser transport resynchronized after a stalled scroll; re-scan from checkpoint')
            return result
        if 'return {imgs' in script or 'imgs:data' in script or 'MutationObserver' in script:
            payload = {'reader_selectors': self.context.reader_selectors,
                       'image_attributes': self.context.image_attributes}
            result = self.context.bridge.rpc('snapshot', payload)
            # A verified reader expecting image slots may be temporarily showing
            # a self-clearing interstitial. Do not touch the browser during the
            # one quiet interval; retry the exact original snapshot just once.
            # Existing empty unproven pages and partially loaded slots are unchanged.
            if not (result.get('imgs') or []) and getattr(self, '_expect_reader_images', False):
                _quiet_reader_image_wait('expected chapter image slots temporarily absent')
                result = self.context.bridge.rpc('snapshot', payload)
                if not (result.get('imgs') or []):
                    raise BrowserBridgeError(
                        'Expected chapter image list is still empty after a single '
                        'quiet 10-second wait. Stopping this chapter without more '
                        'scrolling, page reloads or publication. If the source '
                        'has a real verification screen, complete it normally.')
            return result
        raise BrowserBridgeError('Unsupported browser script. Use the documented generic DOM operations.')

    def recover_unloaded_image(self, key, url, *, force_position=False, refresh_source=False):
        """Target only the missing ordinal in the original reader, never a new tab."""
        return self.context.bridge.rpc('recover_image', {
            'key': str(key), 'url': str(url or ''),
            'force_position': bool(force_position),
            'refresh_source': bool(refresh_source),
            'reader_selectors': self.context.reader_selectors,
            'image_attributes': self.context.image_attributes,
        }, timeout=55)

    def image_diagnostics(self, url):
        """Read status cached by the EXISTING tab's Chrome Network observer.

        No DevTools window, page navigation, direct CDN request or credential
        read is required. Source allowlists still apply in the bridge.
        """
        bridge = self.context.bridge
        payload = {'url': str(url)}
        selector = getattr(bridge, 'rendered_only_selector', lambda _:None)(url)
        if selector:
            payload['rendered_reader_selector'] = selector
        return bridge.rpc('image_diagnostics', payload, timeout=8)

    def wait_for_timeout(self, ms):
        time.sleep(max(0, ms) / 1000)

    def locator(self, selector):
        class EmptyLocator:
            def count(self):
                return 0
        return EmptyLocator()

    def close(self):
        pass  # NEVER close the human's browser tab.


class BridgeRequest:
    # The cross-origin image path transfers pixels/response bytes ALREADY
    # loaded by the chosen normal browser tab; it creates no new CDN request.
    reuses_loaded_page_images = True

    def __init__(self, context):
        self.context = context

    def get(self, url, headers=None, timeout=45000):
        self.context.bridge.validate_image(url)
        selector = getattr(self.context.bridge, 'rendered_only_selector', lambda _:None)(url)
        payload = {'url': url}
        if selector:
            payload['rendered_reader_selector'] = selector
        result = self.context.bridge.rpc('image', payload)
        if selector and (result.get('via') != 'rendered-png' or result.get('url') != url or
                         result.get('rendered_reader_revision') != 'scoped-rendered-reader-v1'):
            raise BrowserBridgeError('Scoped rendered-reader transfer failed or extension is outdated; reload Comic Bridge. No unapproved CDN fetch attempted.')
        # A 403 from an image CDN is NOT proof that the chapter needs another
        # Cloudflare challenge. The document is already accessible. Repeating
        # the human chapter check cannot grant access to an extension-origin
        # request. Fail clearly unless the browser could return loaded bytes.
        status = int(result.get('status', 0))
        if status in (401, 403, 424):
            from .source_session import SourceAccessPaused
            host = urlsplit(url).hostname
            diag = result.get('diagnostics') or {}
            tab = diag.get('tabImage') or {}
            if tab.get('found') and tab.get('loaded'):
                tab_note = 'Browser confirms the image is decoded and displayed, but its original response bytes were not recoverable.'
            elif tab.get('found'):
                tab_note = 'Browser image element exists, but the original image has not loaded (naturalWidth=0).'
            else:
                tab_note = 'Requested image URL not found in the paired tab; check the source image URL mapping.'
            raise SourceAccessPaused(
                f'Image CDN {host} original response bytes unavailable (browser status {status}). '
                f'{tab_note} '
                f'Loaded-response inspection (debugger attached={bool(diag.get("debuggerAttached"))}, '
                f'captured={int(diag.get("capturedImages") or 0)}, '
                f'failed={int(diag.get("captureFailures") or 0)}). '
                'Use Chrome/Edge (not Firefox), grant Comic Bridge debugger access, close DevTools for the selected tab, and reconnect. '
                'If capture is attached but the image is still unavailable, the browser did not provide its original bytes; no image will be falsely archived. '
                'No alternative identity, proxy, or challenge bypass was attempted.'
            )
        data = base64.b64decode(result.get('base64', ''), validate=True)
        if len(data) > 100 * 1024 * 1024:
            raise BrowserBridgeError('Image exceeds maximum supported size')
        return BrowserResponse(result.get('url', url), int(result.get('status', 0)),
                               result.get('headers', {}), data, result.get('via', 'original-response'))


class BridgeContext:
    def __init__(self, bridge, reader_selectors, image_attributes):
        self.bridge = bridge
        self.reader_selectors = list(reader_selectors)
        self.image_attributes = list(image_attributes)
        self.pages = [BridgePage(self)]
        self.request = BridgeRequest(self)
        self._closed = False

    def new_page(self):
        # Engine calls this for discovery/chapter lifecycle. Never create tabs.
        return self.pages[0]

    def close(self):
        # Engine finally blocks call ctx.close() BEFORE the contextmanager
        # unwinds. Release the owned tab while the RPC listener is still alive.
        # Idempotent: the contextmanager also calls close on its way out.
        if self._closed:
            return
        self._closed = True
        bridge = self.bridge
        try:
            if bridge.require_managed_tab and bridge.ready.is_set() and isinstance(bridge.tab_id, int):
                try:
                    receipt = bridge.rpc('release_managed_reader', {}, timeout=20)
                    if receipt.get('closed') is True and receipt.get('tab_id') == bridge.tab_id:
                        print('BROWSER_RETRY_TAB_CLEANUP: ' + str(receipt), flush=True)
                    else:
                        print('BROWSER_RETRY_TAB_CLEANUP_DEFERRED: ' + str(receipt), flush=True)
                except Exception as cleanup_error:
                    print('BROWSER_RETRY_TAB_CLEANUP_DEFERRED: ' + str(cleanup_error), flush=True)
        finally:
            bridge.close()


# The probe validates the screenshot transport, not the separate exact-image
# action used by checkpointed chapter downloads. A Chrome unpacked extension
# can still be running its *old* background service worker after files change.
# Verify the actual loaded handler for blob-backed pages BEFORE any crawling.
BLOB_TRANSFER_HANDLER_REVISION = 'decoded-blob-fallback-diagnostics-v1'


def verify_live_blob_transfer(bridge, proof, reader_selectors):
    """Verify the real extension's exact-blob action, never a simulated file check.

    All source-specific selectors are provided by site_adapter.py. Ordinary
    HTTPS image readers keep their previous fast proof path unchanged.
    """
    image_url = str(proof.get('url') or '')
    if not image_url.startswith('blob:'):
        return None
    # Recheck the blob belongs to the *same active managed tab*, not merely
    # the same host as a past chapter or another browser tab.
    active = urlsplit(str(bridge.tab_url or ''))
    if active.scheme != 'https' or not active.netloc or not image_url.startswith(
            'blob:' + active.scheme + '://' + active.netloc + '/'):
        raise BrowserBridgeError('BROWSER_BLOB_PREFLIGHT_FAILED: blob image origin does not match the managed tab')
    if not reader_selectors:
        raise BrowserBridgeError('BROWSER_BLOB_PREFLIGHT_FAILED: missing adapter reader selectors')
    try:
        reply = bridge.rpc('read_loaded_blob', {
            'url': image_url, 'reader_selectors': list(reader_selectors)}, timeout=80)
    except BrowserBridgeError as exc:
        raise BrowserBridgeError(
            'BROWSER_BLOB_PREFLIGHT_FAILED: exact-image transfer command failed BEFORE archiving: '
            + str(exc)[:280] + '. Verify the installed extension path and reload Comic Bridge '
            'in chrome://extensions; restart python run.py.') from exc
    revision = str(reply.get('bridge_revision') or '')
    if revision != BLOB_TRANSFER_HANDLER_REVISION:
        raise BrowserBridgeError(
            'BROWSER_EXTENSION_STALE_RUNTIME: screenshot proof succeeded but the running '
            'read_loaded_blob handler does NOT have the installed decoded-image fallback '
            '(revision=' + (revision or 'ABSENT')[:90] + '). Files-on-disk parity cannot '
            'verify an executing Chrome service worker. Reload the correct unpacked Comic Bridge '
            'at chrome://extensions (check its installed path), then restart python run.py. '
            'No chapter download or publication has started.')
    if reply.get('status') != 200 or not reply.get('base64'):
        extra = reply.get('diagnostics') or {}
        if not isinstance(extra, dict):
            extra = {}
        raise BrowserBridgeError(
            'BROWSER_BLOB_PREFLIGHT_FAILED: updated extension is running, but the original '
            'blob read AND its rendered-image fallback could not transfer this exact decoded '
            'panel. original_reason=' + str(reply.get('reason') or 'unknown')[:240]
            + '; pixel_fallback_error=' + str(extra.get('pixelFallbackError') or 'not supplied')[:300]
            + '. No chapter download or publication started.')
    try:
        raw = base64.b64decode(reply['base64'], validate=True)
        from PIL import Image
        import io
        with Image.open(io.BytesIO(raw)) as im:
            fmt, dimensions = im.format, im.size
            im.verify()
    except (ValueError, TypeError, OSError, KeyError) as exc:
        raise BrowserBridgeError('BROWSER_BLOB_PREFLIGHT_FAILED: exact-image action returned invalid image bytes') from exc
    if not raw or len(raw) > 20 * 1024 * 1024 or fmt not in ('PNG', 'JPEG', 'WEBP') or min(dimensions) <= 0:
        raise BrowserBridgeError('BROWSER_BLOB_PREFLIGHT_FAILED: exact-image image size/format invalid')
    via = str(reply.get('via') or '')
    if via == 'rendered-png' and (fmt != 'PNG' or
                                   str((reply.get('headers') or {}).get('content-type', '')).split(';')[0] != 'image/png'):
        raise BrowserBridgeError('BROWSER_BLOB_PREFLIGHT_FAILED: rendered-PNG fallback is not truthful PNG bytes')
    if reply.get('url') != image_url:
        raise BrowserBridgeError('BROWSER_BLOB_PREFLIGHT_FAILED: exact-image action returned a different source URL')
    print('BROWSER_BLOB_CHAPTER_TRANSFER_PROOF: PASS | '
          + str(len(raw)) + ' bytes | ' + str(dimensions[0]) + 'x' + str(dimensions[1])
          + ' | via=' + via + ' | live_revision=' + revision, flush=True)
    return {'via': via, 'dimensions': dimensions, 'bytes': len(raw)}


# Provider-independent grace for a reader that currently has no decoded image.
# During this entire delay Python does not issue browser/extension commands.
QUIET_READER_IMAGE_GRACE_SECONDS = 10


def _quiet_reader_image_wait(reason):
    print('BROWSER_READER_QUIET_WAIT: ' + reason +
          f'; leaving the browser untouched for {QUIET_READER_IMAGE_GRACE_SECONDS}s '
          '(no polling, clicks, scrolls or reloads).', flush=True)
    time.sleep(QUIET_READER_IMAGE_GRACE_SECONDS)


def _probe_with_one_quiet_image_grace(bridge, reader_selectors):
    """Keep the existing proof, retrying only the empty-decoded-image error."""
    payload = {'reader_selectors': list(reader_selectors)}
    selector = getattr(bridge, 'rendered_image_selector', None)
    if isinstance(selector, str) and selector:
        payload['rendered_reader_selector'] = selector
    try:
        return bridge.rpc('probe', payload, timeout=55)
    except BrowserBridgeError as error:
        if 'No decoded CDN image on the selected page' not in str(error):
            raise
    _quiet_reader_image_wait('initial image not decoded yet')
    try:
        return bridge.rpc('probe', payload, timeout=55)
    except BrowserBridgeError as error:
        if 'No decoded CDN image on the selected page' in str(error):
            raise BrowserBridgeError(
                'Source reader still has no decoded image after a single quiet '
                '10-second wait. Stopping without touching the tab again. '
                'If a verification/login page remains, complete it normally; '
                'otherwise check the site adapter reader selectors and reload '
                'the installed extension only if it is outdated.') from error
        raise


@contextmanager
def source_extension_context(data_dir: Path, source_url: str, *,
                             adapter, reader_selectors=(), initial_chapter_url=None,
                             reconnect_timeout=None):
    port = int(os.environ.get('COMIC_ARCHIVER_BRIDGE_PORT') or BRIDGE_PORT)
    ensure_generated_extensions(Path(__file__).resolve().parents[1], adapter, port)
    bridge = LocalBridge(source_url, reader_selectors=reader_selectors,
                         image_attributes=adapter.IMAGE_ATTRIBUTES,
                         image_hosts=getattr(adapter, 'BRIDGE_IMAGE_HOSTS', ()), port=port,
                         initial_chapter_url=initial_chapter_url, require_managed_tab=True,
                         rendered_image_selector=getattr(adapter, 'BRIDGE_RENDERED_IMAGE_SELECTOR', None),
                         rendered_image_validator=getattr(adapter, 'accept_rendered_image_url', None))
    bridge.require_startup_refresh = True
    bridge.start()
    # The loopback listener MUST be ready before opening Chrome: a cold-started
    # service worker can immediately request /bootstrap. Chrome uses the user's
    # ordinary installed profile and the extension already enabled there.
    try:
        if os.environ.get('COMIC_ARCHIVER_NO_AUTO_BROWSER') != '1':
            from .normal_browser_launch import launch_normal_chrome
            command = launch_normal_chrome(bridge.initial_chapter_url, startup_nonce=bridge.startup_nonce)
            print('NORMAL_CHROME_AUTO_OPEN: normal Chrome/Edge ready; '
                  'installed extension owns and navigates the chapter tab: '
                  + bridge.initial_chapter_url, flush=True)
    except Exception:
        bridge.close()
        raise
    ctx = BridgeContext(bridge, reader_selectors, adapter.IMAGE_ATTRIBUTES)
    try:
        if reconnect_timeout is None:
            bridge.wait_paired()
        else:
            bridge.wait_paired(timeout_seconds=reconnect_timeout)
        from .chapter_script import enabled as script_mode_enabled
        if script_mode_enabled(adapter):
            # Feature query only. A managed tab may still be settling after
            # pairing; chapter-specific RPCs validate the actual document.
            result=bridge.rpc('script_capabilities', {}, timeout=30)
            if result.get('revision')!='native-chapter-download-v2':
                raise BrowserBridgeError('SCRIPT_DOWNLOAD: reload current Chrome/Edge extension')
            if getattr(adapter,'CHAPTER_DOWNLOAD_TRANSPORT','native')=='loaded-resource':
                if result.get('loadedResource') is not True:
                    raise BrowserBridgeError('SCRIPT_RESOURCE: reload current Chrome/Edge extension')
                print('BROWSER_LOADED_RESOURCE_MODE: READY',flush=True)
            else:
                if result.get('native') is not True:
                    raise BrowserBridgeError('SCRIPT_DOWNLOAD: native download permission unavailable; reload current Chrome/Edge extension')
                print('BROWSER_NATIVE_CHAPTER_DOWNLOAD_MODE: READY',flush=True)
            # Ordinary navigation/access classification remains active. No
            # pretend byte proof, and no old screenshot probe is performed.
            yield ctx
            return
        # Real transfer proof BEFORE the crawler scrolls a single chapter.
        # This transfers a decoded image across extension -> localhost -> Python,
        # validates bytes, and gives the user an on-disk artifact to inspect.
        try:
            result = _probe_with_one_quiet_image_grace(bridge, reader_selectors)
        except BrowserBridgeError as exc:
            if 'Unsupported command' in str(exc):
                raise BrowserBridgeError(
                    'The browser is still running an OUTDATED Comic Bridge service worker '
                    'which cannot transfer images. Remove the old Comic Bridge extension '
                    'under chrome://extensions and Load unpacked from the project '
                    'browser_bridge/chrome folder. Leave the comic tab open.') from exc
            raise
        if bridge.rendered_image_selector:
            if result.get('rendered_reader_revision') != 'scoped-rendered-reader-v1':
                raise BrowserBridgeError('OUTDATED COMIC BRIDGE EXTENSION: reload for scoped rendered-reader support before crawling')
            bridge.validate_image(str(result.get('url') or ''))
        raw = base64.b64decode(result.get('base64',''), validate=True)
        if not raw or len(raw) > 22*1024*1024:
            raise BrowserBridgeError('Browser proof failed: no valid image bytes received')
        from PIL import Image
        import io
        with Image.open(io.BytesIO(raw)) as im:
            image_format, dimensions = im.format, im.size
            im.verify()
        if image_format not in ('PNG','JPEG','WEBP') or min(dimensions)<=0:
            raise BrowserBridgeError('Browser proof failed: invalid or undecodable image')
        ext={'PNG':'.png','JPEG':'.jpg','WEBP':'.webp'}[image_format]
        proof=data_dir / ('bridge_proof_first_image'+ext)
        proof.parent.mkdir(parents=True, exist_ok=True)
        proof.write_bytes(raw)
        via=str(result.get('via','unknown'))
        print(f'BROWSER_TO_PYTHON_IMAGE_PROOF: PASS | {len(raw)} bytes | '
              f'{dimensions[0]}x{dimensions[1]} | SHA256 {hashlib.sha256(raw).hexdigest()} | '
              f'{via} | {proof}', flush=True)
        if via == 'rendered-png':
            print('IMAGE FIDELITY NOTICE: browser-rendered PNG, NOT original CDN JPEG bytes.', flush=True)
        # ADDITIVE: also exercise the *exact action* used by chapter downloads.
        # A stale MV3 background worker can pass 'probe' yet fail every blob.
        verify_live_blob_transfer(bridge, result, reader_selectors)
        bridge.startup_reader_verified = True
        # A successful byte proof confirms that future chapter snapshots
        # should contain image slots. Standalone/unproven pages are untouched.
        ctx.pages[0]._expect_reader_images = True
        yield ctx
    finally:
        ctx.close()


def ensure_generated_extensions(root, adapter, port):
    """Generate the installed bridge from ONE provider-neutral manifest writer.

    All website hosts, URL matches and CDN grants come from the single adapter.
    Never hand-edit the generated browser_bridge/* manifests, and never drop
    security-critical manifest permissions while regenerating them.
    """
    from .bridge_manifest import generate_installed_manifests

    root = Path(root)
    generate_installed_manifests(root, adapter, port=port)
    source = root / 'reusable' / 'browser_bridge_extension'
    target = root / 'browser_bridge'
    for browser in ('chrome', 'firefox'):
        folder = target / browser
        for filename in ('background.js', 'content.js', 'popup.html', 'popup.js'):
            source_file = source / filename
            target_file = folder / filename
            raw = source_file.read_bytes()
            if not target_file.exists() or target_file.read_bytes() != raw:
                target_file.write_bytes(raw)
    return target
