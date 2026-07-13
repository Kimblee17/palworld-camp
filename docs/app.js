// ===== Données de référence (embarquées via data.js) =====
const DB = window.PAL_DATA || { workTypes: [], pals: [], structures: [] };
const WORK_TYPES = DB.workTypes;
const PALS = DB.pals;
const STRUCTURES = DB.structures;
const workById = Object.fromEntries(WORK_TYPES.map(w => [w.id, w]));
const palsById = Object.fromEntries(PALS.map(p => [p.id, p]));
const structById = Object.fromEntries(STRUCTURES.map(s => [s.id, s]));

// ===== Stockage =====
// STORE_KEY      : espace PRIVÉ (local à cet appareil, jamais partagé).
// SPACE_ID_KEY   : id de l'espace partagé actif (absent = mode privé).
// SPACE_CACHE_KEY: dernière copie connue de l'espace partagé (affichage instantané).
const STORE_KEY = "palworld-store";
const SPACE_ID_KEY = "palworld-space";
const SPACE_CACHE_KEY = "palworld-space-cache";
let store = loadStore();
let currentTab = "pals";
let currentView = "camp";

// Sommes-nous dans un espace partagé (cloud) ou en privé (local) ?
function isShared() { return window.PWCloud ? window.PWCloud.mode() === "shared"
  : !!(localStorage.getItem(SPACE_ID_KEY) || localStorage.getItem("palworld-ws")); }

function uid() { return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function loadStore() {
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
  return { activeId: id, palBox: {}, camps: { [id]: { name: "Camp 1", pals, structures: {}, limit } } };
}

function normalize(s) {
  s.palBox = migrateBox(s.palBox);
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
function migrateBox(box) {
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
function touchBox() { _boxCounts = null; }
function palBoxCounts() {
  if (_boxCounts) return _boxCounts;
  const out = {};
  for (const e of Object.values(store.palBox))
    if (e && e.palId) out[e.palId] = (out[e.palId] || 0) + 1;
  return (_boxCounts = out);
}

// Clé synthétique unique (ajout manuel / import CoWork sans instance_id).
let _synSeq = 0;
function synKey() { return `syn_${Date.now().toString(36)}_${(_synSeq++).toString(36)}`; }

function saveStore() {
  if (isShared()) {
    // Espace partagé : cache local (chargement instantané) + poussée cloud. On NE
    // touche PAS à l'espace privé, restauré tel quel quand on quitte le partage.
    localStorage.setItem(SPACE_CACHE_KEY, JSON.stringify(store));
    window.PWCloud?.push?.(store);
  } else {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  }
}

// ===== Passerelles avec le module de synchro cloud (firebase-sync.js) =====
// Applique un store reçu du cloud (sans re-pousser : écriture dans le cache d'espace).
window.applyRemoteStore = function (data) {
  if (JSON.stringify(data) === JSON.stringify(store)) return;
  store = normalize(data);
  touchBox();
  localStorage.setItem(SPACE_CACHE_KEY, JSON.stringify(store));
  renderAll();
};

// Rechargé après avoir quitté un espace partagé : on revient à l'espace privé.
window.reloadLocalStore = function () {
  store = loadStore();   // les clés d'espace sont effacées -> charge l'espace privé
  touchBox();
  renderAll();
};

// Met à jour la barre selon l'état renvoyé par le module de synchro.
let syncLink = null, syncRoLink = null;
window.setSyncUI = function (state, info = {}) {
  const st = document.getElementById("sync-status");
  const create = document.getElementById("space-create");
  const share = document.getElementById("space-share");
  const shareRo = document.getElementById("space-share-ro");
  const join = document.getElementById("space-join");
  const leave = document.getElementById("space-leave");
  syncLink = info.link || null;
  syncRoLink = info.roLink || null;
  const show = (el, on) => { if (el) el.hidden = !on; };
  const shared = window.PWCloud ? window.PWCloud.mode() === "shared" : false;
  const all = (a, b, c, d, e) => { show(create, a); show(share, b); show(shareRo, c); show(join, d); show(leave, e); };
  if (state === "connecting") {
    st.textContent = "☁️ Connexion…"; st.className = "sync-status"; all(false, false, false, false, false);
  } else if (state === "shared" && info.ro) {
    st.textContent = "👁 Espace partagé — lecture seule"; st.className = "sync-status ok"; all(false, false, false, false, true);
  } else if (state === "shared") {
    st.textContent = "👥 Espace partagé (synchronisé)"; st.className = "sync-status ok"; all(false, true, true, false, true);
  } else if (state === "error") {
    st.textContent = "⚠️ " + (info.msg || "erreur de synchro"); st.className = "sync-status err";
    all(!shared, shared, shared, !shared, shared);
  } else { // "local"
    st.textContent = "🖥️ Espace privé (local à cet appareil)"; st.className = "sync-status"; all(true, false, false, true, false);
  }
};

// ===== Lecture seule (lien ?ro=1) =====
let readOnly = new URLSearchParams(location.search).get("ro") === "1"
  || localStorage.getItem("palworld-ro") === "1";
window.setReadOnly = function (ro) {
  readOnly = !!ro;
  document.body.classList.toggle("read-only", readOnly);
  const b = document.getElementById("ro-banner");
  if (b) b.hidden = !readOnly;
};

// ===== Présence (qui est en ligne) =====
window.PW_NAME = () => localStorage.getItem("palworld-name") || "";
window.setPresence = function (list) {
  const el = document.getElementById("presence");
  if (!el) return;
  if (!list || !list.length) { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = "👥 " + list.length;
  el.title = "En ligne : " + list.map(p => p.name + (p.ro ? " 👁" : "") + (p.me ? " (toi)" : "")).join(", ");
};
function promptName() {
  const n = (prompt("Ton nom (visible par ton groupe dans un espace partagé) :", window.PW_NAME()) || "").trim();
  if (n) localStorage.setItem("palworld-name", n);
}

// ===== Historique / annuler =====
let undoStack = [];
function pushUndo(label) {
  undoStack.push({ json: JSON.stringify(store), label });
  if (undoStack.length > 20) undoStack.shift();
  updateUndoUI();
}
function updateUndoUI() {
  const btn = document.getElementById("undo-btn");
  if (!btn) return;
  const last = undoStack[undoStack.length - 1];
  btn.hidden = !last || readOnly;
  if (last) btn.title = "Annuler : " + last.label;
}
function doUndo() {
  if (readOnly) return;
  const u = undoStack.pop();
  if (!u) return;
  store = normalize(JSON.parse(u.json));
  touchBox();
  saveStore(); renderAll();
}

// ===== Modale : détail d'un Pal =====
function openPalDetail(pal) {
  const modal = document.getElementById("pal-modal");
  const body = document.getElementById("pal-modal-body");
  if (!modal || !body) return;
  const url = palIconUrl(pal);
  const iconHtml = url
    ? `<img class="pm-ic" src="${url}" alt="${pal.name}">`
    : `<div class="pm-ic pal-ic fallback">${(pal.name[0] || "?").toUpperCase()}</div>`;
  const skills = WORK_TYPES.filter(w => (pal.work[w.id] || 0) > 0)
    .map(w => `<span class="skill-chip ${levelClass(pal.work[w.id])}">${w.icon} ${w.label} <b>${pal.work[w.id]}</b></span>`)
    .join("") || `<span class="muted">aucune</span>`;
  const tiers = TIER_CATS.map(c => { const t = pal.tiers && pal.tiers[c.key]; return t ? `<span class="pm-tag">${c.label} <b class="${tierClass(t)}">${t}</b></span>` : ""; }).filter(Boolean).join("");
  const stats = [];
  if (pal.level != null) stats.push(`Niv. ${pal.level}`);
  if (pal.rarityCategory) stats.push(`${pal.rarityCategory} · rareté ${pal.rarity}`);
  if (pal.captureRate != null) stats.push(`Capture ×${pal.captureRate}`);
  if (pal.zukan != null) stats.push(`Paldeck #${pal.zukan}`);
  if (pal.nightWorker) stats.push("🌙 Nuit");
  const drops = (pal.drops || []).map(d => `<li>${d.item} <span class="muted">×${d.amount} · ${d.rate}</span></li>`).join("");
  const link = pal.slug ? `<a href="https://palworld.gg/pal/${pal.slug}" target="_blank" rel="noopener">Fiche palworld.gg ↗</a>` : "";
  body.innerHTML = `
    <div class="pm-head">${iconHtml}<div><div class="pm-name">${pal.name}</div><div class="pm-el">${elementChipsHtml(pal)}</div></div></div>
    ${stats.length ? `<div class="pm-stats">${stats.map(s => `<span>${s}</span>`).join("")}</div>` : ""}
    <div class="pm-sub">Compétences de travail</div><div class="pm-skills">${skills}</div>
    ${tiers ? `<div class="pm-sub">Rangs (palworld.gg)</div><div class="pm-tags">${tiers}</div>` : ""}
    ${drops ? `<div class="pm-sub">Butin</div><ul class="pm-drops">${drops}</ul>` : ""}
    ${link ? `<div class="pm-linkrow">${link}</div>` : ""}`;
  modal.hidden = false;
  modal.querySelector(".pm-close")?.focus();
}
function closePalModal() { const m = document.getElementById("pal-modal"); if (m) m.hidden = true; }

function active() { return store.camps[store.activeId]; }

// ===== Quantités (Pals / Constructions / Boîte) =====
function palQty(id) { return active().pals[id] || 0; }
function structQty(id) { return active().structures[id] || 0; }
function boxQty(id) { return palBoxCounts()[id] || 0; }
function totalPals() { return Object.values(active().pals).reduce((a, b) => a + b, 0); }
function totalBox() { return Object.values(palBoxCounts()).reduce((a, b) => a + b, 0); }
function isFull() { return totalPals() >= active().limit; }

function setPalQty(id, q) {
  if (readOnly) return;
  const m = active().pals;
  if (q > 0) m[id] = q; else delete m[id];
  saveStore(); renderAll();
}
function setStructQty(id, q) {
  if (readOnly) return;
  const m = active().structures;
  if (q > 0) m[id] = q; else delete m[id];
  saveStore(); renderAll();
}
// Ajuste à la main la quantité d'un palId à la valeur cible q, en RÉCONCILIANT les
// entrées individuelles : on ajoute des entrées synthétiques si q monte ; si q baisse,
// on retire d'abord les entrées manuelles/synthétiques (sans données de save), puis, en
// dernier recours, les entrées importées (préserve level/étoiles/passifs autant que possible).
function setBoxQty(id, q) {
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
function addPal(id) {
  if (isFull()) { flashLimit(); return; }
  setPalQty(id, palQty(id) + 1);
}
function addStruct(id) { setStructQty(id, structQty(id) + 1); }
function addBox(id) { setBoxQty(id, boxQty(id) + 1); }

// ===== Code couleur des niveaux =====
// Échelle des compétences de travail 1–10 (Palworld 1.0), regroupée en 5 paliers de couleur.
function levelTier(lvl) { return lvl <= 0 ? 0 : Math.min(5, Math.ceil(lvl / 2)); }
function levelClass(lvl) { return "lvl-" + levelTier(lvl); }
const TIER_NAMES = { 0: "Manquant", 1: "Faible", 2: "Moyen", 3: "Bon", 4: "Fort", 5: "Élite" };
function levelName(lvl) { return TIER_NAMES[levelTier(lvl)]; }

// Icône de vignette par catégorie de construction
const CATEGORY_ICON = {
  "Production": "🔨", "Nourriture": "🍳", "Infrastructure": "⚡", "Défense": "🛡️",
  "Stockage": "📦", "Éclairage": "💡", "Pals": "🥚", "Médical": "💊", "Autre": "🔧",
};

// Éléments (couleur + nom FR) pour la Palpedia
const ELEMENT_META = {
  Neutral: { fr: "Neutre", c: "#b9c2d0" }, Fire: { fr: "Feu", c: "#ff6b3d" },
  Water: { fr: "Eau", c: "#3fa9e0" }, Electric: { fr: "Foudre", c: "#f5c542" },
  Ice: { fr: "Glace", c: "#7fe3e3" }, Ground: { fr: "Terre", c: "#c58a55" },
  Dark: { fr: "Ténèbres", c: "#9a6bd6" }, Dragon: { fr: "Dragon", c: "#7b6bff" },
  Grass: { fr: "Herbe", c: "#7cc44d" },
};
const ELEMENT_ORDER = ["Neutral", "Fire", "Water", "Electric", "Ice", "Ground", "Dark", "Dragon", "Grass"];
function palElements(pal) { return (pal && pal.elements) || []; }
function elementChipsHtml(pal) {
  return palElements(pal).map(e => {
    const m = ELEMENT_META[e] || { fr: e, c: "#888" };
    return `<span class="el-chip" style="background:${m.c}" title="Élément : ${m.fr}">${m.fr}</span>`;
  }).join("");
}

// ===== Rangs de tier-list (palworld.gg) =====
const TIER_CATS = [
  { key: "overall",     label: "Global",  speed: null },
  { key: "workers",     label: "Workers", speed: null },
  { key: "combat",      label: "Combat",  speed: null },
  { key: "flyingMount", label: "Vol",     speed: "flying" },
  { key: "groundMount", label: "Sol",     speed: "ground" },
];
function tierClass(t) { return t ? "tier-" + t : "tier-none"; }
const TIER_RANK = { S: 0, A: 1, B: 2, C: 3, D: 4 };   // pour le tri (S en premier)
let pediaSort = { key: "name", dir: 1 };              // dir: 1 = croissant, -1 = décroissant

let flashTimer = null;
function flashLimit() {
  const el = document.getElementById("limit-msg");
  el.textContent = `Limite du camp atteinte (${active().limit}). Augmente la limite ou retire un Pal.`;
  el.classList.add("show");
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el.classList.remove("show"), 3000);
}

// ===== Calcul du récapitulatif (offre vs demande), en local =====
function computeSummary() {
  const palsById = Object.fromEntries(PALS.map(p => [p.id, p]));
  const structById = Object.fromEntries(STRUCTURES.map(s => [s.id, s]));
  const palMembers = Object.entries(active().pals)
    .map(([id, q]) => [palsById[id], q]).filter(([p]) => p);
  const structMembers = Object.entries(active().structures)
    .map(([id, q]) => [structById[id], q]).filter(([s]) => s);

  const campSize = palMembers.reduce((a, [, q]) => a + q, 0);
  const nightWorkers = palMembers.reduce((a, [p, q]) => a + (p.nightWorker ? q : 0), 0);
  const structureCount = structMembers.reduce((a, [, q]) => a + q, 0);

  let uncovered = 0;
  const summary = WORK_TYPES.map(w => {
    const wid = w.id;
    const pals = palMembers
      .filter(([p]) => (p.work[wid] || 0) > 0)
      .map(([p, q]) => ({ id: p.id, name: p.name, level: p.work[wid], qty: q }))
      .sort((a, b) => b.level - a.level || a.name.localeCompare(b.name, "fr"));
    const structures = structMembers
      .filter(([s]) => s.requires.includes(wid))
      .map(([s, q]) => ({ id: s.id, name: s.name, qty: q }))
      .sort((a, b) => a.name.localeCompare(b.name, "fr"));

    const count = pals.reduce((a, c) => a + c.qty, 0);
    const demand = structures.reduce((a, c) => a + c.qty, 0);
    const covered = demand === 0 || count > 0;
    if (demand > 0 && count === 0) uncovered++;

    return {
      id: wid, label: w.label, icon: w.icon,
      count, maxLevel: pals.reduce((m, c) => Math.max(m, c.level), 0),
      pals, demand, structures, covered,
    };
  });

  return { summary, campSize, nightWorkers, structureCount, uncovered };
}

// ===== Initialisation =====
function init() {
  document.getElementById("pals-total").textContent = PALS.length;
  document.getElementById("structs-total").textContent = STRUCTURES.length;

  const fw = document.getElementById("filter-work");
  WORK_TYPES.forEach(w => fw.add(new Option(`${w.icon} ${w.label}`, w.id)));
  const fc = document.getElementById("filter-category");
  [...new Set(STRUCTURES.map(s => s.category))].sort((a, b) => a.localeCompare(b, "fr"))
    .forEach(cat => fc.add(new Option(cat, cat)));

  document.getElementById("search").addEventListener("input", renderPalCatalog);
  fw.addEventListener("change", renderPalCatalog);
  document.getElementById("night-only").addEventListener("change", renderPalCatalog);
  document.getElementById("search-struct").addEventListener("input", renderStructCatalog);
  fc.addEventListener("change", renderStructCatalog);
  document.getElementById("search-box").addEventListener("input", renderBoxCatalog);
  document.getElementById("owned-only").addEventListener("change", renderBoxCatalog);
  document.getElementById("suggest-btn").addEventListener("click", renderSuggestion);
  document.getElementById("box-import-btn").addEventListener("click", () => toggleImportPanel());
  document.getElementById("import-cancel").addEventListener("click", () => toggleImportPanel(false));
  document.getElementById("import-run").addEventListener("click", runBoxImport);
  document.getElementById("sav-file").addEventListener("change", onSavFile);
  document.getElementById("sav-apply").addEventListener("click", applySavImport);
  document.querySelectorAll('input[name="sav-import-mode"]').forEach(el =>
    el.addEventListener("change", () => { if (_savPending) renderSavPreview(); }));
  ["opt-import-pals", "opt-import-camps"].forEach(id =>
    document.getElementById(id)?.addEventListener("change", () => { if (_savPending) renderSavPreview(); }));
  document.querySelectorAll(".tab").forEach(t =>
    t.addEventListener("click", () => switchTab(t.dataset.tab)));
  document.querySelectorAll(".view-btn").forEach(b =>
    b.addEventListener("click", () => switchView(b.dataset.view)));
  document.getElementById("pedia-search").addEventListener("input", renderPalpedia);
  const pw = document.getElementById("pedia-work");
  WORK_TYPES.forEach(w => pw.add(new Option(`${w.icon} ${w.label}`, w.id)));
  const pe = document.getElementById("pedia-element");
  ELEMENT_ORDER.forEach(e => pe.add(new Option(ELEMENT_META[e].fr, e)));
  pw.addEventListener("change", renderPalpedia);
  pe.addEventListener("change", renderPalpedia);
  document.getElementById("pedia-owned").addEventListener("change", renderPalpedia);
  document.querySelectorAll(".pedia-table th[data-sort]").forEach(th =>
    th.addEventListener("click", () => setPediaSort(th.dataset.sort)));
  document.getElementById("drop-search").addEventListener("input", renderDrops);

  document.getElementById("clear-camp").addEventListener("click", () => {
    if (readOnly) return;
    if (confirm("Vider ce camp (Pals et constructions) ?")) {
      pushUndo("camp vidé");
      active().pals = {}; active().structures = {}; saveStore(); renderAll();
    }
  });
  const limitInput = document.getElementById("limit-input");
  limitInput.addEventListener("change", () => {
    if (readOnly) return;
    let v = parseInt(limitInput.value, 10);
    if (!Number.isFinite(v) || v < 1) v = 1;
    active().limit = v; limitInput.value = v; saveStore(); renderAll();
  });

  document.getElementById("camp-select").addEventListener("change", e => {
    store.activeId = e.target.value; saveStore(); renderAll();
  });
  document.getElementById("camp-new").addEventListener("click", newCamp);
  document.getElementById("camp-rename").addEventListener("click", renameCamp);
  document.getElementById("camp-delete").addEventListener("click", deleteCamp);

  // Espaces partagés (cloud)
  document.getElementById("space-create").addEventListener("click", () => {
    if (confirm("Créer un espace partagé à partir de tes camps actuels ?\n\nTu obtiendras un lien à envoyer UNIQUEMENT aux amis avec qui tu joues : eux seuls verront et modifieront ces camps.")) {
      window.PWCloud?.createSharedSpace(store);
    }
  });
  document.getElementById("space-join").addEventListener("click", () => {
    const input = (prompt("Colle le lien de partage (ou le code) reçu d'un ami :") || "").trim();
    if (!input) return;
    let id = input;
    const m = input.match(/[?&]ws=([^&\s]+)/);
    if (m) id = decodeURIComponent(m[1]);
    if (id) window.PWCloud?.join(id);
  });
  document.getElementById("space-leave").addEventListener("click", () => {
    if (confirm("Quitter cet espace partagé et revenir à tes camps privés (sur cet appareil) ?")) {
      window.PWCloud?.leave();
    }
  });
  document.getElementById("space-share").addEventListener("click", async e => {
    if (!syncLink) return;
    const btn = e.currentTarget;
    try {
      await navigator.clipboard.writeText(syncLink);
      const old = btn.textContent;
      btn.textContent = "✓ Lien copié !";
      setTimeout(() => { btn.textContent = old; }, 1800);
    } catch {
      prompt("Copie ce lien et envoie-le à ton groupe :", syncLink);
    }
  });
  document.getElementById("space-share-ro").addEventListener("click", async e => {
    if (!syncRoLink) return;
    const btn = e.currentTarget;
    try {
      await navigator.clipboard.writeText(syncRoLink);
      const old = btn.textContent; btn.textContent = "✓ Copié !";
      setTimeout(() => { btn.textContent = old; }, 1800);
    } catch { prompt("Lien en lecture seule (le destinataire ne pourra pas modifier) :", syncRoLink); }
  });

  // Présence : cliquer pour définir son nom
  document.getElementById("presence").addEventListener("click", promptName);

  // Annuler
  document.getElementById("undo-btn").addEventListener("click", doUndo);

  // Modale détail Pal + raccourcis clavier
  document.querySelectorAll("#pal-modal .pm-close, #pal-modal .pm-backdrop")
    .forEach(el => el.addEventListener("click", closePalModal));
  document.getElementById("pedia-body").addEventListener("click", e => {
    if (e.target.closest("a")) return;
    const tr = e.target.closest("tr[data-pal]");
    if (tr && palsById[tr.dataset.pal]) openPalDetail(palsById[tr.dataset.pal]);
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") closePalModal();
    const tag = (document.activeElement?.tagName || "").toLowerCase();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !["input", "textarea", "select"].includes(tag)) {
      e.preventDefault(); doUndo();
    }
  });

  // PWA / hors-ligne
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

  buildLegend();
  renderAll();
}

function buildLegend() {
  const tiers = [
    { t: 1, r: "1–2", n: "Faible" }, { t: 2, r: "3–4", n: "Moyen" }, { t: 3, r: "5–6", n: "Bon" },
    { t: 4, r: "7–8", n: "Fort" }, { t: 5, r: "9–10", n: "Élite" },
  ];
  document.querySelectorAll(".legend").forEach(legend => {
    legend.querySelectorAll(".legend-item").forEach(e => e.remove());
    tiers.forEach(({ t, r, n }) => {
      const span = document.createElement("span");
      span.className = "legend-item lvl-" + t;
      span.textContent = `${r} · ${n}`;
      legend.appendChild(span);
    });
  });
}

// ===== Icône d'un Pal (image palworld.gg, sinon pastille de repli) =====
// URL dérivée du code interne (BPClass) : T_{code}_icon_normal.png. Couvre tous les
// Pals ayant un `code` (299/300) ; repli sur une pastille sinon.
function palIconUrl(pal) {
  return pal.code ? "https://palworld.gg/images/full_palicon/T_" + pal.code + "_icon_normal.png" : null;
}
function palIconEl(pal) {
  const url = palIconUrl(pal);
  if (url) {
    const img = document.createElement("img");
    img.className = "pal-ic";
    img.loading = "lazy";
    img.alt = pal.name;
    img.src = url;
    img.onerror = () => img.replaceWith(palIconFallback(pal));
    return img;
  }
  return palIconFallback(pal);
}
function palIconFallback(pal) {
  const d = document.createElement("div");
  d.className = "pal-ic fallback";
  d.textContent = (pal.name[0] || "?").toUpperCase();
  return d;
}
function palIconHtml(pal) {
  const url = palIconUrl(pal);
  const init = (pal.name[0] || "?").toUpperCase();
  if (url) return `<img class="pal-ic" loading="lazy" alt="" src="${url}" onerror="this.outerHTML='<span class=\\'pal-ic fallback\\'>${init}</span>'">`;
  return `<span class="pal-ic fallback">${init}</span>`;
}

// ===== Onglets =====
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === tab));
  ["pals", "structures", "box"].forEach(name =>
    document.querySelectorAll(".tab-" + name).forEach(el => el.hidden = name !== tab));
  if (tab !== "box") toggleImportPanel(false);   // referme le panneau d'import
}

// ===== Vues (Assistant de camp / Palpedia) =====
function switchView(view) {
  currentView = view;
  document.querySelectorAll(".view-btn").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  document.querySelectorAll(".view-camp").forEach(el => el.hidden = view !== "camp");
  document.querySelectorAll(".view-palpedia").forEach(el => el.hidden = view !== "palpedia");
  document.querySelectorAll(".view-drops").forEach(el => el.hidden = view !== "drops");
  document.querySelectorAll(".view-import").forEach(el => el.hidden = view !== "import");
  if (view === "palpedia") renderPalpedia();
  else if (view === "drops") renderDrops();
}

// ===== Gestion des camps =====
function newCamp() {
  if (readOnly) return;
  const n = Object.keys(store.camps).length + 1;
  const name = (prompt("Nom du nouveau camp :", "Camp " + n) || "").trim();
  if (!name) return;
  const id = uid();
  store.camps[id] = { name, pals: {}, structures: {}, limit: 15 };
  store.activeId = id; saveStore(); renderAll();
}
function renameCamp() {
  if (readOnly) return;
  const name = (prompt("Renommer le camp :", active().name) || "").trim();
  if (!name) return;
  active().name = name; saveStore(); renderAll();
}
function deleteCamp() {
  if (readOnly) return;
  if (!confirm(`Supprimer le camp « ${active().name} » ?`)) return;
  pushUndo("suppression du camp");
  delete store.camps[store.activeId];
  const ids = Object.keys(store.camps);
  if (ids.length === 0) {
    const id = uid();
    store.camps[id] = { name: "Camp 1", pals: {}, structures: {}, limit: 15 };
    store.activeId = id;
  } else {
    store.activeId = ids[0];
  }
  saveStore(); renderAll();
}

function renderCampSelect() {
  const sel = document.getElementById("camp-select");
  sel.innerHTML = "";
  // Camps utilisateur d'abord, puis bases importées (préfixe 🏕️), triées par index.
  const entries = Object.entries(store.camps).sort((a, b) => {
    const sa = a[1].source === "save", sb = b[1].source === "save";
    if (sa !== sb) return sa ? 1 : -1;
    if (sa && sb) return (a[1].index || 0) - (b[1].index || 0);
    return 0;
  });
  entries.forEach(([id, c]) => {
    const total = Object.values(c.pals).reduce((a, b) => a + b, 0);
    if (c.source === "save") {
      sel.add(new Option(`🏕️ ${c.name} (${c.palCount ?? total} Pals · ${c.machineCount ?? 0} machines)`, id));
    } else {
      const ns = Object.values(c.structures).reduce((a, b) => a + b, 0);
      sel.add(new Option(`${c.name} (${total} Pals · ${ns} constr.)`, id));
    }
  });
  sel.value = store.activeId;
}

// ===== Agencement d'une base importée : repli + édition (machines & affectations) =====
const _cmCollapsed = new Set();          // ids de camps repliés (préférence UI, non persistée)
let _cmSeq = 0;
function synWorkId() { return `synw_${Date.now().toString(36)}_${(_cmSeq++).toString(36)}`; }

// Recalcule les quantités dérivées (pals/structures) + le nombre de machines après une édition,
// puis persiste et rafraîchit toute l'UI (récap, sélecteur, listes).
function cmSync(c) {
  const d = deriveFromMachines(c.machines);
  c.pals = d.pals; c.structures = d.structures;
  c.machineCount = c.machines.length;
  saveStore(); renderAll();
}
function cmGroups(c) {                    // regroupe les machines par nom de station (ordre d'apparition)
  const map = new Map();
  for (const m of c.machines || []) {
    const k = m.stationName || prettyStation(m.station || m.type);
    if (!map.has(k)) map.set(k, { name: k, structId: m.structId ?? null, machines: [] });
    map.get(k).machines.push(m);
  }
  return [...map.values()].sort((a, b) => b.machines.length - a.machines.length || a.name.localeCompare(b.name, "fr"));
}
function cmAddMachine(groupName) {
  const c = active(); if (!c || readOnly) return;
  const g = cmGroups(c).find(x => x.name === groupName); if (!g) return;
  const t = g.machines[0];
  c.machines.push({
    work_id: synWorkId(), type: t.type, station: t.station,
    stationName: t.stationName, structId: t.structId ?? null, slots: t.slots || 1, assigned: [],
  });
  cmSync(c);
}
function cmRemoveMachine(groupName) {
  const c = active(); if (!c || readOnly) return;
  const g = cmGroups(c).find(x => x.name === groupName); if (!g) return;
  // Retire de préférence une machine sans Pal affecté (sinon la dernière du groupe).
  const target = g.machines.find(m => !(m.assigned || []).length) || g.machines[g.machines.length - 1];
  const i = c.machines.indexOf(target);
  if (i >= 0) c.machines.splice(i, 1);
  cmSync(c);
}
function cmDeleteGroup(groupName) {
  const c = active(); if (!c || readOnly) return;
  c.machines = c.machines.filter(m => (m.stationName || prettyStation(m.station || m.type)) !== groupName);
  cmSync(c);
}
function cmUnassign(workId, instId) {
  const c = active(); if (!c || readOnly) return;
  const m = c.machines.find(x => x.work_id === workId); if (!m) return;
  m.assigned = (m.assigned || []).filter(a => a.pal_instance_id !== instId);
  cmSync(c);
}
function cmAssign(workId, boxKey) {
  const c = active(); if (!c || readOnly || !boxKey) return;
  const m = c.machines.find(x => x.work_id === workId); if (!m) return;
  const e = store.palBox[boxKey]; if (!e || !e.palId) return;
  if ((m.assigned || []).length >= (m.slots || 1)) return;
  m.assigned = m.assigned || [];
  m.assigned.push({
    slot: m.assigned.length, pal_instance_id: boxKey,
    palId: e.palId, name: palsById[e.palId] ? palsById[e.palId].name : "?",
  });
  cmSync(c);
}

// Vue camp : agencement d'une base importée (stations + Pals affectés par machine).
// Repliable, et éditable (quantité de machines par station, réaffectation des Pals).
// Masqué pour les camps-compositions utilisateur (source !== "save").
function renderCampMachines() {
  const box = document.getElementById("camp-machines");
  if (!box) return;
  const c = active();
  if (!c || c.source !== "save") { box.hidden = true; box.innerHTML = ""; return; }
  box.hidden = false;
  box.innerHTML = "";
  const collapsed = _cmCollapsed.has(store.activeId);

  // En-tête cliquable (repli).
  const head = document.createElement("button");
  head.type = "button";
  head.className = "cm-head" + (collapsed ? " collapsed" : "");
  head.setAttribute("aria-expanded", String(!collapsed));
  head.innerHTML = `<span class="cm-caret">${collapsed ? "▸" : "▾"}</span>`
    + `<span class="cm-title">🏗️ Agencement importé</span>`
    + `<span class="cm-sub">🐾 ${c.palCount ?? 0} · 🏗️ ${c.machines.length}</span>`;
  head.onclick = () => {
    if (collapsed) _cmCollapsed.delete(store.activeId); else _cmCollapsed.add(store.activeId);
    renderCampMachines();
  };
  box.appendChild(head);
  if (collapsed) return;

  const body = document.createElement("div");
  body.className = "cm-body";
  const note = document.createElement("div");
  note.className = "camp-machines-note";
  note.textContent = readOnly
    ? "Base lue depuis la sauvegarde (lecture seule)."
    : "Base importée : modifiable ici. ⚠ un réimport de la sauvegarde écrase ces modifications.";
  body.appendChild(note);

  const groups = cmGroups(c);
  if (!groups.length) {
    const empty = document.createElement("div");
    empty.className = "sav-empty";
    empty.textContent = "Aucune machine.";
    body.appendChild(empty);
  }

  // Pals de la boîte déjà affectés quelque part dans CETTE base (exclus du sélecteur).
  const usedInst = new Set();
  for (const m of c.machines) for (const a of m.assigned || []) usedInst.add(a.pal_instance_id);
  const boxCandidates = Object.entries(store.palBox)
    .filter(([k, e]) => e && e.palId && palsById[e.palId] && !usedInst.has(k))
    .map(([k, e]) => ({ key: k, name: palsById[e.palId].name, level: e.level }))
    .sort((a, b) => a.name.localeCompare(b.name, "fr") || (b.level || 0) - (a.level || 0));

  for (const g of groups) body.appendChild(cmGroupEl(g, boxCandidates));
  box.appendChild(body);
}

// Un groupe de station : en-tête (nom + stepper de quantité) + une ligne par machine (slots + Pals).
function cmGroupEl(g, boxCandidates) {
  const wrap = document.createElement("div");
  wrap.className = "cm-group";

  const gh = document.createElement("div");
  gh.className = "cm-group-head";
  const struct = g.structId != null && structById[g.structId] ? structById[g.structId] : null;
  gh.innerHTML = `<span class="cm-station">${escHtml(g.name)}</span>`
    + (struct ? `<span class="cm-struct" title="Construction reconnue (récap offre/demande)">↔ ${escHtml(struct.name)}</span>` : "")
    + (readOnly ? `<span class="cm-count">×${g.machines.length}</span>` : "");
  if (!readOnly) {
    gh.appendChild(stepperOrAdd("camp", g.machines.length,
      () => cmAddMachine(g.name), () => cmRemoveMachine(g.name), () => cmDeleteGroup(g.name), false));
  }
  wrap.appendChild(gh);

  const ul = document.createElement("ul");
  ul.className = "cm-machines";
  g.machines.forEach((m, i) => ul.appendChild(cmMachineEl(m, i, boxCandidates)));
  wrap.appendChild(ul);
  return wrap;
}

// Une machine : ses slots + les Pals affectés (retirables) + un sélecteur pour affecter un Pal.
function cmMachineEl(m, i, boxCandidates) {
  const li = document.createElement("li");
  li.className = "cm-machine";
  const slots = m.slots || 1;
  const assigned = m.assigned || [];

  const meta = document.createElement("span");
  meta.className = "cm-slots";
  meta.textContent = slots > 1 ? `Poste ${i + 1} · ${assigned.length}/${slots}` : `Poste ${i + 1}`;
  li.appendChild(meta);

  const chips = document.createElement("span");
  chips.className = "cm-chips";
  if (!assigned.length) {
    const e = document.createElement("span");
    e.className = "sav-empty";
    e.textContent = "libre";
    chips.appendChild(e);
  }
  for (const a of assigned) {
    const chip = document.createElement("span");
    chip.className = "sav-chip cm-chip";
    chip.textContent = a.name || "?";
    if (!readOnly) {
      const x = document.createElement("button");
      x.type = "button";
      x.className = "cm-x";
      x.title = "Retirer ce Pal";
      x.setAttribute("aria-label", "Retirer " + (a.name || "ce Pal"));
      x.textContent = "✕";
      x.onclick = () => cmUnassign(m.work_id, a.pal_instance_id);
      chip.appendChild(x);
    }
    chips.appendChild(chip);
  }
  li.appendChild(chips);

  if (!readOnly && assigned.length < slots) {
    if (boxCandidates.length) {
      const sel = document.createElement("select");
      sel.className = "cm-assign";
      sel.innerHTML = `<option value="">+ affecter…</option>`
        + boxCandidates.map(p =>
            `<option value="${escHtml(p.key)}">${escHtml(p.name)}${p.level ? ` (niv. ${p.level})` : ""}</option>`).join("");
      sel.onchange = () => cmAssign(m.work_id, sel.value);
      li.appendChild(sel);
    } else {
      const hint = document.createElement("span");
      hint.className = "cm-hint";
      hint.textContent = "boîte vide — importe des Pals pour affecter";
      li.appendChild(hint);
    }
  }
  return li;
}

// ===== Lignes Pal / Construction =====
function palRow(pal, mode) {
  const q = mode === "box" ? boxQty(pal.id) : palQty(pal.id);
  const li = document.createElement("li");
  li.className = "pal-row" + ((mode === "catalog" || mode === "box") && q > 0 ? " in-camp" : "");

  const icon = palIconEl(pal);
  li.appendChild(icon);

  const info = document.createElement("div");
  info.className = "info";
  const night = pal.nightWorker ? ` <span class="night" title="Travailleur de nuit">🌙</span>` : "";
  const wt = pal.tiers && pal.tiers.workers;
  const tier = wt
    ? ` <span class="tier-txt ${tierClass(wt)}" title="Rang Workers (palworld.gg)">Tier ${wt}</span>`
    : "";
  info.innerHTML = `<div class="name">${pal.name}${night}${tier}</div>`;
  const openDetail = () => openPalDetail(pal);
  info.tabIndex = 0; info.setAttribute("role", "button"); info.setAttribute("aria-label", "Détails de " + pal.name);
  info.onclick = openDetail;
  info.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(); } };
  icon.style.cursor = "pointer"; icon.onclick = openDetail;
  li.appendChild(info);

  const skills = document.createElement("div");
  skills.className = "skills";
  WORK_TYPES.forEach(w => {
    const lvl = pal.work[w.id] || 0;
    if (lvl > 0) {
      const chip = document.createElement("span");
      chip.className = "skill-chip " + levelClass(lvl);
      chip.title = `${w.label} — niv. ${lvl} (${levelName(lvl)})`;
      chip.innerHTML = `${w.icon} <b>${lvl}</b>`;
      skills.appendChild(chip);
    }
  });
  li.appendChild(skills);

  if (mode === "box") {
    li.appendChild(stepperOrAdd("box", q, () => addBox(pal.id), d => setBoxQty(pal.id, q + d), () => setBoxQty(pal.id, 0), false));
  } else {
    li.appendChild(stepperOrAdd(mode, q, () => addPal(pal.id), d => setPalQty(pal.id, q + d), () => setPalQty(pal.id, 0), isFull()));
  }
  return li;
}

function structRow(st, mode) {
  const q = structQty(st.id);
  const li = document.createElement("li");
  li.className = "pal-row" + (mode === "catalog" && q > 0 ? " in-camp" : "");

  const tile = document.createElement("div");
  tile.className = "pal-ic fallback struct-ic";
  tile.textContent = CATEGORY_ICON[st.category] || "🏗️";
  tile.title = st.category;
  li.appendChild(tile);

  const info = document.createElement("div");
  info.className = "info";
  info.innerHTML = `<div class="name">${st.name}</div><div class="cat">${st.category}</div>`;
  li.appendChild(info);

  const reqs = document.createElement("div");
  reqs.className = "skills";
  st.requires.forEach(wid => {
    const w = workById[wid];
    if (!w) return;
    const chip = document.createElement("span");
    chip.className = "req-chip";
    chip.title = `Requiert : ${w.label}`;
    chip.innerHTML = `${w.icon} ${w.label}`;
    reqs.appendChild(chip);
  });
  if (st.requires.length === 0) reqs.innerHTML = `<span class="req-chip none">aucune</span>`;
  li.appendChild(reqs);

  li.appendChild(stepperOrAdd(mode, q, () => addStruct(st.id), d => setStructQty(st.id, q + d), () => setStructQty(st.id, 0), false));
  return li;
}

function stepperOrAdd(mode, q, onAdd, onStep, onDel, disabledAdd) {
  const actions = document.createElement("div");
  actions.className = "actions";
  if (mode === "catalog") {
    const btn = document.createElement("button");
    btn.className = "btn btn-add";
    btn.textContent = q > 0 ? `+ (${q})` : "+";
    btn.disabled = disabledAdd;
    btn.title = disabledAdd ? "Limite du camp atteinte" : "Ajouter";
    btn.setAttribute("aria-label", disabledAdd ? "Limite atteinte" : "Ajouter");
    btn.onclick = onAdd;
    actions.appendChild(btn);
  } else {
    const stepper = document.createElement("div");
    stepper.className = "stepper";
    stepper.innerHTML = `
      <button class="btn-step" data-act="dec" aria-label="Retirer un exemplaire">−</button>
      <span class="qty">${q}</span>
      <button class="btn-step" data-act="inc" aria-label="Ajouter un exemplaire" ${disabledAdd ? "disabled" : ""}>+</button>
      <button class="btn-step btn-x" data-act="del" title="Retirer" aria-label="Tout retirer">×</button>`;
    stepper.querySelector('[data-act="dec"]').onclick = () => onStep(-1);
    stepper.querySelector('[data-act="inc"]').onclick = onAdd;
    stepper.querySelector('[data-act="del"]').onclick = onDel;
    actions.appendChild(stepper);
  }
  return actions;
}

// ===== Catalogues =====
function renderPalCatalog() {
  const q = document.getElementById("search").value.trim().toLowerCase();
  const wf = document.getElementById("filter-work").value;
  const nightOnly = document.getElementById("night-only").checked;
  const list = document.getElementById("pal-list");
  list.innerHTML = "";

  const filtered = PALS.filter(p =>
    (!q || p.name.toLowerCase().includes(q)) &&
    (!wf || (p.work[wf] || 0) > 0) &&
    (!nightOnly || p.nightWorker)
  ).sort((a, b) => a.name.localeCompare(b.name, "fr"));

  if (!filtered.length) { list.innerHTML = `<li class="empty">Aucun Pal trouvé.</li>`; return; }
  filtered.forEach(p => list.appendChild(palRow(p, "catalog")));
}

function renderStructCatalog() {
  const q = document.getElementById("search-struct").value.trim().toLowerCase();
  const cf = document.getElementById("filter-category").value;
  const list = document.getElementById("struct-list");
  list.innerHTML = "";

  const filtered = STRUCTURES.filter(s =>
    (!q || s.name.toLowerCase().includes(q)) &&
    (!cf || s.category === cf)
  ).sort((a, b) => a.name.localeCompare(b.name, "fr"));

  if (!filtered.length) { list.innerHTML = `<li class="empty">Aucune construction trouvée.</li>`; return; }
  filtered.forEach(s => list.appendChild(structRow(s, "catalog")));
}

function renderBoxCatalog() {
  const q = document.getElementById("search-box").value.trim().toLowerCase();
  const ownedOnly = document.getElementById("owned-only").checked;
  const list = document.getElementById("box-list");
  list.innerHTML = "";

  const filtered = PALS.filter(p =>
    (!q || p.name.toLowerCase().includes(q)) &&
    (!ownedOnly || boxQty(p.id) > 0)
  ).sort((a, b) => a.name.localeCompare(b.name, "fr"));

  if (!filtered.length) { list.innerHTML = `<li class="empty">Aucun Pal trouvé.</li>`; return; }
  filtered.forEach(p => list.appendChild(palRow(p, "box")));
}

// ===== Import de la boîte (format CoWork "palbox.csv" ou liste libre) =====
// Table nom de code interne Palworld (BPClass) -> nom d'affichage.
// Base automatique : le champ `code` de chaque Pal (data.js, issu de palworld.gg) — couvre
// tous les Pals 1.0 et leurs variantes. Complétée/surchargée par les entrées manuelles
// ci-dessous (au cas où un export CoWork utiliserait un code différent).
const CODENAME_OVERRIDES = {
  PinkCat: "Cattiva", NegativeKoala: "Depresso", Boar: "Rushoar", TentacleTurtle: "Turtacle",
  SheepBall: "Lamball", ChickenPal: "Chikipi", Carbunclo: "Lifmunk", Kitsunebi: "Foxparks",
  BluePlatypus: "Fuack", ElecCat: "Sparkit", Monkey: "Tanzee", FlameBambi: "Rooby",
  Penguin: "Pengullet", Hedgehog: "Jolthog", PlantSlime: "Gumoss", CuteFox: "Vixy",
  WizardOwl: "Hoocrates", Ganesha: "Teafant", WoolFox: "Cremis", DreamDemon: "Daedream",
  NightFox: "Nox", NegativeOctopus: "Killamari", Bastet: "Mau", FlyingManta: "Celaray",
  Garm: "Direhowl", ColorfulBird: "Tocotoco", FlowerRabbit: "Flopie", CowPal: "Mozzarina",
  LittleBriarRose: "Bristla", SharkKid: "Gobfin", WindChimes: "Hangyu", BerryGoat: "Caprity",
  Alpaca: "Melpaca", Deer: "Eikthyrdeer", Deer_Ground: "Eikthyrdeer Terra", HawkBird: "Nitewing",
  PinkRabbit: "Ribbuny", CuteButterfly: "Cinnamoth", FlameBuffalo: "Arsox", LizardMan: "Leezpunk",
  Werewolf: "Loupmoon", Eagle: "Galeclaw", Gorilla: "Gorirat", SoldierBee: "Beegarde",
  QueenBee: "Elizabee", NaughtyCat: "Grintale", WeaselDragon: "Chillet", FireKirin: "Pyrin",
  IceDeer: "Reindrix", FlowerDinosaur: "Dinossom", Serpent: "Surfent", LavaGirl: "Flambelle",
  BirdDragon: "Vanwyrm", Kelpie: "Kelpsea", BlueDragon: "Azurobe", LazyDragon: "Relaxaurus",
  SakuraSaurus: "Broncherry", CatVampire: "Felbat", HadesBird: "Helzephyr", KendoFrog: "Croajiro",
  DarkAlien: "Xenovader", PurpleSpider: "Tarantriss", JellyfishGhost: "Jellroy",
  JellyfishFairy: "Jelliette", DarkCrow: "Cawgnito", LizardMan_Fire: "Leezpunk Ignis",
};
// code (BPClass) -> nom, pour tous les Pals ayant un `code`, surchargé par les entrées manuelles.
const CODENAME_TO_NAME = Object.assign(
  Object.fromEntries(PALS.filter(p => p.code).map(p => [p.code, p.name])),
  CODENAME_OVERRIDES
);
// Entités non-Pal (humains/PNJ capturés) à ignorer.
const IMPORT_HUMANS = /^(Hunter|.*Soldier|SalesPerson|.*Merchant|.*NPC)/i;

// Analyse le texte collé et renvoie {counts:{id:qty}, unmatched:[], humans, species, total}.
function parseBoxImport(text) {
  const idByName = Object.fromEntries(PALS.map(p => [p.name.toLowerCase(), p.id]));
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const byName = {};
  const unmatched = new Set();
  let humans = 0;

  const header = (lines[0] || "").toLowerCase();
  const isCsv = header.includes("species_count") || /(^|,)name(,|$)/.test(header);

  if (isCsv) {
    const cols = lines[0].split(",").map(s => s.trim().toLowerCase());
    const iName = cols.indexOf("name");
    const iCount = cols.indexOf("species_count");
    const seen = new Set();
    for (const line of lines.slice(1)) {
      const c = line.split(",");
      const internal = (c[iName] || "").trim();
      if (!internal || seen.has(internal)) continue;   // species_count est constant par nom
      seen.add(internal);
      const count = parseInt(c[iCount], 10) || 0;
      const base = internal.replace(/^BOSS_/, "");      // fusionne l'alpha dans l'espèce
      const disp = CODENAME_TO_NAME[base];              // Pal connu ? (prioritaire)
      if (disp) { byName[disp] = (byName[disp] || 0) + count; continue; }
      if (IMPORT_HUMANS.test(base)) { humans += count; continue; }   // sinon, humain/PNJ ?
      unmatched.add(internal);
    }
  } else {
    // Liste libre : "Nom xN", "Nom, N", "N Nom" ou "Nom"
    for (const line of lines) {
      let m = line.match(/^(.+?)[\s,]*(?:[x×]\s*)?(\d+)\s*$/i) || line.match(/^(\d+)\s+(.+)$/);
      let name, qty;
      if (m && /^\d+$/.test(m[1])) { qty = parseInt(m[1], 10); name = m[2]; }
      else if (m) { name = m[1]; qty = parseInt(m[2], 10) || 1; }
      else { name = line; qty = 1; }
      name = name.trim();
      const disp = CODENAME_TO_NAME[name] || name;     // accepte aussi les noms de code
      byName[disp] = (byName[disp] || 0) + qty;
    }
  }

  const counts = {};
  for (const [disp, c] of Object.entries(byName)) {
    const id = idByName[disp.toLowerCase()];
    if (id && c > 0) counts[id] = (counts[id] || 0) + c;
    else if (!id) unmatched.add(disp);
  }
  return {
    counts, unmatched: [...unmatched], humans,
    species: Object.keys(counts).length,
    total: Object.values(counts).reduce((a, b) => a + b, 0),
  };
}

function runBoxImport() {
  if (readOnly) return;
  const text = document.getElementById("import-text").value;
  const mode = document.querySelector('input[name="import-mode"]:checked')?.value || "replace";
  const report = document.getElementById("import-report");
  if (!text.trim()) { report.textContent = "Colle d'abord une liste ou l'export CoWork."; return; }

  const r = parseBoxImport(text);
  if (r.species === 0) {
    report.innerHTML = `<span class="imp-ko">Aucun Pal reconnu.</span> Vérifie le format collé.`;
    return;
  }
  pushUndo(mode === "replace" ? "import (remplacement)" : "import (ajout)");
  if (mode === "replace") store.palBox = {};
  // L'import CoWork n'a pas d'instance_id : on crée des entrées synthétiques (quantités).
  for (const [id, c] of Object.entries(r.counts)) {
    for (let i = 0; i < c; i++)
      store.palBox[synKey()] = { palId: id, level: null, stars: 0, passives: [], manual: true };
  }
  touchBox();
  saveStore();

  let msg = `<span class="imp-ok">✓ ${r.species} espèces · ${r.total} Pals chargés</span> (${mode === "replace" ? "remplacement" : "ajout"}).`;
  if (r.humans) msg += ` ${r.humans} humain(s)/PNJ ignoré(s).`;
  if (r.unmatched.length) msg += `<br><span class="imp-warn">Non reconnus (ignorés) : ${r.unmatched.join(", ")}</span>`;
  report.innerHTML = msg;
  renderAll();
}

function toggleImportPanel(show) {
  const p = document.getElementById("import-panel");
  p.hidden = show === undefined ? !p.hidden : !show;
}

// ===== Import depuis une sauvegarde .sav (parseur WASM, 100% navigateur) =====
// Réutilise la table CODENAME_TO_NAME et le filtre humains de l'import CoWork,
// pour rester cohérent avec le format de la boîte (entrées individuelles, cf. migrateBox).
let _saveParser = null;
let _savPending = null; // résultat mappé en attente de validation

// Échappe le HTML (valeurs issues du fichier .sav = non maîtrisées).
function escHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Correspondance id de poste de travail (assign_define_data_id sans suffixe _N) -> nom FR en jeu.
// Sources : localisation FR officielle (oMaN-Rod/palworld-save-pal, data/json/l10n/fr) pour les
// entrées principales ; noms datminés (PalworldModding/Docs) traduits par analogie de famille pour
// les variantes hors localisation (générateurs II/III, sphères « supérieures », armes « propres »…).
// Univers des ids = c2t-r/PalworldData, DataTable/MapObject/MapObjectAssignData.json.
// Maintenance : ajouter une ligne ici quand un id inconnu apparaît (voir prettyStation, console).
const STATION_NAMES = {
  BlastFurnace: "Fournaise de fortune",
  BlastFurnace2: "Fournaise améliorée",
  BlastFurnace3: "Fournaise électrique",
  BlastFurnace4: "Fournaise géante",
  BlastFurnace5: "Fournaise (V)",
  BreedFarm: "Élevage",
  CampFire: "Feu de camp",
  CampFire_Test: "Feu de camp",
  CookingStove: "Marmite",
  Cooler: "Climatiseur",
  CoolerBox: "Glacière",
  CopperPit: "Carrière de cuivre",
  CopperPit_2: "Carrière de cuivre II",
  Crusher: "Concasseur",
  DefenseBowGun: "Arbalète montée",
  DefenseGatlingGun: "Mitrailleuse Gatling montée",
  DefenseMachinegun: "Mitrailleuse montée",
  DefenseMinigun: "Minigun monté",
  DefenseMissile: "Lance-missiles monté",
  DefenseWait: "Sac de sable",
  ElectricCooler: "Climatiseur électrique",
  ElectricGenerator: "Générateur",
  ElectricGenerator2: "Générateur II",
  ElectricGenerator3: "Générateur III",
  ElectricGenerator_Slave: "Générateur (poste secondaire)",
  ElectricHatchingPalEgg: "Incubateur électrique",
  ElectricHeater: "Chauffage électrique",
  ElectricKitchen: "Cuisine électrique",
  Factory_Comfortable_01: "Chaîne de production (variante)",
  Factory_Comfortable_02: "Chaîne de production (variante) II",
  Factory_Hard_01: "Établi de qualité",
  Factory_Hard_02: "Chaîne de production",
  Factory_Hard_03: "Chaîne de production II",
  FarmBlockV2_Berries: "Plantation de baies",
  FarmBlockV2_Grade01: "Plantation",
  FarmBlockV2_Grade02: "Plantation",
  FarmBlockV2_Grade03: "Plantation",
  FarmBlockV2_Lettuce: "Plantation de laitue",
  FarmBlockV2_tomato: "Plantation de tomates",
  FarmBlockV2_wheet: "Plantation de blé",
  FastTravelPoint: "Statue du Grand Aigle",
  FlourMill: "Broyeur",
  FoliageLogTest: "Arbre (bûcheronnage)",
  HatchingPalEgg: "Incubateur",
  Heater: "Chauffage",
  HighTechKitchen: "Cuisine high-tech",
  Light_FirePlace01: "Cheminée en briques",
  Light_FirePlace02: "Cheminée",
  MedicineFacility_01: "Table pharmaceutique archaïque",
  MedicineFacility_02: "Table pharmaceutique électrique",
  MedicineFacility_03: "Table pharmaceutique avancée",
  MonsterFarm: "Exploitation",
  PalStorage: "Boîte à Pals",
  Refrigerator: "Réfrigérateur",
  RepairBench: "Banc de réparation",
  SphereFactory_Black_01: "Établi pour sphères",
  SphereFactory_Black_02: "Chaîne de production de sphères",
  SphereFactory_Black_03: "Chaîne de production de sphères II",
  SphereFactory_White_01: "Établi supérieur pour sphères",
  SphereFactory_White_02: "Chaîne supérieure de sphères",
  SphereFactory_White_03: "Chaîne supérieure de sphères II",
  StationDeforest2: "Scierie",
  StonePit: "Carrière",
  Torch: "Torche sur pied",
  WallTorch: "Torche murale",
  WeaponFactory_Base: "Établi pour armes (base)",
  WeaponFactory_Clean_01: "Établi pour armes (avancé)",
  WeaponFactory_Clean_02: "Chaîne d'armes (avancée)",
  WeaponFactory_Clean_03: "Chaîne d'armes (avancée) II",
  WeaponFactory_Dirty_01: "Établi pour armes",
  WeaponFactory_Dirty_02: "Chaîne de production d’armes",
  WeaponFactory_Dirty_03: "Chaîne de production d’armes II",
  WeaponFactry: "Établi pour armes",
  Well: "Puits",
  WoodCrusher: "Table de démantèlement du bois",
  WorkBench: "Établi de fortune",
  WorkBench_SkillCard: "Établi (cartes de compétence)",
  WorkBench_SkillUnlock: "Établi pour équipement de Pal",
};

// Gisements naturels : ~18 ids DamagableRock0001..DamagableRock_PV -> même nom (règle de préfixe).
const STATION_PREFIXES = [["DamagableRock", "Gisement de minerai"]];

// id de poste -> nom FR en jeu. Repli : rend lisible un id inconnu
// ("StationDeforestX" -> "Station Deforest X") et le journalise pour l'ajouter à la table.
function prettyStation(s) {
  if (!s) return "?";
  if (STATION_NAMES[s]) return STATION_NAMES[s];
  for (const [pfx, name] of STATION_PREFIXES) if (s.startsWith(pfx)) return name;
  if (!prettyStation._seen) prettyStation._seen = new Set();
  if (!prettyStation._seen.has(s)) {
    prettyStation._seen.add(s);
    console.info("[camps] poste de travail non mappé :", s);
  }
  return String(s).replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2").replace(/\s+/g, " ").trim();
}

// ===== Mapping poste de travail (station) -> construction de l'app (structId) =====
// Best-effort : sert à dériver les quantités de constructions d'une base importée pour que
// le récapitulatif offre/demande fonctionne. Deux sources combinées :
//  1) nameToStructId : coïncidence EXACTE du nom FR (STATION_NAMES[code] === structures.json name).
//     Couvre ~21 postes gratuitement, se met à jour tout seul si les tables évoluent.
//  2) STATION_STRUCT_OVERRIDE : correspondances manuelles pour les divergences de nom
//     (« Fournaise… » vs « Four… », générateurs, sphères, armes, médicaments…).
// structId nullable : un poste non mappé reste affiché (stationName) mais ne compte pas dans
// les quantités de constructions. Ne mapper QUE les cas sûrs (un mauvais id fausserait le récap).
const nameToStructId = Object.fromEntries(STRUCTURES.map(s => [s.name, s.id]));
const STATION_STRUCT_OVERRIDE = {
  BlastFurnace: 17, BlastFurnace2: 15, BlastFurnace3: 18, BlastFurnace4: 16,
  Cooler: 54, ElectricCooler: 55,
  ElectricGenerator: 53, ElectricGenerator2: 52, ElectricGenerator_Slave: 53,
  FlourMill: 24, StonePit: 4, StationDeforest2: 3,
  RepairBench: 34, WorkBench_SkillUnlock: 30,
  FarmBlockV2_Lettuce: 47, Factory_Hard_01: 33,
  MedicineFacility_01: 35, MedicineFacility_02: 36, MedicineFacility_03: 28,
  SphereFactory_Black_01: 31, SphereFactory_Black_02: 10, SphereFactory_Black_03: 11,
  WeaponFactory_Base: 29, WeaponFactry: 29,
  WeaponFactory_Dirty_01: 29, WeaponFactory_Dirty_02: 7, WeaponFactory_Dirty_03: 8,
  WeaponFactory_Clean_02: 9,
};
function stationStructId(station) {
  if (!station) return null;
  if (station in STATION_STRUCT_OVERRIDE) return STATION_STRUCT_OVERRIDE[station];
  const fr = STATION_NAMES[station];
  return (fr && fr in nameToStructId) ? nameToStructId[fr] : null;
}

// Regroupe les machines d'une base par station : { name, count, structId, pals[] }.
// resolveName(instance_id) -> nom lisible du Pal affecté (ou "?"). Réutilisé par l'aperçu
// d'import ET la vue camp (agencement d'une base importée).
function stationRows(machines, resolveName) {
  const by = {};
  for (const m of machines || []) {
    const name = m.stationName || prettyStation(m.station || m.type);
    const key = name;
    if (!by[key]) by[key] = { name, count: 0, structId: m.structId ?? stationStructId(m.station), pals: [] };
    by[key].count++;
    for (const a of m.assigned || [])
      by[key].pals.push(a.name || (resolveName ? resolveName(a.pal_instance_id) : "?") || "?");
  }
  return Object.values(by).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "fr"));
}

// Rend une table station / Nb / Pals affectés (markup partagé avec l'aperçu d'import).
function stationTableHtml(rows) {
  if (!rows.length) return `<div class="sav-empty">Aucune machine installée.</div>`;
  return `<table class="sav-station-table"><thead><tr>`
    + `<th>Station</th><th title="Nombre d'exemplaires">Nb</th><th>Pals affectés</th>`
    + `</tr></thead><tbody>`
    + rows.map(o => {
        const pals = o.pals.length
          ? o.pals.slice().sort((a, b) => a.localeCompare(b))
              .map(n => `<span class="sav-chip">${escHtml(n)}</span>`).join("")
          : `<span class="sav-empty">—</span>`;
        return `<tr><td class="sav-st-name">${escHtml(o.name)}</td>`
          + `<td class="sav-st-n">${o.count > 1 ? "×" + o.count : ""}</td>`
          + `<td class="sav-st-pals">${pals}</td></tr>`;
      }).join("")
    + `</tbody></table>`;
}

async function getSaveParser(onProgress) {
  if (_saveParser) return _saveParser;
  const mod = await import("./vendor/save-parser/parser.mjs");
  _saveParser = await mod.createPalworldSaveParser({ onProgress });
  return _saveParser;
}

const _idByNameLower = Object.fromEntries(PALS.map(p => [p.name.toLowerCase(), p.id]));

// pals: [{species, level, ivs, ...}] du parseur ->
//   { counts:{id:qty}, items:[{id,name,...détails}], unmatched, humans, species, total }
// counts = ce qui est réellement importé (quantités). items = détail par Pal, pour l'aperçu.
function mapSavePals(pals) {
  const items = [];
  const unmatched = new Set();
  let humans = 0;
  for (const p of pals || []) {
    const sp = (p.species || "").trim();
    if (!sp) continue;
    const base = sp.replace(/^BOSS_/, "");            // fusionne l'alpha dans l'espèce
    const disp = CODENAME_TO_NAME[base];              // Pal connu ?
    if (!disp) {
      if (IMPORT_HUMANS.test(base)) humans++; else unmatched.add(sp);
      continue;
    }
    const id = _idByNameLower[disp.toLowerCase()];
    if (!id) { unmatched.add(disp); continue; }
    items.push({
      id, name: palsById[id] ? palsById[id].name : disp,
      instId: p.instance_id || null,                   // clé stable pour l'upsert au réimport
      species: sp, level: p.level, stars: p.stars || 0,
      ivs: p.ivs || null, gender: p.gender || null,
      passives: p.passives || [], owner_uid: p.owner_uid || "",
    });
  }
  const counts = {};
  for (const it of items) counts[it.id] = (counts[it.id] || 0) + 1;
  return {
    counts, items, unmatched: [...unmatched], humans,
    species: Object.keys(counts).length,
    total: items.length,
  };
}

// Table instance_id -> { palId, name } depuis un résultat de parseur.
// Priorité aux Pals reconnus (mapSavePals) ; repli sur l'espèce brute (nom lisible, palId null).
function buildInstToPal(res, mapped) {
  const inst = {};
  for (const it of (mapped && mapped.items) || [])
    if (it.instId) inst[it.instId] = { palId: it.id, name: it.name };
  for (const p of res.pals || []) {
    if (!p.instance_id || inst[p.instance_id]) continue;
    const base = (p.species || "").replace(/^BOSS_/, "");
    inst[p.instance_id] = { palId: null, name: CODENAME_TO_NAME[base] || p.species || "?" };
  }
  return inst;
}

// Transforme res.camps[] (bases de la save) en camps de l'app (source:"save"), keyés par base_id.
// Chaque base dérive : pals{palId:qty} (Pals affectables recoupés), structures{structId:qty}
// (via stationStructId, best-effort) et machines[] (agencement complet pour l'affichage).
function buildImportedCamps(res, instToPal) {
  const now = Date.now();
  const out = {};
  for (const c of res.camps || []) {
    if (!c.base_id) continue;
    const machines = (c.machines || []).map(m => {
      const structId = stationStructId(m.station);
      const assigned = (m.assigned || []).map(a => {
        const r = instToPal[a.pal_instance_id] || {};
        return { slot: a.slot, pal_instance_id: a.pal_instance_id, palId: r.palId ?? null, name: r.name || "?" };
      });
      return {
        work_id: m.work_id, type: m.type, station: m.station || null,
        stationName: prettyStation(m.station || m.type), structId: structId ?? null,
        slots: m.slots, assigned,
      };
    });
    const { pals, structures } = deriveFromMachines(machines);
    if (!Object.keys(pals).length)               // aucune affectation -> repli sur la liste de la base
      for (const iid of c.pal_instance_ids || []) {
        const r = instToPal[iid];
        if (r && r.palId) pals[r.palId] = (pals[r.palId] || 0) + 1;
      }
    out[c.base_id] = {
      name: `Base ${c.index}`,
      pals, structures, limit: 15,
      source: "save", base_id: c.base_id, index: c.index, guild_id: c.guild_id || null,
      location: c.location || null,
      palCount: c.pal_count || 0, machineCount: c.machine_count || 0,
      machines, importedAt: now,
    };
  }
  return out;
}

// Dérive { pals:{palId:qty}, structures:{structId:qty} } d'une liste de machines.
// Base commune à l'import initial ET à l'édition manuelle de l'agencement.
function deriveFromMachines(machines) {
  const pals = {}, structures = {};
  for (const m of machines || []) {
    if (m.structId != null) structures[m.structId] = (structures[m.structId] || 0) + 1;
    for (const a of m.assigned || [])
      if (a.palId != null) pals[a.palId] = (pals[a.palId] || 0) + 1;
  }
  return { pals, structures };
}

async function onSavFile(ev) {
  const file = ev.target.files[0];
  ev.target.value = "";              // permet de recharger le même fichier
  if (!file) return;
  const status = document.getElementById("sav-status");
  const preview = document.getElementById("sav-preview");
  const applyBtn = document.getElementById("sav-apply");
  applyBtn.hidden = true; preview.hidden = true; _savPending = null;
  status.textContent = "Initialisation du moteur… (1re fois : quelques secondes)";
  try {
    const parser = await getSaveParser(m => { status.textContent = m; });
    status.textContent = `Lecture de ${file.name}…`;
    const res = await parser.parse(file);
    _savPending = { r: mapSavePals(res.pals), res, name: file.name };
    renderSavPreview();
  } catch (e) {
    status.innerHTML = `<span class="imp-ko">❌ ${e.message || e}</span>`;
    console.error(e);
  }
}

function samePassives(a, b) {
  a = a || []; b = b || [];
  if (a.length !== b.length) return false;
  const sa = [...a].sort(), sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

// Diff entre la boîte actuelle et l'import, selon le mode choisi (pour l'aperçu AVANT validation).
//   merge   : upsert par instance_id — rien n'est retiré, l'existant est mis à jour, le reste ajouté.
//   replace : la boîte est vidée puis reremplie — tout ce qui n'est pas réimporté est RETIRÉ.
// Renvoie { status: Map(instId -> {kind:"new"|"up"|"same", chg?}), added, updated, same, removed[] }.
function computeSavDiff(items, mode) {
  const box = store.palBox;
  const status = new Map();
  const importKeys = new Set();
  let added = 0, updated = 0, same = 0;
  for (const it of items) {
    const key = it.instId;
    if (!key) { added++; continue; }             // sans instance_id -> toujours nouveau (synthétique)
    importKeys.add(key);
    const cur = box[key];
    if (!cur) { added++; status.set(key, { kind: "new" }); continue; }
    const newLevel = Number.isFinite(it.level) ? it.level : null;
    const chg = [];
    if ((cur.level ?? null) !== newLevel) chg.push(`niv. ${cur.level ?? "?"} → ${newLevel ?? "?"}`);
    if ((cur.stars || 0) !== (it.stars || 0)) chg.push(`★ ${cur.stars || 0} → ${it.stars || 0}`);
    if (!samePassives(cur.passives, it.passives)) chg.push("passifs");
    if (chg.length) { updated++; status.set(key, { kind: "up", chg }); }
    else { same++; status.set(key, { kind: "same" }); }
  }
  const removed = [];
  if (mode === "replace") {
    for (const [k, e] of Object.entries(box))
      if (e && e.palId && !importKeys.has(k)) removed.push(e);
  }
  return { status, added, updated, same, removed };
}

// Petit badge de statut d'une ligne de l'aperçu.
function savRowBadge(st) {
  if (!st || st.kind === "new") return `<span class="rbadge new" title="Nouveau Pal (ajouté)">🆕</span>`;
  if (st.kind === "up") return `<span class="rbadge up" title="Mis à jour : ${escHtml(st.chg.join(", "))}">🔄</span>`;
  return `<span class="rbadge same" title="Déjà présent, identique">=</span>`;
}

function renderSavPreview() {
  const { r, res, name } = _savPending;
  const status = document.getElementById("sav-status");
  const preview = document.getElementById("sav-preview");
  const applyBtn = document.getElementById("sav-apply");
  const chars = res.counts ? res.counts.characters : 0;
  status.textContent = `${name} · ${chars} personnage(s) lu(s)`;
  preview.hidden = false;
  if (r.species === 0) {
    preview.innerHTML = `<span class="imp-ko">Aucun Pal reconnu dans cette sauvegarde.</span> `
      + `(classe : ${escHtml(res.save_game_class_name || "?")}). Essaie <b>Level.sav</b>.`;
    applyBtn.hidden = true;
    return;
  }
  const mode = document.querySelector('input[name="sav-import-mode"]:checked')?.value || "replace";
  const items = (r.items || []).slice().sort((a, b) =>
    a.name.localeCompare(b.name) || (b.level || 0) - (a.level || 0));
  const ownerName = Object.fromEntries((res.players || []).map(p => [p.uid, p.name]));
  const diff = computeSavDiff(items, mode);

  let html = `<div class="imp-ok">À importer : ${r.species} espèces · ${r.total} Pals</div>`;
  const plur = n => n > 1 ? "s" : "";
  const badges = [
    `<span class="dbadge new">🆕 ${diff.added} ajouté${plur(diff.added)}</span>`,
    diff.updated ? `<span class="dbadge up">🔄 ${diff.updated} mis à jour</span>` : "",
    diff.same ? `<span class="dbadge same">= ${diff.same} inchangé${plur(diff.same)}</span>` : "",
    diff.removed.length ? `<span class="dbadge rem">🗑️ ${diff.removed.length} retiré${plur(diff.removed.length)}</span>` : "",
  ].filter(Boolean).join("");
  html += `<div class="sav-diff" title="Aperçu du résultat sur ta boîte actuelle">${badges}</div>`;
  html += `<table class="sav-table"><thead><tr>`
    + `<th>Pal</th>`
    + `<th title="Niveau">Lv</th>`
    + `<th title="Étoiles de condensation (fusion d'âmes), 0 à 4">★</th>`
    + `<th title="Talents innés PV / Attaque / Défense (0 à 100)">IV PV/Att/Déf</th>`
    + `<th title="Nombre de compétences passives (survol = liste)">Passifs</th>`
    + `<th>Propriétaire</th>`
    + `</tr></thead><tbody>`
    + items.map(it => {
        const g = it.gender === "Female" ? " ♀" : it.gender === "Male" ? " ♂" : "";
        const stars = it.stars ? "★".repeat(it.stars) : "–";
        const iv = it.ivs ? `${it.ivs.hp}/${it.ivs.shot}/${it.ivs.defense}` : "—";
        const np = it.passives ? it.passives.length : 0;
        const pass = np
          ? `<span class="sav-pass" title="${escHtml(it.passives.join(", "))}">${np}</span>` : "–";
        const owner = ownerName[it.owner_uid]
          ? escHtml(ownerName[it.owner_uid])
          : (it.owner_uid ? "?" : "—");   // "—" = sans propriétaire (base / sauvage)
        const st = it.instId ? diff.status.get(it.instId) : null;
        const badge = savRowBadge(st);
        return `<tr class="sav-row-${st ? st.kind : "new"}"><td>${badge} ${escHtml(it.name)}<span class="sav-g">${g}</span></td>`
          + `<td>${it.level ?? "—"}</td><td class="sav-star">${stars}</td>`
          + `<td class="sav-iv">${iv}</td><td class="sav-pass-c">${pass}</td>`
          + `<td class="sav-owner">${owner}</td></tr>`;
      }).join("")
    + `</tbody></table>`;

  html += `<div class="sav-legend"><b>Lv</b> niveau · <b>★</b> étoiles de condensation (0–4) · `
    + `<b>IV</b> talents innés PV/Att/Déf (0–100) · <b>Passifs</b> nombre de compétences passives `
    + `(survol = liste) · <b>Propriétaire</b> joueur qui possède le Pal.</div>`;
  if (r.humans) html += `<div class="imp-warn">${r.humans} humain(s)/PNJ ignoré(s).</div>`;
  if (r.unmatched.length) html += `<div class="imp-warn">Non reconnus (ignorés) : ${r.unmatched.map(escHtml).join(", ")}</div>`;

  // Mode « remplacer » : Pals actuellement dans la boîte, absents de cette save -> seront retirés.
  if (diff.removed.length) {
    const byPal = {};
    for (const e of diff.removed) byPal[e.palId] = (byPal[e.palId] || 0) + 1;
    const chips = Object.entries(byPal)
      .sort((a, b) => (palsById[a[0]]?.name || a[0]).localeCompare(palsById[b[0]]?.name || b[0], "fr"))
      .map(([pid, q]) => {
        const nm = palsById[pid] ? palsById[pid].name : pid;
        return `<span class="sav-chip rem">${escHtml(nm)}${q > 1 ? ` ×${q}` : ""}</span>`;
      }).join("");
    html += `<div class="sav-removed"><div class="sav-removed-h">🗑️ Retirés de la boîte (${diff.removed.length}) `
      + `— absents de cette sauvegarde</div><div class="sav-removed-list">${chips}</div></div>`;
  }

  // Camps : machines installées + affectations Pal ↔ machine. Importés si la case est cochée.
  const camps = res.camps || [];
  if (camps.length) {
    const wantCamps = document.getElementById("opt-import-camps")?.checked;
    const instToPal = buildInstToPal(res, r);
    const resolveName = iid => (instToPal[iid] && instToPal[iid].name) || "?";
    // Diff bases par base_id vs camps « save » déjà présents (upsert comme les Pals).
    let bnew = 0, bup = 0;
    for (const c of camps) {
      if (!c.base_id) continue;
      const cur = store.camps[c.base_id];
      if (cur && cur.source === "save") bup++; else bnew++;
    }
    const head = wantCamps
      ? `🏕️ Camps (${camps.length}) — à importer · ${bnew} nouvelle(s)${bup ? ` · ${bup} mise(s) à jour` : ""}`
      : `🏕️ Camps (${camps.length}) — info, non importé (coche « Camps » pour importer)`;
    html += `<div class="sav-camps"><div class="sav-camps-h">${head}</div>`;
    html += `<div class="sav-camps-grid">`;
    for (const c of camps.slice().sort((a, b) => a.index - b.index)) {
      const rows = stationRows(c.machines, resolveName);
      html += `<div class="sav-camp">`
        + `<div class="sav-camp-head"><span class="sav-camp-name">🏕️ Base ${c.index}</span>`
        + `<span class="sav-camp-badges"><span class="sav-badge">🐾 ${c.pal_count}</span>`
        + `<span class="sav-badge">🏗️ ${c.machine_count}</span></span></div>`
        + stationTableHtml(rows)
        + `</div>`;
    }
    html += `</div></div>`;
  }

  const wantPals = document.getElementById("opt-import-pals")?.checked;
  const wantCamps = document.getElementById("opt-import-camps")?.checked;
  const what = [wantPals ? "Pals" : "", wantCamps ? "camps & affectations" : ""].filter(Boolean).join(" + ") || "rien (coche une option)";
  html += `<div class="sav-note">À importer : <b>${what}</b>. Les Pals sont enregistrés `
    + `<b>individuellement</b> (niveau, étoiles, passifs). Les camps sont recroisés par base `
    + `(réimport = mise à jour, pas de doublon). `
    + `Mode : <b>${mode === "replace" ? "remplacer" : "mettre à jour / ajouter"}</b>. `
    + `Aperçu : 🆕 nouveau · 🔄 mis à jour (survol = détail) · = inchangé`
    + `${mode === "replace" ? " · 🗑️ retiré" : ""}. Rien n'est écrit avant de valider.</div>`;
  preview.innerHTML = html;
  applyBtn.hidden = false;
}

function applySavImport() {
  if (readOnly || !_savPending) return;
  const { r, res } = _savPending;
  const mode = document.querySelector('input[name="sav-import-mode"]:checked')?.value || "replace";
  const wantPals = document.getElementById("opt-import-pals")?.checked;
  const wantCamps = document.getElementById("opt-import-camps")?.checked;
  if (!wantPals && !wantCamps) return;
  pushUndo(mode === "replace" ? "import save (remplacement)" : "import save (synchro)");

  const parts = [];

  // --- Pals : upsert par instance_id (mise à jour, pas de doublon) ---
  if (wantPals) {
    if (mode === "replace") store.palBox = {};
    let added = 0, updated = 0;
    for (const it of r.items) {
      const key = it.instId || synKey();             // fallback si la save n'a pas d'instance_id
      if (store.palBox[key]) updated++; else added++;
      store.palBox[key] = {
        palId: it.id,
        level: Number.isFinite(it.level) ? it.level : null,
        stars: it.stars || 0,
        passives: it.passives || [],
      };
    }
    touchBox();
    parts.push(mode === "replace"
      ? `${r.total} Pals (remplacement)`
      : `Pals : ${added} ajouté(s), ${updated} mis à jour`);
  }

  // --- Camps : upsert par base_id. Ne touche JAMAIS les camps utilisateur (source !== "save"). ---
  if (wantCamps) {
    const instToPal = buildInstToPal(res, r);
    const built = buildImportedCamps(res, instToPal);
    const prevNames = {};                             // conserve un éventuel renommage manuel
    for (const [id, c] of Object.entries(store.camps))
      if (c.source === "save") prevNames[id] = c.name;
    if (mode === "replace")                           // ne retire que les bases importées
      for (const id of Object.keys(store.camps))
        if (store.camps[id].source === "save") delete store.camps[id];
    let cadded = 0, cupdated = 0;
    for (const [id, camp] of Object.entries(built)) {
      if (store.camps[id]) cupdated++; else cadded++;
      store.camps[id] = { ...camp, name: prevNames[id] || camp.name };
    }
    normalize(store);                                 // répare activeId si besoin
    parts.push(`Camps : ${cadded} ajouté(s)${cupdated ? `, ${cupdated} mis à jour` : ""}`);
  }

  saveStore();
  document.getElementById("sav-preview").innerHTML =
    `<span class="imp-ok">✓ ${parts.join(" · ")}</span>.`;
  document.getElementById("sav-apply").hidden = true;
  document.getElementById("sav-status").textContent = "";
  _savPending = null;
  renderAll();
}

// ===== Suggestion de compo (glouton) depuis la boîte à Pals =====
// Choisit ≤ limite Pals de la boîte pour couvrir au mieux les compétences requises
// par les machines du camp (priorité couverture, puis niveaux, puis débit).
function computeSuggestion() {
  const camp = active();
  const structMembers = Object.entries(camp.structures)
    .map(([id, q]) => [structById[id], q]).filter(([s]) => s);

  const demand = {};
  WORK_TYPES.forEach(w => demand[w.id] = 0);
  structMembers.forEach(([s, q]) => s.requires.forEach(wid => demand[wid] += q));
  const required = WORK_TYPES.map(w => w.id).filter(wid => demand[wid] > 0);
  if (required.length === 0) return { error: "no-structures" };

  const avail = {};
  Object.entries(palBoxCounts()).forEach(([id, q]) => { if (palsById[id]) avail[id] = q; });
  if (Object.keys(avail).length === 0) return { error: "empty-box" };

  const limit = camp.limit;
  const best = {}, cnt = {};
  required.forEach(c => { best[c] = 0; cnt[c] = 0; });
  const chosen = {};
  const teamSize = () => Object.values(chosen).reduce((a, b) => a + b, 0);
  const reqCount = (p) => required.reduce((n, c) => n + ((p.work[c] || 0) > 0 ? 1 : 0), 0);
  function addToTeam(id) {
    chosen[id] = (chosen[id] || 0) + 1;
    const p = palsById[id];
    for (const c of required) { const l = p.work[c] || 0; if (l > 0) { best[c] = Math.max(best[c], l); cnt[c]++; } }
  }

  // Les Pals sont libres dans le camp (pas d'affectation à une machine précise) et il n'y a
  // que 12 compétences pour ≤15 places : on peut donc se payer, pour CHAQUE compétence requise,
  // le Pal possédé du plus haut niveau. On privilégie ainsi les niveaux, pas la polyvalence.

  // Phase A — un spécialiste de plus haut niveau par compétence requise.
  for (const c of [...required].sort((a, b) => demand[b] - demand[a])) {
    const maxAvail = Math.max(0, ...Object.keys(avail).map(id => palsById[id].work[c] || 0));
    if (best[c] >= maxAvail) continue;   // déjà au meilleur niveau possible (via un Pal déjà pris)
    let bid = null, bl = -1, bcov = -1;
    for (const id of Object.keys(avail)) {
      if ((chosen[id] || 0) >= avail[id]) continue;
      const l = palsById[id].work[c] || 0;
      if (l <= 0) continue;
      const cov = reqCount(palsById[id]);              // à niveau égal, on garde le plus utile
      if (l > bl || (l === bl && cov > bcov)) { bl = l; bcov = cov; bid = id; }
    }
    if (bid && teamSize() < limit) addToTeam(bid);
  }

  // Phase B — places restantes : du débit, mais uniquement avec des Pals encore FORTS
  // (renfort sur les compétences à forte demande), jamais du remplissage bas niveau.
  while (teamSize() < limit) {
    let bid = null, bv = 0;
    for (const id of Object.keys(avail)) {
      if ((chosen[id] || 0) >= avail[id]) continue;
      const p = palsById[id];
      let v = 0;
      for (const c of required) {
        const l = p.work[c] || 0;
        if (l > 0) v += (cnt[c] < demand[c] ? l : l * 0.15);   // renfort là où il manque des bras
      }
      if (v > bv) { bv = v; bid = id; }
    }
    if (!bid || bv < 2) break;           // on n'ajoute pas de Pals faibles juste pour remplir
    addToTeam(bid);
  }

  const coverage = required.map(c => ({
    id: c, label: workById[c].label, icon: workById[c].icon,
    demand: demand[c], maxLevel: best[c], covered: best[c] > 0,
  })).sort((a, b) => Number(a.covered) - Number(b.covered) || b.demand - a.demand);

  return {
    chosen, coverage,
    uncovered: coverage.filter(c => !c.covered),
    used: Object.values(chosen).reduce((a, b) => a + b, 0),
    limit: camp.limit,
  };
}

function renderSuggestion() {
  const box = document.getElementById("suggest-result");
  box.hidden = false;
  const r = computeSuggestion();

  if (r.error === "no-structures") {
    box.innerHTML = `<p class="sg-msg">Ajoute d'abord des <b>constructions</b> au camp (onglet 🏗️) : la suggestion se base sur les machines présentes.</p>`;
    return;
  }
  if (r.error === "empty-box") {
    box.innerHTML = `<p class="sg-msg">Ta <b>boîte à Pals</b> est vide. Renseigne les Pals que tu possèdes dans l'onglet 🎒, puis relance la suggestion.</p>`;
    return;
  }

  const chosenList = Object.entries(r.chosen)
    .map(([id, q]) => ({ p: palsById[id], q }))
    .sort((a, b) => a.p.name.localeCompare(b.p.name, "fr"));

  const palsHtml = chosenList.map(({ p, q }) => {
    const chips = WORK_TYPES.filter(w => (p.work[w.id] || 0) > 0)
      .map(w => `<span class="skill-chip ${levelClass(p.work[w.id])}" title="${w.label}">${w.icon} <b>${p.work[w.id]}</b></span>`).join("");
    return `<li class="sg-pal"><span class="sg-name">${p.name}${q > 1 ? ` <b>×${q}</b>` : ""}${p.nightWorker ? " 🌙" : ""}</span><span class="sg-chips">${chips}</span></li>`;
  }).join("");

  const covHtml = r.coverage.map(c => `
    <li class="sg-cov ${c.covered ? "ok" : "ko"}">
      <span>${c.icon} ${c.label}</span>
      <span class="sg-cov-r">🏗️ ${c.demand} · ${c.covered ? `niv. max ${c.maxLevel}` : "non couvert"}</span>
    </li>`).join("");

  const warn = r.uncovered.length
    ? `<p class="sg-warn">⚠ ${r.uncovered.length} compétence(s) requise(s) impossible(s) à couvrir avec ta boîte actuelle.</p>` : "";

  box.innerHTML = `
    <div class="sg-head">
      <b>Compo suggérée : ${r.used} / ${r.limit} Pals</b>
      <button id="suggest-close" class="sg-x" title="Fermer">×</button>
    </div>
    <ul class="sg-pals">${palsHtml}</ul>
    <div class="sg-sub">Couverture des machines :</div>
    <ul class="sg-covs">${covHtml}</ul>
    ${warn}
    <div class="sg-actions">
      <button id="suggest-apply" class="btn-add">Appliquer au camp</button>
      <span class="sg-note">remplace les Pals actuels du camp</span>
    </div>`;

  document.getElementById("suggest-close").onclick = () => { box.hidden = true; box.innerHTML = ""; };
  document.getElementById("suggest-apply").onclick = () => {
    if (readOnly) return;
    pushUndo("suggestion appliquée");
    active().pals = { ...r.chosen };
    saveStore(); renderAll();
    box.hidden = true; box.innerHTML = "";
  };
}

// ===== Contenu du camp =====
function renderCampLists() {
  const pl = document.getElementById("camp-pals");
  const sl = document.getElementById("camp-structs");
  pl.innerHTML = ""; sl.innerHTML = "";

  const palIds = Object.keys(active().pals);
  const structIds = Object.keys(active().structures);
  document.getElementById("clear-camp").hidden = palIds.length === 0 && structIds.length === 0;

  if (!palIds.length) pl.innerHTML = `<li class="empty">Aucun Pal. Ajoute-en depuis l'onglet Pals.</li>`;
  else PALS.filter(p => palQty(p.id) > 0).sort((a, b) => a.name.localeCompare(b.name, "fr"))
        .forEach(p => pl.appendChild(palRow(p, "camp")));

  if (!structIds.length) sl.innerHTML = `<li class="empty">Aucune construction. Ajoute-en depuis l'onglet Constructions.</li>`;
  else STRUCTURES.filter(s => structQty(s.id) > 0).sort((a, b) => a.name.localeCompare(b.name, "fr"))
        .forEach(s => sl.appendChild(structRow(s, "camp")));
}

// ===== Récapitulatif (offre vs demande) =====
function renderSummary() {
  const data = computeSummary();

  document.getElementById("camp-count").textContent = data.campSize;
  document.getElementById("camp-limit").textContent = active().limit;
  document.getElementById("night-count").textContent = data.nightWorkers;
  document.getElementById("struct-count").textContent = data.structureCount;
  document.getElementById("count-wrap").classList.toggle("full", data.campSize >= active().limit);

  const warn = document.getElementById("cover-warn");
  if (data.uncovered > 0) {
    warn.hidden = false;
    warn.textContent = `⚠ ${data.uncovered} compétence(s) requise(s) non couverte(s)`;
  } else warn.hidden = true;

  const list = document.getElementById("summary");
  list.innerHTML = "";
  data.summary.forEach(s => {
    const li = document.createElement("li");
    let state = "";
    if (s.demand > 0) state = s.count > 0 ? " covered" : " uncovered";
    else if (s.count === 0) state = " absent";
    li.className = "summary-row" + state;

    const palDetail = s.pals.map(p => `${p.name} ×${p.qty} (niv. ${p.level})`).join(", ");
    const stDetail = s.structures.map(c => `${c.name} ×${c.qty}`).join(", ");
    li.title = `Pals : ${palDetail || "aucun"}\nConstructions : ${stDetail || "aucune"}`;

    const demandChip = s.demand > 0
      ? `<span class="demand ${s.count > 0 ? "ok" : "ko"}">🏗️ ${s.demand} requis</span>` : "";

    li.innerHTML = `
      <span class="ico">${s.icon}</span>
      <span class="label">${s.label}</span>
      <span class="stats">
        ${demandChip}
        <span class="count">${s.count} Pal${s.count > 1 ? "s" : ""}</span>
        <span class="maxlvl ${levelClass(s.maxLevel)}">${s.maxLevel > 0 ? "niv. " + s.maxLevel : "—"}</span>
      </span>`;
    list.appendChild(li);
  });
}

// ===== Palpedia (tous les Pals + toutes les tier-lists) =====
function tierCell(pal, cat) {
  const t = pal.tiers ? pal.tiers[cat.key] : null;
  const speed = cat.speed && pal.mountSpeed && pal.mountSpeed[cat.speed]
    ? `<span class="pedia-speed">${pal.mountSpeed[cat.speed]}</span>` : "";
  return `<td class="pedia-tier"><span class="tier-badge ${tierClass(t)}">${t || "–"}</span>${speed}</td>`;
}

const MUTED = '<span class="muted">—</span>';

function pediaRow(pal) {
  const tr = document.createElement("tr");
  const night = pal.nightWorker ? ` <span class="night" title="Travailleur de nuit">🌙</span>` : "";
  const name = pal.slug
    ? `<a href="https://palworld.gg/pal/${pal.slug}" target="_blank" rel="noopener" title="Voir sur palworld.gg">${pal.name}</a>`
    : pal.name;
  const lvl = pal.level != null ? `niv. ${pal.level}` : MUTED;
  const rarity = pal.rarityCategory
    ? `<span class="rarity-tag rarity-${pal.rarityCategory.toLowerCase()}">${pal.rarityCategory} ${pal.rarity}</span>`
    : MUTED;
  const cap = pal.captureRate != null ? `×${pal.captureRate}` : MUTED;
  const skills = WORK_TYPES
    .filter(w => (pal.work[w.id] || 0) > 0)
    .map(w => `<span class="skill-chip ${levelClass(pal.work[w.id])}" title="${w.label} — niv. ${pal.work[w.id]} (${levelName(pal.work[w.id])})">${w.icon} <b>${pal.work[w.id]}</b></span>`)
    .join("");
  const tiers = TIER_CATS.map(c => tierCell(pal, c)).join("");
  tr.innerHTML =
    `<td class="pedia-name">${palIconHtml(pal)}${name}${night}` +
      `${boxQty(pal.id) > 0 ? ' <span class="owned-badge" title="Dans ma boîte">✓</span>' : ''}` +
      `<div class="pedia-el">${elementChipsHtml(pal)}</div></td>` +
    `<td class="pedia-num">${lvl}</td>` +
    `<td>${rarity}</td>` +
    `<td class="pedia-num">${cap}</td>` +
    `<td><div class="pedia-skills">${skills || MUTED}</div></td>` +
    tiers;
  tr.dataset.pal = pal.id;
  return tr;
}

function pediaSortValue(pal, key) {
  if (key === "name") return pal.name.toLowerCase();
  if (key === "skills") return WORK_TYPES.reduce((n, w) => n + ((pal.work[w.id] || 0) > 0 ? 1 : 0), 0);
  if (key === "level") return pal.level ?? null;
  if (key === "rarity") return pal.rarity ?? null;
  if (key === "capture") return pal.captureRate ?? null;
  const t = pal.tiers ? pal.tiers[key] : null;
  return t in TIER_RANK ? TIER_RANK[t] : 99;          // non classé : à la fin
}

function setPediaSort(key) {
  if (pediaSort.key === key) {
    pediaSort.dir = -pediaSort.dir;                   // reclic : on inverse
  } else {
    pediaSort.key = key;
    // Défaut sensé : niveau/rareté croissants (plus accessible d'abord) ;
    // compétences et capture décroissants (plus nombreuses / plus facile d'abord) ; reste A→Z ou S→D.
    pediaSort.dir = (key === "skills" || key === "capture") ? -1 : 1;
  }
  renderPalpedia();
}

function updatePediaHeaders() {
  document.querySelectorAll(".pedia-table th[data-sort]").forEach(th => {
    const active = th.dataset.sort === pediaSort.key;
    th.classList.toggle("sorted", active);
    th.querySelector(".arrow")?.remove();
    if (active) {
      const arrow = document.createElement("span");
      arrow.className = "arrow";
      arrow.textContent = pediaSort.dir === 1 ? " ▲" : " ▼";
      th.appendChild(arrow);
    }
  });
}

function renderPalpedia() {
  const q = document.getElementById("pedia-search").value.trim().toLowerCase();
  const wf = document.getElementById("pedia-work").value;
  const ef = document.getElementById("pedia-element").value;
  const owned = document.getElementById("pedia-owned").checked;
  const body = document.getElementById("pedia-body");
  body.innerHTML = "";
  const rows = PALS
    .filter(p =>
      (!q || p.name.toLowerCase().includes(q)) &&
      (!wf || (p.work[wf] || 0) > 0) &&
      (!ef || palElements(p).includes(ef)) &&
      (!owned || boxQty(p.id) > 0))
    .sort((a, b) => {
      const va = pediaSortValue(a, pediaSort.key);
      const vb = pediaSortValue(b, pediaSort.key);
      // Valeurs absentes toujours en fin, quel que soit le sens.
      if (va == null && vb == null) return a.name.localeCompare(b.name, "fr");
      if (va == null) return 1;
      if (vb == null) return -1;
      let c = typeof va === "string" ? va.localeCompare(vb, "fr") : va - vb;
      if (c === 0) c = a.name.localeCompare(b.name, "fr");   // départage par nom
      return c * pediaSort.dir;
    });
  document.getElementById("pedia-count").textContent = rows.length;
  updatePediaHeaders();
  if (!rows.length) {
    body.innerHTML = `<tr><td class="empty" colspan="${5 + TIER_CATS.length}">Aucun Pal trouvé.</td></tr>`;
    return;
  }
  rows.forEach(p => body.appendChild(pediaRow(p)));
}

// ===== Drops (recherche d'objet -> Pals qui le lâchent) =====
let DROP_INDEX = null;   // [[item, [{name, slug, amount, rate}]], ...] trié par objet

function rateNum(rate) { const m = /([\d.]+)/.exec(rate || ""); return m ? parseFloat(m[1]) : 0; }

function fmtAmount(amount) {
  const parts = (amount || "").split("-").map(s => s.trim());
  return parts.length === 2 && parts[0] === parts[1] ? parts[0] : amount;
}

function buildDropIndex() {
  const idx = new Map();
  PALS.forEach(p => (p.drops || []).forEach(d => {
    if (!idx.has(d.item)) idx.set(d.item, []);
    idx.get(d.item).push({ name: p.name, slug: p.slug, amount: d.amount, rate: d.rate });
  }));
  for (const arr of idx.values())
    arr.sort((a, b) => rateNum(b.rate) - rateNum(a.rate) || a.name.localeCompare(b.name, "fr"));
  DROP_INDEX = [...idx.entries()].sort((a, b) => a[0].localeCompare(b[0], "fr"));
}

function dropItemRow(item, pals) {
  const li = document.createElement("li");
  li.className = "drop-item";
  const palsHtml = pals.map(p => {
    const name = p.slug
      ? `<a href="https://palworld.gg/pal/${p.slug}" target="_blank" rel="noopener">${p.name}</a>`
      : p.name;
    return `<li class="drop-pal">${name}<span class="drop-amt">×${fmtAmount(p.amount)}</span>` +
      `<span class="drop-rate">${p.rate}</span></li>`;
  }).join("");
  li.innerHTML =
    `<div class="drop-item-name">${item} <span class="drop-pal-count">${pals.length} Pal${pals.length > 1 ? "s" : ""}</span></div>` +
    `<ul class="drop-pals">${palsHtml}</ul>`;
  return li;
}

function renderDrops() {
  if (!DROP_INDEX) buildDropIndex();
  const q = document.getElementById("drop-search").value.trim().toLowerCase();
  const list = document.getElementById("drop-list");
  list.innerHTML = "";
  const items = DROP_INDEX.filter(([item]) => !q || item.toLowerCase().includes(q));
  document.getElementById("drop-count").textContent = items.length;
  if (!items.length) { list.innerHTML = `<li class="empty">Aucun objet trouvé.</li>`; return; }
  items.forEach(([item, pals]) => list.appendChild(dropItemRow(item, pals)));
}

// ===== Rendu global =====
function renderAll() {
  renderCampSelect();
  document.getElementById("limit-input").value = active().limit;
  document.getElementById("box-total").textContent = totalBox();
  switchTab(currentTab);
  renderPalCatalog();
  renderStructCatalog();
  renderBoxCatalog();
  renderCampLists();
  renderCampMachines();
  renderSummary();
  updateUndoUI();
}

init();
