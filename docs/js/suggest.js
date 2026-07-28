import { levelClass, renderAll } from "./render.js";
import {
  active, cycleWorkPref, palPref, pushUndo, readOnly, saveStore, store, workPref,
} from "./state.js";
import { WORK_TYPES, palsById, structById, workById } from "./dataset.js";

// ===== Bonus de condensation =====
// RÈGLE RETENUE (Palworld 1.0) : chaque rang de condensation ajoute +1 au niveau
// d'aptitude au travail, et le total est plafonné à 10 (le maximum « naturel » d'une
// espèce est 8 ; on dépasse via condensation, livres d'aptitude, etc.).
// Sources :
//   https://palworldgame.wiki/guides/condensation-guide/   (« +1 Work Suitability par rang »)
//   https://nodecraft.com/support/games/palworld/general/palworld-work-suitability-level-10-explained
// Ajuste cette constante si le jeu change de barème : elle est le seul point à toucher.
export const CONDENSE_WORK_BONUS = 1;
export const WORK_LEVEL_CAP = 10;
// À noter : la sauvegarde ne stocke PAS les niveaux d'aptitude effectifs d'un Pal
// (livres d'aptitude compris) — seulement son rang de condensation. Ce bonus reste donc
// un calcul, pas une lecture. En revanche les aptitudes DÉSACTIVÉES en jeu, elles, sont
// dans la save et sont respectées (cf. workOff plus bas).

// ===== Passifs affectant la vitesse de travail =====
// Clés = identifiants internes tels que stockés par l'import de save (PassiveSkillList) ;
// ceux-ci ont été relevés directement dans un Level.sav réel. On accepte aussi les noms
// affichés (anglais/français) pour les boîtes remplies autrement qu'avec une save.
// Valeurs = multiplicateur de vitesse de travail (1 = neutre).
// Source des pourcentages : https://palworld.gg/passive-skills et
// https://gamerant.com/palworld-best-passive-skills-work/
// ⚠ La correspondance up1/up2/up3 -> Sérieux/Artisan/Artisanat remarquable est ma lecture
// la plus probable ; corrige ici si tu constates l'inverse en jeu.
export const PASSIVE_WORK_MODIFIERS = {
  CraftSpeed_up3: 1.75,          // Artisanat remarquable  (+75 %)
  CraftSpeed_up2: 1.50,          // Artisan                (+50 %)
  CraftSpeed_up1: 1.20,          // Sérieux                (+20 %)
  PAL_CorporateSlave: 1.30,      // Bourreau de travail    (+30 %, attaque −30 %)
  CraftSpeed_down1: 0.90,        // Maladroit              (−10 %)
  CraftSpeed_down2: 0.70,        // Fainéant               (−30 %)
  // Alias par nom affiché (import CoWork, saisie manuelle…)
  artisan: 1.50, serious: 1.20, serieux: 1.20, workslave: 1.30,
  remarkablecraftsmanship: 1.75, lucky: 1.15, chanceux: 1.15,
};
// Libellés lisibles pour l'affichage du résultat.
const PASSIVE_LABELS = {
  CraftSpeed_up3: "Artisanat remarquable", CraftSpeed_up2: "Artisan",
  CraftSpeed_up1: "Sérieux", PAL_CorporateSlave: "Bourreau de travail",
  CraftSpeed_down1: "Maladroit", CraftSpeed_down2: "Fainéant",
};

const normPassive = s => String(s || "").toLowerCase().replace(/^pal_/, "").replace(/[^a-z0-9]/g, "");
function passiveFactor(code) {
  if (Object.prototype.hasOwnProperty.call(PASSIVE_WORK_MODIFIERS, code)) return PASSIVE_WORK_MODIFIERS[code];
  const n = normPassive(code);
  for (const [k, v] of Object.entries(PASSIVE_WORK_MODIFIERS)) if (normPassive(k) === n) return v;
  return 1;
}
// Multiplicateur global d'un individu : produit des passifs qui touchent la vitesse.
function speedMultiplier(passives) {
  return (passives || []).reduce((m, code) => m * passiveFactor(code), 1);
}
function workPassives(passives) {
  return (passives || []).filter(c => passiveFactor(c) !== 1)
    .map(c => ({ code: c, label: PASSIVE_LABELS[c] || c, factor: passiveFactor(c) }));
}

// ===== Individus de la boîte =====
// Un Pal ajouté à la main (manual) n'a ni étoile ni passif : son niveau effectif est
// exactement son niveau d'espèce et son multiplicateur vaut 1. Le comportement est donc
// inchangé pour qui n'a jamais importé de sauvegarde.
function boxInstances() {
  return Object.entries(store.palBox).map(([key, e]) => {
    const pal = e && palsById[e.palId];
    if (!pal) return null;
    return {
      key, pal, palId: String(e.palId),
      stars: Number.isFinite(e.stars) ? e.stars : 0,
      level: Number.isFinite(e.level) ? e.level : null,
      passives: e.passives || [],
      // aptitudes décochées dans la fiche du Pal en jeu (import de save)
      workOff: Array.isArray(e.workOff) ? e.workOff : [],
      speed: speedMultiplier(e.passives),
    };
  }).filter(Boolean);
}

// Niveau d'aptitude effectif = aptitude de l'espèce + bonus de condensation.
// Une aptitude désactivée en jeu vaut 0 : le Pal refuserait ce travail dans la base,
// le suggesteur ne doit donc pas compter dessus pour couvrir une machine.
export function effWork(inst, wid) {
  const base = inst.pal.work[wid] || 0;
  if (base <= 0) return 0;                       // la condensation n'ouvre pas une aptitude absente
  if (inst.workOff.includes(wid)) return 0;
  return Math.min(WORK_LEVEL_CAP, base + inst.stars * CONDENSE_WORK_BONUS);
}

// ===== Suggestion de compo (glouton), par INDIVIDU =====
// Choisit ≤ limite individus de la boîte pour couvrir au mieux les compétences requises
// par les machines du camp (priorité couverture, puis niveaux, puis débit).
function computeSuggestion() {
  const camp = active();
  const structMembers = Object.entries(camp.structures)
    .map(([id, q]) => [structById[id], q]).filter(([s]) => s);

  const demand = {};
  WORK_TYPES.forEach(w => demand[w.id] = 0);
  structMembers.forEach(([s, q]) => s.requires.forEach(wid => demand[wid] += q));
  const required = WORK_TYPES.map(w => w.id).filter(wid => demand[wid] > 0);
  if (required.length === 0) return { error: "no-structures" };

  const all = boxInstances();
  if (!all.length) return { error: "empty-box" };

  // Contraintes utilisateur : les exclus ne sont jamais candidats.
  const pool = all.filter(i => palPref(i.palId) !== "exclude");
  const pinnedIds = [...new Set(all.filter(i => palPref(i.palId) === "pin").map(i => i.palId))];

  // Les compétences ignorées ne pèsent pas dans le score ; les prioritaires comptent double.
  const weight = wid => workPref(wid) === "ignore" ? 0 : (workPref(wid) === "priority" ? 2 : 1);
  const scored = required.filter(wid => weight(wid) > 0);

  const limit = camp.limit;
  const best = {}, cnt = {};
  required.forEach(c => { best[c] = 0; cnt[c] = 0; });
  const taken = new Set();
  const chosenInst = [];
  const teamSize = () => chosenInst.length;
  const reqCount = i => scored.reduce((n, c) => n + (effWork(i, c) > 0 ? 1 : 0), 0);

  function addToTeam(inst) {
    taken.add(inst.key);
    chosenInst.push(inst);
    for (const c of required) {
      const l = effWork(inst, c);
      if (l > 0) { best[c] = Math.max(best[c], l); cnt[c]++; }
    }
  }
  const free = () => pool.filter(i => !taken.has(i.key));

  // À égalité de niveau d'aptitude, les passifs départagent — jamais l'inverse :
  // un individu plus rapide ne compense pas un niveau d'aptitude plus faible.
  function pickBest(cands, score) {
    let bi = null, bs = -1, bsp = -1, bcov = -1;
    for (const i of cands) {
      const s = score(i);
      if (s <= 0) continue;
      const sp = i.speed, cov = reqCount(i);
      if (s > bs || (s === bs && (sp > bsp || (sp === bsp && cov > bcov)))) {
        bs = s; bsp = sp; bcov = cov; bi = i;
      }
    }
    return bi;
  }

  // Phase 0 — les épinglés sont placés d'office (et comptent dans la limite).
  const pinnedPlaced = [], pinnedDropped = [];
  for (const pid of pinnedIds) {
    if (teamSize() >= limit) { pinnedDropped.push(pid); continue; }
    // meilleur exemplaire de l'espèce épinglée, au sens des compétences qui comptent
    const cands = free().filter(i => i.palId === pid);
    const bi = pickBest(cands, i => scored.reduce((a, c) => a + effWork(i, c) * weight(c), 0) + 0.001)
            || cands[0];
    if (bi) { addToTeam(bi); pinnedPlaced.push(pid); }
  }

  // Phase A — un spécialiste du plus haut niveau effectif par compétence qui compte.
  for (const c of [...scored].sort((a, b) => demand[b] * weight(b) - demand[a] * weight(a))) {
    const maxAvail = Math.max(0, ...free().map(i => effWork(i, c)));
    if (best[c] >= maxAvail) continue;      // déjà au meilleur niveau atteignable
    if (teamSize() >= limit) break;
    const bi = pickBest(free(), i => effWork(i, c));
    if (bi) addToTeam(bi);
  }

  // Phase B — places restantes : du débit, mais uniquement avec des individus encore FORTS.
  while (teamSize() < limit) {
    const bi = pickBest(free(), i => {
      let v = 0;
      for (const c of scored) {
        const l = effWork(i, c);
        if (l > 0) v += (cnt[c] < demand[c] ? l : l * 0.15) * weight(c);
      }
      return v;
    });
    if (!bi) break;
    let v = 0;
    for (const c of scored) { const l = effWork(bi, c); if (l > 0) v += (cnt[c] < demand[c] ? l : l * 0.15) * weight(c); }
    if (v < 2) break;                        // pas de remplissage bas niveau
    addToTeam(bi);
  }

  const coverage = required.map(c => ({
    id: c, label: workById[c].label, icon: workById[c].icon,
    demand: demand[c], maxLevel: best[c], covered: best[c] > 0,
    pref: workPref(c),
  })).sort((a, b) =>
    Number(a.pref === "ignore") - Number(b.pref === "ignore")
    || Number(a.covered) - Number(b.covered) || b.demand - a.demand);

  // Le camp stocke des quantités par espèce : on agrège les individus retenus.
  const chosen = {};
  chosenInst.forEach(i => { chosen[i.palId] = (chosen[i.palId] || 0) + 1; });

  return {
    chosen, chosenInst, coverage,
    uncovered: coverage.filter(c => !c.covered && c.pref !== "ignore"),
    used: chosenInst.length, limit,
    pinnedDropped,
  };
}

// ===== Rangée de chips : priorité par compétence =====
const WORK_PREF_LOOK = {
  null:     { cls: "",          etat: "neutre",      suite: "prioriser (compte double)" },
  priority: { cls: "is-prio",   etat: "prioritaire", suite: "ignorer (ne compte plus)" },
  ignore:   { cls: "is-ignore", etat: "ignorée",     suite: "revenir au neutre" },
};
export function renderSuggestPrefs() {
  const host = document.getElementById("suggest-prefs");
  if (!host) return;
  host.innerHTML = "";
  WORK_TYPES.forEach(w => {
    const pref = workPref(w.id);
    const look = WORK_PREF_LOOK[pref] || WORK_PREF_LOOK.null;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "wpref " + look.cls;
    b.innerHTML = `<span aria-hidden="true">${w.icon}</span> ${w.label}`;
    b.title = `${w.label} — ${look.etat}. Clic pour ${look.suite}.`;
    b.setAttribute("aria-label", `${w.label} : ${look.etat}. Activer pour ${look.suite}.`);
    b.disabled = readOnly;
    b.onclick = () => cycleWorkPref(w.id);
    host.appendChild(b);
  });
}

function starsHtml(n) {
  return n > 0 ? `<span class="sg-stars" title="${n} rang(s) de condensation : +${n * CONDENSE_WORK_BONUS} d'aptitude">${"★".repeat(n)}</span>` : "";
}

export function renderSuggestion() {
  const box = document.getElementById("suggest-result");
  box.hidden = false;
  const r = computeSuggestion();

  if (r.error === "no-structures") {
    box.innerHTML = `<p class="sg-msg">Ajoute d'abord des <b>constructions</b> au camp (onglet 🏗️) : la suggestion se base sur les machines présentes.</p>`;
    return;
  }
  if (r.error === "empty-box") {
    box.innerHTML = `<p class="sg-msg">Ta <b>boîte à Pals</b> est vide. Renseigne les Pals que tu possèdes dans l'onglet 🎒, puis relance la suggestion.</p>`;
    return;
  }

  // Un individu par ligne : c'est lui qui a été choisi, pas seulement son espèce.
  const palsHtml = [...r.chosenInst]
    .sort((a, b) => a.pal.name.localeCompare(b.pal.name, "fr") || b.stars - a.stars)
    .map(i => {
      const chips = WORK_TYPES.filter(w => effWork(i, w.id) > 0).map(w => {
        const eff = effWork(i, w.id), base = i.pal.work[w.id] || 0;
        const bonus = eff > base ? ` (${base} +${eff - base})` : "";
        return `<span class="skill-chip ${levelClass(eff)}" title="${w.label} — niv. ${eff}${bonus}">${w.icon} <b>${eff}</b></span>`;
      }).join("");
      const pass = workPassives(i.passives);
      const passHtml = pass.length
        ? `<span class="sg-pass" title="Vitesse de travail ×${i.speed.toFixed(2)}">${pass.map(p => `${p.label} ×${p.factor}`).join(" · ")}</span>`
        : "";
      const lvl = i.level != null ? `<span class="sg-lvl">niv. ${i.level}</span>` : "";
      const off = i.workOff.filter(w => (i.pal.work[w] || 0) > 0).map(w => workById[w]?.label).filter(Boolean);
      const offHtml = off.length
        ? `<span class="sg-off" title="Aptitudes décochées dans la fiche de ce Pal en jeu">⊘ ${off.join(", ")}</span>` : "";
      return `<li class="sg-pal">
        <span class="sg-name">${i.pal.name}${starsHtml(i.stars)}${i.pal.nightWorker ? " 🌙" : ""}</span>
        <span class="sg-meta">${lvl}${passHtml}${offHtml}</span>
        <span class="sg-chips">${chips}</span></li>`;
    }).join("");

  const covHtml = r.coverage.map(c => {
    const ign = c.pref === "ignore";
    const tag = ign ? ` <span class="sg-tag">ignorée</span>`
      : c.pref === "priority" ? ` <span class="sg-tag is-prio">prioritaire</span>` : "";
    return `<li class="sg-cov ${ign ? "muted" : c.covered ? "ok" : "ko"}">
      <span>${c.icon} ${c.label}${tag}</span>
      <span class="sg-cov-r">🏗️ ${c.demand} · ${c.covered ? `niv. max ${c.maxLevel}` : "non couvert"}</span>
    </li>`;
  }).join("");

  const warns = [];
  if (r.uncovered.length)
    warns.push(`⚠ ${r.uncovered.length} compétence(s) requise(s) impossible(s) à couvrir avec ta boîte actuelle.`);
  if (r.pinnedDropped.length)
    warns.push(`⚠ ${r.pinnedDropped.length} Pal(s) épinglé(s) non placé(s) : la limite du camp est atteinte.`);
  const warn = warns.map(w => `<p class="sg-warn">${w}</p>`).join("");

  box.innerHTML = `
    <div class="sg-head">
      <b>Compo suggérée : ${r.used} / ${r.limit} Pals</b>
      <button id="suggest-close" class="sg-x" title="Fermer">×</button>
    </div>
    <ul class="sg-pals">${palsHtml}</ul>
    <div class="sg-sub">Couverture des machines :</div>
    <ul class="sg-covs">${covHtml}</ul>
    ${warn}
    <div class="sg-actions">
      <button id="suggest-apply" class="btn-add">Appliquer au camp</button>
      <span class="sg-note">remplace les Pals actuels du camp</span>
    </div>`;

  document.getElementById("suggest-close").onclick = () => { box.hidden = true; box.innerHTML = ""; };
  document.getElementById("suggest-apply").onclick = () => {
    if (readOnly) return;
    pushUndo("suggestion appliquée");
    active().pals = { ...r.chosen };
    saveStore(); renderAll();
    box.hidden = true; box.innerHTML = "";
  };
}
