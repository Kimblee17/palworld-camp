import { flashLimit, renderAll } from "./render.js";
import { DB, PALS, STRUCTURES, WORK_TYPES, palsById, structById, workById } from "./dataset.js";

// ===== Stockage =====
// STORE_KEY      : espace PRIVÉ (local à cet appareil, jamais partagé).
// SPACE_ID_KEY   : id de l'espace partagé actif (absent = mode privé).
// SPACE_CACHE_KEY: dernière copie connue de l'espace partagé (affichage instantané).
const STORE_KEY = "palworld-store";
const SPACE_ID_KEY = "palworld-space";
export const SPACE_CACHE_KEY = "palworld-space-cache";
// Déclarés avant `store` : loadStore() -> normalize() les lit dès le chargement du
// module, et un const reste inaccessible tant que sa ligne n'a pas été exécutée.
const PAL_PREFS = ["pin", "exclude"];
const WORK_PREFS = ["priority", "ignore"];
export let store = loadStore();
// Les imports ES sont en lecture seule : les modules qui remplacent entièrement le
// store (synchro cloud, retour en privé) passent par ce setter.
export function setStore(next) { store = next; }
// Sommes-nous dans un espace partagé (cloud) ou en privé (local) ?
function isShared() { return window.PWCloud ? window.PWCloud.mode() === "shared"
  : !!(localStorage.getItem(SPACE_ID_KEY) || localStorage.getItem("palworld-ws")); }

export function uid() { return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

export function loadStore() {
  // En mode partagé : on hydrate depuis le cache de l'espace (le cloud rafraîchira ensuite).
  if (isShared()) {
    try {
      const c = JSON.parse(localStorage.getItem(SPACE_CACHE_KEY));
      if (c && c.camps) return normalize(c);
    } catch { /* ignore */ }
  }
  // Mode privé : espace local de cet appareil.
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY));
    if (raw && raw.camps && raw.activeId && raw.camps[raw.activeId]) return normalize(raw);
  } catch { /* ignore */ }

  // Migration depuis l'ancien format (un seul camp)
  let pals = {};
  try {
    const old = JSON.parse(localStorage.getItem("palworld-camp"));
    if (Array.isArray(old)) pals = Object.fromEntries(old.map(id => [id, 1]));
    else if (old && typeof old === "object") pals = old;
  } catch { /* ignore */ }
  let limit = parseInt(localStorage.getItem("palworld-limit"), 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 15;

  const id = uid();
  // normalize() aussi sur ce chemin : sinon un store tout neuf n'aurait pas les champs
  // garantis (suggest…) que le reste du code suppose présents.
  return normalize({ activeId: id, palBox: {}, camps: { [id]: { name: "Camp 1", pals, structures: {}, limit } } });
}

export function normalize(s) {
  s.palBox = migrateBox(s.palBox);
  s.suggest = normalizeSuggestPrefs(s.suggest);
  s.camps = s.camps || {};
  for (const c of Object.values(s.camps)) {
    c.pals = c.pals || {};
    c.structures = c.structures || {};
    if (!Number.isFinite(c.limit) || c.limit < 1) c.limit = 15;
    if (!c.name) c.name = "Camp";
    // Camps importés d'une save : garantir un tableau de machines exploitable par l'agencement.
    if (c.source === "save" && !Array.isArray(c.machines)) c.machines = [];
  }
  // Garantit un camp actif valide (utile quand on applique un store distant).
  if (!s.camps[s.activeId]) s.activeId = Object.keys(s.camps)[0];
  if (!s.activeId) {
    const id = uid();
    s.camps[id] = { name: "Camp 1", pals: {}, structures: {}, limit: 15 };
    s.activeId = id;
  }
  return s;
}

// ===== Boîte à Pals : entrées INDIVIDUELLES =====
// Schéma : store.palBox = { [clé]: { palId, level, stars, passives, manual? } }.
//   clé = instance_id (Pal importé d'une save, stable → upsert au réimport)
//         ou clé synthétique "syn_…" (ajout manuel / import CoWork / migration).
// L'entrée synthétique (manual:true) n'a pas de données de save (level=null) et
// est retirée en priorité quand on baisse une quantité à la main.
//
// Migration rétro-tolérante depuis l'ancien format { palId: qty } (valeurs = nombres).
// Déterministe (clés "syn_<palId>_<i>") pour ne pas générer de churn de synchro cloud
// lorsque plusieurs clients migrent la même sauvegarde distante.
export function migrateBox(box) {
  box = box || {};
  const out = {};
  for (const [key, val] of Object.entries(box)) {
    if (typeof val === "number") {                    // ancien format { palId: qty }
      const n = Math.max(0, Math.floor(val));
      for (let i = 0; i < n; i++)
        out[`syn_${key}_${i}`] = { palId: key, level: null, stars: 0, passives: [], manual: true };
    } else if (val && typeof val === "object" && val.palId) {   // déjà au nouveau format
      out[key] = {
        palId: val.palId,
        level: Number.isFinite(val.level) ? val.level : null,
        stars: val.stars || 0,
        passives: Array.isArray(val.passives) ? val.passives : [],
        ...(val.manual ? { manual: true } : {}),
      };
    }
    // toute autre valeur (corrompue) est ignorée
  }
  return out;
}

// Vue dérivée { palId: qty }, mémoïsée. Invalidée à chaque écriture (touchBox / normalize).
let _boxCounts = null;
export function touchBox() { _boxCounts = null; }
export function palBoxCounts() {
  if (_boxCounts) return _boxCounts;
  const out = {};
  for (const e of Object.values(store.palBox))
    if (e && e.palId) out[e.palId] = (out[e.palId] || 0) + 1;
  return (_boxCounts = out);
}

// Clé synthétique unique (ajout manuel / import CoWork sans instance_id).
let _synSeq = 0;
export function synKey() { return `syn_${Date.now().toString(36)}_${(_synSeq++).toString(36)}`; }

export function saveStore() {
  if (isShared()) {
    // Espace partagé : cache local (chargement instantané) + poussée cloud. On NE
    // touche PAS à l'espace privé, restauré tel quel quand on quitte le partage.
    localStorage.setItem(SPACE_CACHE_KEY, JSON.stringify(store));
    window.PWCloud?.push?.(store);
  } else {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  }
}

// ===== Lecture seule (lien ?r=<readKey>) =====
// Pré-affichage avant que firebase-sync.js ait tranché (il appelle setReadOnly).
export let readOnly = new URLSearchParams(location.search).has("r")
  || !!localStorage.getItem("palworld-readkey");
const RO_BANNER_DEFAULT = "👁 Lecture seule — tu vois cet espace en direct, mais tu ne peux pas le modifier.";
export function showRoBanner(msg) {
  const b = document.getElementById("ro-banner");
  if (!b) return;
  b.textContent = msg;
  b.hidden = false;
}
window.setReadOnly = function (ro) {
  readOnly = !!ro;
  document.body.classList.toggle("read-only", readOnly);
  const b = document.getElementById("ro-banner");
  if (b) { b.textContent = RO_BANNER_DEFAULT; b.hidden = !readOnly; }
};

// ===== Historique / annuler =====
let undoStack = [];
export function pushUndo(label) {
  undoStack.push({ json: JSON.stringify(store), label });
  if (undoStack.length > 20) undoStack.shift();
  updateUndoUI();
}
export function updateUndoUI() {
  const btn = document.getElementById("undo-btn");
  if (!btn) return;
  const last = undoStack[undoStack.length - 1];
  btn.hidden = !last || readOnly;
  if (last) btn.title = "Annuler : " + last.label;
}
export function doUndo() {
  if (readOnly) return;
  const u = undoStack.pop();
  if (!u) return;
  store = normalize(JSON.parse(u.json));
  touchBox();
  saveStore(); renderAll();
}

// ===== Export / import de la sauvegarde (JSON) =====
// Tout l'état vit dans localStorage : ces deux boutons permettent d'en garder une
// copie hors du navigateur et de la restaurer (autre appareil, après un nettoyage…).
const EXPORT_APP = "palworld-camp";
const EXPORT_VERSION = 1;          // incrémenter si le schéma du fichier change

export function exportStore() {
  const now = new Date();
  const payload = {
    app: EXPORT_APP,
    version: EXPORT_VERSION,
    exportedAt: now.toISOString(),
    store,
  };
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `palworld-camp-export-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Valide le contenu d'un fichier d'export et renvoie le store brut qu'il contient.
// Lève une Error dont le message est directement affichable à l'utilisateur.
function parseExportFile(text) {
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error("Ce fichier n'est pas un JSON valide."); }
  const isPlainObject = v => !!v && typeof v === "object" && !Array.isArray(v);

  if (!isPlainObject(data))
    throw new Error("Contenu inattendu : le fichier ne contient pas un objet JSON.");
  if (data.app !== EXPORT_APP)
    throw new Error("Ce fichier ne vient pas de l'assistant de camp Palworld.");
  if (!Number.isInteger(data.version) || data.version < 1)
    throw new Error("Version de sauvegarde illisible.");
  if (data.version > EXPORT_VERSION)
    throw new Error(`Sauvegarde en version ${data.version}, or cette page ne gère que la version ${EXPORT_VERSION}. Recharge l'application (Ctrl+F5).`);

  const s = data.store;
  if (!isPlainObject(s))
    throw new Error("Sauvegarde illisible : la section « store » est absente.");
  if (!isPlainObject(s.camps))
    throw new Error("Sauvegarde illisible : aucun camp trouvé.");
  const campIds = Object.keys(s.camps);
  if (!campIds.length)
    throw new Error("Cette sauvegarde ne contient aucun camp.");
  for (const id of campIds) {
    if (!isPlainObject(s.camps[id]))
      throw new Error(`Sauvegarde illisible : le camp « ${id} » est corrompu.`);
  }
  if (s.palBox != null && !isPlainObject(s.palBox))
    throw new Error("Sauvegarde illisible : la boîte à Pals est corrompue.");
  return s;
}

export function runStoreImport(text, btn) {
  if (readOnly) return;
  let incoming;
  try { incoming = parseExportFile(text); }
  catch (e) { alert("Import impossible.\n\n" + e.message); return; }

  const nbCamps = Object.keys(incoming.camps).length;
  const cible = isShared()
    ? "de l'espace partagé — le changement sera visible par tout ton groupe"
    : "de cet appareil";
  if (!confirm(
    `Importer cette sauvegarde ? (${nbCamps} camp(s))\n\n`
    + `⚠️ Cela REMPLACE tes camps et ta boîte à Pals ${cible}.\n\n`
    + `Tu pourras revenir en arrière avec ↩ Annuler.`)) return;

  pushUndo("import de sauvegarde");
  // normalize() applique migrateBox() à la boîte et garantit un camp actif valide.
  store = normalize(incoming);
  touchBox();
  saveStore();
  renderAll();

  if (btn) {   // même retour visuel discret que les boutons de partage
    const old = btn.textContent;
    btn.textContent = "✓ Importé !";
    setTimeout(() => { btn.textContent = old; }, 1800);
  }
}

export function active() { return store.camps[store.activeId]; }

// ===== Quantités (Pals / Constructions / Boîte) =====
export function palQty(id) { return active().pals[id] || 0; }
export function structQty(id) { return active().structures[id] || 0; }
export function boxQty(id) { return palBoxCounts()[id] || 0; }
function totalPals() { return Object.values(active().pals).reduce((a, b) => a + b, 0); }
export function totalBox() { return Object.values(palBoxCounts()).reduce((a, b) => a + b, 0); }
export function isFull() { return totalPals() >= active().limit; }

export function setPalQty(id, q) {
  if (readOnly) return;
  const m = active().pals;
  if (q > 0) m[id] = q; else delete m[id];
  saveStore(); renderAll();
}
export function setStructQty(id, q) {
  if (readOnly) return;
  const m = active().structures;
  if (q > 0) m[id] = q; else delete m[id];
  saveStore(); renderAll();
}
// Ajuste à la main la quantité d'un palId à la valeur cible q, en RÉCONCILIANT les
// entrées individuelles : on ajoute des entrées synthétiques si q monte ; si q baisse,
// on retire d'abord les entrées manuelles/synthétiques (sans données de save), puis, en
// dernier recours, les entrées importées (préserve level/étoiles/passifs autant que possible).
// ===== Contraintes du suggesteur de compo =====
// Persistées dans le store (donc partagées avec le groupe en espace partagé) :
//   store.suggest = { pals: { [palId]: "pin" | "exclude" },
//                     works: { [workId]: "priority" | "ignore" } }
// L'absence de clé = état neutre ; on ne stocke jamais "neutral" pour garder le
// store compact et éviter du bruit de synchro.
function normalizeSuggestPrefs(s) {
  const keep = (obj, allowed) => Object.fromEntries(
    Object.entries((obj && typeof obj === "object") ? obj : {})
      .filter(([, v]) => allowed.includes(v)));
  s = s && typeof s === "object" ? s : {};
  return { pals: keep(s.pals, PAL_PREFS), works: keep(s.works, WORK_PREFS) };
}

export function palPref(palId) { return store.suggest.pals[palId] || null; }
export function workPref(workId) { return store.suggest.works[workId] || null; }

// Cycle neutre -> épinglé -> exclu -> neutre (et neutre -> prioritaire -> ignorée).
function cyclePref(map, key, states) {
  const i = states.indexOf(map[key]);
  const next = states[i + 1];       // undefined en fin de cycle -> retour au neutre
  if (next) map[key] = next; else delete map[key];
}

export function cyclePalPref(palId) {
  if (readOnly) return;
  cyclePref(store.suggest.pals, palId, PAL_PREFS);
  saveStore(); renderAll();
}

export function cycleWorkPref(workId) {
  if (readOnly) return;
  cyclePref(store.suggest.works, workId, WORK_PREFS);
  saveStore(); renderAll();
}

export function clearSuggestPrefs() {
  if (readOnly) return;
  store.suggest = { pals: {}, works: {} };
  saveStore(); renderAll();
}

export function setBoxQty(id, q) {
  if (readOnly) return;
  q = Math.max(0, Math.floor(q));
  const entries = Object.entries(store.palBox).filter(([, e]) => e && e.palId === id);
  const cur = entries.length;
  if (q > cur) {
    for (let i = 0; i < q - cur; i++)
      store.palBox[synKey()] = { palId: id, level: null, stars: 0, passives: [], manual: true };
  } else if (q < cur) {
    // manuelles d'abord (manual/synthétique), importées ensuite
    entries.sort(([, a], [, b]) => (a.manual ? 0 : 1) - (b.manual ? 0 : 1));
    for (let i = 0; i < cur - q; i++) delete store.palBox[entries[i][0]];
  }
  touchBox();
  saveStore(); renderAll();
}
export function addPal(id) {
  if (isFull()) { flashLimit(); return; }
  setPalQty(id, palQty(id) + 1);
}
export function addStruct(id) { setStructQty(id, structQty(id) + 1); }
export function addBox(id) { setBoxQty(id, boxQty(id) + 1); }
