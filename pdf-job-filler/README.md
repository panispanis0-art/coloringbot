# PDF Job Filler

Fill a **fillable PDF form** (AcroForm) from the text of a **source PDF**, with a mapping you set up once.

- **Web app** (PWA, installable on Windows and phones): React + Vite + TypeScript, runs fully in the browser —
  no server, no account, nothing uploaded anywhere.
- **Telegram bot** (Node.js + telegraf): send a source PDF with `/write <Job Name>` and get `<Job Name>.pdf` back.
- Both use the same code in [`shared/`](shared/src): pdf.js for text extraction, pdf-lib for filling.

```
pdf-job-filler/
├─ shared/src/      extraction (pdf.js), mapping rules, form filling (pdf-lib), templates
├─ web/             the PWA (Run / Setup / Templates / Settings)
├─ bot/             the Telegram bot
├─ samples/         example source PDFs + example fillable form to try it
├─ scripts/         sample generator, Lovable export
├─ .env.example     bot settings
└─ *.bat            Windows setup / run scripts
```

## How it works

1. **Setup (one time)** — in the web app, *Setup* tab:
   - load the blank **target form** → all its fields are listed;
   - load an **example source PDF** → its text is shown line by line (and as the page itself);
   - for each form field choose where the value comes from:
     | Source | What it does |
     |---|---|
     | **Text next to a label** | finds e.g. `Order No:` and takes what is to its right (or below / on the next line) |
     | **Regular expression** | e.g. `Total amount:\s*EUR\s*([\d.,]+)` — the part in `( )` is used |
     | **Area on the page** | drag a box on the source page; whatever text is inside is used |
     | **Job Name** | the Job Name you type in Run mode |
     | **Fixed value** | always the same text / checkbox state / dropdown option |
     | **Today's date** | format like `DD.MM.YYYY` |
     Tap any piece of source text and press **Use as label**, **Use this area** or **Fixed value** — the
     fastest way. **Auto-match by name** maps fields whose name equals a label in the source (`Phone` ↔ `Phone:`).
     Every field shows the value it would get, live. *More* adds case change, a default and prefix/suffix.
   - **Test fill** shows the result; **Save template** stores it on the device (IndexedDB), together with the
     blank form, so the template is self-contained.
2. **Run** — pick the template, load a new source PDF, type the **Job Name**, press **Fill form** → preview →
   **Download** (or **Share / Save** on phones). The file is called `<Job Name>.pdf` (characters Windows does
   not allow in file names, like `: / ?`, are dropped). You can correct any value before downloading.
3. **Templates** — make active, edit, delete, **Export** to JSON (backup / other device / the bot), **Import**.
4. **Settings** — PDF metadata, flatten default, Unicode font.

### Output PDF

- **Metadata**: Author = `Alex` by default; Creator and Producer are editable (empty = the entry is removed).
  pdf-lib's own “pdf-lib” Producer/Creator stamp is **not** added. Optional: Title = Job Name. The form's old
  XMP metadata is removed by default so every viewer shows the same values. Nothing else is added — no
  watermark, no extra pages, no hidden fields.
- **Flatten** on: fields become normal page content (not editable). Off: the form stays fillable.
- **Special letters** (ă â î ș ț, Cyrillic, Greek…): the standard PDF font cannot draw them, so they are turned
  into the plain letter (ș → s) and a warning is shown. To keep them, load a font in *Settings*
  (e.g. `C:\Windows\Fonts\arial.ttf`) — for the bot set `FONT_PATH` in `.env`.
- Source PDFs must contain real text (exported from Word/Excel/a program). **Scans don't work** (no OCR).
- XFA-only forms (some government forms made with Adobe LiveCycle) are filled through their AcroForm part;
  the XFA layer is removed so Acrobat shows the filled values.

---

## Setup on Windows

1. Install **Node.js 22 LTS** (or newer) from <https://nodejs.org> (default options).
2. Download this repository (green **Code** button → *Download ZIP*, unzip) or `git clone` it.
3. Open the `pdf-job-filler` folder and double-click **`setup.bat`**.
   It installs the packages, creates `.env` from `.env.example` and builds the web app.

### Web app on your PC

- Double-click **`run-web.bat`** → opens <http://localhost:4173>.
- In Chrome or Edge click the **Install** icon in the address bar (or menu → *Apps → Install*) to get it as a
  Windows app with its own window and Start-menu entry. It works offline after the first visit.
- `run-dev.bat` starts the development server with live reload (<http://localhost:8080>) if you change the code.

### Web app on your phone

A PWA can only be **installed** from an `https://` address (or `localhost`). Options:

- **Free static hosting** (recommended): `npm run build` and upload `web/dist` to Netlify Drop
  (<https://app.netlify.com/drop>, drag & drop the folder), Cloudflare Pages or Vercel. Open the https link on the
  phone → *Add to Home screen* / *Install app*. Everything still runs on the phone; the host only serves files.
- **Lovable** — see [LOVABLE.md](LOVABLE.md) and use *Publish*.
- **Same Wi-Fi, no install**: `run-web.bat` also listens on your PC's network address (shown in the window as
  `Network: http://192.168.x.x:4173`). Open that on the phone to use it in the browser (not installable over plain
  http). Allow Node.js through the Windows firewall when asked.

Templates live in the browser of each device. Move them with **Templates → Export / Import**.

### Telegram bot

1. In Telegram open **@BotFather** → `/newbot` → copy the token.
2. Open **@userinfobot** → it tells you your numeric user id.
3. Open `.env` (Notepad) and set `BOT_TOKEN` and `ALLOWED_USER_ID`. Messages from anyone else are ignored
   (no reply at all).
4. Give the bot a template: in the web app *Templates → Export* (keep *Settings → Export templates with the
   target form inside* ticked), then send the `.json` file to your bot with the caption **`/template`**.
   (Or copy it to `bot/data/template.json`.)
5. Double-click **`run-bot.bat`** (or `run-all.bat` for web + bot). Keep the window open; the bot works while
   your PC is on.

Using it:

- **Just send the source PDF.** The bot reads it straight away and asks for the Job Name with one-tap
  suggestions taken from the PDF itself (client, order number, file name…). Tap one or type your own.
- Shortcut: put the Job Name in the **caption** of the PDF (`/write My Job` or just `My Job`).
- The PDF comes back with a **result card**: every field with its value (missing ones marked ❌) and buttons
  for a **🔒 flattened / 📝 editable copy** and **🔁 Rename**.

| Command | |
|---|---|
| `/start`, `/help` | how to use it |
| `/write <Job Name>` | as the caption of the source PDF, or as a reply to a PDF you sent before → returns `<Job Name>.pdf` |
| `/template` | shows the active template and its rules; send a `.json` with caption `/template` to replace it |

The bot uses the template's *Flatten by default* unless `FLATTEN=true/false` is set. Metadata comes from `.env`
(`PDF_AUTHOR`, `PDF_CREATOR`, `PDF_PRODUCER`, `TITLE_FROM_JOB_NAME`, `STRIP_XMP`). Telegram limits bot downloads
to 20 MB per file.

**Start the bot with Windows (optional):** press `Win+R`, type `shell:startup`, Enter, and put a shortcut to
`run-bot.bat` in that folder.

---

## Try it with the samples

`samples/target-form.pdf` is a fillable job sheet; `samples/source-example.pdf` and `source-example-2.pdf` are
work orders. In Setup load the form + `source-example.pdf`, map a few fields, save, then in Run use
`source-example-2.pdf`. Recreate them with `npm run samples`.

## Commands (any OS)

```bash
npm install            # once
npm run dev            # web app, dev server  http://localhost:8080
npm run build          # web app → web/dist (static files)
npm run preview        # serve the build      http://localhost:4173
npm run bot            # Telegram bot (reads .env)
npm test               # tests: extraction, rules, filling, metadata, bot commands
npm run typecheck
npm run export:lovable # stand-alone web app in ./lovable-export
```

Linux/macOS: `./run.sh web`, `./run.sh bot`, `./run.sh dev`.

## Template format

A template is plain JSON (`version: 1`), easy to edit by hand:

```json
{
  "version": 1,
  "id": "k3j2…",
  "name": "Work order sheet",
  "targetFormName": "target-form.pdf",
  "targetFormBase64": "JVBERi0xLjcK…",
  "options": { "flatten": false },
  "mappings": [
    { "fieldName": "JobName",     "fieldType": "text", "rule": { "type": "jobName" } },
    { "fieldName": "OrderNumber", "fieldType": "text", "rule": { "type": "label", "label": "Order No", "valueOn": "auto" } },
    { "fieldName": "ClientName",  "fieldType": "text", "rule": { "type": "label", "label": "Client", "transform": "upper" } },
    { "fieldName": "Total",       "fieldType": "text", "rule": { "type": "regex", "pattern": "Total amount:\\s*EUR\\s*([\\d.,]+)", "flags": "i" } },
    { "fieldName": "SiteAddress", "fieldType": "text", "rule": { "type": "position", "page": 1, "x": 46, "y": 644, "w": 126, "h": 18 } },
    { "fieldName": "Approved",    "fieldType": "checkbox", "rule": { "type": "static", "value": "yes" } },
    { "fieldName": "FilledOn",    "fieldType": "text", "rule": { "type": "date", "format": "DD.MM.YYYY" } },
    { "fieldName": "Notes",       "fieldType": "text", "rule": { "type": "skip" } }
  ]
}
```

Label rule options: `valueOn` (`auto` | `sameLine` | `nextLine` | `below`), `occurrence` (n-th match),
`lines` (how many lines to take), `stopAt` (regex where the value ends), `caseSensitive`.
All rules accept `transform` (`upper` | `lower` | `title`), `defaultValue`, `prefix`, `suffix`.
Position coordinates are PDF points from the bottom-left corner of the page. Checkboxes are ticked unless the
value is empty, `0`, `false`, `no`, `nu`, `off`.

## Importing the web app into Lovable

See **[LOVABLE.md](LOVABLE.md)**.
