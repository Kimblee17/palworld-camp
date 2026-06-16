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

- **Plusieurs camps** : barre en haut pour créer / renommer / supprimer / changer de camp.
  Chaque camp garde ses Pals, ses constructions et sa limite. Tout est sauvegardé
  automatiquement dans le navigateur (localStorage).
- **Catalogue à onglets** : « 🐾 Pals » (227, recherche + filtre compétence + filtre
  🌙 nuit) et « 🏗️ Constructions » (69, recherche + filtre catégorie).
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

Tu peux aussi éditer directement les fichiers JSON.

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
  "id": 11,
  "name": "Anubis",
  "work": { "handiwork": 3, "mining": 4, "transporting": 2 },
  "nightWorker": false
}
```

- `id` : identifiant **unique** (entier).
- `name` : nom affiché (sert à la recherche).
- `work` : niveaux de compétence. Indique **seulement** les compétences possédées
  (les absentes valent 0). Niveaux de 1 à 4.
- `nightWorker` : `true` si travailleur de nuit, sinon `false`.

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
