// Offline test of the bot: Telegram API calls and file downloads are stubbed.
import { test, before } from 'node:test';
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
const { listFormFields, emptyTemplate, bytesToBase64 } = await import('../../shared/src/index.ts');

type Call = { method: string; payload: any };
let calls: Call[] = [];
let files: Record<string, Uint8Array> = {};

function makeBot() {
  const bot = createBot('123:TEST');
  bot.botInfo = { id: 1, is_bot: true, first_name: 'Test', username: 'TestBot' } as any;
  return bot;
}

// telegraf makes a new Telegram client per update, so stub the prototype
(Telegram.prototype as any).callApi = async function (method: string, payload: any) {
  calls.push({ method, payload });
  if (method === 'getFile') return { file_id: payload.file_id, file_path: payload.file_id };
  return true;
};

globalThis.fetch = (async (url: any) => {
  const key = String(url).split('/').pop()!;
  const body = files[key];
  return body ? new Response(body as BodyInit) : new Response('nope', { status: 404 });
}) as typeof fetch;

let n = 1;
const msg = (from: number, extra: Record<string, unknown>) => ({
  update_id: n++,
  message: { message_id: n, date: 0, chat: { id: from, type: 'private' }, from: { id: from, is_bot: false, first_name: 'A' }, ...extra },
});
const text = (from: number, t: string, extra = {}) =>
  msg(from, { text: t, entities: t.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: t.split(/\s/)[0].length }] : [], ...extra });
const doc = (name: string, mime: string) => ({ file_id: name, file_unique_id: name, file_name: name, mime_type: mime });

before(async () => {
  const form = new Uint8Array(await fs.readFile(path.join(samples, 'target-form.pdf')));
  const t = emptyTemplate('Bot test', await listFormFields(form));
  t.targetFormBase64 = bytesToBase64(form);
  t.mappings = t.mappings.map((m) =>
    m.fieldName === 'ClientName' ? { ...m, rule: { type: 'label', label: 'Client' } } :
    m.fieldName === 'JobName' ? { ...m, rule: { type: 'jobName' } } : m,
  );
  files['tpl.json'] = new TextEncoder().encode(JSON.stringify(t));
  files['src.pdf'] = new Uint8Array(await fs.readFile(path.join(samples, 'source-example.pdf')));
});

test('command parsing', () => {
  assert.equal(commandArgs('/write  My Job ', 'write'), 'My Job');
  assert.equal(commandArgs('/write@TestBot My Job', 'write'), 'My Job');
  assert.equal(commandArgs('/write', 'write'), '');
  assert.equal(commandArgs('/writer x', 'write'), undefined);
  assert.equal(commandArgs(undefined, 'write'), undefined);
});

test('strangers are ignored completely', async () => {
  calls = [];
  const bot = makeBot();
  await bot.handleUpdate(text(7, '/start') as any);
  await bot.handleUpdate(msg(7, { document: doc('src.pdf', 'application/pdf'), caption: '/write X' }) as any);
  assert.deepEqual(calls, []);
});

test('template upload, /template, /write by caption and by reply', async () => {
  const bot = makeBot();

  calls = [];
  await bot.handleUpdate(text(42, '/template') as any);
  assert.match(calls[0].payload.text, /No template/);

  calls = [];
  await bot.handleUpdate(msg(42, { document: doc('tpl.json', 'application/json'), caption: '/template' }) as any);
  assert.match(calls.at(-1)!.payload.text, /Template saved[\s\S]*ClientName/);

  calls = [];
  await bot.handleUpdate(msg(42, { document: doc('src.pdf', 'application/pdf'), caption: '/write Popescu Kitchen' }) as any);
  const sent = calls.find((c) => c.method === 'sendDocument');
  assert.ok(sent, JSON.stringify(calls.map((c) => [c.method, c.payload.text])));
  assert.equal(sent.payload.document.filename, 'Popescu Kitchen.pdf');
  const out = await PDFDocument.load(sent.payload.document.source);
  assert.equal(out.getForm().getTextField('ClientName').getText(), 'Maria Popescu');
  assert.equal(out.getForm().getTextField('JobName').getText(), 'Popescu Kitchen');
  assert.equal(out.getAuthor(), 'Alex');

  calls = [];
  await bot.handleUpdate(
    text(42, '/write Reply Job', { reply_to_message: { message_id: 1, date: 0, chat: { id: 42, type: 'private' }, document: doc('src.pdf', 'application/pdf') } }) as any,
  );
  assert.equal(calls.find((c) => c.method === 'sendDocument')?.payload.document.filename, 'Reply Job.pdf');

  calls = [];
  await bot.handleUpdate(text(42, '/write') as any);
  assert.match(calls[0].payload.text, /Add a Job Name/);
});
