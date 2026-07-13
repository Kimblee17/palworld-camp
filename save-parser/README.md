# save-parser — parseur de sauvegarde Palworld en WebAssembly

Pipeline qui récupère la dernière version de [PalworldSaveTools](https://github.com/deafdudecomputers/PalworldSaveTools)
(`palsav` + la lib Oodle `ooz`) et **compile tout en WebAssembly**, prêt à être
consommé par l'app (100% navigateur : ni backend, ni binaire natif).

## En un coup d'œil

```
save-parser/            ← SOURCE (versionnée) : scripts + notre code
├── build.sh            orchestrateur de build
├── setup-emsdk.sh      installe Emscripten localement (une fois)
├── versions.lock       commit upstream FIGÉ (reproductible) + version Pyodide
├── src/
│   ├── ooz_wasm.cpp     wrapper C++ (expose ooz_decompress)
│   ├── palsav_api.py    API : parse_save / parse_gvas -> JSON
│   ├── parser.mjs       loader d'intégration (surface pour l'app)
│   └── pyshim/palooz.py stub du module natif Oodle
├── patches/
│   └── patch_oozlib.py  court-circuit emscripten dans oozlib.py (appliqué au build)
├── LICENSES/            licence GPL-3.0 upstream (copiée au build)
└── demo.html            page de test locale

docs/vendor/save-parser/ ← ARTEFACTS (versionnés, générés par build.sh)
├── ooz.mjs / ooz.wasm    décompresseur Oodle/Kraken -> WASM
├── palsav.zip            paquet Python palsav + palsav_api.py + palooz stub
├── parser.mjs            copie du loader
├── LICENSE               GPL-3.0
└── build-info.json       commit source, date, versions, sha256 des fichiers
```

## Construire / mettre à jour

```bash
cd save-parser
./setup-emsdk.sh          # une seule fois (installe Emscripten dans .emsdk/)
./build.sh                # build reproductible depuis versions.lock
./build.sh --update       # récupère la DERNIÈRE version upstream, met à jour le pin, rebuild
```

`--update` résout le dernier commit de `main` upstream, l'écrit dans
`versions.lock`, puis build. Sans `--update`, le build est **100% reproductible**
(même commit figé → mêmes artefacts).

Le patch emscripten et les chemins upstream sont vérifiés au build : si upstream
change de structure, le build **échoue bruyamment** (à revoir plutôt que casser en
silence).

## Que publie-t-on sur git, que garde-t-on en artefact ?

Contrainte : le site est déployé via **GitHub Pages « deploy from a branch » sur
`docs/`**, sans étape de build serveur. Donc tout ce que l'app charge à
l'exécution **doit être un fichier statique présent dans `docs/`**.

| Élément | Git ? | Où | Pourquoi |
|---|---|---|---|
| Scripts de build, wrapper, API, stub, patch, `versions.lock` | ✅ versionné | `save-parser/` | Source de vérité, reproductible. |
| `docs/vendor/save-parser/*` (ooz.wasm/.mjs, palsav.zip, parser.mjs, LICENSE, build-info) | ✅ versionné | `docs/vendor/` | **Requis à l'exécution** par Pages (pas de build au déploiement). Générés mais publiés. |
| Pyodide (runtime Python→WASM) | ❌ | CDN jsdelivr | ~10 Mo ; chargé à la volée, pas la peine de le vendoriser. |
| `.work/` (clone/temp), `.emsdk/` (toolchain), `__pycache__` | ❌ gitignoré | local | Intermédiaires de build, lourds, régénérables. |

> Les fichiers de `docs/vendor/save-parser/` sont **générés** : ne pas les éditer à
> la main, relancer `build.sh`. `build-info.json` trace le commit source exact.

## Licence

`palsav` **et** `ooz` sont en **GPL-3.0-or-later**. Les artefacts publiés
(`ooz.wasm`, `ooz.mjs`, `palsav.zip`) en sont dérivés et restent donc GPL-3.0 :
`docs/vendor/save-parser/LICENSE` accompagne la distribution. Notre propre code
(`parser.mjs`, `palsav_api.py`, wrapper, scripts) est de la glue ; le distribuer
avec ces composants relève de la GPL pour l'ensemble redistribué. Le reste de
`palworld-camp` (ton app) reste indépendant tant qu'il ne *lie* pas ce code au
sens GPL — ici il l'appelle comme un module séparé côté navigateur.

## Utilisation depuis l'app (aperçu)

```js
import { createPalworldSaveParser } from './vendor/save-parser/parser.mjs';

const parser = await createPalworldSaveParser({ onProgress: console.log });
const result = await parser.parse(file);   // File | ArrayBuffer | Uint8Array
// result = { save_type, save_game_class_name, counts, players, guilds, pals }
```

Test local : `python3 -m http.server` à la racine, puis ouvrir
`http://localhost:8000/save-parser/demo.html`.

## Vérifié

Build contre la dernière version upstream, puis, façon navigateur (Pyodide +
artefacts réels) : import du bundle OK, chemin **zlib** (`parse_save`) OK, chemin
**Oodle** (`ooz.wasm` → `parse_gvas`) OK. La décompression Oodle/Kraken a été
validée octet à octet contre la compression native de référence.
