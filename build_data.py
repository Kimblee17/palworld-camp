"""
Génère les données de l'application depuis les fichiers CSV :
  - data/pals.json + data/structures.json   (caches lisibles, utilisés par les scripts)
  - docs/data.js                            (données embarquées par le site statique)
  - docs/sw.js                              (version du cache = hash git court)
  - data/changelog.json                     (Pals ajoutés/retirés depuis le build précédent)
  - data/breeding.json                      (breed power + combinaisons uniques)
  - data/recipes.json                       (recettes de fabrication)

Les rangs de tier-list (palworld.gg) sont fusionnés dans chaque Pal de pals.json
via fetch_tier_lists.load_tier_lists (téléchargement live + cache de repli).

Relance ce script après avoir modifié un CSV :  python build_data.py
"""
import csv
import datetime
import json
import re
import subprocess
from pathlib import Path

from fetch_tier_lists import load_tier_lists
from fetch_pal_data import load_pal_data
from fetch_pal_drops import load_pal_drops
from fetch_breeding import load_breeding
from fetch_recipes import load_recipes
from fetch_pal_food import load_pal_food
from fetch_passives import load_code_table, load_passives
from fetch_spawns import load_spawns

BASE_DIR = Path(__file__).parent
PALS_CSV = BASE_DIR / "Liste pals.csv"
STRUCT_CSV = BASE_DIR / "palworld-structures.csv"
PALS_OUT = BASE_DIR / "data" / "pals.json"
STRUCT_OUT = BASE_DIR / "data" / "structures.json"
STATIC_OUT = BASE_DIR / "docs" / "data.js"
SW_OUT = BASE_DIR / "docs" / "sw.js"
# Les apparitions vivent HORS de data.js : 300 Ko compressés qu'on ne veut pas
# faire porter au démarrage. Le module de carte les demande à la première fiche.
SPAWNS_OUT = BASE_DIR / "docs" / "data" / "spawns.json"
CHANGELOG_OUT = BASE_DIR / "data" / "changelog.json"

# Définition centralisée des 12 compétences de travail (source unique de vérité),
# recopiée dans docs/data.js pour le site statique.
WORK_TYPES = [
    {"id": "farming",      "label": "Élevage",         "order": 1,  "icon": "🥚"},
    {"id": "electricity",  "label": "Électricité",     "order": 2,  "icon": "⚡"},
    {"id": "kindling",     "label": "Allumage",        "order": 3,  "icon": "🔥"},
    {"id": "gathering",    "label": "Récolte",         "order": 4,  "icon": "🧺"},
    {"id": "transporting", "label": "Transport",       "order": 5,  "icon": "📦"},
    {"id": "planting",     "label": "Plantation",      "order": 6,  "icon": "🌱"},
    {"id": "watering",     "label": "Arrosage",        "order": 7,  "icon": "💧"},
    {"id": "medicine",     "label": "Médicaments",     "order": 8,  "icon": "💊"},
    {"id": "handiwork",    "label": "Travail manuel",  "order": 9,  "icon": "🔨"},
    {"id": "mining",       "label": "Minage",          "order": 10, "icon": "⛏️"},
    {"id": "lumbering",    "label": "Bûcheronnage",    "order": 11, "icon": "🪓"},
    {"id": "cooling",      "label": "Refroidissement", "order": 12, "icon": "❄️"},
]
WORK_IDS = [w["id"] for w in WORK_TYPES]

# Colonnes du CSV des Pals -> identifiant interne de compétence.
COLUMN_TO_WORK = {
    "Élevage": "farming",
    "Électricité": "electricity",
    "Allumage": "kindling",
    "Récolte": "gathering",
    "Transport": "transporting",
    "Plantation": "planting",
    "Arrosage": "watering",
    "Médicaments": "medicine",
    "Travail manuel": "handiwork",
    "Minage": "mining",
    "Bûcheronnage": "lumbering",
    "Refroidissement": "cooling",
}
NIGHT_COLUMN = "Travailleur de nuit"
LABEL_TO_WORK = dict(COLUMN_TO_WORK)

# Onglet de tier-list -> clé du champ "tiers" de chaque Pal.
TIER_CATEGORIES = {
    "best-overall":  "overall",
    "workers":       "workers",
    "combat":        "combat",
    "flying-mounts": "flyingMount",
    "ground-mounts": "groundMount",
}


# Production de ranch (extraite de la compétence de partenaire) -> est-ce un aliment ?
# Table exhaustive du vocabulaire observé : un produit absent d'ici est signalé au build
# plutôt que classé au hasard, pour qu'une mise à jour du jeu ne passe pas inaperçue.
RANCH_PRODUCT_IS_FOOD = {
    "Honey": True, "Red Berries": True, "Mushroom or Cavern Mushroom": True,
    "Cotton Candy": True, "Caramel Cotton Candy": True,
    "Aquatic Pal Fluids": False, "Bone": False, "Electric Organ": False,
    "Flame Organ": False, "Gold Coin": False, "High Quality Cloth": False,
    "High Quality Pal Oil": False, "Ice Organ": False, "Iceorgan": False,
    "Leather": False, "Venom Gland": False, "Wool": False,
    "items from the ground": False, "various seeds": False,
}
# Ces deux-là produisent au ranch sans que leur compétence de partenaire le dise —
# ce sont pourtant l'œuf et le lait, les deux productions les plus courantes du jeu.
RANCH_FOOD_IMPLICIT = {"Chikipi", "Mozzarina"}


def _norm(name):
    """Normalise un nom de Pal pour faire correspondre CSV et tier-list."""
    return name.lower().strip().replace(" ", "").replace("-", "")


def index_tiers(tier_data):
    """Construit {nom normalisé: {"tiers": {...}, "mountSpeed": {...}}} depuis les 5 onglets."""
    index = {}
    for page_key, category in TIER_CATEGORIES.items():
        page = tier_data.get(page_key)
        if not page:
            continue
        for tier, pals in page["tiers"].items():
            for p in pals:
                entry = index.setdefault(_norm(p["name"]), {"tiers": {}, "mountSpeed": {}, "slug": None})
                entry["tiers"][category] = tier
                entry["slug"] = entry["slug"] or p.get("slug")
                if "speed" in p:
                    # flyingMount -> flying, groundMount -> ground
                    entry["mountSpeed"][category.replace("Mount", "").lower()] = p["speed"]
    return index


def build_pals():
    tier_index = index_tiers(load_tier_lists())
    all_categories = list(TIER_CATEGORIES.values())

    with PALS_CSV.open(encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f, delimiter=";"))
    names = [n for n in ((r.get("Nom") or "").strip() for r in rows) if n]

    # Données de jeu (level, rareté, taux de capture) — bundle choisi sur nos noms.
    pal_data = load_pal_data(target_names=names)
    data_index = {_norm(n): v for n, v in pal_data.items()}

    # Drops : scrapés par slug sur les fiches palworld.gg.
    slugs = [info["slug"] for info in (tier_index.get(_norm(n)) for n in names)
             if info and info.get("slug")]
    drops_data = load_pal_drops(slugs)

    # Appétit (FoodAmount) — source distincte, cf. l'en-tête de fetch_pal_food.py :
    # palworld.gg ne publie pas cette statistique.
    food_data = load_pal_food(names)

    pals = []
    matched = set()
    data_matched = set()
    for i, row in enumerate(rows, start=1):
        name = (row.get("Nom") or "").strip()
        if not name:
            continue
        work = {}
        for col, wid in COLUMN_TO_WORK.items():
            try:
                lvl = int(row.get(col, 0) or 0)
            except ValueError:
                lvl = 0
            if lvl > 0:
                work[wid] = lvl

        info = tier_index.get(_norm(name))
        # Toutes les catégories présentes (None si le Pal n'y figure pas).
        tiers = {cat: None for cat in all_categories}
        if info:
            tiers.update(info["tiers"])
            matched.add(_norm(name))

        pal = {
            "id": i,
            "name": name,
            "work": work,
            "nightWorker": (row.get(NIGHT_COLUMN, "").strip().lower() == "oui"),
            "tiers": tiers,
        }
        if info and info.get("slug"):
            pal["slug"] = info["slug"]
            if drops_data.get(info["slug"]):
                pal["drops"] = drops_data[info["slug"]]
        if info and info["mountSpeed"]:
            pal["mountSpeed"] = info["mountSpeed"]

        gd = data_index.get(_norm(name))
        if gd:
            if gd.get("code"):
                pal["code"] = gd["code"]   # nom de code interne (BPClass) pour l'import CoWork
            if gd.get("elements"):
                pal["elements"] = gd["elements"]   # élément(s) canoniques pour la Palpedia
            pal["level"] = gd["level"]
            pal["rarity"] = gd["rarity"]
            pal["rarityCategory"] = gd["rarityCategory"]
            pal["captureRate"] = gd["captureRate"]
            pal["zukan"] = gd["zukan"]
            data_matched.add(_norm(name))
        if food_data.get(name) is not None:
            pal["food"] = food_data[name]     # appétit, échelle entière 1-9
        if name in RANCH_FOOD_IMPLICIT or RANCH_PRODUCT_IS_FOOD.get((gd or {}).get("ranch")):
            pal["ranchFood"] = True           # produit de la nourriture placé au ranch
        pals.append(pal)

    PALS_OUT.parent.mkdir(exist_ok=True)
    PALS_OUT.write_text(json.dumps(pals, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"{len(pals)} Pals écrits dans {PALS_OUT}")

    no_data = [p["name"] for p in pals if "level" not in p]
    if no_data:
        print(f"  ⚠ {len(no_data)} Pal(s) sans données de jeu (level/rareté) : {', '.join(no_data)}")

    inconnus = sorted({v["ranch"] for v in pal_data.values()
                       if v.get("ranch") and v["ranch"] not in RANCH_PRODUCT_IS_FOOD})
    if inconnus:
        print(f"  ⚠ {len(inconnus)} production(s) de ranch non classée(s) dans "
              f"RANCH_PRODUCT_IS_FOOD : {', '.join(inconnus)}")
    print(f"  {sum(1 for p in pals if p.get('ranchFood'))} Pal(s) produisent de la nourriture au ranch")

    no_food = [p["name"] for p in pals if "food" not in p]
    if no_food:
        print(f"  ⚠ {len(no_food)} Pal(s) sans appétit : {', '.join(no_food)}")

    no_tier = [p["name"] for p in pals if all(v is None for v in p["tiers"].values())]
    if no_tier:
        print(f"  ⚠ {len(no_tier)} Pal(s) sans aucun rang de tier-list : {', '.join(no_tier)}")
    unused = set(tier_index) - matched
    if unused:
        print(f"  ⚠ {len(unused)} Pal(s) de tier-list non présents dans le CSV (ignorés).")
    return pals


def merge_breeding(pals):
    """Ajoute breedPower à chaque Pal et renvoie les combos uniques en identifiants app.

    On embarque le pouvoir de reproduction (et les deux champs qui conditionnent le
    calcul) plutôt que la matrice des ~45 000 paires : le client recalcule l'enfant à
    la demande, cf. docs/js/breeding.js.
    """
    data = load_breeding()
    species = data["species"]
    id_by_name = {p["name"]: p["id"] for p in pals}

    sans = []
    for p in pals:
        sp = species.get(p["name"])
        if not sp or sp.get("breedPower") is None:
            sans.append(p["name"])
            continue
        p["breedPower"] = sp["breedPower"]
        p["breedPriority"] = sp["combiPriority"]
        # Espèce qui ne peut pas naître de la règle générale (légendaires, variantes…).
        if sp.get("ignoreCombi"):
            p["breedNoResult"] = True
        if sp.get("isBoss"):
            p["breedIsBoss"] = True

    combos, perdus = [], 0
    for c in data["uniqueCombos"]:
        try:
            combo = {"a": id_by_name[c["a"]], "b": id_by_name[c["b"]], "child": id_by_name[c["child"]]}
        except KeyError:
            perdus += 1        # espèce absente de notre CSV (ex. Zoe & Grizzbolt)
            continue
        if c.get("ga"): combo["ga"] = c["ga"]
        if c.get("gb"): combo["gb"] = c["gb"]
        combos.append(combo)

    print(f"Reproduction : {len(pals) - len(sans)}/{len(pals)} Pals avec breed power, "
          f"{len(combos)} combinaison(s) unique(s)")
    if sans:
        print(f"  ⚠ {len(sans)} Pal(s) sans breed power : {', '.join(sans)}")
    if perdus:
        print(f"  ⚠ {perdus} combinaison(s) ignorée(s) : espèce inconnue du CSV")
    return combos


def merge_recipes(structures):
    """Recettes + correspondance station -> id de construction de l'app.

    Les noms de stations viennent de palworld.gg (français) ; on les relie à nos
    constructions par nom exact, la table d'alias de fetch_recipes.py ayant déjà réglé
    les libellés divergents (Scierie -> Camp de bûcheronnage…).
    """
    data = load_recipes()
    id_by_name = {s["name"]: s["id"] for s in structures}

    inconnues = set()
    def station_id(nom):
        if not nom:
            return None
        sid = id_by_name.get(nom)
        if sid is None:
            inconnues.add(nom)
        return sid

    recipes = {}
    for nom, r in data["recipes"].items():
        recipes[nom] = {
            "count": r.get("count", 1),
            "ingredients": r["ingredients"],
            **({"station": r["station"], "stationId": station_id(r["station"]),
                "stationGuessed": r.get("stationGuessed", False)} if r.get("station") else {}),
        }
    produced_by = {}
    for res, nom in data["producedBy"].items():
        produced_by[res] = {"station": nom, "stationId": station_id(nom)}

    print(f"Recettes : {len(recipes)} objet(s), {len(produced_by)} ressource(s) d'extraction")
    if inconnues:
        print(f"  ⚠ {len(inconnues)} station(s) sans construction correspondante : {', '.join(sorted(inconnues))}")
    return {"recipes": recipes, "producedBy": produced_by,
            "rawItems": data.get("rawItems", [])}


def build_structures():
    structures = []
    unknown = set()
    with STRUCT_CSV.open(encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f, delimiter=";")
        for i, row in enumerate(reader, start=1):
            name = (row.get("Nom (FR)") or "").strip()
            if not name:
                continue
            # « Niveaux requis » est aligné positionnellement sur « Compétences
            # requises ». Colonne absente, plus courte ou valeur illisible : on
            # retombe sur 1, le minimum, plutôt que d'écarter la compétence.
            niveaux = [n.strip() for n in (row.get("Niveaux requis") or "").split(",")]
            requires, required_levels = [], {}
            for pos, part in enumerate((row.get("Compétences requises") or "").split(",")):
                key = part.strip()
                if not key:
                    continue
                wid = LABEL_TO_WORK.get(key)
                if wid is None:
                    unknown.add(key)
                    continue
                try:
                    lvl = int(niveaux[pos])
                except (IndexError, ValueError):
                    lvl = 1
                lvl = min(10, max(1, lvl))
                if wid not in requires:
                    requires.append(wid)
                # Même compétence citée deux fois : on garde l'exigence la plus haute.
                required_levels[wid] = max(required_levels.get(wid, 1), lvl)
            structures.append({
                "id": i,
                "name": name,
                "category": (row.get("Catégorie") or "").strip(),
                "requires": requires,
                "requiredLevels": required_levels,
            })
    STRUCT_OUT.parent.mkdir(exist_ok=True)
    STRUCT_OUT.write_text(json.dumps(structures, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"{len(structures)} structures écrites dans {STRUCT_OUT}")
    exigeantes = [s2["name"] for s2 in structures
                  if any(v > 1 for v in s2["requiredLevels"].values())]
    print(f"  {len(exigeantes)} construction(s) exigeant un niveau > 1"
          + (f" : {', '.join(exigeantes)}" if exigeantes else ""))
    if unknown:
        print("  ⚠ Compétences non reconnues :", ", ".join(sorted(unknown)))
    return structures


def previous_pal_names():
    """Noms des Pals du docs/data.js **actuel** (avant réécriture), ou None si absent.

    Sert à dater le diff : on compare la génération qui va être écrite à celle qui est
    encore sur le disque. Un data.js illisible n'est pas une erreur — on renonce
    simplement au diff plutôt que de faire échouer le build.
    """
    if not STATIC_OUT.exists():
        return None
    try:
        txt = STATIC_OUT.read_text(encoding="utf-8")
        m = re.search(r"window\.PAL_DATA = (\{.*\});", txt, re.S)
        if not m:
            return None
        return [p["name"] for p in json.loads(m.group(1)).get("pals", [])]
    except Exception as exc:
        print(f"  ⚠ docs/data.js précédent illisible ({exc}) — pas de changelog.")
        return None


def build_changelog(pals):
    """Écrit data/changelog.json : Pals ajoutés / retirés depuis le build précédent."""
    before = previous_pal_names()
    now = [p["name"] for p in pals]
    if before is None:
        added, removed, known = [], [], False
    else:
        known = True
        added = sorted(set(now) - set(before))
        removed = sorted(set(before) - set(now))
    data = {
        "generatedAt": datetime.datetime.now(datetime.timezone.utc)
                               .replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "comparedToPrevious": known,   # false au tout premier build
        "totalBefore": len(before) if known else None,
        "totalAfter": len(now),
        "added": added,
        "removed": removed,
    }
    CHANGELOG_OUT.parent.mkdir(exist_ok=True)
    CHANGELOG_OUT.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    if not known:
        print("Changelog : aucune génération précédente à comparer.")
    elif added or removed:
        print(f"Changelog : +{len(added)} / -{len(removed)} Pal(s)")
    else:
        print("Changelog : aucun Pal ajouté ni retiré.")
    return data


def build_static(pals, structures, unique_combos, recipes, passives):
    """Écrit docs/data.js : données embarquées pour la version statique (GitHub Pages)."""
    data = {"workTypes": WORK_TYPES, "pals": pals, "structures": structures,
            "uniqueCombos": unique_combos, "recipes": recipes["recipes"],
            "producedBy": recipes["producedBy"], "rawItems": recipes["rawItems"],
            "passives": passives["passives"], "passiveCategories": passives["categoryLabels"],
            "passiveSources": passives["sourceLabels"],
            "passiveCodes": passives["codeTable"]}
    js = "// Généré par build_data.py — ne pas éditer à la main.\n"
    js += "window.PAL_DATA = " + json.dumps(data, ensure_ascii=False) + ";\n"
    STATIC_OUT.parent.mkdir(exist_ok=True)
    STATIC_OUT.write_text(js, encoding="utf-8")
    print(f"Données embarquées écrites dans {STATIC_OUT}")


def _index_codes(passives):
    """Attache à chaque passif les codes de sauvegarde qui le désignent.

    La liaison est une LISTE et non un champ simple : rien n'interdit à deux codes de
    sauvegarde de désigner le même passif, et n'en garder qu'un ferait disparaître la
    moitié des Pals concernés du décompte. Aucun cas dans la table actuelle, mais la
    structure ne coûte rien et le jour où il y en aura un, il sera compté.
    """
    par_nom = {p["name"]: p for p in passives["passives"]}
    orphelins = []
    for code, nom in passives["codeTable"].items():
        p = par_nom.get(nom)
        if p is None:
            orphelins.append((code, nom))
            continue
        p.setdefault("codes", []).append(code)
    if orphelins:
        print(f"  ⚠ {len(orphelins)} code(s) nommé(s) sans passif correspondant : "
              f"{', '.join(n for _, n in orphelins[:4])}")
    couverts = sum(1 for p in passives["passives"] if p.get("codes"))
    print(f"  {couverts}/{len(passives['passives'])} passifs reliés à un code de boîte")


def publish_spawns(spawns):
    """Copie les apparitions dans docs/. Fichier à part, servi à la demande."""
    SPAWNS_OUT.parent.mkdir(parents=True, exist_ok=True)
    SPAWNS_OUT.write_text(json.dumps(spawns, ensure_ascii=False, separators=(",", ":")),
                          encoding="utf-8")
    print(f"Apparitions écrites dans {SPAWNS_OUT} "
          f"({SPAWNS_OUT.stat().st_size // 1024} Ko)")


def stamp_service_worker():
    """Aligne la version du cache du service worker sur le commit courant.

    Oublier de changer CACHE laissait les visiteurs sur un shell périmé ; le hash git
    change à chaque commit, donc la bonne valeur est toujours posée automatiquement.
    En cas d'échec (hors dépôt git, git absent), on laisse le fichier tel quel plutôt
    que d'écrire une version bidon.
    """
    try:
        rev = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=BASE_DIR,
                             capture_output=True, text=True, timeout=10)
        if rev.returncode != 0:
            raise RuntimeError((rev.stderr or "").strip() or "git a échoué")
        sha = rev.stdout.strip()
        if not re.fullmatch(r"[0-9a-f]{6,40}", sha):
            raise RuntimeError(f"hash inattendu : {sha!r}")
    except Exception as exc:
        print(f"  ⚠ Version du service worker inchangée ({exc}).")
        return

    src = SW_OUT.read_text(encoding="utf-8")
    new, n = re.subn(r'const CACHE = "[^"]*";', f'const CACHE = "pw-{sha}";', src, count=1)
    if not n:
        print("  ⚠ Déclaration CACHE introuvable dans docs/sw.js — version inchangée.")
        return
    if new != src:
        SW_OUT.write_text(new, encoding="utf-8")
    print(f"Service worker : CACHE = pw-{sha}")


if __name__ == "__main__":
    pals = build_pals()
    structures = build_structures()
    unique_combos = merge_breeding(pals)
    recipes = merge_recipes(structures)
    passives = load_passives()
    # Codes de sauvegarde -> nom : c'est ce qui rend lisibles les passifs d'une boîte
    # importée. Chaque passif reçoit la liste des codes qui le désignent.
    passives["codeTable"] = load_code_table()
    _index_codes(passives)
    spawns = load_spawns(pals)
    build_changelog(pals)        # avant build_static : compare au docs/data.js encore en place
    build_static(pals, structures, unique_combos, recipes, passives)
    publish_spawns(spawns)
    stamp_service_worker()
