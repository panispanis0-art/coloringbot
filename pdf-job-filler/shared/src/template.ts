import type { FieldMapping, FormFieldInfo, Template } from './types';

export function newId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function emptyTemplate(name: string, fields: FormFieldInfo[]): Template {
  const now = new Date().toISOString();
  return {
    version: 1,
    id: newId(),
    name,
    createdAt: now,
    updatedAt: now,
    mappings: fields
      .filter((f) => f.type !== 'button' && f.type !== 'signature')
      .map<FieldMapping>((f) => ({ fieldName: f.name, fieldType: f.type, rule: { type: 'skip' } })),
    options: { flatten: false },
  };
}

/** Parse and sanity-check a template JSON (from a file, IndexedDB or Telegram). */
export function parseTemplate(json: string | unknown): Template {
  const t = (typeof json === 'string' ? JSON.parse(json) : json) as Template;
  if (!t || typeof t !== 'object') throw new Error('Template is not a JSON object.');
  if (t.version !== 1) throw new Error(`Unsupported template version: ${(t as any).version}`);
  if (!Array.isArray(t.mappings)) throw new Error('Template has no "mappings" list.');
  for (const m of t.mappings) {
    if (!m || typeof m.fieldName !== 'string' || !m.rule || typeof m.rule.type !== 'string') {
      throw new Error('Template has a broken mapping entry.');
    }
  }
  t.options = { ...(t.options ?? {}), flatten: !!t.options?.flatten };
  t.id ||= newId();
  t.name ||= 'Template';
  return t;
}

export function describeRule(m: FieldMapping): string {
  const r = m.rule;
  switch (r.type) {
    case 'skip':
      return 'skip';
    case 'label':
      return `label "${r.label}" (${r.valueOn ?? 'auto'})`;
    case 'regex':
      return `regex /${r.pattern}/${r.flags ?? 'i'}`;
    case 'position':
      return `position p${r.page} [${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}x${Math.round(r.h)}]`;
    case 'static':
      return `fixed "${r.value}"`;
    case 'jobName':
      return 'Job Name';
    case 'date':
      return `today (${r.format || 'DD.MM.YYYY'})`;
  }
}

/* base64 helpers that work in browsers and Node without Buffer */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/^data:[^,]*,/, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
