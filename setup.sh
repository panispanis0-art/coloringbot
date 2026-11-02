#!/usr/bin/env bash
# One-time setup on Linux / macOS / Raspberry Pi. Needs Python 3.10+.
set -e
cd "$(dirname "$0")"
python3 -m venv .venv
.venv/bin/pip install --upgrade pip -q
.venv/bin/pip install -r requirements.txt -q
[ -f .env ] || cp .env.example .env
echo
echo "Installed. Now edit .env (bot token, chat id, Cloudflare id + token), then:"
echo "  .venv/bin/python -m colorbook check          # test everything"
echo "  .venv/bin/python -m colorbook make --send    # first 100-page book to Telegram"
echo "  .venv/bin/python -m colorbook bot            # start the /newbook bot"
