// Surface d'intégration du parseur de sauvegarde Palworld, 100% navigateur.
//
// Ce fichier est notre code (glue d'orchestration), pas du GPL. Il pilote :
//  - Pyodide (Python -> WASM, chargé depuis un CDN)
//  - ooz.wasm (décompression Oodle/Kraken, GPL-3.0, voir LICENSE du bundle)
//  - palsav.zip (parseur GVAS, GPL-3.0)
//
// Usage :
//   import { createPalworldSaveParser } from './vendor/save-parser/parser.mjs';
//   const parser = await createPalworldSaveParser();
//   const result = await parser.parse(file);   // file: File | ArrayBuffer | Uint8Array
//
// `result` = { save_type, save_game_class_name, counts, players, guilds, pals }.
// Avec parse(file, { full: true }) on obtient aussi result.gvas (dump complet).

const PYODIDE_VERSION = "0.28.3";
const DEFAULT_PYODIDE_INDEX = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

function toUint8(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  throw new Error("Entrée attendue : File, ArrayBuffer ou Uint8Array");
}

async function readBytes(input) {
  if (typeof File !== "undefined" && input instanceof File) {
    return new Uint8Array(await input.arrayBuffer());
  }
  if (typeof Blob !== "undefined" && input instanceof Blob) {
    return new Uint8Array(await input.arrayBuffer());
  }
  return toUint8(input);
}

function magicOf(bytes) {
  return String.fromCharCode(bytes[8], bytes[9], bytes[10]);
}

/**
 * Initialise le parseur. Coûteux (télécharge Pyodide) : à appeler une seule fois.
 * @param {object} [opts]
 * @param {string} [opts.pyodideIndexURL] URL du dossier full/ de Pyodide.
 * @param {(msg:string)=>void} [opts.onProgress] callback de progression.
 */
export async function createPalworldSaveParser(opts = {}) {
  const baseURL = new URL(".", import.meta.url); // dossier de ce module
  const log = opts.onProgress || (() => {});

  // 1) Pyodide (ESM depuis CDN).
  log("Chargement de Pyodide…");
  const indexURL = opts.pyodideIndexURL || DEFAULT_PYODIDE_INDEX;
  const { loadPyodide } = await import(/* @vite-ignore */ `${indexURL}pyodide.mjs`);
  const pyodide = await loadPyodide({ indexURL });

  // 2) Bundle palsav (zip) -> FS virtuel + sys.path.
  log("Décompression du bundle palsav…");
  const zipBuf = await (await fetch(new URL("palsav.zip", baseURL))).arrayBuffer();
  pyodide.FS.mkdir("/palsav_bundle");
  pyodide.unpackArchive(zipBuf, "zip", { extractDir: "/palsav_bundle" });
  pyodide.runPython(`
import sys
sys.path.insert(0, "/palsav_bundle")
import palsav_api
`);
  const parseSave = pyodide.runPython("palsav_api.parse_save");
  const parseGvas = pyodide.runPython("palsav_api.parse_gvas");
  const debugSave = pyodide.runPython("palsav_api.debug_save");
  const debugGvas = pyodide.runPython("palsav_api.debug_gvas");
  const debugWorldSave = pyodide.runPython("palsav_api.debug_world_save");
  const debugWorldGvas = pyodide.runPython("palsav_api.debug_world_gvas");

  // 3) Décompresseur Oodle (WASM).
  log("Chargement du décompresseur Oodle…");
  const createOoz = (await import(new URL("ooz.mjs", baseURL))).default;
  const ooz = await createOoz();

  function oozDecompress(compressed, uncompressedLen) {
    const sp = ooz._malloc(compressed.length);
    ooz.HEAPU8.set(compressed, sp);
    const dp = ooz._malloc(uncompressedLen);
    const rc = ooz._ooz_decompress(sp, compressed.length, dp, uncompressedLen);
    const out = ooz.HEAPU8.slice(dp, dp + uncompressedLen);
    ooz._free(sp);
    ooz._free(dp);
    if (rc !== uncompressedLen) {
      throw new Error(`Échec décompression Oodle (rc=${rc}, attendu ${uncompressedLen})`);
    }
    return out;
  }

  // Prépare les bytes pour Python selon le format : Oodle -> GVAS décompressé en JS,
  // zlib -> bytes bruts (décompressés en Python). onGvas/onSave reçoivent l'argument idoine.
  async function route(input, onGvas, onSave) {
    const bytes = await readBytes(input);
    if (bytes.length < 12) throw new Error("Fichier trop petit pour être une save Palworld");
    const magic = magicOf(bytes);
    if (magic === "PlM") {
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
      const uncompressedLen = dv.getUint32(0, true);
      const compressedLen = dv.getUint32(4, true);
      const compressed = bytes.subarray(12, 12 + compressedLen);
      return onGvas(oozDecompress(compressed, uncompressedLen));
    }
    if (magic === "PlZ" || magic === "CNK") return onSave(bytes);
    throw new Error(`Format de save inconnu (magic="${magic}")`);
  }

  log("Parseur prêt.");
  return {
    pyodide,
    /**
     * Parse une sauvegarde. @param input File|ArrayBuffer|Uint8Array
     * @param {object} [o] @param {boolean} [o.full] inclure le dump GVAS complet.
     */
    async parse(input, o = {}) {
      const jsonStr = await route(input,
        (raw) => parseGvas(raw, 49, !!o.full),
        (bytes) => parseSave(bytes, !!o.full));
      return JSON.parse(jsonStr);
    },
    /**
     * Debug : renvoie le SaveParameter BRUT des n premiers Pals (pour inspecter les champs).
     * @param input File|ArrayBuffer|Uint8Array  @param {number} [n=3]
     */
    async debug(input, n = 3) {
      const jsonStr = await route(input,
        (raw) => debugGvas(raw, n),
        (bytes) => debugSave(bytes, n));
      return JSON.parse(jsonStr);
    },
    /**
     * Debug bases/travail : renvoie { bases, work_total, work_sample, map_object_total, map_object_sample }.
     * @param input File|ArrayBuffer|Uint8Array
     */
    async debugWorld(input, { workSample = 15, mapObjectSample = 3 } = {}) {
      const jsonStr = await route(input,
        (raw) => debugWorldGvas(raw, workSample, mapObjectSample),
        (bytes) => debugWorldSave(bytes, workSample, mapObjectSample));
      return JSON.parse(jsonStr);
    },
  };
}
