// ===== Espaces partagés (Firebase Firestore) — module ES chargé après app.js =====
// Privé par défaut. Sécurité appliquée CÔTÉ SERVEUR (cf. firestore.rules) via deux
// documents et deux capacités distinctes :
//
//   workspaces/{wsId}   privé, écrivains uniquement
//     { owner, writers: [uid...], readKey, store, updatedAt, presence: { uid: {name, ts, ro} } }
//
//   reads/{readKey}     miroir accessible en connaissant readKey
//     { store, updatedAt, writers: [uid...], presence: { uid: {...} } }
//     ⚠ ne contient JAMAIS wsId : sinon le lien de lecture divulguerait l'écriture.
//
// Liens : écriture ?ws=<wsId> · lecture seule ?r=<readKey>
// - écrivain : abonné à workspaces/{wsId} ; chaque push écrit les DEUX documents (writeBatch)
// - lecteur  : abonné à reads/{readKey} uniquement, ne pousse jamais store
// - présence : heartbeat 15 s, clé = uid (les règles imposent presence.<uid> aux lecteurs)
// - ancien lien ?ws=…&ro=1 : obsolète (identifiant d'écriture déjà divulgué) -> bandeau
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, onSnapshot, getDoc, setDoc, updateDoc, deleteField,
  serverTimestamp, writeBatch, arrayUnion,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDucOyiw6mv9nuAzcOShaFGYJM30pAeg0M",
  authDomain: "palworld-92e5f.firebaseapp.com",
  projectId: "palworld-92e5f",
  storageBucket: "palworld-92e5f.firebasestorage.app",
  messagingSenderId: "964199342005",
  appId: "1:964199342005:web:8ce8a05f9f0aee1f1e83fc",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const SPACE_KEY = "palworld-space";     // wsId — mode écriture
const READ_KEY = "palworld-readkey";    // readKey — mode lecture seule
const LEGACY_WS = "palworld-ws";        // ancien emplacement du wsId
const LEGACY_RO = "palworld-ro";        // ancien indicateur de lecture seule

let wsId = null;        // espace en écriture (null en mode lecture)
let readKey = null;     // capacité de lecture (connue des écrivains ET du lecteur)
let reader = false;     // true = mode lecture seule (abonné à reads/)
let writers = [];       // uid des écrivains, tel que vu dans le dernier snapshot
let unsub = null;
let pushTimer = null;
let hbTimer = null;
let lastJson = null;
let mirrorWarned = false;

function myUid() { return auth.currentUser ? auth.currentUser.uid : null; }
// Nom tronqué à 40 caractères : c'est la limite imposée par firestore.rules sur
// l'entrée de présence d'un lecteur (au-delà, son heartbeat serait refusé).
function myName() {
  const u = myUid() || "";
  const n = (window.PW_NAME && window.PW_NAME()) || localStorage.getItem("palworld-name")
    || ("Invité-" + u.slice(0, 4));
  return String(n).slice(0, 40);
}

function status(state, info) { window.setSyncUI?.(state, info || {}); }
function wsRef(id) { return doc(db, "workspaces", id); }
function readRef(key) { return doc(db, "reads", key); }
async function ensureAuth() { if (!auth.currentUser) await signInAnonymously(auth); }

// Secret aléatoire (22 hex) — sert d'identifiant d'espace ET de clé de lecture.
function randomKey() {
  const a = new Uint8Array(16); crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 22);
}

// ----- Liens -----
function baseUrl() {
  const u = new URL(location.href);
  u.search = ""; u.hash = "";
  return u;
}
function writeLink(id) { const u = baseUrl(); u.searchParams.set("ws", id); return u.toString(); }
function readLink(key) { const u = baseUrl(); u.searchParams.set("r", key); return u.toString(); }
function currentLinks() {
  return {
    link: wsId ? writeLink(wsId) : null,
    roLink: readKey && !reader ? readLink(readKey) : null,
  };
}
function stripQueryFromUrl() {
  const u = new URL(location.href);
  if (u.searchParams.has("ws") || u.searchParams.has("r") || u.searchParams.has("ro")) {
    u.searchParams.delete("ws"); u.searchParams.delete("r"); u.searchParams.delete("ro");
    history.replaceState(null, "", u.pathname + (u.search || "") + u.hash);
  }
}
// Accepte un lien collé ou un code brut. Renvoie {ws} ou {r} ou {legacyRo:true}.
function parseInvite(input) {
  const s = (input || "").trim();
  if (!s) return {};
  const r = s.match(/[?&]r=([^&\s]+)/);
  if (r) return { r: decodeURIComponent(r[1]) };
  const w = s.match(/[?&]ws=([^&\s]+)/);
  if (w) return { ws: decodeURIComponent(w[1]), legacyRo: /[?&]ro=1\b/.test(s) };
  return { ws: s };   // code brut -> traité comme un lien d'écriture
}

// ----- Présence (clé = uid, imposé par les règles côté lecteur) -----
function presenceTarget() {
  if (reader) return readKey ? readRef(readKey) : null;
  return wsId ? wsRef(wsId) : null;
}
async function beat() {
  const u = myUid(); const ref = presenceTarget();
  if (!u || !ref) return;
  try {
    await updateDoc(ref, { ["presence." + u]: { name: myName(), ts: Date.now(), ro: reader } });
  } catch { /* doc supprimé ou droits insuffisants : la présence est accessoire */ }
}
function startHeartbeat() { stopHeartbeat(); beat(); hbTimer = setInterval(beat, 15000); }
function stopHeartbeat() { if (hbTimer) { clearInterval(hbTimer); hbTimer = null; } }
async function dropPresence() {
  const u = myUid(); const ref = presenceTarget();
  if (!u || !ref) return;
  try { await updateDoc(ref, { ["presence." + u]: deleteField() }); } catch { /* ignore */ }
}
function readPresence(snap) {
  const p = (snap.data() && snap.data().presence) || {};
  const now = Date.now();
  const me = myUid();
  const list = Object.entries(p)
    .filter(([, v]) => v && now - (v.ts || 0) < 45000)
    .map(([id, v]) => ({ id, name: v.name || "?", ro: !!v.ro, me: id === me }))
    .sort((a, b) => a.name.localeCompare(b.name, "fr"));
  window.setPresence?.(list);
}

// ----- Abonnement -----
function applySnapshot(snap) {
  if (!snap.exists()) { status("error", { msg: "espace introuvable" }); return; }
  readPresence(snap);
  const d = snap.data();

  if (!reader) {
    // L'espace porte la liste des écrivains et la clé de lecture (liens à jour).
    const nextWriters = Array.isArray(d.writers) ? d.writers : [];
    const writersChanged = JSON.stringify(nextWriters) !== JSON.stringify(writers);
    const keyChanged = (d.readKey || null) !== readKey;
    writers = nextWriters;
    if (d.readKey) readKey = d.readKey;
    if (writersChanged || keyChanged) {
      status("shared", { spaceId: wsId, ro: false, ...currentLinks() });
      // Le miroir autorise l'écriture aux uid de SON writers : on le rafraîchit
      // pour qu'un écrivain fraîchement ajouté puisse pousser à son tour.
      if (writersChanged && d.store) syncMirror(d.store);
    }
  }

  const data = d.store;
  if (!data) return;
  const json = JSON.stringify(data);
  if (json === lastJson) return;
  lastJson = json;
  window.applyRemoteStore?.(data);
}

function subscribe() {
  if (unsub) unsub();
  const ref = reader ? readRef(readKey) : wsRef(wsId);
  unsub = onSnapshot(ref, applySnapshot, err => status("error", { msg: err.code || err.message }));
}

// Rafraîchit le miroir (store + writers) — best-effort : échoue tant que cet
// écrivain n'est pas encore dans le writers DU MIROIR (cf. push()).
async function syncMirror(store) {
  if (reader || !readKey || !writers.length) return;
  try {
    await setDoc(readRef(readKey), { store, updatedAt: serverTimestamp(), writers }, { merge: true });
  } catch { /* un écrivain déjà établi s'en chargera */ }
}

function enterWriter(id) {
  wsId = id; reader = false;
  localStorage.setItem(SPACE_KEY, id);
  localStorage.removeItem(READ_KEY); localStorage.removeItem(LEGACY_RO);
  window.setReadOnly?.(false);
  subscribe();
  startHeartbeat();
  status("shared", { spaceId: id, ro: false, ...currentLinks() });
}

function enterReader(key) {
  readKey = key; reader = true; wsId = null;
  localStorage.setItem(READ_KEY, key);
  localStorage.removeItem(SPACE_KEY); localStorage.removeItem(LEGACY_RO);
  window.setReadOnly?.(true);
  subscribe();
  startHeartbeat();
  status("shared", { spaceId: null, ro: true, link: null, roLink: null });
}

// Adhésion en écriture : migre un espace legacy, sinon s'auto-ajoute à writers.
async function ensureWriterMembership(id) {
  const u = myUid();
  const snap = await getDoc(wsRef(id));
  if (!snap.exists()) throw Object.assign(new Error("espace introuvable"), { code: "not-found" });
  const d = snap.data();

  // Espace créé avant la refonte : on pose owner/writers/readKey et on crée le miroir.
  if (d.owner === undefined) {
    const key = randomKey();
    const batch = writeBatch(db);
    batch.update(wsRef(id), { owner: u, writers: [u], readKey: key, updatedAt: serverTimestamp() });
    batch.set(readRef(key), { store: d.store || {}, updatedAt: serverTimestamp(), writers: [u] });
    await batch.commit();
    readKey = key; writers = [u];
    return;
  }

  readKey = d.readKey || null;
  writers = Array.isArray(d.writers) ? d.writers : [];
  if (!writers.includes(u)) {
    // Update d'auto-ajout : le SEUL changement est l'ajout de mon uid à writers.
    await updateDoc(wsRef(id), { writers: arrayUnion(u) });
    writers = writers.concat([u]);
  }
}

const Cloud = {
  mode: () => (wsId || reader ? "shared" : "local"),
  spaceId: () => wsId,
  isReadOnly: () => reader,
  shareLink: (ro) => (ro ? (readKey && !reader ? readLink(readKey) : null) : (wsId ? writeLink(wsId) : null)),

  async createSharedSpace(seedStore) {
    try {
      status("connecting");
      await ensureAuth();
      const u = myUid();
      const id = randomKey();
      const key = randomKey();
      const batch = writeBatch(db);
      batch.set(wsRef(id), {
        owner: u, writers: [u], readKey: key,
        store: seedStore, updatedAt: serverTimestamp(),
      });
      batch.set(readRef(key), { store: seedStore, updatedAt: serverTimestamp(), writers: [u] });
      await batch.commit();
      readKey = key; writers = [u];
      lastJson = JSON.stringify(seedStore);
      enterWriter(id);
    } catch (e) {
      wsId = null; readKey = null; reader = false;
      status("error", { msg: e.code || e.message });
    }
  },

  // Rejoindre en écriture (lien ?ws= ou code brut). Un ancien lien ?ws=…&ro=1
  // n'est PAS sécurisable rétroactivement : on prévient l'utilisateur.
  async join(input) {
    const p = parseInvite(input);
    if (p.r) return Cloud.joinRead(p.r);
    if (!p.ws) { status("error", { msg: "lien invalide" }); return; }
    if (p.legacyRo) { Cloud.showLegacyRoNotice(); return; }
    try {
      status("connecting");
      await ensureAuth();
      lastJson = null; mirrorWarned = false;
      await ensureWriterMembership(p.ws);
      enterWriter(p.ws);
    } catch (e) { status("error", { msg: e.code || e.message }); }
  },

  // Rejoindre en lecture seule (lien ?r=<readKey>) : abonnement au miroir seul.
  async joinRead(key) {
    try {
      status("connecting");
      await ensureAuth();
      lastJson = null;
      enterReader(key);
    } catch (e) { status("error", { msg: e.code || e.message }); }
  },

  showLegacyRoNotice() {
    localStorage.removeItem(LEGACY_RO);
    localStorage.removeItem(SPACE_KEY);
    localStorage.removeItem(LEGACY_WS);
    status("legacy-ro");
  },

  push(store) {
    if (reader || !wsId) return;   // un lecteur ne pousse jamais store
    clearTimeout(pushTimer);
    pushTimer = setTimeout(async () => {
      const stamp = () => serverTimestamp();
      try {
        lastJson = JSON.stringify(store);
        const batch = writeBatch(db);
        batch.update(wsRef(wsId), { store, updatedAt: stamp() });
        if (readKey) {
          // Le miroir reçoit aussi writers : c'est ce qui ouvre l'écriture du
          // miroir aux écrivains ajoutés après sa création.
          batch.set(readRef(readKey), { store, updatedAt: stamp(), writers }, { merge: true });
        }
        await batch.commit();
        mirrorWarned = false;
      } catch (e) {
        // Miroir pas encore ouvert à cet uid : on pousse au moins l'espace pour
        // ne pas perdre la modification (le miroir se remettra à jour au prochain
        // push d'un écrivain déjà établi, cf. syncMirror).
        if (e.code === "permission-denied" && readKey) {
          try {
            await updateDoc(wsRef(wsId), { store, updatedAt: serverTimestamp() });
            if (!mirrorWarned) {
              mirrorWarned = true;
              status("shared", {
                spaceId: wsId, ro: false, ...currentLinks(),
                warn: "lien lecture seule pas encore à jour",
              });
            }
            return;
          } catch (e2) { status("error", { msg: e2.code || e2.message }); return; }
        }
        status("error", { msg: e.code || e.message });
      }
    }, 500);
  },

  leave() {
    stopHeartbeat();
    dropPresence();
    if (unsub) { unsub(); unsub = null; }
    wsId = null; readKey = null; reader = false; writers = []; lastJson = null;
    localStorage.removeItem(SPACE_KEY); localStorage.removeItem(READ_KEY);
    localStorage.removeItem(LEGACY_RO); localStorage.removeItem(LEGACY_WS);
    window.setReadOnly?.(false);
    window.setPresence?.([]);
    status("local");
    window.reloadLocalStore?.();
  },
};

window.PWCloud = Cloud;
window.addEventListener("beforeunload", () => { if (wsId || reader) dropPresence(); });

(async () => {
  const usp = new URLSearchParams(location.search);
  const urlWs = usp.get("ws");
  const urlRead = usp.get("r");
  const urlLegacyRo = usp.get("ro") === "1";
  if (urlWs || urlRead || usp.has("ro")) stripQueryFromUrl();

  // Migration des anciennes clés de stockage.
  const legacyWs = localStorage.getItem(LEGACY_WS);
  if (legacyWs) {
    if (!localStorage.getItem(SPACE_KEY)) localStorage.setItem(SPACE_KEY, legacyWs);
    localStorage.removeItem(LEGACY_WS);
  }

  // 1) Ancien lien lecture seule : obsolète, on n'essaie pas de le rattraper.
  if (urlWs && urlLegacyRo) { Cloud.showLegacyRoNotice(); return; }
  // 2) Liens explicites.
  if (urlRead) { await Cloud.joinRead(urlRead); return; }
  if (urlWs) { await Cloud.join(urlWs); return; }
  // 3) Ancienne session « lecture seule » enregistrée : même traitement.
  if (localStorage.getItem(LEGACY_RO) === "1") { Cloud.showLegacyRoNotice(); return; }
  // 4) Reprise de session.
  const savedRead = localStorage.getItem(READ_KEY);
  if (savedRead) { await Cloud.joinRead(savedRead); return; }
  const savedWs = localStorage.getItem(SPACE_KEY);
  if (savedWs) { await Cloud.join(savedWs); return; }
  status("local");
})();
