"""
Récupère les données de jeu des Pals (level, rareté, capture, n° Paldeck) depuis palworld.gg.

Palworld 1.0 : palworld.gg ne « bake » plus le dataset dans un bundle nommé
(pals.<hash>.js). Les données sont désormais un chunk importé paresseusement, un par
langue, référencé dans un bundle sous la forme :
    "../data/pals/en.json":()=>xe(()=>import("./<hash>.js"), ...)
Le chunk contient les Pals comme objets JS lisibles :
    {id:"anubis",key:"Anubis",slug:"anubis",name:"Anubis",...,index:139,rarity:10,
     level:68,captureRate:1,bossCaptureRate:.7,elements:[...],icon:"..."}

On découvre donc dynamiquement : page -> bundles /_nuxt -> chunk "pals/en.json" -> objets.
On cible l'anglais (`en`) pour coller aux noms de "Liste pals.csv".

⚠ `level` = niveau de spawn sauvage ; les Pals sans spawn sauvage (boss/légendaires :
Jetragon, Frostallion, Dandilord…) valent 1. `index` = ZukanIndex (Paldeck 1.0, renuméroté).

Utilisé par build_data.py (load_pal_data) ; le cache data/pal-data.json sert de repli
hors-ligne. Lançable seul pour rafraîchir le cache :  python fetch_pal_data.py
"""
import json
import re
import urllib.request
from pathlib import Path

BASE_DIR = Path(__file__).parent
CACHE = BASE_DIR / "data" / "pal-data.json"
BASE_URL = "https://palworld.gg"

# Pages susceptibles de charger le dataset (on s'arrête à la première qui marche).
SEED_PAGES = ["/capture-rate", "/pals", "/"]
# Langue du dataset à récupérer (noms anglais = ceux du CSV).
LANG = "en"

# rarityTier de palworld.gg : e>10 legendary, e>=8 epic, e>=5 rare, sinon common.
def rarity_category(r):
    if r is None:
        return None
    if r > 10:
        return "Legendary"
    if r >= 8:
        return "Epic"
    if r >= 5:
        return "Rare"
    return "Common"


def fetch(path):
    url = path if path.startswith("http") else BASE_URL + path
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=45) as resp:
        return resp.read().decode("utf-8", "replace")


def find_dataset_js(lang=LANG, verbose=True):
    """Page -> bundles /_nuxt -> chunk importé pour "../data/pals/<lang>.json"."""
    ref = re.compile(r'"\.\./data/pals/' + lang + r'\.json":\(\)=>\w+\(\(\)=>import\("\./([A-Za-z0-9_]+)\.js"')
    tried = set()
    for page in SEED_PAGES:
        try:
            html = fetch(page)
        except Exception:
            continue
        for chunk in sorted(set(re.findall(r"/_nuxt/[A-Za-z0-9_]+\.js", html))):
            if chunk in tried:
                continue
            tried.add(chunk)
            try:
                js = fetch(chunk)
            except Exception:
                continue
            m = ref.search(js)
            if m:
                if verbose:
                    print(f"  dataset : {chunk} -> {m.group(1)}.js")
                return fetch("/_nuxt/" + m.group(1) + ".js")
    raise RuntimeError(
        f"Chunk 'pals/{lang}.json' introuvable (structure palworld.gg changée ?)."
    )


_OBJ_START = re.compile(r'\{id:"[a-z0-9_]+",key:"[A-Za-z0-9_]+",slug:"')


def _grp(s, pat, cast):
    m = re.search(pat, s)
    return cast(m.group(1)) if m else None


def parse_dataset(js):
    """Extrait {nom: {level, rarity, rarityCategory, captureRate, zukan}} du chunk."""
    out = {}
    starts = [m.start() for m in _OBJ_START.finditer(js)]
    for i, pos in enumerate(starts):
        end = starts[i + 1] if i + 1 < len(starts) else min(pos + 3000, len(js))
        s = js[pos:end]
        name = _grp(s, r'name:"([^"]*)"', str)
        if not name:
            continue
        rarity = _grp(s, r",rarity:(\d+),combiRank:", int)
        out[name] = {
            "level": _grp(s, r",level:(\d+),captureRate:", int),
            "rarity": rarity,
            "rarityCategory": rarity_category(rarity),
            "captureRate": _grp(s, r",captureRate:([0-9.]+),bossCaptureRate:", float),
            "zukan": _grp(s, r",index:(\d+),suffix:", int),
        }
    return out


def scrape(verbose=True):
    data = parse_dataset(find_dataset_js(verbose=verbose))
    if verbose:
        print(f"  {len(data)} Pals dans le dataset palworld.gg")
    if not data:
        raise RuntimeError("Aucun Pal extrait du chunk de données.")
    return data


def load_pal_data(cache=CACHE, target_names=None, verbose=True):
    """Données de jeu pour build_data : fetch live + cache, repli sur cache si réseau KO.

    `target_names` est ignoré (compatibilité) : on cible explicitement la langue `en`.
    """
    try:
        data = scrape(verbose=verbose)
        cache.parent.mkdir(exist_ok=True)
        cache.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        return data
    except Exception as exc:
        if cache.exists():
            print(f"  ⚠ Téléchargement impossible ({exc}). Utilisation du cache {cache}.")
            return json.loads(cache.read_text(encoding="utf-8"))
        raise RuntimeError(
            f"Téléchargement des données de Pals impossible et aucun cache ({cache})."
        ) from exc


if __name__ == "__main__":
    load_pal_data()
    print(f"\nCache écrit dans {CACHE}")
