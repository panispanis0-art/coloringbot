# Importing the web app into Lovable

The web app is a normal **Vite + React + TypeScript** project with no backend, so Lovable can host and edit it.
It needs no Supabase, no API keys and no Lovable AI credits to run.

Lovable works with **one app per repository, at the repository root**. This repo is a small monorepo
(`web/`, `bot/`, `shared/`), so you give Lovable a stand-alone copy of the web app.

## 1. Make the stand-alone copy

```bash
npm install
npm run export:lovable
```

This creates `lovable-export/` with:

- everything from `web/`,
- the shared logic copied to `src/shared/` (picked up automatically by `vite.config.ts` and `tsconfig.json`
  through the `@shared` alias — no code changes needed),
- its own `package.json`, `.gitignore` and README.

Check it: `cd lovable-export && npm install && npm run build`.

## 2. Get it into Lovable

At the time of writing Lovable doesn't import an existing GitHub repo; it creates and syncs its own. So:

1. In Lovable create a new project (any prompt, e.g. "empty project"). This one message is the only
   thing that may use a credit; you can also start from a free template.
2. In the project: **GitHub → Connect** → Lovable creates a repo (e.g. `you/pdf-job-filler-web`) and keeps it
   in two-way sync.
3. Clone that repo, **delete its contents** (keep the `.git` folder), copy everything from `lovable-export/` in,
   commit and push:
   ```bash
   git clone https://github.com/you/pdf-job-filler-web.git
   cd pdf-job-filler-web
   git rm -rq . && git clean -fdq
   cp -r ../pdf-job-filler/lovable-export/. .
   git add -A && git commit -m "Import PDF Job Filler web app" && git push
   ```
4. Lovable picks up the push and rebuilds the preview. **Publish** gives you an `https://….lovable.app` link
   that you can install as an app on your phone and on Windows.

Editing code directly on GitHub / in your editor and pushing is free; only asking Lovable's AI to change things
uses credits.

## Notes

- Dev server port is **8080** (what Lovable expects); `vite.config.ts` already sets it.
- pdf.js needs its font/CMap files as static files. `vite.config.ts` copies them from `node_modules/pdfjs-dist`
  to `public/pdfjs/` at start-up, so there is nothing to commit for them.
- Styling is plain CSS (`src/index.css`). Lovable's agent can add Tailwind/shadcn later if you want; nothing
  depends on it.
- Data (templates, settings, font) stays in the browser (IndexedDB/localStorage) of each device. Nothing is
  sent to Lovable or anywhere else. To move templates use *Templates → Export / Import*.
- If you change `shared/src` in this repo, run `npm run export:lovable` again and copy `src/shared/` over, so the
  web app and the bot keep using the same logic.
