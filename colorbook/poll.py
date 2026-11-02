"""Serverless mode for GitHub Actions: run every few minutes, answer new
Telegram messages, build any requested books, then exit.

- The first person to send /start becomes the owner (saved in state/owner.json),
  unless TELEGRAM_CHAT_ID is set. Everyone else is ignored.
- The owner gets a first book automatically right after /start.
"""
from __future__ import annotations

import hashlib
import json
import os
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


def send_buttons(cfg: Config, tg: TG, chat: int, theme: str | None) -> None:
    """One-tap ordering: surprise me, same again, or one of three fresh ideas."""
    from .ideas import suggest_themes
    rows = [[{"text": "🎲 Surprise me", "callback_data": "new:"}]]
    if theme:
        rows[0].append({"text": f"🔁 More {theme}"[:40], "callback_data": f"again:{theme}"[:64]})
    for t in suggest_themes(cfg, 3):
        rows.append([{"text": f"✨ {t}"[:60], "callback_data": f"theme:{t}"[:64]}])
    try:
        tg.call("sendMessage", data={"chat_id": chat, "text": "What should the next book be?",
                                     "reply_markup": json.dumps({"inline_keyboard": rows})})
    except Exception as e:
        print("buttons failed:", e)


def collect(cfg: Config, tg: TG, wait: int = 0) -> list[tuple[int, str | None]]:
    updates = tg.call("getUpdates", timeout=wait + 30, data={"timeout": wait,
                                          "allowed_updates": json.dumps(["message", "callback_query"])})
    jobs: list[tuple[int, str | None]] = []
    for u in updates:
        cq = u.get("callback_query")
        if cq:  # a tap on one of the buttons under a finished book
            chat = ((cq.get("message") or {}).get("chat") or {}).get("id")
            try:
                tg.call("answerCallbackQuery", data={"callback_query_id": cq["id"],
                                                     "text": "Coming right up!"})
            except Exception:
                pass
            if chat and _h(chat) in _owner(cfg):
                kind, _, val = (cq.get("data") or "").partition(":")
                jobs.append((chat, val or None))
            continue
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
            send_buttons(cfg, tg, chat, None)
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
    # Stay online and answer instantly (long polling) for LISTEN_MINUTES after the
    # last message, instead of exiting and waiting for the next scheduled check.
    listen = float(os.getenv("LISTEN_MINUTES", "0") or 0) * 60
    started = time.time()
    jobs = collect(cfg, tg)
    print(f"{len(jobs)} book request(s)")
    while True:
        if jobs:
            make_books(cfg, tg, jobs[:3])  # at most 3 books per batch
            started = time.time()  # stay around a while after each book
        left = listen - (time.time() - started)
        if left < 5:
            break
        try:
            jobs = collect(cfg, tg, wait=int(min(50, left)))
        except Exception as e:
            print("listen error:", e)
            time.sleep(5)
            jobs = []
        if jobs:
            print(f"{len(jobs)} new book request(s)")


def make_books(cfg: Config, tg: TG, jobs) -> None:
    from .bot import _split_pdfs
    from .pipeline import make_book
    for chat, theme in jobs:
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
            note = f"Done! Theme: {res['theme']}. Tap a button for the next book, or send /newbook <your idea>."
            if res["failures"]:
                note += f" ({len(res['failures'])} page(s) could not be drawn and were skipped.)"
            if status:
                tg.edit(status, note)
            send_buttons(cfg, tg, chat, res["theme"])
        except Exception as e:
            print("book failed:", e)
            tg.say(chat, f"Sorry, that book failed: {str(e)[:300]}. Send /newbook to try again.")
