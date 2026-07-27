// Données de référence embarquées (docs/data.js -> window.PAL_DATA).
// Module FEUILLE : il n'importe rien. C'est volontaire — les autres modules calculent
// des tables au chargement à partir de PALS/STRUCTURES, ce qui exige que ces valeurs
// soient déjà initialisées quels que soient les cycles d'imports entre modules.

// ===== Données de référence (embarquées via data.js) =====
export const DB = window.PAL_DATA || { workTypes: [], pals: [], structures: [] };
export const WORK_TYPES = DB.workTypes;
export const PALS = DB.pals;
export const STRUCTURES = DB.structures;
export const workById = Object.fromEntries(WORK_TYPES.map(w => [w.id, w]));
export const palsById = Object.fromEntries(PALS.map(p => [p.id, p]));
export const structById = Object.fromEntries(STRUCTURES.map(s => [s.id, s]));
