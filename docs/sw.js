// Service worker — app installable + hors-ligne.
// Bump CACHE à chaque déploiement pour forcer le rafraîchissement du shell.
const CACHE = "pw-d88655d";
// Les icônes de Pals (icons/pals/*.png) sont désormais auto-hébergées : elles passent
// par le cache same-origin ci-dessous, au fil de la navigation. Elles ne sont PAS
// précachées ici — ~300 fichiers rendraient l'installation du service worker trop lourde.
const SHELL = [
  "./", "index.html", "style.css", "data.js",
  "js/main.js", "js/dataset.js", "js/state.js", "js/render.js", "js/palpedia.js",
  "js/drops.js", "js/sav-import.js", "js/suggest.js", "js/breeding.js", "js/production.js",
  "js/share.js", "js/notes.js", "js/passives.js",
  "firebase-sync.js", "icon.svg", "manifest.webmanifest",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Firebase / gstatic / autres origines : réseau direct (données dynamiques).
  if (url.origin !== location.origin) return;

  // Shell même origine : réseau d'abord (frais en ligne), repli cache hors-ligne.
  e.respondWith(
    fetch(req)
      .then((res) => { if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone())); return res; })
      .catch(() => caches.match(req).then((hit) => hit || caches.match("index.html")))
  );
});
