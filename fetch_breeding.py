"""
Récupère les données de reproduction des Pals depuis palworld.gg.

Deux informations, extraites du même chunk de données que fetch_pal_data.py (on
réutilise sa découverte dynamique, cf. find_dataset_js) :

  - le « breed power » de chaque espèce (combiRank dans les données du jeu), plus les
    champs nécessaires pour reproduire fidèlement le calcul : combiPriority (le champ
    CombiDuplicatePriority du jeu, qui départage les égalités), ignoreCombi (espèce qui
    ne peut pas sortir d'un œuf par la règle générale) et isBoss ;
  - les combinaisons UNIQUES : des paires parent+parent dont l'enfant est imposé et
    déroge à la règle générale (ex. Fuack × Flambelle -> Fuack Ignis). Certaines
    portent une contrainte de sexe (ga/gb).

La matrice complète des paires n'est PAS produite : elle se recalcule côté client à
partir du breed power (cf. docs/js/breeding.js), ce qui évite d'embarquer ~45 000
combinaisons dans docs/data.js.

Utilisé par build_data.py (load_breeding) ; le cache data/breeding.json sert de repli
hors-ligne. Lançable seul pour rafraîchir le cache :  python fetch_breeding.py
"""
import json
import os
import re
from pathlib import Path

from fetch_pal_data import find_dataset_js, _OBJ_START

BASE_DIR = Path(__file__).parent
# En intégration continue on veut un échec franc : le repli silencieux sur le cache
# masquerait un scraping cassé et publierait indéfiniment des données périmées.
STRICT = os.getenv("PALWORLD_STRICT_FETCH") == "1"
CACHE = BASE_DIR / "data" / "breeding.json"

_COMBO = re.compile(
    r'\{a:"([^"]+)",b:"([^"]+)",child:"([^"]+)"'
    r'(?:,ga:"([^"]*)")?(?:,gb:"([^"]*)")?\}'
)


def _grp(s, pat, cast=str):
    m = re.search(pat, s)
    return cast(m.group(1)) if m else None


def parse_breeding(js):
    """Extrait {species: {...}, combos: [...]} du chunk de données."""
    species, combos, by_id = {}, {}, {}
    starts = [m.start() for m in _OBJ_START.finditer(js)]
    for i, pos in enumerate(starts):
        end = starts[i + 1] if i + 1 < len(starts) else min(pos + 6000, len(js))
        s = js[pos:end]
        name = _grp(s, r'name:"([^"]*)"')
        pid = _grp(s, r'^\{id:"([a-z0-9_]+)"')
        if not name or not pid:
            continue
        by_id[pid] = name
        species[name] = {
            "id": pid,
            # ⚠ NOTATION EXPONENTIELLE. Le bundle écrit les rangs ronds en notation
            # JavaScript : `combiRank:3e3`. Un `(\d+)` n'y lisait que « 3 », soit un
            # rang 1000 fois trop petit — Depresso passait de 3000 à 3, et le
            # calculateur en tirait des couples faux (Depresso × Ophydia « donnait »
            # Aegidron). Il faut donc accepter le point et l'exposant, puis arrondir.
            "breedPower": _grp(s, r",combiRank:([0-9.e+]+)", lambda v: int(float(v))),
            "combiPriority": _grp(s, r",combiPriority:([0-9.e+]+)", float),
            "ignoreCombi": ",ignoreCombi:!0" in s,
            "isBoss": ",isBoss:!0" in s,
        }
        # Chaque Pal liste TOUTES les combos où il figure (parent ou enfant) : on
        # déduplique sur (a, b, enfant, sexes) pour obtenir la liste globale.
        block = re.search(r"combos:\[(.*?)\]", s, re.S)
        if block:
            for a, b, child, ga, gb in _COMBO.findall(block.group(1)):
                combos[(a, b, child, ga or "", gb or "")] = {
                    "a": a, "b": b, "child": child,
                    **({"ga": ga} if ga else {}), **({"gb": gb} if gb else {}),
                }

    # Combos exprimés en noms d'espèce (lisible, et c'est la clé commune avec nos CSV).
    out_combos = []
    for c in combos.values():
        if all(k in by_id for k in (c["a"], c["b"], c["child"])):
            out_combos.append({
                "a": by_id[c["a"]], "b": by_id[c["b"]], "child": by_id[c["child"]],
                **({"ga": c["ga"]} if "ga" in c else {}),
                **({"gb": c["gb"]} if "gb" in c else {}),
            })
    out_combos.sort(key=lambda c: (c["child"], c["a"], c["b"]))
    return {"species": species, "uniqueCombos": out_combos}


def scrape(verbose=True):
    data = parse_breeding(find_dataset_js(verbose=verbose))
    if not data["species"]:
        raise RuntimeError("Aucune espèce extraite du chunk de données.")
    # Garde-fou contre une troncature silencieuse : dans ce jeu de données les rangs
    # sont des multiples de 10 et le plus petit vaut 10. Une valeur en dessous trahit
    # une notation exponentielle mal lue, et fausserait tout le calculateur sans
    # qu'aucune erreur ne se manifeste.
    trop_petits = {n: v["breedPower"] for n, v in data["species"].items()
                   if v["breedPower"] is not None and v["breedPower"] < 10}
    if trop_petits:
        raise RuntimeError(
            f"Rangs de reproduction implausibles (< 10) : {trop_petits} — "
            "la notation exponentielle du bundle est probablement mal lue.")
    if verbose:
        n_ign = sum(1 for v in data["species"].values() if v["ignoreCombi"])
        print(f"  {len(data['species'])} espèces ({n_ign} hors résultat générique), "
              f"{len(data['uniqueCombos'])} combinaisons uniques")
    return data


def load_breeding(cache=CACHE, verbose=True):
    """Données de reproduction pour build_data : fetch live + cache, repli si réseau KO."""
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
            f"Téléchargement des données de reproduction impossible et aucun cache ({cache})."
        ) from exc


if __name__ == "__main__":
    load_breeding()
    print(f"\nCache écrit dans {CACHE}")
