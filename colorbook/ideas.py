"""Idea discovery: pick a fresh theme and write one scene per page.

Uses the configured text AI (OpenAI or Gemini). If none is available it falls
back to a built-in theme bank, so the pipeline never stalls on ideas.
Past themes are kept in state/history.json so books do not repeat.
"""
from __future__ import annotations

import datetime as dt
import json
import random
import re
from pathlib import Path

import requests

from .config import Config

SEASONAL = {
    1: "winter, snow and New Year", 2: "Valentine's friendship and winter animals",
    3: "spring flowers and baby animals", 4: "Easter, rain and gardens",
    5: "bugs, bees and blossoms", 6: "summer beach and ocean",
    7: "camping, picnics and summer fun", 8: "pools, ice cream and road trips",
    9: "back to school and apples", 10: "friendly Halloween and autumn leaves",
    11: "harvest, forests and cozy autumn", 12: "Christmas, winter and holidays",
}

THEME_BANK = {
    "Farm Friends": ["cow", "pig", "sheep", "horse", "chicken with chicks", "duck", "goat", "tractor", "barn", "farmer", "rabbit", "dog", "cat", "donkey", "turkey", "scarecrow", "pumpkin patch", "hay bales", "beehive", "windmill"],
    "Ocean Adventure": ["whale", "dolphin", "octopus", "sea turtle", "crab", "starfish", "seahorse", "jellyfish", "clownfish", "shark", "submarine", "pirate ship", "mermaid", "treasure chest", "lighthouse", "seal", "coral reef", "pufferfish", "anchor", "sandcastle"],
    "Dinosaur World": ["T-rex", "triceratops", "stegosaurus", "brachiosaurus", "pterodactyl", "dinosaur egg hatching", "baby dinosaur", "volcano", "ankylosaurus", "velociraptor", "dinosaur with palm trees", "fossil dig", "spinosaurus", "parasaurolophus", "dinosaur family", "dinosaur footprints", "dino reading a book", "dino on a skateboard", "dino birthday", "dino at the beach"],
    "Things That Go": ["fire truck", "police car", "school bus", "train", "airplane", "helicopter", "rocket", "sailboat", "bicycle", "race car", "excavator", "dump truck", "hot air balloon", "tractor", "garbage truck", "ambulance", "motorcycle", "submarine", "ice cream truck", "crane"],
    "Space Explorers": ["astronaut", "rocket ship", "planet with rings", "moon and stars", "friendly alien", "UFO", "space station", "comet", "astronaut cat", "moon rover", "telescope", "galaxy", "satellite", "alien pet", "planet garden", "sun with sunglasses", "space dog", "star constellation", "astronaut floating", "robot on mars"],
    "Jungle Safari": ["lion", "elephant", "giraffe", "zebra", "monkey", "hippo", "parrot", "tiger", "crocodile", "toucan", "sloth", "rhino", "cheetah", "gorilla", "snake", "flamingo", "safari jeep", "chameleon", "meerkat", "panda"],
    "Fairy Tale Land": ["castle", "princess", "knight", "friendly dragon", "unicorn", "fairy", "wizard", "magic wand", "gingerbread house", "frog prince", "carriage", "mermaid", "elf", "magic tree", "treasure map", "crown", "gnome house", "owl wizard", "fairy garden", "tower with long hair"],
    "Cute Kawaii Food": ["cupcake", "ice cream cone", "donut", "pizza slice", "watermelon", "strawberry", "taco", "sushi", "pancakes", "birthday cake", "cookie", "popcorn", "banana", "avocado", "lollipop", "milkshake", "hot dog", "carrot", "apple", "boba tea"],
}

STYLE = ("black and white line drawing, children's coloring book page: {scene}. "
         "Cute simple cartoon, clean bold black "
         "outlines on a pure white background, thick even line art, no fill, flat 2D, "
         "large simple shapes, lots of white space, full body in frame, one single scene, "
         "simple round cartoon eyes, every outline closed "
         "(no floating heads, no extra portraits or insets). "
         "Animals have their real natural animal body and anatomy, on their own legs and paws, "
         "like a nature picture book, not dressed, not human-like")


COLOR_WORDS = re.compile(
    r"\b(red|orange|yellow|green|blue|purple|violet|pink|brown|black|white|gray|grey|golden|"
    r"gold|silver|colou?rful|bright|dark|light|pastel|rainbow-colou?red|striped|spotted|shiny|"
    r"glowing|sparkling|vivid|neon)\b\s*", re.I)


def _clean_scene(scene: str) -> str:
    # Color and lighting words push image models toward painted, shaded art.
    return re.sub(r"\s{2,}", " ", COLOR_WORDS.sub("", scene)).strip(" ,.")


def _history_path(cfg: Config) -> Path:
    return cfg.state_dir / "history.json"


def load_history(cfg: Config) -> list[str]:
    p = _history_path(cfg)
    if p.exists():
        try:
            return json.loads(p.read_text())
        except Exception:
            return []
    return []


def save_history(cfg: Config, themes: list[str]) -> None:
    _history_path(cfg).write_text(json.dumps(themes[-200:], indent=1))


def _extract_json(text: str) -> dict:
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise ValueError("no JSON in model reply")
    return json.loads(m.group(0))


def _ask_llm(cfg: Config, prompt: str) -> str:
    if cfg.gemini_key:
        url = (f"https://generativelanguage.googleapis.com/v1beta/models/"
               f"{cfg.gemini_text_model}:generateContent")
        r = requests.post(url, headers={"x-goog-api-key": cfg.gemini_key},
                          json={"contents": [{"parts": [{"text": prompt}]}],
                                "generationConfig": {"responseMimeType": "application/json"}},
                          timeout=180)
        r.raise_for_status()
        return r.json()["candidates"][0]["content"]["parts"][0]["text"]
    if cfg.cf_account and cfg.cf_token:
        url = (f"https://api.cloudflare.com/client/v4/accounts/{cfg.cf_account}"
               f"/ai/run/{cfg.cf_text_model}")
        r = requests.post(url, headers={"Authorization": f"Bearer {cfg.cf_token}"},
                          json={"messages": [{"role": "user", "content": prompt}],
                                "max_tokens": 8000}, timeout=300)
        r.raise_for_status()
        out = r.json()["result"]["response"]
        return out if isinstance(out, str) else json.dumps(out)
    if cfg.openai_key:
        r = requests.post("https://api.openai.com/v1/chat/completions",
                          headers={"Authorization": f"Bearer {cfg.openai_key}"},
                          json={"model": cfg.openai_text_model,
                                "response_format": {"type": "json_object"},
                                "temperature": 1.0,
                                "messages": [{"role": "user", "content": prompt}]},
                          timeout=180)
        r.raise_for_status()
        return r.json()["choices"][0]["message"]["content"]
    # Free fallback with no key: Pollinations' OpenAI-compatible text endpoint.
    r = requests.post("https://text.pollinations.ai/openai",
                      json={"model": "openai", "messages": [{"role": "user", "content": prompt}]},
                      timeout=300)
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"]


def _llm_plan(cfg: Config, history: list[str], request: str | None) -> dict:
    today = dt.date.today()
    season = SEASONAL[today.month]
    ask = (f"The user asked for this theme: {request}. Use it." if request else
           f"Invent a fresh, specific theme kids love right now. Consider the season "
           f"({season}), evergreen kid favorites and popular kids' interests, but "
           f"never copy brands or copyrighted characters.")
    prompt = f"""You plan children's coloring books for ages {cfg.age_group}.
{ask}
Do NOT reuse any of these past themes: {json.dumps(history[-60:])}.

Make it feel like a real, designed book, not random pictures:
- Invent ONE main character: EITHER a real animal OR a human child, never a mix. An animal
  must look like the real animal drawn cute: its natural body, legs, paws and fur, no clothes,
  no shoes, no human hair, no human hands, not standing or dancing like a person.
  Give it a name and a short, fixed look (e.g. "Pip, a round little hedgehog with big eyes
  and a tiny nose"). Put that exact description in
  most scenes so the character looks the same on every page. Some pages can show friends,
  places or objects from the same world instead.
- Order the pages as a gentle story from morning to night or start to finish of an adventure.

Return JSON: {{"title": "short fun book title", "theme": "theme in 3-6 words",
"character": "the fixed character description",
"pages": [{{"subject": "2-5 words", "scene": "one sentence describing a simple, cute scene",
"caption": "the storybook line printed under the picture: warm, simple words a 5-year-old enjoys, max 12 words"}}]}}
with exactly {cfg.pages} pages. Every page must be a clearly different scene. Keep scenes simple: one main subject, at most 2-3 background items,
nothing scary, no text or letters in the picture, no real brands or characters.
Never mention colors, light, shadows or textures: these are black-and-white outline pages."""
    data = _extract_json(_ask_llm(cfg, prompt))
    pages = [p for p in data.get("pages", []) if p.get("scene")]
    if len(pages) < cfg.pages * 0.8:
        raise ValueError(f"model returned only {len(pages)} pages")
    return {"character": data.get("character", ""),
            "title": data.get("title") or data.get("theme", "My Coloring Book"),
            "theme": data.get("theme", data.get("title", "")),
            "pages": pages}


ACTIONS = ["happy", "playing", "sleeping", "waving hello", "with a friend",
           "in a garden", "at a party", "reading a book", "on an adventure",
           "with balloons", "in the rain with an umbrella", "jumping", "eating a snack",
           "under the stars", "by a river", "with flowers", "wearing a hat", "dancing",
           "having a picnic", "in a cozy house"]


def _bank_subjects(theme: str) -> list[str]:
    # Stay on the requested theme: use a matching bank, or else the theme itself.
    words = lambda s: {w.rstrip("s") for w in s.lower().split()}
    for name, subjects in THEME_BANK.items():
        if words(theme) & words(name):
            return subjects
    return [theme]


def _fallback_plan(cfg: Config, history: list[str], request: str | None) -> dict:
    themes = [t for t in THEME_BANK if t not in history] or list(THEME_BANK)
    theme = request if request else random.choice(themes)
    subjects = _bank_subjects(theme)
    combos = [(s, a) for s in subjects for a in ACTIONS]
    random.shuffle(combos)
    pages = [{"subject": s, "scene": f"a cute {s} {a}"} for s, a in combos[: cfg.pages]]
    return {"title": f"{theme[:1].upper()}{theme[1:]} Coloring Book", "theme": theme, "pages": pages}


def plan_book(cfg: Config, request: str | None = None, log=print) -> dict:
    history = load_history(cfg)
    try:
        plan = _llm_plan(cfg, history, request)
        log(f"Ideas from AI: {plan['theme']}")
    except Exception as e:  # network, quota, bad JSON...
        log(f"AI idea step failed ({e}); using built-in theme bank")
        plan = _fallback_plan(cfg, history, request)
    # pad/trim to exactly cfg.pages
    pages = plan["pages"]
    while len(pages) < cfg.pages:
        p = dict(random.choice(plan["pages"]))
        p["scene"] += f", {random.choice(ACTIONS)}"
        pages.append(p)
    plan["pages"] = pages[: cfg.pages]
    char = _clean_scene(plan.get("character") or "")
    name = char.split(",")[0].split()[0] if char else ""
    for p in plan["pages"]:
        if not p.get("caption"):
            cap = p["scene"]
            if char and len(char) > len(name):
                cap = cap.replace(plan.get("character", ""), name)
            p["caption"] = cap.split(",")[0].strip().rstrip(".") + "."
        p["caption"] = p["caption"].strip()[:110]
        scene = _clean_scene(p["scene"])
        # Always say what the main character IS, or the image AI invents a random animal.
        if char and name and name.lower() in scene.lower() and char.lower() not in scene.lower():
            scene = f"{scene} ({char})"
        p["prompt"] = STYLE.format(scene=scene)
    save_history(cfg, history + [plan["theme"]])
    return plan


def suggest_themes(cfg: Config, n: int = 3) -> list[str]:
    """A few fresh, short theme ideas for the Telegram buttons."""
    history = load_history(cfg)
    try:
        season = SEASONAL[dt.date.today().month]
        txt = _ask_llm(cfg, f"Suggest {n} fresh, specific coloring book themes kids aged "
                            f"{cfg.age_group} love (season: {season}). Each 2-4 words, no brands. "
                            f"Avoid: {json.dumps(history[-30:])}. "
                            'Return JSON: {"themes": ["...", "..."]}')
        ideas_ = [str(t).strip() for t in _extract_json(txt).get("themes", []) if str(t).strip()]
        if len(ideas_) >= n:
            return [t[:40] for t in ideas_[:n]]
    except Exception:
        pass
    pool = [t for t in THEME_BANK if t not in history] or list(THEME_BANK)
    return random.sample(pool, min(n, len(pool)))
