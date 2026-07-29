import { PALS, STRUCTURES } from "./dataset.js";
import { pushUndo, readOnly, saveStore, store, uid } from "./state.js";
import { renderAll } from "./render.js";

// ===== Partage d'une compo par URL, sans serveur =====
//
// Toute la compo tient dans le fragment (#c=…), qui n'est jamais envoyé au serveur :
// le partage ne dépend donc ni de Firebase ni d'un compte. Format de la charge utile :
//
//     #c=<drapeau><base64url>      drapeau « z » = deflate-raw, « b » = JSON brut
//
// Le drapeau est indispensable : CompressionStream n'existe pas partout (Safari
// ancien), et sans lui un lecteur ne saurait pas s'il doit décompresser.
//
// Le lien produit repart d'une URL NUE : on retire ?ws= / ?r= pour ne pas donner
// l'accès à un espace partagé en même temps qu'une simple compo.

const PREFIXE = "c=";

const b64url = bytes => {
  let s = "";
  // Par tranches : String.fromCharCode(...) sur un gros tableau ferait sauter la pile.
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const deB64url = txt => {
  const norm = txt.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(norm + "=".repeat((4 - norm.length % 4) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

async function viaFlux(bytes, flux) {
  const s = new Blob([bytes]).stream().pipeThrough(flux);
  return new Uint8Array(await new Response(s).arrayBuffer());
}

// ===== Écriture =====
export async function lienDeCompo(camp) {
  const json = JSON.stringify({ n: camp.name, l: camp.limit, p: camp.pals, s: camp.structures });
  const brut = new TextEncoder().encode(json);
  let charge = null;
  if (typeof CompressionStream !== "undefined") {
    try {
      charge = "z" + b64url(await viaFlux(brut, new CompressionStream("deflate-raw")));
    } catch { charge = null; }             // repli silencieux : le lien brut marche aussi
  }
  if (charge === null) charge = "b" + b64url(brut);

  const u = new URL(location.href);
  u.search = "";                            // jamais de ?ws= / ?r= dans un lien de compo
  u.hash = PREFIXE + charge;
  return u.toString();
}

// ===== Lecture =====
async function decoder(charge) {
  const drapeau = charge[0];
  const bytes = deB64url(charge.slice(1));
  let json;
  if (drapeau === "z") json = new TextDecoder().decode(
    await viaFlux(bytes, new DecompressionStream("deflate-raw")));
  else if (drapeau === "b") json = new TextDecoder().decode(bytes);
  else throw new Error("drapeau inconnu");
  return JSON.parse(json);
}

// Un lien peut venir d'une version plus ancienne, d'un copier-coller tronqué ou d'une
// main malicieuse : on ne fait confiance à rien. Les identifiants inconnus sont écartés
// plutôt que de faire échouer tout l'import.
function nettoyer(d) {
  if (!d || typeof d !== "object") throw new Error("structure invalide");
  const filtre = (obj, ids) => {
    const out = {};
    for (const [k, v] of Object.entries(obj && typeof obj === "object" ? obj : {})) {
      const id = Number(k), n = Math.floor(Number(v));
      if (ids.has(id) && Number.isFinite(n) && n > 0) out[id] = Math.min(999, n);
    }
    return out;
  };
  const camp = {
    name: String(d.n ?? "").trim().slice(0, 60) || "Compo partagée",
    limit: Math.min(50, Math.max(1, Math.floor(Number(d.l)) || 15)),
    pals: filtre(d.p, new Set(PALS.map(p => p.id))),
    structures: filtre(d.s, new Set(STRUCTURES.map(s => s.id))),
  };
  if (!Object.keys(camp.pals).length && !Object.keys(camp.structures).length)
    throw new Error("compo vide");
  return camp;
}

function nettoyerHash() {
  // replaceState ne déclenche pas hashchange : le routage des vues n'est pas perturbé.
  history.replaceState(null, "", location.pathname + location.search);
}

function bandeau(html, boutons = []) {
  const el = document.getElementById("share-banner");
  if (!el) return;
  el.innerHTML = `<span class="sb-txt">${html}</span>`;
  for (const b of boutons) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "bar-btn" + (b.principal ? " sb-go" : "");
    btn.textContent = b.libelle;
    btn.addEventListener("click", b.action);
    el.appendChild(btn);
  }
  el.hidden = false;
}

function fermerBandeau() {
  const el = document.getElementById("share-banner");
  if (el) { el.hidden = true; el.innerHTML = ""; }
}

// L'ajout crée TOUJOURS un nouveau camp : un lien reçu ne doit jamais pouvoir écraser
// le travail en cours. pushUndo d'abord, donc « Annuler » rattrape l'ajout.
function ajouterCompo(camp) {
  pushUndo("Ajout d'une compo partagée");
  const id = uid();
  let nom = camp.name;
  const pris = new Set(Object.values(store.camps).map(c => c.name));
  for (let i = 2; pris.has(nom); i++) nom = `${camp.name} (${i})`;
  store.camps[id] = { name: nom, pals: camp.pals, structures: camp.structures, limit: camp.limit };
  store.activeId = id;
  saveStore();
  renderAll();
  return nom;
}

async function lireLienEntrant() {
  const hash = location.hash.slice(1);
  if (!hash.startsWith(PREFIXE)) return;
  const charge = hash.slice(PREFIXE.length);

  let camp;
  try {
    camp = nettoyer(await decoder(charge));
  } catch {
    // Aucune exception ne remonte : un lien abîmé est un cas ordinaire, pas un bug.
    bandeau("😕 Ce lien de compo est illisible ou incomplet. Demande à son auteur de le renvoyer en entier.",
      [{ libelle: "Fermer", action: () => { fermerBandeau(); nettoyerHash(); } }]);
    return;
  }

  if (readOnly) {
    bandeau(`Compo partagée « <b>${camp.name}</b> » — impossible de l'ajouter depuis un lien en lecture seule.`,
      [{ libelle: "Fermer", action: () => { fermerBandeau(); nettoyerHash(); } }]);
    return;
  }

  const nbPals = Object.values(camp.pals).reduce((a, n) => a + n, 0);
  const nbStructs = Object.values(camp.structures).reduce((a, n) => a + n, 0);
  bandeau(
    `Compo partagée « <b>${camp.name}</b> » — l'ajouter à mes camps ? `
    + `<span class="sb-detail">${nbPals} Pal(s) · ${nbStructs} construction(s)</span>`,
    [
      { libelle: "Ajouter", principal: true, action: () => {
          const nom = ajouterCompo(camp);
          bandeau(`✓ « <b>${nom}</b> » ajouté à tes camps.`,
            [{ libelle: "Fermer", action: fermerBandeau }]);
          nettoyerHash();
        } },
      { libelle: "Ignorer", action: () => { fermerBandeau(); nettoyerHash(); } },
    ]);
}

export function initShare() {
  const btn = document.getElementById("camp-share");
  if (btn) btn.addEventListener("click", async e => {
    const b = e.currentTarget;
    const camp = store.camps[store.activeId];
    // Un camp vide produirait un lien que le destinataire rejetterait : autant le dire
    // tout de suite à l'expéditeur plutôt que de le laisser diffuser un lien mort.
    if (!Object.keys(camp.pals).length && !Object.keys(camp.structures).length) {
      bandeau("Ce camp est vide : ajoute des Pals ou des constructions avant de le partager.",
        [{ libelle: "Fermer", action: fermerBandeau }]);
      return;
    }
    const lien = await lienDeCompo(camp);
    try {
      await navigator.clipboard.writeText(lien);
      const old = b.innerHTML;
      b.textContent = "✓ Lien copié !";
      setTimeout(() => { b.innerHTML = old; }, 1800);
    } catch {
      prompt("Copie ce lien pour partager cette compo :", lien);
    }
  });
  lireLienEntrant();
  // Coller un lien #c= dans un onglet DÉJÀ ouvert ne recharge pas la page : sans cette
  // écoute, rien ne se passerait. nettoyerHash() utilise replaceState, qui ne déclenche
  // pas hashchange — pas de boucle à craindre.
  window.addEventListener("hashchange", lireLienEntrant);
}
