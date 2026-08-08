import { PALS, palsById } from "./dataset.js";
import { openPalDetail, palIconHtml } from "./render.js";

// ===== Butin, dans les deux sens =====
//
// « Qui lâche cet objet ? » et « que lâche ce Pal ? » sont la même table lue dans deux
// directions. La seconde sert aussi au DESTRUCTEUR DE PALS : il rend le même butin que
// l'abattage, donc rien de nouveau à collecter — juste une lecture qui manquait.
let DROP_INDEX = null;   // [[item, [{id, name, amount, rate}]], ...] trié par objet
let sens = "objet";      // "objet" | "pal"

// Un objet peut être lâché par la moitié du bestiaire : cinq items en comptent 106
// chacun, soit 41 % des 1 283 couples objet-Pal à eux seuls. La médiane, elle, est de
// TROIS. On plafonne donc l'affichage par objet — la liste passe de 1 283 lignes à
// 395, et 81 objets sur 116 ne sont même pas concernés.
const CAP_PALS = 6;
const deplies = new Set();

function rateNum(rate) { const m = /([\d.]+)/.exec(rate || ""); return m ? parseFloat(m[1]) : 0; }

function fmtAmount(amount) {
  const parts = (amount || "").split("-").map(s => s.trim());
  return parts.length === 2 && parts[0] === parts[1] ? parts[0] : amount;
}

function buildDropIndex() {
  const idx = new Map();
  PALS.forEach(p => (p.drops || []).forEach(d => {
    if (!idx.has(d.item)) idx.set(d.item, []);
    idx.get(d.item).push({ id: p.id, name: p.name, amount: d.amount, rate: d.rate });
  }));
  for (const arr of idx.values())
    arr.sort((a, b) => rateNum(b.rate) - rateNum(a.rate) || a.name.localeCompare(b.name, "fr"));
  DROP_INDEX = [...idx.entries()].sort((a, b) => a[0].localeCompare(b[0], "fr"));
}

function dropItemRow(item, pals) {
  const li = document.createElement("li");
  li.className = "drop-item";
  const tout = deplies.has(item);
  const montres = tout ? pals : pals.slice(0, CAP_PALS);
  // Le nom ouvre la FICHE INTERNE, pas palworld.gg. Elle contient désormais la
  // compétence de partenaire, le butin et la carte des apparitions : sortir de
  // l'application pour en savoir moins n'avait plus de sens.
  const palsHtml = montres.map(p =>
    `<li class="drop-pal"><button type="button" class="drop-pal-btn" data-pal="${p.id}"` +
    ` aria-label="Fiche de ${p.name}">${p.name}</button>` +
    `<span class="drop-amt">×${fmtAmount(p.amount)}</span>` +
    `<span class="drop-rate">${p.rate}</span></li>`).join("");
  const reste = pals.length - montres.length;
  const plus = reste > 0 || tout
    ? `<li class="drop-plus"><button type="button" class="bar-btn" data-plus="${item}">` +
      `${tout ? "Réduire" : `+ ${reste} autre${reste > 1 ? "s" : ""}`}</button></li>`
    : "";
  li.innerHTML =
    `<div class="drop-item-name">${item} <span class="drop-pal-count">${pals.length} Pal${pals.length > 1 ? "s" : ""}</span></div>` +
    `<ul class="drop-pals">${palsHtml}${plus}</ul>`;
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
    `<div class="drop-item-name"><button type="button" class="drop-pal-btn drop-tete"`
    + ` data-pal="${pal.id}" aria-label="Fiche de ${pal.name}">${palIconHtml(pal)} ${pal.name}</button> `
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
  // UN écouteur pour toute la liste, pas un par ligne : à 400 boutons, en poser un
  // sur chacun coûterait à chaque rendu ce qu'on vient d'économiser en lignes.
  const liste = document.getElementById("drop-list");
  if (liste) liste.addEventListener("click", e => {
    const plus = e.target.closest("[data-plus]");
    if (plus) {
      const item = plus.dataset.plus;
      if (deplies.has(item)) deplies.delete(item); else deplies.add(item);
      renderDrops();
      return;
    }
    const b = e.target.closest(".drop-pal-btn");
    if (b) openPalDetail(palsById[Number(b.dataset.pal)]);
  });

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
