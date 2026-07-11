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
  s.palBox = s.palBox || {};
  s.camps = s.camps || {};
  for (const c of Object.values(s.camps)) {
    c.pals = c.pals || {};
    c.structures = c.structures || {};
    if (!Number.isFinite(c.limit) || c.limit < 1) c.limit = 15;
    if (!c.name) c.name = "Camp";
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
  localStorage.setItem(SPACE_CACHE_KEY, JSON.stringify(store));
  renderAll();
};

// Rechargé après avoir quitté un espace partagé : on revient à l'espace privé.
window.reloadLocalStore = function () {
  store = loadStore();   // les clés d'espace sont effacées -> charge l'espace privé
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
  saveStore(); renderAll();
}

// ===== Modale : détail d'un Pal =====
function openPalDetail(pal) {
  const modal = document.getElementById("pal-modal");
  const body = document.getElementById("pal-modal-body");
  if (!modal || !body) return;
  const url = window.PAL_ICON_URL && window.PAL_ICON_URL(pal.name);
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
function boxQty(id) { return store.palBox[id] || 0; }
function totalPals() { return Object.values(active().pals).reduce((a, b) => a + b, 0); }
function totalBox() { return Object.values(store.palBox).reduce((a, b) => a + b, 0); }
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
function setBoxQty(id, q) {
  if (readOnly) return;
  if (q > 0) store.palBox[id] = q; else delete store.palBox[id];
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
function palElements(name) { return (window.PAL_ELEMENTS && window.PAL_ELEMENTS[name]) || []; }
function elementChipsHtml(pal) {
  return palElements(pal.name).map(e => {
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
function palIconEl(pal) {
  const url = window.PAL_ICON_URL && window.PAL_ICON_URL(pal.name);
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
  const url = window.PAL_ICON_URL && window.PAL_ICON_URL(pal.name);
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
  Object.entries(store.camps).forEach(([id, c]) => {
    const total = Object.values(c.pals).reduce((a, b) => a + b, 0);
    const ns = Object.values(c.structures).reduce((a, b) => a + b, 0);
    sel.add(new Option(`${c.name} (${total} Pals · ${ns} constr.)`, id));
  });
  sel.value = store.activeId;
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
  pushUndo(mode === "replace" ? "import (remplacement)" : "import (fusion)");
  if (mode === "replace") store.palBox = {};
  for (const [id, c] of Object.entries(r.counts)) {
    store.palBox[id] = (mode === "merge" ? (store.palBox[id] || 0) : 0) + c;
  }
  saveStore();

  let msg = `<span class="imp-ok">✓ ${r.species} espèces · ${r.total} Pals chargés</span> (${mode === "replace" ? "remplacement" : "fusion"}).`;
  if (r.humans) msg += ` ${r.humans} humain(s)/PNJ ignoré(s).`;
  if (r.unmatched.length) msg += `<br><span class="imp-warn">Non reconnus (ignorés) : ${r.unmatched.join(", ")}</span>`;
  report.innerHTML = msg;
  renderAll();
}

function toggleImportPanel(show) {
  const p = document.getElementById("import-panel");
  p.hidden = show === undefined ? !p.hidden : !show;
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
  Object.entries(store.palBox).forEach(([id, q]) => { if (palsById[id]) avail[id] = q; });
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
      (!ef || palElements(p.name).includes(ef)) &&
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
  renderSummary();
  updateUndoUI();
}

init();
