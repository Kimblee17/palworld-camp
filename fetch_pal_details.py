"""
Récupère, pour chaque espèce, ce que paldb.cc publie et que palworld.gg ne donne pas :
son APPÉTIT (FoodAmount) et sa COMPÉTENCE DE PARTENAIRE.

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

Les deux viennent de la MÊME page, donc de la même requête : 300 fiches en tout, pas
600. C'est la raison d'être de ce module unique — deux collecteurs séparés doubleraient
la charge sur une source qui nous rend déjà service.

⚠ PAGES FRANÇAISES, contrairement au reste du pipeline qui cible l'anglais. La
compétence de partenaire est une PHRASE, lue par l'utilisateur : « Bouclier Duveteux —
s'équipe au joueur et sert de bouclier ». L'appétit, lui, est un nombre : il est
identique d'une langue à l'autre (vérifié sur Lamball, 1 en `en` comme en `fr`), donc
rien n'est perdu à basculer. Les NOMS DE PALS restent anglais : ce sont eux qui servent
de clé partout ailleurs, et le slug de l'URL est le même dans toutes les langues.

Cache : data/pal-details.json. Lançable seul :  python fetch_pal_details.py
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
CACHE = BASE_DIR / "data" / "pal-details.json"
BASE_URL = "https://paldb.cc/fr/"

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
# Le bloc de compétence s'ouvre sur un lien vers Partner_Skill. On s'accroche à ce
# href et non au libellé : il est identique dans toutes les langues, là où le titre
# affiché change (« Compétences partenaires », « Partner Skill »…).
_PS_ANCRE = re.compile(r'href="Partner_Skill"')
_PS_NOM = re.compile(r'border-left: solid white"><span class="ms-2">([^<]+)</span>')
_PS_DESC = re.compile(r'<div class="flex-grow-1 ms-2">(.*?)</div>', re.S)


def slug_for(name):
    return SLUG_ALIASES.get(name) or urllib.parse.quote(name.replace(" ", "_"))


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=45) as r:
        return r.read().decode("utf-8", "replace")


def _texte(frag):
    return H.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", frag))).strip()


def parse_fiche(html):
    """Appétit et compétence de partenaire, lus dans l'onglet ACTIF.

    Les onglets « <Nom>(cache - N) » sont d'anciennes révisions aux valeurs parfois
    différentes (Lamball : appétit 1 en actif, 2 en cache). On ne lit que l'actif.
    """
    m = _PANE.search(html)
    zone = html[m.end():] if m else html
    f = _FOOD.search(zone)
    food = int(f.group(1)) if f else None

    partner = None
    a = _PS_ANCRE.search(zone)
    if a:
        bloc = zone[a.end(): a.end() + 3000]
        nom, desc = _PS_NOM.search(bloc), _PS_DESC.search(bloc)
        if nom and desc:
            partner = {"nom": H.unescape(nom.group(1)).strip(), "desc": _texte(desc.group(1))}
    return food, partner


def details_for(name):
    # Une seconde tentative : sur 300 requêtes, un échec réseau isolé est banal, et
    # sans cela il effacerait silencieusement les données d'un Pal (vécu sur
    # « Zoe & Grizzbolt », dont l'appétit a disparu d'un build à l'autre).
    for _ in range(2):
        try:
            food, partner = parse_fiche(fetch(BASE_URL + slug_for(name)))
            if food is not None or partner is not None:
                return name, {"food": food, "partner": partner}
        except Exception:
            pass
    return name, None


def scrape(names, verbose=True):
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        res = dict(pool.map(details_for, names))
    trouves = {n: v for n, v in res.items() if v is not None}
    manquants = sorted(n for n, v in res.items() if v is None)
    if verbose:
        vals = sorted(v["food"] for v in trouves.values() if v["food"] is not None)
        avec_ps = sum(1 for v in trouves.values() if v["partner"])
        print(f"  {len(trouves)}/{len(names)} fiches lues"
              + (f", appétits de {vals[0]} à {vals[-1]}" if vals else "")
              + f", {avec_ps} compétence(s) de partenaire")
        if manquants:
            print(f"  ⚠ {len(manquants)} sans fiche : {', '.join(manquants[:8])}"
                  f"{'…' if len(manquants) > 8 else ''}")
    if len(trouves) < MIN_COVERAGE * len(names):
        raise RuntimeError(
            f"Fiches lues pour {len(trouves)}/{len(names)} Pals seulement "
            f"(seuil {MIN_COVERAGE:.0%}) — structure de paldb.cc changée ?")
    return trouves


def load_pal_details(names, cache=CACHE, verbose=True):
    """Appétit + compétence de partenaire : fetch live, repli sur cache si réseau KO."""
    ancien = {}
    if cache.exists():
        try:
            ancien = json.loads(cache.read_text(encoding="utf-8"))
        except Exception:
            ancien = {}
    try:
        data = scrape(names, verbose=verbose)
        # On FUSIONNE avec le cache au lieu de le remplacer : un Pal absent de cette
        # passe (page injoignable) garde la valeur déjà connue. Un scraping cassé se
        # signale par le seuil MIN_COVERAGE, pas en effaçant des données valides.
        conserves = [n for n in ancien if n not in data and n in set(names)]
        if conserves and verbose:
            print(f"  ↳ {len(conserves)} fiche(s) reprise(s) du cache : "
                  f"{', '.join(sorted(conserves)[:5])}{'…' if len(conserves) > 5 else ''}")
        fusion = {**{n: v for n, v in ancien.items() if n in set(names)}, **data}
        cache.parent.mkdir(exist_ok=True)
        cache.write_text(json.dumps(fusion, ensure_ascii=False, indent=2, sort_keys=True),
                         encoding="utf-8")
        return fusion
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
    load_pal_details([p["name"] for p in pals])
    print(f"\nCache écrit dans {CACHE}")
