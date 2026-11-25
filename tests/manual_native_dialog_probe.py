"""Opt-in Windows test using a harmless loopback POST; never touches archive state."""
import os
import sys
import threading
import time
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from reusable.native_dialogs import ManagedNativeDialogWatcher


def main():
    if os.name != 'nt':
        raise SystemExit('Run this test on Windows with ordinary Chrome or Edge.')
    title = 'ComicArchiver Native Dialog Test ' + uuid.uuid4().hex[:12]
    posted = threading.Event()
    repeated = threading.Event()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def reply(self, body):
            data = ('<!doctype html><meta charset="utf-8"><title>'+title+
                    '</title><h1>'+title+'</h1>'+body).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            self.reply('<p>Local test only. Click the button, then press Ctrl+R once.</p>'
                       '<form method="POST" action="/"><input type="hidden" name="test" value="1">'
                       '<button type="submit">Submit harmless local test</button></form>')

        def do_POST(self):
            self.rfile.read(min(int(self.headers.get('Content-Length', 0)), 1024))
            if posted.is_set():
                repeated.set()
            posted.set()
            self.reply('<p>Press Ctrl+R once if this is the first POST. '
                       'Do not manually click Continue. No external requests are made.</p>')

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    watcher = None
    try:
        url = f'http://127.0.0.1:{server.server_port}/'
        print('Open in normal Chrome or Edge if the default browser differs:', url, flush=True)
        print('Click Submit harmless local test, press Ctrl+R once, then leave the warning open.', flush=True)
        webbrowser.open(url)
        if not posted.wait(90):
            raise SystemExit('No initial local POST; test not performed.')
        watcher = ManagedNativeDialogWatcher(title, timeout=90).start()
        deadline = time.monotonic() + 105
        while watcher.process is not None and watcher.process.poll() is None and time.monotonic() < deadline:
            time.sleep(.25)
        accepted = watcher.close()
        if accepted and repeated.is_set():
            print('PASS: native dialog disappeared and the local POST was resubmitted.')
        else:
            print('FAIL/UNVERIFIED: auto-accept=%s repeated_local_post=%s' % (accepted, repeated.is_set()))
            raise SystemExit(1)
    finally:
        if watcher is not None:
            watcher.close()
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
