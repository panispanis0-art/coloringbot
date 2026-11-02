"""CLI.

python -m colorbook bot                 run the Telegram bot (/newbook)
python -m colorbook make [theme]        make one book now and print the PDF path
python -m colorbook make --send [theme] make one book and send it to TELEGRAM_CHAT_ID
python -m colorbook check               test keys and connections
python -m colorbook poll                answer Telegram once and exit (GitHub Actions)
"""
from __future__ import annotations

import sys

import requests

from .config import Config


def send(cfg: Config, res: dict) -> None:
    from .bot import _split_pdfs
    for cid in cfg.chat_ids:
        for pdf in _split_pdfs(res):
            with pdf.open("rb") as fh:
                r = requests.post(f"https://api.telegram.org/bot{cfg.bot_token}/sendDocument",
                                  data={"chat_id": cid, "caption": f"{res['title']}: {res['pages']} pages"},
                                  files={"document": (pdf.name, fh, "application/pdf")}, timeout=600)
            print("sent" if r.ok else f"send failed: {r.text[:200]}")


def check(cfg: Config) -> None:
    from . import providers
    print("Image back-ends:", providers.chain(cfg) if cfg.provider == "free" else [cfg.provider])
    if cfg.bot_token:
        r = requests.get(f"https://api.telegram.org/bot{cfg.bot_token}/getMe", timeout=30)
        print("Telegram bot:", r.json().get("result", {}).get("username") if r.ok else r.text[:200])
    else:
        print("Telegram bot: TELEGRAM_BOT_TOKEN missing")
    print("Chat ids:", cfg.chat_ids or "missing (send /start to the bot to learn yours)")
    try:
        data = providers.generate(cfg, "Children's coloring page, black and white line art, a cute cat")
        print(f"Test image OK ({len(data)//1024} KB)")
    except Exception as e:
        print("Test image FAILED:", e)


def describe_cf() -> None:
    # Safe description of the Cloudflare secrets (shape only, never the values).
    import os, re
    for k in ("CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"):
        v = os.getenv(k, "")
        parts = v.split()
        print(f"{k}: {len(v)} chars, {len(parts)} part(s): " + ", ".join(
            f"len {len(p)}{' hex32' if re.fullmatch(r'[0-9a-f]{32}', p) else ''}" for p in parts))


def main(argv: list[str]) -> None:
    cfg = Config()
    if argv and argv[0] in ("sample", "check"):
        describe_cf()
        print("Cloudflare ready:", bool(cfg.cf_account and cfg.cf_token))
    cmd = argv[0] if argv else "help"
    if cmd == "bot":
        from .bot import main as bot_main
        bot_main()
    elif cmd == "make":
        args = argv[1:]
        do_send = "--send" in args
        theme = " ".join(a for a in args if a != "--send") or None
        from .pipeline import make_book
        res = make_book(cfg, theme, progress=lambda d, t: print(f"\r{d}/{t}", end="", flush=True))
        print("\nPDF:", res["pdf"])
        if do_send:
            send(cfg, res)
    elif cmd == "sample":
        # Make a small book and keep its pages in samples/latest (for quality review).
        import shutil
        from .pipeline import make_book
        theme = " ".join(argv[1:]) or None
        res = make_book(cfg, theme)
        out = cfg.out_dir.parent / "samples" / "latest"
        shutil.rmtree(out, ignore_errors=True)
        shutil.copytree(res["folder"], out)
        print("samples saved to", out)
    elif cmd == "poll":
        from .poll import run
        run(cfg)
    elif cmd == "check":
        check(cfg)
    else:
        print(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
