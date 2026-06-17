"""
Génère les données de l'application depuis les fichiers CSV :
  - data/pals.json + data/structures.json   (utilisés par la version Flask, app.py)
  - docs/data.js                            (données embarquées pour la version statique)

Les rangs de tier-list (palworld.gg) sont fusionnés dans chaque Pal de pals.json
via fetch_tier_lists.load_tier_lists (téléchargement live + cache de repli).

Relance ce script après avoir modifié un CSV :  python build_data.py
"""
import csv
import json
from pathlib import Path

from fetch_tier_lists import load_tier_lists

BASE_DIR = Path(__file__).parent
PALS_CSV = BASE_DIR / "Liste pals.csv"
STRUCT_CSV = BASE_DIR / "palworld-structures.csv"
PALS_OUT = BASE_DIR / "data" / "pals.json"
STRUCT_OUT = BASE_DIR / "data" / "structures.json"
STATIC_OUT = BASE_DIR / "docs" / "data.js"

# Définition centralisée des 12 compétences de travail (source unique de vérité).
# Utilisée par app.py (import) et par la version statique (docs/data.js).
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
                entry = index.setdefault(_norm(p["name"]), {"tiers": {}, "mountSpeed": {}})
                entry["tiers"][category] = tier
                if "speed" in p:
                    # flyingMount -> flying, groundMount -> ground
                    entry["mountSpeed"][category.replace("Mount", "").lower()] = p["speed"]
    return index


def build_pals():
    tier_index = index_tiers(load_tier_lists())
    all_categories = list(TIER_CATEGORIES.values())

    pals = []
    matched = set()
    with PALS_CSV.open(encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f, delimiter=";")
        for i, row in enumerate(reader, start=1):
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
            if info and info["mountSpeed"]:
                pal["mountSpeed"] = info["mountSpeed"]
            pals.append(pal)

    PALS_OUT.parent.mkdir(exist_ok=True)
    PALS_OUT.write_text(json.dumps(pals, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"{len(pals)} Pals écrits dans {PALS_OUT}")

    no_tier = [p["name"] for p in pals if all(v is None for v in p["tiers"].values())]
    if no_tier:
        print(f"  ⚠ {len(no_tier)} Pal(s) sans aucun rang de tier-list : {', '.join(no_tier)}")
    unused = set(tier_index) - matched
    if unused:
        print(f"  ⚠ {len(unused)} Pal(s) de tier-list non présents dans le CSV (ignorés).")
    return pals


def build_structures():
    structures = []
    unknown = set()
    with STRUCT_CSV.open(encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f, delimiter=";")
        for i, row in enumerate(reader, start=1):
            name = (row.get("Nom (FR)") or "").strip()
            if not name:
                continue
            requires = []
            for part in (row.get("Compétences requises") or "").split(","):
                key = part.strip()
                if not key:
                    continue
                wid = LABEL_TO_WORK.get(key)
                if wid is None:
                    unknown.add(key)
                elif wid not in requires:
                    requires.append(wid)
            structures.append({
                "id": i,
                "name": name,
                "category": (row.get("Catégorie") or "").strip(),
                "requires": requires,
            })
    STRUCT_OUT.parent.mkdir(exist_ok=True)
    STRUCT_OUT.write_text(json.dumps(structures, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"{len(structures)} structures écrites dans {STRUCT_OUT}")
    if unknown:
        print("  ⚠ Compétences non reconnues :", ", ".join(sorted(unknown)))
    return structures


def build_static(pals, structures):
    """Écrit docs/data.js : données embarquées pour la version statique (GitHub Pages)."""
    data = {"workTypes": WORK_TYPES, "pals": pals, "structures": structures}
    js = "// Généré par build_data.py — ne pas éditer à la main.\n"
    js += "window.PAL_DATA = " + json.dumps(data, ensure_ascii=False) + ";\n"
    STATIC_OUT.parent.mkdir(exist_ok=True)
    STATIC_OUT.write_text(js, encoding="utf-8")
    print(f"Données embarquées écrites dans {STATIC_OUT}")


if __name__ == "__main__":
    pals = build_pals()
    structures = build_structures()
    build_static(pals, structures)
