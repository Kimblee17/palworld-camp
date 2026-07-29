"""
Récupère l'appétit (FoodAmount) de chaque espèce de Pal.

⚠ SOURCE DIFFÉRENTE DU RESTE DU PIPELINE, et c'est délibéré : palworld.gg ne publie
pas cette statistique. Vérifié sur l'union des clés des 299 Pals de son dataset — son
objet `stats` n'en compte que 11 (hp, melee, shot, defense, support, craftSpeed,
runSpeed, rideSprintSpeed, slowWalkSpeed, price, stamina) — et les fiches
individuelles n'affichent que ces mêmes valeurs. On passe donc par paldb.cc, qui
expose les paramètres bruts du jeu, dont FoodAmount. robots.txt y autorise le crawl.

`FoodAmount` est la quantité de nourriture qu'un Pal consomme par repas, sur une
échelle entière ~1-10 (Chikipi 1, Lamball 1, Mammorest 6, Jetragon 9). C'est la
statistique d'appétit du jeu, pas un débit : elle ne dit rien de la vitesse à laquelle
la jauge se vide. L'interface doit donc rester au niveau de l'ordre de grandeur.

Structure de page : chaque fiche porte plusieurs onglets, l'onglet actif
(`class="tab-pane fade show active"`) étant la révision courante et les onglets
« <Nom>(cache - N) » d'anciennes révisions aux valeurs parfois différentes
(Lamball : 1 en actif, 2 en cache). On ne lit QUE l'onglet actif.

Cache : data/pal-food.json. Lançable seul :  python fetch_pal_food.py
"""
import json
import os
import re
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

BASE_DIR = Path(__file__).parent
# En intégration continue on veut un échec franc plutôt qu'un repli silencieux.
STRICT = os.getenv("PALWORLD_STRICT_FETCH") == "1"
CACHE = BASE_DIR / "data" / "pal-food.json"
BASE_URL = "https://paldb.cc/en/"

# Une fiche par Pal : 300 requêtes. En parallèle pour tenir la minute, sans charger
# la source (elle n'impose aucun délai, on reste volontairement modeste).
WORKERS = 6

# Nom du CSV -> slug paldb.cc, uniquement quand la règle « espaces -> _ » ne suffit pas.
# Les Pals de boss humains sont fichés sous leur intitulé complet chez paldb.
SLUG_ALIASES = {
    "Zoe & Grizzbolt": "Rayne_Syndicate_Officer_Zoe_%26_Grizzbolt",
}

# Proportion minimale de Pals résolus en dessous de laquelle on considère le scraping
# cassé : mieux vaut échouer que publier un indicateur alimentaire à moitié aveugle.
MIN_COVERAGE = 0.9

_PANE = re.compile(r'class="tab-pane fade show active"')
_FOOD = re.compile(r"FoodAmount</div>\s*<div>([0-9]+)</div>")


def slug_for(name):
    return SLUG_ALIASES.get(name) or urllib.parse.quote(name.replace(" ", "_"))


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=45) as r:
        return r.read().decode("utf-8", "replace")


def parse_food(html):
    """FoodAmount de l'onglet ACTIF (les onglets « cache » sont d'anciennes révisions)."""
    m = _PANE.search(html)
    zone = html[m.end():] if m else html
    f = _FOOD.search(zone)
    return int(f.group(1)) if f else None


def food_for(name):
    try:
        return name, parse_food(fetch(BASE_URL + slug_for(name)))
    except Exception:
        return name, None


def scrape(names, verbose=True):
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        res = dict(pool.map(food_for, names))
    trouves = {n: f for n, f in res.items() if f is not None}
    manquants = sorted(n for n, f in res.items() if f is None)
    if verbose:
        vals = sorted(trouves.values())
        print(f"  {len(trouves)}/{len(names)} appétits récupérés "
              f"(échelle {vals[0]}-{vals[-1]})" if trouves else "  aucun appétit récupéré")
        if manquants:
            print(f"  ⚠ {len(manquants)} sans fiche : {', '.join(manquants[:8])}"
                  f"{'…' if len(manquants) > 8 else ''}")
    if len(trouves) < MIN_COVERAGE * len(names):
        raise RuntimeError(
            f"Appétit récupéré pour {len(trouves)}/{len(names)} Pals seulement "
            f"(seuil {MIN_COVERAGE:.0%}) — structure de paldb.cc changée ?")
    return trouves


def load_pal_food(names, cache=CACHE, verbose=True):
    """Appétits pour build_data : fetch live + cache, repli sur cache si réseau KO."""
    try:
        data = scrape(names, verbose=verbose)
        cache.parent.mkdir(exist_ok=True)
        cache.write_text(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True),
                         encoding="utf-8")
        return data
    except Exception as exc:
        if STRICT:
            raise
        if cache.exists():
            print(f"  ⚠ Téléchargement impossible ({exc}). Utilisation du cache {cache}.")
            return json.loads(cache.read_text(encoding="utf-8"))
        raise RuntimeError(
            f"Téléchargement des appétits impossible et aucun cache ({cache})."
        ) from exc


if __name__ == "__main__":
    pals = json.loads((BASE_DIR / "data" / "pals.json").read_text(encoding="utf-8"))
    load_pal_food([p["name"] for p in pals])
    print(f"\nCache écrit dans {CACHE}")
