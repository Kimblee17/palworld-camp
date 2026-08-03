"""
Récupère les points d'apparition des Pals et les repères de la carte, depuis paldb.cc.

⚠ SOURCE DIFFÉRENTE DU RESTE DU PIPELINE, comme l'appétit et les passifs. palworld.gg
ne publie qu'une image de carte sans coordonnées. paldb sert, pour chaque espèce, la
liste des positions du jeu :  https://paldb.cc/paldex/<code>.json

⚠ AUCUN ASSET DU JEU N'EST REPRIS. On ne prend que des COORDONNÉES — des nombres. Le
fond de carte de l'application est reconstitué à partir de ces mêmes nombres (cf.
`grille_terre`) : les Pals et les ressources n'apparaissant que sur la terre ferme,
leur nuage de points en dessine le littoral. Les tuiles de paldb, elles, sont la
texture de carte extraite du jeu : les republier serait redistribuer l'œuvre de
Pocketpair, et les pointer à distance ferait porter la bande passante à paldb.

CONVERSION DES COORDONNÉES. Le jeu travaille en centimètres dans un repère centré
ailleurs que sur la carte. La transformation est celle de paldb, relue dans leur
map.js pour ne pas la deviner :
    u = (Y - Ymin) / (Ymax - Ymin)                 -> abscisse, 0 à gauche
    v = 1 - (X - Xmin) / (Xmax - Xmin)             -> ordonnée, 0 en haut
Les bornes viennent de `config.landScapeRealPosition{Min,Max}` dans leur fichier de
données. On arrondit à 4 décimales : 1e-4 du monde vaut ~1,4 m en jeu, très en deçà
de la précision utile.

JOUR ET NUIT. `dayTimeLocations` et `nightTimeLocations` sont identiques pour la
plupart des espèces, mais PAS TOUTES : 38 divergent, et ce sont précisément les
nocturnes (Blazehowl Noct, Cawgnito, Daedream…). Un échantillon de deux espèces
m'avait fait conclure l'inverse. On garde donc les deux listes, et seulement quand
elles diffèrent — sinon `nuit` vaut null et l'interface réutilise celle du jour.

FORMAT. Les coordonnées sont des ENTIERS en dix-millièmes (0 à 10000), à plat :
[u1, v1, u2, v2, …]. Un dix-millième vaut ~14 cm en jeu. Les paires en flottants
coûtaient un tiers de plus pour une précision que personne ne peut exploiter.

Cache : data/spawns.json. Lançable seul :  python fetch_spawns.py
"""
import json
import os
import re
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

BASE_DIR = Path(__file__).parent
# En intégration continue on veut un échec franc plutôt qu'un repli silencieux.
STRICT = os.getenv("PALWORLD_STRICT_FETCH") == "1"
CACHE = BASE_DIR / "data" / "spawns.json"
PALDEX = "https://paldb.cc/paldex/{code}.json"
CARTE = "https://paldb.cc/js/map_data_en.js"
ENTETES = {"User-Agent": "Mozilla/5.0", "Referer": "https://paldb.cc/en/Map"}

# 300 fiches : en parallèle pour tenir la minute, sans charger la source.
WORKERS = 6
# Résolution de la grille du littoral. 512 donne un trait d'environ 2,8 km de côté :
# assez fin pour reconnaître les îles, assez grossier pour tenir en quelques dizaines
# de kilo-octets.
GRILLE = 512
# En dessous, la collecte est considérée cassée plutôt qu'incomplète.
MIN_ESPECES = 0.8


def fetch(url):
    req = urllib.request.Request(url, headers=ENTETES)
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8", "replace")


def _blocs(js):
    """Les variables de map_data_en.js, découpées puis lues en JSON."""
    bornes = [(m.group(1), m.end())
              for m in re.finditer(r"(?:^|;)\s*(?:var|let|const)\s+(\w+)\s*=", js)]
    out = {}
    for i, (nom, deb) in enumerate(bornes):
        fin = len(js) if i + 1 == len(bornes) else js.rindex(";", deb, bornes[i + 1][1])
        try:
            out[nom] = json.loads(js[deb:fin].strip().rstrip(";").strip())
        except Exception:
            pass
    return out


class Projection:
    """rpos (centimètres du jeu) -> [u, v] relatifs, comme le fait paldb."""

    def __init__(self, config):
        self.x0 = config["landScapeRealPositionMin"]["X"]
        self.x1 = config["landScapeRealPositionMax"]["X"]
        self.y0 = config["landScapeRealPositionMin"]["Y"]
        self.y1 = config["landScapeRealPositionMax"]["Y"]

    def __call__(self, p):
        u = (p["Y"] - self.y0) / (self.y1 - self.y0)
        v = 1 - (p["X"] - self.x0) / (self.x1 - self.x0)
        return [round(u * 10000), round(v * 10000)]

    def dedans(self, uv):
        return 0 <= uv[0] <= 10000 and 0 <= uv[1] <= 10000


def points_espece(code):
    """Positions d'une espèce, ou None si paldb n'a pas de fiche pour ce code."""
    try:
        d = json.loads(fetch(PALDEX.format(code=code.lower())))
    except Exception:
        return None
    jour = (d.get("dayTimeLocations") or {}).get("Locations") or []
    nuit = (d.get("nightTimeLocations") or {}).get("Locations") or []
    return jour, nuit


def grille_terre(nuages, proj):
    """Le littoral, reconstitué : une cellule occupée dès qu'un point y tombe.

    C'est ce qui permet de se passer de la texture du jeu. Les Pals et les ressources
    n'apparaissent que sur la terre ferme ; à 26 000 points, leur nuage en dessine le
    contour. On dilate ensuite d'un cran (une cellule vide cernée d'au moins trois
    cellules pleines est comblée) pour que la côte se lise comme une masse et non
    comme de la poussière.
    """
    plein = {}
    for uv in nuages:
        c = min(GRILLE - 1, uv[0] * GRILLE // 10000)
        r = min(GRILLE - 1, uv[1] * GRILLE // 10000)
        plein[(r, c)] = min(9, plein.get((r, c), 0) + 1)
    comble = dict(plein)
    for (r, c) in plein:
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                q = (r + dr, c + dc)
                if q in plein or not (0 <= q[0] < GRILLE and 0 <= q[1] < GRILLE):
                    continue
                voisins = sum((q[0] + a, q[1] + b) in plein
                              for a in (-1, 0, 1) for b in (-1, 0, 1))
                if voisins >= 3:
                    comble[q] = comble.get(q, 1)
    plat = []
    for (r, c), v in sorted(comble.items()):
        plat += [r, c, v]
    return plat


def scrape(pals, verbose=True):
    donnees = _blocs(fetch(CARTE))
    for cle in ("config", "fixedDungeon", "regionData"):
        if cle not in donnees:
            raise RuntimeError(f"« {cle} » absent de map_data_en.js — structure changée ?")
    proj = Projection(donnees["config"])

    avec_code = [p for p in pals if p.get("code")]
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        brut = dict(zip((p["name"] for p in avec_code),
                        pool.map(lambda p: points_espece(p["code"]), avec_code)))

    def plat(positions):
        out = []
        for q in positions:
            uv = proj(q)
            if proj.dedans(uv):
                out += uv
        return out

    spawns, sans_fiche, divergents = {}, [], []
    for nom, res in brut.items():
        if res is None:
            sans_fiche.append(nom)
            continue
        jour, nuit = res
        j, n = plat(jour), plat(nuit)
        # `nuit` à null quand les deux listes coïncident : c'est le cas courant, et
        # les dupliquer doublerait le poids du fichier pour rien.
        meme = (j == n)
        if not meme:
            divergents.append(nom)
        spawns[nom] = {"j": j, "n": None if meme else n}

    # Repères fixes : ils servent DEUX fois — comme marqueurs, et comme points de
    # terre supplémentaires pour épaissir le littoral là où peu de Pals apparaissent.
    fixes = [x for x in donnees["fixedDungeon"] if x.get("pos")]
    boss = [{"nom": re.sub(r"<.*", "", x["item"]).strip(), "niveau": x.get("lv"),
             "nuit": x.get("onlyTime") == "Night", "p": proj(x["pos"])}
            for x in fixes if x.get("type") == "Alpha Pal"]

    nuages = [s["j"][i:i + 2] for s in spawns.values() for i in range(0, len(s["j"]), 2)]
    nuages += [uv for uv in (proj(x["pos"]) for x in fixes) if proj.dedans(uv)]
    terre = grille_terre(nuages, proj)

    # Les régions sont données en coordonnées « ipos » ; paldb les projette avec une
    # échelle à part (perPixel), relue dans leur page plutôt que devinée.
    pp = 459
    tx, ty = (proj.x1 - proj.x0) / pp, (proj.y1 - proj.y0) / pp
    sx, sy = 1000 + (-582888 - proj.x0) / pp, 1000 + (-301000 - proj.y0) / pp
    regions = []
    for x in donnees["regionData"]:
        ip = x.get("ipos")
        if not ip:
            continue
        u, v = (ip["X"] + sy) / ty, 1 - (ip["Y"] + sx) / tx
        m = re.match(r"Lv\.([\d-]+)\s*(.*)", x["item"])
        regions.append({"nom": (m.group(2) if m else x["item"]).strip(),
                        "niveaux": m.group(1) if m else None,
                        "p": [round(u * 10000), round(v * 10000)]})

    if verbose:
        avec = sum(1 for s in spawns.values() if s["j"])
        total = sum(len(s["j"]) + len(s["n"] or []) for s in spawns.values()) // 2
        print(f"  {len(spawns)}/{len(avec_code)} espèces interrogées, {avec} avec des "
              f"apparitions sauvages ({total} points)")
        print(f"  {len(divergents)} espèce(s) avec des zones de nuit distinctes")
        print(f"  {len(boss)} boss de terrain, {len(regions)} régions, "
              f"{len(terre) // 3} cellules de littoral")
        if sans_fiche:
            print(f"  ⚠ {len(sans_fiche)} sans fiche paldb : "
                  f"{', '.join(sans_fiche[:6])}{'…' if len(sans_fiche) > 6 else ''}")
    if len(spawns) < MIN_ESPECES * len(avec_code):
        raise RuntimeError(
            f"Seulement {len(spawns)}/{len(avec_code)} espèces résolues "
            f"(seuil {MIN_ESPECES:.0%}) — structure de paldb.cc changée ?")
    return {"spawns": spawns, "boss": boss, "regions": regions,
            "terre": terre, "grille": GRILLE}


def load_spawns(pals, cache=CACHE, verbose=True):
    """Apparitions pour build_data : fetch live + cache, repli sur cache si réseau KO."""
    try:
        data = scrape(pals, verbose=verbose)
        cache.parent.mkdir(exist_ok=True)
        cache.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")),
                         encoding="utf-8")
        return data
    except Exception as exc:
        if STRICT:
            raise
        if cache.exists():
            print(f"  ⚠ Téléchargement impossible ({exc}). Utilisation du cache {cache}.")
            return json.loads(cache.read_text(encoding="utf-8"))
        raise RuntimeError(
            f"Téléchargement des apparitions impossible et aucun cache ({cache})."
        ) from exc


if __name__ == "__main__":
    pals = json.loads((BASE_DIR / "data" / "pals.json").read_text(encoding="utf-8"))
    d = load_spawns(pals)
    print(f"\nCache écrit dans {CACHE} ({CACHE.stat().st_size // 1024} Ko)")
