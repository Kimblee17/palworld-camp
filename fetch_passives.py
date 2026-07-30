"""
Récupère le catalogue des compétences passives depuis paldb.cc.

⚠ SOURCE DIFFÉRENTE DU RESTE DU PIPELINE, comme pour l'appétit (fetch_pal_food.py).
palworld.gg ne rend côté serveur que 60 passifs, tous positifs et de rang 3 à 5 : ses
communs et ses négatifs sont chargés en JavaScript et restent hors de portée. paldb.cc
publie les 412, avec un rang SIGNÉ qui donne la polarité sans interprétation.

⚠ NOMS EN ANGLAIS, assumé. Aucune source ne permet de joindre les noms français de
façon fiable :
  - palworld.gg publie 60 noms FR, mais triés par langue : l'appariement positionnel
    avec la liste anglaise est faux (vérifié) ;
  - la jonction par signature numérique des effets ne lève l'ambiguïté que sur 2 des
    60 — trop de passifs partagent « +20 % / -10 % ».
Les noms français viendront de la table code -> nom, remplie à la main (lot B).

Ce que paldb fournit par passif :
  - `rank`   : entier signé de -3 à +5. Le SIGNE porte la polarité, la VALEUR la rareté.
  - `weight` : poids de tirage aléatoire (100 courant, 5 rare, 0 jamais au hasard).
  - `badges` : Pal / RarePal / Armor / Accessory — sert à écarter l'équipement.
  - `code`   : identifiant interne du jeu, présent seulement quand un implant existe
               (21 sur ~90). C'est ce qui bloque le croisement avec la boîte (lot B).

Cache : data/passives.json. Lançable seul :  python fetch_passives.py
"""
import html as H
import json
import os
import re
import urllib.parse
import urllib.request
from pathlib import Path

BASE_DIR = Path(__file__).parent
# En intégration continue on veut un échec franc plutôt qu'un repli silencieux.
STRICT = os.getenv("PALWORLD_STRICT_FETCH") == "1"
CACHE = BASE_DIR / "data" / "passives.json"
URL = "https://paldb.cc/en/Passive_Skills"

# Rang -> rareté d'affichage. Correspondance donnée par l'utilisateur, qui a le jeu
# sous les yeux. Tout rang négatif est « négatif » quelle que soit son amplitude.
def rarete(rang):
    if rang < 0:
        return "negatif"
    if rang >= 4:
        return "arcenciel"
    if rang >= 2:
        return "dore"
    return "commun"


# Effet -> catégorie. Table explicite plutôt qu'une heuristique floue : chaque motif
# est un terme que paldb emploie littéralement. Un passif peut relever de plusieurs
# catégories (Dieu de la Destruction touche l'attaque ET les PV), on les cumule.
CATEGORIES = {
    "combat": ["Attack", "Defense", "Max Health", "Critical", "Shot", "Melee",
               "ActiveSkillCoolTime", "Active skill cooldown"],
    "travail": ["Work Speed", "SAN", "Sanity", "Work Suitability", "Logging",
                "Mining", "Gathering", "Planting", "Handiwork"],
    "monture": ["Movement Speed", "Stamina", "Swim", "Sprint", "Riding"],
    "entretien": ["Hunger", "Stomach", "Satiety", "Food", "Health Regeneration",
                  "Nocturnal", "Nighttime", "Daytime"],
    "element": ["Fire", "Water", "Electricity", "Ice", "Earth", "Dark", "Dragon",
                "Leaf", "Normal", "Cold", "Heat"],
    "autre": [],
}
CAT_LABELS = {
    "combat": "Combat", "travail": "Travail", "monture": "Monture",
    "entretien": "Entretien", "element": "Élément", "autre": "Autre",
}


def categories_de(effet):
    trouvees = [c for c, motifs in CATEGORIES.items()
                if any(m.lower() in effet.lower() for m in motifs)]
    return trouvees or ["autre"]


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return r.read().decode("utf-8", "replace")


# Une carte = bannière (rang + nom) puis infobulle (effets bruts + badges) puis effet lisible.
CARTE = re.compile(
    r'passive_banner_rank(-?\d+)".*?passive-rank-?\d+ ps-2 py-1">([^<]+)</div>'
    r'.*?data-bs-title="(.*?)"\s*/>.*?<div class="p-2"[^>]*>\s*<div>(.*?)</div><div>', re.S)
# Le code interne n'apparaît que sur les passifs pourvus d'un implant.
CODE_IMPLANT = re.compile(r'PalPassiveSkillChange_([A-Za-z0-9_]+)"')
CODE_LIEN = re.compile(
    r'class="itemname[^"]*passive-rank(-?\d+)"[^>]*data-hover="\?s=PassiveSkills%2F([^"]+)">([^<]+)</a>')


def _texte(frag):
    return H.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", frag))).strip()


def scrape(verbose=True):
    h = fetch(URL)

    # Codes internes glanés dans les liens (utiles au lot B, croisement avec la boîte).
    codes = {}
    for _, code, nom in CODE_LIEN.findall(h):
        codes[H.unescape(nom).strip()] = urllib.parse.unquote(code)

    out = []
    for rang, nom, tip, eff in CARTE.findall(h):
        tip = H.unescape(tip)
        nom = H.unescape(nom).strip()
        poids = re.search(r"Weight (\d+)", tip)
        badges = [b for b in re.findall(r'badge bg-primary">([^<]+)</span>', tip)
                  if not b.startswith("Weight")]
        implant = CODE_IMPLANT.search(tip)
        effet = _texte(eff)
        out.append({
            "name": nom,
            "rank": int(rang),
            "rarity": rarete(int(rang)),
            "positive": int(rang) > 0,
            "effect": effet,
            "weight": int(poids.group(1)) if poids else None,
            "badges": badges,
            "categories": categories_de(effet + " " + nom),
            **({"code": codes.get(nom) or implant.group(1)}
               if (codes.get(nom) or implant) else {}),
        })

    # Seuls les passifs QUE PEUT PORTER UN PAL nous intéressent : la reproduction ne
    # transmet ni passif d'armure ni passif d'accessoire. Deux familles les identifient :
    #   - badge Pal / RarePal : 86 entrées, à comparer aux 88 codes distincts relevés
    #     dans une boîte de 960 Pals — la convergence valide le filtre ;
    #   - rang 5 sans badge : les 7 passifs de l'Arbre-Monde, que palworld.gg classe
    #     bien comme une source de Pal.
    def pour_pal(p):
        return bool(set(p["badges"]) & {"Pal", "RarePal"}) or (p["rank"] == 5 and not p["badges"])
    equipement = [p for p in out if not pour_pal(p)]
    pals = [p for p in out if pour_pal(p)]

    # Doublons de nom : paldb répète une carte quand plusieurs implants y mènent.
    vus, uniques = set(), []
    for p in pals:
        if p["name"] in vus:
            continue
        vus.add(p["name"])
        uniques.append(p)
    uniques.sort(key=lambda p: (-p["rank"], p["name"]))

    if verbose:
        par_rarete = {}
        for p in uniques:
            par_rarete[p["rarity"]] = par_rarete.get(p["rarity"], 0) + 1
        print(f"  {len(out)} passifs lus, {len(equipement)} d'équipement écartés, "
              f"{len(uniques)} retenus")
        print(f"  répartition : {par_rarete}")
        print(f"  {sum(1 for p in uniques if 'code' in p)} avec code interne "
              f"(le reste bloque le croisement avec la boîte)")
    if len(uniques) < 60:
        raise RuntimeError(f"Seulement {len(uniques)} passifs extraits — structure paldb.cc changée ?")
    return {"passives": uniques, "categoryLabels": CAT_LABELS}


def load_passives(cache=CACHE, verbose=True):
    """Passifs pour build_data : fetch live + cache, repli sur cache si réseau KO."""
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
            f"Téléchargement des passifs impossible et aucun cache ({cache})."
        ) from exc


if __name__ == "__main__":
    load_passives()
    print(f"\nCache écrit dans {CACHE}")
