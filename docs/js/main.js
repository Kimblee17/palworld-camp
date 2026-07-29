import { renderDrops } from "./drops.js";
import { initBreeding, renderBreeding } from "./breeding.js";
import { initProduction, renderProduction, DEBUG as prodDebug } from "./production.js";
import { initShare } from "./share.js";
import { clearPediaSelection, openPediaCompare, renderPalpedia, setPediaSort, togglePediaSelection } from "./palpedia.js";
import { ELEMENT_META, ELEMENT_ORDER, buildLegend, closePalModal, openPalDetail, renderAll, renderBoxCatalog, renderPalCatalog, renderStructCatalog } from "./render.js";
import { _savPending, applySavImport, onSavFile, renderSavPreview } from "./sav-import.js";
import { SPACE_CACHE_KEY, active, doUndo, exportStore, loadStore, normalize, pushUndo, readOnly, runStoreImport, saveStore, setStore, showRoBanner, store, touchBox, uid } from "./state.js";
import { PALS, STRUCTURES, WORK_TYPES, palsById } from "./dataset.js";
import { renderSuggestion } from "./suggest.js";

export let currentTab = "pals";
let currentView = "camp";

// ===== Passerelles avec le module de synchro cloud (firebase-sync.js) =====
// Applique un store reçu du cloud (sans re-pousser : écriture dans le cache d'espace).
window.applyRemoteStore = function (data) {
  if (JSON.stringify(data) === JSON.stringify(store)) return;
  setStore(normalize(data));
  touchBox();
  localStorage.setItem(SPACE_CACHE_KEY, JSON.stringify(store));
  renderAll();
};

// Rechargé après avoir quitté un espace partagé : on revient à l'espace privé.
window.reloadLocalStore = function () {
  setStore(loadStore());   // les clés d'espace sont effacées -> charge l'espace privé
  touchBox();
  renderAll();
};

// Met à jour la barre selon l'état renvoyé par le module de synchro.
let syncLink = null, syncRoLink = null;
window.setSyncUI = function (state, info = {}) {
  const st = document.getElementById("sync-status");
  const create = document.getElementById("space-create");
  const share = document.getElementById("space-share");
  const shareRo = document.getElementById("space-share-ro");
  const join = document.getElementById("space-join");
  const leave = document.getElementById("space-leave");
  const perso = document.getElementById("sync-personal");
  const persoLink = document.getElementById("personal-link");
  syncLink = info.link || null;
  syncRoLink = info.roLink || null;
  const show = (el, on) => { if (el) el.hidden = !on; };
  const shared = window.PWCloud ? window.PWCloud.mode() === "shared" : false;
  // Espace personnel : même espace, même sécurité — seul l'habillage diffère, pour ne
  // pas parler de « groupe » à quelqu'un qui synchronise ses propres appareils.
  const perso_ = !!info.personal;
  const all = (a, b, c, d, e) => {
    show(create, a); show(share, b && !perso_); show(shareRo, c && !perso_);
    show(join, d); show(leave, e);
    show(perso, a);                       // proposé partout où « créer un espace » l'est
    show(persoLink, e && perso_);         // rappel du lien, une fois la synchro active
  };
  if (leave) {
    leave.innerHTML = perso_
      ? `<span aria-hidden="true">🔌</span> Désactiver la synchro sur cet appareil`
      : `<span aria-hidden="true">🚪</span> Quitter (revenir en privé)`;
  }
  if (state === "connecting") {
    st.textContent = "☁️ Connexion…"; st.className = "sync-status"; all(false, false, false, false, false);
  } else if (state === "legacy-ro") {
    // Ancien lien ?ws=…&ro=1 : son identifiant donne l'écriture, il n'est pas
    // rattrapable. On reste en privé et on explique quoi demander.
    st.textContent = "⚠️ Lien de lecture obsolète"; st.className = "sync-status err";
    all(true, false, false, true, false);
    showRoBanner("⚠️ Ce lien « lecture seule » est obsolète et n'est plus accepté : "
      + "sa sécurité ne pouvait pas être garantie. Demande à ton groupe un nouveau "
      + "lien de lecture (bouton 👁 Lien lecture seule), puis ouvre-le.");
  } else if (state === "shared" && info.ro) {
    st.textContent = "👁 Espace partagé — lecture seule"; st.className = "sync-status ok"; all(false, false, false, false, true);
  } else if (state === "shared") {
    const n = info.devices || 1;
    st.textContent = (perso_
      ? `🔄 Synchronisé (${n} appareil${n > 1 ? "s" : ""})`
      : "👥 Espace partagé (synchronisé)") + (info.warn ? " — ⚠️ " + info.warn : "");
    st.className = "sync-status ok";
    all(false, true, !!syncRoLink, false, true);
  } else if (state === "error") {
    st.textContent = "⚠️ " + (info.msg || "erreur de synchro"); st.className = "sync-status err";
    all(!shared, shared, shared, !shared, shared);
  } else { // "local"
    st.textContent = "🖥️ Espace privé (local à cet appareil)"; st.className = "sync-status"; all(true, false, false, true, false);
  }
};

// ===== Présence (qui est en ligne) =====
// Audit des recettes depuis la console du navigateur.
window.PW_PROD_DEBUG = prodDebug;

window.PW_NAME = () => localStorage.getItem("palworld-name") || "";
window.setPresence = function (list) {
  const el = document.getElementById("presence");
  if (!el) return;
  if (!list || !list.length) { el.hidden = true; return; }
  el.hidden = false;
  // Le pictogramme est décoratif : le nombre et l'aria-label portent l'information.
  el.innerHTML = `<span aria-hidden="true">👥</span> ${list.length}`;
  el.setAttribute("aria-label", `${list.length} personne(s) en ligne — définir mon nom`);
  el.title = "En ligne : " + list.map(p => p.name + (p.ro ? " 👁" : "") + (p.me ? " (toi)" : "")).join(", ");
};
function promptName() {
  const n = (prompt("Ton nom (visible par ton groupe dans un espace partagé) :", window.PW_NAME()) || "").trim();
  if (n) localStorage.setItem("palworld-name", n);
}

// ===== Initialisation =====
export function init() {
  document.getElementById("pals-total").textContent = PALS.length;
  document.getElementById("structs-total").textContent = STRUCTURES.length;

  const fw = document.getElementById("filter-work");
  WORK_TYPES.forEach(w => fw.add(new Option(`${w.icon} ${w.label}`, w.id)));
  const fc = document.getElementById("filter-category");
  [...new Set(STRUCTURES.map(s => s.category))].sort((a, b) => a.localeCompare(b, "fr"))
    .forEach(cat => fc.add(new Option(cat, cat)));

  document.getElementById("search").addEventListener("input", renderPalCatalog);
  fw.addEventListener("change", renderPalCatalog);
  document.getElementById("night-only").addEventListener("change", renderPalCatalog);
  document.getElementById("search-struct").addEventListener("input", renderStructCatalog);
  fc.addEventListener("change", renderStructCatalog);
  document.getElementById("search-box").addEventListener("input", renderBoxCatalog);
  document.getElementById("owned-only").addEventListener("change", renderBoxCatalog);
  document.getElementById("suggest-btn").addEventListener("click", renderSuggestion);
  document.getElementById("sav-file").addEventListener("change", onSavFile);
  document.getElementById("sav-apply").addEventListener("click", applySavImport);
  document.querySelectorAll('input[name="sav-import-mode"]').forEach(el =>
    el.addEventListener("change", () => { if (_savPending) renderSavPreview(); }));
  ["opt-import-pals", "opt-import-camps"].forEach(id =>
    document.getElementById(id)?.addEventListener("change", () => { if (_savPending) renderSavPreview(); }));
  document.querySelectorAll(".tab").forEach(t =>
    t.addEventListener("click", () => switchTab(t.dataset.tab)));
  document.querySelectorAll(".view-btn").forEach(b =>
    b.addEventListener("click", () => switchView(b.dataset.view)));
  document.getElementById("pedia-search").addEventListener("input", renderPalpedia);
  const pw = document.getElementById("pedia-work");
  WORK_TYPES.forEach(w => pw.add(new Option(`${w.icon} ${w.label}`, w.id)));
  const pe = document.getElementById("pedia-element");
  ELEMENT_ORDER.forEach(e => pe.add(new Option(ELEMENT_META[e].fr, e)));
  pw.addEventListener("change", renderPalpedia);
  pe.addEventListener("change", renderPalpedia);
  // Filtre de possession : tous / possédés / manquants.
  document.getElementById("pedia-owned").addEventListener("change", renderPalpedia);
  // Le tri est porté par un <button> dans le th : focalisable, Entrée et Espace natifs.
  document.querySelectorAll(".pedia-table th[data-sort] > button").forEach(btn =>
    btn.addEventListener("click", () => setPediaSort(btn.parentElement.dataset.sort)));
  document.getElementById("drop-search").addEventListener("input", renderDrops);

  document.getElementById("clear-camp").addEventListener("click", () => {
    if (readOnly) return;
    if (confirm("Vider ce camp (Pals et constructions) ?")) {
      pushUndo("camp vidé");
      active().pals = {}; active().structures = {}; saveStore(); renderAll();
    }
  });
  const limitInput = document.getElementById("limit-input");
  limitInput.addEventListener("change", () => {
    if (readOnly) return;
    let v = parseInt(limitInput.value, 10);
    if (!Number.isFinite(v) || v < 1) v = 1;
    active().limit = v; limitInput.value = v; saveStore(); renderAll();
  });

  document.getElementById("camp-select").addEventListener("change", e => {
    store.activeId = e.target.value; saveStore(); renderAll();
  });
  document.getElementById("camp-new").addEventListener("click", newCamp);
  document.getElementById("camp-rename").addEventListener("click", renameCamp);
  document.getElementById("camp-delete").addEventListener("click", deleteCamp);

  // Export / import de la sauvegarde locale
  document.getElementById("export-btn").addEventListener("click", exportStore);
  document.getElementById("import-btn").addEventListener("click", () => {
    if (readOnly) return;
    document.getElementById("import-file").click();
  });
  document.getElementById("import-file").addEventListener("change", async e => {
    const input = e.target;
    const file = input.files && input.files[0];
    input.value = "";                     // permet de réimporter deux fois le même fichier
    if (!file) return;
    let text;
    try { text = await file.text(); }
    catch { alert("Import impossible.\n\nLa lecture du fichier a échoué."); return; }
    runStoreImport(text, document.getElementById("import-btn"));
  });

  // Espaces partagés (cloud)
  document.getElementById("space-create").addEventListener("click", () => {
    if (confirm("Créer un espace partagé à partir de tes camps actuels ?\n\nTu obtiendras un lien à envoyer UNIQUEMENT aux amis avec qui tu joues : eux seuls verront et modifieront ces camps.")) {
      window.PWCloud?.createSharedSpace(store);
    }
  });
  // ===== Espace personnel (mes appareils) =====
  // Techniquement un espace partagé à un seul écrivain : aucune règle Firestore ni
  // collection en plus. Le panneau d'appairage insiste sur ce que le lien donne.
  function ouvrirPanneauPerso() {
    const p = document.getElementById("personal-panel");
    const url = document.getElementById("personal-url");
    const lien = window.PWCloud?.shareLink?.(false) || syncLink;
    if (!p || !url || !lien) return;
    url.value = lien;
    p.hidden = false;
    url.focus(); url.select();
  }
  document.getElementById("sync-personal").addEventListener("click", () => {
    if (!confirm("Synchroniser tes camps entre tes appareils ?\n\n"
      + "Tes camps seront envoyés dans le cloud, puis tu obtiendras un lien à ouvrir "
      + "sur ton autre appareil.\n\n"
      + "Ce lien donne le contrôle complet : ne le partage avec personne.")) return;
    window.PWCloud?.createPersonalSpace(store);
    // La création est asynchrone : on attend que le lien existe pour l'afficher.
    const t0 = Date.now();
    const attendre = setInterval(() => {
      if (window.PWCloud?.shareLink?.(false)) { clearInterval(attendre); ouvrirPanneauPerso(); }
      else if (Date.now() - t0 > 15000) clearInterval(attendre);   // échec : le statut l'affiche
    }, 200);
  });
  document.getElementById("personal-link").addEventListener("click", ouvrirPanneauPerso);
  document.getElementById("personal-close").addEventListener("click", () => {
    document.getElementById("personal-panel").hidden = true;
  });
  document.getElementById("personal-copy").addEventListener("click", async e => {
    const b = e.currentTarget, url = document.getElementById("personal-url");
    try {
      await navigator.clipboard.writeText(url.value);
      const old = b.innerHTML; b.textContent = "✓ Copié !";
      setTimeout(() => { b.innerHTML = old; }, 1800);
    } catch { url.select(); }
  });

  document.getElementById("space-join").addEventListener("click", () => {
    // Accepte un lien d'écriture (?ws=), un lien lecture seule (?r=) ou un code brut :
    // le module de synchro se charge de reconnaître le format.
    const input = (prompt("Colle le lien de partage (ou le code) reçu d'un ami :") || "").trim();
    if (input) window.PWCloud?.join(input);
  });
  document.getElementById("space-leave").addEventListener("click", () => {
    // Le libellé suit le mode : parler d'« espace partagé » à quelqu'un qui synchronise
    // ses propres appareils lui ferait craindre de perdre ses camps.
    const msg = window.PWCloud?.isPersonal?.()
      ? "Désactiver la synchro sur cet appareil ?\n\nTes camps restent dans le cloud et sur "
        + "tes autres appareils. Celui-ci repassera sur ses camps privés locaux, et pourra "
        + "se resynchroniser avec le même lien."
      : "Quitter cet espace partagé et revenir à tes camps privés (sur cet appareil) ?";
    if (confirm(msg)) window.PWCloud?.leave();
  });
  document.getElementById("space-share").addEventListener("click", async e => {
    if (!syncLink) return;
    const btn = e.currentTarget;
    try {
      await navigator.clipboard.writeText(syncLink);
      const old = btn.textContent;
      btn.textContent = "✓ Lien copié !";
      setTimeout(() => { btn.textContent = old; }, 1800);
    } catch {
      prompt("Copie ce lien et envoie-le à ton groupe :", syncLink);
    }
  });
  document.getElementById("space-share-ro").addEventListener("click", async e => {
    if (!syncRoLink) return;
    const btn = e.currentTarget;
    try {
      await navigator.clipboard.writeText(syncRoLink);
      const old = btn.textContent; btn.textContent = "✓ Copié !";
      setTimeout(() => { btn.textContent = old; }, 1800);
    } catch { prompt("Lien en lecture seule (le destinataire ne pourra pas modifier) :", syncRoLink); }
  });

  // Présence : cliquer pour définir son nom
  document.getElementById("presence").addEventListener("click", promptName);

  // Annuler
  document.getElementById("undo-btn").addEventListener("click", doUndo);

  // « ⋯ » : replie les actions secondaires du camp sur mobile. Le bouton n'est visible
  // qu'en dessous de 700px (CSS) ; l'état vit sur <body> car la limite du camp, qu'il
  // révèle aussi, se trouve dans un autre conteneur.
  document.getElementById("camp-more").addEventListener("click", e => {
    const on = document.body.classList.toggle("camp-actions-open");
    e.currentTarget.setAttribute("aria-expanded", String(on));
    e.currentTarget.setAttribute("aria-label",
      on ? "Masquer les autres actions du camp" : "Afficher les autres actions du camp");
  });

  // Modale détail Pal + raccourcis clavier
  document.querySelectorAll("#pal-modal .pm-close, #pal-modal .pm-backdrop")
    .forEach(el => el.addEventListener("click", closePalModal));
  document.getElementById("pedia-body").addEventListener("click", e => {
    if (e.target.closest("a")) return;
    // La case de comparaison vit dans une ligne cliquable : sans cette sortie, cocher
    // ouvrirait aussi la fiche détail.
    if (e.target.closest(".pedia-pick")) return;
    const tr = e.target.closest("tr[data-pal]");
    if (tr && palsById[tr.dataset.pal]) openPalDetail(palsById[tr.dataset.pal]);
  });
  document.getElementById("pedia-body").addEventListener("change", e => {
    const cb = e.target.closest(".pedia-pick input");
    if (cb) togglePediaSelection(Number(cb.dataset.pal));
  });
  document.getElementById("cmp-open").addEventListener("click", openPediaCompare);
  document.getElementById("cmp-clear").addEventListener("click", () => clearPediaSelection());
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") closePalModal();
    const tag = (document.activeElement?.tagName || "").toLowerCase();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !["input", "textarea", "select"].includes(tag)) {
      e.preventDefault(); doUndo();
    }
  });

  // Navigation par hash : bouton retour/suivant du navigateur et liens profonds.
  window.addEventListener("hashchange", () => {
    const v = viewFromHash();
    if (v !== currentView) switchView(v, false);
  });

  // PWA / hors-ligne
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

  buildLegend();
  initBreeding();
  initShare();
  initProduction();
  renderAll();
  // Applique la vue demandée par l'URL (sans hash : #camp, URL laissée intacte).
  switchView(viewFromHash(), false);
}

// ===== Onglets =====
export function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === tab));
  ["pals", "structures", "box"].forEach(name =>
    document.querySelectorAll(".tab-" + name).forEach(el => el.hidden = name !== tab));
}

// ===== Vues (Assistant de camp / Palpedia) =====
// Routage par hash : #camp (défaut) · #palpedia · #drops · #import.
// Le hash est indépendant des paramètres ?ws= / ?r= de la synchro (firebase-sync.js
// nettoie la query en conservant le hash), les deux cohabitent donc sans interférence.
const VIEWS = ["camp", "palpedia", "drops", "breeding", "production", "import"];
function viewFromHash() {
  const v = decodeURIComponent(location.hash.replace(/^#/, ""));
  return VIEWS.includes(v) ? v : "camp";
}

// updateHash=false quand l'URL porte déjà la vue (chargement initial, hashchange) :
// on évite ainsi d'écrire « #camp » sur une URL nue, dont le comportement est inchangé.
function switchView(view, updateHash = true) {
  currentView = view;
  document.querySelectorAll(".view-btn").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  document.querySelectorAll(".view-camp").forEach(el => el.hidden = view !== "camp");
  document.querySelectorAll(".view-palpedia").forEach(el => el.hidden = view !== "palpedia");
  document.querySelectorAll(".view-drops").forEach(el => el.hidden = view !== "drops");
  document.querySelectorAll(".view-breeding").forEach(el => el.hidden = view !== "breeding");
  document.querySelectorAll(".view-production").forEach(el => el.hidden = view !== "production");
  document.querySelectorAll(".view-import").forEach(el => el.hidden = view !== "import");
  // Sélection du comparateur : état de session, remis à zéro en quittant la Palpedia.
  if (view !== "palpedia") clearPediaSelection(false);
  if (view === "palpedia") renderPalpedia();
  else if (view === "drops") renderDrops();
  else if (view === "breeding") renderBreeding();
  else if (view === "production") renderProduction();
  // Nouvelle entrée d'historique -> le bouton retour revient à la vue précédente.
  if (updateHash && location.hash !== "#" + view) location.hash = view;
}

// ===== Gestion des camps =====
function newCamp() {
  if (readOnly) return;
  const n = Object.keys(store.camps).length + 1;
  const name = (prompt("Nom du nouveau camp :", "Camp " + n) || "").trim();
  if (!name) return;
  const id = uid();
  store.camps[id] = { name, pals: {}, structures: {}, limit: 15 };
  store.activeId = id; saveStore(); renderAll();
}
function renameCamp() {
  if (readOnly) return;
  const name = (prompt("Renommer le camp :", active().name) || "").trim();
  if (!name) return;
  active().name = name; saveStore(); renderAll();
}
function deleteCamp() {
  if (readOnly) return;
  if (!confirm(`Supprimer le camp « ${active().name} » ?`)) return;
  pushUndo("suppression du camp");
  delete store.camps[store.activeId];
  const ids = Object.keys(store.camps);
  if (ids.length === 0) {
    const id = uid();
    store.camps[id] = { name: "Camp 1", pals: {}, structures: {}, limit: 15 };
    store.activeId = id;
  } else {
    store.activeId = ids[0];
  }
  saveStore(); renderAll();
}

// Point d'entrée : les modules ES sont différés, le DOM est donc prêt ici, et
// main.js s'exécute avant firebase-sync.js (ordre des balises <script>).
init();
