import { Markup, Telegraf, type Context } from 'telegraf';
import { message } from 'telegraf/filters';
import fs from 'node:fs/promises';
import path from 'node:path';
import { bytesToBase64, emptyTemplate, listFormFields, type MappingRule } from '../../shared/src/index.ts';
import { zipSync } from 'fflate';
import { config, PROJECT_DIR } from './config.ts';
import {
  applyNamePattern,
  deleteTemplate,
  nameIdeas,
  listTemplates,
  prepareJob,
  renderJob,
  saveTemplate,
  suggestJobNames,
  switchTemplate,
  templateSummary,
  type Rendered,
} from './pdf.ts';
import { renderPreview } from './preview.ts';
import { Progress, react } from './progress.ts';
import { allSegments, learnRule } from './teach.ts';
import { findDuplicate, findJob, hashOf, history, saveJob } from './store.ts';
import { habits } from './jobs.ts';
import { addJob, jobAwaitingName, newJobId, pendingInput, waitForName, waitForValue, type Job } from './jobs.ts';

export const HELP = [
  'PDF Job Filler bot',
  '',
  '📄 Just send me the source PDF. I read it and ask for the Job Name —',
  '   tap a suggestion or type one. You get back "<Job Name>.pdf".',
  '   Shortcut: put the Job Name in the caption of the PDF.',
  '📦 Several PDFs at once: select them all and send together — you get one ZIP.',
  '',
  '/write <Job Name> — as caption of a PDF, or as a reply to a PDF.',
  '/templates — your templates (I pick the best one for each PDF).',
  '   Send a template .json (exported from the web app) to add it.',
  '/history — your last jobs, tap one to get its PDF again.',
  '/autoname — name jobs automatically, e.g. /autoname {ClientName} - {date}',
  '/help — this message.',
].join('\n');

interface Doc {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

/** "/write Job Name" or "/write@MyBot Job Name" -> "Job Name"; undefined if it is another command. */
export function commandArgs(text: string | undefined, command: string): string | undefined {
  const m = new RegExp(`^/${command}(?:@\\w+)?(?:\\s+([\\s\\S]*))?$`, 'i').exec((text ?? '').trim());
  return m ? (m[1] ?? '').trim() : undefined;
}

const isPdf = (d: Doc) => d.mime_type === 'application/pdf' || /\.pdf$/i.test(d.file_name ?? '');
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function download(ctx: Context, d: Doc): Promise<Uint8Array> {
  if (d.file_size && d.file_size > 20 * 1024 * 1024) throw new Error('File is over 20 MB, Telegram bots cannot download it.');
  const link = await ctx.telegram.getFileLink(d.file_id);
  const res = await fetch(link);
  if (!res.ok) throw new Error(`Download failed (${res.status}).`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Download + read a source PDF into a Job. Replies with the error and returns undefined on failure. */
/** Download + read a source PDF into a Job (throws on failure). */
async function createJob(ctx: Context, doc: Doc, progress?: Progress): Promise<Job> {
  if (!isPdf(doc)) throw new Error(`${doc.file_name ?? 'That file'} is not a PDF.`);
  const sourceBytes = await download(ctx, doc);
  await progress?.step(`🔎 Reading ${doc.file_name ?? 'the PDF'}…`);
  return createJobFromBytes(ctx, sourceBytes, doc.file_name ?? 'source.pdf');
}

async function createJobFromBytes(ctx: Context, sourceBytes: Uint8Array, sourceName: string): Promise<Job> {
  const prepared = await prepareJob(sourceBytes);
  const job = addJob({
    id: newJobId(),
    userId: ctx.from!.id,
    chatId: ctx.chat!.id,
    sourceName,
    sourceBytes,
    sourceHash: hashOf(sourceBytes),
    prepared,
    createdAt: Date.now(),
    overrides: {},
    suggestions: suggestJobNames(prepared, sourceName),
    ...(ctx.message && 'document' in ctx.message ? { messageId: ctx.message.message_id } : {}),
  });
  await saveJob(job).catch((e) => console.warn('Could not save job:', e));
  return job;
}

/** Download + read a source PDF into a Job. Replies with the error and returns undefined on failure. */
async function startJob(ctx: Context, doc: Doc): Promise<Job | undefined> {
  const own = !!ctx.message && 'document' in ctx.message;
  if (own) await react(ctx, '👀');
  await ctx.sendChatAction('typing').catch(() => {});
  const progress = new Progress(ctx, `📥 Downloading ${doc.file_name ?? 'the PDF'}…`);
  try {
    return await createJob(ctx, doc, progress);
  } catch (e) {
    console.error(e);
    await progress.done();
    if (own) await react(ctx, '😢');
    await ctx.reply(`❌ ${errText(e)}`);
    return undefined;
  } finally {
    await progress.done();
  }
}

function templateLine(job: Job): string {
  const sc = job.prepared.ranking.find((r) => r.id === job.prepared.template.id);
  const auto = job.prepared.ranking.length > 1 ? ' (best match)' : '';
  return `🧩 Template: ${job.prepared.template.name}${sc ? ` — ${sc.found}/${sc.total} found` : ''}${auto}`;
}

/** Ask for the Job Name: suggestion buttons + "type it" reply box. */
async function askName(ctx: Context, job: Job) {
  waitForName(job.userId, job.id);
  fillAhead(job);
  const found = Object.values(job.prepared.values).filter(Boolean).length;
  const buttons = job.suggestions.map((s, i) => [Markup.button.callback(`📝 ${s}`, `jn:${job.id}:${i}`)]);
  if (job.prepared.ranking.length > 1) buttons.push([Markup.button.callback('🔄 Use another template', `ot:${job.id}`)]);
  await ctx.reply(
    `📄 ${job.sourceName} — read, ${found} value(s) found.\n${templateLine(job)}\n\nWhat's the Job Name? Tap one or type your own.`,
    buttons.length ? Markup.inlineKeyboard(buttons) : Markup.forceReply().placeholder('Job Name'),
  );
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function isFlat(job: Job): boolean {
  return job.flatten ?? config.flatten ?? job.prepared.template.options.flatten;
}

/** The message under the PDF: every mapped field with its value, missing ones marked. */
export function resultCaption(
  job: Job,
  fileName: string,
  values: Record<string, string>,
  warnings: string[],
  footer = '',
): string {
  const mapped = job.prepared.template.mappings.filter((m) => m.rule.type !== 'skip');
  const missing = mapped.filter((m) => !values[m.fieldName]);
  const head = `✅ <b>${esc(fileName)}</b>\n${mapped.length - missing.length}/${mapped.length} fields filled · ${isFlat(job) ? '🔒 flattened' : '📝 editable'}`;
  const rows = mapped.map((m) => {
    const v = values[m.fieldName];
    const short = v && v.length > 60 ? `${v.slice(0, 57)}…` : v;
    return v ? `• ${esc(m.fieldName)}: <b>${esc(short!.replace(/\n/g, ' / '))}</b>` : `• ${esc(m.fieldName)}: ❌ <i>not found</i>`;
  });
  const warn = warnings.filter((w) => !/is not in this form/.test(w)).map((w) => `⚠️ ${esc(w)}`);
  const tail = [...(warn.length ? ['', ...warn] : []), ...(footer ? ['', footer] : [])];
  let out = [head, '', ...rows, ...tail].join('\n');
  // Telegram captions are limited to 1024 characters: drop rows (never cut inside a tag)
  while (out.length > 1024 && rows.length) {
    rows.pop();
    out = [head, '', ...rows, '…', ...tail].join('\n');
  }
  while (out.length > 1024 && tail.length) {
    tail.shift();
    out = [head, '', ...rows, '…', ...tail].join('\n');
  }
  return out;
}

function missingFields(job: Job): string[] {
  return editableFields(job)
    .map((m) => m.fieldName)
    .filter((f) => !currentValue(job, f) && !job.skipped?.includes(f));
}

function resultButtons(job: Job) {
  const missing = missingFields(job).length;
  return Markup.inlineKeyboard([
    ...(missing ? [[Markup.button.callback(`🧩 Fill ${missing} missing`, `mf:${job.id}`)]] : []),
    [Markup.button.callback('✏️ Fix a value', `fx:${job.id}`)],
    [
      Markup.button.callback(isFlat(job) ? '📝 Editable copy' : '🔒 Flattened copy', `fl:${job.id}`),
      Markup.button.callback('🔁 Rename', `rn:${job.id}`),
    ],
    ...(job.prepared.ranking.length > 1 ? [[Markup.button.callback('🔄 Other template', `ot:${job.id}`)]] : []),
    ...(job.jobName ? [[Markup.button.switchToChat('📤 Send to a chat', job.jobName)]] : []),
  ]);
}

interface Output {
  res: Rendered;
  picture?: Buffer | undefined;
  /** milliseconds spent filling + drawing */
  ms: number;
}

/** Fill the form and draw the preview. */
async function produce(job: Job, jobName: string, withPreview = config.preview, progress?: Progress): Promise<Output> {
  const t0 = performance.now();
  const res = await renderJob({ prepared: job.prepared, jobName, overrides: job.overrides, flatten: isFlat(job) });
  if (withPreview) await progress?.step('🖼 Drawing the preview…');
  const picture = withPreview ? await renderPreview(res.bytes).catch((e) => void console.warn('Preview failed:', e)) : undefined;
  return { res, picture: picture ?? undefined, ms: performance.now() - t0 };
}

/** Same name + same corrections + same flatten = same output. */
const outputKey = (job: Job, jobName: string) => JSON.stringify([jobName.trim(), job.overrides, isFlat(job)]);

/** Fill ahead for the most likely Job Name, so tapping it answers instantly. */
function fillAhead(job: Job) {
  const name = job.suggestions[0];
  if (!name) return;
  const promise = produce(job, name);
  promise.catch(() => {}); // a failure shows up again on the real request
  job.ahead = { key: outputKey(job, name), promise };
}

async function finish(ctx: Context, job: Job, jobName: string) {
  waitForName(job.userId, undefined);
  job.jobName = jobName.trim();
  await ctx.sendChatAction('upload_document').catch(() => {});
  const progress = new Progress(ctx, '✍️ Filling the form…');
  try {
    const ahead = job.ahead?.key === outputKey(job, job.jobName) ? job.ahead.promise : undefined;
    job.ahead = undefined;
    const { res, picture, ms } = await (ahead ?? produce(job, job.jobName, config.preview, progress));
    await progress.step('📤 Sending…');
    let speed = ahead ? '⚡ ready before you tapped' : `⚡ ${ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`}`;
    if (job.autoNamed) speed += ' · named automatically (🔁 Rename to change)';
    const card = {
      caption: resultCaption(job, res.fileName, res.values, res.warnings, `<i>${speed}</i>`),
      parse_mode: 'HTML' as const,
      ...resultButtons(job),
    };
    let sentDoc;
    if (picture) {
      // picture of page 1 with the card and buttons, then the PDF itself
      await ctx.replyWithPhoto({ source: picture, filename: 'preview.png' }, card);
      sentDoc = await ctx.replyWithDocument({ source: Buffer.from(res.bytes), filename: res.fileName });
    } else {
      sentDoc = await ctx.replyWithDocument({ source: Buffer.from(res.bytes), filename: res.fileName }, card);
    }
    // remember Telegram's copy of the file: sharing it later needs no upload
    const fileId = (sentDoc as { document?: { file_id?: string } } | undefined)?.document?.file_id;
    if (fileId) job.result = { fileId, fileName: res.fileName };
    await progress.done();
    if (job.messageId) await react(ctx, '👍', job.messageId);
    await saveJob(job).catch((e) => console.warn('Could not save job:', e));
    console.log(`Filled "${res.fileName}" (${Object.keys(res.values).length} fields, ${Math.round(ms)} ms${ahead ? ', filled ahead' : ''})`);
  } catch (e) {
    console.error(e);
    await progress.done();
    if (job.messageId) await react(ctx, '😢', job.messageId);
    await ctx.reply(`❌ ${errText(e)}`);
  }
}

/** Fields the user can correct: everything mapped, in form order. */
function editableFields(job: Job) {
  return job.prepared.template.mappings.filter((m) => m.rule.type !== 'skip' && m.rule.type !== 'jobName');
}

function currentValue(job: Job, field: string): string {
  return job.overrides[field] ?? job.prepared.values[field] ?? '';
}

async function showFieldPicker(ctx: Context, job: Job) {
  const rows = editableFields(job).map((m, i) => {
    const v = currentValue(job, m.fieldName);
    const label = `${v ? '' : '❌ '}${m.fieldName}${v ? `: ${v.replace(/\n/g, ' ').slice(0, 30)}` : ''}`;
    return [Markup.button.callback(label, `fe:${job.id}:${i}`)];
  });
  await ctx.reply('Which value should I change?', Markup.inlineKeyboard(rows));
}

async function askFieldValue(ctx: Context, job: Job, index: number) {
  const m = editableFields(job)[index];
  if (!m) return;
  const info = job.prepared.fields.find((f) => f.name === m.fieldName);
  const now = currentValue(job, m.fieldName);
  const walking = !!job.walk?.length;
  const step = walking ? `🧩 ${job.walkTotal! - job.walk!.length + 1}/${job.walkTotal} · ` : '';
  const empty = m.rule.type === 'ask' ? 'type it in' : walking ? 'not found in the PDF' : 'Now: empty';
  const title = `${step}${m.fieldName} — ${now ? `Now: ${now}` : empty}`;
  const walkRow = walking
    ? [[Markup.button.callback('⏭ Skip', `sk:${job.id}`), Markup.button.callback('✋ Done for now', `st:${job.id}`)]]
    : [];
  if (info?.type === 'checkbox') {
    return ctx.reply(
      title,
      Markup.inlineKeyboard([
        [Markup.button.callback('☑️ Tick', `fo:${job.id}:${index}:1`), Markup.button.callback('⬜ Untick', `fo:${job.id}:${index}:0`)],
        ...walkRow,
      ]),
    );
  }
  if (info?.options?.length) {
    const opts = info.options.slice(0, 40).map((o, oi) => [Markup.button.callback(o, `fo:${job.id}:${index}:${oi}`)]);
    return ctx.reply(`${title}\nChoose:`, Markup.inlineKeyboard([...opts, ...walkRow]));
  }
  waitForValue(job.userId, job.id, m.fieldName);
  const teachRow = [Markup.button.callback('🎓 Pick it from the PDF', `tc:${job.id}:${index}:0`)];
  if (walking) return ctx.reply(`${title}\n\nType the value, or pick it from the PDF and I'll remember where it is:`, Markup.inlineKeyboard([teachRow, ...walkRow]));
  return ctx.reply(
    `${title}\n\nType the new value ("-" = leave empty), or pick it from the PDF and I'll remember where it is for next time:`,
    Markup.inlineKeyboard([teachRow]),
  );
}

/** Walk through the missing fields one by one; the PDF is sent once at the end. */
async function nextMissing(ctx: Context, job: Job) {
  const field = job.walk?.[0];
  if (field) return askFieldValue(ctx, job, editableFields(job).findIndex((m) => m.fieldName === field));
  job.walk = undefined;
  waitForName(job.userId, undefined);
  if (job.jobName) return finish(ctx, job, job.jobName);
  return askName(ctx, job);
}

async function setValue(ctx: Context, job: Job, field: string, value: string) {
  job.overrides[field] = value;
  waitForName(job.userId, undefined);
  if (job.walk?.length) {
    job.walk = job.walk.filter((f) => f !== field);
    return nextMissing(ctx, job);
  }
  if (job.jobName) return finish(ctx, job, job.jobName);
  return askName(ctx, job);
}

async function showLibrary(ctx: Context) {
  const list = await listTemplates();
  if (!list.length) return ctx.reply('No templates yet. Export one from the web app (Templates → Export) and send me the .json file.');
  const lines = list.map(({ template: t }) => {
    const n = t.mappings.filter((m) => m.rule.type !== 'skip').length;
    return `• ${t.name} — ${n} fields mapped, updated ${t.updatedAt.slice(0, 10)}`;
  });
  const rows = list.map(({ template: t }) => [
    Markup.button.callback(`🔍 ${t.name}`, `ti:${t.id}`),
    Markup.button.callback('🗑 Delete', `td:${t.id}`),
  ]);
  return ctx.reply(
    `🧩 ${list.length} template(s). For each PDF I use the one that finds the most values.\n\n${lines.join('\n')}\n\nSend another template .json to add it.`,
    Markup.inlineKeyboard(rows),
  );
}

/* ---------- home screen, menu and demo ---------- */

export const MENU_LABELS = { history: '🕘 History', templates: '🧩 Templates', autoname: '⚡ Autoname', help: '❓ Help' } as const;
const MENU = Markup.keyboard([
  [MENU_LABELS.history, MENU_LABELS.templates],
  [MENU_LABELS.autoname, MENU_LABELS.help],
])
  .resize()
  .persistent()
  .placeholder('Send a PDF…');

async function home(ctx: Context) {
  const list = await listTemplates();
  const jobs = (await history(ctx.from!.id, 200)).filter((h) => h.fileId).length;
  const auto = list.filter((t) => t.template.options.jobNamePattern).length;
  const hi = `👋 Hi ${ctx.from?.first_name ?? ''}!`;
  if (!list.length) {
    await ctx.reply(`${hi} I fill PDF forms from the PDFs you send me.`, MENU);
    return ctx.reply(
      'You have no template yet. Want to see how it works first? I will set up a demo form and fill it from a sample work order — takes 10 seconds.',
      Markup.inlineKeyboard([[Markup.button.callback('▶️ Show me with a demo', 'demo')]]),
    );
  }
  return ctx.reply(
    `${hi}\n\n🧩 ${list.length} template(s)${auto ? ` · ⚡ autopilot on for ${auto}` : ''}\n📄 ${jobs} PDF(s) filled so far\n\nJust send me a source PDF (or several at once).`,
    MENU,
  );
}

/** Install the demo template (sample job sheet) and run a real job on the sample work order. */
async function runDemo(ctx: Context) {
  const dir = path.join(PROJECT_DIR, 'samples');
  try {
    const form = new Uint8Array(await fs.readFile(path.join(dir, 'target-form.pdf')));
    const source = new Uint8Array(await fs.readFile(path.join(dir, 'source-example.pdf')));
    const t = emptyTemplate('Demo — job sheet', await listFormFields(form));
    t.id = 'demojobsheet';
    t.targetFormName = 'target-form.pdf';
    t.targetFormBase64 = bytesToBase64(form);
    const rules: Record<string, MappingRule> = {
      JobName: { type: 'jobName' },
      OrderNumber: { type: 'label', label: 'Order No' },
      ClientName: { type: 'label', label: 'Client' },
      Phone: { type: 'label', label: 'Phone' },
      SiteAddress: { type: 'label', label: 'Site address', valueOn: 'below' },
      OrderDate: { type: 'label', label: 'Date' },
      Total: { type: 'regex', pattern: 'Total amount:\\s*EUR\\s*([\\d.,]+)' },
      FilledOn: { type: 'date' },
      Priority: { type: 'static', value: 'Normal' },
    };
    t.mappings = t.mappings.map((m) => ({ ...m, rule: rules[m.fieldName] ?? m.rule }));
    await saveTemplate(JSON.stringify(t));
    await ctx.reply('✅ Demo template installed. Here is a sample work order, as if you had sent it:');
    await ctx.replyWithDocument({ source: Buffer.from(source), filename: 'work-order-example.pdf' });
    const job = await createJobFromBytes(ctx, source, 'work-order-example.pdf');
    await askName(ctx, job);
    await ctx.reply(
      '👆 Tap a name and watch the form fill. Then: export your own template from the web app (Templates → Export) and send me the .json — remove the demo any time in 🧩 Templates.',
    );
  } catch (e) {
    await ctx.reply(`❌ The demo could not start: ${errText(e)}`);
  }
}

/* ---------- autopilot naming ---------- */

/** The Job Name from the template's pattern, or undefined when there is none / it comes out empty. */
function autoName(job: Job): string | undefined {
  const pattern = job.prepared.template.options.jobNamePattern;
  if (!pattern) return undefined;
  const name = applyNamePattern(pattern, job.prepared, job.sourceName);
  return name || undefined;
}

/** No name given: use the autopilot pattern if there is one, else ask. */
async function nameOrAsk(ctx: Context, job: Job) {
  const auto = autoName(job);
  if (!auto) return askName(ctx, job);
  job.autoNamed = true;
  return finish(ctx, job, auto);
}


async function setNamePattern(templateId: string, pattern: string | undefined) {
  const hit = (await listTemplates()).find((t) => t.template.id === templateId);
  if (!hit) throw new Error('That template is no longer in the library.');
  const t = { ...hit.template, options: { ...hit.template.options, jobNamePattern: pattern }, updatedAt: new Date().toISOString() };
  if (!pattern) delete t.options.jobNamePattern;
  await saveTemplate(JSON.stringify(t));
  return t;
}

/* ---------- teach: tap the value in the PDF, the template learns the rule ---------- */

const PER_PAGE = 10;

async function showSegments(ctx: Context, job: Job, fieldIndex: number, page: number) {
  const m = editableFields(job)[fieldIndex];
  if (!m) return;
  const segs = allSegments(job.prepared.source);
  const pages = Math.max(1, Math.ceil(segs.length / PER_PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const rows = segs.slice(p * PER_PAGE, (p + 1) * PER_PAGE).map((x, i) => {
    const label = x.seg.text.length > 48 ? `${x.seg.text.slice(0, 45)}…` : x.seg.text;
    return [Markup.button.callback(label, `ts:${job.id}:${fieldIndex}:${p * PER_PAGE + i}`)];
  });
  const nav = [
    ...(p > 0 ? [Markup.button.callback('◀ Back', `tc:${job.id}:${fieldIndex}:${p - 1}`)] : []),
    ...(p < pages - 1 ? [Markup.button.callback(`More ▶ (${p + 1}/${pages})`, `tc:${job.id}:${fieldIndex}:${p + 1}`)] : []),
  ];
  const text = `🎓 Tap the value for ${m.fieldName} (text of ${job.sourceName}, top to bottom):`;
  const markup = Markup.inlineKeyboard([...rows, ...(nav.length ? [nav] : [])]);
  // page through by editing the same message
  if (ctx.callbackQuery && page !== 0) return ctx.editMessageText(text, markup).catch(() => ctx.reply(text, markup));
  return ctx.reply(text, markup);
}

async function teach(ctx: Context, job: Job, fieldIndex: number, segIndex: number) {
  const m = editableFields(job)[fieldIndex];
  const picked = allSegments(job.prepared.source)[segIndex];
  if (!m || !picked) return;
  const { rule, how } = learnRule(job.prepared.source, picked);
  const template = structuredClone(job.prepared.template);
  template.mappings = template.mappings.map((x) => (x.fieldName === m.fieldName ? { ...x, rule } : x));
  template.updatedAt = new Date().toISOString();
  try {
    await saveTemplate(JSON.stringify(template));
    job.prepared = await switchTemplate(job.prepared, template.id);
  } catch (e) {
    return ctx.reply(`❌ Could not update the template: ${errText(e)}`);
  }
  delete job.overrides[m.fieldName];
  job.ahead = undefined;
  waitForName(job.userId, undefined);
  await ctx.reply(
    `🎓 Learned: ${m.fieldName} = ${how}.\nFound here: “${job.prepared.values[m.fieldName] ?? ''}”. Saved in “${template.name}” for every future PDF.`,
  );
  if (job.walk?.length) {
    job.walk = job.walk.filter((f) => f !== m.fieldName);
    return nextMissing(ctx, job);
  }
  if (job.jobName) return finish(ctx, job, job.jobName);
  return askName(ctx, job);
}

/* ---------- batch: several PDFs sent together (one album) ---------- */

interface Batch {
  ctx: Context;
  docs: Doc[];
  /** the user's album messages, for 👀 / 👍 reactions */
  messageIds: number[];
  caption: string;
  timer?: NodeJS.Timeout;
}
const batches = new Map<string, Batch>();

/** Telegram delivers an album as separate messages: collect them for a moment, then run them together. */
function queueBatch(ctx: Context, groupId: string, doc: Doc, caption: string) {
  const key = `${ctx.from!.id}:${groupId}`;
  const b = batches.get(key) ?? { ctx, docs: [], caption: '', messageIds: [] };
  b.docs.push(doc);
  const mid = (ctx.message as { message_id?: number } | undefined)?.message_id;
  if (mid) {
    b.messageIds.push(mid);
    void react(ctx, '👀', mid);
  }
  if (caption) b.caption = caption;
  clearTimeout(b.timer);
  b.timer = setTimeout(() => {
    batches.delete(key);
    runBatch(b).catch((e) => console.error('Batch failed:', e));
  }, config.batchWaitMs);
  batches.set(key, b);
}

async function runBatch({ ctx, docs, caption, messageIds }: Batch) {
  if (docs.length === 1) {
    const job = await startJob(ctx, docs[0]!);
    if (!job) return;
    const name = commandArgs(caption, 'write') ?? (caption.startsWith('/') ? '' : caption);
    return name ? finish(ctx, job, name) : nameOrAsk(ctx, job);
  }
  const status = await ctx.reply(`📦 ${docs.length} PDFs — filling them all…`);
  await ctx.sendChatAction('upload_document').catch(() => {});
  const t0 = performance.now();
  const used = new Set<string>();
  const zipFiles: Record<string, Uint8Array> = {};
  const lines: string[] = [];
  const done: Job[] = [];
  for (const [i, doc] of docs.entries()) {
    await ctx.telegram
      .editMessageText(status.chat.id, status.message_id, undefined, `📦 Filling ${i + 1}/${docs.length} — ${doc.file_name ?? 'PDF'}…`)
      .catch(() => {});
    try {
      const job = await createJob(ctx, doc);
      let name = autoName(job) ?? job.suggestions[0] ?? job.sourceName.replace(/\.pdf$/i, '');
      for (let n = 2; used.has(name.toLowerCase()); n++) name = `${job.suggestions[0] ?? 'Job'} (${n})`;
      used.add(name.toLowerCase());
      job.jobName = name;
      const { res } = await produce(job, name, false);
      zipFiles[res.fileName] = res.bytes;
      await saveJob(job).catch(() => {});
      done.push(job);
      const missing = missingFields(job).length;
      lines.push(missing ? `🧩 ${esc(name)} — ${missing} missing` : `✅ ${esc(name)}`);
    } catch (e) {
      lines.push(`❌ ${esc(doc.file_name ?? 'file')} — ${esc(errText(e))}`);
    }
  }
  await ctx.telegram.deleteMessage(status.chat.id, status.message_id).catch(() => {});
  for (const id of messageIds) await react(ctx, done.length ? '👍' : '😢', id);
  if (!done.length) return ctx.reply(`❌ None of the ${docs.length} files could be filled:\n${lines.join('\n')}`, { parse_mode: 'HTML' });
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '-');
  const zipName = `Jobs ${stamp} (${done.length}).zip`;
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  let text = `📦 <b>${done.length} of ${docs.length} filled</b> — all in ${esc(zipName)}\n\n${lines.join('\n')}\n\n<i>⚡ ${secs} s · tap a job to check, rename or fix it</i>`;
  if (text.length > 1024) text = `📦 <b>${done.length} of ${docs.length} filled</b> — all in ${esc(zipName)}\n<i>⚡ ${secs} s</i>`;
  const rows = done.slice(0, 20).map((j) => {
    const missing = missingFields(j).length;
    return [Markup.button.callback(`${missing ? '🧩' : '🔍'} ${j.jobName}`.slice(0, 60), `hj:${j.id}`)];
  });
  await ctx.replyWithDocument(
    { source: Buffer.from(zipSync(zipFiles, { level: 0 })), filename: zipName },
    { caption: text, parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) },
  );
  console.log(`Batch: ${done.length}/${docs.length} filled in ${secs} s`);
}

async function importTemplate(ctx: Context, d: Doc) {
  if (!/\.json$/i.test(d.file_name ?? '') && d.mime_type !== 'application/json') {
    return ctx.reply('Send the template as a .json file (web app: Templates → Export).');
  }
  try {
    const bytes = await download(ctx, d);
    const { template, replaced } = await saveTemplate(new TextDecoder().decode(bytes));
    const count = (await listTemplates()).length;
    await ctx.reply(
      `✅ Template ${replaced ? 'updated' : 'added'}: ${template.name}\n${count} template(s) in the library — I pick the best one for each PDF.\n\n${templateSummary(template)}`,
    );
  } catch (e) {
    await ctx.reply(`❌ Could not use that template: ${errText(e)}`);
  }
}

export function createBot(token = config.token): Telegraf {
  const bot = new Telegraf(token, { handlerTimeout: 120_000 });

  // Ignore everybody except the allowed user(s). No reply, so the bot stays silent for strangers.
  bot.use(async (ctx, next) => {
    const id = ctx.from?.id;
    if (!id || !config.allowedUserIds.includes(id)) {
      if (ctx.from) console.log(`Ignored update from user ${id} (@${ctx.from.username ?? '-'})`);
      return;
    }
    return next();
  });

  bot.start((ctx) => home(ctx));
  bot.help((ctx) => ctx.reply(HELP, MENU));
  bot.action('demo', async (ctx) => {
    await ctx.answerCbQuery('Setting up the demo…').catch(() => {});
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    return runDemo(ctx);
  });

  bot.command(['template', 'templates'], async (ctx) => {
    const reply = (ctx.message as any).reply_to_message;
    if (reply?.document) return importTemplate(ctx, reply.document);
    return showLibrary(ctx);
  });

  // "@bot <name>" in any chat: your filled PDFs, ready to send there
  bot.on('inline_query', async (ctx) => {
    const q = ctx.inlineQuery.query.trim().toLowerCase();
    const list = (await history(ctx.from.id, 200)).filter(
      (h) => h.fileId && (!q || `${h.jobName} ${h.sourceName}`.toLowerCase().includes(q)),
    );
    const day = (t: number) => new Date(t).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    await ctx.answerInlineQuery(
      list.slice(0, 50).map((h) => ({
        type: 'document' as const,
        id: h.id,
        title: h.fileName ?? `${h.jobName}.pdf`,
        document_file_id: h.fileId!,
        description: `${h.templateName} · ${day(h.updatedAt)}`,
      })),
      { cache_time: 0, is_personal: true },
    );
  });

  const showHistory = async (ctx: Context) => {
    const list = await history(ctx.from!.id, 10);
    if (!list.length) return ctx.reply('No jobs yet. Send me a source PDF to start.');
    const day = (t: number) => new Date(t).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const rows = list.map((h) => [
      Markup.button.callback(`${h.jobName ? '📄' : '⏳'} ${h.jobName ?? h.sourceName} · ${day(h.updatedAt)}`.slice(0, 60), `hj:${h.id}`),
    ]);
    return ctx.reply('🕘 Your last jobs — tap one to get its PDF again (then rename, fix or flatten as usual).', Markup.inlineKeyboard(rows));
  };
  bot.command('history', showHistory);
  bot.action(/^hj:(\w+)$/, async (ctx) => {
    const job = await findJob(ctx.match[1]!);
    await ctx.answerCbQuery(job ? undefined : 'That job is gone.').catch(() => {});
    if (!job) return;
    if (job.jobName) return finish(ctx, job, job.jobName);
    return askName(ctx, job);
  });

  // template library: details / delete
  bot.action(/^ti:(\w+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const hit = (await listTemplates()).find((t) => t.template.id === ctx.match[1]);
    if (!hit) return ctx.reply('That template is no longer in the library.');
    return ctx.reply(templateSummary(hit.template));
  });
  bot.action(/^td:(\w+)$/, async (ctx) => {
    const gone = await deleteTemplate(ctx.match[1]!);
    await ctx.answerCbQuery(gone ? `Deleted ${gone.name}` : 'Already gone').catch(() => {});
    return showLibrary(ctx);
  });

  // switch template for a job
  bot.action(/^ot:(\w+)$/, async (ctx) => {
    const job = await findJob(ctx.match[1]!);
    await ctx.answerCbQuery(job ? undefined : 'This job expired, send the PDF again.').catch(() => {});
    if (!job) return;
    const rows = job.prepared.ranking.map((r, i) => [
      Markup.button.callback(`${r.id === job.prepared.template.id ? '✅ ' : ''}${r.name} — ${r.found}/${r.total}`, `tp:${job.id}:${i}`),
    ]);
    return ctx.reply('Which template? (found / fields it reads from the PDF)', Markup.inlineKeyboard(rows));
  });
  bot.action(/^tp:(\w+):(\d+)$/, async (ctx) => {
    const job = await findJob(ctx.match[1]!);
    const choice = job?.prepared.ranking[Number(ctx.match[2])];
    await ctx.answerCbQuery(choice ? `Using ${choice.name}` : 'This job expired, send the PDF again.').catch(() => {});
    if (!job || !choice) return;
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    try {
      job.prepared = await switchTemplate(job.prepared, choice.id);
    } catch (e) {
      return ctx.reply(`❌ ${errText(e)}`);
    }
    job.overrides = {};
    job.ahead = undefined;
    job.suggestions = suggestJobNames(job.prepared, job.sourceName);
    if (job.jobName) return finish(ctx, job, job.jobName);
    return askName(ctx, job);
  });

  // "/write Job" as a reply to a PDF ("/write" alone: I ask for the name)
  bot.command('write', async (ctx) => {
    const jobName = commandArgs(ctx.message.text, 'write') ?? '';
    const doc: Doc | undefined = (ctx.message as any).reply_to_message?.document;
    if (!doc) {
      const pending = jobAwaitingName(ctx.from.id);
      if (pending && jobName) return finish(ctx, pending, jobName);
      return ctx.reply('Send me the source PDF first (or reply to one with /write <Job Name>).');
    }
    const job = await startJob(ctx, doc);
    if (!job) return;
    if (jobName) return finish(ctx, job, jobName);
    return askName(ctx, job);
  });

  bot.on(message('document'), async (ctx) => {
    const caption = (ctx.message.caption ?? '').trim();
    const document = ctx.message.document;
    if (commandArgs(caption, 'template') !== undefined) return importTemplate(ctx, document);
    if (!isPdf(document) && /\.json$/i.test(document.file_name ?? '')) return importTemplate(ctx, document);
    // several PDFs sent together: one batch
    const groupId = (ctx.message as any).media_group_id as string | undefined;
    if (groupId) return queueBatch(ctx, groupId, document, caption);
    const job = await startJob(ctx, document);
    if (!job) return;
    // caption "/write Name" or simply "Name" = the Job Name
    const name = commandArgs(caption, 'write') ?? (caption.startsWith('/') ? '' : caption);
    if (name) return finish(ctx, job, name);
    // the same PDF again? offer the earlier result instead of a second job
    const dup = await findDuplicate(job.userId, job.sourceHash!, job.id);
    if (dup) {
      const when = new Date(dup.updatedAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
      return ctx.reply(
        `♻️ You already filled this PDF on ${when} as “${dup.jobName}”.`,
        Markup.inlineKeyboard([
          [Markup.button.callback('📄 Send that PDF again', `dp:${dup.id}`)],
          [Markup.button.callback('🆕 Fill it as a new job', `dn:${job.id}`)],
        ]),
      );
    }
    return nameOrAsk(ctx, job);
  });

  bot.action(/^dp:(\w+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    const old = await findJob(ctx.match[1]!);
    if (!old?.result) return ctx.reply('That earlier job is gone. Send the PDF again to fill it.');
    return ctx.replyWithDocument(old.result.fileId, {
      caption: `♻️ <b>${esc(old.result.fileName)}</b> — the earlier result, sent again.`,
      parse_mode: 'HTML',
      ...resultButtons(old),
    });
  });
  bot.action(/^dn:(\w+)$/, async (ctx) => {
    const job = await findJob(ctx.match[1]!);
    await ctx.answerCbQuery(job ? undefined : 'This job is gone, send the PDF again.').catch(() => {});
    if (!job) return;
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    return nameOrAsk(ctx, job);
  });

  // tap on a suggested name
  bot.action(/^jn:(\w+):(\d+)$/, async (ctx) => {
    const job = await findJob(ctx.match[1]!);
    const name = job?.suggestions[Number(ctx.match[2])];
    await ctx.answerCbQuery(job ? undefined : 'This job expired, send the PDF again.').catch(() => {});
    if (!job || !name) return;
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    job.autoNamed = false;
    await finish(ctx, job, name);
    // same kind of name picked again? offer to do it automatically from now on
    const idx = Number(ctx.match[2]);
    const idea = nameIdeas(job.prepared, job.sourceName)[idx];
    const tid = job.prepared.template.id;
    if (!idea || job.prepared.template.options.jobNamePattern) return;
    const h = habits.get(tid);
    const count = h?.pattern === idea.pattern ? h.count + 1 : 1;
    habits.set(tid, { pattern: idea.pattern, count });
    if (count >= 2) {
      habits.delete(tid);
      return ctx.reply(
        `💡 You named the last ${count} jobs the same way: ${idea.pattern}\nShall I name jobs like this automatically? Then a PDF is filled the moment you send it.`,
        Markup.inlineKeyboard([
          [Markup.button.callback('⚡ Yes, always name like this', `ap:${job.id}:${idx}`)],
          [Markup.button.callback('No thanks', `an:${job.id}`)],
        ]),
      );
    }
  });
  bot.action(/^ap:(\w+):(\d+)$/, async (ctx) => {
    const job = await findJob(ctx.match[1]!);
    const idea = job && nameIdeas(job.prepared, job.sourceName)[Number(ctx.match[2])];
    await ctx.answerCbQuery().catch(() => {});
    if (!job || !idea) return;
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    const t = await setNamePattern(job.prepared.template.id, idea.pattern);
    return ctx.reply(`⚡ Autopilot on for “${t.name}”: jobs are named ${idea.pattern}.\nJust send PDFs now. Change or stop it with /autoname.`);
  });
  bot.action(/^an:(\w+)$/, async (ctx) => {
    await ctx.answerCbQuery('OK, I will keep asking.').catch(() => {});
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  });

  // /autoname [pattern | off]
  const autonameCmd = async (ctx: Context) => {
    const arg = commandArgs((ctx.message as { text?: string } | undefined)?.text, 'autoname') ?? '';
    const last = (await history(ctx.from!.id, 1))[0];
    const lastJob = last && (await findJob(last.id));
    const list = await listTemplates();
    const target = lastJob?.prepared.template ?? list[0]?.template;
    if (!target) return ctx.reply('No templates yet. Send me a template .json first.');
    const fields = target.mappings.filter((m) => m.fieldType === 'text').map((m) => `{${m.fieldName}}`);
    if (!arg) {
      const now = target.options.jobNamePattern;
      return ctx.reply(
        `Template “${target.name}”: ${now ? `⚡ autopilot ON — ${now}` : 'autopilot off (I ask for each name)'}\n\n` +
          `Set it: /autoname {${fields[0]?.slice(1, -1) ?? 'Field'}} - {date}\nStop it: /autoname off\n\nYou can use: ${[...fields, '{file}', '{date}'].join(' ')}`,
      );
    }
    if (/^(off|stop|none)$/i.test(arg)) {
      await setNamePattern(target.id, undefined);
      return ctx.reply(`Autopilot off for “${target.name}”. I will ask for each Job Name again.`);
    }
    if (!/\{[^}]+\}/.test(arg)) return ctx.reply('The pattern needs at least one {Field}, e.g. /autoname {ClientName} - {date}');
    const t = await setNamePattern(target.id, arg);
    const example = lastJob ? applyNamePattern(arg, { ...lastJob.prepared, template: t }, lastJob.sourceName) : '';
    return ctx.reply(`⚡ Autopilot on for “${t.name}”: ${arg}${example ? `\nYour last PDF would be: ${example}` : ''}`);
  };
  bot.command('autoname', autonameCmd);

  // result card: flattened <-> editable copy
  bot.action(/^fl:(\w+)$/, async (ctx) => {
    const job = await findJob(ctx.match[1]!);
    if (!job?.jobName) return ctx.answerCbQuery('This job expired, send the PDF again.').catch(() => {});
    job.flatten = !isFlat(job);
    await ctx.answerCbQuery(job.flatten ? 'Making a flattened copy…' : 'Making an editable copy…').catch(() => {});
    return finish(ctx, job, job.jobName);
  });

  // result card: rename -> ask for a new Job Name
  bot.action(/^rn:(\w+)$/, async (ctx) => {
    const job = await findJob(ctx.match[1]!);
    if (!job) return ctx.answerCbQuery('This job expired, send the PDF again.').catch(() => {});
    await ctx.answerCbQuery().catch(() => {});
    waitForName(job.userId, job.id);
    return ctx.reply(`New Job Name for ${job.sourceName}?`, Markup.forceReply().placeholder(job.jobName ?? 'Job Name'));
  });

  // result card: fill the missing fields one after another
  bot.action(/^mf:(\w+)$/, async (ctx) => {
    const job = await findJob(ctx.match[1]!);
    await ctx.answerCbQuery(job ? undefined : 'This job expired, send the PDF again.').catch(() => {});
    if (!job) return;
    job.walk = missingFields(job);
    job.walkTotal = job.walk.length;
    return nextMissing(ctx, job);
  });
  bot.action(/^sk:(\w+)$/, async (ctx) => {
    const job = await findJob(ctx.match[1]!);
    await ctx.answerCbQuery().catch(() => {});
    const field = job?.walk?.shift();
    if (!job || !field) return;
    (job.skipped ??= []).push(field);
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    return nextMissing(ctx, job);
  });
  bot.action(/^st:(\w+)$/, async (ctx) => {
    const job = await findJob(ctx.match[1]!);
    await ctx.answerCbQuery().catch(() => {});
    if (!job?.walk) return;
    job.walk = [];
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    return nextMissing(ctx, job);
  });

  // teach: browse the PDF text / pick a piece
  bot.action(/^tc:(\w+):(\d+):(\d+)$/, async (ctx) => {
    const job = await findJob(ctx.match[1]!);
    await ctx.answerCbQuery(job ? undefined : 'This job is gone, send the PDF again.').catch(() => {});
    if (job) return showSegments(ctx, job, Number(ctx.match[2]), Number(ctx.match[3]));
  });
  bot.action(/^ts:(\w+):(\d+):(\d+)$/, async (ctx) => {
    const job = await findJob(ctx.match[1]!);
    await ctx.answerCbQuery(job ? 'Learning…' : 'This job is gone, send the PDF again.').catch(() => {});
    if (!job) return;
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    return teach(ctx, job, Number(ctx.match[2]), Number(ctx.match[3]));
  });

  // result card: fix a value
  bot.action(/^fx:(\w+)$/, async (ctx) => {
    const job = await findJob(ctx.match[1]!);
    await ctx.answerCbQuery(job ? undefined : 'This job expired, send the PDF again.').catch(() => {});
    if (job) return showFieldPicker(ctx, job);
  });
  bot.action(/^fe:(\w+):(\d+)$/, async (ctx) => {
    const job = await findJob(ctx.match[1]!);
    await ctx.answerCbQuery(job ? undefined : 'This job expired, send the PDF again.').catch(() => {});
    if (job) return askFieldValue(ctx, job, Number(ctx.match[2]));
  });
  // option / checkbox chosen
  bot.action(/^fo:(\w+):(\d+):(\d+)$/, async (ctx) => {
    const job = await findJob(ctx.match[1]!);
    const m = job && editableFields(job)[Number(ctx.match[2])];
    await ctx.answerCbQuery(m ? undefined : 'This job expired, send the PDF again.').catch(() => {});
    if (!job || !m) return;
    const info = job.prepared.fields.find((f) => f.name === m.fieldName);
    const oi = Number(ctx.match[3]);
    const value = info?.type === 'checkbox' ? (oi ? 'yes' : '') : (info?.options?.[oi] ?? '');
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    return setValue(ctx, job, m.fieldName, value);
  });

  // typed text while a PDF waits for its Job Name
  bot.on(message('text'), async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return;
    // the menu at the bottom of the chat
    if (text === MENU_LABELS.history) return showHistory(ctx);
    if (text === MENU_LABELS.templates) return showLibrary(ctx);
    if (text === MENU_LABELS.autoname) return autonameCmd(ctx);
    if (text === MENU_LABELS.help) return ctx.reply(HELP, MENU);
    const pending = pendingInput(ctx.from.id);
    if (!pending) return ctx.reply('Send me a source PDF and I will fill the form. /help');
    if (pending.field) return setValue(ctx, pending.job, pending.field, text === '-' ? '' : text);
    pending.job.autoNamed = false;
    return finish(ctx, pending.job, text);
  });

  bot.catch((err, ctx) => {
    console.error(`Error for update ${ctx.update.update_id}:`, err);
  });

  return bot;
}
