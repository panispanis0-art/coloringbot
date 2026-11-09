import { Markup, Telegraf, type Context } from 'telegraf';
import { message } from 'telegraf/filters';
import { config } from './config.ts';
import { loadTemplate, prepareJob, renderJob, saveTemplate, suggestJobNames, templateSummary } from './pdf.ts';
import { addJob, getJob, jobAwaitingName, newJobId, pendingInput, waitForName, waitForValue, type Job } from './jobs.ts';

export const HELP = [
  'PDF Job Filler bot',
  '',
  '📄 Just send me the source PDF. I read it and ask for the Job Name —',
  '   tap a suggestion or type one. You get back "<Job Name>.pdf".',
  '   Shortcut: put the Job Name in the caption of the PDF.',
  '',
  '/write <Job Name> — as caption of a PDF, or as a reply to a PDF.',
  '/template — show the active template.',
  '   Send a template .json (exported from the web app) with the caption /template to replace it.',
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
    return addJob({
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
  } catch (e) {
    console.error(e);
    await ctx.reply(`❌ ${errText(e)}`);
    return undefined;
  }
}

/** Ask for the Job Name: suggestion buttons + "type it" reply box. */
async function askName(ctx: Context, job: Job) {
  waitForName(job.userId, job.id);
  const found = Object.values(job.prepared.values).filter(Boolean).length;
  const buttons = job.suggestions.map((s, i) => [Markup.button.callback(`📝 ${s}`, `jn:${job.id}:${i}`)]);
  await ctx.reply(
    `📄 ${job.sourceName} — read, ${found} value(s) found.\n\nWhat's the Job Name? Tap one or type your own.`,
    buttons.length ? Markup.inlineKeyboard(buttons) : Markup.forceReply().placeholder('Job Name'),
  );
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function isFlat(job: Job): boolean {
  return job.flatten ?? config.flatten ?? job.prepared.template.options.flatten;
}

/** The message under the PDF: every mapped field with its value, missing ones marked. */
export function resultCaption(job: Job, fileName: string, values: Record<string, string>, warnings: string[]): string {
  const mapped = job.prepared.template.mappings.filter((m) => m.rule.type !== 'skip');
  const missing = mapped.filter((m) => !values[m.fieldName]);
  const head = `✅ <b>${esc(fileName)}</b>\n${mapped.length - missing.length}/${mapped.length} fields filled · ${isFlat(job) ? '🔒 flattened' : '📝 editable'}`;
  const rows = mapped.map((m) => {
    const v = values[m.fieldName];
    const short = v && v.length > 60 ? `${v.slice(0, 57)}…` : v;
    return v ? `• ${esc(m.fieldName)}: <b>${esc(short!.replace(/\n/g, ' / '))}</b>` : `• ${esc(m.fieldName)}: ❌ <i>not found</i>`;
  });
  const warn = warnings.filter((w) => !/is not in this form/.test(w)).map((w) => `⚠️ ${esc(w)}`);
  let out = [head, '', ...rows, ...(warn.length ? ['', ...warn] : [])].join('\n');
  // Telegram captions are limited to 1024 characters
  while (out.length > 1000 && rows.length) {
    rows.pop();
    out = [head, '', ...rows, '…', ...(warn.length ? ['', ...warn] : [])].join('\n');
  }
  return out.slice(0, 1024);
}

function resultButtons(job: Job) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✏️ Fix a value', `fx:${job.id}`)],
    [
      Markup.button.callback(isFlat(job) ? '📝 Editable copy' : '🔒 Flattened copy', `fl:${job.id}`),
      Markup.button.callback('🔁 Rename', `rn:${job.id}`),
    ],
  ]);
}

async function finish(ctx: Context, job: Job, jobName: string) {
  waitForName(job.userId, undefined);
  job.jobName = jobName.trim();
  await ctx.sendChatAction('upload_document').catch(() => {});
  try {
    const res = await renderJob({ prepared: job.prepared, jobName: job.jobName, overrides: job.overrides, flatten: isFlat(job) });
    await ctx.replyWithDocument(
      { source: Buffer.from(res.bytes), filename: res.fileName },
      { caption: resultCaption(job, res.fileName, res.values, res.warnings), parse_mode: 'HTML', ...resultButtons(job) },
    );
    console.log(`Filled "${res.fileName}" (${Object.keys(res.values).length} fields, ${res.warnings.length} warnings)`);
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
  const nowText = now ? `Now: ${now}` : 'Now: empty';
  if (info?.type === 'checkbox') {
    return ctx.reply(
      `${m.fieldName} — ${nowText}`,
      Markup.inlineKeyboard([[Markup.button.callback('☑️ Tick', `fo:${job.id}:${index}:1`), Markup.button.callback('⬜ Untick', `fo:${job.id}:${index}:0`)]]),
    );
  }
  if (info?.options?.length) {
    const opts = info.options.slice(0, 40).map((o, oi) => [Markup.button.callback(o, `fo:${job.id}:${index}:${oi}`)]);
    return ctx.reply(`${m.fieldName} — ${nowText}\nChoose:`, Markup.inlineKeyboard(opts));
  }
  waitForValue(job.userId, job.id, m.fieldName);
  return ctx.reply(`${m.fieldName} — ${nowText}\n\nType the new value ("-" = leave empty):`, Markup.forceReply().placeholder(m.fieldName));
}

async function setValue(ctx: Context, job: Job, field: string, value: string) {
  job.overrides[field] = value;
  waitForName(job.userId, undefined);
  if (job.jobName) return finish(ctx, job, job.jobName);
  return askName(ctx, job);
}

async function importTemplate(ctx: Context, d: Doc) {
  if (!/\.json$/i.test(d.file_name ?? '') && d.mime_type !== 'application/json') {
    return ctx.reply('Send the template as a .json file (web app: Templates → Export).');
  }
  try {
    const bytes = await download(ctx, d);
    const t = await saveTemplate(new TextDecoder().decode(bytes));
    await ctx.reply(`✅ Template saved.\n\n${templateSummary(t)}`);
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

  bot.command('template', async (ctx) => {
    const reply = (ctx.message as any).reply_to_message;
    if (reply?.document) return importTemplate(ctx, reply.document);
    try {
      await ctx.reply(templateSummary(await loadTemplate()));
    } catch (e) {
      await ctx.reply(`⚠️ ${errText(e)}`);
    }
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
    const job = getJob(ctx.match[1]!);
    const name = job?.suggestions[Number(ctx.match[2])];
    await ctx.answerCbQuery(job ? undefined : 'This job expired, send the PDF again.').catch(() => {});
    if (!job || !name) return;
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    return finish(ctx, job, name);
  });

  // result card: flattened <-> editable copy
  bot.action(/^fl:(\w+)$/, async (ctx) => {
    const job = getJob(ctx.match[1]!);
    if (!job?.jobName) return ctx.answerCbQuery('This job expired, send the PDF again.').catch(() => {});
    job.flatten = !isFlat(job);
    await ctx.answerCbQuery(job.flatten ? 'Making a flattened copy…' : 'Making an editable copy…').catch(() => {});
    return finish(ctx, job, job.jobName);
  });

  // result card: rename -> ask for a new Job Name
  bot.action(/^rn:(\w+)$/, async (ctx) => {
    const job = getJob(ctx.match[1]!);
    if (!job) return ctx.answerCbQuery('This job expired, send the PDF again.').catch(() => {});
    await ctx.answerCbQuery().catch(() => {});
    waitForName(job.userId, job.id);
    return ctx.reply(`New Job Name for ${job.sourceName}?`, Markup.forceReply().placeholder(job.jobName ?? 'Job Name'));
  });

  // result card: fix a value
  bot.action(/^fx:(\w+)$/, async (ctx) => {
    const job = getJob(ctx.match[1]!);
    await ctx.answerCbQuery(job ? undefined : 'This job expired, send the PDF again.').catch(() => {});
    if (job) return showFieldPicker(ctx, job);
  });
  bot.action(/^fe:(\w+):(\d+)$/, async (ctx) => {
    const job = getJob(ctx.match[1]!);
    await ctx.answerCbQuery(job ? undefined : 'This job expired, send the PDF again.').catch(() => {});
    if (job) return askFieldValue(ctx, job, Number(ctx.match[2]));
  });
  // option / checkbox chosen
  bot.action(/^fo:(\w+):(\d+):(\d+)$/, async (ctx) => {
    const job = getJob(ctx.match[1]!);
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
