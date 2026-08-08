import { PALS } from "./dataset.js";
import { palIconHtml } from "./render.js";

// ===== Butin, dans les deux sens =====
//
// « Qui lâche cet objet ? » et « que lâche ce Pal ? » sont la même table lue dans deux
// directions. La seconde sert aussi au DESTRUCTEUR DE PALS : il rend le même butin que
// l'abattage, donc rien de nouveau à collecter — juste une lecture qui manquait.
let DROP_INDEX = null;   // [[item, [{name, slug, amount, rate}]], ...] trié par objet
let sens = "objet";      // "objet" | "pal"

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

// Une ligne par Pal : sa vignette, puis ce qu'il lâche.
function dropPalRow(pal) {
  const li = document.createElement("li");
  li.className = "drop-item";
  const objets = (pal.drops || [])
    .slice()
    .sort((a, b) => rateNum(b.rate) - rateNum(a.rate) || a.item.localeCompare(b.item, "fr"))
    .map(d => `<li class="drop-pal">${d.item}<span class="drop-amt">×${fmtAmount(d.amount)}</span>`
            + `<span class="drop-rate">${d.rate}</span></li>`).join("");
  const n = (pal.drops || []).length;
  li.innerHTML =
    `<div class="drop-item-name">${palIconHtml(pal)} ${pal.name} `
    + `<span class="drop-pal-count">${n} objet${n > 1 ? "s" : ""}</span></div>`
    + `<ul class="drop-pals">${objets}</ul>`;
  return li;
}

export function renderDrops() {
  if (!DROP_INDEX) buildDropIndex();
  const q = document.getElementById("drop-search").value.trim().toLowerCase();
  const list = document.getElementById("drop-list");
  const compte = document.getElementById("drop-count");
  const unite = document.getElementById("drop-unite");
  list.innerHTML = "";

  if (sens === "pal") {
    const pals = PALS.filter(p => (p.drops || []).length && (!q || p.name.toLowerCase().includes(q)))
      .sort((a, b) => a.name.localeCompare(b.name, "fr"));
    compte.textContent = pals.length;
    unite.textContent = pals.length > 1 ? "Pals" : "Pal";
    if (!pals.length) { list.innerHTML = `<li class="empty">Aucun Pal trouvé.</li>`; return; }
    pals.forEach(p => list.appendChild(dropPalRow(p)));
    return;
  }

  const items = DROP_INDEX.filter(([item]) => !q || item.toLowerCase().includes(q));
  compte.textContent = items.length;
  unite.textContent = items.length > 1 ? "objets" : "objet";
  if (!items.length) { list.innerHTML = `<li class="empty">Aucun objet trouvé.</li>`; return; }
  items.forEach(([item, pals]) => list.appendChild(dropItemRow(item, pals)));
}

export function initDrops() {
  const boutons = { objet: document.getElementById("drop-par-objet"),
                    pal: document.getElementById("drop-par-pal") };
  if (!boutons.objet) return;
  for (const [cle, b] of Object.entries(boutons)) {
    b.addEventListener("click", () => {
      sens = cle;
      for (const [c, x] of Object.entries(boutons)) {
        x.classList.toggle("active", c === cle);
        x.setAttribute("aria-pressed", String(c === cle));
      }
      // Le champ change d'objet : garder « Rechercher un objet » en mode Pal
      // enverrait chercher au mauvais endroit.
      const champ = document.getElementById("drop-search");
      champ.placeholder = cle === "pal" ? "Rechercher un Pal…" : "Rechercher un objet…";
      champ.value = "";
      renderDrops();
    });
  }
}
