import { palIconEl, elementChipsHtml } from "./render.js";
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

// Parents possibles : il faut un breed power ; une espèce sans résultat générique reste
// utilisable comme parent si elle apparaît dans au moins une combinaison unique.
export const BREEDERS = PALS.filter(p =>
  p.breedPower && !p.breedIsBoss &&
  !(p.breedNoResult && !(combosByPal.get(p.id) || []).length));
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
  if (!uniqueChildIds.has(target.id) && !target.breedNoResult && target.breedPower) {
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

// ===== Vue =====
let modeCible = false;          // false = A × B, true = cible
let cibleId = null;
let selA = null, selB = null;
let boiteSeule = false;

const nomsTries = () => [...BREEDERS].sort((a, b) => a.name.localeCompare(b.name, "fr"));

function palLigne(pal, extra = "") {
  const li = document.createElement("li");
  li.className = "bd-pal";
  li.appendChild(palIconEl(pal));
  const info = document.createElement("div");
  info.className = "info";
  info.innerHTML = `<div class="name">${pal.name}</div>`
    + `<div class="bd-sub">${elementChipsHtml(pal)}`
    + `<span class="bd-power" title="Breed power (CombiRank) — sert au calcul">⚖ ${pal.breedPower ?? "—"}</span>${extra}</div>`;
  li.appendChild(info);
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

function rendreModeCible() {
  const host = document.getElementById("bd-result");
  const cible = palsById[cibleId];
  if (!cible) { host.innerHTML = ""; return; }

  let paires = parentsFor(cible);
  const counts = palBoxCounts();
  let filtre = "";
  if (boiteSeule) {
    paires = paires.filter(({ a, b }) => {
      const qa = counts[a.id] || 0, qb = counts[b.id] || 0;
      // Un seul exemplaire ne peut pas être son propre partenaire.
      return a.id === b.id ? qa >= 2 : qa >= 1 && qb >= 1;
    });
    filtre = `<p class="bd-note">🎒 Filtré sur ta boîte. `
      + `<b>Le sexe n'est pas pris en compte</b> : la boîte ne mémorise pas cette information `
      + `(l'import de sauvegarde ne la conserve pas). Vérifie en jeu que tu as bien un mâle et une femelle.</p>`;
  }

  if (!paires.length) {
    host.innerHTML = (boiteSeule
      ? `<p class="bd-msg">Aucune paire réalisable avec les Pals de ta boîte pour obtenir <b>${cible.name}</b>.</p>`
      : `<p class="bd-msg"><b>${cible.name}</b> ne peut pas être obtenu par reproduction.</p>`) + filtre;
    return;
  }

  // Les combinaisons uniques d'abord, puis par nom.
  paires.sort((x, y) => Number(y.unique) - Number(x.unique)
    || x.a.name.localeCompare(y.a.name, "fr") || x.b.name.localeCompare(y.b.name, "fr"));

  host.innerHTML = `<div class="bd-head"><b>${paires.length} paire(s) donnant ${cible.name}</b></div>${filtre}`;
  const ul = document.createElement("ul");
  ul.className = "bd-pairs";
  for (const { a, b, unique, ga, gb } of paires.slice(0, 300)) {
    const li = document.createElement("li");
    li.className = "bd-pair" + (unique ? " is-unique" : "");
    const g = s => s === "F" ? " ♀" : s === "M" ? " ♂" : "";
    const dispo = q => boiteSeule ? "" : (counts[q.id] ? ` <span class="bd-own" title="Dans ta boîte">🎒${counts[q.id]}</span>` : "");
    li.innerHTML = `<span class="bd-pn">${a.name}${g(ga)}${dispo(a)}</span>`
      + `<span class="bd-x" aria-hidden="true">×</span>`
      + `<span class="bd-pn">${b.name}${g(gb)}${dispo(b)}</span>`
      + (unique ? `<span class="bd-tag">unique</span>` : "");
    ul.appendChild(li);
  }
  host.appendChild(ul);
  if (paires.length > 300) {
    const p = document.createElement("p");
    p.className = "bd-note";
    p.textContent = `Seules les 300 premières paires sont affichées (sur ${paires.length}).`;
    host.appendChild(p);
  }
}

export function renderBreeding() {
  const host = document.getElementById("bd-result");
  if (!host) return;
  document.getElementById("bd-mode-couple").classList.toggle("active", !modeCible);
  document.getElementById("bd-mode-cible").classList.toggle("active", modeCible);
  document.getElementById("bd-couple-ctrl").hidden = modeCible;
  document.getElementById("bd-cible-ctrl").hidden = !modeCible;
  if (modeCible) rendreModeCible(); else rendreModeCouple();
}

export function initBreeding() {
  const sa = document.getElementById("bd-a"), sb = document.getElementById("bd-b");
  const sc = document.getElementById("bd-cible");
  if (!sa) return;
  const parDefaut = nomsTries();
  selA = parDefaut[0]?.id; selB = parDefaut[1]?.id; cibleId = parDefaut[0]?.id;
  remplirSelect(sa, selA); remplirSelect(sb, selB); remplirSelect(sc, cibleId);

  sa.addEventListener("change", () => { selA = Number(sa.value); renderBreeding(); });
  sb.addEventListener("change", () => { selB = Number(sb.value); renderBreeding(); });
  sc.addEventListener("change", () => { cibleId = Number(sc.value); renderBreeding(); });
  document.getElementById("bd-swap").addEventListener("click", () => {
    [selA, selB] = [selB, selA]; sa.value = String(selA); sb.value = String(selB); renderBreeding();
  });
  document.getElementById("bd-mode-couple").addEventListener("click", () => { modeCible = false; renderBreeding(); });
  document.getElementById("bd-mode-cible").addEventListener("click", () => { modeCible = true; renderBreeding(); });
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
}
