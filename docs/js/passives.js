import { PASSIVES, PASSIVE_CATEGORIES, PASSIVE_SOURCES } from "./dataset.js";

// ===== Catalogue des compétences passives =====
//
// 93 passifs que peut porter un Pal — l'équipement est écarté à la source, un passif
// d'armure ne se transmettant pas par la reproduction.
//
// La rareté vient du RANG, qui est signé : son signe donne la polarité, sa valeur la
// couleur. Un rang négatif est rouge quelle que soit son amplitude — un malus reste un
// malus, qu'il coûte 10 % ou 30 %.
//
// Noms et effets sont en français, pris sur la page francophone de la source et
// appariés PAR POSITION avec l'anglaise — appariement vérifié à chaque collecte
// (cf. `_aligner` dans fetch_passives.py). Le nom anglais reste affiché en second :
// c'est celui des wikis, des guides et des codes internes du jeu.

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

// Une provenance connue veut dire « on peut se le procurer ainsi », pas « la liste est
// complète » : elle est relevée en jeu, aucune source ne la publie. « Sans source
// connue » filtre donc sur notre ignorance, pas sur une propriété du jeu — le libellé
// le dit, et le poids de tirage reste la seule information sur le hasard.
const provenance = p => (p.source ? PASSIVE_SOURCES[p.source] || p.source : null);

let tri = "rarete";
const filtres = { q: "", rarete: "", categorie: "", polarite: "", provenance: "" };

// Le tri suit le nom AFFICHÉ, donc le français ; les rares passifs dont la source
// n'aurait pas de traduction retombent sur l'anglais plutôt que sur du vide.
const nomDe = p => p.nameFr || p.name;
const effetDe = p => p.effectFr || p.effect;

function comparer(a, b) {
  if (tri === "nom") return nomDe(a).localeCompare(nomDe(b), "fr");
  if (tri === "categorie")
    return (a.categories[0] || "").localeCompare(b.categories[0] || "", "fr")
        || nomDe(a).localeCompare(nomDe(b), "fr");
  // Par défaut : arc-en-ciel d'abord, négatifs en dernier, puis rang décroissant.
  return RARETES[a.rarity].ordre - RARETES[b.rarity].ordre
      || Math.abs(b.rank) - Math.abs(a.rank)
      || nomDe(a).localeCompare(nomDe(b), "fr");
}

function retenus() {
  const q = filtres.q.toLowerCase();
  // La recherche porte sur les DEUX langues : on tape aussi bien « Artisan » que
  // « Appliqué », et les guides anglophones restent utilisables tels quels.
  return PASSIVES.filter(p =>
    (!q || [nomDe(p), p.name, effetDe(p), p.effect]
             .some(t => t && t.toLowerCase().includes(q))) &&
    (!filtres.rarete || p.rarity === filtres.rarete) &&
    (!filtres.categorie || p.categories.includes(filtres.categorie)) &&
    (!filtres.polarite || String(p.positive) === filtres.polarite) &&
    (!filtres.provenance || (filtres.provenance === "aucune"
       ? !p.source : p.source === filtres.provenance))
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
    const prov = provenance(p);
    const cats = p.categories
      .map(c => `<span class="pv-cat">${esc(PASSIVE_CATEGORIES[c] || c)}</span>`).join("");
    li.innerHTML = `
      <span class="pv-rar" title="Rang ${p.rank} — ${RARETES[p.rarity].libelle}">${RARETES[p.rarity].libelle}</span>
      <span class="pv-main">
        <span class="pv-name">${esc(nomDe(p))}${
          nomDe(p) !== p.name ? `<span class="pv-en">${esc(p.name)}</span>` : ""}</span>
        <span class="pv-eff">${esc(effetDe(p))}</span>
      </span>
      <span class="pv-tags">
        ${cats}
        ${prov ? `<span class="pv-src src-${p.source}" title="Relevé en jeu : ce passif s'obtient auprès de cette source. La liste n'est pas exhaustive.">${esc(prov)}</span>` : ""}
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
  document.getElementById("pv-provenance").addEventListener("change", e => {
    filtres.provenance = e.target.value; renderPassives();
  });
  document.getElementById("pv-polarite").addEventListener("change", e => {
    filtres.polarite = e.target.value; renderPassives();
  });
  document.getElementById("pv-tri").addEventListener("change", e => {
    tri = e.target.value; renderPassives();
  });
}
