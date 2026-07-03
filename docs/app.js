// ===== Données de référence (embarquées via data.js) =====
const DB = window.PAL_DATA || { workTypes: [], pals: [], structures: [] };
const WORK_TYPES = DB.workTypes;
const PALS = DB.pals;
const STRUCTURES = DB.structures;
const workById = Object.fromEntries(WORK_TYPES.map(w => [w.id, w]));
const palsById = Object.fromEntries(PALS.map(p => [p.id, p]));
const structById = Object.fromEntries(STRUCTURES.map(s => [s.id, s]));

// ===== Stockage : plusieurs camps + une boîte à Pals =====
const STORE_KEY = "palworld-store";
let store = loadStore();
let currentTab = "pals";
let currentView = "camp";

function uid() { return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function loadStore() {
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
  localStorage.setItem(STORE_KEY, JSON.stringify(store));
  window.PWCloud?.push?.(store);   // pousse vers le cloud si la synchro est active
}

// ===== Passerelles avec le module de synchro cloud (firebase-sync.js) =====
// Applique un store reçu du cloud (sans re-pousser : écriture directe en local).
window.applyRemoteStore = function (data) {
  if (JSON.stringify(data) === JSON.stringify(store)) return;
  store = normalize(data);
  localStorage.setItem(STORE_KEY, JSON.stringify(store));
  renderAll();
};

// Met à jour la barre de synchro selon l'état renvoyé par le module.
let syncLink = null;
window.setSyncUI = function (state, info = {}) {
  const st = document.getElementById("sync-status");
  const enable = document.getElementById("sync-enable");
  const share = document.getElementById("sync-share");
  const leave = document.getElementById("sync-leave");
  syncLink = info.link || null;
  const show = (el, on) => { if (el) el.hidden = !on; };
  if (state === "connecting") {
    st.textContent = "☁️ Connexion…"; st.className = "sync-status";
    show(enable, false); show(share, false); show(leave, false);
  } else if (state === "synced") {
    st.textContent = "☁️ Synchronisé — partage actif"; st.className = "sync-status ok";
    show(enable, false); show(share, true); show(leave, true);
  } else if (state === "error") {
    st.textContent = "⚠️ Synchro : " + (info.msg || "erreur"); st.className = "sync-status err";
    const synced = !!window.PWCloud?.isSynced?.();
    show(enable, !synced); show(share, false); show(leave, synced);
  } else { // "local"
    st.textContent = "🖥️ Camps locaux (non synchronisés)"; st.className = "sync-status";
    show(enable, true); show(share, false); show(leave, false);
  }
};
function active() { return store.camps[store.activeId]; }

// ===== Quantités (Pals / Constructions / Boîte) =====
function palQty(id) { return active().pals[id] || 0; }
function structQty(id) { return active().structures[id] || 0; }
function boxQty(id) { return store.palBox[id] || 0; }
function totalPals() { return Object.values(active().pals).reduce((a, b) => a + b, 0); }
function totalBox() { return Object.values(store.palBox).reduce((a, b) => a + b, 0); }
function isFull() { return totalPals() >= active().limit; }

function setPalQty(id, q) {
  const m = active().pals;
  if (q > 0) m[id] = q; else delete m[id];
  saveStore(); renderAll();
}
function setStructQty(id, q) {
  const m = active().structures;
  if (q > 0) m[id] = q; else delete m[id];
  saveStore(); renderAll();
}
function setBoxQty(id, q) {
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
function levelClass(lvl) { return "lvl-" + Math.min(Math.max(lvl, 0), 4); }
const LEVEL_NAMES = { 0: "Manquant", 1: "Faible", 2: "Moyen", 3: "Fort", 4: "Très fort" };

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
  document.querySelectorAll(".tab").forEach(t =>
    t.addEventListener("click", () => switchTab(t.dataset.tab)));
  document.querySelectorAll(".view-btn").forEach(b =>
    b.addEventListener("click", () => switchView(b.dataset.view)));
  document.getElementById("pedia-search").addEventListener("input", renderPalpedia);
  document.querySelectorAll(".pedia-table th[data-sort]").forEach(th =>
    th.addEventListener("click", () => setPediaSort(th.dataset.sort)));
  document.getElementById("drop-search").addEventListener("input", renderDrops);

  document.getElementById("clear-camp").addEventListener("click", () => {
    if (confirm("Vider ce camp (Pals et constructions) ?")) {
      active().pals = {}; active().structures = {}; saveStore(); renderAll();
    }
  });
  const limitInput = document.getElementById("limit-input");
  limitInput.addEventListener("change", () => {
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

  // Synchro cloud
  document.getElementById("sync-enable").addEventListener("click", () => window.PWCloud?.enable(store));
  document.getElementById("sync-leave").addEventListener("click", () => {
    if (confirm("Quitter la synchro ? Tes camps restent en local sur cet appareil, mais ne seront plus partagés ni synchronisés.")) {
      window.PWCloud?.leave();
    }
  });
  document.getElementById("sync-share").addEventListener("click", async e => {
    if (!syncLink) return;
    const btn = e.currentTarget;
    try {
      await navigator.clipboard.writeText(syncLink);
      const old = btn.textContent;
      btn.textContent = "✓ Lien copié !";
      setTimeout(() => { btn.textContent = old; }, 1800);
    } catch {
      prompt("Copie ce lien de partage :", syncLink);
    }
  });

  buildLegend();
  renderAll();
}

function buildLegend() {
  const legend = document.getElementById("legend");
  [1, 2, 3, 4].forEach(l => {
    const span = document.createElement("span");
    span.className = "legend-item " + levelClass(l);
    span.textContent = `${l} · ${LEVEL_NAMES[l]}`;
    legend.appendChild(span);
  });
}

// ===== Onglets =====
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === tab));
  ["pals", "structures", "box"].forEach(name =>
    document.querySelectorAll(".tab-" + name).forEach(el => el.hidden = name !== tab));
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
  const n = Object.keys(store.camps).length + 1;
  const name = (prompt("Nom du nouveau camp :", "Camp " + n) || "").trim();
  if (!name) return;
  const id = uid();
  store.camps[id] = { name, pals: {}, structures: {}, limit: 15 };
  store.activeId = id; saveStore(); renderAll();
}
function renameCamp() {
  const name = (prompt("Renommer le camp :", active().name) || "").trim();
  if (!name) return;
  active().name = name; saveStore(); renderAll();
}
function deleteCamp() {
  if (!confirm(`Supprimer le camp « ${active().name} » ?`)) return;
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

  const info = document.createElement("div");
  info.className = "info";
  const night = pal.nightWorker ? ` <span class="night" title="Travailleur de nuit">🌙</span>` : "";
  const wt = pal.tiers && pal.tiers.workers;
  const tier = wt
    ? ` <span class="tier-txt ${tierClass(wt)}" title="Rang Workers (palworld.gg)">Tier ${wt}</span>`
    : "";
  info.innerHTML = `<div class="name">${pal.name}${night}${tier}</div>`;
  li.appendChild(info);

  const skills = document.createElement("div");
  skills.className = "skills";
  WORK_TYPES.forEach(w => {
    const lvl = pal.work[w.id] || 0;
    if (lvl > 0) {
      const chip = document.createElement("span");
      chip.className = "skill-chip " + levelClass(lvl);
      chip.title = `${w.label} — ${LEVEL_NAMES[lvl]}`;
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
    btn.onclick = onAdd;
    actions.appendChild(btn);
  } else {
    const stepper = document.createElement("div");
    stepper.className = "stepper";
    stepper.innerHTML = `
      <button class="btn-step" data-act="dec">−</button>
      <span class="qty">${q}</span>
      <button class="btn-step" data-act="inc" ${disabledAdd ? "disabled" : ""}>+</button>
      <button class="btn-step btn-x" data-act="del" title="Retirer">×</button>`;
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

  const best = {}, cnt = {};
  required.forEach(c => { best[c] = 0; cnt[c] = 0; });
  const chosen = {};

  function score(p) {
    let s = 0;
    for (const c of required) {
      const lvl = p.work[c] || 0;
      if (lvl <= 0) continue;
      if (best[c] === 0) s += 1000 + demand[c] * 20;      // couvre une compétence nouvelle
      else if (lvl > best[c]) s += (lvl - best[c]) * 40;  // améliore le niveau max
      else if (cnt[c] < demand[c]) s += lvl * 4;          // débit supplémentaire
    }
    return s;
  }

  let slots = camp.limit;
  while (slots > 0) {
    let bestId = null, bestScore = 0;
    for (const id of Object.keys(avail)) {
      if ((chosen[id] || 0) >= avail[id]) continue;
      const sc = score(palsById[id]);
      if (sc > bestScore) { bestScore = sc; bestId = id; }
    }
    if (!bestId || bestScore <= 0) break;
    chosen[bestId] = (chosen[bestId] || 0) + 1;
    slots--;
    const p = palsById[bestId];
    for (const c of required) {
      const lvl = p.work[c] || 0;
      if (lvl > 0) { best[c] = Math.max(best[c], lvl); cnt[c]++; }
    }
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
    .map(w => `<span class="skill-chip ${levelClass(pal.work[w.id])}" title="${w.label} — ${LEVEL_NAMES[pal.work[w.id]]}">${w.icon} <b>${pal.work[w.id]}</b></span>`)
    .join("");
  const tiers = TIER_CATS.map(c => tierCell(pal, c)).join("");
  tr.innerHTML =
    `<td class="pedia-name">${name}${night}</td>` +
    `<td class="pedia-num">${lvl}</td>` +
    `<td>${rarity}</td>` +
    `<td class="pedia-num">${cap}</td>` +
    `<td><div class="pedia-skills">${skills || MUTED}</div></td>` +
    tiers;
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
  const body = document.getElementById("pedia-body");
  body.innerHTML = "";
  const rows = PALS
    .filter(p => !q || p.name.toLowerCase().includes(q))
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
}

init();
