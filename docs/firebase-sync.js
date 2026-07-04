// ===== Espaces partagés (Firebase Firestore) — module ES chargé après app.js =====
// Modèle : "privé par défaut". Les camps vivent en local (privé). On peut créer un
// "espace partagé" = document workspaces/{id} (id aléatoire non devinable) et n'en
// donner le lien qu'à son groupe. Rejoindre un espace n'écrase pas l'espace privé.
// L'URL est nettoyée après avoir rejoint (le lien de partage passe par le bouton dédié).
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, onSnapshot, setDoc, serverTimestamp,
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

const SPACE_KEY = "palworld-space";     // id de l'espace partagé actif
const LEGACY_WS = "palworld-ws";        // ancien nom de clé (migration)
let spaceId = null;                     // null = mode privé
let unsub = null;
let pushTimer = null;
let lastJson = null;                    // pour ignorer l'écho de nos propres écritures

function status(state, info) { window.setSyncUI?.(state, info || {}); }
function wsRef(id) { return doc(db, "workspaces", id); }
async function ensureAuth() { if (!auth.currentUser) await signInAnonymously(auth); }

function randomId() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 22);
}

// Lien de partage = URL de base + ?ws=<id> (jamais laissé dans la barre d'adresse).
function linkFor(id) {
  const u = new URL(location.href);
  u.search = ""; u.hash = "";
  u.searchParams.set("ws", id);
  return u.toString();
}
function stripWsFromUrl() {
  const u = new URL(location.href);
  if (u.searchParams.has("ws")) {
    u.searchParams.delete("ws");
    history.replaceState(null, "", u.pathname + (u.search || "") + u.hash);
  }
}

function subscribe(id) {
  if (unsub) unsub();
  unsub = onSnapshot(wsRef(id),
    snap => {
      if (!snap.exists()) { status("error", { msg: "espace introuvable" }); return; }
      const data = snap.data().store;
      if (!data) return;
      const json = JSON.stringify(data);
      if (json === lastJson) return;          // écho de notre propre écriture
      lastJson = json;
      window.applyRemoteStore?.(data);
    },
    err => status("error", { msg: err.code || err.message }),
  );
}

const Cloud = {
  mode: () => (spaceId ? "shared" : "local"),
  spaceId: () => spaceId,
  shareLink: () => (spaceId ? linkFor(spaceId) : null),

  // Crée un espace partagé à partir des camps actuels (l'espace privé reste intact).
  async createSharedSpace(seedStore) {
    try {
      status("connecting");
      await ensureAuth();
      const id = randomId();
      const json = JSON.stringify(seedStore);
      await setDoc(wsRef(id), { store: seedStore, updatedAt: serverTimestamp() });
      spaceId = id; lastJson = json;
      localStorage.setItem(SPACE_KEY, id);
      subscribe(id);
      status("shared", { spaceId: id, link: linkFor(id) });
    } catch (e) {
      spaceId = null;
      status("error", { msg: e.code || e.message });
    }
  },

  // Rejoint l'espace d'un ami (son contenu s'affichera à l'arrivée du snapshot).
  async join(id) {
    try {
      status("connecting");
      await ensureAuth();
      spaceId = id; lastJson = null;
      localStorage.setItem(SPACE_KEY, id);
      subscribe(id);
      status("shared", { spaceId: id, link: linkFor(id) });
    } catch (e) { status("error", { msg: e.code || e.message }); }
  },

  push(store) {
    if (!spaceId) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(async () => {
      try {
        lastJson = JSON.stringify(store);
        await setDoc(wsRef(spaceId), { store, updatedAt: serverTimestamp() });
      } catch (e) { status("error", { msg: e.code || e.message }); }
    }, 500);
  },

  // Quitte l'espace partagé et revient à l'espace privé (local à cet appareil).
  leave() {
    if (unsub) { unsub(); unsub = null; }
    spaceId = null; lastJson = null;
    localStorage.removeItem(SPACE_KEY);
    status("local");
    window.reloadLocalStore?.();
  },
};

window.PWCloud = Cloud;

// Démarrage : ?ws= dans l'URL (invitation) prioritaire, sinon espace mémorisé, sinon privé.
(async () => {
  const fromUrl = new URLSearchParams(location.search).get("ws");
  let saved = localStorage.getItem(SPACE_KEY) || localStorage.getItem(LEGACY_WS);
  if (localStorage.getItem(LEGACY_WS)) {                 // migration ancienne clé
    if (saved) localStorage.setItem(SPACE_KEY, saved);
    localStorage.removeItem(LEGACY_WS);
  }
  if (fromUrl) stripWsFromUrl();                         // on ne laisse pas le ws dans la barre
  const id = fromUrl || saved;
  if (id) await Cloud.join(id);
  else status("local");
})();
