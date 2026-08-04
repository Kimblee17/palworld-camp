"""
Récupère le catalogue des compétences passives depuis paldb.cc.

⚠ SOURCE DIFFÉRENTE DU RESTE DU PIPELINE, comme pour l'appétit (fetch_pal_food.py).
palworld.gg ne rend côté serveur que 60 passifs, tous positifs et de rang 3 à 5 : ses
communs et ses négatifs sont chargés en JavaScript et restent hors de portée. paldb.cc
publie les 412, avec un rang SIGNÉ qui donne la polarité sans interprétation.

NOMS FRANÇAIS : paldb publie la même page en neuf langues, engendrée à partir de la
même liste et DANS LE MÊME ORDRE. La correspondance se fait donc par position, ce qui
n'est pas une conjecture mais un fait vérifié à chaque exécution (`_aligner`) :
  - même nombre de cartes ;
  - même rang à chaque position, 412 fois sur 412 ;
  - jamais deux codes internes différents à la même position.
Contrôle indépendant fait une fois à la main : les 60 passifs que palworld.gg rend en
clair ont, dans ses versions FR et EN, une signature d'effet chiffrée identique ;
sur les 29 dont cette signature est unique, les 29 traductions concordent avec paldb,
zéro désaccord. L'appariement positionnel entre les deux LISTES de palworld.gg, lui,
reste faux — chaque langue y est triée alphabétiquement.

Ce que paldb fournit par passif :
  - `rank`   : entier signé de -3 à +5. Le SIGNE porte la polarité, la VALEUR la rareté.
  - `weight` : poids de tirage aléatoire (100 courant, 5 rare, 0 jamais au hasard).
  - `badges` : Pal / RarePal / Armor / Accessory — sert à écarter l'équipement.
  - `code`   : identifiant interne du jeu, présent seulement quand un implant existe.

Cache : data/passives.json. Lançable seul :  python fetch_passives.py
"""
import html as H
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
CACHE = BASE_DIR / "data" / "passives.json"
URL = "https://paldb.cc/{lang}/Passive_Skills"

# Les deux langues dont on lit les NOMS. Un échec ici est fatal.
LANGUES_NOM = ("en", "fr")
# Langues d'appoint dont on ne prend QUE le code interne, jamais un libellé. paldb
# n'affiche le lien vers l'implant que si l'objet est traduit dans la langue lue :
# aucune page ne les a tous, l'union en donne 35 contre 30 pour l'anglais seul. Un
# échec ici n'est pas fatal — on y perd quelques codes, pas une donnée affichée.
LANGUES_CODE = ("de", "es", "it", "ja", "ko", "ru")


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
# ⚠ Les motifs sont ANGLAIS et le restent : la catégorisation se fait sur le texte
# anglais, seul stable, même quand l'affichage est français.
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


# Passifs qu'on peut se procurer autrement qu'au hasard. Table RELEVÉE EN JEU par
# l'utilisateur, pas collectée : aucune des deux sources ne publie ces inventaires.
#
# Elle est EXHAUSTIVE, et c'est ce qui la rend exploitable : le jeu ne compte qu'un
# marchand et qu'un chasseur de primes, et voici tout ce qu'ils vendent. Les 79 autres
# passifs ne s'obtiennent qu'au hasard sur un Pal. Les données corroborent : aucun des
# 79 n'a un poids de tirage nul (60 courants, 19 rares), donc aucun n'est hors
# d'atteinte du hasard — la table et le catalogue ne se contredisent pas.
#
# Clé = nom FRANÇAIS, celui que l'utilisateur lit dans le jeu. Toute entrée qui ne
# retrouve pas exactement un passif fait échouer la collecte (cf. `_provenances`) :
# un libellé retouché en amont doit se voir, pas disparaître en silence.
SOURCES = {
    "chasseur": ["Impulsif", "Corps Robuste", "Appliqué", "Chef d'Assaut",
                 "Stratège de Forteresse", "Motivateur", "Guide de l'effort"],
    "marchand": ["Infatigable", "Coursier", "Coursier Marin", "Noble",
                 "Instructeur de Tir", "Sérénité", "Ange Médecin"],
}
SOURCE_LABELS = {"chasseur": "Chasseur de primes", "marchand": "Marchand"}


def _provenances(passifs):
    """Nom français -> provenance, après contrôle que chaque nom désigne bien un passif."""
    index = {}
    for p in passifs:
        index.setdefault(p["nameFr"], []).append(p)
    out, fautifs = {}, []
    for source, noms in SOURCES.items():
        for nom in noms:
            trouves = index.get(nom, [])
            if len(trouves) != 1:
                fautifs.append(f"{nom} ({len(trouves)} correspondance(s))")
            else:
                out[nom] = source
    if fautifs:
        raise RuntimeError(
            "Table des provenances désynchronisée du catalogue : " + ", ".join(fautifs))
    return out


def categories_de(effet):
    trouvees = [c for c, motifs in CATEGORIES.items()
                if any(m.lower() in effet.lower() for m in motifs)]
    return trouvees or ["autre"]


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return r.read().decode("utf-8", "replace")


# Chaque carte commence à sa bannière de rang ; la suivante en marque la fin. On
# découpe d'abord, on extrait ensuite : c'est ce découpage qui rend les positions
# comparables d'une langue à l'autre.
BANNIERE = re.compile(r'passive_banner_rank(-?\d+)"')
NOM = re.compile(r'passive-rank-?\d+ ps-2 py-1">([^<]+)</div>')
TIP = re.compile(r'data-bs-title="(.*?)"\s*/>', re.S)
EFFET = re.compile(r'<div class="p-2"[^>]*>\s*<div>(.*?)</div><div>', re.S)
# Le code interne n'apparaît que sur les passifs pourvus d'un implant. C'est un lien
# FRÈRE de l'infobulle, pas dedans : le chercher dans la seule infobulle en ratait
# la moitié (Musclehead, Burly Body, Noble…).
CODE_IMPLANT = re.compile(r'PalPassiveSkillChange_([A-Za-z0-9_]+)"')
CODE_LIEN = re.compile(
    r'class="itemname[^"]*passive-rank(-?\d+)"[^>]*data-hover="\?s=PassiveSkills%2F([^"]+)">([^<]+)</a>')
# Garde-fou du dernier bloc, qui court sinon jusqu'au pied de page.
FIN_CARTE = 6000


def _texte(frag):
    return H.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", frag))).strip()


def decouper(h):
    """La page en cartes, dans l'ordre. Une entrée par bannière de rang."""
    bornes = [(m.start(), int(m.group(1))) for m in BANNIERE.finditer(h)]
    cartes = []
    for i, (deb, rang) in enumerate(bornes):
        fin = bornes[i + 1][0] if i + 1 < len(bornes) else min(len(h), deb + FIN_CARTE)
        bloc = h[deb:fin]
        nom, tip, eff = NOM.search(bloc), TIP.search(bloc), EFFET.search(bloc)
        code = CODE_IMPLANT.search(bloc)
        cartes.append({
            "rang": rang,
            "nom": H.unescape(nom.group(1)).strip() if nom else None,
            "tip": H.unescape(tip.group(1)) if tip else "",
            "effet": _texte(eff.group(1)) if eff else "",
            "code": urllib.parse.unquote(code.group(1)) if code else None,
        })
    return cartes


def _aligner(pages):
    """Vérifie que toutes les langues décrivent la même liste, dans le même ordre.

    Si ce contrôle passe, lire le nom français à la position i de la page FR et le nom
    anglais à la position i de la page EN désigne bien le même passif. S'il échoue, la
    page a changé de forme et toute traduction déduite serait fausse : on s'arrête.
    """
    ref_lang, ref = next(iter(pages.items()))
    for lang, cartes in pages.items():
        if len(cartes) != len(ref):
            raise RuntimeError(
                f"Alignement impossible : {len(cartes)} cartes en {lang} contre "
                f"{len(ref)} en {ref_lang} — structure paldb.cc changée ?")
        ecarts = [i for i, (a, b) in enumerate(zip(cartes, ref)) if a["rang"] != b["rang"]]
        if ecarts:
            raise RuntimeError(
                f"Alignement impossible : {len(ecarts)} rangs divergent entre {lang} et "
                f"{ref_lang} (position {ecarts[0]}) — l'ordre des pages a changé.")
    # Le code interne est indépendant de la langue : deux valeurs différentes à la même
    # position signeraient un décalage que l'égalité des rangs n'aurait pas révélé.
    codes = []
    for i in range(len(ref)):
        vus = {c[i]["code"] for c in pages.values() if c[i]["code"]}
        if len(vus) > 1:
            raise RuntimeError(
                f"Alignement impossible : codes contradictoires en position {i} ({vus}).")
        codes.append(vus.pop() if vus else None)
    return codes


def scrape(verbose=True):
    def charger(lang, obligatoire):
        try:
            return lang, decouper(fetch(URL.format(lang=lang)))
        except Exception as exc:
            if obligatoire:
                raise
            if verbose:
                print(f"  ⚠ page {lang} injoignable ({exc}) — quelques codes en moins.")
            return lang, None

    taches = [(l, True) for l in LANGUES_NOM] + [(l, False) for l in LANGUES_CODE]
    with ThreadPoolExecutor(max_workers=4) as pool:
        pages = {l: c for l, c in pool.map(lambda a: charger(*a), taches) if c}

    codes = _aligner(pages)
    en, fr = pages["en"], pages["fr"]

    # Codes glanés dans les liens des autres pages du site, indexés par nom anglais.
    par_nom = {}
    for _, code, nom in CODE_LIEN.findall(fetch(URL.format(lang="en"))):
        par_nom[H.unescape(nom).strip()] = urllib.parse.unquote(code)

    out = []
    for i, c in enumerate(en):
        rang = c["rang"]
        poids = re.search(r"Weight (\d+)", c["tip"])
        badges = [b for b in re.findall(r'badge bg-primary">([^<]+)</span>', c["tip"])
                  if not b.startswith("Weight")]
        code = codes[i] or par_nom.get(c["nom"])
        out.append({
            "name": c["nom"],
            # Le français vient de la MÊME POSITION dans la page FR (cf. _aligner).
            "nameFr": fr[i]["nom"],
            "rank": rang,
            "rarity": rarete(rang),
            "positive": rang > 0,
            "effect": c["effet"],
            "effectFr": fr[i]["effet"],
            "weight": int(poids.group(1)) if poids else None,
            "badges": badges,
            "categories": categories_de(c["effet"] + " " + c["nom"]),
            **({"code": code} if code else {}),
        })

    # Seuls les passifs QUE PEUT PORTER UN PAL nous intéressent : la reproduction ne
    # transmet ni passif d'armure ni passif d'accessoire. Deux familles les identifient :
    #   - badge Pal / RarePal : 86 entrées, à comparer aux 88 codes distincts relevés
    #     dans une boîte de 960 Pals — la convergence valide le filtre ;
    #   - AUCUN badge mais un CODE D'IMPLANT : si l'objet qui pose ce passif existe,
    #     c'est bien sur un Pal qu'on le pose. Sur les 179 cartes sans badge, 12
    #     seulement portent un code — les 7 de l'Arbre-Monde, les 4 de mutation
    #     (Anomalie, Immortel, Baby-sitter, Blindage) et Marche Céleste. Les 167
    #     autres sont des enchantements d'équipement, qui n'ont jamais de code.
    #
    # ⚠ La règle précédente ne rattrapait que le RANG 5, donc l'Arbre-Monde seul. Elle
    # écartait Anomalie et Immortel, que des Pals de la boîte portent pourtant — c'est
    # le croisement code par code avec l'export qui l'a révélé.
    def pour_pal(p):
        return bool(set(p["badges"]) & {"Pal", "RarePal"}) or ("code" in p and not p["badges"])
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

    provenances = _provenances(uniques)
    for p in uniques:
        if p["nameFr"] in provenances:
            p["source"] = provenances[p["nameFr"]]

    if verbose:
        par_rarete = {}
        for p in uniques:
            par_rarete[p["rarity"]] = par_rarete.get(p["rarity"], 0) + 1
        print(f"  {len(out)} passifs lus en {len(pages)} langues, "
              f"{len(equipement)} d'équipement écartés, {len(uniques)} retenus")
        print(f"  répartition : {par_rarete}")
        print(f"  {sum(1 for p in uniques if p['nameFr'] != p['name'])} noms traduits "
              f"(alignement vérifié sur {len(en)} cartes)")
        print(f"  {sum(1 for p in uniques if 'code' in p)} avec code interne "
              f"(le reste bloque le croisement avec la boîte)")
        print(f"  {len(provenances)} avec une provenance connue : "
              + ", ".join(f"{len(v)} {SOURCE_LABELS[k].lower()}" for k, v in SOURCES.items()))
    if len(uniques) < 60:
        raise RuntimeError(f"Seulement {len(uniques)} passifs extraits — structure paldb.cc changée ?")
    manquants = [p["name"] for p in uniques if not p["nameFr"]]
    if manquants:
        raise RuntimeError(f"{len(manquants)} passifs sans nom français : {manquants[:5]}")
    return {"passives": uniques, "categoryLabels": CAT_LABELS,
            "sourceLabels": SOURCE_LABELS}


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
