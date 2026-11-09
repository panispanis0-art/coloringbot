// Offline test of the bot: Telegram API calls and file downloads are stubbed.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { Telegram } from 'telegraf';

const samples = path.resolve(import.meta.dirname, '../../samples');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pjf-bot-'));
process.env.ALLOWED_USER_ID = '42';
process.env.TEMPLATE_PATH = path.join(tmp, 'template.json');
process.env.BOT_TOKEN = '123:TEST';

const { createBot, commandArgs } = await import('../src/bot.ts');
const { clearJobs } = await import('../src/jobs.ts');
const { listFormFields, emptyTemplate, bytesToBase64 } = await import('../../shared/src/index.ts');

type Call = { method: string; payload: any };
let calls: Call[] = [];
const files: Record<string, Uint8Array> = {};
let msgId = 1000;

// telegraf makes a new Telegram client per update, so stub the prototype
(Telegram.prototype as any).callApi = async function (method: string, payload: any) {
  calls.push({ method, payload });
  if (method === 'getFile') return { file_id: payload.file_id, file_path: payload.file_id };
  if (method.startsWith('send')) return { message_id: ++msgId, date: 0, chat: { id: payload.chat_id, type: 'private' } };
  return true;
};

globalThis.fetch = (async (url: any) => {
  const key = String(url).split('/').pop()!;
  const body = files[key];
  return body ? new Response(body as BodyInit) : new Response('nope', { status: 404 });
}) as typeof fetch;

function makeBot() {
  const bot = createBot('123:TEST');
  bot.botInfo = { id: 1, is_bot: true, first_name: 'Test', username: 'TestBot' } as any;
  return bot;
}

let n = 1;
const chat = (id: number) => ({ id, type: 'private' });
const from = (id: number) => ({ id, is_bot: false, first_name: 'A' });
export const msg = (user: number, extra: Record<string, unknown>) => ({
  update_id: n++,
  message: { message_id: n, date: 0, chat: chat(user), from: from(user), ...extra },
});
export const text = (user: number, t: string, extra = {}) =>
  msg(user, { text: t, entities: t.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: t.split(/\s/)[0]!.length }] : [], ...extra });
export const doc = (name: string, mime = 'application/pdf') => ({ file_id: name, file_unique_id: name, file_name: name, mime_type: mime });
export const pdfMsg = (user: number, caption?: string) => msg(user, { document: doc('src.pdf'), ...(caption ? { caption } : {}) });
export const tap = (user: number, data: string) => ({
  update_id: n++,
  callback_query: { id: String(n), from: from(user), chat_instance: '1', data, message: { message_id: 5, date: 0, chat: chat(user), text: 'x' } },
});

const sent = (method = 'sendDocument') => calls.filter((c) => c.method === method);
const lastText = () => [...calls].reverse().find((c) => c.method === 'sendMessage')?.payload.text as string;
const buttons = (c: Call | undefined) => (c?.payload.reply_markup?.inline_keyboard ?? []).flat() as { text: string; callback_data: string }[];

async function filledForm(c: Call) {
  return (await PDFDocument.load(c.payload.document.source)).getForm();
}

before(async () => {
  const form = new Uint8Array(await fs.readFile(path.join(samples, 'target-form.pdf')));
  const t = emptyTemplate('Bot test', await listFormFields(form));
  t.targetFormBase64 = bytesToBase64(form);
  const rules: Record<string, any> = {
    ClientName: { type: 'label', label: 'Client' },
    OrderNumber: { type: 'label', label: 'Order No' },
    JobName: { type: 'jobName' },
  };
  t.mappings = t.mappings.map((m) => (rules[m.fieldName] ? { ...m, rule: rules[m.fieldName] } : m));
  files['tpl.json'] = new TextEncoder().encode(JSON.stringify(t));
  files['src.pdf'] = new Uint8Array(await fs.readFile(path.join(samples, 'source-example.pdf')));
});

beforeEach(() => {
  calls = [];
  clearJobs();
});

test('command parsing', () => {
  assert.equal(commandArgs('/write  My Job ', 'write'), 'My Job');
  assert.equal(commandArgs('/write@TestBot My Job', 'write'), 'My Job');
  assert.equal(commandArgs('/write', 'write'), '');
  assert.equal(commandArgs('/writer x', 'write'), undefined);
  assert.equal(commandArgs(undefined, 'write'), undefined);
});

test('strangers are ignored completely', async () => {
  const bot = makeBot();
  await bot.handleUpdate(text(7, '/start') as any);
  await bot.handleUpdate(pdfMsg(7, '/write X') as any);
  await bot.handleUpdate(tap(7, 'jn:abc:0') as any);
  assert.deepEqual(calls, []);
});

test('template upload and /template', async () => {
  const bot = makeBot();
  await fs.rm(process.env.TEMPLATE_PATH!, { force: true });
  await bot.handleUpdate(text(42, '/template') as any);
  assert.match(lastText(), /No template/);
  calls = [];
  await bot.handleUpdate(msg(42, { document: doc('tpl.json', 'application/json'), caption: '/template' }) as any);
  assert.match(lastText(), /Template saved[\s\S]*ClientName/);
});

test('caption "/write Name" and plain caption "Name" fill right away', async () => {
  const bot = makeBot();
  await bot.handleUpdate(pdfMsg(42, '/write Popescu Kitchen') as any);
  assert.equal(sent()[0]?.payload.document.filename, 'Popescu Kitchen.pdf');
  const form = await filledForm(sent()[0]!);
  assert.equal(form.getTextField('ClientName').getText(), 'Maria Popescu');
  assert.equal(form.getTextField('JobName').getText(), 'Popescu Kitchen');

  calls = [];
  await bot.handleUpdate(pdfMsg(42, 'Just A Name') as any);
  assert.equal(sent()[0]?.payload.document.filename, 'Just A Name.pdf');
});

test('bare PDF: suggestions from the PDF, tap one', async () => {
  const bot = makeBot();
  await bot.handleUpdate(pdfMsg(42) as any);
  assert.equal(sent().length, 0);
  const ask = sent('sendMessage').at(-1);
  assert.match(ask!.payload.text, /What's the Job Name/);
  const b = buttons(ask);
  assert.deepEqual(
    b.map((x) => x.text),
    ['📝 Maria Popescu - WO-2026-0147', '📝 Maria Popescu', '📝 WO-2026-0147'],
  );
  await bot.handleUpdate(tap(42, b[0]!.callback_data) as any);
  assert.equal(sent()[0]?.payload.document.filename, 'Maria Popescu - WO-2026-0147.pdf');
});

test('bare PDF, then type the name', async () => {
  const bot = makeBot();
  await bot.handleUpdate(pdfMsg(42) as any);
  await bot.handleUpdate(text(42, 'Typed Job') as any);
  assert.equal(sent()[0]?.payload.document.filename, 'Typed Job.pdf');
  // the next text is not a job name any more
  calls = [];
  await bot.handleUpdate(text(42, 'hello') as any);
  assert.equal(sent().length, 0);
  assert.match(lastText(), /Send me a source PDF/);
});

test('/write as a reply to a PDF', async () => {
  const bot = makeBot();
  const reply_to_message = { message_id: 1, date: 0, chat: chat(42), document: doc('src.pdf') };
  await bot.handleUpdate(text(42, '/write Reply Job', { reply_to_message }) as any);
  assert.equal(sent()[0]?.payload.document.filename, 'Reply Job.pdf');
  calls = [];
  await bot.handleUpdate(text(42, '/write') as any);
  assert.match(lastText(), /Send me the source PDF first/);
});
