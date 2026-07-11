// Service worker — app installable + hors-ligne.
// Bump CACHE à chaque déploiement pour forcer le rafraîchissement du shell.
const CACHE = "pw-v4";
const IMG_CACHE = "pw-img-v1";
const SHELL = [
  "./", "index.html", "app.js", "style.css", "data.js",
  "pal-icons.js", "pal-elements.js", "firebase-sync.js", "icon.svg", "manifest.webmanifest",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k !== IMG_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Icônes de Pals (palworld.gg) : cache d'abord, mise en cache au vol (offline OK).
  if (url.hostname === "palworld.gg") {
    e.respondWith(caches.open(IMG_CACHE).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      try { const res = await fetch(req); if (res.ok) c.put(req, res.clone()); return res; }
      catch { return hit || Response.error(); }
    }));
    return;
  }

  // Firebase / gstatic / autres origines : réseau direct (données dynamiques).
  if (url.origin !== location.origin) return;

  // Shell même origine : réseau d'abord (frais en ligne), repli cache hors-ligne.
  e.respondWith(
    fetch(req)
      .then((res) => { if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone())); return res; })
      .catch(() => caches.match(req).then((hit) => hit || caches.match("index.html")))
  );
});
