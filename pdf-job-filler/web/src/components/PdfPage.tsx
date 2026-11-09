import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PDFDocumentProxy, PageViewport, RenderTask } from "pdfjs-dist";
import { errorMessage } from "@shared";
import { pdfjs, pdfjsOptions } from "@/lib/pdfjs";

export interface Box {
  key: string;
  /** PDF user space, origin bottom-left */
  x: number;
  y: number;
  w: number;
  h: number;
  className?: string | undefined;
  title?: string | undefined;
  label?: ReactNode | undefined;
  onClick?: () => void | undefined;
}

interface Props {
  bytes: Uint8Array;
  page: number;
  boxes?: Box[] | undefined;
  /** called with a rectangle in PDF coordinates when the user drags on the page */
  onSelectRect?: (r: { x: number; y: number; w: number; h: number }) => void | undefined;
  onPageCount?: (n: number) => void | undefined;
  maxWidth?: number | undefined;
}

/** Renders one PDF page to a canvas with clickable overlay boxes and drag-to-select. */
export function PdfPage({
  bytes,
  page,
  boxes = [],
  onSelectRect,
  onPageCount,
  maxWidth = 900,
}: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy>();
  const [viewport, setViewport] = useState<PageViewport>();
  const [width, setWidth] = useState(0);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    let loaded: PDFDocumentProxy | undefined;
    setError(undefined);
    pdfjs
      .getDocument({ ...pdfjsOptions, data: bytes.slice() })
      .promise.then((d) => {
        loaded = d;
        if (cancelled) {
          void d.destroy();
          return;
        }
        setDoc(d);
        onPageCount?.(d.numPages);
      })
      .catch((e: unknown) => setError(errorMessage(e)));
    return () => {
      cancelled = true;
      loaded?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bytes]);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.min(el.clientWidth, maxWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [maxWidth]);

  useEffect(() => {
    if (!doc || !width || !canvas.current) return;
    let task: RenderTask | undefined;
    let cancelled = false;
    (async () => {
      const p = await doc.getPage(Math.min(Math.max(1, page), doc.numPages));
      if (cancelled) return;
      const base = p.getViewport({ scale: 1 });
      const vp = p.getViewport({ scale: width / base.width });
      const dpr = window.devicePixelRatio || 1;
      const c = canvas.current!;
      c.width = Math.floor(vp.width * dpr);
      c.height = Math.floor(vp.height * dpr);
      c.style.width = `${vp.width}px`;
      c.style.height = `${vp.height}px`;
      task = p.render({
        canvasContext: c.getContext("2d")!,
        canvas: c,
        viewport: vp,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        annotationMode: pdfjs.AnnotationMode.ENABLE,
      });
      setViewport(vp);
      await task.promise.catch(() => {});
    })();
    return () => {
      cancelled = true;
      task?.cancel?.();
    };
  }, [doc, page, width]);

  const toCss = (vp: PageViewport, b: { x: number; y: number; w: number; h: number }) => {
    const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = vp.convertToViewportRectangle([
      b.x,
      b.y,
      b.x + b.w,
      b.y + b.h,
    ]);
    return {
      left: Math.min(x1, x2),
      top: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
    };
  };

  const local = (e: React.PointerEvent) => {
    const r = wrap.current!.querySelector(".pdfpage-stage")!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  if (error) return <div className="error">Could not show this PDF: {error}</div>;

  return (
    <div className="pdfpage" ref={wrap}>
      <div
        className={`pdfpage-stage ${onSelectRect ? "selectable" : ""}`}
        onPointerDown={(e) => {
          if (
            !onSelectRect ||
            e.button !== 0 ||
            (e.target as HTMLElement).classList.contains("box")
          )
            return;
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          const p = local(e);
          setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
        }}
        onPointerMove={(e) => {
          if (!drag) return;
          const p = local(e);
          setDrag({ ...drag, x1: p.x, y1: p.y });
        }}
        onPointerUp={() => {
          if (!drag || !viewport) return setDrag(null);
          const { x0, y0, x1, y1 } = drag;
          setDrag(null);
          if (Math.abs(x1 - x0) < 6 || Math.abs(y1 - y0) < 6) return;
          const [ax, ay] = viewport.convertToPdfPoint(Math.min(x0, x1), Math.max(y0, y1));
          const [bx, by] = viewport.convertToPdfPoint(Math.max(x0, x1), Math.min(y0, y1));
          onSelectRect?.({ x: ax, y: ay, w: bx - ax, h: by - ay });
        }}
      >
        <canvas ref={canvas} />
        {viewport &&
          boxes.map((b) => (
            <div
              key={b.key}
              className={`box ${b.className ?? ""} ${b.onClick ? "clickable" : ""}`}
              style={toCss(viewport, b)}
              title={b.title}
              onClick={b.onClick}
            >
              {b.label}
            </div>
          ))}
        {drag && (
          <div
            className="box drag"
            style={{
              left: Math.min(drag.x0, drag.x1),
              top: Math.min(drag.y0, drag.y1),
              width: Math.abs(drag.x1 - drag.x0),
              height: Math.abs(drag.y1 - drag.y0),
            }}
          />
        )}
      </div>
    </div>
  );
}

export function PageNav({
  page,
  count,
  onChange,
}: {
  page: number;
  count: number;
  onChange: (p: number) => void;
}) {
  if (count <= 1) return null;
  return (
    <div className="pagenav">
      <button className="btn small" disabled={page <= 1} onClick={() => onChange(page - 1)}>
        ‹ Prev
      </button>
      <span>
        Page {page} / {count}
      </span>
      <button className="btn small" disabled={page >= count} onClick={() => onChange(page + 1)}>
        Next ›
      </button>
    </div>
  );
}
