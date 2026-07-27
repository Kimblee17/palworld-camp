"""
Télécharge les icônes de Pals pour les auto-héberger.

Les icônes étaient hotlinkées depuis palworld.gg (palIconUrl dans docs/app.js) :
dépendance à un site tiers, aucune garantie de disponibilité, et une requête externe
par vignette. On les rapatrie une fois pour toutes dans docs/icons/pals/<code>.png,
où <code> est le nom de code interne (BPClass) déjà présent dans data/pals.json.

  https://palworld.gg/images/full_palicon/T_<code>_icon_normal.png
      -> docs/icons/pals/<code>.png

Relançable sans risque : les fichiers déjà présents sont conservés (reprise après
interruption), les requêtes sont espacées pour rester poli avec palworld.gg, et un
rapport final liste ce qui manque encore.

    python tools/fetch_icons.py            # reprise : ne retélécharge rien
    python tools/fetch_icons.py --force    # retélécharge tout
"""
import json
import sys
import time
import urllib.request
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")   # console Windows -> UTF-8 pour les emojis
except Exception:
    pass

BASE_DIR = Path(__file__).resolve().parent.parent
PALS = BASE_DIR / "data" / "pals.json"
OUT_DIR = BASE_DIR / "docs" / "icons" / "pals"
URL = "https://palworld.gg/images/full_palicon/T_{code}_icon_normal.png"

DELAY = 0.25        # secondes entre deux requêtes
RETRIES = 3
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def fetch(url, retries=RETRIES):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.read()
        except Exception:
            if attempt == retries - 1:
                raise
            time.sleep(0.5 * (attempt + 1))   # petit backoff contre le throttling


def load_codes():
    """[(nom, code)] depuis data/pals.json, dédoublonné sur le code."""
    pals = json.loads(PALS.read_text(encoding="utf-8"))
    seen, out, no_code = set(), [], []
    for p in pals:
        code = p.get("code")
        if not code:
            no_code.append(p.get("name", "?"))
        elif code not in seen:
            seen.add(code)
            out.append((p.get("name", "?"), code))
    return out, no_code


def main():
    force = "--force" in sys.argv
    if not PALS.exists():
        raise SystemExit(f"{PALS} introuvable — lance d'abord build_data.py.")

    codes, no_code = load_codes()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"{len(codes)} icônes à traiter -> {OUT_DIR.relative_to(BASE_DIR)}"
          + (" (--force : tout retélécharger)" if force else ""))

    kept = downloaded = 0
    failed, invalid = [], []
    for i, (name, code) in enumerate(codes, 1):
        dest = OUT_DIR / f"{code}.png"
        if dest.exists() and dest.stat().st_size > 0 and not force:
            kept += 1
            continue
        try:
            data = fetch(URL.format(code=code))
        except Exception as exc:
            failed.append(f"{name} ({code}) : {getattr(exc, 'code', exc)}")
            continue
        # Une page d'erreur renvoyée en 200 ne doit pas finir en .png silencieusement.
        if not data.startswith(PNG_MAGIC):
            invalid.append(f"{name} ({code})")
            continue
        dest.write_bytes(data)
        downloaded += 1
        if downloaded % 25 == 0:
            print(f"  … {i}/{len(codes)} ({downloaded} téléchargées)")
        time.sleep(DELAY)

    present = sum(1 for _, c in codes if (OUT_DIR / f"{c}.png").exists())
    print(f"\n{downloaded} téléchargée(s), {kept} déjà présente(s) — "
          f"{present}/{len(codes)} icônes disponibles.")
    if no_code:
        print(f"  ⚠ {len(no_code)} Pal(s) sans code dans pals.json (repli initiale) : "
              + ", ".join(no_code))
    if invalid:
        print(f"  ⚠ {len(invalid)} réponse(s) non-PNG (ignorées) : " + ", ".join(invalid))
    if failed:
        print(f"  ⚠ {len(failed)} échec(s) de téléchargement : " + ", ".join(failed))
    missing = [f"{n} ({c})" for n, c in codes if not (OUT_DIR / f"{c}.png").exists()]
    if missing:
        print(f"  ⚠ {len(missing)} icône(s) manquante(s) — relance le script pour réessayer :")
        print("     " + ", ".join(missing))
    else:
        print("  ✅ aucune icône manquante.")


if __name__ == "__main__":
    main()
