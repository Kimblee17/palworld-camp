# Palworld — Assistant de camp

Application web pour gérer **plusieurs camps** Palworld : on y ajoute des Pals (qui
fournissent des compétences de travail) et des constructions (qui en requièrent),
puis on vérifie que chaque compétence requise est bien couverte.

Le site est **entièrement statique** (`docs/`) : c'est ce dossier qui est publié sur
GitHub Pages, et il n'y a aucun serveur applicatif à faire tourner. Les scripts Python
du dépôt servent uniquement à **construire les données** (`build_data.py` et les
`fetch_*.py`) ; ils n'ont besoin d'aucune dépendance en dehors de la bibliothèque
standard.

## Lancer en local

**Version statique (la plus simple)** — sers le dossier `docs/` :

```powershell
python -m http.server 5500 --directory docs
```

Puis ouvre **http://localhost:5500**.

> ⚠️ Le double-clic sur `docs/index.html` **ne fonctionne plus**. Le front est découpé en
> modules ES (`docs/js/*.js`), et les navigateurs refusent de charger des modules depuis
> `file://` (politique d'origine). Un simple serveur HTTP local suffit, comme ci-dessus.

Le code du front est organisé ainsi (aucun bundler, modules ES natifs) :

| Fichier | Rôle |
| --- | --- |
| `docs/js/main.js` | point d'entrée : initialisation, navigation, câblage des boutons |
| `docs/js/dataset.js` | données de référence (Pals, constructions, compétences) |
| `docs/js/state.js` | store, chargement/sauvegarde, quantités, annulation, export/import JSON |
| `docs/js/render.js` | listes, légende, récapitulatif, modale, agencement des bases |
| `docs/js/palpedia.js` | tableau Palpedia (tri et filtres) |
| `docs/js/drops.js` | recherche d'objet → Pals qui le lâchent |
| `docs/js/sav-import.js` | import d'une sauvegarde `.sav` et comparaison |
| `docs/js/suggest.js` | suggestion de composition depuis la boîte à Pals |

## Mettre en ligne sur GitHub Pages

Le site statique (`docs/`) est prêt à être publié. Une fois le dépôt poussé sur GitHub :

1. Crée un dépôt sur GitHub (ex. `palworld-camp`).
2. Pousse le code :
   ```powershell
   git remote add origin https://github.com/<ton-pseudo>/palworld-camp.git
   git branch -M main
   git push -u origin main
   ```
3. Sur GitHub : **Settings → Pages → Build and deployment → Source : _Deploy from a branch_**,
   choisis la branche **`main`** et le dossier **`/docs`**, puis **Save**.
4. Après ~1 minute, l'URL publique s'affiche :
   `https://<ton-pseudo>.github.io/palworld-camp/` — c'est le lien à partager. 🎉

> Chaque visiteur a ses propres camps (stockés dans son navigateur). Pour mettre à jour le
> site, modifie le code/les données, relance `python build_data.py` si besoin, puis
> `git commit` + `git push` : GitHub Pages se met à jour tout seul.

## Fonctionnalités

L'app a **trois vues**, accessibles via la bascule en haut à droite : **🏕️ Assistant de
camp** (gestion des camps), **📖 Palpedia** (référence de tous les Pals) et **💎 Drops**
(recherche d'objet → Pals qui le lâchent).

- **Plusieurs camps** : barre en haut pour créer / renommer / supprimer / changer de camp.
  Chaque camp garde ses Pals, ses constructions et sa limite. Tout est sauvegardé
  automatiquement dans le navigateur (localStorage).
- **Catalogue à onglets** : « 🐾 Pals » (227, recherche + filtre compétence + filtre
  🌙 nuit) et « 🏗️ Constructions » (69, recherche + filtre catégorie). Chaque Pal affiche
  son **rang Workers** (« Tier S/A/B/C/D », coloré) issu de la tier-list palworld.gg.
- **Palpedia** : tableau triable de tous les Pals (clic sur un en-tête) avec, par Pal :
  **niveau**, **rareté**, **taux de capture**, **compétences** et **rangs dans les 5
  tier-lists** (Global, Workers, Combat, Vol, Sol — vitesse pour les montures). Le nom
  renvoie à la fiche palworld.gg, et un lien mène au calculateur de capture.
- **Drops** : recherche d'un objet (parmi 91) ; pour chacun, la liste des Pals qui le
  lâchent avec **quantité** et **taux**, triés du taux le plus élevé au plus faible.
- **Exemplaires** : `+` pour ajouter, compteur `− [n] +` puis `×` pour retirer, aussi bien
  pour les Pals que pour les constructions.
- **Limite de Pals modifiable** par camp (défaut 15) ; les `+` se désactivent une fois atteinte.
- **Code couleur par niveau** : manquant (gris) · 1 faible (rouge) · 2 moyen (orange) ·
  3 fort (vert clair) · 4 très fort (vert).
- **Récapitulatif offre / demande** : pour chacune des 12 compétences, le nombre de Pals
  qui la fournissent (+ niveau max) **et** le nombre de constructions qui la requièrent.
  Une compétence requise mais fournie par aucun Pal est signalée en **rouge** (non couverte) ;
  un bandeau résume le nombre de compétences non couvertes.

## Mettre à jour les données

Les données viennent de `Liste pals.csv` et `palworld-structures.csv`, converties en
[`data/pals.json`](data/pals.json) et [`data/structures.json`](data/structures.json)
par le script `build_data.py`. Après avoir modifié un CSV :

```powershell
python build_data.py
```

`build_data.py` met aussi à jour la **version du cache du service worker**
(`docs/sw.js`) avec le hash git court du commit courant : plus besoin d'y penser à la
main, et les visiteurs ne restent jamais bloqués sur une version périmée du site.
Comme le hash est celui du commit **déjà** en place, l'enchaînement naturel est
`python build_data.py` puis `git commit` — le sw.js commité porte alors le hash du
commit précédent, ce qui suffit : la valeur change dès qu'un nouveau commit existe.

`build_data.py` fait tout en une commande : il lit les CSV **et** récupère depuis
[palworld.gg](https://palworld.gg) les rangs de tier-list, les données de jeu
(niveau, rareté, taux de capture) **et** les drops, puis fusionne le tout dans chaque Pal
de `data/pals.json`.

Tu peux aussi éditer directement les fichiers JSON.

### Rangs de tier-list (palworld.gg)

Les 5 onglets de tier-list du site sont extraits et fusionnés dans les Pals :
`Best Overall`, `Workers`, `Combat`, `Flying Mounts`, `Ground Mounts`.

- [`fetch_tier_lists.py`](fetch_tier_lists.py) télécharge et parse les pages (rendu Nuxt SSR,
  données dans le HTML), déduplique les Pals listés en double, et écrit un cache technique
  `data/tier-lists.json`.
- `build_data.py` appelle ce module : **téléchargement live**, écriture du cache, et **repli
  automatique sur le cache** si le réseau est indisponible (le build n'échoue jamais).
- Pour seulement rafraîchir le cache sans tout reconstruire : `python fetch_tier_lists.py`.

> `data/tier-lists.json` n'est qu'un cache intermédiaire : l'application ne lit que
> `data/pals.json` (et `docs/data.js`).

### Données de jeu (niveau, rareté, capture, stats)

- [`fetch_pal_data.py`](fetch_pal_data.py) récupère le dataset complet du jeu depuis les
  bundles JS du calculateur `palworld.gg/capture-rate` (noms de fichiers hashés découverts
  dynamiquement, bundle anglais sélectionné par couverture des noms), et écrit le cache
  technique `data/pal-data.json`.
- `build_data.py` fusionne ces données dans chaque Pal : `level` (niveau Alpha/suggéré,
  `1` pour les boss de raid sans spawn sauvage), `rarity` + `rarityCategory`
  (Common/Rare/Epic/Legendary), `captureRate` (multiplicateur, plus haut = plus facile)
  et `zukan` (n° de Paldeck).
- Même logique de **fetch live + repli sur cache** que les tier-lists. Rafraîchir seul :
  `python fetch_pal_data.py`.

### Drops (butin)

- [`fetch_pal_drops.py`](fetch_pal_drops.py) scrape la table de butin de chaque fiche
  **`palworld.gg/fr/pal/<slug>`** (version française → noms d'objets en FR ; repli sur la
  fiche par défaut pour les Pals non traduits, ex. collab Terraria), une requête par Pal en
  parallèle, et écrit le cache `data/pal-drops.json`. Les drops ne sont pas dans le dataset
  de jeu, d'où le scraping HTML. Échecs réseau fusionnés sur le cache (pas de perte).
- `build_data.py` fusionne la liste dans chaque Pal sous la clé `drops` (absente si le Pal
  n'a pas de table de drops, ex. boss de raid). Repli sur cache si réseau KO.
- Rafraîchir seul : `python fetch_pal_drops.py`.

### Format d'une construction (`data/structures.json`)

```json
{ "id": 4, "name": "Carrière de pierre", "category": "Production", "requires": ["mining"] }
```

`requires` liste les identifiants de compétences (voir tableau ci-dessous) requises par
la construction. Côté CSV (`palworld-structures.csv`), la colonne « Compétences requises »
contient les libellés français séparés par des virgules (ex. `Plantation, Arrosage, Récolte`).

### Format d'un Pal (`data/pals.json`)

```json
{
  "id": 105,
  "name": "Jetragon",
  "work": { "gathering": 3 },
  "nightWorker": false,
  "tiers": { "overall": "S", "workers": "C", "combat": "A", "flyingMount": "S", "groundMount": null },
  "mountSpeed": { "flying": "1700 - 3300" },
  "slug": "jetragon",
  "level": 60,
  "rarity": 20,
  "rarityCategory": "Legendary",
  "captureRate": 1.0,
  "zukan": 111,
  "drops": [{ "item": "Quartz pur", "amount": "10 - 10", "rate": "100%" }]
}
```

- `id` : identifiant **unique** (entier).
- `name` : nom affiché (sert à la recherche).
- `work` : niveaux de compétence. Indique **seulement** les compétences possédées
  (les absentes valent 0). Niveaux de 1 à 4.
- `slug`, `level`, `rarity`, `rarityCategory`, `captureRate`, `zukan` :
  données palworld.gg (voir « Données de jeu » ci-dessus). Absents pour les 2 Pals non
  présents sur palworld.gg (`Hartalis`, `Zoe & Grizzbolt`). `slug` sert au lien vers la fiche.
- `drops` : liste `{ item, amount, rate }` du butin (voir « Drops » ci-dessus). Absent si
  le Pal n'a pas de table de drops sur palworld.gg.
- `nightWorker` : `true` si travailleur de nuit, sinon `false`.
- `tiers` : rang dans chacun des 5 onglets de tier-list (`S`/`A`/`B`/`C`/`D`, ou `null`
  si le Pal n'y figure pas). Clés : `overall`, `workers`, `combat`, `flyingMount`,
  `groundMount`. Généré automatiquement (voir ci-dessous), pas depuis le CSV.
- `mountSpeed` *(optionnel)* : vitesse de monture, présent uniquement pour les montures.
  Clés possibles : `flying` et/ou `ground` (ex. `"1700 - 3300"`).

### Identifiants des 12 compétences (`work`) et colonne CSV correspondante

| id             | Compétence       | Colonne CSV     |
|----------------|------------------|-----------------|
| `farming`      | Élevage          | Élevage         |
| `electricity`  | Électricité      | Électricité     |
| `kindling`     | Allumage         | Allumage        |
| `gathering`    | Récolte          | Récolte         |
| `transporting` | Transport        | Transport       |
| `planting`     | Plantation       | Plantation      |
| `watering`     | Arrosage         | Arrosage        |
| `medicine`     | Médicaments      | Médicaments     |
| `handiwork`    | Travail manuel   | Travail manuel  |
| `mining`       | Minage           | Minage          |
| `lumbering`    | Bûcheronnage     | Bûcheronnage    |
| `cooling`      | Refroidissement  | Refroidissement |

> La colonne CSV « Travailleur de nuit » (`Oui`/`Non`) alimente le champ `nightWorker`.

> Les libellés et l'ordre d'affichage sont définis dans `build_data.py` (`WORK_TYPES`)
> si tu veux les ajuster.
