#!/usr/bin/env python3
"""Patch appliqué au palsav fraîchement récupéré, pour Pyodide/emscripten.

`OozLib.__load_ooz()` ne connaît que win32/linux/darwin et lève
`Unsupported platform: emscripten` AVANT même d'importer palooz. On insère un
court-circuit en tête de méthode : sous emscripten, on importe simplement le
stub `palooz` et on sort.

Idempotent. Échoue bruyamment si l'ancre n'existe plus (= upstream a changé,
à revoir manuellement).

Usage: python3 patch_oozlib.py <chemin/vers/palsav/compressor/oozlib.py>
"""
import sys

ANCHOR = "    def __load_ooz(self):\n"
GUARD = "if sys.platform == 'emscripten':"
INJECT = (
    ANCHOR
    + "        # [palworld-camp] Pyodide : décompression Oodle faite côté JS (ooz.wasm).\n"
    + "        if sys.platform == 'emscripten':\n"
    + "            import palooz\n"
    + "            self.palooz = palooz\n"
    + "            return\n"
)


def main(path):
    with open(path, encoding="utf-8") as f:
        src = f.read()
    if GUARD in src:
        print(f"[patch] déjà appliqué : {path}")
        return 0
    if ANCHOR not in src:
        print(f"[patch] ERREUR: ancre introuvable dans {path}", file=sys.stderr)
        print("        La structure d'oozlib.py a changé upstream — revoir le patch.", file=sys.stderr)
        return 1
    if "import sys" not in src:
        print(f"[patch] ERREUR: 'import sys' absent de {path} (attendu).", file=sys.stderr)
        return 1
    src = src.replace(ANCHOR, INJECT, 1)
    with open(path, "w", encoding="utf-8") as f:
        f.write(src)
    print(f"[patch] emscripten appliqué : {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
