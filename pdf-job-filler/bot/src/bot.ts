import { Telegraf, type Context } from 'telegraf';
import { message } from 'telegraf/filters';
import { config } from './config.ts';
import { fillJob, loadTemplate, saveTemplate, templateSummary } from './pdf.ts';

export const HELP = [
  'PDF Job Filler bot',
  '',
  '/write <Job Name> — fill the form from a source PDF.',
  '   • send the source PDF with the caption: /write My Job',
  '   • or reply to a PDF you already sent with: /write My Job',
  '   You get back "My Job.pdf".',
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

async function download(ctx: Context, d: Doc): Promise<Uint8Array> {
  if (d.file_size && d.file_size > 20 * 1024 * 1024) throw new Error('File is over 20 MB, Telegram bots cannot download it.');
  const link = await ctx.telegram.getFileLink(d.file_id);
  const res = await fetch(link);
  if (!res.ok) throw new Error(`Download failed (${res.status}).`);
  return new Uint8Array(await res.arrayBuffer());
}

async function write(ctx: Context, jobName: string, doc: Doc | undefined) {
  if (!jobName) return ctx.reply('Add a Job Name: /write <Job Name>');
  if (!doc) return ctx.reply('Attach the source PDF with this caption, or reply to a PDF with /write <Job Name>.');
  if (!isPdf(doc)) return ctx.reply('That file is not a PDF.');
  await ctx.sendChatAction('upload_document').catch(() => {});
  try {
    const source = await download(ctx, doc);
    const res = await fillJob(source, jobName);
    const filled = Object.keys(res.values).length;
    let caption = `✅ ${res.fileName} — ${filled} field(s) filled.`;
    if (res.warnings.length) caption += `\n⚠️ ${res.warnings.slice(0, 5).join('\n⚠️ ')}`;
    if (res.warnings.length > 5) caption += `\n…and ${res.warnings.length - 5} more`;
    await ctx.replyWithDocument(
      { source: Buffer.from(res.bytes), filename: res.fileName },
      { caption: caption.slice(0, 1000) },
    );
    console.log(`Filled "${res.fileName}" (${filled} fields, ${res.warnings.length} warnings)`);
  } catch (e: any) {
    console.error(e);
    await ctx.reply(`❌ ${e?.message ?? e}`);
  }
}

async function importTemplate(ctx: Context, d: Doc) {
  if (!/\.json$/i.test(d.file_name ?? '') && d.mime_type !== 'application/json') {
    return ctx.reply('Send the template as a .json file (web app: Templates → Export).');
  }
  try {
    const bytes = await download(ctx, d);
    const t = await saveTemplate(new TextDecoder().decode(bytes));
    await ctx.reply(`✅ Template saved.\n\n${templateSummary(t)}`);
  } catch (e: any) {
    await ctx.reply(`❌ Could not use that template: ${e?.message ?? e}`);
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
    } catch (e: any) {
      await ctx.reply(`⚠️ ${e.message}`);
    }
  });

  // "/write Job" typed as text, as a reply to a PDF
  bot.command('write', async (ctx) => {
    const jobName = commandArgs(ctx.message.text, 'write') ?? '';
    const reply = (ctx.message as any).reply_to_message;
    await write(ctx, jobName, reply?.document);
  });

  // a document whose caption is a command: "/write Job" (PDF) or "/template" (JSON)
  bot.on(message('document'), async (ctx) => {
    const caption = ctx.message.caption;
    const jobName = commandArgs(caption, 'write');
    if (jobName !== undefined) return write(ctx, jobName, ctx.message.document);
    if (commandArgs(caption, 'template') !== undefined) return importTemplate(ctx, ctx.message.document);
    if (isPdf(ctx.message.document)) return ctx.reply('Got the PDF. Reply to it with /write <Job Name> to fill the form.');
  });

  bot.catch((err, ctx) => {
    console.error(`Error for update ${ctx.update.update_id}:`, err);
  });

  return bot;
}
