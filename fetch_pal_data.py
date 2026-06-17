"""
Récupère les données de jeu des Pals depuis palworld.gg.

Contrairement aux fiches HTML, le calculateur /capture-rate embarque le dataset
complet du jeu dans des bundles JS (/_nuxt/pals.<hash>.js). On y trouve, par Pal :
  - level             : niveau « suggéré » (celui pré-rempli dans le calculateur de capture)
  - Rarity            : rareté (1 à 20) -> catégorie Common/Rare/Epic/Legendary
  - CaptureRateCorrect: multiplicateur de capture (plus haut = plus facile)
  - ZukanIndex        : numéro de Paldeck

Les noms de fichiers sont hashés et changent à chaque déploiement du site : on les
découvre donc dynamiquement (page -> bundle capture-rate -> bundles pals). palworld.gg
expose un bundle par langue (noms localisés) : on sélectionne celui dont les noms
collent le mieux à nos Pals (l'anglais), sans fusionner les autres.

Utilisé par build_data.py (load_pal_data) ; le cache data/pal-data.json sert de repli
hors-ligne. Lançable seul pour rafraîchir le cache :  python fetch_pal_data.py
"""
import json
import re
import urllib.request
from pathlib import Path

BASE_DIR = Path(__file__).parent
CACHE = BASE_DIR / "data" / "pal-data.json"
BASE_URL = "https://palworld.gg"


def fetch(path):
    url = path if path.startswith("http") else BASE_URL + path
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8")


def rarity_category(r):
    """Catégorie de rareté façon palworld.gg (vérifié : 1-4 Common, 5-7 Rare, 8-19 Epic, 20 Legendary)."""
    if r is None:
        return None
    if r >= 20:
        return "Legendary"
    if r >= 8:
        return "Epic"
    if r >= 5:
        return "Rare"
    return "Common"


def _num(slice_, key, cast=float):
    m = re.search(key + r":(-?[0-9.]+)", slice_)
    return cast(m.group(1)) if m else None


def parse_dataset(js):
    """Extrait {nom: {...}} d'un bundle pals.<hash>.js (objets JS minifiés)."""
    out = {}
    starts = [(m.group(1), m.start()) for m in re.finditer(r'OverrideNameTextID:"([^"]+)"', js)]
    for i, (name, pos) in enumerate(starts):
        end = starts[i + 1][1] if i + 1 < len(starts) else len(js)
        s = js[pos:end]
        rarity = _num(s, "Rarity", int)
        out[name] = {
            "level": _num(s, "level", int),
            "rarity": rarity,
            "rarityCategory": rarity_category(rarity),
            "captureRate": _num(s, "CaptureRateCorrect"),
            "zukan": _num(s, "ZukanIndex", int),
        }
    return out


def discover_dataset_urls():
    """Page /capture-rate -> bundle capture-rate.<hash>.js -> URLs des bundles pals.<hash>.js."""
    page = fetch("/capture-rate")
    cr = re.search(r"/_nuxt/capture-rate\.[A-Za-z0-9_-]+\.js", page)
    if not cr:
        raise RuntimeError("Bundle capture-rate introuvable sur /capture-rate.")
    bundle = fetch(cr.group(0))
    urls = sorted(set(re.findall(r"\.?(/_nuxt/pals\.[A-Za-z0-9_-]+\.js)", bundle)) |
                  set("/_nuxt/" + u for u in re.findall(r'"\./(pals\.[A-Za-z0-9_-]+\.js)"', bundle)))
    if not urls:
        raise RuntimeError("Aucun bundle pals.*.js référencé dans capture-rate.js.")
    return urls


# Noms anglais canoniques pour reconnaître le bon bundle si aucune cible n'est fournie.
# On inclut des Pals de collab (Terraria) pour préférer le dataset anglais le plus complet.
_MARKERS = {"chikipi", "lamball", "anubis", "frostallion",
            "greenslime", "blueslime", "eyeofcthulhu"}


def _norm(name):
    return name.lower().strip().replace(" ", "").replace("-", "").replace("&", "").replace("'", "")


def scrape(target_names=None, verbose=True):
    """Sélectionne le bundle (langue) dont les noms couvrent le mieux nos Pals."""
    targets = {_norm(n) for n in target_names} if target_names else _MARKERS
    best, best_data, best_score = None, None, -1
    for url in discover_dataset_urls():
        data = parse_dataset(fetch(url))
        score = sum(1 for n in data if _norm(n) in targets)
        if verbose:
            print(f"  {url.split('/')[-1]} : {len(data)} Pals, couvre {score}")
        if score > best_score:
            best, best_data, best_score = url, data, score
    if verbose:
        print(f"Bundle retenu : {best.split('/')[-1]} ({best_score} Pals couverts)")
    return best_data


def load_pal_data(cache=CACHE, target_names=None, verbose=True):
    """Données de jeu pour build_data : fetch live + cache, repli sur cache si réseau KO."""
    try:
        data = scrape(target_names=target_names, verbose=verbose)
        cache.parent.mkdir(exist_ok=True)
        cache.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        return data
    except Exception as exc:
        if cache.exists():
            print(f"  ⚠ Téléchargement impossible ({exc}). Utilisation du cache {cache}.")
            return json.loads(cache.read_text(encoding="utf-8"))
        raise RuntimeError(
            f"Téléchargement des données de Pals impossible et aucun cache ({cache})."
        ) from exc


if __name__ == "__main__":
    load_pal_data()
    print(f"\nCache écrit dans {CACHE}")
