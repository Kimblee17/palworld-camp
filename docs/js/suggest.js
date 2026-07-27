import { levelClass, renderAll } from "./render.js";
import { active, palBoxCounts, pushUndo, readOnly, saveStore } from "./state.js";
import { WORK_TYPES, palsById, structById, workById } from "./dataset.js";

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

export function renderSuggestion() {
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
