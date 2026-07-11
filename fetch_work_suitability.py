"""
Met à jour les compétences de travail (échelle 1–10, Palworld 1.0) dans
"Liste pals.csv" en scrapant les fiches palworld.gg (/pal/<slug>).

palworld.gg 1.0 ne « bake » plus le dataset dans un bundle JS ; on lit donc chaque
fiche : <div class="name">Handiwork</div>…<span>Lv</span><span>6</span>.

Slugs pris dans data/pals.json (récupérés via les tier-lists). Relançable :
    python fetch_work_suitability.py
"""
import csv
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")   # console Windows -> UTF-8 pour les emojis
except Exception:
    pass

BASE = Path(__file__).parent
CSV = BASE / "Liste pals.csv"
PALS_JSON = BASE / "data" / "pals.json"

# Nom de compétence affiché sur palworld.gg -> identifiant interne.
WORKNAME_TO_ID = {
    "Kindling": "kindling", "Watering": "watering", "Planting": "planting",
    "Generating Electricity": "electricity", "Handiwork": "handiwork",
    "Gathering": "gathering", "Deforesting": "lumbering", "Lumbering": "lumbering", "Mining": "mining",
    "Medicine Production": "medicine", "Cooling": "cooling",
    "Transporting": "transporting", "Farming": "farming",
}
# identifiant interne -> colonne (FR) du CSV
ID_TO_COL = {
    "farming": "Élevage", "electricity": "Électricité", "kindling": "Allumage",
    "gathering": "Récolte", "transporting": "Transport", "planting": "Plantation",
    "watering": "Arrosage", "medicine": "Médicaments", "handiwork": "Travail manuel",
    "mining": "Minage", "lumbering": "Bûcheronnage", "cooling": "Refroidissement",
}
WORK_BLOCK = re.compile(
    r'<div class="name">([^<]+)</div></div><div class="level">'
    r'<span class="text">Lv</span><span[^>]*>(\d+)</span>'
)


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")


def scrape_work(slug):
    """Renvoie {id_compétence: niveau} pour un slug, ou None si la fiche est absente."""
    try:
        html = fetch("https://palworld.gg/pal/" + slug)
    except Exception:
        return None
    work, unknown = {}, set()
    for name, lvl in WORK_BLOCK.findall(html):
        wid = WORKNAME_TO_ID.get(name.strip())
        if wid:
            work[wid] = int(lvl)
        else:
            unknown.add(name.strip())
    scrape_work.unknown |= unknown
    return work


scrape_work.unknown = set()


def main():
    slugs = {p["name"]: p.get("slug") for p in json.loads(PALS_JSON.read_text(encoding="utf-8"))}

    with CSV.open(encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f, delimiter=";")
        fields = reader.fieldnames
        rows = list(reader)

    updated, no_slug, not_found, empty = 0, [], [], []
    for i, row in enumerate(rows, 1):
        name = (row.get("Nom") or "").strip()
        slug = slugs.get(name)
        if not slug:
            no_slug.append(name); continue
        work = scrape_work(slug)
        if work is None:
            not_found.append(f"{name} ({slug})"); continue
        if not work:
            empty.append(name)
        # remet à 0 toutes les colonnes puis applique les valeurs scrapées
        for wid, col in ID_TO_COL.items():
            row[col] = str(work.get(wid, 0))
        updated += 1
        if i % 25 == 0:
            print(f"  … {i}/{len(rows)}")
        time.sleep(0.2)

    with CSV.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, delimiter=";")
        w.writeheader()
        w.writerows(rows)

    print(f"\n{updated} Pals mis à jour (1–10) dans {CSV.name}")
    if no_slug:  print(f"  ⚠ {len(no_slug)} sans slug (ignorés) : {', '.join(no_slug)}")
    if not_found: print(f"  ⚠ {len(not_found)} fiches introuvables : {', '.join(not_found)}")
    if empty:    print(f"  ⚠ {len(empty)} Pals sans compétence trouvée : {', '.join(empty)}")
    if scrape_work.unknown:
        print(f"  ⚠ noms de compétence NON MAPPÉS : {', '.join(sorted(scrape_work.unknown))}")


if __name__ == "__main__":
    main()
