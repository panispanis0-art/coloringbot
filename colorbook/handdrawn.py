"""Turn an AI image into clean, hand-inked-looking coloring line art.

Steps: grayscale -> pure black/white -> hollow out big solid black blobs
(kids need space to color) -> drop specks -> gentle line wobble -> uneven
pen-pressure stroke weight -> 1-bit output.
"""
from __future__ import annotations

import io

import cv2
import numpy as np
from PIL import Image

WORK_LONG_SIDE = 2400


def _smooth_noise(h: int, w: int, cells: int, rng: np.random.Generator) -> np.ndarray:
    gh, gw = max(2, cells * h // max(h, w)), max(2, cells * w // max(h, w))
    grid = rng.standard_normal((gh, gw)).astype(np.float32)
    field = cv2.resize(grid, (w, h), interpolation=cv2.INTER_CUBIC)
    return field / (np.abs(field).max() + 1e-6)


def _load_gray(data: bytes) -> np.ndarray:
    img = Image.open(io.BytesIO(data))
    if img.mode in ("RGBA", "LA", "P"):
        img = img.convert("RGBA")
        bg = Image.new("RGBA", img.size, (255, 255, 255, 255))
        img = Image.alpha_composite(bg, img)
    gray = np.array(img.convert("L"))
    h, w = gray.shape
    s = WORK_LONG_SIDE / max(h, w)
    if abs(s - 1) > 0.05:
        gray = cv2.resize(gray, (round(w * s), round(h * s)),
                          interpolation=cv2.INTER_CUBIC if s > 1 else cv2.INTER_AREA)
    return gray


def to_ink_mask(gray: np.ndarray) -> np.ndarray:
    """Return uint8 mask, 255 = ink."""
    blur = cv2.GaussianBlur(gray, (3, 3), 0)
    otsu, _ = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    # Bias toward keeping only real dark lines; light gray shading becomes white.
    t = min(otsu, 150)
    _, ink = cv2.threshold(blur, t, 255, cv2.THRESH_BINARY_INV)
    return ink


def hollow_solids(ink: np.ndarray, line_px: int = 9) -> np.ndarray:
    """Replace large solid-black areas with an outline so they can be colored."""
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (line_px * 3, line_px * 3))
    core = cv2.erode(ink, k)
    if not core.any():
        return ink
    solid = cv2.dilate(core, k)
    solid = cv2.bitwise_and(solid, ink)
    inner = cv2.erode(solid, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (line_px * 2, line_px * 2)))
    # keep small details (eyes, noses): only hollow blobs bigger than ~1.5% of page
    n, labels, stats, _ = cv2.connectedComponentsWithStats((inner > 0).astype(np.uint8), 8)
    min_area = ink.size * 0.015
    big = np.zeros_like(ink)
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] >= min_area:
            big[labels == i] = 255
    return cv2.bitwise_and(ink, cv2.bitwise_not(big))


def drop_specks(ink: np.ndarray, min_frac: float = 0.00004) -> np.ndarray:
    n, labels, stats, _ = cv2.connectedComponentsWithStats((ink > 0).astype(np.uint8), 8)
    keep = np.zeros(n, dtype=bool)
    keep[1:] = stats[1:, cv2.CC_STAT_AREA] >= ink.size * min_frac
    return np.where(keep[labels], 255, 0).astype(np.uint8)


def hand_inked(ink: np.ndarray, seed: int | None = None,
               wobble_px: float = 2.2, weight: float = 0.22) -> np.ndarray:
    rng = np.random.default_rng(seed)
    h, w = ink.shape
    # 1) line wobble: low-frequency displacement, like a hand that is not a ruler
    dx = _smooth_noise(h, w, 9, rng) * wobble_px + _smooth_noise(h, w, 40, rng) * wobble_px * 0.35
    dy = _smooth_noise(h, w, 9, rng) * wobble_px + _smooth_noise(h, w, 40, rng) * wobble_px * 0.35
    xs, ys = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
    warped = cv2.remap(ink.astype(np.float32) / 255.0, xs + dx, ys + dy,
                       interpolation=cv2.INTER_LINEAR, borderValue=0.0)
    # 2) pen pressure: blur, then threshold with a slowly varying level, so some
    #    stretches are a bit thicker and others thinner; tiny noise roughens edges.
    soft = cv2.GaussianBlur(warped, (0, 0), 1.8)
    level = 0.5 + _smooth_noise(h, w, 6, rng) * weight + rng.normal(0, 0.035, (h, w)).astype(np.float32)
    out = (soft > np.clip(level, 0.18, 0.82)).astype(np.uint8) * 255
    # 3) close pinholes so color regions stay closed for kids
    out = cv2.morphologyEx(out, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    return out


def process(data: bytes, seed: int | None = None) -> Image.Image:
    """Bytes from the image AI -> 1-bit PIL image, black lines on white."""
    gray = _load_gray(data)
    ink = to_ink_mask(gray)
    ink = hollow_solids(ink)
    ink = drop_specks(ink)
    ink = hand_inked(ink, seed=seed)
    ink = drop_specks(ink)
    return Image.fromarray(255 - ink).convert("1", dither=Image.Dither.NONE)
