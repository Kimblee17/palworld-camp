# Palworld — Assistant de camp

Application web (Flask) pour gérer **plusieurs camps** Palworld : on y ajoute des
Pals (qui fournissent des compétences de travail) et des constructions (qui en
requièrent), puis on vérifie que chaque compétence requise est bien couverte.

L'application existe en **deux versions** qui partagent les mêmes données :

- **Statique** (`docs/`) — c'est elle qui est mise en ligne sur GitHub Pages. Aucune
  installation : il suffit d'ouvrir `docs/index.html` (double-clic) ou de servir le dossier.
- **Flask** (`app.py`) — version serveur, pratique en développement local.

## Lancer en local

**Version statique (la plus simple)** — ouvre directement `docs/index.html` dans ton
navigateur. Les données sont embarquées dans `docs/data.js`, rien d'autre n'est requis.

**Version Flask** :

```powershell
python -m venv venv
venv\Scripts\Activate.ps1
pip install -r requirements.txt
python app.py
```

Puis ouvre **http://localhost:5000**.

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

L'app a **deux vues**, accessibles via la bascule en haut à droite : **🏕️ Assistant de
camp** (gestion des camps) et **📖 Palpedia** (référence de tous les Pals).

- **Plusieurs camps** : barre en haut pour créer / renommer / supprimer / changer de camp.
  Chaque camp garde ses Pals, ses constructions et sa limite. Tout est sauvegardé
  automatiquement dans le navigateur (localStorage).
- **Catalogue à onglets** : « 🐾 Pals » (227, recherche + filtre compétence + filtre
  🌙 nuit) et « 🏗️ Constructions » (69, recherche + filtre catégorie). Chaque Pal affiche
  son **rang Workers** (« Tier S/A/B/C/D », coloré) issu de la tier-list palworld.gg.
- **Palpedia** : tableau de tous les Pals avec leurs compétences et leurs **rangs dans les
  5 tier-lists** (Global, Workers, Combat, Vol, Sol) ; la vitesse est indiquée pour les montures.
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

`build_data.py` fait tout en une commande : il lit les CSV **et** récupère les rangs de
tier-list depuis [palworld.gg](https://palworld.gg/tier-list/base-work), puis les fusionne
dans chaque Pal de `data/pals.json` (champs `tiers` et `mountSpeed`).

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
  "mountSpeed": { "flying": "1700 - 3300" }
}
```

- `id` : identifiant **unique** (entier).
- `name` : nom affiché (sert à la recherche).
- `work` : niveaux de compétence. Indique **seulement** les compétences possédées
  (les absentes valent 0). Niveaux de 1 à 4.
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

> Les libellés et l'ordre d'affichage sont définis dans `app.py` (`WORK_TYPES`)
> si tu veux les ajuster.
