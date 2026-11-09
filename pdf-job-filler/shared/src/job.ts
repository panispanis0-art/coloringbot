import { extractSource, type PdfJsLike } from './extract';
import { applyMappings } from './mapping';
import { fillForm, safeFileName } from './fill';
import { base64ToBytes } from './template';
import type { FillOptions, SourceDoc, Template } from './types';

export interface RunJobInput {
  pdfjs: PdfJsLike;
  /** extra pdf.js getDocument options (standardFontDataUrl, cMapUrl...) */
  pdfjsOptions?: Record<string, unknown>;
  template: Template;
  sourceBytes: Uint8Array;
  jobName: string;
  /** overrides the form stored in the template */
  formBytes?: Uint8Array;
  fill?: FillOptions;
  /** manual corrections, applied on top of the extracted values */
  overrides?: Record<string, string>;
}

export interface RunJobResult {
  fileName: string;
  bytes: Uint8Array;
  values: Record<string, string>;
  warnings: string[];
  source: SourceDoc;
}

/** The whole "Run mode" pipeline, shared by the web app and the Telegram bot. */
export async function runJob(input: RunJobInput): Promise<RunJobResult> {
  const jobName = input.jobName.trim();
  if (!jobName) throw new Error('Job Name is empty.');
  const formBytes =
    input.formBytes ?? (input.template.targetFormBase64 ? base64ToBytes(input.template.targetFormBase64) : undefined);
  if (!formBytes) throw new Error('No target form: the template has no form inside and none was given.');

  const source = await extractSource(input.pdfjs, input.sourceBytes, input.pdfjsOptions);
  if (!source.fullText.trim()) {
    throw new Error('No text found in the source PDF. Is it a scan? Only text-based PDFs work.');
  }
  const values = { ...applyMappings(source, input.template.mappings, { jobName }), ...(input.overrides ?? {}) };
  const fill: FillOptions = { flatten: input.template.options.flatten, ...input.fill };
  const res = await fillForm(formBytes, values, fill);
  return { fileName: safeFileName(jobName), bytes: res.bytes, values, warnings: res.warnings, source };
}
