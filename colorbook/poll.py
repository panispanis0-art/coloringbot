"""Serverless mode for GitHub Actions: run every few minutes, answer new
Telegram messages, build any requested books, then exit.

- The first person to send /start becomes the owner (saved in state/owner.json),
  unless TELEGRAM_CHAT_ID is set. Everyone else is ignored.
- The owner gets a first book automatically right after /start.
"""
from __future__ import annotations

import hashlib
import json
import time

import requests

from .config import Config

HELP = ("Hi! I make printable coloring books for kids.\n\n"
        "/newbook  a new book with a fresh theme\n"
        "/newbook dinosaurs at the beach  a book on your theme\n\n"
        "I check for messages every few minutes, and a book takes a few minutes.")


class TG:
    def __init__(self, token: str):
        self.base = f"https://api.telegram.org/bot{token}/"

    def call(self, method: str, timeout=60, **kw):
        r = requests.post(self.base + method, timeout=timeout, **kw)
        data = r.json()
        if not data.get("ok"):
            raise RuntimeError(f"Telegram {method}: {data.get('description')}")
        return data["result"]

    def say(self, chat_id: int, text: str):
        try:
            return self.call("sendMessage", data={"chat_id": chat_id, "text": text})
        except Exception as e:
            print("sendMessage failed:", e)

    def edit(self, msg, text: str):
        try:
            self.call("editMessageText", data={"chat_id": msg["chat"]["id"],
                                                "message_id": msg["message_id"], "text": text})
        except Exception:
            pass


def _h(chat_id: int) -> str:
    # Only a hash of the owner's chat id is stored, so the repo can be public.
    return hashlib.sha256(f"colorbook:{chat_id}".encode()).hexdigest()


def _owner(cfg: Config) -> list[str]:
    if cfg.chat_ids:
        return [_h(c) for c in cfg.chat_ids]
    p = cfg.state_dir / "owner.json"
    return json.loads(p.read_text()) if p.exists() else []


def _set_owner(cfg: Config, chat_id: int):
    (cfg.state_dir / "owner.json").write_text(json.dumps([_h(chat_id)]))


def collect(cfg: Config, tg: TG) -> list[tuple[int, str | None]]:
    updates = tg.call("getUpdates", data={"timeout": 0, "allowed_updates": json.dumps(["message"])})
    jobs: list[tuple[int, str | None]] = []
    for u in updates:
        m = u.get("message") or {}
        text = (m.get("text") or "").strip()
        chat = (m.get("chat") or {}).get("id")
        if not chat or not text.startswith("/"):
            continue
        cmd, _, arg = text.partition(" ")
        cmd = cmd.split("@")[0].lower()
        owners = _owner(cfg)
        if not owners and cmd == "/start":
            _set_owner(cfg, chat)
            tg.say(chat, HELP + "\n\nThis bot is now yours only. Your first book is starting now.")
            jobs.append((chat, None))
            continue
        if _h(chat) not in owners:
            tg.say(chat, "Sorry, this bot is private.")
            continue
        if cmd in ("/start", "/help"):
            tg.say(chat, HELP)
        elif cmd == "/newbook":
            jobs.append((chat, arg.strip() or None))
    if updates:  # confirm, so Telegram does not send them again
        tg.call("getUpdates", data={"offset": updates[-1]["update_id"] + 1, "timeout": 0})
    return jobs


def run(cfg: Config) -> None:
    from .bot import _split_pdfs
    from .pipeline import make_book

    if not cfg.bot_token:
        raise SystemExit("TELEGRAM_BOT_TOKEN secret is missing")
    tg = TG(cfg.bot_token)
    tg.call("deleteWebhook")
    jobs = collect(cfg, tg)
    print(f"{len(jobs)} book request(s)")
    for chat, theme in jobs[:3]:  # at most 3 books per run
        what = f"on “{theme}”" if theme else "with a fresh theme"
        status = tg.say(chat, f"Got it! Making a new book {what}. Thinking of ideas…")
        last = [0.0]

        def progress(done, total):
            if status and (time.time() - last[0] > 60 or done == total):
                last[0] = time.time()
                tg.edit(status, f"Drawing pages: {done}/{total}")

        try:
            res = make_book(cfg, theme, progress=progress)
            preview = res["preview"][:4]
            try:
                files = {f"p{i}": (p.name, p.read_bytes(), "image/png") for i, p in enumerate(preview)}
                media = [{"type": "photo", "media": f"attach://p{i}"} for i in range(len(preview))]
                tg.call("sendMediaGroup", timeout=300,
                        data={"chat_id": chat, "media": json.dumps(media)}, files=files)
            except Exception as e:
                print("preview failed:", e)
            for pdf in _split_pdfs(res):
                with pdf.open("rb") as fh:
                    tg.call("sendDocument", timeout=600,
                            data={"chat_id": chat,
                                  "caption": f"{res['title']}: {res['pages']} pages, ready to print"},
                            files={"document": (pdf.name, fh, "application/pdf")})
            note = f"Done! Theme: {res['theme']}. Send /newbook for another."
            if res["failures"]:
                note += f" ({len(res['failures'])} page(s) could not be drawn and were skipped.)"
            if status:
                tg.edit(status, note)
        except Exception as e:
            print("book failed:", e)
            tg.say(chat, f"Sorry, that book failed: {str(e)[:300]}. Send /newbook to try again.")
