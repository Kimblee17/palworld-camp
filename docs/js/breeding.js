import { palIconEl, palIconHtml, elementChipsHtml, openPalDetail } from "./render.js";
import { palBoxCounts } from "./state.js";
import { PALS, palsById, DB } from "./dataset.js";

// ===== Calculateur de reproduction =====
//
// RÈGLE DU JEU (Palworld 1.0), dans cet ordre :
//   1. une COMBINAISON UNIQUE portant sur la paire l'emporte (l'enfant est imposé) ;
//      certaines ne valent que pour un sens de sexes (ga/gb) ;
//   2. deux parents de la MÊME espèce donnent cette espèce ;
//   3. sinon l'enfant est l'espèce dont le « breed power » (CombiRank) est le plus
//      proche de  floor((powerA + powerB + 1) / 2).
//
// DÉPARTAGE à distance égale : l'espèce dont le combiPriority est le PLUS ÉLEVÉ.
// combiPriority est le champ CombiDuplicatePriority du jeu (valeur identique dans les
// stats paldb.cc). Vérifié de deux façons : la formule est celle documentée par
// https://palbreeding.com/guides/palworld-breeding-formula (« ties broken by the game's
// own CombiDuplicatePriority field »), et le sens du départage a été relevé dans le
// calculateur de palworld.gg lui-même, qui sert nos données :
//     (c < r || c == r && d.combiPriority > t.combiPriority) && (r = c, t = d)
//
// Deux exclusions, tirées de la même implémentation de référence :
//   - une espèce marquée breedNoResult (ignoreCombi) ne sort jamais d'un œuf par la
//     règle générale (légendaires…) ;
//   - une espèce qui est l'enfant d'une combinaison unique ne sort QUE de celle-ci.
//
// On ne stocke pas la matrice des paires : la table de correspondance ci-dessous est
// construite une fois en mémoire, au premier calcul.

const UNIQUE_COMBOS = DB.uniqueCombos || [];

// Combos indexés par participant, pour ne pas balayer la liste à chaque appel.
const combosByPal = new Map();
for (const c of UNIQUE_COMBOS) {
  for (const id of new Set([c.a, c.b])) {
    if (!combosByPal.has(id)) combosByPal.set(id, []);
    combosByPal.get(id).push(c);
  }
}
const uniqueChildIds = new Set(UNIQUE_COMBOS.map(c => c.child));
// Paires déjà couvertes par une combinaison unique (dans les deux sens).
const uniquePairs = new Set();
for (const c of UNIQUE_COMBOS) { uniquePairs.add(c.a + "|" + c.b); uniquePairs.add(c.b + "|" + c.a); }

// Parents possibles : il suffit d'avoir un breed power.
// `breedNoResult` (l'ignoreCombi de palworld.gg) veut dire « ne peut pas être l'ENFANT
// d'un croisement générique ». Il ne dit rien de la capacité à être PARENT : deux Pals
// de la même espèce donnent toujours cette espèce, y compris pour un légendaire. Cette
// nuance manquait, et écartait Astralym et Panthalus de la recherche.
export const BREEDERS = PALS.filter(p => p.breedPower && !p.breedIsBoss);
// Enfants possibles par la règle générale.
const GENERIC_CHILDREN = BREEDERS.filter(p => !uniqueChildIds.has(p.id) && !p.breedNoResult);

let _table = null;
function table() {
  if (_table) return _table;
  const max = Math.max(...BREEDERS.map(p => p.breedPower)) + 1;
  _table = new Array(max + 1);
  for (let t = 0; t <= max; t++) {
    let best = null, bd = Infinity;
    for (const p of GENERIC_CHILDREN) {
      const d = Math.abs(p.breedPower - t);
      if (d < bd || (d === bd && p.breedPriority > best.breedPriority)) { bd = d; best = p; }
    }
    _table[t] = best;
  }
  return _table;
}

// Une contrainte de sexe absente vaut « n'importe lequel ».
const genderOk = (need, got) => !need || !got || need === got;

/** Enfant d'un couple. ga/gb : sexes des parents ("M"/"F"), facultatifs. */
export function childOf(a, b, ga, gb) {
  if (!a || !b || !a.breedPower || !b.breedPower) return null;
  for (const c of combosByPal.get(a.id) || []) {
    if (c.a === a.id && c.b === b.id && genderOk(c.ga, ga) && genderOk(c.gb, gb)) return palsById[c.child];
    if (c.a === b.id && c.b === a.id && genderOk(c.ga, gb) && genderOk(c.gb, ga)) return palsById[c.child];
  }
  if (a.id === b.id) return a;                       // même espèce -> même espèce
  return table()[(a.breedPower + b.breedPower + 1) >> 1] || null;
}

/** Toutes les paires de parents donnant `target`. */
export function parentsFor(target) {
  const out = [];
  for (const c of UNIQUE_COMBOS) {
    if (c.child !== target.id) continue;
    const a = palsById[c.a], b = palsById[c.b];
    if (a && b) out.push({ a, b, unique: true, ga: c.ga || null, gb: c.gb || null });
  }
  // Espèce exclue de la table générique : aucun couple mixte ne la redonne, mais
  // deux individus de son espèce si — c'est la seule voie d'élevage pour Astralym
  // ou Panthalus, et ne pas la proposer laissait croire qu'ils étaient inélevables.
  if (!uniqueChildIds.has(target.id) && target.breedNoResult && target.breedPower) {
    out.push({ a: target, b: target, unique: false });
  } else if (!uniqueChildIds.has(target.id) && !target.breedNoResult && target.breedPower) {
    const T = table();
    for (let i = 0; i < BREEDERS.length; i++) {
      for (let j = i; j < BREEDERS.length; j++) {
        const a = BREEDERS[i], b = BREEDERS[j];
        if (uniquePairs.has(a.id + "|" + b.id)) continue;   // déjà traité en combo unique
        const child = a.id === b.id ? a : T[(a.breedPower + b.breedPower + 1) >> 1];
        if (child && child.id === target.id) out.push({ a, b, unique: false });
      }
    }
  }
  return out;
}

// ===== Plan d'élevage sur plusieurs générations =====
//
// « Comment obtenir X à partir de ce que j'ai ? » Parcours en LARGEUR sur les espèces
// atteignables : chaque génération croise tout ce qu'on possède déjà, et la largeur
// d'abord garantit le plan le plus court en nombre de générations.
//
// Une subtilité qui change le résultat : croiser une espèce avec ELLE-MÊME exige d'en
// posséder deux exemplaires. En revanche, dès qu'une espèce est PRODUITE par le plan,
// on peut en faire éclore autant d'œufs qu'on veut — elle devient donc disponible en
// quantité, et son auto-croisement redevient possible.
const MAX_GENERATIONS = 5;

export function planDeReproduction(cibleId, quantites, maxGen = MAX_GENERATIONS) {
  const possede = new Set();
  const illimite = new Set();          // espèces qu'on sait reproduire à volonté
  for (const [id, n] of Object.entries(quantites || {})) {
    if (n > 0) possede.add(Number(id));
    if (n > 1) illimite.add(Number(id));
  }
  if (!possede.size) return { vide: true };
  if (possede.has(cibleId)) return { deja: true };

  const via = new Map();               // id produit -> { a, b, gen }
  let frontiere = [...possede];

  for (let gen = 1; gen <= maxGen && frontiere.length; gen++) {
    const dispo = [...possede];
    const nouveaux = [];
    // On ne recroise que les paires impliquant au moins un nouveau venu : les paires
    // entièrement anciennes ont déjà été explorées à la génération précédente.
    for (const idA of dispo) {
      for (const idB of frontiere) {
        if (idA === idB && !illimite.has(idA)) continue;   // il en faut deux
        const enfant = childOf(palsById[idA], palsById[idB]);
        if (!enfant || possede.has(enfant.id)) continue;
        possede.add(enfant.id);
        illimite.add(enfant.id);                          // produit = reproductible
        via.set(enfant.id, { a: idA, b: idB, gen });
        nouveaux.push(enfant.id);
        if (enfant.id === cibleId) {
          return { arbre: construireArbre(cibleId, via), generations: gen };
        }
      }
    }
    frontiere = nouveaux;
  }
  return { introuvable: true, generations: maxGen };
}

// Remonte la chaîne de production jusqu'aux espèces déjà possédées (les feuilles).
function construireArbre(id, via) {
  const source = via.get(id);
  const pal = palsById[id];
  if (!source) return { pal, possede: true };
  return {
    pal, gen: source.gen,
    parents: [construireArbre(source.a, via), construireArbre(source.b, via)],
  };
}

// ===== Vue =====
let mode = "couple";            // "couple" (A × B) · "cible" (parents directs) · "plan"
let cibleId = null;
let selA = null, selB = null;
let boiteSeule = false;

// ===== Arbre construit à la main (mode « cible ») =====
// L'arbre n'est PAS calculé : c'est l'utilisateur qui choisit, à chaque nœud, le couple
// qui l'intéresse. On identifie un nœud par son CHEMIN (suite d'indices 0/1 depuis la
// racine) et non par son espèce : la même espèce peut apparaître à plusieurs endroits,
// et deux branches identiques ne doivent pas se déplier ensemble.
let arbre = null;               // { id, parents: [noeud, noeud] | null }
let focus = null;               // chemin du nœud dont on liste les couples
let filtreParent = "";          // filtre sur le nom d'un des deux parents

// `focus` vaut null quand rien n'est sélectionné : on retombe alors sur la racine.
const noeudA = chemin => (chemin || []).reduce((n, i) => n && n.parents && n.parents[i], arbre);
const memeChemin = (x, y) => x && y && x.length === y.length && x.every((v, i) => v === y[i]);

function reinitArbre(id) { arbre = { id, parents: null }; focus = []; filtreParent = ""; }

const nomsTries = () => [...BREEDERS].sort((a, b) => a.name.localeCompare(b.name, "fr"));

// Vignette et nom ouvrent la fiche détaillée, comme dans la Palpedia. Le nom porte le
// rôle de bouton et l'accès clavier ; la vignette se contente du clic — c'est déjà la
// répartition du catalogue, et deux arrêts de tabulation pour un même Pal
// n'apporteraient rien à un écran qui en compte déjà beaucoup.
function rendreFiche(icone, nom, pal) {
  const ouvrir = () => openPalDetail(pal);
  if (icone) { icone.style.cursor = "pointer"; icone.onclick = ouvrir; }
  if (!nom) return;
  nom.classList.add("bd-fiche");
  nom.tabIndex = 0;
  nom.setAttribute("role", "button");
  nom.setAttribute("aria-label", "Détails de " + pal.name);
  nom.onclick = ouvrir;
  nom.onkeydown = e => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); ouvrir(); }
  };
}

// Carte d'un Pal : vignette, nom, éléments, pouvoir de reproduction. Les TROIS modes
// s'en servent — c'est elle qui donne à la vue son air d'arbre généalogique, et la
// réserver au mode « A × B » laissait les deux autres en simples listes.
// Le contenu de `extra` se range à la suite du pouvoir ; ce qui doit aller à droite
// (bouton, badge) s'ajoute par le sujet appelant, en frère de `.info`.
function garnirCarte(hote, pal, extra = "") {
  const icone = palIconEl(pal);
  hote.appendChild(icone);
  const info = document.createElement("div");
  info.className = "info";
  info.innerHTML = `<div class="name">${pal.name}</div>`
    + `<div class="bd-sub">${elementChipsHtml(pal)}`
    + `<span class="bd-power" title="Breed power (CombiRank) — sert au calcul">⚖ ${pal.breedPower ?? "—"}</span>${extra}</div>`;
  hote.appendChild(info);
  rendreFiche(icone, info.querySelector(".name"), pal);
  return info;
}

function palLigne(pal, extra = "") {
  const li = document.createElement("li");
  li.className = "bd-pal";
  garnirCarte(li, pal, extra);
  return li;
}

function remplirSelect(sel, valeur) {
  sel.innerHTML = "";
  for (const p of nomsTries()) {
    const o = new Option(`${p.name} (${p.breedPower})`, String(p.id));
    sel.appendChild(o);
  }
  if (valeur != null) sel.value = String(valeur);
}

function rendreModeCouple() {
  const host = document.getElementById("bd-result");
  const a = palsById[selA], b = palsById[selB];
  const enfant = childOf(a, b);
  if (!enfant) {
    host.innerHTML = `<p class="bd-msg">Cette paire ne donne aucun résultat connu.</p>`;
    return;
  }
  const combo = (combosByPal.get(a.id) || []).find(c =>
    (c.a === a.id && c.b === b.id) || (c.a === b.id && c.b === a.id));
  host.innerHTML = "";
  const bloc = document.createElement("div");
  bloc.className = "bd-couple";
  const ul = document.createElement("ul");
  ul.className = "bd-parents";
  ul.appendChild(palLigne(a));
  ul.appendChild(palLigne(b));
  bloc.appendChild(ul);
  const fleche = document.createElement("div");
  fleche.className = "bd-arrow";
  fleche.innerHTML = `<span aria-hidden="true">↓</span>`;
  bloc.appendChild(fleche);
  const res = document.createElement("ul");
  res.className = "bd-child";
  res.appendChild(palLigne(enfant));
  bloc.appendChild(res);
  const note = document.createElement("p");
  note.className = "bd-note";
  if (combo) {
    const sexe = combo.ga || combo.gb
      ? ` (uniquement ${combo.a === a.id ? a.name : b.name} ${combo.ga === "F" ? "♀" : "♂"} × ${combo.a === a.id ? b.name : a.name} ${combo.gb === "F" ? "♀" : "♂"})` : "";
    note.innerHTML = `🔒 <b>Combinaison unique</b> : cette paire donne toujours ${enfant.name}${sexe}.`;
  } else if (a.id === b.id) {
    note.textContent = "Deux parents de la même espèce donnent cette espèce.";
  } else {
    const cible = (a.breedPower + b.breedPower + 1) >> 1;
    note.innerHTML = `Moyenne des pouvoirs : (${a.breedPower} + ${b.breedPower} + 1) ÷ 2 = <b>${cible}</b> `
      + `→ espèce la plus proche : ${enfant.name} (${enfant.breedPower}).`;
  }
  bloc.appendChild(note);
  host.appendChild(bloc);
}

// Un nœud de l'arbre manuel. Une feuille porte un « + » pour choisir ses parents ;
// un nœud déplié porte un « × » pour détacher la branche et essayer autre chose.
function noeudArbre(n, chemin, counts) {
  const li = document.createElement("li");
  const pal = palsById[n.id];
  const enBoite = counts[pal.id] || 0;
  li.className = "bd-node" + (enBoite ? " is-owned" : "")
    + (memeChemin(chemin, focus) ? " is-focus" : "");

  const tete = document.createElement("div");
  tete.className = "bd-pal bd-nhead";
  // Le badge se range DANS la ligne d'informations, pas après la carte : ajouté en
  // queue il élargissait le nœud, et des cartes de largeurs différentes désalignent
  // les colonnes de l'arbre. Seul le bouton reste en queue, et il est partout.
  garnirCarte(tete, pal,
    enBoite ? ` <span class="bd-own" title="Dans ta boîte">🎒 ${enBoite}</span>` : "");

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn-step bd-nbtn";
  if (n.parents) {
    btn.textContent = "×";
    btn.setAttribute("aria-label", `Détacher les parents de ${pal.name}`);
    btn.onclick = () => { n.parents = null; focus = chemin; filtreParent = ""; renderBreeding(); };
  } else {
    btn.textContent = "+";
    btn.setAttribute("aria-label", `Choisir les parents de ${pal.name}`);
    btn.setAttribute("aria-pressed", String(memeChemin(chemin, focus)));
    btn.onclick = () => { focus = chemin; filtreParent = ""; renderBreeding(); };
  }
  tete.appendChild(btn);
  li.appendChild(tete);

  if (n.parents) {
    const ul = document.createElement("ul");
    ul.className = "bd-children";
    n.parents.forEach((p, i) => ul.appendChild(noeudArbre(p, [...chemin, i], counts)));
    li.appendChild(ul);
  }
  return li;
}

function rendreModeCible() {
  const host = document.getElementById("bd-result");
  const cible = palsById[cibleId];
  if (!cible) { host.innerHTML = ""; return; }

  // L'arbre suit la cible : changer de cible repart d'une racine neuve.
  if (!arbre || arbre.id !== cibleId) reinitArbre(cibleId);
  const noeudFocus = noeudA(focus) || arbre;
  const palFocus = palsById[noeudFocus.id];

  const toutesPaires = parentsFor(palFocus);
  const total = toutesPaires.length;
  // Filtre sur l'un OU l'autre parent : on cherche « avec qui puis-je faire ce Pal »,
  // et la position du parent dans le couple n'a pas de sens ici.
  const filtrer = () => {
    if (!filtreParent) return toutesPaires.slice();
    const q = filtreParent.toLowerCase();
    return toutesPaires.filter(({ a, b }) =>
      a.name.toLowerCase().includes(q) || b.name.toLowerCase().includes(q));
  };
  const counts = palBoxCounts();
  let filtre = "";
  const filtrerBoite = liste => !boiteSeule ? liste : liste.filter(({ a, b }) => {
    const qa = counts[a.id] || 0, qb = counts[b.id] || 0;
    // Un seul exemplaire ne peut pas être son propre partenaire.
    return a.id === b.id ? qa >= 2 : qa >= 1 && qb >= 1;
  });
  if (boiteSeule) {
    filtre = `<p class="bd-note">🎒 Filtré sur ta boîte. `
      + `<b>Le sexe n'est pas pris en compte</b> : la boîte ne mémorise pas cette information `
      + `(l'import de sauvegarde ne la conserve pas). Vérifie en jeu que tu as bien un mâle et une femelle.</p>`;
  }

  // Deux colonnes : à gauche les couples du nœud sélectionné, à droite l'arbre en
  // cours de construction.
  host.innerHTML = "";
  const split = document.createElement("div");
  split.className = "bd-split";
  const gauche = document.createElement("div");
  gauche.className = "bd-couples";
  const droite = document.createElement("div");
  droite.className = "bd-arbre";
  split.append(gauche, droite);
  host.appendChild(split);

  // --- Colonne gauche : les couples donnant le Pal sélectionné
  gauche.innerHTML = `<div class="bd-head"><b id="bd-pair-count"></b>`
    + (palFocus.id !== cible.id ? `<span class="bd-focus-tag">branche en cours</span>` : "")
    + `</div>${filtre}`;

  const champ = document.createElement("input");
  champ.type = "search";
  champ.id = "bd-pair-filter";
  champ.className = "bd-pair-filter";
  champ.placeholder = "Filtrer par parent…";
  champ.setAttribute("aria-label", `Filtrer les couples donnant ${palFocus.name} par nom de parent`);
  champ.autocomplete = "off";
  champ.value = filtreParent;
  // On ne rejoue PAS tout le rendu : le champ resterait détruit et recréé à chaque
  // touche, et la saisie perdrait le focus. Seule la liste est repeuplée.
  champ.addEventListener("input", e => {
    filtreParent = e.target.value.trim();
    peupler();
  });
  gauche.appendChild(champ);

  // Repeuple le compteur et la liste, sans toucher au champ de filtre.
  function peupler() {
  const paires = filtrerBoite(filtrer());
  gauche.querySelectorAll(".bd-pairs, .bd-msg, .bd-note.bd-trop").forEach(e => e.remove());
  document.getElementById("bd-pair-count").textContent =
    `${paires.length}${filtreParent ? ` sur ${total}` : ""} paire(s) donnant ${palFocus.name}`;
  if (!paires.length) {
    gauche.insertAdjacentHTML("beforeend", boiteSeule
      ? `<p class="bd-msg">Aucune paire réalisable avec ta boîte pour obtenir <b>${palFocus.name}</b>.</p>`
      : filtreParent
        ? `<p class="bd-msg">Aucun couple donnant <b>${palFocus.name}</b> ne fait intervenir `
          + `« ${filtreParent} » (sur ${total} paires).</p>`
        : `<p class="bd-msg"><b>${palFocus.name}</b> ne peut pas être obtenu par reproduction : `
          + `il faut le capturer.</p>`);
  } else {
    // Les combinaisons uniques d'abord, puis par nom.
    paires.sort((x, y) => Number(y.unique) - Number(x.unique)
      || x.a.name.localeCompare(y.a.name, "fr") || x.b.name.localeCompare(y.b.name, "fr"));

    const ul = document.createElement("ul");
    ul.className = "bd-pairs";
    for (const { a, b, unique, ga, gb } of paires.slice(0, 300)) {
      const li = document.createElement("li");
      li.className = "bd-pair" + (unique ? " is-unique" : "");
      const g = s => s === "F" ? " ♀" : s === "M" ? " ♂" : "";
      const dispo = q => boiteSeule ? "" : (counts[q.id] ? ` <span class="bd-own" title="Dans ta boîte">🎒${counts[q.id]}</span>` : "");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "bd-pair-btn";
      btn.setAttribute("aria-label",
        `Ajouter ${a.name} et ${b.name} comme parents de ${palFocus.name}`);
      // Vignettes ici aussi : une liste de 300 noms nus se parcourt mal, alors qu'on
      // reconnaît un Pal à son image bien avant de lire son nom.
      const cote = (p, sexe) => `<span class="bd-pn">${palIconHtml(p)}`
        + `<span class="bd-pn-nom">${p.name}${g(sexe)}${dispo(p)}</span></span>`;
      btn.innerHTML = cote(a, ga)
        + `<span class="bd-x" aria-hidden="true">×</span>`
        + cote(b, gb)
        + (unique ? `<span class="bd-tag">unique</span>` : "");
      // Choisir un couple greffe les deux parents sous le nœud sélectionné.
      btn.onclick = () => {
        const n = noeudA(focus) || arbre;
        n.parents = [{ id: a.id, parents: null }, { id: b.id, parents: null }];
        focus = null;                       // rien de sélectionné : on regarde la racine
        filtreParent = "";
        renderBreeding();
      };
      li.appendChild(btn);
      ul.appendChild(li);
    }
    gauche.appendChild(ul);
    if (paires.length > 300) {
      gauche.insertAdjacentHTML("beforeend",
        `<p class="bd-note bd-trop">Seules les 300 premières paires sont affichées (sur ${paires.length}).</p>`);
    }
  }
  }
  peupler();

  // --- Colonne droite : l'arbre
  const entete = document.createElement("div");
  entete.className = "bd-head bd-arbre-head";
  entete.innerHTML = `<b>Arbre de ${cible.name}</b>`;
  const raz = document.createElement("button");
  raz.type = "button";
  raz.className = "bar-btn";
  raz.textContent = "Effacer l'arbre";
  raz.onclick = () => { reinitArbre(cibleId); renderBreeding(); };
  entete.appendChild(raz);
  droite.appendChild(entete);
  droite.insertAdjacentHTML("beforeend",
    `<p class="bd-note">Clique un couple à gauche pour l'attacher, puis <b>+</b> sur un `
    + `parent pour choisir à son tour ses parents. <b>×</b> détache une branche.</p>`);

  const ul = document.createElement("ul");
  ul.className = "bd-tree";
  ul.appendChild(noeudArbre(arbre, [], counts));
  droite.appendChild(ul);
}

// Un nœud de l'arbre : soit une espèce déjà en boîte (feuille), soit un croisement.
function noeudPlan(n, counts) {
  const li = document.createElement("li");
  li.className = "bd-node" + (n.possede ? " is-owned" : "");
  const tete = document.createElement("div");
  tete.className = "bd-pal bd-nhead";
  const q = counts[n.pal.id] || 0;
  garnirCarte(tete, n.pal, n.possede
    ? ` <span class="bd-own" title="Déjà dans ta boîte">🎒 ${q}</span>`
    : ` <span class="bd-gen">génération ${n.gen}</span>`);
  li.appendChild(tete);
  if (n.parents) {
    const ul = document.createElement("ul");
    ul.className = "bd-children";
    for (const p of n.parents) ul.appendChild(noeudPlan(p, counts));
    li.appendChild(ul);
  }
  return li;
}

function rendreModePlan() {
  const host = document.getElementById("bd-result");
  const cible = palsById[cibleId];
  if (!cible) { host.innerHTML = ""; return; }
  const counts = palBoxCounts();
  const res = planDeReproduction(cible.id, counts);

  if (res.vide) {
    host.innerHTML = `<p class="bd-msg">Ta boîte est vide. Remplis-la depuis l'onglet `
      + `📥 Importer une save, ou à la main dans « Ma boîte ».</p>`;
    return;
  }
  if (res.deja) {
    host.innerHTML = `<p class="bd-msg">Tu possèdes déjà <b>${cible.name}</b> `
      + `(${counts[cible.id]} exemplaire(s)). Aucun élevage nécessaire.</p>`;
    return;
  }
  if (res.introuvable) {
    host.innerHTML = `<p class="bd-msg">Aucun chemin trouvé vers <b>${cible.name}</b> `
      + `en ${res.generations} générations à partir de ta boîte.</p>`
      + `<p class="bd-note">Certaines espèces ne s'obtiennent pas par reproduction : il faut `
      + `alors en capturer une, puis relancer le calcul.</p>`;
    return;
  }

  const feuilles = new Set();
  (function compter(n) {
    if (n.possede) feuilles.add(n.pal.name); else n.parents.forEach(compter);
  })(res.arbre);

  host.innerHTML = `<div class="bd-head"><b>${cible.name}</b> en `
    + `${res.generations} génération${res.generations > 1 ? "s" : ""}, `
    + `à partir de ${feuilles.size} espèce(s) de ta boîte</div>`
    + `<p class="bd-note">🎒 = déjà en boîte. <b>Le sexe n'est pas pris en compte</b> : `
    + `la boîte ne mémorise pas cette information. Vérifie en jeu que chaque couple a `
    + `bien un mâle et une femelle.</p>`;
  const ul = document.createElement("ul");
  ul.className = "bd-tree";
  ul.appendChild(noeudPlan(res.arbre, counts));
  host.appendChild(ul);
}

export function renderBreeding() {
  const host = document.getElementById("bd-result");
  if (!host) return;
  for (const m of ["couple", "cible", "plan"]) {
    document.getElementById("bd-mode-" + m).classList.toggle("active", mode === m);
    document.getElementById("bd-mode-" + m).setAttribute("aria-pressed", String(mode === m));
    document.getElementById("bd-" + m + "-ctrl").hidden = mode !== m;
  }
  if (mode === "cible") rendreModeCible();
  else if (mode === "plan") rendreModePlan();
  else rendreModeCouple();
}

export function initBreeding() {
  const sa = document.getElementById("bd-a"), sb = document.getElementById("bd-b");
  const sc = document.getElementById("bd-cible");
  const sp = document.getElementById("bd-plan");
  if (!sa) return;
  const parDefaut = nomsTries();
  selA = parDefaut[0]?.id; selB = parDefaut[1]?.id; cibleId = parDefaut[0]?.id;
  remplirSelect(sa, selA); remplirSelect(sb, selB); remplirSelect(sc, cibleId);
  // Le mode « plan » vise le même Pal que le mode « cible » : passer de l'un à l'autre
  // garde la recherche en cours.
  remplirSelect(sp, cibleId);

  sa.addEventListener("change", () => { selA = Number(sa.value); renderBreeding(); });
  sb.addEventListener("change", () => { selB = Number(sb.value); renderBreeding(); });
  sc.addEventListener("change", () => { cibleId = Number(sc.value); sp.value = sc.value; renderBreeding(); });
  sp.addEventListener("change", () => { cibleId = Number(sp.value); sc.value = sp.value; renderBreeding(); });
  document.getElementById("bd-swap").addEventListener("click", () => {
    [selA, selB] = [selB, selA]; sa.value = String(selA); sb.value = String(selB); renderBreeding();
  });
  for (const m of ["couple", "cible", "plan"])
    document.getElementById("bd-mode-" + m).addEventListener("click", () => { mode = m; renderBreeding(); });
  document.getElementById("bd-box-only").addEventListener("change", e => {
    boiteSeule = e.target.checked; renderBreeding();
  });

  // Recherche : filtre les options d'un <select> sans dépendance externe.
  const brancherRecherche = (inputId, sel, onPick) => {
    document.getElementById(inputId).addEventListener("input", e => {
      const q = e.target.value.trim().toLowerCase();
      const gardes = nomsTries().filter(p => !q || p.name.toLowerCase().includes(q));
      sel.innerHTML = "";
      for (const p of gardes) sel.appendChild(new Option(`${p.name} (${p.breedPower})`, String(p.id)));
      if (gardes.length) { sel.value = String(gardes[0].id); onPick(gardes[0].id); renderBreeding(); }
    });
  };
  brancherRecherche("bd-a-search", sa, id => { selA = id; });
  brancherRecherche("bd-b-search", sb, id => { selB = id; });
  brancherRecherche("bd-cible-search", sc, id => { cibleId = id; });
  brancherRecherche("bd-plan-search", sp, id => { cibleId = id; });
}
