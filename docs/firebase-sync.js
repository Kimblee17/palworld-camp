// ===== Synchro cloud (Firebase Firestore) — module ES chargé après app.js =====
// Chaque "espace" = document workspaces/{id} contenant tout le store (camps + boîte).
// Identifiant de partage aléatoire (sécurité par lien difficile à deviner).
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

const WS_KEY = "palworld-ws";
let wsId = null;
let unsub = null;
let pushTimer = null;
let lastJson = null;   // dernière donnée écrite/reçue, pour ignorer notre propre echo

function status(state, info) { window.setSyncUI?.(state, info || {}); }
function wsRef(id) { return doc(db, "workspaces", id); }

async function ensureAuth() {
  if (!auth.currentUser) await signInAnonymously(auth);
}

function randomId() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 22);
}

function setUrl(id) {
  const u = new URL(location.href);
  if (id) u.searchParams.set("ws", id); else u.searchParams.delete("ws");
  history.replaceState(null, "", u.toString());
}
function currentLink() {
  if (!wsId) return null;
  const u = new URL(location.href);
  u.searchParams.set("ws", wsId);
  u.hash = "";
  return u.toString();
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
  isSynced: () => !!wsId,

  async enable(store) {
    try {
      status("connecting");
      await ensureAuth();
      const id = randomId();                       // pas encore "engagé"
      const json = JSON.stringify(store);
      await setDoc(wsRef(id), { store, updatedAt: serverTimestamp() });
      wsId = id; lastJson = json;                  // succès : on engage l'espace
      localStorage.setItem(WS_KEY, wsId);
      setUrl(wsId);
      subscribe(wsId);
      status("synced", { wsId, link: currentLink() });
    } catch (e) {
      wsId = null;                                 // échec : on ne reste pas à moitié synchronisé
      status("error", { msg: e.code || e.message });
    }
  },

  async join(id) {
    try {
      status("connecting");
      await ensureAuth();
      wsId = id;
      localStorage.setItem(WS_KEY, wsId);
      setUrl(wsId);
      subscribe(wsId);
      status("synced", { wsId, link: currentLink() });
    } catch (e) { status("error", { msg: e.code || e.message }); }
  },

  push(store) {
    if (!wsId) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(async () => {
      try {
        lastJson = JSON.stringify(store);
        await setDoc(wsRef(wsId), { store, updatedAt: serverTimestamp() });
      } catch (e) { status("error", { msg: e.code || e.message }); }
    }, 500);
  },

  leave() {
    if (unsub) { unsub(); unsub = null; }
    wsId = null; lastJson = null;
    localStorage.removeItem(WS_KEY);
    setUrl(null);
    status("local");
  },
};

window.PWCloud = Cloud;

// Démarrage : rejoindre l'espace indiqué par l'URL (?ws=) ou mémorisé localement.
(async () => {
  const fromUrl = new URLSearchParams(location.search).get("ws");
  const saved = localStorage.getItem(WS_KEY);
  const id = fromUrl || saved;
  if (id) await Cloud.join(id);
  else status("local");
})();
