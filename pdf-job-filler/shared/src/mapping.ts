import type { FieldMapping, MappingRule, SourceDoc, TextLine, Transform } from './types';

export interface ApplyContext {
  jobName?: string;
  now?: Date;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Label text matching that tolerates different spacing ("Invoice  No" vs "Invoice No"). */
function labelRegex(label: string, caseSensitive?: boolean): RegExp {
  const parts = label.trim().split(/\s+/).map(escapeRegex);
  return new RegExp(parts.join('\\s*'), caseSensitive ? '' : 'i');
}

const SEPARATORS = /^[\s:：\-–—#=.|]+/;

function cut(value: string, stopAt?: string): string {
  if (!stopAt) return value;
  try {
    const m = new RegExp(stopAt).exec(value);
    return m ? value.slice(0, m.index) : value;
  } catch {
    return value;
  }
}

function linesBelow(doc: SourceDoc, line: TextLine, x: number, w: number, count: number): string[] {
  const out: string[] = [];
  const pageLines = doc.lines.filter((l) => l.page === line.page && l.y < line.y);
  pageLines.sort((a, b) => b.y - a.y);
  for (const l of pageLines) {
    // segments that overlap the label horizontally
    const segs = l.segments.filter((s) => s.x < x + Math.max(w, 40) && s.x + s.w > x - 5);
    if (!segs.length) continue;
    out.push(segs.map((s) => s.text).join(' '));
    if (out.length >= count) break;
  }
  return out;
}

function applyLabel(doc: SourceDoc, rule: Extract<MappingRule, { type: 'label' }>): string | undefined {
  if (!rule.label?.trim()) return undefined;
  const re = labelRegex(rule.label, rule.caseSensitive);
  const want = Math.max(1, rule.occurrence ?? 1);
  const mode = rule.valueOn ?? 'auto';
  const count = Math.max(1, rule.lines ?? 1);
  let seen = 0;
  for (const line of doc.lines) {
    for (let si = 0; si < line.segments.length; si++) {
      const seg = line.segments[si];
      const m = re.exec(seg.text);
      if (!m) continue;
      seen++;
      if (seen < want) continue;

      const restOfCell = seg.text.slice(m.index + m[0].length).replace(SEPARATORS, '').trim();
      const restOfLine = [restOfCell, ...line.segments.slice(si + 1).map((s) => s.text)]
        .filter(Boolean)
        .join('  ')
        .trim();
      const nextLines = () =>
        doc.lines
          .slice(line.index + 1, line.index + 1 + count)
          .map((l) => l.text)
          .join('\n');
      const below = () => linesBelow(doc, line, seg.x, seg.w, count).join('\n');

      let value = '';
      if (mode === 'sameLine') value = restOfLine;
      else if (mode === 'nextLine') value = nextLines();
      else if (mode === 'below') value = below();
      else {
        value = restOfCell || line.segments[si + 1]?.text || '';
        if (!value) value = below() || nextLines();
      }
      return cut(value, rule.stopAt).trim();
    }
  }
  return undefined;
}

function applyRegex(doc: SourceDoc, rule: Extract<MappingRule, { type: 'regex' }>): string | undefined {
  if (!rule.pattern) return undefined;
  let re: RegExp;
  try {
    const flags = (rule.flags ?? 'i').replace(/[gy]/g, '') + 'g';
    re = new RegExp(rule.pattern, flags);
  } catch {
    return undefined;
  }
  const want = Math.max(1, rule.occurrence ?? 1);
  let n = 0;
  for (const m of doc.fullText.matchAll(re)) {
    n++;
    if (n < want) continue;
    const group = rule.group ?? (m.length > 1 ? 1 : 0);
    return (m[group] ?? '').trim();
  }
  return undefined;
}

function applyPosition(doc: SourceDoc, rule: Extract<MappingRule, { type: 'position' }>): string | undefined {
  const page = doc.pages.find((p) => p.page === rule.page);
  if (!page) return undefined;
  const inside = (cx: number, cy: number) =>
    cx >= rule.x && cx <= rule.x + rule.w && cy >= rule.y && cy <= rule.y + rule.h;
  const out: string[] = [];
  for (const line of page.lines) {
    const parts: string[] = [];
    for (const seg of line.segments) {
      const words = seg.items.filter((it) => inside(it.x + it.w / 2, it.y + it.h / 3));
      if (words.length) parts.push(words.map((w) => w.str).join('').replace(/\s+/g, ' ').trim());
    }
    const t = parts.filter(Boolean).join(' ');
    if (t) out.push(t);
  }
  return out.length ? out.join('\n') : undefined;
}

export function formatDate(d: Date, format = 'DD.MM.YYYY'): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return format
    .replace(/YYYY/g, String(d.getFullYear()))
    .replace(/YY/g, String(d.getFullYear()).slice(-2))
    .replace(/MM/g, pad(d.getMonth() + 1))
    .replace(/DD/g, pad(d.getDate()));
}

function transform(value: string, t?: Transform): string {
  switch (t) {
    case 'upper':
      return value.toUpperCase();
    case 'lower':
      return value.toLowerCase();
    case 'title':
      return value.toLowerCase().replace(/(^|[\s\-'])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());
    default:
      return value;
  }
}

/** Resolve one rule against a source document. Returns undefined when the field should be left alone. */
export function applyRule(doc: SourceDoc | undefined, rule: MappingRule, ctx: ApplyContext = {}): string | undefined {
  if (rule.type === 'skip') return undefined;
  let raw: string | undefined;
  switch (rule.type) {
    case 'label':
      raw = doc ? applyLabel(doc, rule) : undefined;
      break;
    case 'regex':
      raw = doc ? applyRegex(doc, rule) : undefined;
      break;
    case 'position':
      raw = doc ? applyPosition(doc, rule) : undefined;
      break;
    case 'static':
      raw = rule.value;
      break;
    case 'jobName':
      raw = ctx.jobName;
      break;
    case 'date':
      raw = formatDate(ctx.now ?? new Date(), rule.format || 'DD.MM.YYYY');
      break;
  }
  if (raw === undefined || raw === '') {
    if (rule.defaultValue === undefined || rule.defaultValue === '') return raw === '' ? '' : undefined;
    raw = rule.defaultValue;
  }
  return (rule.prefix ?? '') + transform(raw, rule.transform) + (rule.suffix ?? '');
}

/** Resolve all mappings. Fields whose rule finds nothing are left out. */
export function applyMappings(
  doc: SourceDoc | undefined,
  mappings: FieldMapping[],
  ctx: ApplyContext = {},
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const m of mappings) {
    const v = applyRule(doc, m.rule, ctx);
    if (v !== undefined) values[m.fieldName] = v;
  }
  return values;
}
