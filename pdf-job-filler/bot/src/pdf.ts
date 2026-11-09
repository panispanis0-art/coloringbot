import fs from 'node:fs/promises';
import path from 'node:path';
import {
  applyMappings,
  extractSource,
  fillForm,
  formatDate,
  listFormFields,
  type FormFieldInfo,
  parseTemplate,
  base64ToBytes,
  describeRule,
  safeFileName,
  type SourceDoc,
  type Template,
} from '../../shared/src/index.ts';
import { PDFDocument } from 'pdf-lib';
import { pdfjs, nodePdfjsOptions } from '../../shared/src/node.ts';
import { config } from './config.ts';

/** Re-read a file only when it changed on disk (mtime/size). */
const fileCache = new Map<string, { stamp: string; value: unknown }>();
async function cachedFile<T>(file: string, load: (bytes: Buffer) => T | Promise<T>): Promise<T> {
  const st = await fs.stat(file);
  const stamp = `${st.mtimeMs}:${st.size}`;
  const hit = fileCache.get(file);
  if (hit && hit.stamp === stamp) return hit.value as T;
  const value = await load(await fs.readFile(file));
  fileCache.set(file, { stamp, value });
  return value;
}

export interface StoredTemplate {
  template: Template;
  file: string;
}

const NO_TEMPLATE =
  'No template yet.\nExport one from the web app (Templates → Export) and send me the .json file.';

/** All templates: every .json in TEMPLATES_DIR, plus the single TEMPLATE_PATH file of older setups. */
export async function listTemplates(): Promise<StoredTemplate[]> {
  const files: string[] = [];
  try {
    for (const f of await fs.readdir(config.templatesDir)) {
      if (f.toLowerCase().endsWith('.json')) files.push(path.join(config.templatesDir, f));
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  if (!files.includes(config.templatePath)) files.push(config.templatePath);
  const byId = new Map<string, StoredTemplate>();
  for (const file of files) {
    try {
      const template = await cachedFile(file, (b) => parseTemplate(b.toString('utf8')));
      const prev = byId.get(template.id);
      if (!prev || prev.template.updatedAt < template.updatedAt) byId.set(template.id, { template, file });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`Skipping template ${file}: ${(e as Error).message}`);
    }
  }
  return [...byId.values()].sort((x, y) => x.template.name.localeCompare(y.template.name));
}

/** The most recently updated template. */
export async function loadTemplate(): Promise<Template> {
  const list = await listTemplates();
  if (!list.length) throw new Error(NO_TEMPLATE);
  return list.reduce((a, b) => (b.template.updatedAt > a.template.updatedAt ? b : a)).template;
}

/** Add a template to the library (same id = replace it). */
export async function saveTemplate(json: string): Promise<{ template: Template; replaced: boolean }> {
  const template = parseTemplate(json);
  const existing = (await listTemplates()).find((s) => s.template.id === template.id);
  const file =
    existing?.file ?? path.join(config.templatesDir, safeFileName(`${template.name}-${template.id.slice(0, 6)}`, '.json'));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(template, null, 2), 'utf8');
  return { template, replaced: !!existing };
}

export async function deleteTemplate(id: string): Promise<Template | undefined> {
  const hit = (await listTemplates()).find((s) => s.template.id === id);
  if (hit) await fs.rm(hit.file, { force: true });
  return hit?.template;
}

async function readOptional(p?: string): Promise<Uint8Array | undefined> {
  if (!p) return undefined;
  return cachedFile(p, (b) => new Uint8Array(b));
}

/** Decoded form + its field list, per template version. */
const formCache = new Map<string, { bytes: Uint8Array; fields: FormFieldInfo[] }>();

/** Step 1: read the source PDF and work out every field value. Fast, no PDF is written yet. */
export interface Prepared {
  template: Template;
  source: SourceDoc;
  /** values found in the source (without the Job Name) */
  values: Record<string, string>;
  /** the form's fields (types, dropdown options) */
  fields: FormFieldInfo[];
  /** every template scored on this PDF, best first */
  ranking: TemplateScore[];
}

export interface TemplateScore {
  id: string;
  name: string;
  /** rules that read from the PDF and found something */
  found: number;
  /** rules that read from the PDF (label, regex, area) */
  total: number;
}

const READS_PDF = new Set(['label', 'regex', 'position']);

function score(template: Template, values: Record<string, string>): TemplateScore {
  const reading = template.mappings.filter((m) => READS_PDF.has(m.rule.type));
  const found = reading.filter((m) => values[m.fieldName]).length;
  return { id: template.id, name: template.name, found, total: reading.length };
}

const ratio = (s: TemplateScore) => (s.total ? s.found / s.total : 0);

async function loadForm(template: Template): Promise<{ bytes: Uint8Array; fields: FormFieldInfo[] }> {
  const fromFile = await readOptional(config.formPath);
  const key = fromFile ? `file:${config.formPath}:${fromFile.length}` : `tpl:${template.id}:${template.updatedAt}`;
  const hit = formCache.get(key);
  if (hit && (!fromFile || hit.bytes === fromFile)) return hit;
  const bytes = fromFile ?? (template.targetFormBase64 ? base64ToBytes(template.targetFormBase64) : undefined);
  if (!bytes) {
    throw new Error('The template has no form inside. Export it again with "include form", or set FORM_PATH in .env.');
  }
  const entry = { bytes, fields: await listFormFields(bytes) };
  formCache.set(key, entry);
  if (formCache.size > 10) formCache.delete(formCache.keys().next().value!);
  return entry;
}

/** Load pdf.js, the template and the form once at start-up so the first job is as fast as the rest. */
export async function warmUp(): Promise<void> {
  const t0 = Date.now();
  const blank = await PDFDocument.create();
  blank.addPage().drawText('warm up');
  await extractSource(pdfjs, await blank.save(), nodePdfjsOptions);
  for (const { template } of await listTemplates().catch(() => [])) await loadForm(template).catch(() => {});
  console.log(`Warmed up in ${Date.now() - t0} ms`);
}

/** Read the source PDF once, try every template on it and use the best one (or the one asked for). */
export async function prepareJob(sourceBytes: Uint8Array, templateId?: string): Promise<Prepared> {
  const library = await listTemplates();
  if (!library.length) throw new Error(NO_TEMPLATE);
  const source = await extractSource(pdfjs, sourceBytes, nodePdfjsOptions);
  if (!source.fullText.trim()) {
    throw new Error('No text found in this PDF. Is it a scan? Only text-based PDFs work.');
  }
  const scored = library.map(({ template }) => {
    const values = applyMappings(source, template.mappings, {});
    return { template, values, score: score(template, values) };
  });
  scored.sort((a, b) => ratio(b.score) - ratio(a.score) || b.score.found - a.score.found);
  const pick = scored.find((x) => x.template.id === templateId) ?? scored[0]!;
  const { fields } = await loadForm(pick.template);
  return { template: pick.template, source, values: pick.values, fields, ranking: scored.map((x) => x.score) };
}

/** Same source PDF, another template from the library. */
export async function switchTemplate(prepared: Prepared, templateId: string): Promise<Prepared> {
  const hit = (await listTemplates()).find((s) => s.template.id === templateId);
  if (!hit) throw new Error('That template is no longer in the library.');
  const template = hit.template;
  const { fields } = await loadForm(template);
  return { ...prepared, template, values: applyMappings(prepared.source, template.mappings, {}), fields };
}

export interface RenderInput {
  prepared: Prepared;
  jobName: string;
  overrides?: Record<string, string>;
  flatten?: boolean;
}

export interface Rendered {
  fileName: string;
  bytes: Uint8Array;
  values: Record<string, string>;
  warnings: string[];
}

/** Step 2: write the filled form for a Job Name. */
export async function renderJob({ prepared, jobName, overrides = {}, flatten }: RenderInput): Promise<Rendered> {
  const name = jobName.trim();
  if (!name) throw new Error('Job Name is empty.');
  const { template, source } = prepared;
  const { bytes: formBytes } = await loadForm(template);
  const values = { ...applyMappings(source, template.mappings, { jobName: name }), ...overrides };
  const res = await fillForm(formBytes, values, {
    flatten: flatten ?? config.flatten ?? template.options.flatten,
    stripXmp: config.stripXmp,
    fontBytes: await readOptional(config.fontPath),
    metadata: { ...config.metadata, ...(config.titleFromJobName ? { title: name } : {}) },
  });
  return { fileName: safeFileName(name), bytes: res.bytes, values, warnings: res.warnings };
}

/** Old one-shot API: read + fill. */
export async function fillJob(sourceBytes: Uint8Array, jobName: string): Promise<Rendered> {
  return renderJob({ prepared: await prepareJob(sourceBytes), jobName });
}

/** Field names that make good Job Names, best first. */
const NAME_HINTS = [/job|project/i, /client|customer|company|name/i, /order|ref|number|invoice/i, /site|address/i];

export interface NameIdea {
  name: string;
  /** how the name was made, e.g. "{ClientName} - {OrderNumber}" (for autopilot) */
  pattern: string;
}

/** Up to 3 Job Name ideas taken from the PDF itself, best first, with the pattern behind each. */
export function nameIdeas(prepared: Prepared, fileName?: string): NameIdea[] {
  const out: NameIdea[] = [];
  const add = (name: string | undefined, pattern: string) => {
    const v = (name ?? '').replace(/\s+/g, ' ').trim();
    if (v && v.length <= 48 && !out.some((o) => o.name.toLowerCase() === v.toLowerCase())) out.push({ name: v, pattern });
  };
  const ranked = prepared.template.mappings
    .filter((m) => m.fieldType === 'text' && m.rule.type !== 'jobName')
    .map((m) => ({ rank: NAME_HINTS.findIndex((re) => re.test(m.fieldName)), field: m.fieldName, value: prepared.values[m.fieldName] }))
    .filter((x): x is { rank: number; field: string; value: string } => x.rank >= 0 && !!x.value && !x.value.includes('\n'))
    .sort((a, b) => a.rank - b.rank);
  const [a, b] = ranked;
  if (a && b) add(`${a.value} - ${b.value}`, `{${a.field}} - {${b.field}}`);
  for (const x of ranked) add(x.value, `{${x.field}}`);
  add(fileName?.replace(/\.pdf$/i, '').replace(/[_]+/g, ' '), '{file}');
  return out.slice(0, 3);
}

export function suggestJobNames(prepared: Prepared, fileName?: string): string[] {
  return nameIdeas(prepared, fileName).map((i) => i.name);
}

/** "{ClientName} - {OrderNumber}" -> "Maria Popescu - WO-1". Also {file} and {date}. Empty fields are left out neatly. */
export function applyNamePattern(pattern: string, prepared: Prepared, fileName = ''): string {
  const vals: Record<string, string | undefined> = {
    ...prepared.values,
    file: fileName.replace(/\.pdf$/i, '').replace(/[_]+/g, ' '),
    date: formatDate(new Date()),
  };
  const filled = pattern.replace(/\{([^}]+)\}/g, (_, k: string) => (vals[k.trim()] ?? '').replace(/\s+/g, ' ').trim());
  // tidy separators left behind by empty fields: "Maria -  - " -> "Maria"
  return filled
    .replace(/(\s*[-–—_,/|·]\s*){2,}/g, (m) => m.match(/\s*[-–—_,/|·]\s*/)![0])
    .replace(/^\s*[-–—_,/|·]\s*|\s*[-–—_,/|·]\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function templateSummary(t: Template): string {
  const used = t.mappings.filter((m) => m.rule.type !== 'skip');
  const lines = [
    `Active template: ${t.name}`,
    `Form: ${config.formPath ?? t.targetFormName ?? '(inside template)'}${t.targetFormBase64 || config.formPath ? '' : ' (MISSING)'}`,
    `Flatten: ${config.flatten ?? t.options.flatten ? 'yes' : 'no'}`,
    `Updated: ${t.updatedAt?.slice(0, 16).replace('T', ' ') ?? '?'}`,
    `Mapped fields: ${used.length} of ${t.mappings.length}`,
    '',
    ...used.map((m) => `• ${m.fieldName} ← ${describeRule(m)}`),
  ];
  return lines.join('\n');
}
