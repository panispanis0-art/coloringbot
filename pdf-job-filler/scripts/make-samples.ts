// Creates samples/source-example.pdf (a text PDF like a work order) and
// samples/target-form.pdf (a fillable AcroForm) to try the app and the bot.
import fs from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const out = path.resolve(import.meta.dirname, '..', 'samples');

async function source(variant: { order: string; client: string; address: string; date: string; total: string; phone: string }) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let y = 780;
  const t = (s: string, x: number, f = font, size = 11) => page.drawText(s, { x, y, size, font: f });
  t('WORK ORDER', 50, bold, 20);
  y -= 40;
  t('Order No:', 50, bold); t(variant.order, 130);
  t('Date:', 350, bold); t(variant.date, 400);
  y -= 22;
  t('Client:', 50, bold); t(variant.client, 130);
  y -= 22;
  t('Phone:', 50, bold); t(variant.phone, 130);
  y -= 30;
  t('Site address', 50, bold);
  y -= 16;
  t(variant.address, 50);
  y -= 40;
  t('Description', 50, bold);
  y -= 16;
  t('Replace kitchen cabinets and install new countertop.', 50);
  y -= 40;
  t(`Total amount: EUR ${variant.total}`, 50, bold, 13);
  return doc.save();
}

async function form() {
  const doc = await PDFDocument.create();
  doc.setTitle('Job Sheet Form');
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const f = doc.getForm();
  page.drawText('JOB SHEET', { x: 50, y: 780, size: 20, font });
  const rows: [string, string][] = [
    ['JobName', 'Job'],
    ['OrderNumber', 'Order number'],
    ['ClientName', 'Client'],
    ['Phone', 'Phone'],
    ['SiteAddress', 'Address'],
    ['OrderDate', 'Order date'],
    ['Total', 'Total (EUR)'],
    ['FilledOn', 'Filled on'],
  ];
  let y = 730;
  for (const [name, label] of rows) {
    page.drawText(label, { x: 50, y: y + 6, size: 11, font, color: rgb(0.2, 0.2, 0.2) });
    f.createTextField(name).addToPage(page, { x: 170, y, width: 360, height: 22 });
    y -= 36;
  }
  page.drawText('Approved', { x: 50, y: y + 6, size: 11, font });
  f.createCheckBox('Approved').addToPage(page, { x: 170, y, width: 18, height: 18 });
  y -= 36;
  page.drawText('Priority', { x: 50, y: y + 6, size: 11, font });
  const dd = f.createDropdown('Priority');
  dd.addOptions(['Low', 'Normal', 'High']);
  dd.addToPage(page, { x: 170, y, width: 140, height: 22 });
  return doc.save();
}

await fs.mkdir(out, { recursive: true });
await fs.writeFile(
  path.join(out, 'source-example.pdf'),
  await source({ order: 'WO-2026-0147', client: 'Maria Popescu', phone: '+40 721 000 111', address: 'Str. Lalelelor 12, Brasov', date: '03.11.2026', total: '4,850.00' }),
);
await fs.writeFile(
  path.join(out, 'source-example-2.pdf'),
  await source({ order: 'WO-2026-0152', client: 'John Smith', phone: '+44 20 7946 0000', address: '221B Baker Street, London', date: '07.11.2026', total: '12,300.50' }),
);
await fs.writeFile(path.join(out, 'target-form.pdf'), await form());
console.log('Samples written to', out);
