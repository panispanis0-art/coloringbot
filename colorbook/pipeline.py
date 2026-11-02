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
    failures: list[str] = []

    def work(i: int, page: dict) -> Path:
        raw = providers.generate(cfg, page["prompt"])
        (folder / "pages" / f"{i:03d}_raw.bin").write_bytes(raw)
        img = handdrawn.process(raw, seed=random.randint(0, 2**31))
        p = folder / "pages" / f"{i:03d}.png"
        img.save(p, optimize=True)
        return p

    todo = list(enumerate(plan["pages"]))
    with ThreadPoolExecutor(max_workers=max(1, cfg.parallel)) as ex:
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
    pdf = book.make_pdf(plan["title"], arts, folder / f"{_slug(plan['title'])}.pdf", cfg.page_size)
    for raw in (folder / "pages").glob("*_raw.bin"):
        raw.unlink()
    (folder / "plan.txt").write_text(
        plan["title"] + "\n\n" + "\n".join(f"{n + 1}. {plan['pages'][i]['scene']}" for n, i in enumerate(order)))
    log(f"Done: {len(order)} pages, {len(failures)} errors -> {pdf}")
    return {"title": plan["title"], "theme": plan["theme"], "pdf": pdf, "pages": len(order),
            "folder": folder, "failures": failures, "preview": [results[i] for i in order[:4]]}
