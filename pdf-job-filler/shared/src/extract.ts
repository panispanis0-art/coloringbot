import type { SourceDoc, SourcePage, TextItem, TextLine, LineSegment } from './types';

/**
 * The bit of pdf.js we need. The web app passes `pdfjs-dist`, the bot passes
 * `pdfjs-dist/legacy/build/pdf.mjs`, so this module never imports pdf.js itself.
 */
export interface PdfJsLike {
  getDocument(src: any): { promise: Promise<any> };
}

/** Extract positioned text from a text-based PDF. */
export async function extractSource(
  pdfjs: PdfJsLike,
  data: Uint8Array,
  /** extra pdf.js getDocument options, e.g. standardFontDataUrl / cMapUrl */
  options: Record<string, unknown> = {},
): Promise<SourceDoc> {
  // pdf.js may transfer (detach) the buffer it gets, so give it a copy.
  const task = pdfjs.getDocument({
    ...options,
    data: data.slice(),
    useSystemFonts: false,
    disableFontFace: true,
  });
  const doc = await task.promise;
  const pages: SourcePage[] = [];
  let lineIndex = 0;
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items: TextItem[] = [];
      for (const it of content.items as any[]) {
        if (typeof it.str !== 'string') continue;
        const t = it.transform as number[];
        const h = it.height || Math.hypot(t[2], t[3]) || 10;
        items.push({ str: it.str, x: t[4], y: t[5], w: it.width || 0, h });
      }
      const lines = groupLines(items, p);
      for (const l of lines) l.index = lineIndex++;
      pages.push({ page: p, width: viewport.width, height: viewport.height, items, lines });
      page.cleanup?.();
    }
  } finally {
    await doc.destroy?.();
  }
  const lines = pages.flatMap((pg) => pg.lines);
  const fullText = pages.map((pg) => pg.lines.map((l) => l.text).join('\n')).join('\n\f\n');
  return { pages, lines, fullText };
}

/** Group text items into lines (same baseline) and lines into cells (big horizontal gaps). */
export function groupLines(items: TextItem[], page: number): TextLine[] {
  const usable = items.filter((i) => i.str.length > 0);
  // top of page first, then left to right
  usable.sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: TextItem[][] = [];
  for (const it of usable) {
    const row = rows[rows.length - 1];
    if (row) {
      const ref = row[0];
      const tol = Math.max(2, Math.min(ref.h, it.h) * 0.5);
      if (Math.abs(ref.y - it.y) <= tol) {
        row.push(it);
        continue;
      }
    }
    rows.push([it]);
  }
  const lines: TextLine[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x);
    const segments: LineSegment[] = [];
    let cur: TextItem[] = [];
    let text = '';
    const flush = () => {
      const t = text.replace(/\s+/g, ' ').trim();
      if (cur.length && t) {
        const x = cur[0].x;
        const last = cur[cur.length - 1];
        segments.push({ text: t, x, w: last.x + last.w - x, items: cur });
      }
      cur = [];
      text = '';
    };
    let space = false;
    for (const it of row) {
      // pdf.js inserts whitespace items that span column gaps: they only mean "there was a space"
      if (!it.str.trim()) {
        space = true;
        continue;
      }
      if (cur.length) {
        const prev = cur[cur.length - 1];
        const gap = it.x - (prev.x + prev.w);
        const h = Math.max(prev.h, it.h);
        // a gap wider than ~1 character height starts a new cell ("Order No:      WO-1")
        if (gap > h * 1.2) flush();
        else if ((space || gap > h * 0.15) && !text.endsWith(' ') && !it.str.startsWith(' ')) text += ' ';
      }
      space = false;
      cur.push(it);
      text += it.str;
    }
    flush();
    if (!segments.length) continue;
    const x = segments[0].x;
    const lastSeg = segments[segments.length - 1];
    lines.push({
      page,
      index: 0,
      text: segments.map((s) => s.text).join('  '),
      x,
      y: row[0].y,
      w: lastSeg.x + lastSeg.w - x,
      h: Math.max(...row.map((i) => i.h)),
      segments,
    });
  }
  return lines;
}
