"""
Ajoute les nouveaux Pals de Palworld 1.0 (présents dans les tier-lists mais absents
de "Liste pals.csv") en scrapant leurs compétences de travail (échelle 1–10) sur la
fiche palworld.gg (/pal/<slug>) -> nouvelles lignes de "Liste pals.csv".

Icônes ET éléments ne sont plus gérés ici : ils dérivent des champs `code` / `elements`
ajoutés à chaque Pal par build_data.py (depuis le dataset palworld.gg).
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

WORK_BLOCK = re.compile(
    r'<div class="name">([^<]+)</div></div><div class="level">'
    r'<span class="text">Lv</span><span[^>]*>(\d+)</span>'
)


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")


def scrape(slug):
    """Renvoie {id_compétence: niveau} ou None si la fiche est absente."""
    try:
        html = fetch("https://palworld.gg/pal/" + slug)
    except Exception:
        return None
    work = {}
    for wname, lvl in WORK_BLOCK.findall(html):
        wid = WORKNAME_TO_ID.get(wname.strip())
        if wid:
            work[wid] = int(lvl)
    return work


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

    added, no_work, not_found = 0, [], []
    for i, name in enumerate(missing, 1):
        slug = name2slug[name]
        work = scrape(slug)
        if work is None:
            not_found.append(f"{name} ({slug})"); continue
        row = {c: "" for c in fields}
        row["Nom"] = name
        for wid, col in ID_TO_COL.items():
            row[col] = str(work.get(wid, 0))
        row[NIGHT_COL] = "Non"
        rows.append(row)
        if not work: no_work.append(name)
        added += 1
        if i % 20 == 0:
            print(f"  … {i}/{len(missing)}")
        time.sleep(0.2)

    # Écriture CSV : IMPORTANT — ne pas trier. Les Pals sont référencés par `id` = ordre
    # des lignes (camps/boîtes sauvegardés). On préserve l'ordre existant et on ajoute les
    # nouveaux à la fin pour ne pas décaler les id des Pals déjà présents.
    with CSV_PATH.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, delimiter=";")
        w.writeheader()
        w.writerows(rows)

    print(f"\n{added} Pals ajoutés au CSV ({len(rows)} au total).")
    if no_work:   print(f"  ⚠ {len(no_work)} sans compétence trouvée : {', '.join(no_work)}")
    if not_found: print(f"  ⚠ {len(not_found)} fiches introuvables : {', '.join(not_found)}")


if __name__ == "__main__":
    main()
