import { active, pushUndo, readOnly, saveStore, store, uid } from "./state.js";

// ===== Notes & tâches par camp =====
//
// Tout vit dans le camp (`notes`, `todos`), donc la persistance, l'export, l'annulation
// et la synchro d'espace partagé fonctionnent sans une ligne de code en plus.
//
// Deux temporisations se succèdent volontairement sur la frappe des notes :
//   1. ici, 500 ms après la dernière touche, avant d'écrire dans le store ;
//   2. dans firebase-sync.push(), 500 ms de plus avant d'écrire chez Firestore.
// Une phrase tapée d'un trait ne produit donc qu'UN document écrit, pas un par touche.
const DEBOUNCE_NOTES = 500;

// L'état replié/déplié est une préférence d'affichage, pas une donnée de camp : il
// reste local à l'appareil. Le mettre dans le store le pousserait chez Firestore à
// chaque clic et l'imposerait aux autres appareils.
const OPEN_KEY = "palworld-notes-open";

function ouverts() {
  try { return JSON.parse(localStorage.getItem(OPEN_KEY)) || {}; } catch { return {}; }
}
function estOuvert(id) { return !!ouverts()[id]; }
function memoriserOuvert(id, on) {
  const o = ouverts();
  if (on) o[id] = true; else delete o[id];
  localStorage.setItem(OPEN_KEY, JSON.stringify(o));
}

const esc = s => String(s).replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function autoGrandir(ta) {
  ta.style.height = "auto";
  ta.style.height = Math.min(400, ta.scrollHeight) + "px";
}

let notesTimer = null;
// Camp auquel appartient la frappe en cours, et camp actuellement affiché. Sans ces
// deux repères, changer de camp pendant la temporisation écrirait le texte saisi dans
// le MAUVAIS camp — et la garde « ne pas réécrire pendant la frappe » laisserait les
// notes du camp précédent à l'écran.
let notesCible = null;
let campAffiche = null;

function enregistrerNotes(valeur, campId) {
  const c = store.camps[campId];
  if (!c || c.notes === valeur) return;
  c.notes = valeur;
  saveStore();
}

// Écrit sans attendre la fin de la temporisation (changement de camp, perte du focus).
function viderTemporisation() {
  clearTimeout(notesTimer);
  notesTimer = null;
  const ta = document.getElementById("camp-notes");
  if (ta && notesCible && !readOnly) enregistrerNotes(ta.value, notesCible);
  notesCible = null;
}

// ===== Rendu =====
export function renderNotes() {
  const corps = document.getElementById("notes-body");
  const bascule = document.getElementById("notes-toggle");
  if (!corps || !bascule) return;

  const camp = active();
  const todos = camp.todos || [];
  const faites = todos.filter(t => t.done).length;

  const compteur = document.getElementById("notes-count");
  if (compteur) {
    compteur.textContent = todos.length ? `${faites} / ${todos.length}` : "";
    compteur.title = todos.length ? `${faites} tâche(s) faite(s) sur ${todos.length}` : "";
  }

  const ouvert = estOuvert(store.activeId);
  corps.hidden = !ouvert;
  bascule.setAttribute("aria-expanded", String(ouvert));
  const caret = bascule.querySelector(".nt-caret");
  if (caret) caret.textContent = ouvert ? "▾" : "▸";

  const ta = document.getElementById("camp-notes");
  const changementDeCamp = campAffiche !== store.activeId;
  // Frappe en cours au moment où l'on change de camp : on l'enregistre d'abord sur son
  // camp d'origine, sinon elle serait perdue ou attribuée au camp suivant.
  if (changementDeCamp && notesTimer) viderTemporisation();
  // Hors changement de camp, on ne réécrit pas la zone pendant la frappe : un rendu
  // déclenché par ailleurs (mise à jour distante, annulation) replacerait le curseur.
  if (ta && (changementDeCamp || document.activeElement !== ta)) {
    ta.value = camp.notes || "";
    autoGrandir(ta);
  }
  campAffiche = store.activeId;
  if (ta) ta.disabled = readOnly;
  const champ = document.getElementById("todo-input");
  const ajout = document.getElementById("todo-add");
  if (champ) champ.disabled = readOnly;
  if (ajout) ajout.disabled = readOnly;

  const liste = document.getElementById("todo-list");
  if (!liste) return;
  liste.innerHTML = "";
  if (!todos.length) {
    liste.innerHTML = `<li class="empty">Aucune tâche pour ce camp.</li>`;
    return;
  }
  todos.forEach((t, i) => {
    const li = document.createElement("li");
    li.className = "todo-row" + (t.done ? " done" : "");
    li.innerHTML = `
      <input type="checkbox" id="todo-${t.id}" ${t.done ? "checked" : ""} ${readOnly ? "disabled" : ""}>
      <label for="todo-${t.id}" class="todo-txt">${esc(t.text)}</label>
      <span class="todo-actions">
        <button type="button" class="btn-step" data-act="up" data-i="${i}" ${i === 0 || readOnly ? "disabled" : ""}
                aria-label="Monter : ${esc(t.text)}"><span aria-hidden="true">↑</span></button>
        <button type="button" class="btn-step" data-act="down" data-i="${i}" ${i === todos.length - 1 || readOnly ? "disabled" : ""}
                aria-label="Descendre : ${esc(t.text)}"><span aria-hidden="true">↓</span></button>
        <button type="button" class="btn-step btn-x" data-act="del" data-i="${i}" ${readOnly ? "disabled" : ""}
                aria-label="Supprimer : ${esc(t.text)}"><span aria-hidden="true">✕</span></button>
      </span>`;
    li.querySelector("input").addEventListener("change", () => basculerTache(i));
    liste.appendChild(li);
  });
}

// ===== Actions sur la checklist (toutes passent par pushUndo) =====
function ajouterTache() {
  if (readOnly) return;
  const champ = document.getElementById("todo-input");
  const texte = (champ.value || "").trim().slice(0, 200);
  if (!texte) return;
  pushUndo("Ajout d'une tâche");
  active().todos.push({ id: uid(), text: texte, done: false });
  champ.value = "";
  saveStore();
  renderNotes();
  champ.focus();
}

function basculerTache(i) {
  if (readOnly) return;
  const t = active().todos[i];
  if (!t) return;
  pushUndo(t.done ? "Tâche décochée" : "Tâche cochée");
  t.done = !t.done;
  saveStore();
  renderNotes();
}

function supprimerTache(i) {
  if (readOnly) return;
  const todos = active().todos;
  if (!todos[i]) return;
  pushUndo("Suppression d'une tâche");
  todos.splice(i, 1);
  saveStore();
  renderNotes();
}

function deplacerTache(i, delta) {
  if (readOnly) return;
  const todos = active().todos;
  const j = i + delta;
  if (!todos[i] || !todos[j]) return;
  pushUndo("Réordonnancement des tâches");
  [todos[i], todos[j]] = [todos[j], todos[i]];
  saveStore();
  renderNotes();
  // Le focus suit la tâche déplacée, sinon un usage clavier repart du début à chaque
  // pression sur monter/descendre.
  document.querySelector(`#todo-list [data-act="${delta < 0 ? "up" : "down"}"][data-i="${j}"]`)?.focus();
}

// ===== Initialisation =====
export function initNotes() {
  const bascule = document.getElementById("notes-toggle");
  if (!bascule) return;

  bascule.addEventListener("click", () => {
    memoriserOuvert(store.activeId, !estOuvert(store.activeId));
    renderNotes();
    if (estOuvert(store.activeId)) document.getElementById("camp-notes")?.focus();
  });

  const ta = document.getElementById("camp-notes");
  ta.addEventListener("input", () => {
    autoGrandir(ta);
    if (readOnly) return;
    notesCible = store.activeId;          // le camp visé est figé au moment de la frappe
    clearTimeout(notesTimer);
    notesTimer = setTimeout(() => {
      notesTimer = null;
      enregistrerNotes(ta.value, notesCible);   // -> push() différé de 500 ms de plus
      notesCible = null;
    }, DEBOUNCE_NOTES);
  });
  // Quitter le champ enregistre tout de suite : sans cela, changer de camp juste après
  // la frappe perdrait les derniers caractères.
  ta.addEventListener("blur", viderTemporisation);

  document.getElementById("todo-add").addEventListener("click", ajouterTache);
  document.getElementById("todo-input").addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); ajouterTache(); }
  });
  document.getElementById("todo-list").addEventListener("click", e => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const i = Number(b.dataset.i);
    if (b.dataset.act === "del") supprimerTache(i);
    else deplacerTache(i, b.dataset.act === "up" ? -1 : 1);
  });
}
