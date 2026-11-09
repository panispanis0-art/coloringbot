import { Markup, Telegraf, type Context } from 'telegraf';
import { message } from 'telegraf/filters';
import { config } from './config.ts';
import {
  deleteTemplate,
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
import { findJob, history, saveJob } from './store.ts';
import { addJob, jobAwaitingName, newJobId, pendingInput, waitForName, waitForValue, type Job } from './jobs.ts';

export const HELP = [
  'PDF Job Filler bot',
  '',
  '📄 Just send me the source PDF. I read it and ask for the Job Name —',
  '   tap a suggestion or type one. You get back "<Job Name>.pdf".',
  '   Shortcut: put the Job Name in the caption of the PDF.',
  '',
  '/write <Job Name> — as caption of a PDF, or as a reply to a PDF.',
  '/templates — your templates (I pick the best one for each PDF).',
  '   Send a template .json (exported from the web app) to add it.',
  '/history — your last jobs, tap one to get its PDF again.',
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
async function startJob(ctx: Context, doc: Doc): Promise<Job | undefined> {
  if (!isPdf(doc)) {
    await ctx.reply('That file is not a PDF.');
    return undefined;
  }
  await ctx.sendChatAction('typing').catch(() => {});
  try {
    const sourceBytes = await download(ctx, doc);
    const prepared = await prepareJob(sourceBytes);
    const sourceName = doc.file_name ?? 'source.pdf';
    const job = addJob({
      id: newJobId(),
      userId: ctx.from!.id,
      chatId: ctx.chat!.id,
      sourceName,
      sourceBytes,
      prepared,
      createdAt: Date.now(),
      overrides: {},
      suggestions: suggestJobNames(prepared, sourceName),
    });
    await saveJob(job).catch((e) => console.warn('Could not save job:', e));
    return job;
  } catch (e) {
    console.error(e);
    await ctx.reply(`❌ ${errText(e)}`);
    return undefined;
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
  ]);
}

interface Output {
  res: Rendered;
  picture?: Buffer | undefined;
  /** milliseconds spent filling + drawing */
  ms: number;
}

/** Fill the form and draw the preview. */
async function produce(job: Job, jobName: string): Promise<Output> {
  const t0 = performance.now();
  const res = await renderJob({ prepared: job.prepared, jobName, overrides: job.overrides, flatten: isFlat(job) });
  const picture = config.preview ? await renderPreview(res.bytes).catch((e) => void console.warn('Preview failed:', e)) : undefined;
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
  try {
    const ahead = job.ahead?.key === outputKey(job, job.jobName) ? job.ahead.promise : undefined;
    job.ahead = undefined;
    const { res, picture, ms } = await (ahead ?? produce(job, job.jobName));
    const speed = ahead ? '⚡ ready before you tapped' : `⚡ ${ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`}`;
    const card = {
      caption: resultCaption(job, res.fileName, res.values, res.warnings, `<i>${speed}</i>`),
      parse_mode: 'HTML' as const,
      ...resultButtons(job),
    };
    if (picture) {
      // picture of page 1 with the card and buttons, then the PDF itself
      await ctx.replyWithPhoto({ source: picture, filename: 'preview.png' }, card);
      await ctx.replyWithDocument({ source: Buffer.from(res.bytes), filename: res.fileName });
    } else {
      await ctx.replyWithDocument({ source: Buffer.from(res.bytes), filename: res.fileName }, card);
    }
    await saveJob(job).catch((e) => console.warn('Could not save job:', e));
    console.log(`Filled "${res.fileName}" (${Object.keys(res.values).length} fields, ${Math.round(ms)} ms${ahead ? ', filled ahead' : ''})`);
  } catch (e) {
    console.error(e);
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
  const title = `${step}${m.fieldName} — ${now ? `Now: ${now}` : walking ? 'not found in the PDF' : 'Now: empty'}`;
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
  if (walking) return ctx.reply(`${title}\n\nType the value:`, Markup.inlineKeyboard(walkRow));
  return ctx.reply(`${title}\n\nType the new value ("-" = leave empty):`, Markup.forceReply().placeholder(m.fieldName));
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

  bot.start((ctx) => ctx.reply(`Hi ${ctx.from.first_name ?? ''}! Your user id ${ctx.from.id} is allowed.\n\n${HELP}`));
  bot.help((ctx) => ctx.reply(HELP));

  bot.command(['template', 'templates'], async (ctx) => {
    const reply = (ctx.message as any).reply_to_message;
    if (reply?.document) return importTemplate(ctx, reply.document);
    return showLibrary(ctx);
  });

  bot.command('history', async (ctx) => {
    const list = await history(ctx.from.id, 10);
    if (!list.length) return ctx.reply('No jobs yet. Send me a source PDF to start.');
    const day = (t: number) => new Date(t).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const rows = list.map((h) => [
      Markup.button.callback(`${h.jobName ? '📄' : '⏳'} ${h.jobName ?? h.sourceName} · ${day(h.updatedAt)}`.slice(0, 60), `hj:${h.id}`),
    ]);
    return ctx.reply('🕘 Your last jobs — tap one to get its PDF again (then rename, fix or flatten as usual).', Markup.inlineKeyboard(rows));
  });
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
    const job = await startJob(ctx, document);
    if (!job) return;
    // caption "/write Name" or simply "Name" = the Job Name
    const name = commandArgs(caption, 'write') ?? (caption.startsWith('/') ? '' : caption);
    if (name) return finish(ctx, job, name);
    return askName(ctx, job);
  });

  // tap on a suggested name
  bot.action(/^jn:(\w+):(\d+)$/, async (ctx) => {
    const job = await findJob(ctx.match[1]!);
    const name = job?.suggestions[Number(ctx.match[2])];
    await ctx.answerCbQuery(job ? undefined : 'This job expired, send the PDF again.').catch(() => {});
    if (!job || !name) return;
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    return finish(ctx, job, name);
  });

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
    const pending = pendingInput(ctx.from.id);
    if (!pending) return ctx.reply('Send me a source PDF and I will fill the form. /help');
    if (pending.field) return setValue(ctx, pending.job, pending.field, text === '-' ? '' : text);
    return finish(ctx, pending.job, text);
  });

  bot.catch((err, ctx) => {
    console.error(`Error for update ${ctx.update.update_id}:`, err);
  });

  return bot;
}
