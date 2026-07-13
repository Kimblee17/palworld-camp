#!/usr/bin/env bash
# Pipeline de build du parseur de sauvegarde Palworld (WASM, 100% navigateur).
#
#   ./build.sh            build reproductible depuis le commit figé (versions.lock)
#   ./build.sh --update   récupère la DERNIÈRE version upstream, met à jour le pin, puis build
#
# Produit (artefacts commités) dans docs/vendor/save-parser/ :
#   ooz.mjs, ooz.wasm   décompresseur Oodle/Kraken (lib `ooz` -> WebAssembly)
#   palsav.zip          parseur GVAS Python + palsav_api.py + stub palooz
#   parser.mjs          loader d'intégration (notre code)
#   LICENSE             GPL-3.0 (palsav & ooz)
#   build-info.json     métadonnées de build (commit, date, versions)
set -euo pipefail

SP="$(cd "$(dirname "$0")" && pwd)"          # save-parser/
ROOT="$(cd "$SP/.." && pwd)"                 # racine du repo
OUT="$ROOT/docs/vendor/save-parser"          # artefacts (commités)
WORK="$SP/.work"                             # temporaire (gitignoré)
LOCK="$SP/versions.lock"

j() { python3 -c "import json,sys; print(json.load(open('$LOCK'))$1)"; }

# ---------------------------------------------------------------- Emscripten
ensure_emcc() {
  if command -v emcc >/dev/null 2>&1; then return; fi
  for env in "${EMSDK_ENV:-}" "${EMSDK:-}/emsdk_env.sh" "$SP/.emsdk/emsdk_env.sh"; do
    if [ -n "$env" ] && [ -f "$env" ]; then
      # shellcheck disable=SC1090
      source "$env" >/dev/null 2>&1 || true
      command -v emcc >/dev/null 2>&1 && return
    fi
  done
  echo "ERREUR: 'emcc' (Emscripten) introuvable." >&2
  echo "  -> Lance d'abord :  ./setup-emsdk.sh   (installe emsdk dans save-parser/.emsdk)" >&2
  echo "  -> ou fournis EMSDK_ENV=/chemin/emsdk_env.sh" >&2
  exit 1
}

# ---------------------------------------------------------------- --update
if [ "${1:-}" = "--update" ]; then
  REPO="$(j "['source']['repo']")"; REF="$(j "['source']['ref']")"
  echo "==> Résolution de la dernière version ($REF) sur $REPO"
  NEW="$(git ls-remote "$REPO" "$REF" | cut -f1)"
  [ -n "$NEW" ] || { echo "ERREUR: impossible de résoudre $REF" >&2; exit 1; }
  python3 - "$LOCK" "$NEW" <<'PY'
import json, sys
p, sha = sys.argv[1], sys.argv[2]
d = json.load(open(p)); old = d["source"]["commit"]; d["source"]["commit"] = sha
json.dump(d, open(p, "w"), indent=2, ensure_ascii=False); open(p,"a").write("\n")
print(f"    {old[:12]} -> {sha[:12]}")
PY
fi

COMMIT="$(j "['source']['commit']")"
REPO="$(j "['source']['repo']")"
PALSAV_PY="$(j "['source']['paths']['palsav_python']")"
OOZ_PATH="$(j "['source']['paths']['ooz_sources']")"
PYODIDE="$(j "['pyodide']")"
OWNER_REPO="$(echo "$REPO" | sed -E 's#https://github.com/##')"

echo "==> Source : $OWNER_REPO @ ${COMMIT:0:12}"
ensure_emcc
echo "    emcc : $(emcc --version | head -1)"

# ---------------------------------------------------------------- fetch (piné)
rm -rf "$WORK"; mkdir -p "$WORK"
SRCDIR="$WORK/src"
echo "==> Récupération du tarball figé…"
mkdir -p "$SRCDIR"
curl -fsSL "https://github.com/$OWNER_REPO/archive/$COMMIT.tar.gz" \
  | tar xz -C "$SRCDIR" --strip-components=1
[ -d "$SRCDIR/$PALSAV_PY" ] || { echo "ERREUR: $PALSAV_PY absent (upstream a changé ?)" >&2; exit 1; }
[ -d "$SRCDIR/$OOZ_PATH" ]  || { echo "ERREUR: $OOZ_PATH absent (upstream a changé ?)" >&2; exit 1; }

# ---------------------------------------------------------------- build ooz.wasm
echo "==> Compilation de ooz -> WebAssembly"
OOZB="$WORK/ooz"; mkdir -p "$OOZB"
cp "$SRCDIR/$OOZ_PATH"/*.cpp "$SRCDIR/$OOZ_PATH"/*.h "$OOZB/"
cp -R "$SRCDIR/$OOZ_PATH/simde" "$OOZB/simde"
cp "$SP/src/ooz_wasm.cpp" "$OOZB/"
( cd "$OOZB" && emcc -O3 -std=c++17 -I. -Isimde -Wno-everything \
    ooz_wasm.cpp kraken.cpp bitknit.cpp lzna.cpp \
    -o ooz.mjs \
    -s MODULARIZE=1 -s EXPORT_ES6=1 -s ENVIRONMENT=web,node \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s EXPORTED_FUNCTIONS='["_ooz_decompress","_malloc","_free"]' \
    -s EXPORTED_RUNTIME_METHODS='["HEAPU8","ccall"]' \
    -s EXPORT_NAME=createOoz )

# ---------------------------------------------------------------- bundle palsav.zip
echo "==> Assemblage du bundle palsav.zip"
BUN="$WORK/bundle"; mkdir -p "$BUN"
cp -R "$SRCDIR/$PALSAV_PY" "$BUN/palsav"
python3 "$SP/patches/patch_oozlib.py" "$BUN/palsav/compressor/oozlib.py"
cp "$SP/src/palsav_api.py" "$BUN/palsav_api.py"
cp "$SP/src/pyshim/palooz.py" "$BUN/palooz.py"
find "$BUN" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
find "$BUN" -name '*.pyc' -delete 2>/dev/null || true
( cd "$BUN" && rm -f palsav.zip && zip -rqX palsav.zip . ) # -X: pas de métadonnées extra

# ---------------------------------------------------------------- publication
echo "==> Publication dans docs/vendor/save-parser/"
mkdir -p "$OUT"
cp "$OOZB/ooz.mjs" "$OOZB/ooz.wasm" "$OUT/"
cp "$BUN/palsav.zip" "$OUT/"
cp "$SP/src/parser.mjs" "$OUT/"
cp "$SRCDIR/$(dirname "$PALSAV_PY")/../LICENSE" "$OUT/LICENSE" 2>/dev/null \
  || cp "$SRCDIR/src/palsav/LICENSE" "$OUT/LICENSE"
cp "$OUT/LICENSE" "$SP/LICENSES/PalworldSaveTools-GPL-3.0.txt"

BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
python3 - "$OUT/build-info.json" "$OWNER_REPO" "$COMMIT" "$PYODIDE" "$BUILD_DATE" <<'PY'
import json, sys, os, hashlib
out, repo, commit, pyodide, date = sys.argv[1:6]
d = os.path.dirname(out)
files = {}
for n in ("ooz.mjs","ooz.wasm","palsav.zip","parser.mjs"):
    p = os.path.join(d, n)
    files[n] = {"bytes": os.path.getsize(p),
                "sha256": hashlib.sha256(open(p,"rb").read()).hexdigest()}
json.dump({"source_repo": repo, "source_commit": commit,
           "pyodide": pyodide, "built_at": date,
           "license": "GPL-3.0-or-later", "files": files},
          open(out,"w"), indent=2, ensure_ascii=False)
PY

rm -rf "$WORK"
echo
echo "✅ Build terminé."
ls -la "$OUT"
