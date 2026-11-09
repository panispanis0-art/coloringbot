import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pdfjs, nodePdfjsOptions as opts } from '../src/node.ts';
import { PDFDocument, PDFName } from 'pdf-lib';
import {
  extractSource,
  listFormFields,
  applyMappings,
  runJob,
  emptyTemplate,
  parseTemplate,
  bytesToBase64,
  safeFileName,
  fillForm,
  type Template,
} from '../src/index.ts';

const samples = path.resolve(import.meta.dirname, '../../samples');
const read = async (f: string) => new Uint8Array(await fs.readFile(path.join(samples, f)));

async function sampleTemplate(): Promise<Template> {
  const form = await read('target-form.pdf');
  const t = emptyTemplate('Work order', await listFormFields(form));
  const rules: Record<string, Template['mappings'][number]['rule']> = {
    JobName: { type: 'jobName' },
    OrderNumber: { type: 'label', label: 'Order No' },
    ClientName: { type: 'label', label: 'Client', transform: 'upper' },
    Phone: { type: 'regex', pattern: 'Phone:\\s*(\\+[\\d ]+)' },
    SiteAddress: { type: 'label', label: 'Site address', valueOn: 'below' },
    OrderDate: { type: 'label', label: 'Date' },
    Total: { type: 'regex', pattern: 'Total amount:\\s*EUR\\s*([\\d.,]+)' },
    FilledOn: { type: 'date', format: 'YYYY-MM-DD' },
    Approved: { type: 'static', value: 'yes' },
    Priority: { type: 'static', value: 'high' },
  };
  t.mappings = t.mappings.map((m) => ({ ...m, rule: rules[m.fieldName] ?? m.rule }));
  t.targetFormBase64 = bytesToBase64(form);
  return t;
}

test('extracts lines and cells', async () => {
  const doc = await extractSource(pdfjs, await read('source-example.pdf'), opts);
  const orderLine = doc.lines.find((l) => l.text.startsWith('Order No:'));
  assert.ok(orderLine, doc.fullText);
  assert.deepEqual(orderLine.segments.map((s) => s.text), ['Order No:', 'WO-2026-0147', 'Date:', '03.11.2026']);
  assert.match(doc.fullText, /Maria Popescu/);
});

test('lists form fields', async () => {
  const fields = await listFormFields(await read('target-form.pdf'));
  const names = fields.map((f) => f.name);
  assert.ok(names.includes('ClientName'));
  assert.equal(fields.find((f) => f.name === 'Approved')?.type, 'checkbox');
  assert.deepEqual(fields.find((f) => f.name === 'Priority')?.options, ['Low', 'Normal', 'High']);
  assert.equal(fields.find((f) => f.name === 'JobName')?.page, 1);
});

test('mapping rules find the right values', async () => {
  const t = await sampleTemplate();
  for (const [file, expect] of [
    ['source-example.pdf', { OrderNumber: 'WO-2026-0147', ClientName: 'MARIA POPESCU', OrderDate: '03.11.2026', SiteAddress: 'Str. Lalelelor 12, Brasov', Total: '4,850.00', Phone: '+40 721 000 111' }],
    ['source-example-2.pdf', { OrderNumber: 'WO-2026-0152', ClientName: 'JOHN SMITH', OrderDate: '07.11.2026', SiteAddress: '221B Baker Street, London', Total: '12,300.50', Phone: '+44 20 7946 0000' }],
  ] as const) {
    const doc = await extractSource(pdfjs, await read(file), opts);
    const v = applyMappings(doc, t.mappings, { jobName: 'J1', now: new Date(2026, 10, 9) });
    for (const [k, want] of Object.entries(expect)) assert.equal(v[k], want, `${file} ${k}`);
    assert.equal(v.JobName, 'J1');
    assert.equal(v.FilledOn, '2026-11-09');
  }
});

test('position rule reads the text inside a box', async () => {
  const doc = await extractSource(pdfjs, await read('source-example.pdf'), opts);
  const line = doc.lines.find((l) => l.text.startsWith('Client:'))!;
  const seg = line.segments[1];
  const v = applyMappings(doc, [
    { fieldName: 'x', fieldType: 'text', rule: { type: 'position', page: 1, x: seg.x - 2, y: line.y - 4, w: seg.w + 4, h: line.h + 6 } },
  ]);
  assert.equal(v.x, 'Maria Popescu');
});

test('runJob fills, sets metadata, no pdf-lib stamp', async () => {
  const t = parseTemplate(JSON.stringify(await sampleTemplate()));
  const res = await runJob({
    pdfjs,
    pdfjsOptions: opts,
    template: t,
    sourceBytes: await read('source-example.pdf'),
    jobName: 'Popescu: Kitchen/2026',
    fill: { metadata: { author: 'Alex', creator: 'My Creator', producer: '' } },
  });
  assert.equal(res.fileName, 'Popescu Kitchen2026.pdf');
  assert.deepEqual(res.warnings, []);
  const out = await PDFDocument.load(res.bytes, { updateMetadata: false });
  const form = out.getForm();
  assert.equal(form.getTextField('ClientName').getText(), 'MARIA POPESCU');
  assert.equal(form.getTextField('JobName').getText(), 'Popescu: Kitchen/2026');
  assert.equal(form.getCheckBox('Approved').isChecked(), true);
  assert.deepEqual(form.getDropdown('Priority').getSelected(), ['High']);
  assert.equal(out.getAuthor(), 'Alex');
  assert.equal(out.getCreator(), 'My Creator');
  assert.equal(out.getProducer(), undefined);
  assert.equal(out.getTitle(), 'Job Sheet Form');
  assert.equal(out.catalog.get(PDFName.of('Metadata')), undefined);
  assert.ok(!Buffer.from(res.bytes).toString('latin1').includes('pdf-lib'));
});

test('flatten removes the fields', async () => {
  const form = await read('target-form.pdf');
  const res = await fillForm(form, { ClientName: 'Ana' }, { flatten: true });
  const out = await PDFDocument.load(res.bytes);
  assert.equal(out.getForm().getFields().length, 0);
});

test('characters the standard font lacks are replaced, not crashing', async () => {
  const form = await read('target-form.pdf');
  const res = await fillForm(form, { SiteAddress: 'Brașov, Țara Bârsei', Nope: 'x' });
  const out = await PDFDocument.load(res.bytes);
  assert.equal(out.getForm().getTextField('SiteAddress').getText(), 'Brasov, Tara Bârsei');
  assert.equal(res.warnings.length, 2);
});

test('safe file names', () => {
  assert.equal(safeFileName('  a<b>c:d  '), 'abcd.pdf');
  assert.equal(safeFileName('CON'), 'job-CON.pdf');
  assert.equal(safeFileName('Job. '), 'Job.pdf');
});

const SYSTEM_FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
test('a Unicode font keeps ș/ț, also when flattened', { skip: !(await fs.stat(SYSTEM_FONT).catch(() => null)) }, async () => {
  const form = await read('target-form.pdf');
  const fontBytes = new Uint8Array(await fs.readFile(SYSTEM_FONT));
  for (const flatten of [false, true]) {
    const res = await fillForm(form, { SiteAddress: 'Brașov, Țara Bârsei' }, { fontBytes, flatten });
    assert.deepEqual(res.warnings, []);
    const out = await PDFDocument.load(res.bytes);
    if (!flatten) assert.equal(out.getForm().getTextField('SiteAddress').getText(), 'Brașov, Țara Bârsei');
    const doc = await extractSource(pdfjs, res.bytes, opts);
    if (flatten) assert.match(doc.fullText, /Brașov, Țara Bârsei/);
  }
});

test('flat PDF: spots become boxes that keep the old text until a new value is given', async () => {
  const { addFieldsToPdf, textWidth } = await import('../src/index.ts');
  const plain = await PDFDocument.create();
  const page = plain.addPage([400, 200]);
  const font = await plain.embedFont((await import('pdf-lib')).StandardFonts.Helvetica);
  page.drawText('Sector:Gamma', { x: 50, y: 100, size: 12, font });
  page.drawText('Position:1', { x: 50, y: 80, size: 12, font });
  const bytes = await plain.save();
  assert.equal((await listFormFields(bytes)).length, 0);

  const off = await textWidth('Sector:', 12);
  const fillable = await addFieldsToPdf(bytes, [
    { name: 'Sector', page: 1, x: 50 + off - 1, y: 96.6, w: 60, h: 15.3, fontSize: 12, text: 'Gamma' },
    { name: 'Position', page: 1, x: 50 + (await textWidth('Position:', 12)) - 1, y: 76.6, w: 30, h: 15.3, fontSize: 12, text: '1' },
  ]);
  const fields = await listFormFields(fillable);
  assert.deepEqual(fields.map((f) => [f.name, f.currentValue]), [['Sector', 'Gamma'], ['Position', '1']]);

  // template with "typed in each time" rules needs no source PDF; only changed values are written
  const t = parseTemplate(JSON.stringify({ ...emptyTemplate('Flat', fields), targetFormBase64: bytesToBase64(fillable) }));
  t.mappings = t.mappings.map((m) => ({ ...m, rule: { type: 'ask' as const } }));
  const res = await runJob({ pdfjs, template: t, jobName: 'Alpha 2', overrides: { Sector: 'Alpha' }, fill: { flatten: true } });
  const text = (await extractSource(pdfjs, res.bytes, opts)).fullText;
  assert.match(text, /Alpha/);
  assert.match(text, /1/);
  await assert.rejects(
    runJob({ pdfjs, template: { ...t, mappings: [{ fieldName: 'Sector', fieldType: 'text', rule: { type: 'label', label: 'X' } }] }, jobName: 'x' }),
    /reads values from a source PDF/,
  );
});
