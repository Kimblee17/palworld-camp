#!/usr/bin/env bash
# Installe Emscripten (emsdk) localement dans save-parser/.emsdk (gitignoré).
# À lancer une seule fois. Ensuite ./build.sh le détecte automatiquement.
set -euo pipefail
SP="$(cd "$(dirname "$0")" && pwd)"
DIR="$SP/.emsdk"

if [ ! -d "$DIR" ]; then
  echo "==> Clonage d'emsdk dans $DIR"
  git clone --depth 1 https://github.com/emscripten-core/emsdk.git "$DIR"
fi
cd "$DIR"
echo "==> Installation + activation de la dernière version"
./emsdk install latest
./emsdk activate latest
echo
echo "✅ Emscripten prêt. Tu peux lancer ./build.sh"
