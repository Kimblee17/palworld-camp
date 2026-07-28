import { currentTab, switchTab } from "./main.js";
import { deriveFromMachines, escHtml, prettyStation } from "./sav-import.js";
import { renderSuggestPrefs } from "./suggest.js";
import { active, addBox, addPal, addStruct, boxQty, cyclePalPref, palPref, isFull, palQty, readOnly, saveStore, setBoxQty, setPalQty, setStructQty, store, structQty, totalBox, updateUndoUI } from "./state.js";
import { PALS, STRUCTURES, WORK_TYPES, palsById, structById, workById } from "./dataset.js";

// ===== Modale : détail d'un Pal =====
export function openPalDetail(pal) {
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
  modalReturnFocus = document.activeElement;   // pour rendre le focus à la fermeture
  modal.hidden = false;
  setBackgroundInert(true);
  modal.querySelector(".pm-close")?.focus();
}

// Élément qui avait ouvert la modale (ligne de Pal, entrée de Palpedia…).
let modalReturnFocus = null;

// Neutralise l'arrière-plan pendant que la modale est ouverte : `inert` le retire du
// parcours de tabulation ET de l'arbre d'accessibilité. On cible tous les enfants
// directs de <body> sauf la modale, pour ne rien oublier quand la page évolue.
function setBackgroundInert(on) {
  const modal = document.getElementById("pal-modal");
  for (const el of document.body.children) {
    if (el === modal) continue;
    if (on) el.inert = true; else el.inert = false;
  }
}

export function closePalModal() {
  const m = document.getElementById("pal-modal");
  if (!m || m.hidden) return;          // Échap hors modale : ne touche à rien
  m.hidden = true;
  setBackgroundInert(false);
  const back = modalReturnFocus;
  modalReturnFocus = null;
  // On ne rend le focus que si l'élément est toujours dans le document.
  if (back && document.contains(back) && typeof back.focus === "function") back.focus();
}

// ===== Code couleur des niveaux =====
// Échelle des compétences de travail 1–10 (Palworld 1.0), regroupée en 5 paliers de couleur.
function levelTier(lvl) { return lvl <= 0 ? 0 : Math.min(5, Math.ceil(lvl / 2)); }
export function levelClass(lvl) { return "lvl-" + levelTier(lvl); }
const TIER_NAMES = { 0: "Manquant", 1: "Faible", 2: "Moyen", 3: "Bon", 4: "Fort", 5: "Élite" };
export function levelName(lvl) { return TIER_NAMES[levelTier(lvl)]; }

// Icône de vignette par catégorie de construction
const CATEGORY_ICON = {
  "Production": "🔨", "Nourriture": "🍳", "Infrastructure": "⚡", "Défense": "🛡️",
  "Stockage": "📦", "Éclairage": "💡", "Pals": "🥚", "Médical": "💊", "Autre": "🔧",
};

// Éléments (couleur + nom FR) pour la Palpedia
export const ELEMENT_META = {
  Neutral: { fr: "Neutre", c: "#b9c2d0" }, Fire: { fr: "Feu", c: "#ff6b3d" },
  Water: { fr: "Eau", c: "#3fa9e0" }, Electric: { fr: "Foudre", c: "#f5c542" },
  Ice: { fr: "Glace", c: "#7fe3e3" }, Ground: { fr: "Terre", c: "#c58a55" },
  Dark: { fr: "Ténèbres", c: "#9a6bd6" }, Dragon: { fr: "Dragon", c: "#7b6bff" },
  Grass: { fr: "Herbe", c: "#7cc44d" },
};
export const ELEMENT_ORDER = ["Neutral", "Fire", "Water", "Electric", "Ice", "Ground", "Dark", "Dragon", "Grass"];
export function palElements(pal) { return (pal && pal.elements) || []; }
export function elementChipsHtml(pal) {
  return palElements(pal).map(e => {
    const m = ELEMENT_META[e] || { fr: e, c: "#888" };
    return `<span class="el-chip" style="background:${m.c}" title="Élément : ${m.fr}">${m.fr}</span>`;
  }).join("");
}

// ===== Rangs de tier-list (palworld.gg) =====
export const TIER_CATS = [
  { key: "overall",     label: "Global",  speed: null },
  { key: "workers",     label: "Workers", speed: null },
  { key: "combat",      label: "Combat",  speed: null },
  { key: "flyingMount", label: "Vol",     speed: "flying" },
  { key: "groundMount", label: "Sol",     speed: "ground" },
];
export function tierClass(t) { return t ? "tier-" + t : "tier-none"; }
export const TIER_RANK = { S: 0, A: 1, B: 2, C: 3, D: 4 };   // pour le tri (S en premier)
let flashTimer = null;
export function flashLimit() {
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

export function buildLegend() {
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

// ===== Icône d'un Pal (image auto-hébergée, sinon pastille de repli) =====
// Chemin relatif dérivé du code interne (BPClass) : icons/pals/{code}.png, récupéré
// par tools/fetch_icons.py. Couvre tous les Pals ayant un `code` (299/300) ; si le
// fichier manque (ou pas de code), on retombe sur une pastille à l'initiale.
function palIconUrl(pal) {
  return pal.code ? "icons/pals/" + pal.code + ".png" : null;
}
export function palIconEl(pal) {
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
export function palIconHtml(pal) {
  const url = palIconUrl(pal);
  const init = (pal.name[0] || "?").toUpperCase();
  if (url) return `<img class="pal-ic" loading="lazy" alt="" src="${url}" onerror="this.outerHTML='<span class=\\'pal-ic fallback\\'>${init}</span>'">`;
  return `<span class="pal-ic fallback">${init}</span>`;
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
    li.appendChild(suggestPrefBtn(pal));
    li.appendChild(stepperOrAdd("box", q, () => addBox(pal.id), d => setBoxQty(pal.id, q + d), () => setBoxQty(pal.id, 0), false));
  } else {
    li.appendChild(stepperOrAdd(mode, q, () => addPal(pal.id), d => setPalQty(pal.id, q + d), () => setPalQty(pal.id, 0), isFull()));
  }
  return li;
}

// Badge cliquable de l'onglet boîte : neutre -> épinglé -> exclu -> neutre.
// Contraint le suggesteur de compo (cf. docs/js/suggest.js).
const PREF_LOOK = {
  null:      { txt: "○", cls: "",        etat: "neutre",   suite: "épingler (toujours dans la compo)" },
  pin:       { txt: "📌", cls: "is-pin",  etat: "épinglé",  suite: "exclure de la compo" },
  exclude:   { txt: "🚫", cls: "is-excl", etat: "exclu",    suite: "revenir au neutre" },
};
function suggestPrefBtn(pal) {
  const pref = palPref(pal.id);
  const look = PREF_LOOK[pref] || PREF_LOOK.null;
  const b = document.createElement("button");
  b.type = "button";
  b.className = "pref-btn " + look.cls;
  b.innerHTML = `<span aria-hidden="true">${look.txt}</span>`;
  b.title = `Suggestion : ${look.etat} — clic pour ${look.suite}`;
  b.setAttribute("aria-label", `${pal.name} — suggestion : ${look.etat}. Activer pour ${look.suite}.`);
  b.disabled = readOnly;
  b.onclick = () => cyclePalPref(pal.id);
  return b;
}

function structRow(st, mode) {
  const q = structQty(st.id);
  const li = document.createElement("li");
  li.className = "pal-row" + (mode === "catalog" && q > 0 ? " in-camp" : "");

  const tile = document.createElement("div");
  tile.className = "pal-ic fallback struct-ic";
  tile.textContent = CATEGORY_ICON[st.category] || "🏗️";
  tile.title = st.category;
  tile.setAttribute("aria-hidden", "true");   // décoratif : la catégorie est écrite juste à côté
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
export function renderPalCatalog() {
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

export function renderStructCatalog() {
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

export function renderBoxCatalog() {
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

// ===== Rendu global =====
export function renderAll() {
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
  renderSuggestPrefs();
  updateUndoUI();
}
