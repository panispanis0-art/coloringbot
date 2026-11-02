"""End-to-end: ideas -> images -> hand-drawn cleanup -> PDF."""
from __future__ import annotations

import datetime as dt
import random
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from PIL import Image

from . import book, handdrawn, ideas, providers
from .config import Config


SIMPLER = (" Make it much simpler: fewer, bigger shapes, thick bold outlines, "
           "large empty areas to color, no tiny details, no shading, no black fills. "
           "Every animal is a plain natural animal on all its own legs, with no clothes "
           "and no human features.")


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:50] or "book"


def make_book(cfg: Config, request: str | None = None, log=print,
              progress=lambda done, total: None) -> dict:
    providers.check(cfg)
    plan = ideas.plan_book(cfg, request, log=log)
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M")
    folder = cfg.out_dir / f"{stamp}-{_slug(plan['title'])}"
    (folder / "pages").mkdir(parents=True, exist_ok=True)
    log(f"Book: {plan['title']} ({len(plan['pages'])} pages) via {'+'.join(providers.chain(cfg))}")

    results: dict[int, Path] = {}
    quality_log: list[tuple[int, float]] = []
    budget = [max(3, cfg.pages // 2)]  # at most ~25 redraws per 100-page book
    failures: list[str] = []

    def work(i: int, page: dict) -> Path:
        # Quality gate: redraw pages that are too busy, too dark, shaded or empty.
        best = None
        for attempt in range(1 + cfg.redraws + 2):
            prompt = page["prompt"] if attempt == 0 else page["prompt"] + SIMPLER
            raw = providers.generate(cfg, prompt)
            (folder / "pages" / f"{i:03d}_raw_{attempt}.img").write_bytes(raw)
            img, score, problems = handdrawn.process_scored(raw, seed=random.randint(0, 2**31))
            if score >= 0.6:
                import io
                small = Image.open(io.BytesIO(raw)).convert("L")
                small.thumbnail((512, 512))
                buf = io.BytesIO()
                small.save(buf, "PNG")
                ok, why = providers.review_page(cfg, buf.getvalue(), page["scene"])
                if not ok:
                    score = 0.45  # below the bar: redraw, but still better than a broken page
                    problems = problems + [f"looks wrong: {why}"]
            if best is None or score > best[1]:
                best = (img, score, problems)
            if score >= 0.6:
                break
            painted = score <= 0.2  # never accept a painted/3D picture if we can avoid it
            if not painted and (budget[0] <= 0 or attempt >= cfg.redraws):
                break
            if not painted:
                budget[0] -= 1  # cap ordinary redraws so a book never takes too long
            log(f"page {i + 1} redraw ({', '.join(problems)})")
        img, score, problems = best
        if i != 999:
            quality_log.append((i, score))
        p = folder / "pages" / f"{i:03d}.png"
        img.save(p, optimize=True)
        return p

    todo = list(enumerate(plan["pages"]))
    # The cover gets its own illustration: the hero, big and happy, drawn for the cover.
    hero = plan.get("character") or plan["theme"]
    cover_page = {"scene": f"cover illustration of {hero}, big in the middle, happy and "
                           f"looking at the viewer, with a few small {plan['theme']} things around",
                  "prompt": ideas.STYLE.format(scene=f"book cover illustration of {ideas._clean_scene(hero)}, "
                                                     f"big in the centre, happy, looking at the viewer, "
                                                     f"a few small {ideas._clean_scene(plan['theme'])} "
                                                     f"things around, no text, no letters")}
    with ThreadPoolExecutor(max_workers=max(1, cfg.parallel)) as ex:
        cover_fut = ex.submit(work, 999, cover_page)
        futs = {ex.submit(work, i, pg): i for i, pg in todo}
        for f in as_completed(futs):
            i = futs[f]
            try:
                results[i] = f.result()
            except Exception as e:
                failures.append(f"page {i + 1}: {e}")
            progress(len(results), len(todo))

    # Retry failed pages once with a fresh scene so the book stays full.
    missing = [i for i, _ in todo if i not in results]
    for i in missing:
        try:
            results[i] = work(i, plan["pages"][i])
            progress(len(results), len(todo))
        except Exception as e:
            failures.append(f"page {i + 1} retry: {e}")

    if not results:
        raise RuntimeError("No pages could be generated. " + "; ".join(failures[-3:]))
    order = sorted(results)
    arts = [Image.open(results[i]) for i in order]
    try:
        cover_art = Image.open(cover_fut.result())
    except Exception as e:  # never lose a book over its cover
        log(f"cover art failed ({e}); using page 1")
        cover_art = None
    captions = [plan["pages"][i].get("caption") for i in order]
    pdf = book.make_pdf(plan["title"], arts, folder / f"{_slug(plan['title'])}.pdf", cfg.page_size,
                        captions=captions, cover_art=cover_art,
                        hero_name=(plan.get("character") or "").split(",")[0].strip()[:20] or None)
    avg = sum(q for _, q in quality_log) / max(1, len(quality_log))
    log(f"Average page quality: {avg:.2f}; images by back-end: {providers.used}")
    (folder / "plan.txt").write_text(
        plan["title"] + "\n\n" + "\n".join(f"{n + 1}. {plan['pages'][i]['scene']}" for n, i in enumerate(order)))
    log(f"Done: {len(order)} pages, {len(failures)} errors -> {pdf}")
    return {"title": plan["title"], "theme": plan["theme"], "pdf": pdf, "pages": len(order),
            "folder": folder, "failures": failures, "preview": [results[i] for i in order[:4]]}
