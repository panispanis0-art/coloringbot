import { textWidth, type LineSegment, type Spot, type TextLine } from "@shared";
import { pdfjs, pdfjsOptions } from "@/lib/pdfjs";

/** A rendered page we can read pixels from (to match colours and find free space). */
export interface Raster {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  scale: number;
  pageHeight: number;
}

export async function rasterize(bytes: Uint8Array, pageNumber: number, scale = 2): Promise<Raster> {
  const doc = await pdfjs.getDocument({ ...pdfjsOptions, data: bytes.slice() }).promise;
  try {
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, canvas, viewport }).promise;
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { data: img.data, width: img.width, height: img.height, scale, pageHeight: viewport.height / scale };
  } finally {
    await doc.destroy();
  }
}

type RGB = [number, number, number];

function pixel(r: Raster, xPt: number, yPt: number): RGB {
  const px = Math.min(r.width - 1, Math.max(0, Math.round(xPt * r.scale)));
  const py = Math.min(r.height - 1, Math.max(0, Math.round((r.pageHeight - yPt) * r.scale)));
  const i = (py * r.width + px) * 4;
  return [r.data[i]!, r.data[i + 1]!, r.data[i + 2]!];
}

const near = (a: RGB, b: RGB, tol = 40) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) <= tol;

/** The most common colour inside a box: the background behind the text. Returned as 0..1. */
export function backgroundOf(r: Raster, x: number, y: number, w: number, h: number): [number, number, number] {
  const counts = new Map<string, { c: RGB; n: number }>();
  for (let i = 0; i <= 12; i++) {
    for (let j = 0; j <= 4; j++) {
      const c = pixel(r, x + (w * i) / 12, y + (h * j) / 4);
      const key = c.map((v) => v >> 3).join(",");
      const hit = counts.get(key);
      if (hit) hit.n++;
      else counts.set(key, { c, n: 1 });
    }
  }
  const best = [...counts.values()].sort((a, b) => b.n - a.n)[0]!.c;
  return [best[0] / 255, best[1] / 255, best[2] / 255];
}

/** How far the background continues to the right of x (stops at text, lines or a colour change). */
function freeRight(r: Raster, x: number, y: number, h: number, bg: [number, number, number], max: number): number {
  const want: RGB = [bg[0] * 255, bg[1] * 255, bg[2] * 255];
  const rows = [y + h * 0.15, y + h * 0.5, y + h * 0.85];
  for (let d = 0; d <= max; d += 0.5) {
    if (rows.some((yy) => !near(pixel(r, x + d, yy), want))) return Math.max(0, d - 1.5);
  }
  return max;
}

/** Share of points along a horizontal edge that match the background. */
function edgeMatch(r: Raster, x: number, w: number, y: number, bg: RGB): number {
  let ok = 0;
  const n = 24;
  for (let i = 0; i <= n; i++) if (near(pixel(r, x + (w * i) / n, y), bg)) ok++;
  return ok / (n + 1);
}

/**
 * Shrink a box evenly from top and bottom until both edges sit on the background colour (so a grey
 * box never sticks out of a grey band). Shrinking evenly keeps pdf-lib's centred baseline in place.
 */
function fitVertically(r: Raster, x: number, w: number, y: number, h: number, bg01: [number, number, number], minH: number) {
  const bg: RGB = [bg01[0] * 255, bg01[1] * 255, bg01[2] * 255];
  let t = 0;
  while (h - 2 * t > minH && (edgeMatch(r, x, w, y + h - t, bg) < 0.7 || edgeMatch(r, x, w, y + t, bg) < 0.7)) t += 0.25;
  return { y: y + t, h: h - 2 * t };
}

const hasLetters = (s: string) => /\p{L}/u.test(s);

/**
 * A fill-in box for a tapped piece of text. "Site:5GB0518A" keeps "Site:" and covers only the value.
 * The box gets the exact background colour and some free room to the right for longer values.
 */
export async function spotFromText(r: Raster, line: TextLine, seg: LineSegment, segIndex: number, n: number): Promise<Spot> {
  // use the piece's own baseline and size (a "line" can merge pieces a few points apart)
  const items = seg.items.length ? seg.items : [{ y: line.y, h: line.h }];
  const baseline = items[0]!.y;
  const size = Math.round(Math.max(...items.map((i) => i.h)) * 10) / 10;
  const text = seg.text;
  const colon = text.search(/[:：]/);
  const label = colon > 0 && text.slice(colon + 1).trim() ? text.slice(0, colon + 1) : "";
  const full = await textWidth(text, size);
  const ratio = full > 0 ? seg.w / full : 1;
  const offset = label ? (await textWidth(label, size)) * ratio : 0;
  const valueX = seg.x + offset;
  const valueW = Math.max(4, seg.w - offset);
  // pdf-lib draws text 1pt inside the box, vertically centred on the cap height (0.718 em for Helvetica):
  // this box puts the new baseline exactly on the old one and covers ascenders and descenders.
  const below = size * 0.28;
  const h = 2 * (below + size * 0.359);
  const x = valueX - 1;
  const y = baseline - below;
  const background = backgroundOf(r, x, y, valueW + 2, h);
  const room = freeRight(r, valueX + valueW + 1, y, h, background, 120);
  const fit = fitVertically(r, x, valueW + 2 + room, y, h, background, size * 0.95);
  const left = line.segments[segIndex - 1]?.text;
  const name = label ? label.slice(0, -1).trim() : left && hasLetters(left) ? left.replace(/[:：]\s*$/, "") : `Field ${n}`;
  return { name, page: line.page, x, y: fit.y, w: valueW + 2 + room, h: fit.h, fontSize: size, background, text: text.slice(label.length).trim() };
}

/** A fill-in box for an empty area the user dragged. */
export function spotFromArea(r: Raster, page: number, rect: { x: number; y: number; w: number; h: number }, n: number): Spot {
  const fontSize = rect.h < 30 ? Math.max(7, Math.min(12, Math.round(rect.h * 0.7))) : 11;
  return {
    name: `Field ${n}`,
    page,
    ...rect,
    fontSize,
    background: backgroundOf(r, rect.x, rect.y, rect.w, rect.h),
    multiline: rect.h > fontSize * 2.5,
  };
}
