import { PASSIVES, PASSIVE_CATEGORIES, PASSIVE_CODES, PASSIVE_SOURCES } from "./dataset.js";
import { store } from "./state.js";

// ===== Catalogue des compétences passives =====
//
// 100 passifs que peut porter un Pal — l'équipement est écarté à la source, un passif
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
  // Pas de poids du tout : la source n'en publie pas parce qu'il n'y en a pas. Ces
  // cinq-là se posent par un implant de mutation, jamais par un tirage.
  if (p.weight === null || p.weight === undefined)
    return { txt: "implant de mutation", cls: "tir-non" };
  if (p.weight <= 5) return { txt: "rare au hasard", cls: "tir-rare" };
  return { txt: "courant au hasard", cls: "tir-courant" };
}

// Le jeu ne compte qu'un marchand et qu'un chasseur de primes, et la table de
// fetch_passives.py liste tout leur inventaire. L'absence de provenance signifie donc
// « pas d'achat possible » ; c'est ensuite le poids qui départage un tirage clément,
// un tirage rare, ou pas de tirage du tout.
const provenance = p => (p.source ? PASSIVE_SOURCES[p.source] || p.source : null);

// ===== Croisement avec la boîte =====
// La sauvegarde ne stocke que des codes internes ; la table code -> nom permet de
// dire, passif par passif, combien de Pals le portent déjà. Recalculé à chaque rendu :
// la boîte change à l'import d'une save et rien ne préviendrait cette vue.
function effectifsBoite() {
  const parCode = new Map();
  let inconnus = 0;
  const codesConnus = PASSIVE_CODES;
  for (const e of Object.values(store.palBox || {})) {
    for (const code of (e && e.passives) || []) {
      if (!codesConnus[code]) { inconnus++; continue; }
      parCode.set(code, (parCode.get(code) || 0) + 1);
    }
  }
  const parPassif = new Map();
  for (const p of PASSIVES) {
    const n = (p.codes || []).reduce((s, c) => s + (parCode.get(c) || 0), 0);
    if (n) parPassif.set(p.name, n);
  }
  return { parPassif, inconnus };
}
// Ce que la boîte dit, et ce qu'elle ne dit pas. Les codes encore sans nom sont
// annoncés plutôt que passés sous silence : sans cela, un passif absent du décompte
// se lirait comme « je ne l'ai pas », alors qu'il signifie « je ne sais pas ».
function majBandeauBoite() {
  const el = document.getElementById("pv-boite-etat");
  if (!el) return;
  const total = Object.keys(store.palBox || {}).length;
  if (!total) {
    el.innerHTML = `Ta boîte est vide : importe une save pour voir quels passifs tu possèdes déjà.`;
    return;
  }
  const traçables = PASSIVES.filter(traçable).length;
  const possedes = effectifs.parPassif.size;
  el.innerHTML =
    `<b>${possedes}</b> passif${possedes > 1 ? "s" : ""} sur ${traçables} identifiables `
    + `présent${possedes > 1 ? "s" : ""} dans ta boîte de <b>${total}</b> Pals.`
    + (effectifs.inconnus
        ? ` <span class="pv-inconnu">${effectifs.inconnus} passif(s) portent un code encore sans nom — ils ne sont comptés nulle part.</span>`
        : "");
}

let effectifs = { parPassif: new Map(), inconnus: 0 };
const enBoite = p => effectifs.parPassif.get(p.name) || 0;
// Un passif sans code rattaché n'est pas « absent de la boîte » : on ne sait pas.
// Le filtre « qui me manquent » ne doit donc pas le compter comme manquant.
const traçable = p => !!(p.codes && p.codes.length);

let tri = "rarete";
const filtres = { q: "", rarete: "", categorie: "", polarite: "", provenance: "", boite: "" };

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
    (!filtres.provenance || ({
       // « Au hasard » exige un poids de tirage réel : cinq passifs n'en ont aucun,
       // ce sont des implants de mutation qu'aucun tirage ne pose. Les ranger avec
       // les autres reviendrait à promettre une chance qui n'existe pas.
       aleatoire: !p.source && p.weight > 0,
       implant: !p.source && !p.weight,
     }[filtres.provenance] ?? p.source === filtres.provenance)) &&
    (!filtres.boite || (filtres.boite === "possedes"
       ? enBoite(p) > 0 : traçable(p) && enBoite(p) === 0))
  ).sort(comparer);
}

export function renderPassives() {
  const hote = document.getElementById("pv-list");
  if (!hote) return;
  effectifs = effectifsBoite();
  majBandeauBoite();
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
    const n = enBoite(p);
    if (n) li.classList.add("is-owned");
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
        ${n ? `<span class="pv-box" title="Nombre de Pals de ta boîte qui portent ce passif">🎒 ${n}</span>` : ""}
        ${cats}
        ${prov ? `<span class="pv-src src-${p.source}" title="S'achète auprès de cette source, sans passer par le hasard.">${esc(prov)}</span>` : ""}
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
  document.getElementById("pv-boite").addEventListener("change", e => {
    filtres.boite = e.target.value; renderPassives();
  });
  document.getElementById("pv-polarite").addEventListener("change", e => {
    filtres.polarite = e.target.value; renderPassives();
  });
  document.getElementById("pv-tri").addEventListener("change", e => {
    tri = e.target.value; renderPassives();
  });
}
