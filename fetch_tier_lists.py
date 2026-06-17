"""
Récupère les tier-lists de palworld.gg.

5 onglets sont extraits :
  - best-overall   : classement général (rang seul)
  - workers        : Pals de travail (rang + compétences de camp)
  - flying-mounts  : montures volantes (rang + vitesse)
  - ground-mounts  : montures terrestres (rang + vitesse)
  - combat         : combat (rang seul)

Les pages sont rendues côté serveur (Nuxt SSR) : les données sont directement
dans le HTML, pas dans une API JSON. On parse donc le HTML.

Doublons : le site liste parfois deux fois le même Pal (même slug, mêmes
données). Le parsing déduplique par slug en conservant la première occurrence.

Ce module est aussi utilisé par build_data.py (fonction load_tier_lists), qui
fusionne ces rangs directement dans data/pals.json. Le cache data/tier-lists.json
n'est qu'un fichier technique : il évite de retélécharger à chaque build et sert
de repli quand le réseau est indisponible.

Usage en ligne de commande (rafraîchit le cache) :  python fetch_tier_lists.py
"""
import json
import re
import urllib.request
from html import unescape
from pathlib import Path

BASE_DIR = Path(__file__).parent
CACHE = BASE_DIR / "data" / "tier-lists.json"
BASE_URL = "https://palworld.gg"

# Onglets : (clé, libellé, chemin URL)
PAGES = [
    ("best-overall",  "Best Overall",  "/tier-list"),
    ("workers",       "Workers",       "/tier-list/base-work"),
    ("flying-mounts", "Flying Mounts", "/tier-list/flying-mounts"),
    ("ground-mounts", "Ground Mounts", "/tier-list/ground-mounts"),
    ("combat",        "Combat",        "/tier-list/combat"),
]

# Libellés de compétence du site -> identifiant interne (cf. build_data.py).
WORK_MAP = {
    "Farming": "farming",
    "Generating Electricity": "electricity",
    "Kindling": "kindling",
    "Gathering": "gathering",
    "Transporting": "transporting",
    "Planting": "planting",
    "Watering": "watering",
    "Medicine Production": "medicine",
    "Handiwork": "handiwork",
    "Mining": "mining",
    "Deforesting": "lumbering",
    "Cooling": "cooling",
}

TIER_RE = re.compile(r'<div class="tier ([A-Z]+)"><div class="t-name">[A-Z]+</div>')
PAL_RE = re.compile(r'<div class="pal"[^>]*>(.*?)(?=<div class="pal"|$)', re.S)
WORK_RE = re.compile(
    r'<div class="active item"[^>]*>.*?alt="([^"]+)" width="20".*?'
    r'<span class="value">(\d+)</span>',
    re.S,
)


def fetch(path):
    url = BASE_URL + path
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8")


def parse_page(html):
    """Extrait {tier: [pals]} d'une page de tier-list, dédupliqué par slug."""
    # On se limite au bloc <div class="tier-list"> pour ignorer CSS/JS.
    start = html.find('<div class="tier-list">')
    if start != -1:
        html = html[start:]

    tiers = [(m.group(1), m.start()) for m in TIER_RE.finditer(html)]
    seen = set()            # slugs déjà vus (dédup sur toute la page)
    duplicates = 0
    out = {}

    for i, (tier, s) in enumerate(tiers):
        e = tiers[i + 1][1] if i + 1 < len(tiers) else len(html)
        block = html[s:e]
        pals = []
        for pm in PAL_RE.finditer(block):
            pb = pm.group(1)
            href = re.search(r'href="/pal/([^"]+)"', pb)
            name = re.search(r'alt="([^"]*)"', pb)
            if not href or not name:
                continue
            slug = href.group(1)
            if slug in seen:
                duplicates += 1
                continue
            seen.add(slug)

            entry = {"name": unescape(name.group(1)).strip(), "slug": slug}

            works = {}
            for am in WORK_RE.finditer(pb):
                wid = WORK_MAP.get(am.group(1))
                lvl = int(am.group(2))
                if wid and lvl > 0:
                    works[wid] = lvl
            if works:
                entry["work"] = works

            speed = re.search(r'<div class="speed">([^<]+)</div>', pb)
            if speed:
                entry["speed"] = speed.group(1).strip()

            pals.append(entry)
        out[tier] = pals

    return out, duplicates


def scrape(verbose=True):
    """Télécharge et parse les 5 onglets. Lève une exception en cas d'échec réseau."""
    result = {}
    for key, label, path in PAGES:
        tiers, dups = parse_page(fetch(path))
        result[key] = {"label": label, "tiers": tiers}
        if verbose:
            total = sum(len(v) for v in tiers.values())
            counts = ", ".join(f"{t}:{len(v)}" for t, v in tiers.items())
            dup_msg = f"  (déduplication : {dups} doublon(s) retiré(s))" if dups else ""
            print(f"{label:14s} {total:4d} Pals  [{counts}]{dup_msg}")
    return result


def load_tier_lists(cache=CACHE, verbose=True):
    """Tier-lists pour build_data : fetch live + écriture cache, repli sur cache si réseau KO."""
    try:
        result = scrape(verbose=verbose)
        cache.parent.mkdir(exist_ok=True)
        cache.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        return result
    except Exception as exc:  # réseau indisponible, page modifiée, etc.
        if cache.exists():
            print(f"  ⚠ Téléchargement impossible ({exc}). Utilisation du cache {cache}.")
            return json.loads(cache.read_text(encoding="utf-8"))
        raise RuntimeError(
            f"Téléchargement des tier-lists impossible et aucun cache disponible ({cache})."
        ) from exc


if __name__ == "__main__":
    load_tier_lists()
    print(f"\nCache écrit dans {CACHE}")
