import { palIconEl } from "./render.js";
import { PALS, DB } from "./dataset.js";

// ===== Vue Production : d'un objectif de fabrication vers les ressources de base =====
//
// On part d'un objet + une quantité et on déroule sa nomenclature complète :
//   - un objet AVEC recette est un nœud dépliable ;
//   - un objet SANS recette est une feuille = ressource de base (à récolter, miner,
//     ou à récupérer sur un Pal) ;
//   - un ingrédient inconnu (ni recette, ni objet connu) est affiché tel quel, marqué.
//
// Les quantités tiennent compte du rendement : une recette produit `count` unités, il
// faut donc ceil(besoin / count) fabrications, et les ingrédients sont multipliés par
// ce nombre de fabrications (pas par la quantité demandée).

const RECIPES = DB.recipes || {};
const PRODUCED_BY = DB.producedBy || {};
// Objets du jeu sans recette : ressources brutes (Blé, Paloxite, Minerai…). Un
// ingrédient ABSENT de cet ensemble n'est pas une ressource, c'est un nom que nos
// données ne reconnaissent pas — le seul cas qui mérite le marqueur « inconnu ».
const RAW = new Set(DB.rawItems || []);

// Profondeur maximale : garde-fou contre une éventuelle recette cyclique dans les
// données (A demande B qui redemande A). On coupe et on le signale dans l'arbre.
export const MAX_DEPTH = 12;

// Index objet -> Pals qui le lâchent, trié par taux décroissant (réutilise les drops).
const rateNum = r => { const m = String(r || "").match(/[\d.]+/); return m ? parseFloat(m[0]) : 0; };
let _dropIndex = null;
function dropIndex() {
  if (_dropIndex) return _dropIndex;
  const idx = {};
  for (const p of PALS) {
    for (const d of p.drops || []) {
      (idx[d.item] || (idx[d.item] = [])).push({ pal: p, amount: d.amount, rate: d.rate });
    }
  }
  for (const list of Object.values(idx)) list.sort((a, b) => rateNum(b.rate) - rateNum(a.rate));
  return (_dropIndex = idx);
}

/**
 * Construit l'arbre de décomposition.
 * `chemin` porte les objets déjà traversés sur cette branche : si un objet réapparaît,
 * c'est un cycle — on s'arrête là plutôt que de boucler à l'infini.
 */
export function buildTree(nom, besoin, totaux = {}, chemin = [], depth = 0) {
  const recette = RECIPES[nom];
  const noeud = { nom, besoin, enfants: [], depth };

  if (chemin.includes(nom)) { noeud.cycle = true; return noeud; }
  if (depth >= MAX_DEPTH) { noeud.tropProfond = true; return noeud; }

  if (!recette) {
    // Feuille : un ingrédient sans recette. On cumule la quantité et on liste les Pals
    // qui le lâchent — c'est la seule provenance dont la donnée soit vérifiée.
    //
    // ⚠ ON N'AFFIRME PLUS D'OÙ VIENT UN INGRÉDIENT NI AVEC QUELLE MACHINE. Les
    // étiquettes « ressource de base » et « à récolter dans le monde » se déduisaient
    // d'une absence — pas de recette, pas de structure, pas de Pal — ce qui les rendait
    // fausses dès qu'une donnée manquait au lieu d'être nulle. Quant aux établis, la
    // cartographie est erronée même hors devinettes : la farine sortait d'une marmite
    // au lieu d'un broyeur, sans être signalée « probable ».
    noeud.feuille = true;
    totaux[nom] = (totaux[nom] || 0) + besoin;
    noeud.pals = (dropIndex()[nom] || []).slice(0, 3);
    // Nom absent du catalogue d'objets : ni recette ni ressource connue.
    noeud.inconnu = !RAW.has(nom);
    return noeud;
  }

  const parCraft = Math.max(1, recette.count || 1);
  const crafts = Math.ceil(besoin / parCraft);
  noeud.crafts = crafts;
  noeud.parCraft = parCraft;

  for (const ing of recette.ingredients) {
    noeud.enfants.push(
      buildTree(ing.name, ing.count * crafts, totaux, chemin.concat(nom), depth + 1));
  }
  return noeud;
}

export function planFor(nom, qte) {
  const totaux = {};
  const racine = buildTree(nom, qte, totaux);
  return { racine, totaux };
}

/**
 * Audit des données de recettes, à appeler depuis la console (`PW_PROD_DEBUG()`).
 * Sert à repérer un scraping qui se dégraderait : ingrédients hors catalogue,
 * ressources sans provenance connue, objets fabriqués sans station rattachée.
 *
 * Ces deux derniers compteurs ne servent PLUS l'affichage — la vue n'affirme plus de
 * provenance — mais ils restent le meilleur signal de santé du scraping de recettes.
 */
export function DEBUG() {
  const ingredients = new Set();
  for (const r of Object.values(RECIPES)) for (const i of r.ingredients) ingredients.add(i.name);
  const feuilles = [...ingredients].filter(n => !RECIPES[n]);
  const drops = dropIndex();
  return {
    recettes: Object.keys(RECIPES).length,
    sansStation: Object.keys(RECIPES).filter(n => !RECIPES[n].stationId),
    ingredientsInconnus: feuilles.filter(n => !RAW.has(n)),
    ressourcesSansProvenance: feuilles.filter(n => RAW.has(n) && !PRODUCED_BY[n] && !drops[n]),
  };
}

// ===== Rendu =====
let objetChoisi = null, quantite = 1;
const replies = new Set();          // noeuds repliés (clé = chemin)

const objetsCraftables = () => Object.keys(RECIPES).sort((a, b) => a.localeCompare(b, "fr"));

function noeudEl(n, cle) {
  const li = document.createElement("li");
  li.className = "pr-node" + (n.feuille ? " is-leaf" : "");

  const tete = document.createElement("div");
  tete.className = "pr-head";

  const pliable = n.enfants.length > 0;
  if (pliable) {
    const b = document.createElement("button");           // <button> : Entrée/Espace natifs
    b.type = "button";
    b.className = "pr-toggle";
    const ouvert = !replies.has(cle);
    b.setAttribute("aria-expanded", String(ouvert));
    b.innerHTML = `<span aria-hidden="true">${ouvert ? "▾" : "▸"}</span>`;
    b.setAttribute("aria-label", `${ouvert ? "Replier" : "Déplier"} ${n.nom}`);
    b.onclick = () => { replies.has(cle) ? replies.delete(cle) : replies.add(cle); render(); };
    tete.appendChild(b);
  } else {
    const sp = document.createElement("span");
    sp.className = "pr-toggle pr-spacer";
    sp.setAttribute("aria-hidden", "true");
    tete.appendChild(sp);
  }

  const t = document.createElement("span");
  t.className = "pr-name";
  t.innerHTML = `<b>${n.besoin}</b> × ${n.nom}`;
  tete.appendChild(t);

  if (n.crafts && n.parCraft > 1)
    tete.insertAdjacentHTML("beforeend",
      `<span class="pr-meta">${n.crafts} fabrication(s) × ${n.parCraft}</span>`);
  if (n.cycle)
    tete.insertAdjacentHTML("beforeend", `<span class="pr-warn">↻ cycle — branche coupée</span>`);
  if (n.tropProfond)
    tete.insertAdjacentHTML("beforeend", `<span class="pr-warn">profondeur maximale atteinte</span>`);
  if (n.inconnu)
    tete.insertAdjacentHTML("beforeend",
      `<span class="pr-warn" title="Cet ingrédient ne figure pas dans notre catalogue d'objets">? ingrédient inconnu</span>`);
  li.appendChild(tete);

  // Feuille : les 3 meilleurs Pals qui la lâchent (taux décroissant).
  if (n.feuille && n.pals && n.pals.length) {
    const ul = document.createElement("ul");
    ul.className = "pr-pals";
    for (const d of n.pals) {
      const pli = document.createElement("li");
      pli.appendChild(palIconEl(d.pal));
      pli.insertAdjacentHTML("beforeend",
        `<span class="pr-pal-n">${d.pal.name}</span><span class="pr-pal-r">×${d.amount} · ${d.rate}</span>`);
      ul.appendChild(pli);
    }
    li.appendChild(ul);
  }

  if (pliable && !replies.has(cle)) {
    const ul = document.createElement("ul");
    ul.className = "pr-children";
    n.enfants.forEach((c, i) => ul.appendChild(noeudEl(c, cle + "/" + i + c.nom)));
    li.appendChild(ul);
  }
  return li;
}

function render() {
  const host = document.getElementById("pr-result");
  if (!host) return;
  if (!objetChoisi || !RECIPES[objetChoisi]) {
    host.innerHTML = `<p class="pr-msg">Choisis un objet à fabriquer.</p>`;
    return;
  }
  const { racine, totaux } = planFor(objetChoisi, Math.max(1, quantite));
  host.innerHTML = "";

  const arbre = document.createElement("ul");
  arbre.className = "pr-tree";
  // La clé de la racine porte le NOM de l'objet : une clé fixe faisait hériter au
  // suivant l'état replié du précédent, et on changeait de sélection pour tomber sur
  // un arbre fermé.
  arbre.appendChild(noeudEl(racine, "r:" + objetChoisi));
  host.appendChild(arbre);

  // Récapitulatif des ressources de base
  const noms = Object.keys(totaux).sort((a, b) => totaux[b] - totaux[a] || a.localeCompare(b, "fr"));
  const rec = document.createElement("div");
  rec.className = "pr-summary";
  rec.innerHTML = `<h3>Ingrédients à réunir — ${noms.length}</h3>`;
  const ul = document.createElement("ul");
  for (const n of noms) {
    const pals = (dropIndex()[n] || []).slice(0, 3).map(d => d.pal.name).join(", ");
    const li = document.createElement("li");
    li.innerHTML = `<b>${totaux[n]}</b> × ${n}`
      + (pals ? ` <span class="pr-meta">🐾 ${pals}</span>` : "");
    ul.appendChild(li);
  }
  rec.appendChild(ul);
  host.appendChild(rec);

}

export const renderProduction = render;

export function initProduction() {
  const sel = document.getElementById("pr-item");
  if (!sel) return;
  const remplir = (q = "") => {
    const liste = objetsCraftables().filter(n => !q || n.toLowerCase().includes(q));
    sel.innerHTML = "";
    for (const n of liste) sel.appendChild(new Option(n, n));
    if (liste.length) { objetChoisi = liste[0]; sel.value = liste[0]; }
    return liste.length;
  };
  remplir();
  sel.addEventListener("change", () => { objetChoisi = sel.value; render(); });
  document.getElementById("pr-search").addEventListener("input", e => {
    if (remplir(e.target.value.trim().toLowerCase())) render();
  });
  const q = document.getElementById("pr-qty");
  q.addEventListener("change", () => {
    quantite = Math.max(1, parseInt(q.value, 10) || 1); q.value = quantite; render();
  });
  document.getElementById("pr-expand").addEventListener("click", () => { replies.clear(); render(); });
}
