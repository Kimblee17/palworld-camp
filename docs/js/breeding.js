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

// ===== Mutation =====
//
// Un œuf peut éclore en un Pal tout autre que celui de la formule normale. La règle
// n'est publiée nulle part : elle a été RETROUVÉE en interrogeant le calculateur de
// paldb.cc sur 63 couples, puis validée hors ligne contre ces 63 relevés — les 63 jeux
// de candidats sont exacts et les pourcentages tombent juste à l'arrondi d'affichage
// près (un seul écart de 0,1 point, dû à l'arrondi de la source).
//
//   m = rang le plus BAS des deux parents (donc le Pal le plus fort), M = le plus haut
//   fenêtre de rangs = ] (4M + m) / 10 , (4M + 2m) / 10 ]
//   tirage UNIFORME d'un rang entier dans cette fenêtre, puis espèce la plus proche
//
// Deux conséquences qu'on ne devinerait pas :
//   - la largeur de la fenêtre vaut m/10 : deux parents proches ouvrent un large
//     éventail, deux parents très éloignés n'en laissent souvent qu'un seul ;
//   - la population n'est PAS celle de la reproduction normale. Les variantes (Noct,
//     Cryst, Ignis…), réservées aux combinaisons uniques, sont ici accessibles. Seules
//     les espèces `breedNoResult` restent exclues.
//
// L'arithmétique est ENTIÈRE : les rangs sont des multiples de 10, et 0,1 × 260 vaut
// 26.000000000000004 en virgule flottante — un `floor` mal placé décalerait la fenêtre.
const MUTABLES = PALS.filter(p => p.breedPower && !p.breedIsBoss && !p.breedNoResult);

let _procheMut = null;
function procheMut() {
  if (_procheMut) return _procheMut;
  const max = Math.max(...MUTABLES.map(p => p.breedPower)) + 1;
  _procheMut = new Array(max + 1);
  for (let t = 0; t <= max; t++) {
    let best = null, bd = Infinity;
    for (const p of MUTABLES) {
      const d = Math.abs(p.breedPower - t);
      if (d < bd || (d === bd && p.breedPriority > best.breedPriority)) { bd = d; best = p; }
    }
    _procheMut[t] = best;
  }
  return _procheMut;
}

/** Enfants possibles par mutation, avec leur probabilité. Décroissant. */
export function mutationsDe(a, b) {
  if (!a || !b || !a.breedPower || !b.breedPower) return [];
  const m = Math.min(a.breedPower, b.breedPower), M = Math.max(a.breedPower, b.breedPower);
  const lo = Math.floor((4 * M + m) / 10) + 1;
  const hi = Math.floor((4 * M + 2 * m) / 10);
  if (hi < lo) return [];
  const T = procheMut();
  const compte = new Map();
  for (let t = lo; t <= hi; t++) {
    const p = T[Math.min(t, T.length - 1)];
    if (p) compte.set(p, (compte.get(p) || 0) + 1);
  }
  const total = hi - lo + 1;
  return [...compte.entries()]
    .map(([pal, n]) => ({ pal, pct: n * 100 / total }))
    .sort((x, y) => y.pct - x.pct || x.pal.name.localeCompare(y.pal.name, "fr"));
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

// ===== Chemin d'une espèce vers une autre =====
//
// « Je veux A, en partant de B. » Ce n'est PAS le plan d'élevage : celui-là part de
// tout ce qu'on possède et cherche le plus court chemin depuis n'importe quoi. Ici une
// espèce est imposée comme ancêtre, et on cherche la lignée qui y mène.
//
// Le parcours est en largeur sur les espèces atteignables depuis B en croisant, à
// chaque génération, l'individu courant avec un partenaire quelconque. La largeur
// d'abord garantit le plus petit nombre de générations ; à nombre égal, on essaie les
// partenaires DÉJÀ EN BOÎTE en premier, pour que le chemin proposé soit jouable tout
// de suite plutôt qu'élégant sur le papier.
//
// Le résultat est une CHAÎNE — B × P1 → C1, C1 × P2 → C2, … → A — donc un arbre dont
// l'épine dorsale descend jusqu'à B. C'est exactement ce que fait un joueur avec une
// seule lignée, et c'est modifiable nœud par nœud comme n'importe quel arbre construit
// à la main.
export function cheminDepuis(sourceId, cibleId, quantites = {}, maxGen = MAX_GENERATIONS) {
  if (sourceId === cibleId) return { memeEspece: true };
  const source = palsById[sourceId], cible = palsById[cibleId];
  if (!source || !cible || !source.breedPower || !cible.breedPower) return { impossible: true };
  // Certaines espèces ne naissent que de deux individus de leur propre espèce : aucune
  // lignée ne peut y mener depuis une autre. C'est une règle, pas une limite de
  // profondeur, et le dire évite de laisser croire qu'une recherche plus longue
  // finirait par aboutir.
  //
  // ⚠ On le DÉDUIT des couples réellement possibles, on ne le lit pas dans un drapeau.
  // `breedNoResult` combiné à « enfant d'une combinaison unique » donnait un verdict
  // faux pour Jetragon ; interroger parentsFor, qui est la fonction dont dépend déjà
  // tout l'écran, ne peut pas diverger de ce que l'utilisateur voit.
  const couples = parentsFor(cible);
  if (!couples.length) return { impossible: true };
  if (couples.every(c => c.a.id === cibleId && c.b.id === cibleId))
    return { seulementSoiMeme: true };

  // Partenaires possibles, ceux de la boîte d'abord (cf. commentaire ci-dessus).
  //
  // ⚠ LA CIBLE EST ÉCARTÉE DES PARTENAIRES. Sans cela le parcours proposait des
  // lignées qui consomment un Anubis pour finir par produire un Anubis : le croisement
  // est exact, le conseil est circulaire. Qui possède déjà l'espèce visée n'a pas
  // besoin d'un plan pour l'obtenir.
  const enBoite = new Set(Object.entries(quantites || {})
    .filter(([, n]) => n > 0).map(([id]) => Number(id)));
  const partenaires = BREEDERS.filter(p => p.id !== cibleId).sort((a, b) =>
    (enBoite.has(b.id) ? 1 : 0) - (enBoite.has(a.id) ? 1 : 0));

  const via = new Map();               // espèce atteinte -> { depuis, partenaire }
  let frontiere = [sourceId];
  const vus = new Set([sourceId]);

  for (let gen = 1; gen <= maxGen && frontiere.length; gen++) {
    const suivants = [];
    for (const courant of frontiere) {
      for (const p of partenaires) {
        const enfant = childOf(palsById[courant], p);
        if (!enfant || vus.has(enfant.id)) continue;
        vus.add(enfant.id);
        via.set(enfant.id, { depuis: courant, partenaire: p.id });
        if (enfant.id === cibleId) {
          // On remonte la chaîne et on la retourne : l'arbre se lit de la cible
          // vers la source, chaque nœud ayant pour parents l'étape précédente et
          // le partenaire de ce croisement.
          const etapes = [];
          for (let id = cibleId; via.has(id); id = via.get(id).depuis) {
            const v = via.get(id);
            etapes.unshift({ enfant: id, depuis: v.depuis, partenaire: v.partenaire });
          }
          return { etapes, generations: gen };
        }
        suivants.push(enfant.id);
      }
    }
    frontiere = suivants;
  }
  return { introuvable: true, generations: maxGen };
}

/** La chaîne d'étapes en arbre pour le constructeur : la cible en racine. */
function arbreDepuisChemin(etapes) {
  let noeud = null;
  for (const e of etapes) {
    const gauche = noeud || { id: e.depuis, parents: null };
    noeud = { id: e.enfant, parents: [gauche, { id: e.partenaire, parents: null }] };
  }
  return noeud;
}

// ===== Vue =====
let mode = "couple";            // "couple" (A × B) · "cible" (parents directs) · "plan"
let cibleId = null;
let sourceId = null;            // contrainte « à partir de », null = aucune
let selA = null, selB = null;
let boiteSeule = false;
let montrerMutations = false;   // bascule du mode « A × B »

// ===== Arbre construit à la main (mode « cible ») =====
// L'arbre n'est PAS calculé : c'est l'utilisateur qui choisit, à chaque nœud, le couple
// qui l'intéresse. On identifie un nœud par son CHEMIN (suite d'indices 0/1 depuis la
// racine) et non par son espèce : la même espèce peut apparaître à plusieurs endroits,
// et deux branches identiques ne doivent pas se déplier ensemble.
let arbre = null;               // { id, parents: [noeud, noeud] | null }
let focus = null;               // chemin du nœud dont on liste les couples
let filtreParent = "";          // filtre sur le nom d'un des deux parents
// Couple (cible, source) dont l'arbre affiché est issu. Sert à ne PAS reconstruire
// l'arbre à chaque rendu : greffer un couple redessine tout, et repartir du chemin
// suggéré effacerait le travail de l'utilisateur à chaque clic.
let arbreCle = null;
let cheminInfo = null;          // résultat de cheminDepuis, pour le bandeau

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

// ===== Zoom de l'arbre =====
// Une mise à l'échelle CSS, rien de plus : les traits de liaison sont des bordures,
// ils suivent la transformation sans qu'on redessine quoi que ce soit.
//
// ⚠ `transform` ne change pas la mise en page : le conteneur qui défile continuerait
// de croire l'arbre à sa taille d'origine — bandeau vide en dézoom, contenu coupé en
// zoom. On redonne donc au calque intérieur la taille naturelle multipliée par le
// facteur. (`zoom` en CSS ferait ça tout seul, mais son support reste trop récent.)
const ZOOM_MIN = 0.4, ZOOM_MAX = 1.6, ZOOM_PAS = 0.15;
let zoom = 1;          // conservé d'un rendu à l'autre : greffer un couple redessine tout
// Tant que personne n'a touché aux commandes, un arbre trop large s'ajuste tout seul :
// l'ouvrir coupé serait un mauvais accueil. Dès le premier réglage manuel, on ne
// décide plus rien à la place de l'utilisateur, même quand l'arbre grandit.
let zoomManuel = false;

function installerZoom(cadre, arbre) {
  const inner = arbre.parentElement;
  const nat = { l: arbre.offsetWidth, h: arbre.offsetHeight };
  const appliquer = () => {
    arbre.style.transform = `scale(${zoom})`;
    inner.style.width = nat.l * zoom + "px";
    inner.style.height = nat.h * zoom + "px";
    cadre.querySelector(".bd-zoom-val").textContent = Math.round(zoom * 100) + " %";
  };
  const regler = z => { zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)); appliquer(); };
  const reglerMain = z => { zoomManuel = true; regler(z); };
  const ajuster = () => Math.min(1, (cadre.clientWidth - 24) / (nat.l || 1));

  cadre.querySelector(".bd-zoom-plus").onclick = () => reglerMain(zoom + ZOOM_PAS);
  cadre.querySelector(".bd-zoom-moins").onclick = () => reglerMain(zoom - ZOOM_PAS);
  // « Ajuster » ne grossit jamais au-delà de 100 % : un petit arbre étiré au format du
  // cadre serait grotesque, et l'utilisateur demande à voir l'ensemble, pas à remplir.
  cadre.querySelector(".bd-zoom-fit").onclick = () => {
    reglerMain(ajuster());
    cadre.scrollLeft = (cadre.scrollWidth - cadre.clientWidth) / 2;
  };

  // Ctrl + molette, comme partout ailleurs. La molette seule reste au défilement de
  // la page : la détourner piège l'utilisateur qui traverse la section.
  cadre.addEventListener("wheel", e => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    reglerMain(zoom - Math.sign(e.deltaY) * ZOOM_PAS);
  }, { passive: false });

  // Glisser pour déplacer : sur un arbre large, viser la barre de défilement est
  // pénible. On ignore les clics sur un bouton ou un nom, qui ont déjà une action.
  let tire = null;
  cadre.addEventListener("pointerdown", e => {
    if (e.button !== 0 || e.target.closest("button, [role=button], a")) return;
    tire = { x: e.clientX, y: e.clientY, gx: cadre.scrollLeft, gy: cadre.scrollTop };
    cadre.classList.add("is-tire");
  });
  const fin = () => { tire = null; cadre.classList.remove("is-tire"); };
  cadre.addEventListener("pointermove", e => {
    if (!tire) return;
    cadre.scrollLeft = tire.gx - (e.clientX - tire.x);
    cadre.scrollTop = tire.gy - (e.clientY - tire.y);
  });
  cadre.addEventListener("pointerup", fin);
  cadre.addEventListener("pointerleave", fin);

  if (!zoomManuel && nat.l > cadre.clientWidth) regler(ajuster());
  else appliquer();
}

// Enveloppe l'arbre dans un cadre défilant muni de ses commandes de zoom.
function cadreZoom(arbre) {
  const cadre = document.createElement("div");
  cadre.className = "bd-zoom";
  const inner = document.createElement("div");
  inner.className = "bd-zoom-inner";
  inner.appendChild(arbre);
  cadre.appendChild(inner);
  cadre.insertAdjacentHTML("beforeend", `
    <div class="bd-zoom-ctl">
      <button type="button" class="bd-zoom-plus" aria-label="Zoom avant sur l'arbre">+</button>
      <button type="button" class="bd-zoom-moins" aria-label="Zoom arrière sur l'arbre">−</button>
      <button type="button" class="bd-zoom-fit" aria-label="Ajuster l'arbre au cadre">⤢</button>
      <span class="bd-zoom-val" aria-live="polite"></span>
    </div>`);
  return cadre;
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

  if (montrerMutations) host.appendChild(blocMutations(a, b));
}

// Les enfants de mutation, sous le résultat normal. Le pourcentage n'est affiché que
// s'il y a plusieurs issues : « 100 % » sur une liste d'un seul élément n'apprend rien.
function blocMutations(a, b) {
  const liste = mutationsDe(a, b);
  const bloc = document.createElement("section");
  bloc.className = "bd-mut";
  if (!liste.length) {
    bloc.innerHTML = `<h3 class="bd-mut-titre">🧬 Mutation</h3>`
      + `<p class="bd-note">Aucune mutation possible pour ce couple.</p>`;
    return bloc;
  }
  const plusieurs = liste.length > 1;
  bloc.innerHTML = `<h3 class="bd-mut-titre">🧬 Mutation — ${liste.length} enfant`
    + `${plusieurs ? "s possibles" : " possible"}</h3>`;
  const ul = document.createElement("ul");
  ul.className = "bd-parents bd-mut-liste";
  for (const { pal, pct } of liste) {
    ul.appendChild(palLigne(pal, plusieurs
      ? ` <span class="bd-pct">${pct.toFixed(1).replace(".0", "")} %</span>` : ""));
  }
  bloc.appendChild(ul);
  // ⚠ La probabilité affichée est celle du CHOIX DE L'ESPÈCE une fois la mutation
  // survenue, pas la chance de muter. Confondre les deux ferait espérer un Pal rare à
  // chaque œuf ; on le dit plutôt que de laisser le pourcentage parler seul.
  bloc.insertAdjacentHTML("beforeend",
    `<p class="bd-note">Répartition <b>entre les mutations</b>, pas la probabilité qu'une `
    + `mutation survienne — celle-ci reste rare et le jeu ne la publie pas. `
    + `Règle retrouvée depuis <a href="https://paldb.cc/en/Breed" target="_blank" rel="noopener">paldb.cc</a> `
    + `et vérifiée sur 63 couples.</p>`);
  return bloc;
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

// Ce que la contrainte de départ a donné. Un chemin suggéré n'est PAS un plan validé :
// on le dit, parce que l'arbre a exactement l'air de ceux que l'utilisateur construit
// lui-même et que rien d'autre ne signalerait qu'une machine l'a rempli.
function messageChemin(cible) {
  if (!sourceId || !cheminInfo) return "";
  const source = palsById[sourceId];
  if (cheminInfo.memeEspece)
    return `<p class="bd-msg bd-chemin">${cible.name} <b>est</b> l'espèce de départ : `
      + `deux individus suffisent, aucun croisement intermédiaire.</p>`;
  if (cheminInfo.impossible)
    return `<p class="bd-msg bd-chemin is-non">${source.name} ou ${cible.name} ne se reproduit pas.</p>`;
  if (cheminInfo.seulementSoiMeme)
    return `<p class="bd-msg bd-chemin is-non"><b>${cible.name}</b> ne naît que de deux `
      + `${cible.name}. Aucune lignée ne peut y mener depuis une autre espèce — ce n'est `
      + `pas une limite du calcul, c'est la règle du jeu. Il faut en capturer un.</p>`;
  if (cheminInfo.introuvable)
    return `<p class="bd-msg bd-chemin is-non">Aucune lignée trouvée de <b>${source.name}</b> `
      + `vers <b>${cible.name}</b> en ${cheminInfo.generations} générations. `
      + `L'arbre repart à vide : construis-le à la main, ou change d'espèce de départ.</p>`;
  const g = cheminInfo.generations;
  return `<p class="bd-msg bd-chemin is-oui">Lignée proposée depuis <b>${source.name}</b> : `
    + `<b>${g} génération${g > 1 ? "s" : ""}</b>${g === 1 ? " — un croisement direct suffit" : ""}. `
    + `Les partenaires de ta boîte sont privilégiés à nombre de générations égal. `
    + `Chaque nœud reste modifiable.</p>`;
}

function rendreModeCible() {
  const host = document.getElementById("bd-result");
  const cible = palsById[cibleId];
  if (!cible) { host.innerHTML = ""; return; }

  // L'arbre suit la cible ET la contrainte de départ. Tant que ce couple ne change
  // pas, on garde l'arbre tel que l'utilisateur l'a modifié.
  const counts = palBoxCounts();
  const cle = cibleId + "|" + (sourceId ?? "");
  if (!arbre || arbre.id !== cibleId || arbreCle !== cle) {
    cheminInfo = sourceId ? cheminDepuis(sourceId, cibleId, counts) : null;
    if (cheminInfo && cheminInfo.etapes) {
      arbre = arbreDepuisChemin(cheminInfo.etapes);
      focus = []; filtreParent = "";
    } else {
      reinitArbre(cibleId);
    }
    arbreCle = cle;
  }
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
  raz.onclick = () => { reinitArbre(cibleId); arbreCle = null; renderBreeding(); };
  entete.appendChild(raz);
  droite.appendChild(entete);
  droite.insertAdjacentHTML("beforeend", messageChemin(cible)
    + `<p class="bd-note">Clique un couple à gauche pour l'attacher, puis <b>+</b> sur un `
    + `parent pour choisir à son tour ses parents. <b>×</b> détache une branche.</p>`);

  const ul = document.createElement("ul");
  ul.className = "bd-tree";
  ul.appendChild(noeudArbre(arbre, [], counts));
  const cadre = cadreZoom(ul);
  droite.appendChild(cadre);
  installerZoom(cadre, ul);
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
  const cadre = cadreZoom(ul);
  host.appendChild(cadre);
  installerZoom(cadre, ul);
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

  // --- Contrainte « à partir de ». Vide au départ : la vue garde son comportement
  // d'origine tant qu'on ne l'utilise pas.
  const sd = document.getElementById("bd-depuis");
  const effacer = document.getElementById("bd-depuis-clear");
  remplirSelect(sd);
  sd.insertBefore(new Option("— aucune contrainte —", ""), sd.firstChild);
  sd.value = "";
  const majDepuis = () => {
    sourceId = sd.value ? Number(sd.value) : null;
    effacer.hidden = !sourceId;
    renderBreeding();
  };
  sd.addEventListener("change", majDepuis);
  effacer.addEventListener("click", () => {
    sd.value = ""; document.getElementById("bd-depuis-search").value = "";
    remplirSelect(sd); sd.insertBefore(new Option("— aucune contrainte —", ""), sd.firstChild);
    sd.value = ""; majDepuis();
  });
  document.getElementById("bd-depuis-search").addEventListener("input", e => {
    const q = e.target.value.trim().toLowerCase();
    const gardes = nomsTries().filter(p => !q || p.name.toLowerCase().includes(q));
    sd.innerHTML = "";
    sd.appendChild(new Option("— aucune contrainte —", ""));
    for (const p of gardes) sd.appendChild(new Option(`${p.name} (${p.breedPower})`, String(p.id)));
    // Une recherche vidée relâche la contrainte plutôt que d'en imposer une au hasard.
    sd.value = q && gardes.length ? String(gardes[0].id) : "";
    majDepuis();
  });
  sp.addEventListener("change", () => { cibleId = Number(sp.value); sc.value = sp.value; renderBreeding(); });
  document.getElementById("bd-swap").addEventListener("click", () => {
    [selA, selB] = [selB, selA]; sa.value = String(selA); sb.value = String(selB); renderBreeding();
  });
  for (const m of ["couple", "cible", "plan"])
    document.getElementById("bd-mode-" + m).addEventListener("click", () => { mode = m; renderBreeding(); });
  document.getElementById("bd-box-only").addEventListener("change", e => {
    boiteSeule = e.target.checked; renderBreeding();
  });
  // Bouton à bascule, comme les trois boutons de mode juste au-dessus : même registre
  // visuel, `aria-pressed` pour l'état, et rien à cocher.
  const bmut = document.getElementById("bd-mutation");
  bmut.addEventListener("click", () => {
    montrerMutations = !montrerMutations;
    bmut.classList.toggle("active", montrerMutations);
    bmut.setAttribute("aria-pressed", String(montrerMutations));
    renderBreeding();
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
