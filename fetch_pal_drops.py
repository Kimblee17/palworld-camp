"""
Récupère les drops (butin) des Pals depuis les fiches palworld.gg.

Les drops ne sont PAS dans le dataset de jeu (fetch_pal_data.py) : ils ne figurent que
sur chaque fiche HTML palworld.gg, dans la table de butin (objet · quantité · taux).
On scrape la version **française** (/fr/pal/<slug>) pour avoir les noms d'objets en FR,
une page par Pal (en parallèle).

Chaque drop = {"item": "Os", "amount": "3 - 5", "rate": "100%"}.

Utilisé par build_data.py (load_pal_drops) ; le cache data/pal-drops.json sert de repli
hors-ligne. Lançable seul pour rafraîchir le cache :  python fetch_pal_drops.py
"""
import json
import re
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

BASE_DIR = Path(__file__).parent
CACHE = BASE_DIR / "data" / "pal-drops.json"
PALS = BASE_DIR / "data" / "pals.json"
BASE_URL = "https://palworld.gg"
LOCALE = "/fr"          # version française des fiches -> noms d'objets en FR
WORKERS = 8

TABLE_RE = re.compile(r"<table>.*?</table>", re.S)
ROW_RE = re.compile(r"<tr>(.*?)</tr>", re.S)
NAME_RE = re.compile(r'<div class="name">([^<]+)</div>')
TD_RE = re.compile(r"<td[^>]*>(.*?)</td>", re.S)
RATE_RE = re.compile(r"\d")            # une cellule de taux/quantité contient un chiffre
_TAGS = re.compile(r"<[^>]+>")
_WS = re.compile(r"\s+")


def fetch(path, retries=3):
    req = urllib.request.Request(BASE_URL + path, headers={"User-Agent": "Mozilla/5.0"})
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.read().decode("utf-8")
        except Exception:
            if attempt == retries - 1:
                raise
            time.sleep(0.5 * (attempt + 1))   # petit backoff contre le throttling


def _text(html):
    return _WS.sub(" ", _TAGS.sub("", html)).strip()


def _parse_table(table):
    drops = []
    for row in ROW_RE.finditer(table):
        block = row.group(1)
        name = NAME_RE.search(block)
        tds = [_text(x) for x in TD_RE.findall(block)]
        # item = div.name ; quantité et taux = les deux dernières colonnes (contiennent un chiffre)
        if name and len(tds) >= 3 and RATE_RE.search(tds[-1]):
            drops.append({"item": name.group(1).strip(), "amount": tds[-2], "rate": tds[-1]})
    return drops


def parse_drops(html):
    """Extrait les drops de la table de butin (repérée par sa structure, indépendant de la langue)."""
    for table in TABLE_RE.findall(html):
        drops = _parse_table(table)
        if drops:
            return drops
    return []


def scrape(slugs, verbose=True):
    """Scrape les drops pour chaque slug en parallèle. Renvoie {slug: [drops]}."""
    def one(slug):
        # FR d'abord (noms d'objets en français) ; repli sur la fiche par défaut (EN)
        # pour les Pals non traduits, ex. la collab Terraria absente de /fr/.
        for prefix in (LOCALE, ""):
            try:
                return slug, parse_drops(fetch(f"{prefix}/pal/{slug}"))
            except Exception:
                continue
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
    existing = json.loads(cache.read_text(encoding="utf-8")) if cache.exists() else {}
    try:
        data = scrape(slugs, verbose=verbose)
        if not data:
            raise RuntimeError("aucune fiche récupérée")
        # Fusion sur le cache : un slug en échec réseau conserve ses drops déjà connus.
        merged = {**existing, **data}
        cache.parent.mkdir(exist_ok=True)
        cache.write_text(json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8")
        return merged
    except Exception as exc:
        if cache.exists():
            print(f"  ⚠ Scraping impossible ({exc}). Utilisation du cache {cache}.")
            return json.loads(cache.read_text(encoding="utf-8"))
        raise RuntimeError(f"Scraping des drops impossible et aucun cache ({cache}).") from exc


if __name__ == "__main__":
    load_pal_drops()
    print(f"\nCache écrit dans {CACHE}")
