import { PASSIVES, PASSIVE_CATEGORIES } from "./dataset.js";

// ===== Catalogue des compétences passives =====
//
// 93 passifs que peut porter un Pal — l'équipement est écarté à la source, un passif
// d'armure ne se transmettant pas par la reproduction.
//
// La rareté vient du RANG, qui est signé : son signe donne la polarité, sa valeur la
// couleur. Un rang négatif est rouge quelle que soit son amplitude — un malus reste un
// malus, qu'il coûte 10 % ou 30 %.
//
// ⚠ Les noms sont en anglais : aucune source ne permet de joindre les noms français de
// façon fiable (cf. l'en-tête de fetch_passives.py). Ils suivront avec la table de
// correspondance des codes internes.

const RARETES = {
  arcenciel: { libelle: "Arc-en-ciel", ordre: 0 },
  dore:      { libelle: "Doré",        ordre: 1 },
  commun:    { libelle: "Commun",      ordre: 2 },
  negatif:   { libelle: "Négatif",     ordre: 3 },
};

const esc = s => String(s).replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Un poids de tirage n'est pas une provenance, et on ne prétend pas le contraire :
// 0 signifie seulement que le passif n'apparaît jamais au hasard sur un Pal sauvage.
function tirage(p) {
  if (p.weight === 0) return { txt: "jamais au hasard", cls: "tir-non" };
  if (p.weight === null || p.weight === undefined) return null;
  if (p.weight <= 5) return { txt: "rare au hasard", cls: "tir-rare" };
  return { txt: "courant au hasard", cls: "tir-courant" };
}

let tri = "rarete";
const filtres = { q: "", rarete: "", categorie: "", polarite: "" };

function comparer(a, b) {
  if (tri === "nom") return a.name.localeCompare(b.name, "fr");
  if (tri === "categorie")
    return (a.categories[0] || "").localeCompare(b.categories[0] || "", "fr")
        || a.name.localeCompare(b.name, "fr");
  // Par défaut : arc-en-ciel d'abord, négatifs en dernier, puis rang décroissant.
  return RARETES[a.rarity].ordre - RARETES[b.rarity].ordre
      || Math.abs(b.rank) - Math.abs(a.rank)
      || a.name.localeCompare(b.name, "fr");
}

function retenus() {
  const q = filtres.q.toLowerCase();
  return PASSIVES.filter(p =>
    (!q || p.name.toLowerCase().includes(q) || p.effect.toLowerCase().includes(q)) &&
    (!filtres.rarete || p.rarity === filtres.rarete) &&
    (!filtres.categorie || p.categories.includes(filtres.categorie)) &&
    (!filtres.polarite || String(p.positive) === filtres.polarite)
  ).sort(comparer);
}

export function renderPassives() {
  const hote = document.getElementById("pv-list");
  if (!hote) return;
  const liste = retenus();
  document.getElementById("pv-count").textContent = liste.length;

  hote.innerHTML = "";
  if (!liste.length) {
    hote.innerHTML = `<li class="empty">Aucune compétence passive ne correspond.</li>`;
    return;
  }
  for (const p of liste) {
    const li = document.createElement("li");
    li.className = "pv-row rar-" + p.rarity;
    const t = tirage(p);
    const cats = p.categories
      .map(c => `<span class="pv-cat">${esc(PASSIVE_CATEGORIES[c] || c)}</span>`).join("");
    li.innerHTML = `
      <span class="pv-rar" title="Rang ${p.rank} — ${RARETES[p.rarity].libelle}">${RARETES[p.rarity].libelle}</span>
      <span class="pv-main">
        <span class="pv-name">${esc(p.name)}</span>
        <span class="pv-eff">${esc(p.effect)}</span>
      </span>
      <span class="pv-tags">
        ${cats}
        ${t ? `<span class="pv-tir ${t.cls}" title="Probabilité d'apparaître au hasard sur un Pal">${t.txt}</span>` : ""}
      </span>`;
    hote.appendChild(li);
  }
}

export function initPassives() {
  const q = document.getElementById("pv-search");
  if (!q) return;

  const cat = document.getElementById("pv-cat");
  for (const [cle, lbl] of Object.entries(PASSIVE_CATEGORIES)) cat.add(new Option(lbl, cle));

  q.addEventListener("input", e => { filtres.q = e.target.value.trim(); renderPassives(); });
  document.getElementById("pv-rarete").addEventListener("change", e => {
    filtres.rarete = e.target.value; renderPassives();
  });
  cat.addEventListener("change", e => { filtres.categorie = e.target.value; renderPassives(); });
  document.getElementById("pv-polarite").addEventListener("change", e => {
    filtres.polarite = e.target.value; renderPassives();
  });
  document.getElementById("pv-tri").addEventListener("change", e => {
    tri = e.target.value; renderPassives();
  });
}
