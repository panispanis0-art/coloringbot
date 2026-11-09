# Coloring Book Bot

> This repo also contains **[PDF Job Filler](pdf-job-filler/README.md)** (PDF form filler web app + Telegram bot) in `pdf-job-filler/`.

Makes 100-page printable coloring books for kids and sends them to your Telegram.
Send **/newbook** for a fresh theme, or **/newbook dinosaurs at the beach** for your own.

## How it works
1. **Ideas**: an AI (Gemini free tier or Cloudflare's free Llama, if configured) invents a new kid-friendly
   theme, looking at the season and avoiding themes it already used (`state/history.json`).
   It writes 100 different simple scenes. If no AI is reachable it uses a built-in theme bank.
2. **Drawing**: each scene goes to the image AI with a strict "black-and-white line art for kids" prompt.
   Default `IMAGE_PROVIDER=free`: Cloudflare Workers AI (Flux, free 10,000 neurons/day, about 170 pages)
   and then Pollinations.ai (no key, ~1 image per 45 s) when the free daily Cloudflare amount is used up.
3. **Hand-drawn cleanup** (`colorbook/handdrawn.py`): removes gray and shading, turns big solid
   black areas into outlines so kids can color them, removes specks, adds a slight hand wobble,
   then saves crisp 1-bit art. Painted or broken pictures are redrawn and never go in the book;
   if a page keeps coming out that way it is skipped and the bot tells you.
4. **Book**: cover with hollow letters, a "This book belongs to" page and 100 pages, as an A4 or Letter
   PDF at 300 dpi, about 1-10 MB. It is split in two parts if it ever goes over Telegram's 50 MB limit.

## Running on GitHub (no computer needed)
The workflow in `.github/workflows/coloring-book.yml` checks Telegram every ~10 minutes.
Add the repo secret `TELEGRAM_BOT_TOKEN`, then send `/start` to your bot: you become its owner and get a first book.
Optional secrets: `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` (faster, free), `GEMINI_API_KEY` (better ideas).

## Running on your own computer (about 10 minutes)
1. **Telegram bot**: in Telegram, message **@BotFather**, send `/newbot`, and copy the token.
   Message **@userinfobot** to get your chat id. Open your new bot and press **Start**.
2. **Cloudflare (free)**: sign up at dash.cloudflare.com, open **AI > Workers AI > Use REST API**,
   then copy your **Account ID** and create a token with the *Workers AI* permission.
3. Run `./setup.sh` (Linux/Mac/Pi) or double-click `setup.bat` (Windows).
4. Open `.env` and fill in `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`.
   Optional: `GEMINI_API_KEY` (free at aistudio.google.com) for better ideas.
5. Test: `.venv/bin/python -m colorbook check` (Windows: `.venv\Scripts\python -m colorbook check`).
6. First book: `python -m colorbook make --send`
7. Start the bot: `python -m colorbook bot` (Windows: double-click `run-bot.bat`).
   Linux/Pi 24/7: see `colorbook-bot.service`.

The bot answers only the chat ids in `TELEGRAM_CHAT_ID`. Set `AUTO_EVERY_HOURS=24` to get a new book every day automatically.
Books are also saved in `books/` with each page as PNG and the scene list in `plan.txt`.

## Dependencies
Only well-known packages: python-telegram-bot, OpenCV, NumPy, scikit-image, Pillow, requests, python-dotenv.
The cover font is Chewy (Google Fonts, Apache 2.0), bundled in `colorbook/fonts`.
Nothing else is downloaded or run.
