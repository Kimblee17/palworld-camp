// ===== Carte des points d'apparition =====
//
// ⚠ AUCUN ASSET DU JEU. Le littoral n'est pas une image : c'est une grille de densité
// calculée à partir des 73 000 positions d'apparition et des 13 755 repères de
// ressources. Pals et ressources n'existant que sur la terre ferme, leur nuage en
// dessine le contour. Les tuiles de paldb.cc, elles, sont la texture de carte extraite
// du jeu — les republier reviendrait à redistribuer l'œuvre de Pocketpair.
//
// Les données vivent hors de data.js, dans data/spawns.json (301 Ko compressés) :
// elles ne ralentissent donc pas le démarrage. Chargement à la PREMIÈRE ouverture
// d'une carte, puis gardées en mémoire — la fiche d'un Pal s'ouvre souvent, il serait
// absurde de retélécharger à chaque fois. Le service worker les précache par ailleurs,
// pour que la carte survive hors ligne.

const URL_DONNEES = "data/spawns.json";

// Tuiles de paldb.cc, avec l'accord de son auteur (u/chuanhsing) pour un usage
// PERSONNEL ET NON COMMERCIAL. Cet accord porte sur son hébergement, pas sur une
// licence : la texture reste l'œuvre de Pocketpair. Si ce site devenait commercial,
// ces trois lignes sont à retirer — le fond reconstitué ci-dessous suffit à tourner
// sans elles, c'est justement pourquoi il reste là.
const TUILES = "https://cdn.paldb.cc/image/map8/z{z}x{x}y{y}.webp";
const ZOOM = 2;             // 4×4 tuiles de 512 px = 2048 px, 229 Ko, une seule fois
const COTE = 512 * 2 ** ZOOM;

let DONNEES = null;
let chargement = null;
let fond = null;            // littoral reconstitué, repli hors ligne
let tuiles = null;          // fond photographique, null tant qu'il n'est pas prêt
let tuilesEnCours = null;

export function chargerCarte() {
  if (DONNEES) return Promise.resolve(DONNEES);
  if (!chargement) {
    chargement = fetch(URL_DONNEES)
      .then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(d => (DONNEES = d))
      .catch(err => { chargement = null; throw err; });
  }
  return chargement;
}

// Le littoral ne dépend pas du Pal affiché : on le peint une fois, à la résolution de
// la grille, et on l'agrandit ensuite avec lissage. Peindre 32 000 cellules à chaque
// ouverture de fiche serait du gaspillage pur.
function fondLittoral(d) {
  if (fond) return fond;
  const G = d.grille;
  fond = document.createElement("canvas");
  fond.width = fond.height = G;
  const g = fond.getContext("2d");
  const img = g.createImageData(G, G);
  for (let i = 0; i < d.terre.length; i += 3) {
    const r = d.terre[i], c = d.terre[i + 1], v = d.terre[i + 2];
    const k = (r * G + c) * 4;
    img.data[k] = 116; img.data[k + 1] = 136; img.data[k + 2] = 170;
    img.data[k + 3] = Math.min(255, (0.34 + v * 0.11) * 255);
  }
  g.putImageData(img, 0, 0);
  return fond;
}

// Le fond photographique : 16 tuiles assemblées une fois dans un canevas hors écran.
// Le CDN ne renvoie pas d'en-tête CORS, donc ce canevas est « teinté » — on peut y
// dessiner, pas en relire les pixels. Aucun code d'affichage n'en a besoin.
//
// Hors ligne, ces requêtes échouent : c'est prévu, on retombe alors sur le littoral
// reconstitué, qui lui est précaché. La carte ne disparaît jamais, elle se dégrade.
function chargerTuiles() {
  if (tuiles) return Promise.resolve(tuiles);
  if (tuilesEnCours) return tuilesEnCours;
  const n = 2 ** ZOOM;
  const cv = document.createElement("canvas");
  cv.width = cv.height = COTE;
  const g = cv.getContext("2d");
  const une = (x, y) => new Promise((ok, ko) => {
    const im = new Image();
    im.onload = () => { g.drawImage(im, x * 512, y * 512); ok(); };
    im.onerror = ko;
    im.src = TUILES.replace("{z}", ZOOM).replace("{x}", x).replace("{y}", y);
  });
  const toutes = [];
  for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) toutes.push(une(x, y));
  tuilesEnCours = Promise.all(toutes)
    .then(() => (tuiles = cv))
    .catch(() => { tuilesEnCours = null; return null; });
  return tuilesEnCours;
}

export const fondPhoto = () => !!tuiles;

const points = (d, nom, nuit) => {
  const s = d.spawns[nom];
  if (!s) return null;
  return (nuit && s.n) ? s.n : s.j;
};

// Une espèce peut avoir des zones de nuit distinctes : 38 en ont, et ce sont les
// nocturnes. L'interface ne propose la bascule que dans ce cas.
export const aZonesDeNuit = (d, nom) => !!(d.spawns[nom] && d.spawns[nom].n);

// Chez plusieurs nocturnes, la liste de JOUR est vide : ouvrir sur le jour montrerait
// une carte déserte et laisserait croire que le Pal est introuvable. On part donc sur
// l'heure où il y a quelque chose à voir.
export function heureParDefaut(d, nom) {
  const s = d.spawns[nom];
  return !!(s && s.n && s.n.length && !s.j.length);
}

// Étiquettes de régions : on refuse celles qui chevauchent une voisine déjà posée.
// Quatre-vingts noms sur une carte de 300 px sont illisibles ; mieux vaut en montrer
// vingt et pouvoir les lire. Le nombre réellement affiché est renvoyé pour que
// l'interface puisse le dire plutôt que de laisser croire qu'il n'y a que ça.
function etiquettes(g, d, T, avecNiveaux) {
  g.font = "11px 'Segoe UI',system-ui,sans-serif";
  g.textAlign = "center";
  const prises = [];
  // Les noms français sont nettement plus longs que les anglais (« Archipel de la
  // Brise salée » contre « Sea Breeze Archipelago »). La coupe suit donc la taille du
  // canevas : serrée dans la vignette de la fiche, généreuse en plein écran.
  const max = T > 600 ? 42 : 24;
  for (const R of [...d.regions].sort((a, b) => a.nom.length - b.nom.length)) {
    const x = R.p[0] / 10000 * T, y = R.p[1] / 10000 * T;
    const t = R.nom.length > max ? R.nom.slice(0, max - 1) + "…" : R.nom;
    const w = g.measureText(t).width;
    const b = [x - w / 2 - 3, y - 9, w + 6, 18];
    if (prises.some(p => b[0] < p[0] + p[2] && b[0] + b[2] > p[0]
                      && b[1] < p[1] + p[3] && b[1] + b[3] > p[1])) continue;
    prises.push(b);
    g.fillStyle = "rgba(11,14,19,.72)";
    g.fillRect(b[0], b[1], b[2], b[3]);
    g.fillStyle = "rgba(190,201,219,.95)";
    g.fillText(t, x, y + 4);
    if (avecNiveaux && R.niveaux) {
      g.font = "9px 'Segoe UI',system-ui,sans-serif";
      g.fillStyle = "rgba(255,194,75,.9)";
      g.fillText("Niv. " + R.niveaux, x, y + 15);
      g.font = "11px 'Segoe UI',system-ui,sans-serif";
    }
  }
  return prises.length;
}

/** Peint la carte d'un Pal. Renvoie de quoi rédiger la légende. */
export function dessinerCarte(canvas, nom, { nuit = false, noms = false } = {}) {
  const d = DONNEES;
  if (!d) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const T = canvas.clientWidth || 300;
  canvas.width = canvas.height = Math.round(T * dpr);
  const g = canvas.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, T, T);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  // Le relief quand on l'a, le littoral reconstitué sinon. Les deux couvrent
  // exactement la même étendue : les coordonnées relatives ne changent pas.
  g.drawImage(tuiles || fondLittoral(d), 0, 0, T, T);

  const pts = points(d, nom, nuit) || [];
  // Halo large puis point net : la zone se repère de loin, la position se lit de près.
  const rayon = Math.max(5, T / 42);
  g.fillStyle = "rgba(201,242,78,.13)";
  for (let i = 0; i < pts.length; i += 2) {
    g.beginPath();
    g.arc(pts[i] / 10000 * T, pts[i + 1] / 10000 * T, rayon, 0, 6.284);
    g.fill();
  }
  g.fillStyle = "rgba(216,255,110,.95)";
  const r2 = Math.max(1.6, T / 190);
  for (let i = 0; i < pts.length; i += 2) {
    g.beginPath();
    g.arc(pts[i] / 10000 * T, pts[i + 1] / 10000 * T, r2, 0, 6.284);
    g.fill();
  }

  const boss = d.boss.filter(b => b.nom === nom);
  for (const b of boss) {
    const x = b.p[0] / 10000 * T, y = b.p[1] / 10000 * T;
    g.beginPath();
    g.arc(x, y, Math.max(4, T / 70), 0, 6.284);
    g.fillStyle = b.nuit ? "#9a86ff" : "#ff6b5e";
    g.fill();
    g.strokeStyle = "rgba(0,0,0,.7)";
    g.lineWidth = 1.5;
    g.stroke();
  }

  const nbNoms = noms ? etiquettes(g, d, T, true) : 0;
  const s = d.spawns[nom];
  return { nb: pts.length / 2, boss, nbNoms, total: d.regions.length,
           inconnu: !s,
           // Vide *à cette heure-là* seulement : la bascule mène ailleurs.
           videIci: !!s && !pts.length && !!(s.j.length || (s.n && s.n.length)) };
}

// Trois situations à ne pas confondre, et c'est la nuance qui rend la légende utile :
// des apparitions à cette heure, aucune À CETTE HEURE mais d'autres à l'opposé, ou
// aucune du tout — auquel cas seul un boss peut rester. Les boss sont toujours cités,
// y compris pour les 21 espèces que la source ne référence pas (Jetragon en fait
// partie : sans cela sa carte n'annonçait rien alors qu'elle montrait un point).
function legende({ nb, boss, inconnu, videIci }, nom, nuit) {
  const l = [];
  if (nb) {
    l.push(`<b>${nb}</b> point${nb > 1 ? "s" : ""} d'apparition${nuit ? " la nuit" : ""}`);
  } else if (videIci) {
    l.push(`<span class="cm-warn">Aucune apparition ${nuit ? "la nuit" : "le jour"} — voir l'autre créneau.</span>`);
  } else if (inconnu) {
    l.push(boss.length
      ? `Aucune apparition sauvage référencée : ce Pal ne se rencontre qu'en boss.`
      : `<span class="cm-warn">Aucune donnée d'apparition pour ${nom}.</span>`);
  } else {
    l.push(`<span class="cm-warn">Aucune apparition sauvage : ce Pal ne se rencontre qu'en boss.</span>`);
  }
  for (const b of boss)
    l.push(`<span class="cm-boss${b.nuit ? " nuit" : ""}"></span>Boss de terrain, niv. ${b.niveau}${b.nuit ? " — la nuit" : ""}`);
  // Attribution due : le relief vient de paldb, avec l'accord de son auteur. Quand
  // elle manque, c'est le fond reconstitué qui est à l'écran, et le dire évite de
  // laisser croire à une carte incomplète.
  l.push(fondPhoto()
    ? `<span class="cm-muted">Fond de carte : <a href="https://paldb.cc/en/Map" target="_blank" rel="noopener">paldb.cc</a></span>`
    : `<span class="cm-muted">Fond reconstitué à partir des coordonnées (relief indisponible hors ligne)</span>`);
  return l.join("<br>");
}

// ===== Bloc inséré dans la fiche d'un Pal =====

export function insererCarte(hote, pal) {
  hote.innerHTML = `<div class="cm-attente">Chargement de la carte…</div>`;
  chargerCarte().then(d => {
    if (hote.dataset.pal !== pal.name) return;      // la fiche a changé entre-temps
    const nuitDispo = aZonesDeNuit(d, pal.name);
    let nuit = heureParDefaut(d, pal.name);
    hote.innerHTML = `
      <div class="cm-wrap">
        <canvas class="cm-canvas" role="img"
                aria-label="Carte des points d'apparition de ${pal.name}"></canvas>
        <button type="button" class="cm-zoom" aria-label="Agrandir la carte de ${pal.name}">
          <span aria-hidden="true">🔍</span>
        </button>
      </div>
      ${nuitDispo ? `<div class="cm-heure">
        <button type="button" class="cm-h${nuit ? "" : " on"}" data-nuit="0">☀ Jour</button>
        <button type="button" class="cm-h${nuit ? " on" : ""}" data-nuit="1">🌙 Nuit</button>
      </div>` : ""}
      <div class="cm-legende"></div>`;
    const canvas = hote.querySelector(".cm-canvas");
    const peindre = n => {
      const info = dessinerCarte(canvas, pal.name, { nuit: n });
      hote.querySelector(".cm-legende").innerHTML = legende(info, pal.name, n);
    };
    peindre(nuit);
    // Les tuiles arrivent après coup : on repeint quand elles sont là plutôt que de
    // faire attendre devant un cadre vide. La carte est utilisable entre-temps.
    chargerTuiles().then(t => { if (t && hote.dataset.pal === pal.name) peindre(nuit); });
    hote.querySelector(".cm-zoom").onclick = () => ouvrirPleinEcran(pal, nuit);
    hote.querySelectorAll(".cm-h").forEach(b => b.onclick = () => {
      nuit = b.dataset.nuit === "1";
      hote.querySelectorAll(".cm-h").forEach(x => x.classList.toggle("on", x === b));
      peindre(nuit);
    });
  }).catch(() => {
    hote.innerHTML = `<div class="cm-attente cm-warn">Carte indisponible (hors ligne ?).</div>`;
  });
}

// ===== Plein écran =====

let retourFocus = null;

export function ouvrirPleinEcran(pal, nuit = false) {
  const ov = document.getElementById("carte-plein");
  if (!ov || !DONNEES) return;
  retourFocus = document.activeElement;
  ov.querySelector(".cp-titre").textContent = pal.name;
  const nuitDispo = aZonesDeNuit(DONNEES, pal.name);
  const barre = ov.querySelector(".cp-heure");
  barre.hidden = !nuitDispo;
  barre.innerHTML = nuitDispo ? `
    <button type="button" class="cm-h${nuit ? "" : " on"}" data-nuit="0">☀ Jour</button>
    <button type="button" class="cm-h${nuit ? " on" : ""}" data-nuit="1">🌙 Nuit</button>` : "";
  ov.hidden = false;

  const canvas = ov.querySelector(".cp-canvas");
  const peindre = n => {
    // Le canevas est carré et tient dans la plus petite dimension de la fenêtre. La
    // réserve verticale couvre la barre de titre ET les quatre lignes que la légende
    // peut atteindre (points, boss, attribution, régions nommées) : sous-estimer la
    // légende la faisait sortir de l'écran.
    const c = Math.min(ov.clientWidth - 32, ov.clientHeight - 190);
    canvas.style.width = canvas.style.height = Math.max(240, c) + "px";
    const info = dessinerCarte(canvas, pal.name, { nuit: n, noms: true });
    ov.querySelector(".cp-legende").innerHTML = legende(info, pal.name, n)
      + (info.nbNoms ? `<br><span class="cm-muted">${info.nbNoms} régions nommées sur ${info.total} — les autres se chevaucheraient</span>` : "");
  };
  peindre(nuit);
  chargerTuiles().then(t => { if (t && !ov.hidden) peindre(nuit); });
  barre.querySelectorAll(".cm-h").forEach(b => b.onclick = () => {
    barre.querySelectorAll(".cm-h").forEach(x => x.classList.toggle("on", x === b));
    peindre(b.dataset.nuit === "1");
  });
  ov.__repeindre = () => peindre(barre.querySelector(".cm-h.on")?.dataset.nuit === "1");
  ov.querySelector(".cp-close").focus();
}

export function fermerPleinEcran() {
  const ov = document.getElementById("carte-plein");
  if (!ov || ov.hidden) return false;
  ov.hidden = true;
  ov.__repeindre = null;
  retourFocus?.focus?.();
  retourFocus = null;
  return true;
}

export function initCarte() {
  const ov = document.getElementById("carte-plein");
  if (!ov) return;
  ov.querySelector(".cp-close").addEventListener("click", fermerPleinEcran);
  ov.querySelector(".cp-backdrop").addEventListener("click", fermerPleinEcran);
  // Échap en phase de CAPTURE : le plein écran est au-dessus de la fiche, il doit se
  // fermer le premier. Sans cela, la même touche fermerait les deux d'un coup.
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && !ov.hidden) { fermerPleinEcran(); e.stopPropagation(); }
  }, true);
  window.addEventListener("resize", () => { if (!ov.hidden) ov.__repeindre?.(); });
}
