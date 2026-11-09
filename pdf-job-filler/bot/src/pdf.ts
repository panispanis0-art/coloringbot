import fs from 'node:fs/promises';
import path from 'node:path';
import {
  runJob,
  parseTemplate,
  base64ToBytes,
  describeRule,
  type Template,
  type RunJobResult,
} from '../../shared/src/index.ts';
import { pdfjs, nodePdfjsOptions } from '../../shared/src/node.ts';
import { config } from './config.ts';

export async function loadTemplate(): Promise<Template> {
  let raw: string;
  try {
    raw = await fs.readFile(config.templatePath, 'utf8');
  } catch {
    throw new Error(
      `No template at ${config.templatePath}.\nExport one from the web app (Templates > Export) and send the .json file to me with the caption /template, or copy it there.`,
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

export async function fillJob(sourceBytes: Uint8Array, jobName: string): Promise<RunJobResult> {
  const template = await loadTemplate();
  const formBytes = await readOptional(config.formPath);
  if (!formBytes && !template.targetFormBase64) {
    throw new Error('The template has no form inside. Export it again with "include form", or set FORM_PATH in .env.');
  }
  const fontBytes = await readOptional(config.fontPath);
  return runJob({
    pdfjs,
    pdfjsOptions: nodePdfjsOptions,
    template,
    sourceBytes,
    jobName,
    formBytes,
    fill: {
      ...(config.flatten !== undefined ? { flatten: config.flatten } : {}),
      stripXmp: config.stripXmp,
      fontBytes,
      metadata: {
        ...config.metadata,
        ...(config.titleFromJobName ? { title: jobName.trim() } : {}),
      },
    },
  });
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

export { base64ToBytes };
