import fs from 'node:fs/promises';
import path from 'node:path';
import {
  applyMappings,
  extractSource,
  fillForm,
  listFormFields,
  type FormFieldInfo,
  parseTemplate,
  base64ToBytes,
  describeRule,
  safeFileName,
  type SourceDoc,
  type Template,
} from '../../shared/src/index.ts';
import { pdfjs, nodePdfjsOptions } from '../../shared/src/node.ts';
import { config } from './config.ts';

export async function loadTemplate(): Promise<Template> {
  let raw: string;
  try {
    raw = await fs.readFile(config.templatePath, 'utf8');
  } catch {
    throw new Error(
      `No template yet.\nExport one from the web app (Templates → Export) and send the .json file to me with the caption /template.`,
    );
  }
  return parseTemplate(raw);
}

export async function saveTemplate(json: string): Promise<Template> {
  const t = parseTemplate(json);
  await fs.mkdir(path.dirname(config.templatePath), { recursive: true });
  await fs.writeFile(config.templatePath, JSON.stringify(t, null, 2), 'utf8');
  return t;
}

async function readOptional(p?: string): Promise<Uint8Array | undefined> {
  if (!p) return undefined;
  return new Uint8Array(await fs.readFile(p));
}

/** Step 1: read the source PDF and work out every field value. Fast, no PDF is written yet. */
export interface Prepared {
  template: Template;
  source: SourceDoc;
  /** values found in the source (without the Job Name) */
  values: Record<string, string>;
  /** the form's fields (types, dropdown options) */
  fields: FormFieldInfo[];
}

async function loadFormBytes(template: Template): Promise<Uint8Array> {
  const formBytes =
    (await readOptional(config.formPath)) ??
    (template.targetFormBase64 ? base64ToBytes(template.targetFormBase64) : undefined);
  if (!formBytes) {
    throw new Error('The template has no form inside. Export it again with "include form", or set FORM_PATH in .env.');
  }
  return formBytes;
}

export async function prepareJob(sourceBytes: Uint8Array): Promise<Prepared> {
  const template = await loadTemplate();
  const source = await extractSource(pdfjs, sourceBytes, nodePdfjsOptions);
  if (!source.fullText.trim()) {
    throw new Error('No text found in this PDF. Is it a scan? Only text-based PDFs work.');
  }
  const fields = await listFormFields(await loadFormBytes(template));
  return { template, source, values: applyMappings(source, template.mappings, {}), fields };
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
  const formBytes = await loadFormBytes(template);
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

/** Up to 3 Job Name ideas taken from the PDF itself, best first. */
export function suggestJobNames(prepared: Prepared, fileName?: string): string[] {
  const out: string[] = [];
  const add = (s: string | undefined) => {
    const v = (s ?? '').replace(/\s+/g, ' ').trim();
    if (v && v.length <= 48 && !out.some((o) => o.toLowerCase() === v.toLowerCase())) out.push(v);
  };
  const ranked = prepared.template.mappings
    .filter((m) => m.fieldType === 'text' && m.rule.type !== 'jobName')
    .map((m) => ({ rank: NAME_HINTS.findIndex((re) => re.test(m.fieldName)), value: prepared.values[m.fieldName] }))
    .filter((x): x is { rank: number; value: string } => x.rank >= 0 && !!x.value && !x.value.includes('\n'))
    .sort((a, b) => a.rank - b.rank)
    .map((x) => x.value);
  if (ranked.length >= 2) add(`${ranked[0]} - ${ranked[1]}`);
  for (const v of ranked) add(v);
  add(fileName?.replace(/\.pdf$/i, '').replace(/[_]+/g, ' '));
  return out.slice(0, 3);
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
