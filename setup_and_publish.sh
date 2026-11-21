#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
python -m playwright install chromium
npm install --no-audit --no-fund
if [ "$(python comic_archiver.py --github-account | grep -c 'not selected' || true)" != "0" ]; then
  python comic_archiver.py --github-login
fi
if ! npx wrangler whoami >/dev/null 2>&1; then
  npx wrangler login
fi
SOURCE_URL="${1:-}"
if [ -z "$SOURCE_URL" ] && [ -f source/starting_url.txt ]; then SOURCE_URL="$(cat source/starting_url.txt)"; fi
if [ -z "$SOURCE_URL" ]; then read -rp 'Comic webpage URL: ' SOURCE_URL; fi
read -rp 'Type I HAVE RIGHTS to confirm download and public redistribution rights: ' ACK
[ "$ACK" = 'I HAVE RIGHTS' ] || exit 2
python comic_archiver.py --archive --authorized --source-url "$SOURCE_URL"
python comic_archiver.py --deploy --authorized
