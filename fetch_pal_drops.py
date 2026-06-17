"""
Récupère les drops (butin) des Pals depuis les fiches palworld.gg.

Les drops ne sont PAS dans le dataset de jeu (fetch_pal_data.py) : ils ne figurent que
sur chaque fiche HTML palworld.gg/pal/<slug>, dans la table « Possible Drops »
(objet · quantité · taux). On scrape donc une page par Pal (en parallèle).

Chaque drop = {"item": "Bone", "amount": "3 - 5", "rate": "100%"}.

Utilisé par build_data.py (load_pal_drops) ; le cache data/pal-drops.json sert de repli
hors-ligne. Lançable seul pour rafraîchir le cache :  python fetch_pal_drops.py
"""
import json
import re
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

BASE_DIR = Path(__file__).parent
CACHE = BASE_DIR / "data" / "pal-drops.json"
PALS = BASE_DIR / "data" / "pals.json"
BASE_URL = "https://palworld.gg"
WORKERS = 8

ROW_RE = re.compile(r"<tr>(.*?)</tr>", re.S)
NAME_RE = re.compile(r'<div class="name">([^<]+)</div>')
TD_RE = re.compile(r"<td[^>]*>(.*?)</td>", re.S)
_TAGS = re.compile(r"<[^>]+>")
_WS = re.compile(r"\s+")


def fetch(path):
    req = urllib.request.Request(BASE_URL + path, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8")


def _text(html):
    return _WS.sub(" ", _TAGS.sub("", html)).strip()


def parse_drops(html):
    """Extrait la liste des drops depuis la table « Possible Drops » d'une fiche Pal."""
    i = html.find("Possible Drops")
    if i == -1:
        return []
    table = re.search(r"<table>.*?</table>", html[i:i + 8000], re.S)
    if not table:
        return []
    drops = []
    for row in ROW_RE.finditer(table.group(0)):
        block = row.group(1)
        name = NAME_RE.search(block)
        tds = [_text(x) for x in TD_RE.findall(block)]
        if not name or len(tds) < 3:
            continue  # ligne d'en-tête ou incomplète
        # item = div.name ; quantité et taux = les deux dernières colonnes
        drops.append({"item": name.group(1).strip(), "amount": tds[-2], "rate": tds[-1]})
    return drops


def scrape(slugs, verbose=True):
    """Scrape les drops pour chaque slug en parallèle. Renvoie {slug: [drops]}."""
    def one(slug):
        try:
            return slug, parse_drops(fetch(f"/pal/{slug}"))
        except Exception:
            return slug, None

    out = {}
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for slug, drops in pool.map(one, slugs):
            if drops is not None:
                out[slug] = drops
    if verbose:
        failed = len(slugs) - len(out)
        empty = sum(1 for d in out.values() if not d)
        print(f"Drops récupérés : {len(out)}/{len(slugs)} Pals"
              + (f" ({failed} échec(s) réseau)" if failed else "")
              + (f", {empty} sans drop" if empty else ""))
    return out


def _slugs_from_pals():
    if not PALS.exists():
        return []
    return [p["slug"] for p in json.loads(PALS.read_text(encoding="utf-8")) if p.get("slug")]


def load_pal_drops(slugs=None, cache=CACHE, verbose=True):
    """Drops pour build_data : scrape live + cache, repli sur cache si réseau KO."""
    slugs = slugs if slugs is not None else _slugs_from_pals()
    try:
        data = scrape(slugs, verbose=verbose)
        if not data:
            raise RuntimeError("aucune fiche récupérée")
        cache.parent.mkdir(exist_ok=True)
        cache.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        return data
    except Exception as exc:
        if cache.exists():
            print(f"  ⚠ Scraping impossible ({exc}). Utilisation du cache {cache}.")
            return json.loads(cache.read_text(encoding="utf-8"))
        raise RuntimeError(f"Scraping des drops impossible et aucun cache ({cache}).") from exc


if __name__ == "__main__":
    load_pal_drops()
    print(f"\nCache écrit dans {CACHE}")
