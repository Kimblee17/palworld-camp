import { renderAll } from "./render.js";
import { DEFAULT_LIMIT, migrateBox, normalize, pushUndo, readOnly, saveStore, store, synKey, touchBox } from "./state.js";
import { PALS, STRUCTURES, palsById } from "./dataset.js";

// ===== Noms de code des Pals (utilisés par l'import de sauvegarde) =====
// Table nom de code interne Palworld (BPClass) -> nom d'affichage.
// Base automatique : le champ `code` de chaque Pal (data.js, issu de palworld.gg) — couvre
// tous les Pals 1.0 et leurs variantes. Complétée/surchargée par les entrées manuelles
// ci-dessous (au cas où une sauvegarde utiliserait un code différent).
const CODENAME_OVERRIDES = {
  PinkCat: "Cattiva", NegativeKoala: "Depresso", Boar: "Rushoar", TentacleTurtle: "Turtacle",
  SheepBall: "Lamball", ChickenPal: "Chikipi", Carbunclo: "Lifmunk", Kitsunebi: "Foxparks",
  BluePlatypus: "Fuack", ElecCat: "Sparkit", Monkey: "Tanzee", FlameBambi: "Rooby",
  Penguin: "Pengullet", Hedgehog: "Jolthog", PlantSlime: "Gumoss", CuteFox: "Vixy",
  WizardOwl: "Hoocrates", Ganesha: "Teafant", WoolFox: "Cremis", DreamDemon: "Daedream",
  NightFox: "Nox", NegativeOctopus: "Killamari", Bastet: "Mau", FlyingManta: "Celaray",
  Garm: "Direhowl", ColorfulBird: "Tocotoco", FlowerRabbit: "Flopie", CowPal: "Mozzarina",
  LittleBriarRose: "Bristla", SharkKid: "Gobfin", WindChimes: "Hangyu", BerryGoat: "Caprity",
  Alpaca: "Melpaca", Deer: "Eikthyrdeer", Deer_Ground: "Eikthyrdeer Terra", HawkBird: "Nitewing",
  PinkRabbit: "Ribbuny", CuteButterfly: "Cinnamoth", FlameBuffalo: "Arsox", LizardMan: "Leezpunk",
  Werewolf: "Loupmoon", Eagle: "Galeclaw", Gorilla: "Gorirat", SoldierBee: "Beegarde",
  QueenBee: "Elizabee", NaughtyCat: "Grintale", WeaselDragon: "Chillet", FireKirin: "Pyrin",
  IceDeer: "Reindrix", FlowerDinosaur: "Dinossom", Serpent: "Surfent", LavaGirl: "Flambelle",
  BirdDragon: "Vanwyrm", Kelpie: "Kelpsea", BlueDragon: "Azurobe", LazyDragon: "Relaxaurus",
  SakuraSaurus: "Broncherry", CatVampire: "Felbat", HadesBird: "Helzephyr", KendoFrog: "Croajiro",
  DarkAlien: "Xenovader", PurpleSpider: "Tarantriss", JellyfishGhost: "Jellroy",
  JellyfishFairy: "Jelliette", DarkCrow: "Cawgnito", LizardMan_Fire: "Leezpunk Ignis",
};
// code (BPClass) -> nom, pour tous les Pals ayant un `code`, surchargé par les entrées manuelles.
const CODENAME_TO_NAME = Object.assign(
  Object.fromEntries(PALS.filter(p => p.code).map(p => [p.code, p.name])),
  CODENAME_OVERRIDES
);
// Entités non-Pal (humains/PNJ capturés) à ignorer.
const IMPORT_HUMANS = /^(Hunter|.*Soldier|SalesPerson|.*Merchant|.*NPC)/i;

// ===== Import depuis une sauvegarde .sav (parseur WASM, 100% navigateur) =====
// Utilise la table CODENAME_TO_NAME et le filtre humains ci-dessus, pour rester
// cohérent avec le format de la boîte (entrées individuelles, cf. migrateBox).
let _saveParser = null;
export let _savPending = null; // résultat mappé en attente de validation

// Échappe le HTML (valeurs issues du fichier .sav = non maîtrisées).
export function escHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Correspondance id de poste de travail (assign_define_data_id sans suffixe _N) -> nom FR en jeu.
// Sources : localisation FR officielle (oMaN-Rod/palworld-save-pal, data/json/l10n/fr) pour les
// entrées principales ; noms datminés (PalworldModding/Docs) traduits par analogie de famille pour
// les variantes hors localisation (générateurs II/III, sphères « supérieures », armes « propres »…).
// Univers des ids = c2t-r/PalworldData, DataTable/MapObject/MapObjectAssignData.json.
// Maintenance : ajouter une ligne ici quand un id inconnu apparaît (voir prettyStation, console).
const STATION_NAMES = {
  BlastFurnace: "Fournaise de fortune",
  BlastFurnace2: "Fournaise améliorée",
  BlastFurnace3: "Fournaise électrique",
  BlastFurnace4: "Fournaise géante",
  BlastFurnace5: "Fournaise (V)",
  BreedFarm: "Élevage",
  CampFire: "Feu de camp",
  CampFire_Test: "Feu de camp",
  CookingStove: "Marmite",
  Cooler: "Climatiseur",
  CoolerBox: "Glacière",
  CopperPit: "Carrière de cuivre",
  CopperPit_2: "Carrière de cuivre II",
  Crusher: "Concasseur",
  DefenseBowGun: "Arbalète montée",
  DefenseGatlingGun: "Mitrailleuse Gatling montée",
  DefenseMachinegun: "Mitrailleuse montée",
  DefenseMinigun: "Minigun monté",
  DefenseMissile: "Lance-missiles monté",
  DefenseWait: "Sac de sable",
  ElectricCooler: "Climatiseur électrique",
  ElectricGenerator: "Générateur",
  ElectricGenerator2: "Générateur II",
  ElectricGenerator3: "Générateur III",
  ElectricGenerator_Slave: "Générateur (poste secondaire)",
  ElectricHatchingPalEgg: "Incubateur électrique",
  ElectricHeater: "Chauffage électrique",
  ElectricKitchen: "Cuisine électrique",
  Factory_Comfortable_01: "Chaîne de production (variante)",
  Factory_Comfortable_02: "Chaîne de production (variante) II",
  Factory_Hard_01: "Établi de qualité",
  Factory_Hard_02: "Chaîne de production",
  Factory_Hard_03: "Chaîne de production II",
  FarmBlockV2_Berries: "Plantation de baies",
  FarmBlockV2_Grade01: "Plantation",
  FarmBlockV2_Grade02: "Plantation",
  FarmBlockV2_Grade03: "Plantation",
  FarmBlockV2_Lettuce: "Plantation de laitue",
  FarmBlockV2_tomato: "Plantation de tomates",
  FarmBlockV2_wheet: "Plantation de blé",
  FastTravelPoint: "Statue du Grand Aigle",
  FlourMill: "Broyeur",
  FoliageLogTest: "Arbre (bûcheronnage)",
  HatchingPalEgg: "Incubateur",
  Heater: "Chauffage",
  HighTechKitchen: "Cuisine high-tech",
  Light_FirePlace01: "Cheminée en briques",
  Light_FirePlace02: "Cheminée",
  MedicineFacility_01: "Table pharmaceutique archaïque",
  MedicineFacility_02: "Table pharmaceutique électrique",
  MedicineFacility_03: "Table pharmaceutique avancée",
  MonsterFarm: "Exploitation",
  PalStorage: "Boîte à Pals",
  Refrigerator: "Réfrigérateur",
  RepairBench: "Banc de réparation",
  SphereFactory_Black_01: "Établi pour sphères",
  SphereFactory_Black_02: "Chaîne de production de sphères",
  SphereFactory_Black_03: "Chaîne de production de sphères II",
  SphereFactory_White_01: "Établi supérieur pour sphères",
  SphereFactory_White_02: "Chaîne supérieure de sphères",
  SphereFactory_White_03: "Chaîne supérieure de sphères II",
  StationDeforest2: "Scierie",
  StonePit: "Carrière",
  Torch: "Torche sur pied",
  WallTorch: "Torche murale",
  WeaponFactory_Base: "Établi pour armes (base)",
  WeaponFactory_Clean_01: "Établi pour armes (avancé)",
  WeaponFactory_Clean_02: "Chaîne d'armes (avancée)",
  WeaponFactory_Clean_03: "Chaîne d'armes (avancée) II",
  WeaponFactory_Dirty_01: "Établi pour armes",
  WeaponFactory_Dirty_02: "Chaîne de production d’armes",
  WeaponFactory_Dirty_03: "Chaîne de production d’armes II",
  WeaponFactry: "Établi pour armes",
  Well: "Puits",
  WoodCrusher: "Table de démantèlement du bois",
  WorkBench: "Établi de fortune",
  WorkBench_SkillCard: "Établi (cartes de compétence)",
  WorkBench_SkillUnlock: "Établi pour équipement de Pal",
};

// Gisements naturels : ~18 ids DamagableRock0001..DamagableRock_PV -> même nom (règle de préfixe).
const STATION_PREFIXES = [["DamagableRock", "Gisement de minerai"]];

// id de poste -> nom FR en jeu. Repli : rend lisible un id inconnu
// ("StationDeforestX" -> "Station Deforest X") et le journalise pour l'ajouter à la table.
export function prettyStation(s) {
  if (!s) return "?";
  if (STATION_NAMES[s]) return STATION_NAMES[s];
  for (const [pfx, name] of STATION_PREFIXES) if (s.startsWith(pfx)) return name;
  if (!prettyStation._seen) prettyStation._seen = new Set();
  if (!prettyStation._seen.has(s)) {
    prettyStation._seen.add(s);
    console.info("[camps] poste de travail non mappé :", s);
  }
  return String(s).replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2").replace(/\s+/g, " ").trim();
}

// ===== Mapping poste de travail (station) -> construction de l'app (structId) =====
// Best-effort : sert à dériver les quantités de constructions d'une base importée pour que
// le récapitulatif offre/demande fonctionne. Deux sources combinées :
//  1) nameToStructId : coïncidence EXACTE du nom FR (STATION_NAMES[code] === structures.json name).
//     Couvre ~21 postes gratuitement, se met à jour tout seul si les tables évoluent.
//  2) STATION_STRUCT_OVERRIDE : correspondances manuelles pour les divergences de nom
//     (« Fournaise… » vs « Four… », générateurs, sphères, armes, médicaments…).
// structId nullable : un poste non mappé reste affiché (stationName) mais ne compte pas dans
// les quantités de constructions. Ne mapper QUE les cas sûrs (un mauvais id fausserait le récap).
// Calculée à la première utilisation : au chargement du module, state.js peut ne pas
// être encore évalué (imports circulaires).
let _nameToStructId = null;
function nameToStructId() {
  if (!_nameToStructId) _nameToStructId = Object.fromEntries(STRUCTURES.map(s => [s.name, s.id]));
  return _nameToStructId;
}
const STATION_STRUCT_OVERRIDE = {
  BlastFurnace: 17, BlastFurnace2: 15, BlastFurnace3: 18, BlastFurnace4: 16,
  Cooler: 54, ElectricCooler: 55,
  ElectricGenerator: 53, ElectricGenerator2: 52, ElectricGenerator_Slave: 53,
  FlourMill: 24, StonePit: 4, StationDeforest2: 3,
  RepairBench: 34, WorkBench_SkillUnlock: 30,
  FarmBlockV2_Lettuce: 47, Factory_Hard_01: 33,
  MedicineFacility_01: 35, MedicineFacility_02: 36, MedicineFacility_03: 28,
  SphereFactory_Black_01: 31, SphereFactory_Black_02: 10, SphereFactory_Black_03: 11,
  WeaponFactory_Base: 29, WeaponFactry: 29,
  WeaponFactory_Dirty_01: 29, WeaponFactory_Dirty_02: 7, WeaponFactory_Dirty_03: 8,
  WeaponFactory_Clean_02: 9,
};
function stationStructId(station) {
  if (!station) return null;
  if (station in STATION_STRUCT_OVERRIDE) return STATION_STRUCT_OVERRIDE[station];
  const fr = STATION_NAMES[station];
  const byName = nameToStructId();
  return (fr && fr in byName) ? byName[fr] : null;
}

// Regroupe les machines d'une base par station : { name, count, structId, pals[] }.
// resolveName(instance_id) -> nom lisible du Pal affecté (ou "?"). Réutilisé par l'aperçu
// d'import ET la vue camp (agencement d'une base importée).
function stationRows(machines, resolveName) {
  const by = {};
  for (const m of machines || []) {
    const name = m.stationName || prettyStation(m.station || m.type);
    const key = name;
    if (!by[key]) by[key] = { name, count: 0, structId: m.structId ?? stationStructId(m.station), pals: [] };
    by[key].count++;
    for (const a of m.assigned || [])
      by[key].pals.push(a.name || (resolveName ? resolveName(a.pal_instance_id) : "?") || "?");
  }
  return Object.values(by).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "fr"));
}

// Rend une table station / Nb / Pals affectés (markup partagé avec l'aperçu d'import).
function stationTableHtml(rows) {
  if (!rows.length) return `<div class="sav-empty">Aucune machine installée.</div>`;
  return `<table class="sav-station-table"><thead><tr>`
    + `<th>Station</th><th title="Nombre d'exemplaires">Nb</th><th>Pals affectés</th>`
    + `</tr></thead><tbody>`
    + rows.map(o => {
        const pals = o.pals.length
          ? o.pals.slice().sort((a, b) => a.localeCompare(b))
              .map(n => `<span class="sav-chip">${escHtml(n)}</span>`).join("")
          : `<span class="sav-empty">—</span>`;
        return `<tr><td class="sav-st-name">${escHtml(o.name)}</td>`
          + `<td class="sav-st-n">${o.count > 1 ? "×" + o.count : ""}</td>`
          + `<td class="sav-st-pals">${pals}</td></tr>`;
      }).join("")
    + `</tbody></table>`;
}

async function getSaveParser(onProgress) {
  if (_saveParser) return _saveParser;
  // Chemin relatif AU MODULE (docs/js/) : le parseur est dans docs/vendor/.
  const mod = await import("../vendor/save-parser/parser.mjs");
  _saveParser = await mod.createPalworldSaveParser({ onProgress });
  return _saveParser;
}

let _idByNameLower = null;   // idem : calcul paresseux (cf. nameToStructId)
function idByNameLower() {
  if (!_idByNameLower) _idByNameLower = Object.fromEntries(PALS.map(p => [p.name.toLowerCase(), p.id]));
  return _idByNameLower;
}

// pals: [{species, level, ivs, ...}] du parseur ->
//   { counts:{id:qty}, items:[{id,name,...détails}], unmatched, humans, species, total }
// counts = ce qui est réellement importé (quantités). items = détail par Pal, pour l'aperçu.
function mapSavePals(pals) {
  const items = [];
  const unmatched = new Set();
  let humans = 0;
  for (const p of pals || []) {
    const sp = (p.species || "").trim();
    if (!sp) continue;
    const base = sp.replace(/^BOSS_/, "");            // fusionne l'alpha dans l'espèce
    const disp = CODENAME_TO_NAME[base];              // Pal connu ?
    if (!disp) {
      if (IMPORT_HUMANS.test(base)) humans++; else unmatched.add(sp);
      continue;
    }
    const id = idByNameLower()[disp.toLowerCase()];
    if (!id) { unmatched.add(disp); continue; }
    items.push({
      id, name: palsById[id] ? palsById[id].name : disp,
      instId: p.instance_id || null,                   // clé stable pour l'upsert au réimport
      species: sp, level: p.level, stars: p.stars || 0,
      ivs: p.ivs || null, gender: p.gender || null,
      passives: p.passives || [], owner_uid: p.owner_uid || "",
    });
  }
  const counts = {};
  for (const it of items) counts[it.id] = (counts[it.id] || 0) + 1;
  return {
    counts, items, unmatched: [...unmatched], humans,
    species: Object.keys(counts).length,
    total: items.length,
  };
}

// Table instance_id -> { palId, name } depuis un résultat de parseur.
// Priorité aux Pals reconnus (mapSavePals) ; repli sur l'espèce brute (nom lisible, palId null).
function buildInstToPal(res, mapped) {
  const inst = {};
  for (const it of (mapped && mapped.items) || [])
    if (it.instId) inst[it.instId] = { palId: it.id, name: it.name };
  for (const p of res.pals || []) {
    if (!p.instance_id || inst[p.instance_id]) continue;
    const base = (p.species || "").replace(/^BOSS_/, "");
    inst[p.instance_id] = { palId: null, name: CODENAME_TO_NAME[base] || p.species || "?" };
  }
  return inst;
}

// Transforme res.camps[] (bases de la save) en camps de l'app (source:"save"), keyés par base_id.
// Chaque base dérive : pals{palId:qty} (Pals affectables recoupés), structures{structId:qty}
// (via stationStructId, best-effort) et machines[] (agencement complet pour l'affichage).
function buildImportedCamps(res, instToPal) {
  const now = Date.now();
  const out = {};
  for (const c of res.camps || []) {
    if (!c.base_id) continue;
    const machines = (c.machines || []).map(m => {
      const structId = stationStructId(m.station);
      const assigned = (m.assigned || []).map(a => {
        const r = instToPal[a.pal_instance_id] || {};
        return { slot: a.slot, pal_instance_id: a.pal_instance_id, palId: r.palId ?? null, name: r.name || "?" };
      });
      return {
        work_id: m.work_id, type: m.type, station: m.station || null,
        stationName: prettyStation(m.station || m.type), structId: structId ?? null,
        slots: m.slots, assigned,
      };
    });
    // Effectif RÉEL de la base : tous les Pals qui y résident, affectés ou non.
    // `pal_instance_ids` est le conteneur de la base, c'est lui qui fait foi.
    const roster = {};
    for (const iid of c.pal_instance_ids || []) {
      const r = instToPal[iid];
      if (r && r.palId) roster[r.palId] = (roster[r.palId] || 0) + 1;
    }
    const { pals: affectes, structures } = deriveFromMachines(machines);
    const pals = fusionEffectif(roster, affectes);
    // La limite suit ce que contient RÉELLEMENT la base. Elle était figée à 15, ce qui
    // rebloquait le camp à chaque import dès qu'une base dépassait ce seuil (serveurs
    // configurés au-delà du défaut). La save fait foi ; la limite reste éditable.
    const dedans = Object.values(pals).reduce((a, n) => a + n, 0);
    out[c.base_id] = {
      name: `Base ${c.index}`,
      pals, structures, roster, limit: Math.max(DEFAULT_LIMIT, dedans),
      // Machines dont la station n'a pas d'équivalent dans notre liste de
      // constructions : elles restent dans l'agencement, mais ne peuvent pas
      // entrer dans `structures`, qui est indexé par identifiant de construction.
      unmappedMachines: machines.filter(m => m.structId == null).length,
      source: "save", base_id: c.base_id, index: c.index, guild_id: c.guild_id || null,
      location: c.location || null,
      palCount: c.pal_count || 0, machineCount: c.machine_count || 0,
      machines, importedAt: now,
    };
  }
  return out;
}

// Effectif de la base + Pals affectés à une machine -> effectif affiché.
// Un Pal peut résider dans la base sans être affecté (au repos, ou sur une station
// que nous ne savons pas rattacher) : il compte quand même. On prend le maximum des
// deux plutôt que la somme, un Pal affecté étant aussi dans le conteneur.
export function fusionEffectif(roster, affectes) {
  const out = { ...(roster || {}) };
  for (const [id, n] of Object.entries(affectes || {})) out[id] = Math.max(out[id] || 0, n);
  return out;
}

// Dérive { pals:{palId:qty}, structures:{structId:qty} } d'une liste de machines.
// Base commune à l'import initial ET à l'édition manuelle de l'agencement.
export function deriveFromMachines(machines) {
  const pals = {}, structures = {};
  for (const m of machines || []) {
    if (m.structId != null) structures[m.structId] = (structures[m.structId] || 0) + 1;
    for (const a of m.assigned || [])
      if (a.palId != null) pals[a.palId] = (pals[a.palId] || 0) + 1;
  }
  return { pals, structures };
}

export async function onSavFile(ev) {
  const file = ev.target.files[0];
  ev.target.value = "";              // permet de recharger le même fichier
  if (!file) return;
  const status = document.getElementById("sav-status");
  const preview = document.getElementById("sav-preview");
  const applyBtn = document.getElementById("sav-apply");
  applyBtn.hidden = true; preview.hidden = true; _savPending = null;
  status.textContent = "Initialisation du moteur… (1re fois : quelques secondes)";
  try {
    const parser = await getSaveParser(m => { status.textContent = m; });
    status.textContent = `Lecture de ${file.name}…`;
    const res = await parser.parse(file);
    _savPending = { r: mapSavePals(res.pals), res, name: file.name };
    renderSavPreview();
  } catch (e) {
    status.innerHTML = `<span class="imp-ko">❌ ${e.message || e}</span>`;
    console.error(e);
  }
}

function samePassives(a, b) {
  a = a || []; b = b || [];
  if (a.length !== b.length) return false;
  const sa = [...a].sort(), sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

// Diff entre la boîte actuelle et l'import, selon le mode choisi (pour l'aperçu AVANT validation).
//   merge   : upsert par instance_id — rien n'est retiré, l'existant est mis à jour, le reste ajouté.
//   replace : la boîte est vidée puis reremplie — tout ce qui n'est pas réimporté est RETIRÉ.
// Renvoie { status: Map(instId -> {kind:"new"|"up"|"same", chg?}), added, updated, same, removed[] }.
function computeSavDiff(items, mode) {
  const box = store.palBox;
  const status = new Map();
  const importKeys = new Set();
  let added = 0, updated = 0, same = 0;
  for (const it of items) {
    const key = it.instId;
    if (!key) { added++; continue; }             // sans instance_id -> toujours nouveau (synthétique)
    importKeys.add(key);
    const cur = box[key];
    if (!cur) { added++; status.set(key, { kind: "new" }); continue; }
    const newLevel = Number.isFinite(it.level) ? it.level : null;
    const chg = [];
    if ((cur.level ?? null) !== newLevel) chg.push(`niv. ${cur.level ?? "?"} → ${newLevel ?? "?"}`);
    if ((cur.stars || 0) !== (it.stars || 0)) chg.push(`★ ${cur.stars || 0} → ${it.stars || 0}`);
    if (!samePassives(cur.passives, it.passives)) chg.push("passifs");
    if (chg.length) { updated++; status.set(key, { kind: "up", chg }); }
    else { same++; status.set(key, { kind: "same" }); }
  }
  const removed = [];
  if (mode === "replace") {
    for (const [k, e] of Object.entries(box))
      if (e && e.palId && !importKeys.has(k)) removed.push(e);
  }
  return { status, added, updated, same, removed };
}

// Petit badge de statut d'une ligne de l'aperçu.
function savRowBadge(st) {
  if (!st || st.kind === "new") return `<span class="rbadge new" title="Nouveau Pal (ajouté)">🆕</span>`;
  if (st.kind === "up") return `<span class="rbadge up" title="Mis à jour : ${escHtml(st.chg.join(", "))}">🔄</span>`;
  return `<span class="rbadge same" title="Déjà présent, identique">=</span>`;
}

export function renderSavPreview() {
  const { r, res, name } = _savPending;
  const status = document.getElementById("sav-status");
  const preview = document.getElementById("sav-preview");
  const applyBtn = document.getElementById("sav-apply");
  const chars = res.counts ? res.counts.characters : 0;
  status.textContent = `${name} · ${chars} personnage(s) lu(s)`;
  preview.hidden = false;
  if (r.species === 0) {
    preview.innerHTML = `<span class="imp-ko">Aucun Pal reconnu dans cette sauvegarde.</span> `
      + `(classe : ${escHtml(res.save_game_class_name || "?")}). Essaie <b>Level.sav</b>.`;
    applyBtn.hidden = true;
    return;
  }
  const mode = document.querySelector('input[name="sav-import-mode"]:checked')?.value || "replace";
  const items = (r.items || []).slice().sort((a, b) =>
    a.name.localeCompare(b.name) || (b.level || 0) - (a.level || 0));
  const ownerName = Object.fromEntries((res.players || []).map(p => [p.uid, p.name]));
  const diff = computeSavDiff(items, mode);

  let html = `<div class="imp-ok">À importer : ${r.species} espèces · ${r.total} Pals</div>`;
  const plur = n => n > 1 ? "s" : "";
  const badges = [
    `<span class="dbadge new">🆕 ${diff.added} ajouté${plur(diff.added)}</span>`,
    diff.updated ? `<span class="dbadge up">🔄 ${diff.updated} mis à jour</span>` : "",
    diff.same ? `<span class="dbadge same">= ${diff.same} inchangé${plur(diff.same)}</span>` : "",
    diff.removed.length ? `<span class="dbadge rem">🗑️ ${diff.removed.length} retiré${plur(diff.removed.length)}</span>` : "",
  ].filter(Boolean).join("");
  html += `<div class="sav-diff" title="Aperçu du résultat sur ta boîte actuelle">${badges}</div>`;
  html += `<table class="sav-table"><thead><tr>`
    + `<th>Pal</th>`
    + `<th title="Niveau">Lv</th>`
    + `<th title="Étoiles de condensation (fusion d'âmes), 0 à 4">★</th>`
    + `<th title="Talents innés PV / Attaque / Défense (0 à 100)">IV PV/Att/Déf</th>`
    + `<th title="Nombre de compétences passives (survol = liste)">Passifs</th>`
    + `<th>Propriétaire</th>`
    + `</tr></thead><tbody>`
    + items.map(it => {
        const g = it.gender === "Female" ? " ♀" : it.gender === "Male" ? " ♂" : "";
        const stars = it.stars ? "★".repeat(it.stars) : "–";
        const iv = it.ivs ? `${it.ivs.hp}/${it.ivs.shot}/${it.ivs.defense}` : "—";
        const np = it.passives ? it.passives.length : 0;
        const pass = np
          ? `<span class="sav-pass" title="${escHtml(it.passives.join(", "))}">${np}</span>` : "–";
        const owner = ownerName[it.owner_uid]
          ? escHtml(ownerName[it.owner_uid])
          : (it.owner_uid ? "?" : "—");   // "—" = sans propriétaire (base / sauvage)
        const st = it.instId ? diff.status.get(it.instId) : null;
        const badge = savRowBadge(st);
        return `<tr class="sav-row-${st ? st.kind : "new"}"><td>${badge} ${escHtml(it.name)}<span class="sav-g">${g}</span></td>`
          + `<td>${it.level ?? "—"}</td><td class="sav-star">${stars}</td>`
          + `<td class="sav-iv">${iv}</td><td class="sav-pass-c">${pass}</td>`
          + `<td class="sav-owner">${owner}</td></tr>`;
      }).join("")
    + `</tbody></table>`;

  html += `<div class="sav-legend"><b>Lv</b> niveau · <b>★</b> étoiles de condensation (0–4) · `
    + `<b>IV</b> talents innés PV/Att/Déf (0–100) · <b>Passifs</b> nombre de compétences passives `
    + `(survol = liste) · <b>Propriétaire</b> joueur qui possède le Pal.</div>`;
  if (r.humans) html += `<div class="imp-warn">${r.humans} humain(s)/PNJ ignoré(s).</div>`;
  if (r.unmatched.length) html += `<div class="imp-warn">Non reconnus (ignorés) : ${r.unmatched.map(escHtml).join(", ")}</div>`;

  // Mode « remplacer » : Pals actuellement dans la boîte, absents de cette save -> seront retirés.
  if (diff.removed.length) {
    const byPal = {};
    for (const e of diff.removed) byPal[e.palId] = (byPal[e.palId] || 0) + 1;
    const chips = Object.entries(byPal)
      .sort((a, b) => (palsById[a[0]]?.name || a[0]).localeCompare(palsById[b[0]]?.name || b[0], "fr"))
      .map(([pid, q]) => {
        const nm = palsById[pid] ? palsById[pid].name : pid;
        return `<span class="sav-chip rem">${escHtml(nm)}${q > 1 ? ` ×${q}` : ""}</span>`;
      }).join("");
    html += `<div class="sav-removed"><div class="sav-removed-h">🗑️ Retirés de la boîte (${diff.removed.length}) `
      + `— absents de cette sauvegarde</div><div class="sav-removed-list">${chips}</div></div>`;
  }

  // Camps : machines installées + affectations Pal ↔ machine. Importés si la case est cochée.
  const camps = res.camps || [];
  if (camps.length) {
    const wantCamps = document.getElementById("opt-import-camps")?.checked;
    const instToPal = buildInstToPal(res, r);
    const resolveName = iid => (instToPal[iid] && instToPal[iid].name) || "?";
    // Diff bases par base_id vs camps « save » déjà présents (upsert comme les Pals).
    let bnew = 0, bup = 0;
    for (const c of camps) {
      if (!c.base_id) continue;
      const cur = store.camps[c.base_id];
      if (cur && cur.source === "save") bup++; else bnew++;
    }
    const head = wantCamps
      ? `🏕️ Camps (${camps.length}) — à importer · ${bnew} nouvelle(s)${bup ? ` · ${bup} mise(s) à jour` : ""}`
      : `🏕️ Camps (${camps.length}) — info, non importé (coche « Camps » pour importer)`;
    html += `<div class="sav-camps"><div class="sav-camps-h">${head}</div>`;
    html += `<div class="sav-camps-grid">`;
    for (const c of camps.slice().sort((a, b) => a.index - b.index)) {
      const rows = stationRows(c.machines, resolveName);
      html += `<div class="sav-camp">`
        + `<div class="sav-camp-head"><span class="sav-camp-name">🏕️ Base ${c.index}</span>`
        + `<span class="sav-camp-badges"><span class="sav-badge">🐾 ${c.pal_count}</span>`
        + `<span class="sav-badge">🏗️ ${c.machine_count}</span></span></div>`
        + stationTableHtml(rows)
        + `</div>`;
    }
    html += `</div></div>`;
  }

  const wantPals = document.getElementById("opt-import-pals")?.checked;
  const wantCamps = document.getElementById("opt-import-camps")?.checked;
  const what = [wantPals ? "Pals" : "", wantCamps ? "camps & affectations" : ""].filter(Boolean).join(" + ") || "rien (coche une option)";
  html += `<div class="sav-note">À importer : <b>${what}</b>. Les Pals sont enregistrés `
    + `<b>individuellement</b> (niveau, étoiles, passifs). Les camps sont recroisés par base `
    + `(réimport = mise à jour, pas de doublon). `
    + `Mode : <b>${mode === "replace" ? "remplacer" : "mettre à jour / ajouter"}</b>. `
    + `Aperçu : 🆕 nouveau · 🔄 mis à jour (survol = détail) · = inchangé`
    + `${mode === "replace" ? " · 🗑️ retiré" : ""}. Rien n'est écrit avant de valider.</div>`;
  preview.innerHTML = html;
  applyBtn.hidden = false;
}

export function applySavImport() {
  if (readOnly || !_savPending) return;
  const { r, res } = _savPending;
  const mode = document.querySelector('input[name="sav-import-mode"]:checked')?.value || "replace";
  const wantPals = document.getElementById("opt-import-pals")?.checked;
  const wantCamps = document.getElementById("opt-import-camps")?.checked;
  if (!wantPals && !wantCamps) return;
  pushUndo(mode === "replace" ? "import save (remplacement)" : "import save (synchro)");

  const parts = [];

  // --- Pals : upsert par instance_id (mise à jour, pas de doublon) ---
  if (wantPals) {
    if (mode === "replace") store.palBox = {};
    let added = 0, updated = 0;
    for (const it of r.items) {
      const key = it.instId || synKey();             // fallback si la save n'a pas d'instance_id
      if (store.palBox[key]) updated++; else added++;
      store.palBox[key] = {
        palId: it.id,
        level: Number.isFinite(it.level) ? it.level : null,
        stars: it.stars || 0,
        passives: it.passives || [],
      };
    }
    touchBox();
    parts.push(mode === "replace"
      ? `${r.total} Pals (remplacement)`
      : `Pals : ${added} ajouté(s), ${updated} mis à jour`);
  }

  // --- Camps : upsert par base_id. Ne touche JAMAIS les camps utilisateur (source !== "save"). ---
  if (wantCamps) {
    const instToPal = buildInstToPal(res, r);
    const built = buildImportedCamps(res, instToPal);
    // Conserve renommage ET limite relevée à la main : un réimport ne doit pas défaire
    // ce que l'utilisateur a ajusté.
    const prevNames = {}, prevLimits = {};
    for (const [id, c] of Object.entries(store.camps))
      if (c.source === "save") { prevNames[id] = c.name; prevLimits[id] = c.limit; }
    if (mode === "replace")                           // ne retire que les bases importées
      for (const id of Object.keys(store.camps))
        if (store.camps[id].source === "save") delete store.camps[id];
    let cadded = 0, cupdated = 0;
    for (const [id, camp] of Object.entries(built)) {
      if (store.camps[id]) cupdated++; else cadded++;
      store.camps[id] = { ...camp, name: prevNames[id] || camp.name,
                          limit: Math.max(camp.limit, prevLimits[id] || 0) };
    }
    normalize(store);                                 // répare activeId si besoin
    parts.push(`Camps : ${cadded} ajouté(s)${cupdated ? `, ${cupdated} mis à jour` : ""}`);
  }

  saveStore();
  document.getElementById("sav-preview").innerHTML =
    `<span class="imp-ok">✓ ${parts.join(" · ")}</span>.`;
  document.getElementById("sav-apply").hidden = true;
  document.getElementById("sav-status").textContent = "";
  _savPending = null;
  renderAll();
}
