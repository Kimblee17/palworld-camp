"""
Ajoute les nouveaux Pals de Palworld 1.0 (présents dans les tier-lists mais absents
de "Liste pals.csv") en scrapant leur fiche palworld.gg (/pal/<slug>) :
  - compétences de travail (échelle 1–10)  -> nouvelles lignes de Liste pals.csv
  - élément(s)                             -> docs/pal-elements.js
  - nom de code interne (icône)            -> docs/pal-icons.js

Le statut « Travailleur de nuit » n'est pas exposé par palworld.gg -> "Non" par défaut.

Relançable :  python fetch_new_pals.py
"""
import csv
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

BASE = Path(__file__).parent
CSV_PATH = BASE / "Liste pals.csv"
TIERS_JSON = BASE / "data" / "tier-lists.json"
ICONS_JS = BASE / "docs" / "pal-icons.js"
ELEMENTS_JS = BASE / "docs" / "pal-elements.js"

# Nom de compétence palworld.gg -> identifiant interne.
WORKNAME_TO_ID = {
    "Kindling": "kindling", "Watering": "watering", "Planting": "planting",
    "Generating Electricity": "electricity", "Handiwork": "handiwork",
    "Gathering": "gathering", "Deforesting": "lumbering", "Lumbering": "lumbering",
    "Mining": "mining", "Medicine Production": "medicine", "Cooling": "cooling",
    "Transporting": "transporting", "Farming": "farming",
}
# identifiant interne -> colonne (FR) du CSV
ID_TO_COL = {
    "farming": "Élevage", "electricity": "Électricité", "kindling": "Allumage",
    "gathering": "Récolte", "transporting": "Transport", "planting": "Plantation",
    "watering": "Arrosage", "medicine": "Médicaments", "handiwork": "Travail manuel",
    "mining": "Minage", "lumbering": "Bûcheronnage", "cooling": "Refroidissement",
}
NIGHT_COL = "Travailleur de nuit"

# Nom d'élément palworld.gg -> nom d'élément de l'app (ELEMENT_META).
ELEMENT_MAP = {
    "Normal": "Neutral", "Fire": "Fire", "Water": "Water", "Electricity": "Electric",
    "Ice": "Ice", "Earth": "Ground", "Dark": "Dark", "Dragon": "Dragon", "Leaf": "Grass",
}

WORK_BLOCK = re.compile(
    r'<div class="name">([^<]+)</div></div><div class="level">'
    r'<span class="text">Lv</span><span[^>]*>(\d+)</span>'
)


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")


def scrape(slug, name):
    """Renvoie (work{}, elements[], codename|None) ou None si la fiche est absente."""
    try:
        html = fetch("https://palworld.gg/pal/" + slug)
    except Exception:
        return None
    work = {}
    for wname, lvl in WORK_BLOCK.findall(html):
        wid = WORKNAME_TO_ID.get(wname.strip())
        if wid:
            work[wid] = int(lvl)
    # éléments : bloc hero uniquement (jusqu'à la section "about")
    m = re.search(r'<div class="elements">(.*?)<div class="about">', html, re.S)
    seg = m.group(1) if m else ""
    elements, seen = [], set()
    for raw in re.findall(r'alt="([A-Za-z]+) element"', seg):
        e = ELEMENT_MAP.get(raw, raw)
        if e not in seen:
            seen.add(e); elements.append(e)
    # code interne : l'img dont l'attribut alt == nom du Pal
    cm = re.search(r'alt="' + re.escape(name) + r'"\s+src="[^"]*full_palicon/T_([A-Za-z0-9_]+)_icon_normal', html)
    if not cm:  # repli : premier full_palicon de la page
        cm = re.search(r'full_palicon/T_([A-Za-z0-9_]+)_icon_normal', html)
    codename = cm.group(1) if cm else None
    return work, elements, codename


def load_js_object(path, var):
    """Extrait l'objet JSON de `window.<var> = {...};`."""
    txt = path.read_text(encoding="utf-8")
    m = re.search(r"window\." + var + r"\s*=\s*(\{[^{}]*\});", txt, re.S)
    return json.loads(m.group(1)) if m else {}


def main():
    tl = json.loads(TIERS_JSON.read_text(encoding="utf-8"))
    name2slug = {}
    for cat in tl.values():
        for arr in cat.get("tiers", {}).values():
            for e in arr:
                name2slug.setdefault(e["name"], e["slug"])

    with CSV_PATH.open(encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f, delimiter=";")
        fields = reader.fieldnames
        rows = list(reader)
    existing = {(r.get("Nom") or "").strip() for r in rows}

    missing = sorted(n for n in name2slug if n not in existing)
    print(f"{len(missing)} Pals à ajouter.")

    icons = load_js_object(ICONS_JS, "PAL_ICONS")
    elements_map = load_js_object(ELEMENTS_JS, "PAL_ELEMENTS")

    added, no_work, no_el, no_icon, not_found = 0, [], [], [], []
    for i, name in enumerate(missing, 1):
        slug = name2slug[name]
        res = scrape(slug, name)
        if res is None:
            not_found.append(f"{name} ({slug})"); continue
        work, els, code = res
        row = {c: "" for c in fields}
        row["Nom"] = name
        for wid, col in ID_TO_COL.items():
            row[col] = str(work.get(wid, 0))
        row[NIGHT_COL] = "Non"
        rows.append(row)
        if not work: no_work.append(name)
        if els: elements_map[name] = els
        else: no_el.append(name)
        if code: icons[name] = code
        else: no_icon.append(name)
        added += 1
        if i % 20 == 0:
            print(f"  … {i}/{len(missing)}")
        time.sleep(0.2)

    # Écriture CSV (rows triées : on garde l'ordre original + nouveaux à la fin, puis tri alpha)
    rows.sort(key=lambda r: (r.get("Nom") or "").lower())
    with CSV_PATH.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, delimiter=";")
        w.writeheader()
        w.writerows(rows)

    # Réécriture pal-icons.js
    icons_sorted = {k: icons[k] for k in sorted(icons)}
    ICONS_JS.write_text(
        "// Nom d'affichage -> nom de code interne Palworld (pour l'icone palworld.gg).\n"
        f"// Genere depuis palworld.wiki.gg + palworld.gg (variantes 1.0). {len(icons_sorted)}/{len(rows)} Pals.\n"
        "window.PAL_ICONS = " + json.dumps(icons_sorted, ensure_ascii=False) + ";\n"
        "window.PAL_ICON_URL = function (name) {\n"
        "  var c = window.PAL_ICONS[name];\n"
        '  return c ? "https://palworld.gg/images/full_palicon/T_" + c + "_icon_normal.png" : null;\n'
        "};\n",
        encoding="utf-8",
    )
    # Réécriture pal-elements.js
    el_sorted = {k: elements_map[k] for k in sorted(elements_map)}
    ELEMENTS_JS.write_text(
        f"// Nom -> element(s) (palworld.wiki.gg + palworld.gg pour les Pals 1.0). {len(el_sorted)}/{len(rows)} Pals.\n"
        "window.PAL_ELEMENTS = " + json.dumps(el_sorted, ensure_ascii=False) + ";\n",
        encoding="utf-8",
    )

    print(f"\n{added} Pals ajoutés au CSV ({len(rows)} au total).")
    print(f"  icônes : {len(icons_sorted)} | éléments : {len(el_sorted)}")
    if no_work:   print(f"  ⚠ {len(no_work)} sans compétence trouvée : {', '.join(no_work)}")
    if no_el:     print(f"  ⚠ {len(no_el)} sans élément : {', '.join(no_el)}")
    if no_icon:   print(f"  ⚠ {len(no_icon)} sans icône : {', '.join(no_icon)}")
    if not_found: print(f"  ⚠ {len(not_found)} fiches introuvables : {', '.join(not_found)}")


if __name__ == "__main__":
    main()
