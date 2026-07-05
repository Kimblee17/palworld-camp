// ===== Espaces partagés (Firebase Firestore) — module ES chargé après app.js =====
// Privé par défaut. Un "espace partagé" = document workspaces/{id} :
//   { store: {...}, updatedAt, presence: { cid: {name, ts, ro} } }
// - store poussé via updateDoc (remplace le champ store sans toucher à presence)
// - présence : heartbeat toutes les 15 s, lue dans le même snapshot
// - lien lecture seule : ?ws=<id>&ro=1  (édition désactivée côté app, pas de push)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, onSnapshot, setDoc, updateDoc, deleteField, serverTimestamp,
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

const SPACE_KEY = "palworld-space";
const LEGACY_WS = "palworld-ws";
const RO_KEY = "palworld-ro";
const CID_KEY = "palworld-cid";

let spaceId = null;
let readOnly = false;
let unsub = null;
let pushTimer = null;
let hbTimer = null;
let lastJson = null;

const cid = (() => {
  let c = localStorage.getItem(CID_KEY);
  if (!c) { c = Math.random().toString(36).slice(2, 10); localStorage.setItem(CID_KEY, c); }
  return c;
})();
function myName() {
  return (window.PW_NAME && window.PW_NAME()) || localStorage.getItem("palworld-name") || ("Invité-" + cid.slice(0, 4));
}

function status(state, info) { window.setSyncUI?.(state, info || {}); }
function wsRef(id) { return doc(db, "workspaces", id); }
async function ensureAuth() { if (!auth.currentUser) await signInAnonymously(auth); }

function randomId() {
  const a = new Uint8Array(16); crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 22);
}

function linkFor(id, ro) {
  const u = new URL(location.href);
  u.search = ""; u.hash = "";
  u.searchParams.set("ws", id);
  if (ro) u.searchParams.set("ro", "1");
  return u.toString();
}
function stripQueryFromUrl() {
  const u = new URL(location.href);
  if (u.searchParams.has("ws") || u.searchParams.has("ro")) {
    u.searchParams.delete("ws"); u.searchParams.delete("ro");
    history.replaceState(null, "", u.pathname + (u.search || "") + u.hash);
  }
}

// ----- Présence -----
async function beat() {
  if (!spaceId) return;
  try { await updateDoc(wsRef(spaceId), { ["presence." + cid]: { name: myName(), ts: Date.now(), ro: readOnly } }); }
  catch { /* doc peut-être supprimé */ }
}
function startHeartbeat() { stopHeartbeat(); beat(); hbTimer = setInterval(beat, 15000); }
function stopHeartbeat() { if (hbTimer) { clearInterval(hbTimer); hbTimer = null; } }
async function dropPresence() {
  try { await updateDoc(wsRef(spaceId), { ["presence." + cid]: deleteField() }); } catch { /* ignore */ }
}
function readPresence(snap) {
  const p = (snap.data() && snap.data().presence) || {};
  const now = Date.now();
  const list = Object.entries(p)
    .filter(([, v]) => v && now - (v.ts || 0) < 45000)
    .map(([id, v]) => ({ id, name: v.name || "?", ro: !!v.ro, me: id === cid }))
    .sort((a, b) => a.name.localeCompare(b.name, "fr"));
  window.setPresence?.(list);
}

function subscribe(id) {
  if (unsub) unsub();
  unsub = onSnapshot(wsRef(id),
    snap => {
      if (!snap.exists()) { status("error", { msg: "espace introuvable" }); return; }
      readPresence(snap);
      const data = snap.data().store;
      if (!data) return;
      const json = JSON.stringify(data);
      if (json === lastJson) return;
      lastJson = json;
      window.applyRemoteStore?.(data);
    },
    err => status("error", { msg: err.code || err.message }),
  );
}

function enterSpace(id, ro) {
  spaceId = id; readOnly = ro;
  localStorage.setItem(SPACE_KEY, id);
  if (ro) localStorage.setItem(RO_KEY, "1"); else localStorage.removeItem(RO_KEY);
  window.setReadOnly?.(ro);
  subscribe(id);
  startHeartbeat();
  status("shared", { spaceId: id, ro, link: linkFor(id), roLink: linkFor(id, true) });
}

const Cloud = {
  mode: () => (spaceId ? "shared" : "local"),
  spaceId: () => spaceId,
  isReadOnly: () => readOnly,
  shareLink: (ro) => (spaceId ? linkFor(spaceId, ro) : null),

  async createSharedSpace(seedStore) {
    try {
      status("connecting");
      await ensureAuth();
      const id = randomId();
      lastJson = JSON.stringify(seedStore);
      await setDoc(wsRef(id), { store: seedStore, updatedAt: serverTimestamp() });
      enterSpace(id, false);
    } catch (e) { spaceId = null; status("error", { msg: e.code || e.message }); }
  },

  async join(id, ro) {
    try {
      status("connecting");
      await ensureAuth();
      lastJson = null;
      enterSpace(id, !!ro);
    } catch (e) { status("error", { msg: e.code || e.message }); }
  },

  push(store) {
    if (!spaceId || readOnly) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(async () => {
      try {
        lastJson = JSON.stringify(store);
        await updateDoc(wsRef(spaceId), { store, updatedAt: serverTimestamp() });
      } catch (e) { status("error", { msg: e.code || e.message }); }
    }, 500);
  },

  leave() {
    stopHeartbeat();
    if (spaceId) dropPresence();
    if (unsub) { unsub(); unsub = null; }
    spaceId = null; readOnly = false; lastJson = null;
    localStorage.removeItem(SPACE_KEY); localStorage.removeItem(RO_KEY);
    window.setReadOnly?.(false);
    window.setPresence?.([]);
    status("local");
    window.reloadLocalStore?.();
  },
};

window.PWCloud = Cloud;
window.addEventListener("beforeunload", () => { if (spaceId) dropPresence(); });

(async () => {
  const usp = new URLSearchParams(location.search);
  const fromUrl = usp.get("ws");
  const roUrl = usp.get("ro") === "1";
  let saved = localStorage.getItem(SPACE_KEY) || localStorage.getItem(LEGACY_WS);
  if (localStorage.getItem(LEGACY_WS)) {
    if (saved) localStorage.setItem(SPACE_KEY, saved);
    localStorage.removeItem(LEGACY_WS);
  }
  if (fromUrl) stripQueryFromUrl();
  const id = fromUrl || saved;
  const ro = fromUrl ? roUrl : (localStorage.getItem(RO_KEY) === "1");
  if (id) await Cloud.join(id, ro);
  else status("local");
})();
