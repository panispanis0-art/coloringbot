"""Telegram bot: /newbook [theme] -> a fresh 100-page coloring book PDF."""
from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path

from PIL import Image
from telegram import InputMediaPhoto, Update
from telegram.ext import Application, CommandHandler, ContextTypes

from . import book
from .config import Config
from .pipeline import make_book

log = logging.getLogger("colorbook")
TG_LIMIT = 48 * 1024 * 1024  # bots may upload up to 50 MB

cfg = Config()
queue: asyncio.Queue = asyncio.Queue()
state = {"busy": None}

HELP = ("Hi! I make printable coloring books for kids.\n\n"
        "/newbook  a new 100-page book with a fresh theme\n"
        "/newbook dinosaurs at the beach  a book on your theme\n"
        "/status  what I'm working on")


def allowed(update: Update) -> bool:
    return not cfg.chat_ids or update.effective_chat.id in cfg.chat_ids


async def start(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not cfg.chat_ids:
        await update.message.reply_text(
            f"Your chat id is {update.effective_chat.id}. Put it in TELEGRAM_CHAT_ID in .env "
            "and restart me so only you can order books.")
    if allowed(update):
        await update.message.reply_text(HELP)


async def status(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not allowed(update):
        return
    busy = state["busy"]
    msg = f"Working on: {busy}" if busy else "Idle."
    await update.message.reply_text(f"{msg} Books waiting: {queue.qsize()}")


async def newbook(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not allowed(update):
        await update.message.reply_text("Sorry, this bot is private.")
        return
    theme = " ".join(ctx.args).strip() or None
    await queue.put((update.effective_chat.id, theme))
    ahead = queue.qsize() - 1 + (1 if state["busy"] else 0)
    what = f"on “{theme}”" if theme else "with a fresh theme"
    when = "Starting now" if ahead == 0 else f"{ahead} book(s) ahead of it"
    await update.message.reply_text(f"New book {what} is on its way. {when}. "
                                    f"This usually takes 15-60 minutes.")


def _split_pdfs(res: dict) -> list[Path]:
    pdf: Path = res["pdf"]
    if pdf.stat().st_size <= TG_LIMIT:
        return [pdf]
    pages = sorted((res["folder"] / "pages").glob("[0-9][0-9][0-9].png"))
    half = len(pages) // 2
    parts = []
    for n, chunk in enumerate((pages[:half], pages[half:]), 1):
        out = pdf.with_name(pdf.stem + f"-part{n}.pdf")
        book.make_pdf(f"{res['title']} (part {n})", [Image.open(p) for p in chunk], out, cfg.page_size)
        parts.append(out)
    return parts


async def build_and_send(app: Application, chat_id: int, theme: str | None):
    bot = app.bot
    loop = asyncio.get_running_loop()
    status_msg = await bot.send_message(chat_id, "Thinking of ideas…")
    last = {"t": 0.0, "pct": -1}

    def progress(done, total):
        pct = int(done * 100 / max(total, 1))
        if pct >= 100 or (pct - last["pct"] >= 5 and time.time() - last["t"] > 20):
            last.update(t=time.time(), pct=pct)
            asyncio.run_coroutine_threadsafe(
                status_msg.edit_text(f"Drawing pages: {done}/{total}"), loop)

    def logline(s):
        log.info(s)

    res = await asyncio.to_thread(make_book, cfg, theme, logline, progress)
    try:
        await bot.send_media_group(chat_id, [InputMediaPhoto(p.read_bytes()) for p in res["preview"]])
    except Exception as e:
        log.warning("preview failed: %s", e)
    for pdf in _split_pdfs(res):
        with pdf.open("rb") as fh:
            await bot.send_document(chat_id, fh, filename=pdf.name, read_timeout=300,
                                    write_timeout=300, connect_timeout=60,
                                    caption=f"{res['title']}: {res['pages']} pages, ready to print")
    note = f"Done! Theme: {res['theme']}."
    if res["failures"]:
        note += f" {len(res['failures'])} page(s) failed and were skipped."
    await status_msg.edit_text(note)


async def worker(app: Application):
    while True:
        chat_id, theme = await queue.get()
        state["busy"] = theme or "a fresh theme"
        try:
            await build_and_send(app, chat_id, theme)
        except Exception as e:
            log.exception("book failed")
            try:
                await app.bot.send_message(chat_id, f"Sorry, that book failed: {str(e)[:300]}")
            except Exception:
                pass
        finally:
            state["busy"] = None
            queue.task_done()


async def auto_scheduler():
    while True:
        await asyncio.sleep(cfg.auto_every_hours * 3600)
        for cid in cfg.chat_ids:
            await queue.put((cid, None))


async def post_init(app: Application):
    app.create_task(worker(app))
    if cfg.auto_every_hours > 0 and cfg.chat_ids:
        app.create_task(auto_scheduler())


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    if not cfg.bot_token:
        raise SystemExit("Set TELEGRAM_BOT_TOKEN in .env first.")
    app = (Application.builder().token(cfg.bot_token).post_init(post_init)
           .read_timeout(60).write_timeout(300).build())
    app.add_handler(CommandHandler(["start", "help"], start))
    app.add_handler(CommandHandler("newbook", newbook))
    app.add_handler(CommandHandler("status", status))
    log.info("Bot running. Send /newbook in Telegram.")
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
