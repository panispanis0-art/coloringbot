// Offline test of the bot: Telegram API calls and file downloads are stubbed.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { Telegram } from 'telegraf';
import { unzipSync } from 'fflate';

const samples = path.resolve(import.meta.dirname, '../../samples');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pjf-bot-'));
process.env.ALLOWED_USER_ID = '42';
process.env.TEMPLATE_PATH = path.join(tmp, 'template.json');
process.env.TEMPLATES_DIR = path.join(tmp, 'templates');
process.env.JOBS_DIR = path.join(tmp, 'jobs');
process.env.BATCH_WAIT_MS = '40';
process.env.BOT_TOKEN = '123:TEST';
process.env.PREVIEW = 'false'; // most tests look at the PDF message; the preview test turns it on

const { createBot, commandArgs } = await import('../src/bot.ts');
const { clearJobs } = await import('../src/jobs.ts');
const { config } = await import('../src/config.ts');
const { listFormFields, emptyTemplate, bytesToBase64 } = await import('../../shared/src/index.ts');

type Call = { method: string; payload: any };
let calls: Call[] = [];
const files: Record<string, Uint8Array> = {};
let msgId = 1000;

// telegraf makes a new Telegram client per update, so stub the prototype
(Telegram.prototype as any).callApi = async function (method: string, payload: any) {
  calls.push({ method, payload });
  if (method === 'getFile') return { file_id: payload.file_id, file_path: payload.file_id };
  if (method === 'sendDocument') {
    return { message_id: ++msgId, date: 0, chat: { id: payload.chat_id, type: 'private' }, document: { file_id: `FILE_${msgId}`, file_unique_id: `U${msgId}` } };
  }
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
const buttons = (c: Call | undefined) =>
  (c?.payload.reply_markup?.inline_keyboard ?? []).flat() as { text: string; callback_data: string; switch_inline_query?: string }[];

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
  files['src2.pdf'] = new Uint8Array(await fs.readFile(path.join(samples, 'source-example-2.pdf')));
});

beforeEach(async () => {
  calls = [];
  clearJobs();
  await fs.rm(process.env.TEMPLATES_DIR!, { recursive: true, force: true });
  await fs.rm(process.env.JOBS_DIR!, { recursive: true, force: true });
  await fs.writeFile(process.env.TEMPLATE_PATH!, files['tpl.json']!);
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
  assert.match(lastText(), /No templates yet/);
  calls = [];
  await bot.handleUpdate(msg(42, { document: doc('tpl.json', 'application/json'), caption: '/template' }) as any);
  assert.match(lastText(), /Template added: Bot test[\s\S]*ClientName/);
  // same template again = update, not a second copy
  calls = [];
  await bot.handleUpdate(msg(42, { document: doc('tpl.json', 'application/json') }) as any);
  assert.match(lastText(), /Template updated[\s\S]*1 template\(s\)/);
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

test('result card: values, missing fields, flatten toggle, rename', async () => {
  const bot = makeBot();
  await bot.handleUpdate(pdfMsg(42, 'Card Job') as any);
  const first = sent()[0]!;
  assert.equal(first.payload.parse_mode, 'HTML');
  assert.match(first.payload.caption, /3\/3 fields filled · 📝 editable/);
  assert.match(first.payload.caption, /ClientName: <b>Maria Popescu<\/b>/);
  const b = buttons(first);
  assert.deepEqual(b.map((x) => x.text), ['✏️ Fix a value', '🔒 Flattened copy', '🔁 Rename', '📤 Send to a chat']);

  calls = [];
  await bot.handleUpdate(tap(42, b[1]!.callback_data) as any);
  const flat = sent()[0]!;
  assert.match(flat.payload.caption, /🔒 flattened/);
  assert.equal((await PDFDocument.load(flat.payload.document.source)).getForm().getFields().length, 0);
  assert.equal(buttons(flat)[1]!.text, '📝 Editable copy');

  calls = [];
  await bot.handleUpdate(tap(42, b[2]!.callback_data) as any);
  assert.match(lastText(), /New Job Name/);
  await bot.handleUpdate(text(42, 'Renamed Job') as any);
  assert.equal(sent()[0]?.payload.document.filename, 'Renamed Job.pdf');
});

test('fix a value: text field by typing, dropdown and checkbox by tapping', async () => {
  const bot = makeBot();
  await bot.handleUpdate(pdfMsg(42, 'Fix Job') as any);
  const fix = buttons(sent()[0]).find((x) => x.text.startsWith('✏️'))!;
  calls = [];
  await bot.handleUpdate(tap(42, fix.callback_data) as any);
  const picker = buttons(sent('sendMessage').at(-1));
  assert.deepEqual(picker.map((x) => x.text), ['OrderNumber: WO-2026-0147', 'ClientName: Maria Popescu']);

  // text field
  await bot.handleUpdate(tap(42, picker[1]!.callback_data) as any);
  assert.match(lastText(), /ClientName — Now: Maria Popescu/);
  calls = [];
  await bot.handleUpdate(text(42, 'Ana Ionescu') as any);
  let form = await filledForm(sent()[0]!);
  assert.equal(form.getTextField('ClientName').getText(), 'Ana Ionescu');
  assert.equal(form.getTextField('OrderNumber').getText(), 'WO-2026-0147');
  assert.match(sent()[0]!.payload.caption, /ClientName: <b>Ana Ionescu<\/b>/);
});

test('fix a value: options for dropdowns and checkboxes', async () => {
  const bot = makeBot();
  // map Priority + Approved so they can be fixed
  const tpl = JSON.parse(new TextDecoder().decode(files['tpl.json']));
  tpl.mappings = tpl.mappings.map((m: any) =>
    m.fieldName === 'Priority' ? { ...m, rule: { type: 'static', value: 'Low' } } :
    m.fieldName === 'Approved' ? { ...m, rule: { type: 'static', value: '' } } : m,
  );
  await fs.writeFile(process.env.TEMPLATE_PATH!, JSON.stringify(tpl));
  await bot.handleUpdate(pdfMsg(42, 'Opt Job') as any);
  const jobId = buttons(sent()[0]).find((x) => x.text.startsWith('✏️'))!.callback_data.split(':')[1];
  const fields = ['OrderNumber', 'ClientName', 'Approved', 'Priority'];
  calls = [];
  await bot.handleUpdate(tap(42, `fe:${jobId}:${fields.indexOf('Priority')}`) as any);
  const opts = buttons(sent('sendMessage').at(-1));
  assert.deepEqual(opts.map((x) => x.text), ['Low', 'Normal', 'High']);
  calls = [];
  await bot.handleUpdate(tap(42, opts[2]!.callback_data) as any);
  let form = await filledForm(sent()[0]!);
  assert.deepEqual(form.getDropdown('Priority').getSelected(), ['High']);

  calls = [];
  await bot.handleUpdate(tap(42, `fe:${jobId}:${fields.indexOf('Approved')}`) as any);
  const tick = buttons(sent('sendMessage').at(-1));
  assert.equal(tick[0]!.text, '☑️ Tick');
  calls = [];
  await bot.handleUpdate(tap(42, tick[0]!.callback_data) as any);
  form = await filledForm(sent()[0]!);
  assert.equal(form.getCheckBox('Approved').isChecked(), true);
});

test('preview picture of page 1 carries the card, then the PDF follows', async () => {
  config.preview = true;
  try {
    const bot = makeBot();
    await bot.handleUpdate(pdfMsg(42, 'Picture Job') as any);
    const photo = sent('sendPhoto')[0]!;
    const png = photo.payload.photo.source as Buffer;
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.match(photo.payload.caption, /Picture Job\.pdf/);
    assert.ok(buttons(photo).some((b) => b.text.startsWith('✏️')));
    const pdf = sent()[0]!;
    assert.equal(pdf.payload.document.filename, 'Picture Job.pdf');
    assert.ok(calls.indexOf(photo) < calls.indexOf(pdf), 'picture first, then the file');
  } finally {
    config.preview = false;
  }
});

test('speed: the top suggestion is filled ahead, so tapping it is instant', async () => {
  const bot = makeBot();
  await bot.handleUpdate(pdfMsg(42) as any);
  const b = buttons(sent('sendMessage').at(-1));
  await new Promise((r) => setTimeout(r, 300)); // user thinks for a moment
  calls = [];
  const t0 = performance.now();
  await bot.handleUpdate(tap(42, b[0]!.callback_data) as any);
  const took = performance.now() - t0;
  assert.match(sent()[0]!.payload.caption, /ready before you tapped/);
  assert.ok(took < 100, `tap answered in ${took.toFixed(0)} ms`);
  // a different name is filled on demand and shows its time
  calls = [];
  await bot.handleUpdate(pdfMsg(42) as any);
  await bot.handleUpdate(text(42, 'Other Name') as any);
  assert.match(sent()[0]!.payload.caption, /⚡ \d+ ms/);
});

test('captions never exceed Telegram\'s 1024 characters', async () => {
  const { resultCaption } = await import('../src/bot.ts');
  const many = Array.from({ length: 80 }, (_, i) => ({ fieldName: `Field_${i}_with_a_long_name`, fieldType: 'text', rule: { type: 'static', value: 'x' } }));
  const job: any = { prepared: { template: { mappings: many, options: { flatten: false } } }, overrides: {} };
  const values = Object.fromEntries(many.map((m) => [m.fieldName, 'a fairly long value that repeats '.repeat(2)]));
  const cap = resultCaption(job, 'Big.pdf', values, ['w1', 'w2'], '<i>⚡ 12 ms</i>');
  assert.ok(cap.length <= 1024, String(cap.length));
  assert.match(cap, /…/);
  assert.equal((cap.match(/<b>/g) ?? []).length, (cap.match(/<\/b>/g) ?? []).length);
});

test('template library: best template picked per PDF, switch with one tap, delete', async () => {
  const bot = makeBot();
  // a second template that reads labels this PDF does not have
  const other = JSON.parse(new TextDecoder().decode(files['tpl.json']));
  other.id = 'invoicetpl1';
  other.name = 'Invoice';
  other.updatedAt = new Date().toISOString();
  other.mappings = other.mappings.map((m: any) =>
    m.fieldName === 'ClientName' ? { ...m, rule: { type: 'label', label: 'Bill to' } } :
    m.fieldName === 'OrderNumber' ? { ...m, rule: { type: 'label', label: 'Invoice No' } } : m,
  );
  files['inv.json'] = new TextEncoder().encode(JSON.stringify(other));
  await bot.handleUpdate(msg(42, { document: doc('inv.json', 'application/json') }) as any);
  assert.match(lastText(), /Template added: Invoice[\s\S]*2 template/);

  // the work order PDF picks "Bot test" even though "Invoice" is newer
  calls = [];
  await bot.handleUpdate(pdfMsg(42) as any);
  const ask = sent('sendMessage').at(-1)!;
  assert.match(ask.payload.text, /Template: Bot test — 2\/2 found \(best match\)/);
  const other_ = buttons(ask).find((b) => b.text.includes('another template'))!;
  calls = [];
  await bot.handleUpdate(tap(42, other_.callback_data) as any);
  const choices = buttons(sent('sendMessage').at(-1));
  assert.deepEqual(choices.map((c) => c.text), ['✅ Bot test — 2/2', 'Invoice — 0/2']);
  calls = [];
  await bot.handleUpdate(tap(42, choices[1]!.callback_data) as any);
  assert.match(lastText(), /Template: Invoice — 0\/2 found/);

  // library + delete
  calls = [];
  await bot.handleUpdate(text(42, '/templates') as any);
  assert.match(lastText(), /2 template\(s\)/);
  const del = buttons(sent('sendMessage').at(-1)).filter((b) => b.text.includes('Delete'));
  calls = [];
  await bot.handleUpdate(tap(42, del.find((d) => d.callback_data === 'td:invoicetpl1')!.callback_data) as any);
  assert.match(lastText(), /1 template\(s\)/);
});

test('fill the gaps: walk through missing fields, skip one, get one complete PDF', async () => {
  const tpl = JSON.parse(new TextDecoder().decode(files['tpl.json']));
  tpl.mappings = tpl.mappings.map((m: any) =>
    m.fieldName === 'OrderDate' ? { ...m, rule: { type: 'label', label: 'Delivery date' } } :
    m.fieldName === 'Total' ? { ...m, rule: { type: 'regex', pattern: 'Grand total:\\s*(\\S+)' } } :
    m.fieldName === 'Priority' ? { ...m, rule: { type: 'label', label: 'Urgency' } } : m,
  );
  await fs.writeFile(process.env.TEMPLATE_PATH!, JSON.stringify(tpl));
  const bot = makeBot();
  await bot.handleUpdate(pdfMsg(42, 'Gap Job') as any);
  const card = sent()[0]!;
  assert.match(card.payload.caption, /OrderDate: ❌/);
  const gap = buttons(card)[0]!;
  assert.equal(gap.text, '🧩 Fill 3 missing');

  calls = [];
  await bot.handleUpdate(tap(42, gap.callback_data) as any);
  assert.match(lastText(), /🧩 1\/3 · OrderDate — not found in the PDF/);
  await bot.handleUpdate(text(42, '05.11.2026') as any);
  assert.match(lastText(), /🧩 2\/3 · Total/);
  assert.equal(sent().length, 0, 'no PDF in the middle of the walk');
  const skip = buttons(sent('sendMessage').at(-1)).find((b) => b.text === '⏭ Skip')!;
  await bot.handleUpdate(tap(42, skip.callback_data) as any);
  assert.match(lastText(), /🧩 3\/3 · Priority/);
  const high = buttons(sent('sendMessage').at(-1)).find((b) => b.text === 'High')!;
  await bot.handleUpdate(tap(42, high.callback_data) as any);

  assert.equal(sent().length, 1);
  const form = await filledForm(sent()[0]!);
  assert.equal(form.getTextField('OrderDate').getText(), '05.11.2026');
  assert.equal(form.getTextField('Total').getText(), undefined);
  assert.deepEqual(form.getDropdown('Priority').getSelected(), ['High']);
  // skipped field is not counted as missing any more
  assert.ok(!buttons(sent()[0]).some((b) => b.text.startsWith('🧩')));
});

test('jobs survive a restart: old buttons still work, /history brings PDFs back', async () => {
  const bot = makeBot();
  await bot.handleUpdate(pdfMsg(42, 'Before Restart') as any);
  const fix = buttons(sent()[0]).find((b) => b.text.startsWith('✏️'))!;
  const jobId = fix.callback_data.split(':')[1]!;
  // correct a value, then "restart": memory is wiped
  await bot.handleUpdate(tap(42, fix.callback_data) as any);
  const client = buttons(sent('sendMessage').at(-1)).find((b) => b.text.startsWith('ClientName'))!;
  await bot.handleUpdate(tap(42, client.callback_data) as any);
  await bot.handleUpdate(text(42, 'Corrected Client') as any);
  clearJobs();

  const restarted = makeBot();
  calls = [];
  await restarted.handleUpdate(tap(42, `rn:${jobId}`) as any);
  assert.match(lastText(), /New Job Name/);
  await restarted.handleUpdate(text(42, 'After Restart') as any);
  const form = await filledForm(sent()[0]!);
  assert.equal(form.getTextField('ClientName').getText(), 'Corrected Client', 'corrections survive');
  assert.equal(sent()[0]!.payload.document.filename, 'After Restart.pdf');

  // newest first; jobs still waiting for a name show ⏳
  await restarted.handleUpdate(pdfMsg(42) as any);
  calls = [];
  await restarted.handleUpdate(text(42, '/history') as any);
  const rows = buttons(sent('sendMessage').at(-1));
  assert.equal(rows.length, 2);
  assert.match(rows[0]!.text, /^⏳ src\.pdf/);
  assert.match(rows[1]!.text, /^📄 After Restart/);
  clearJobs();
  calls = [];
  await restarted.handleUpdate(tap(42, rows[1]!.callback_data) as any);
  assert.equal(sent()[0]!.payload.document.filename, 'After Restart.pdf');
});

test('batch: an album of PDFs comes back as one ZIP with a status per job', async () => {
  const bot = makeBot();
  const album = (name: string) => msg(42, { document: doc(name), media_group_id: 'g1' });
  for (const f of ['src.pdf', 'src2.pdf', 'src.pdf', 'missing.pdf']) await bot.handleUpdate(album(f) as any);
  assert.equal(sent().length, 0, 'waits for the whole album');
  await new Promise((r) => setTimeout(r, 400));
  const zip = sent()[0]!;
  assert.match(zip.payload.document.filename, /^Jobs .* \(3\)\.zip$/);
  const names = Object.keys(unzipSync(new Uint8Array(zip.payload.document.source))).sort();
  assert.deepEqual(names, ['John Smith - WO-2026-0152.pdf', 'Maria Popescu - WO-2026-0147 (2).pdf', 'Maria Popescu - WO-2026-0147.pdf']);
  const inside = unzipSync(new Uint8Array(zip.payload.document.source));
  const form = (await PDFDocument.load(inside['John Smith - WO-2026-0152.pdf']!)).getForm();
  assert.equal(form.getTextField('ClientName').getText(), 'John Smith');
  assert.match(zip.payload.caption, /3 of 4 filled/);
  assert.match(zip.payload.caption, /❌ missing\.pdf/);
  const jobsButtons = buttons(zip);
  assert.equal(jobsButtons.length, 3);
  // a job button opens that job's result card
  calls = [];
  await bot.handleUpdate(tap(42, jobsButtons[1]!.callback_data) as any);
  assert.equal(sent()[0]!.payload.document.filename, 'John Smith - WO-2026-0152.pdf');
});

test('batch of one behaves like a single PDF', async () => {
  const bot = makeBot();
  await bot.handleUpdate(msg(42, { document: doc('src.pdf'), media_group_id: 'g2', caption: 'Solo' }) as any);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(sent()[0]!.payload.document.filename, 'Solo.pdf');
});

test('teach: learnRule finds a rule that works on other PDFs too', async () => {
  const { allSegments, learnRule } = await import('../src/teach.ts');
  const { extractSource, applyRule } = await import('../../shared/src/index.ts');
  const { pdfjs, nodePdfjsOptions } = await import('../../shared/src/node.ts');
  const a = await extractSource(pdfjs, files['src.pdf']!, nodePdfjsOptions);
  const b = await extractSource(pdfjs, files['src2.pdf']!, nodePdfjsOptions);
  const pick = (t: string) => allSegments(a).find((x) => x.seg.text === t)!;
  const cases: [string, RegExp, string][] = [
    ['Maria Popescu', /next to "Client"/, 'John Smith'],
    ['Str. Lalelelor 12, Brasov', /under "Site address"/, '221B Baker Street, London'],
    ['Total amount: EUR 4,850.00', /after "Total amount"/, 'EUR 12,300.50'],
    ['03.11.2026', /next to "Date"/, '07.11.2026'],
  ];
  for (const [text, how, other] of cases) {
    const learned = learnRule(a, pick(text));
    assert.match(learned.how, how, text);
    assert.equal(applyRule(b, learned.rule), other, `${text} on the second PDF`);
  }
  assert.equal(learnRule(a, pick('WORK ORDER')).rule.type, 'position');
});

test('teach: pick the value once, every next PDF gets it', async () => {
  const tpl = JSON.parse(new TextDecoder().decode(files['tpl.json']));
  tpl.mappings = tpl.mappings.map((m: any) => (m.fieldName === 'Phone' ? { ...m, rule: { type: 'label', label: 'Telephone' } } : m));
  await fs.writeFile(process.env.TEMPLATE_PATH!, JSON.stringify(tpl));
  const bot = makeBot();
  await bot.handleUpdate(pdfMsg(42, 'Teach Job') as any);
  await bot.handleUpdate(tap(42, buttons(sent()[0]).find((b) => b.text.startsWith('🧩'))!.callback_data) as any);
  assert.match(lastText(), /Phone — not found/);
  const teachBtn = buttons(sent('sendMessage').at(-1)).find((b) => b.text.startsWith('🎓'))!;
  calls = [];
  await bot.handleUpdate(tap(42, teachBtn.callback_data) as any);
  let list = buttons(sent('sendMessage').at(-1));
  assert.equal(list[0]!.text, 'WORK ORDER');
  // page forward until the phone number shows up
  let phone = list.find((b) => b.text === '+40 721 000 111');
  for (let i = 0; !phone && i < 5; i++) {
    const more = list.find((b) => b.text.startsWith('More'))!;
    calls = [];
    await bot.handleUpdate(tap(42, more.callback_data) as any);
    const edited = calls.find((c) => c.method === 'editMessageText')!;
    list = buttons(edited);
    phone = list.find((b) => b.text === '+40 721 000 111');
  }
  assert.ok(phone);
  calls = [];
  await bot.handleUpdate(tap(42, phone!.callback_data) as any);
  assert.match(sent('sendMessage')[0]!.payload.text, /Learned: Phone = the text next to "Phone"/);
  let form = await filledForm(sent()[0]!);
  assert.equal(form.getTextField('Phone').getText(), '+40 721 000 111');

  // the template file now has the rule: the second PDF gets its own phone number
  calls = [];
  await bot.handleUpdate(msg(42, { document: doc('src2.pdf'), caption: 'Next Job' }) as any);
  form = await filledForm(sent()[0]!);
  assert.equal(form.getTextField('Phone').getText(), '+44 20 7946 0000');
});

test('share: "Send to a chat" button and @bot inline search of filled PDFs', async () => {
  const bot = makeBot();
  await bot.handleUpdate(pdfMsg(42, 'Kitchen Smith') as any);
  await bot.handleUpdate(pdfMsg(42, 'Bathroom Jones') as any);
  const share = buttons(sent()[0]).find((b) => b.text.startsWith('📤'))!;
  assert.equal(share.switch_inline_query, 'Kitchen Smith');

  const inline = (user: number, query: string) => ({ update_id: n++, inline_query: { id: 'q' + n, from: from(user), query, offset: '' } });
  calls = [];
  await bot.handleUpdate(inline(42, 'kitchen') as any);
  const answer = calls.find((c) => c.method === 'answerInlineQuery')!;
  assert.equal(answer.payload.results.length, 1);
  assert.equal(answer.payload.results[0].title, 'Kitchen Smith.pdf');
  assert.match(answer.payload.results[0].document_file_id, /^FILE_/);
  assert.equal(answer.payload.is_personal, true);

  calls = [];
  await bot.handleUpdate(inline(42, '') as any);
  assert.equal(calls.find((c) => c.method === 'answerInlineQuery')!.payload.results.length, 2);

  // survives a restart (file id is saved with the job), strangers get nothing
  clearJobs();
  calls = [];
  await bot.handleUpdate(inline(7, '') as any);
  assert.equal(calls.length, 0);
  await bot.handleUpdate(inline(42, 'bath') as any);
  assert.equal(calls.find((c) => c.method === 'answerInlineQuery')!.payload.results[0].title, 'Bathroom Jones.pdf');
});
