from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

try:
    from dotenv import load_dotenv
    load_dotenv(ROOT / ".env")
except ImportError:
    pass


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, "").strip() or default)
    except ValueError:
        return default


def _cf_parts() -> tuple[str, str]:
    """Find the account id and API token even if the secrets were pasted with
    extra text (e.g. the whole 'curl ... Bearer <token>' example)."""
    import re
    acc_raw = os.getenv("CLOUDFLARE_ACCOUNT_ID", "")
    tok_raw = os.getenv("CLOUDFLARE_API_TOKEN", "")
    words = lambda s: re.findall(r"[A-Za-z0-9_-]{30,}", s)
    hexid = lambda w: re.fullmatch(r"[0-9a-f]{32}", w) is not None
    acc = next((w for w in words(acc_raw) + words(tok_raw) if hexid(w)), "")
    m = re.search(r"Bearer\s+([A-Za-z0-9_-]{30,})", tok_raw)
    toks = ([m.group(1)] if m else []) + [w for w in words(tok_raw) + words(acc_raw) if not hexid(w)]
    return acc, (toks[0] if toks else "")


@dataclass
class Config:
    bot_token: str = field(default_factory=lambda: os.getenv("TELEGRAM_BOT_TOKEN", "").strip())
    chat_ids: list[int] = field(default_factory=lambda: [
        int(x) for x in os.getenv("TELEGRAM_CHAT_ID", "").replace(" ", "").split(",") if x.lstrip("-").isdigit()])
    provider: str = field(default_factory=lambda: os.getenv("IMAGE_PROVIDER", "free").strip().lower())
    openai_key: str = field(default_factory=lambda: os.getenv("OPENAI_API_KEY", "").strip())
    gemini_key: str = field(default_factory=lambda: os.getenv("GEMINI_API_KEY", "").strip())
    fal_key: str = field(default_factory=lambda: os.getenv("FAL_KEY", "").strip())
    cf_account: str = field(default_factory=lambda: _cf_parts()[0])
    cf_token: str = field(default_factory=lambda: _cf_parts()[1])
    cf_image_model: str = field(default_factory=lambda: os.getenv("CLOUDFLARE_IMAGE_MODEL", "@cf/black-forest-labs/flux-1-schnell").strip())
    cf_text_model: str = field(default_factory=lambda: os.getenv("CLOUDFLARE_TEXT_MODEL", "@cf/meta/llama-3.1-8b-instruct-fast").strip())
    pollinations_key: str = field(default_factory=lambda: os.getenv("POLLINATIONS_KEY", "").strip())
    pages: int = field(default_factory=lambda: _int("PAGES", 100))
    page_size: str = field(default_factory=lambda: os.getenv("PAGE_SIZE", "A4").strip().upper())
    age_group: str = field(default_factory=lambda: os.getenv("AGE_GROUP", "4-8").strip())
    openai_image_model: str = field(default_factory=lambda: os.getenv("OPENAI_IMAGE_MODEL", "gpt-image-1").strip())
    openai_image_quality: str = field(default_factory=lambda: os.getenv("OPENAI_IMAGE_QUALITY", "low").strip())
    openai_text_model: str = field(default_factory=lambda: os.getenv("OPENAI_TEXT_MODEL", "gpt-4.1-mini").strip())
    gemini_image_model: str = field(default_factory=lambda: os.getenv("GEMINI_IMAGE_MODEL", "gemini-2.5-flash-image").strip())
    gemini_text_model: str = field(default_factory=lambda: os.getenv("GEMINI_TEXT_MODEL", "gemini-2.5-flash").strip())
    redraws: int = field(default_factory=lambda: _int("REDRAWS", 2))
    parallel: int = field(default_factory=lambda: _int("PARALLEL", 4))
    auto_every_hours: int = field(default_factory=lambda: _int("AUTO_EVERY_HOURS", 0))
    out_dir: Path = ROOT / "books"
    state_dir: Path = ROOT / "state"

    def __post_init__(self):
        self.out_dir.mkdir(exist_ok=True)
        self.state_dir.mkdir(exist_ok=True)
