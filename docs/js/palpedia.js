import { TIER_CATS, TIER_RANK, elementChipsHtml, levelClass, levelName, openPalCompare, palElements, palIconHtml, tierClass } from "./render.js";
import { boxQty } from "./state.js";
import { PALS, WORK_TYPES, palsById } from "./dataset.js";

let pediaSort = { key: "name", dir: 1 };              // dir: 1 = croissant, -1 = décroissant

// ===== Sélection pour le comparateur =====
// État de SESSION : volontairement ni dans le store ni dans localStorage. Comparer
// deux Pals est un geste de consultation, pas une donnée de camp — le recharger au
// prochain lancement n'aurait aucun sens. Vidé en quittant la vue.
const CMP_MAX = 4;
const selection = new Set();

export function clearPediaSelection(rerender = true) {
  if (!selection.size) return;
  selection.clear();
  // La table n'est reconstruite que si on reste dans la vue ; la barre, elle, est
  // toujours remise à jour pour ne pas garder un « Comparer (3) » périmé.
  if (rerender) renderPalpedia();
  else syncPediaSelection();
}

export function togglePediaSelection(id) {
  if (selection.has(id)) selection.delete(id);
  else if (selection.size < CMP_MAX) selection.add(id);
  // Les cases sont désactivées au-delà de CMP_MAX : on ne rejoue que leur état
  // désactivé et la barre, sans reconstruire la table (le tri et le scroll restent).
  syncPediaSelection();
}

export function openPediaCompare() {
  if (selection.size < 2) return;
  openPalCompare([...selection].map(id => palsById[id]).filter(Boolean));
}

// Reflète la sélection sur les cases déjà rendues + met à jour la barre flottante.
function syncPediaSelection() {
  const plein = selection.size >= CMP_MAX;
  document.querySelectorAll("#pedia-body .pedia-pick input").forEach(cb => {
    const id = Number(cb.dataset.pal);
    cb.checked = selection.has(id);
    cb.disabled = plein && !cb.checked;
    cb.closest("tr")?.classList.toggle("is-picked", cb.checked);
  });
  const bar = document.getElementById("pedia-compare-bar");
  if (!bar) return;
  bar.hidden = selection.size < 2;
  const btn = document.getElementById("cmp-open");
  if (btn) btn.textContent = `Comparer (${selection.size})`;
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
  const pick = `<td class="pedia-pick"><input type="checkbox" data-pal="${pal.id}"` +
    `${selection.has(pal.id) ? " checked" : ""}` +
    `${selection.size >= CMP_MAX && !selection.has(pal.id) ? " disabled" : ""}` +
    ` aria-label="Comparer ${pal.name}"></td>`;
  tr.innerHTML = pick +
    `<td class="pedia-name">${palIconHtml(pal)}${name}${night}` +
      `${boxQty(pal.id) > 0 ? ' <span class="owned-badge" title="Dans ma boîte">✓</span>' : ''}` +
      `<div class="pedia-el">${elementChipsHtml(pal)}</div></td>` +
    `<td class="pedia-num">${lvl}</td>` +
    `<td>${rarity}</td>` +
    `<td class="pedia-num">${cap}</td>` +
    `<td><div class="pedia-skills">${skills || MUTED}</div></td>` +
    tiers;
  tr.dataset.pal = pal.id;
  if (selection.has(pal.id)) tr.classList.add("is-picked");
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

export function setPediaSort(key) {
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
    if (!active) { th.removeAttribute("aria-sort"); return; }
    // L'état de tri est porté par aria-sort sur le th ; la flèche n'est que visuelle.
    th.setAttribute("aria-sort", pediaSort.dir === 1 ? "ascending" : "descending");
    const arrow = document.createElement("span");
    arrow.className = "arrow";
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = pediaSort.dir === 1 ? " ▲" : " ▼";
    (th.querySelector("button") || th).appendChild(arrow);
  });
}

export function renderPalpedia() {
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
    body.innerHTML = `<tr><td class="empty" colspan="${6 + TIER_CATS.length}">Aucun Pal trouvé.</td></tr>`;
    syncPediaSelection();
    return;
  }
  rows.forEach(p => body.appendChild(pediaRow(p)));
  syncPediaSelection();
}
