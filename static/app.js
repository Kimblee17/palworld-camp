// ===== Données de référence (chargées une fois) =====
let WORK_TYPES = [];
let PALS = [];
let STRUCTURES = [];
let workById = {};

// ===== Stockage : plusieurs camps =====
const STORE_KEY = "palworld-store";
let store = loadStore();
let currentTab = "pals";

function uid() { return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function loadStore() {
  // Nouveau format
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
  return { activeId: id, camps: { [id]: { name: "Camp 1", pals, structures: {}, limit } } };
}

function normalize(s) {
  for (const c of Object.values(s.camps)) {
    c.pals = c.pals || {};
    c.structures = c.structures || {};
    if (!Number.isFinite(c.limit) || c.limit < 1) c.limit = 15;
    if (!c.name) c.name = "Camp";
  }
  return s;
}

function saveStore() { localStorage.setItem(STORE_KEY, JSON.stringify(store)); }
function active() { return store.camps[store.activeId]; }

// ===== Quantités (Pals / Constructions) =====
function palQty(id) { return active().pals[id] || 0; }
function structQty(id) { return active().structures[id] || 0; }
function totalPals() { return Object.values(active().pals).reduce((a, b) => a + b, 0); }
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
function addPal(id) {
  if (isFull()) { flashLimit(); return; }
  setPalQty(id, palQty(id) + 1);
}
function addStruct(id) { setStructQty(id, structQty(id) + 1); }

// ===== Code couleur des niveaux =====
function levelClass(lvl) { return "lvl-" + Math.min(Math.max(lvl, 0), 4); }
const LEVEL_NAMES = { 0: "Manquant", 1: "Faible", 2: "Moyen", 3: "Fort", 4: "Très fort" };

let flashTimer = null;
function flashLimit() {
  const el = document.getElementById("limit-msg");
  el.textContent = `Limite du camp atteinte (${active().limit}). Augmente la limite ou retire un Pal.`;
  el.classList.add("show");
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el.classList.remove("show"), 3000);
}

// ===== Chargement initial =====
async function init() {
  const res = await fetch("/api/pals");
  const data = await res.json();
  WORK_TYPES = data.workTypes;
  PALS = data.pals;
  STRUCTURES = data.structures || [];
  workById = Object.fromEntries(WORK_TYPES.map(w => [w.id, w]));

  document.getElementById("pals-total").textContent = PALS.length;
  document.getElementById("structs-total").textContent = STRUCTURES.length;

  // Filtre compétences (Pals)
  const fw = document.getElementById("filter-work");
  WORK_TYPES.forEach(w => fw.add(new Option(`${w.icon} ${w.label}`, w.id)));
  // Filtre catégories (Constructions)
  const fc = document.getElementById("filter-category");
  [...new Set(STRUCTURES.map(s => s.category))].sort((a, b) => a.localeCompare(b, "fr"))
    .forEach(cat => fc.add(new Option(cat, cat)));

  // Écouteurs catalogue
  document.getElementById("search").addEventListener("input", renderPalCatalog);
  fw.addEventListener("change", renderPalCatalog);
  document.getElementById("night-only").addEventListener("change", renderPalCatalog);
  document.getElementById("search-struct").addEventListener("input", renderStructCatalog);
  fc.addEventListener("change", renderStructCatalog);
  document.querySelectorAll(".tab").forEach(t =>
    t.addEventListener("click", () => switchTab(t.dataset.tab)));

  // Écouteurs camp
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

  // Écouteurs gestion des camps
  document.getElementById("camp-select").addEventListener("change", e => {
    store.activeId = e.target.value; saveStore(); renderAll();
  });
  document.getElementById("camp-new").addEventListener("click", newCamp);
  document.getElementById("camp-rename").addEventListener("click", renameCamp);
  document.getElementById("camp-delete").addEventListener("click", deleteCamp);

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
  document.querySelectorAll(".tab-pals").forEach(el => el.hidden = tab !== "pals");
  document.querySelectorAll(".tab-structures").forEach(el => el.hidden = tab !== "structures");
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

// ===== Lignes Pal =====
function palRow(pal, mode) {
  const q = palQty(pal.id);
  const li = document.createElement("li");
  li.className = "pal-row" + (mode === "catalog" && q > 0 ? " in-camp" : "");

  const info = document.createElement("div");
  info.className = "info";
  const night = pal.nightWorker ? ` <span class="night" title="Travailleur de nuit">🌙</span>` : "";
  info.innerHTML = `<div class="name">${pal.name}${night}</div>`;
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

  li.appendChild(stepperOrAdd(mode, q, () => addPal(pal.id), d => setPalQty(pal.id, q + d), () => setPalQty(pal.id, 0), isFull()));
  return li;
}

// ===== Lignes Construction =====
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

// Bouton "+" (catalogue) ou compteur −[q]+ × (camp)
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

// ===== Récapitulatif des compétences (offre vs demande) =====
async function renderSummary() {
  const res = await fetch("/api/summary", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pals: active().pals, structures: active().structures }),
  });
  const data = await res.json();

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

// ===== Rendu global =====
function renderAll() {
  renderCampSelect();
  document.getElementById("limit-input").value = active().limit;
  switchTab(currentTab);
  renderPalCatalog();
  renderStructCatalog();
  renderCampLists();
  renderSummary();
}

init();
