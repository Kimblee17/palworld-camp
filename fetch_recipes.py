"""
Récupère les recettes de fabrication des objets depuis palworld.gg.

Les objets sont servis par un chunk JS qui contient un JSON.parse(`[...]`) : on le
découvre dynamiquement depuis la page /fr/items (les hash changent à chaque
déploiement), puis on lit directement le tableau. La locale **fr** est indispensable :
les noms d'objets doivent coïncider avec ceux de data/pal-drops.json, scrapé en français.

Pour chaque objet : recette (ingrédients + quantités), quantité produite, type, niveau
de technologie, et les Pals qui le lâchent.

⚠ LIMITE DE LA SOURCE, assumée : palworld.gg **ne publie pas** la station de craft par
objet. Ce qui est disponible :
  - `produces` sur les structures d'extraction (Scierie -> Bois, Mine de charbon ->
    Charbon…) : correspondance EXACTE, on la récupère aussi ;
  - le `type` de l'objet (Food, Ammo, Material…), d'où une correspondance seulement
    PROBABLE vers un établi.
La station par objet fabriqué est donc déduite du type via STATION_BY_TYPE, table
explicite et éditable, et marquée comme telle (`stationGuessed`) pour que l'interface
ne présente pas une supposition comme un fait.

Cache : data/recipes.json. Lançable seul :  python fetch_recipes.py
"""
import json
import os
import re
import urllib.request
from pathlib import Path

BASE_DIR = Path(__file__).parent
# En intégration continue on veut un échec franc plutôt qu'un repli silencieux.
STRICT = os.getenv("PALWORLD_STRICT_FETCH") == "1"
CACHE = BASE_DIR / "data" / "recipes.json"
BASE_URL = "https://palworld.gg"

# Chunk du jeu de données des OBJETS, épinglé en dernier recours.
# palworld.gg résout le composant de route (et donc ce chunk) à l'exécution, via un
# manifeste que seul le navigateur télécharge : l'exploration du graphe d'imports ne
# l'atteint pas. On tente donc l'exploration d'abord — elle se réparera d'elle-même si
# le chunk redevient atteignable — puis ce nom figé. Le contenu est TOUJOURS validé
# (champs + marqueurs français) avant d'être accepté, donc un hash périmé fait échouer
# proprement plutôt que de produire des données fausses.
# Pour le rafraîchir : ouvrir https://palworld.gg/fr/items, onglet Réseau, repérer le
# /_nuxt/<hash>.js d'environ 550 Ko.
ITEMS_CHUNK_PINNED = "DB7Zks69"
STRUCTS_CHUNK_PINNED = "Cv3boAuy"   # idem pour les structures (champ `produces`)

# Nom de structure chez palworld.gg -> nom dans palworld-structures.csv.
# Uniquement les cas où les deux libellés diffèrent ; le reste correspond à l'identique.
STATION_ALIASES = {
    "Scierie": "Camp de bûcheronnage",
    "Scierie II": "Camp de bûcheronnage",
    "Carrière": "Carrière de pierre",
    "Carrière de cuivre": "Site d'extraction de minerai",
    "Carrière de cuivre II": "Site d'extraction de minerai II",
    "Carrière de quartz pur": "Mine de quartz pur",
    "Mine d’hexoquartz": "Mine de quartz hexolite",
    "Mine d'hexoquartz": "Mine de quartz hexolite",
    "Pompe à pétrole brut": "Pompe à pétrole brut haute pression",
    "Carrière de soralite": None,          # pas d'équivalent dans nos constructions
}

# Type d'objet -> station la plus probable. HEURISTIQUE (la source ne donne pas la
# station par objet) : c'est l'établi le plus courant pour ce type, pas une vérité.
# Édite librement ; `None` = on n'affiche aucune station plutôt qu'une fausse.
STATION_BY_TYPE = {
    "Food": "Marmite",
    "Material": "Établi de fortune",
    "Ammo": "Établi d'armurerie",
    "SpecialWeapon": "Établi de Pal-Spheres",
    "CaptureItemModifier": "Établi de Pal-Spheres",
    "Consume": "Établi médiéval de médicaments",
    "Accessory": "Établi de fortune",
    "Glider": "Établi de fortune",
    "Essential": "Établi de fortune",
    "Blueprint": None,                     # schémas : ne se fabriquent pas à un établi
}


def fetch(path):
    url = path if path.startswith("http") else BASE_URL + path
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8", "replace")


def _parse_chunk(js):
    """Extrait le tableau d'un chunk `JSON.parse(\\`[...]\\`)`."""
    m = re.search(r"JSON\.parse\(`(.*?)`\)", js, re.S)
    if not m:
        return None
    raw = m.group(1).replace("\\`", "`").replace("\\$", "$")
    try:
        data = json.loads(raw)
    except Exception:
        return None
    return data if isinstance(data, list) and data else None


def find_chunk(page_paths, champs, marqueurs, epingles=(), max_bundles=500):
    """Page -> bundles /_nuxt -> premier chunk dont les entrées portent `champs`.

    Le chunk de données n'est pas référencé par la page : il est importé par un bundle
    lui-même importé par la page. On explore donc en largeur sur deux niveaux, en
    suivant les `import("./XXX.js")`. Les hash changent à chaque déploiement, d'où cette
    découverte plutôt qu'une URL en dur.

    `marqueurs` : noms attendus en FRANÇAIS. palworld.gg publie un chunk par langue et
    rien dans l'URL ne les distingue — sans ce garde-fou on récupère au hasard le
    portugais ou l'anglais, et les noms ne correspondent plus à data/pal-drops.json.
    """
    def liens(txt):
        # `/_nuxt/X.js` (page), `import("./X.js")` (import différé) et `"./X.js"`
        # (table de correspondance du routeur) : les trois formes mènent au chunk.
        noms = set(re.findall(r"/_nuxt/([A-Za-z0-9_]+)\.js", txt))
        noms |= set(re.findall(r'"\./([A-Za-z0-9_]+)\.js"', txt))
        return noms

    if isinstance(page_paths, str):
        page_paths = [page_paths]
    vus, file = set(), list(epingles or [])
    for pp in page_paths:
        try:
            file.extend(liens(fetch(pp)))
        except Exception:
            continue
    while file and len(vus) < max_bundles:
        nom = file.pop(0)
        if nom in vus:
            continue
        vus.add(nom)
        try:
            js = fetch(f"/_nuxt/{nom}.js")
        except Exception:
            continue
        data = _parse_chunk(js)
        # On teste l'UNION des clés sur un échantillon : objets et structures partagent
        # id/name/recipe/type, seuls des champs comme `price` ou `produces` les séparent.
        if data and isinstance(data[0], dict):
            # union sur TOUTES les entrées : des champs comme `produces` ne sont présents
            # que sur une poignée d'entrées, un échantillon les manquerait.
            vues = set().union(*(set(d) for d in data if isinstance(d, dict)))
            noms = {d.get("name") for d in data if isinstance(d, dict)}
            if champs <= vues and marqueurs & noms:
                return data
        file.extend(n for n in liens(js) if n not in vus)
    raise RuntimeError(f"Chunk introuvable depuis {page_paths} (structure palworld.gg changée ?).")


def scrape(verbose=True):
    # Plusieurs pages en amorce : le chunk des objets n'est pas atteignable depuis la
    # seule page /fr/items (Nuxt résout le composant de route à l'exécution).
    items = find_chunk(["/fr/items", "/fr/technology-tree", "/fr/weapons", "/fr/armor"],
                       {"id", "name", "recipe", "type", "price", "stats"},
                       {"Bois", "Pierre", "Fibre"}, epingles=[ITEMS_CHUNK_PINNED])
    structs = find_chunk(["/fr/structures", "/fr/technology-tree"],
                         {"id", "name", "recipe", "type", "produces", "workers"},
                         {"Marmite", "Feu de camp", "Scierie"}, epingles=[STRUCTS_CHUNK_PINNED])

    # Ressources brutes : structure d'extraction qui les produit (correspondance exacte).
    produced_by = {}
    for s in structs:
        p = s.get("produces")
        if isinstance(p, dict) and p.get("name"):
            nom = STATION_ALIASES.get(s["name"], s["name"])
            produced_by.setdefault(p["name"], nom if nom else s["name"])

    recipes, sans_station = {}, []
    for it in items:
        rec = it.get("recipe") or []
        if not rec:
            continue
        station = STATION_BY_TYPE.get(it["type"], None)
        recipes[it["name"]] = {
            "id": it["id"],
            "type": it["type"],
            "count": it.get("craftCount", 1),            # quantité produite par craft
            "ingredients": [{"name": i["name"], "count": i.get("count", 1)} for i in rec],
            "station": station,
            "stationGuessed": bool(station),             # déduit du type, pas publié
            **({"techLevel": it["techLevel"]} if it.get("techLevel") else {}),
        }
        if not station:
            sans_station.append(it["name"])

    # Ressources brutes : ingrédient qui EXISTE dans le catalogue d'objets mais n'a pas
    # de recette (Blé, Paloxite, Tomate…). Sans cette liste, l'interface ne peut pas
    # distinguer « ressource à récolter » d'un nom qu'elle ne reconnaît pas — et
    # afficherait à tort « ingrédient inconnu » sur 124 ressources parfaitement banales.
    connus = {it["name"] for it in items}
    ingredients = {i["name"] for it in items for i in (it.get("recipe") or [])}
    raw_items = sorted(n for n in ingredients if n in connus and n not in recipes)

    data = {
        "recipes": recipes,
        "producedBy": produced_by,
        "rawItems": raw_items,
        "stationAliases": {k: v for k, v in STATION_ALIASES.items() if v},
        "stationByType": STATION_BY_TYPE,
    }
    if verbose:
        print(f"  {len(recipes)} recettes, {len(produced_by)} ressource(s) d'extraction, "
              f"{len(raw_items)} ressource(s) brute(s)")
        inconnus = sorted(ingredients - connus)
        if inconnus:
            print(f"  ⚠ {len(inconnus)} ingrédient(s) absent(s) du catalogue : "
                  f"{', '.join(inconnus[:5])}{'…' if len(inconnus) > 5 else ''}")
        if sans_station:
            print(f"  ⚠ {len(sans_station)} objet(s) sans station (type sans établi associé)")
    return data


def load_recipes(cache=CACHE, verbose=True):
    """Recettes pour build_data : fetch live + cache, repli sur cache si réseau KO."""
    try:
        data = scrape(verbose=verbose)
        cache.parent.mkdir(exist_ok=True)
        cache.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        return data
    except Exception as exc:
        if STRICT:
            raise
        if cache.exists():
            print(f"  ⚠ Téléchargement impossible ({exc}). Utilisation du cache {cache}.")
            return json.loads(cache.read_text(encoding="utf-8"))
        raise RuntimeError(
            f"Téléchargement des recettes impossible et aucun cache ({cache})."
        ) from exc


if __name__ == "__main__":
    load_recipes()
    print(f"\nCache écrit dans {CACHE}")
