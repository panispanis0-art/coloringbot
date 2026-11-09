import {
  PDFDocument,
  PDFName,
  PDFRef,
  PDFTextField,
  PDFCheckBox,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFButton,
  PDFSignature,
  StandardFonts,
  type PDFField,
  type PDFFont,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { FieldType, FillOptions, FillResult, FormFieldInfo, PdfMetadata } from './types';

async function loadForm(bytes: Uint8Array): Promise<PDFDocument> {
  try {
    // updateMetadata:false -> pdf-lib does not stamp its own Producer/Creator/dates.
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e: any) {
    if (String(e?.message ?? e).toLowerCase().includes('encrypt')) {
      throw new Error('The target form is encrypted/password protected. Save an unprotected copy first.');
    }
    throw e;
  }
}

function fieldType(f: PDFField): FieldType {
  if (f instanceof PDFTextField) return 'text';
  if (f instanceof PDFCheckBox) return 'checkbox';
  if (f instanceof PDFDropdown) return 'dropdown';
  if (f instanceof PDFOptionList) return 'optionlist';
  if (f instanceof PDFRadioGroup) return 'radio';
  if (f instanceof PDFButton) return 'button';
  if (f instanceof PDFSignature) return 'signature';
  return 'unknown';
}

/** List the AcroForm fields of a fillable PDF. */
export async function listFormFields(bytes: Uint8Array): Promise<FormFieldInfo[]> {
  const doc = await loadForm(bytes);
  const form = doc.getForm();
  const pages = doc.getPages();
  const out: FormFieldInfo[] = [];
  for (const f of form.getFields()) {
    const info: FormFieldInfo = { name: f.getName(), type: fieldType(f), readOnly: f.isReadOnly() };
    try {
      if (f instanceof PDFTextField) {
        info.currentValue = f.getText() ?? '';
        info.multiline = f.isMultiline();
        info.maxLength = f.getMaxLength();
      } else if (f instanceof PDFCheckBox) {
        info.currentValue = f.isChecked() ? 'true' : 'false';
      } else if (f instanceof PDFDropdown || f instanceof PDFOptionList) {
        info.options = f.getOptions();
        info.currentValue = f.getSelected().join(', ');
      } else if (f instanceof PDFRadioGroup) {
        info.options = f.getOptions();
        info.currentValue = f.getSelected() ?? '';
      }
    } catch {
      /* odd fields: keep the basics */
    }
    const widget = f.acroField.getWidgets()[0];
    if (widget) {
      const r = widget.getRectangle();
      info.rect = { x: r.x, y: r.y, w: r.width, h: r.height };
      let pageIndex = -1;
      const p = widget.P();
      if (p instanceof PDFRef) pageIndex = pages.findIndex((pg) => pg.ref === p);
      if (pageIndex < 0) {
        const ref = doc.context.getObjectRef(widget.dict);
        pageIndex = pages.findIndex((pg) => {
          const annots = pg.node.Annots();
          return !!ref && !!annots && annots.asArray().some((a) => a === ref);
        });
      }
      if (pageIndex >= 0) info.page = pageIndex + 1;
    }
    out.push(info);
  }
  return out;
}

const FALSY = new Set(['', '0', 'false', 'no', 'nu', 'off', 'n', 'unchecked', '-']);

export function isTruthy(v: string): boolean {
  return !FALSY.has(v.trim().toLowerCase());
}

/** Replace characters the font cannot draw: strip accents (ș -> s), else "?". */
function makeSafe(font: PDFFont, text: string): string {
  let out = '';
  for (const ch of text) {
    if (ch === '\n' || ch === '\r' || ch === '\t') {
      out += ch;
      continue;
    }
    if (canEncode(font, ch)) {
      out += ch;
      continue;
    }
    const base = ch.normalize('NFD').replace(/\p{M}+/gu, '');
    out += base && [...base].every((c) => canEncode(font, c)) ? base : '?';
  }
  return out;
}

function canEncode(font: PDFFont, ch: string): boolean {
  try {
    font.encodeText(ch);
    return true;
  } catch {
    return false;
  }
}

function matchOption(options: string[], value: string): string | undefined {
  const v = value.trim().toLowerCase();
  return options.find((o) => o === value) ?? options.find((o) => o.trim().toLowerCase() === v);
}

function setInfo(doc: PDFDocument, key: string, value: string | undefined, setter: (v: string) => void) {
  if (value === undefined) return;
  if (value.trim() === '') {
    // empty in settings -> remove the entry instead of writing an empty value
    (doc as any).getInfoDict().delete(PDFName.of(key));
  } else {
    setter(value);
  }
}

export function applyMetadata(doc: PDFDocument, meta: PdfMetadata = {}) {
  setInfo(doc, 'Author', meta.author, (v) => doc.setAuthor(v));
  setInfo(doc, 'Creator', meta.creator, (v) => doc.setCreator(v));
  setInfo(doc, 'Producer', meta.producer, (v) => doc.setProducer(v));
  setInfo(doc, 'Title', meta.title, (v) => doc.setTitle(v));
  setInfo(doc, 'Subject', meta.subject, (v) => doc.setSubject(v));
  setInfo(doc, 'Keywords', meta.keywords, (v) => doc.setKeywords(v.split(/\s*[,;]\s*/)));
}

/** Fill a fillable PDF form with values keyed by field name. */
export async function fillForm(
  formBytes: Uint8Array,
  values: Record<string, string>,
  opts: FillOptions = {},
): Promise<FillResult> {
  const doc = await loadForm(formBytes);
  const form = doc.getForm();
  const filled: string[] = [];
  const warnings: string[] = [];

  // XFA data would override what we write in Acrobat; drop it so the AcroForm values show.
  form.acroForm.dict.delete(PDFName.of('XFA'));

  let font: PDFFont;
  let customFont = false;
  if (opts.fontBytes && opts.fontBytes.length) {
    doc.registerFontkit(fontkit);
    font = await doc.embedFont(opts.fontBytes, { subset: !!opts.flatten });
    customFont = true;
  } else {
    font = await doc.embedFont(StandardFonts.Helvetica);
  }

  for (const [name, rawValue] of Object.entries(values)) {
    const field = form.getFieldMaybe(name);
    if (!field) {
      warnings.push(`Field "${name}" is not in this form.`);
      continue;
    }
    const value = rawValue ?? '';
    try {
      if (field instanceof PDFTextField) {
        let text = customFont ? value : makeSafe(font, value);
        if (text !== value) warnings.push(`"${name}": some characters were replaced (add a Unicode font to keep them: web Settings / FONT_PATH for the bot).`);
        if (!field.isMultiline()) text = text.replace(/\s*\n\s*/g, ' ');
        const max = field.getMaxLength();
        if (max !== undefined && text.length > max) {
          warnings.push(`"${name}": cut to ${max} characters.`);
          text = text.slice(0, max);
        }
        field.setText(text);
      } else if (field instanceof PDFCheckBox) {
        if (isTruthy(value)) field.check();
        else field.uncheck();
      } else if (field instanceof PDFDropdown) {
        const opt = matchOption(field.getOptions(), value);
        if (opt) field.select(opt);
        else if (value === '') field.clear();
        else if (field.isEditable()) field.select(value, false);
        else {
          warnings.push(`"${name}": "${value}" is not one of its options.`);
          continue;
        }
      } else if (field instanceof PDFOptionList) {
        const opt = matchOption(field.getOptions(), value);
        if (opt) field.select(opt);
        else {
          warnings.push(`"${name}": "${value}" is not one of its options.`);
          continue;
        }
      } else if (field instanceof PDFRadioGroup) {
        const opt = matchOption(field.getOptions(), value);
        if (opt) field.select(opt);
        else if (value === '') field.clear();
        else {
          warnings.push(`"${name}": "${value}" is not one of its options.`);
          continue;
        }
      } else {
        warnings.push(`"${name}": this field type cannot be filled.`);
        continue;
      }
      filled.push(name);
    } catch (e: any) {
      warnings.push(`"${name}": ${e?.message ?? e}`);
    }
  }

  form.updateFieldAppearances(font);
  if (opts.flatten) form.flatten({ updateFieldAppearances: false });

  applyMetadata(doc, opts.metadata);
  if (opts.updateDates !== false) {
    const now = new Date();
    doc.setModificationDate(now);
    if (!doc.getCreationDate()) doc.setCreationDate(now);
  }
  if (opts.stripXmp !== false) doc.catalog.delete(PDFName.of('Metadata'));

  const bytes = await doc.save({ updateFieldAppearances: false });
  return { bytes, filled, warnings };
}

/** "Job: 12/A?" -> "Job 12A" - safe on Windows, Android and Telegram. */
export function safeFileName(jobName: string, ext = '.pdf'): string {
  const base = jobName
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  const reserved = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
  const name = !base || reserved.test(base) ? `job-${base || 'output'}` : base;
  return name.slice(0, 150) + ext;
}
