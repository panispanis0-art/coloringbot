"""Image generation back-ends. Each returns raw image bytes (PNG/JPEG/WebP)."""
from __future__ import annotations

import base64
import io
import random
import threading
import time
from urllib.parse import quote

import requests
from PIL import Image, ImageDraw

from .config import Config


class ImageError(RuntimeError):
    pass


def _openai(cfg: Config, prompt: str) -> bytes:
    r = requests.post(
        "https://api.openai.com/v1/images/generations",
        headers={"Authorization": f"Bearer {cfg.openai_key}"},
        json={"model": cfg.openai_image_model, "prompt": prompt, "size": "1024x1536",
              "quality": cfg.openai_image_quality, "n": 1},
        timeout=300)
    if r.status_code != 200:
        raise ImageError(f"OpenAI {r.status_code}: {r.text[:300]}")
    return base64.b64decode(r.json()["data"][0]["b64_json"])


def _gemini(cfg: Config, prompt: str) -> bytes:
    url = (f"https://generativelanguage.googleapis.com/v1beta/models/"
           f"{cfg.gemini_image_model}:generateContent")
    r = requests.post(
        url, headers={"x-goog-api-key": cfg.gemini_key},
        json={"contents": [{"parts": [{"text": prompt + " Portrait orientation, 3:4."}]}],
              "generationConfig": {"responseModalities": ["IMAGE"],
                                   "imageConfig": {"aspectRatio": "3:4"}}},
        timeout=300)
    if r.status_code != 200:
        raise ImageError(f"Gemini {r.status_code}: {r.text[:300]}")
    for part in r.json()["candidates"][0]["content"]["parts"]:
        data = part.get("inlineData") or part.get("inline_data")
        if data:
            return base64.b64decode(data["data"])
    raise ImageError("Gemini returned no image")


def _fal(cfg: Config, prompt: str) -> bytes:
    r = requests.post(
        "https://fal.run/fal-ai/flux/schnell",
        headers={"Authorization": f"Key {cfg.fal_key}"},
        json={"prompt": prompt, "image_size": "portrait_4_3", "num_images": 1,
              "num_inference_steps": 4, "enable_safety_checker": True},
        timeout=300)
    if r.status_code != 200:
        raise ImageError(f"fal {r.status_code}: {r.text[:300]}")
    img_url = r.json()["images"][0]["url"]
    return requests.get(img_url, timeout=120).content


def _cloudflare(cfg: Config, prompt: str) -> bytes:
    url = (f"https://api.cloudflare.com/client/v4/accounts/{cfg.cf_account}"
           f"/ai/run/{cfg.cf_image_model}")
    r = requests.post(url, headers={"Authorization": f"Bearer {cfg.cf_token}"},
                      json={"prompt": prompt[:2000], "steps": 4}, timeout=300)
    if r.status_code != 200:
        raise ImageError(f"Cloudflare {r.status_code}: {r.text[:300]}")
    ctype = r.headers.get("content-type", "")
    if ctype.startswith("image/"):
        return r.content
    return base64.b64decode(r.json()["result"]["image"])


_last_pollinations = [0.0]
_pollinations_lock = threading.Lock()


def _pollinations(cfg: Config, prompt: str) -> bytes:
    # Anonymous use allows ~1 image every 45 s per IP; a free key is faster.
    with _pollinations_lock:  # one request at a time across worker threads
        if not cfg.pollinations_key:
            wait = 46 - (time.time() - _last_pollinations[0])
            if wait > 0:
                time.sleep(wait)
        _last_pollinations[0] = time.time()
    url = "https://image.pollinations.ai/prompt/" + quote(prompt[:1500], safe="")
    headers = {"Authorization": f"Bearer {cfg.pollinations_key}"} if cfg.pollinations_key else {}
    r = requests.get(url, params={"width": 768, "height": 1024, "seed": random.randint(1, 10**9),
                                  "model": "flux", "enhance": "false",
                                  "nologo": "true", "safe": "true"},
                     headers=headers, timeout=300)
    if r.status_code != 200 or not r.headers.get("content-type", "").startswith("image/"):
        raise ImageError(f"Pollinations {r.status_code}: {r.text[:200]}")
    if cfg.pollinations_key:
        return r.content
    # Anonymous images carry a small logo along the bottom edge: crop it off.
    img = Image.open(io.BytesIO(r.content)).convert("RGB")
    w, h = img.size
    img = img.crop((0, 0, w, int(h * 0.93)))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


BACKENDS = {"openai": _openai, "gemini": _gemini, "fal": _fal,
            "cloudflare": _cloudflare, "pollinations": _pollinations}


def chain(cfg: Config) -> list[str]:
    """Which back-ends to try, in order."""
    if cfg.provider == "free":
        return (["cloudflare"] if cfg.cf_account and cfg.cf_token else []) + ["pollinations"]
    return [cfg.provider]


def check(cfg: Config) -> None:
    need = {"openai": cfg.openai_key, "gemini": cfg.gemini_key, "fal": cfg.fal_key,
            "cloudflare": cfg.cf_account and cfg.cf_token, "pollinations": True, "free": True}
    if cfg.provider not in need:
        raise SystemExit(f"IMAGE_PROVIDER must be one of {list(need)}")
    if not need[cfg.provider]:
        raise SystemExit(f"Missing API key for IMAGE_PROVIDER={cfg.provider} in .env")


# Back-ends that ran out of quota today are skipped for the rest of the book.
_exhausted: set[str] = set()


used: dict[str, int] = {}  # images made per back-end (for the log)


def generate(cfg: Config, prompt: str, retries: int = 3) -> bytes:
    errors = []
    for name in chain(cfg):
        if name in _exhausted:
            continue
        fn, delay = BACKENDS[name], 5
        for attempt in range(retries):
            try:
                data = fn(cfg, prompt)
                used[name] = used.get(name, 0) + 1
                return data
            except (ImageError, requests.RequestException, KeyError, ValueError) as e:
                msg = str(e)
                errors.append(f"{name}: {msg[:120]}")
                print(f"{name} failed: {msg[:200]}", flush=True)
                low = msg.lower()
                if name == "cloudflare" and ("4006" in msg or "neuron" in low or "429" in msg
                                             or " 401" in msg or " 403" in msg or "header" in low):
                    _exhausted.add(name)  # daily free allowance used up -> next back-end
                    break
                if "safety" in low or "moderation" in low or "nsfw" in low:
                    prompt += " (gentle, simple, kid-friendly)"
                time.sleep(delay)
                delay *= 2
    raise ImageError("; ".join(errors[-3:]) or "no image back-end available")
