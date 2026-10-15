# Suivi des gardiens USHL

L'interface affiche les 32 équipes avec leurs gardiens, leurs matchs joués
(V + D + N, jamais la colonne GP) et leur limite d'utilisation pour la saison.

Un robot GitHub Actions relève les données deux fois par jour, vers 8 h 20 et
18 h 20 (7 h 20 et 17 h 20 en hiver), et les dépose dans `data/gardiens.json`. L'interface lit ce fichier
dès l'ouverture, en même origine : aucun relais public, et ça fonctionne aussi
sur mobile. C'est le même principe que les interfaces de DG avec
`data/rosters.json`.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | L'interface (servie à la racine de GitHub Pages) |
| `data/gardiens.json` | Relevé produit par le robot (ne pas modifier à la main) |
| `limites.json` | Limites de la saison en cours, même format qu'avant : les interfaces de DG le lisent |
| `data/alertes-envoyees.json` | Alertes déjà envoyées (créé par le robot au premier dépassement) |
| `scripts/releve-gardiens.mjs` | Robot de relève |
| `scripts/alertes-gardiens.mjs` | Robot d'alerte courriel |
| `.github/workflows/releve-gardiens.yml` | Workflow qui fait tourner les deux robots |
| `valide.js`, `tests/fixtures/` | Banc d'essai (`npm test`) |
| `diagnostic/` | Copies brutes, déposées seulement si le classeur des limites est illisible |

## D'où viennent les données

1. **Gardiens par équipe** : le relevé quotidien des 32 alignements déjà
   produit par le dépôt des Sharks (`data/rosters.json`). Aucune requête de
   plus à ushl.ca.
2. **Matchs** : la page texte de la saison régulière, par exemple
   `USHL22TeamScoring.html` (blocs GOALTENDING). Le robot trouve seul la
   saison en cours : le jour où `USHL23TeamScoring.html` apparaît, il passe à
   Y23 et remet les compteurs à zéro.
3. **Limites** : le classeur Excel publié dans `gestion_gardiens/y22/`. Tant
   que le dossier de la saison n'existe pas, les limites sont « à venir » :
   le robot n'applique jamais celles d'une saison précédente. Le nom du
   fichier est lu dans l'index du dossier (il a déjà varié d'une année à
   l'autre).

## Garde-fous

- Page anti-robot ou panne : la relève échoue sans rien écrire, et un job de
  reprise réessaie cinq minutes plus tard sur un autre runner.
- Une page des matchs qui se vide en cours de saison n'efface pas les matchs
  déjà relevés.
- Une source momentanément inaccessible (alignements, dossier des limites) :
  les données précédentes de la même saison sont reprises et un avertissement
  apparaît dans l'interface.
- Un gardien échangé en cours de saison : ses matchs des deux équipes sont
  additionnés et l'interface le précise.
- L'interface avertit si le dernier relevé date de plus de 36 heures (robot
  arrêté, par exemple).

## Alertes courriel

- Un courriel part à `ushl_pro@hotmail.com` dès qu'un gardien dépasse sa
  limite (MJ > limite).
- Chaque gardien n'est signalé qu'une fois par saison, sauf si son écart
  augmente.
- L'état des alertes n'avance que si le courriel est vraiment parti. Si
  l'envoi échoue, le relevé est quand même publié et l'alerte est retentée au
  passage suivant (avertissement dans le résumé du workflow).

## Installation (une seule fois)

1. **Settings → Actions → General → Workflow permissions** : coche
   **Read and write permissions**.
2. **Settings → Secrets and variables → Actions** : les secrets
   `MAIL_USERNAME` (`gardienushl@gmail.com`) et `MAIL_PASSWORD` (mot de passe
   d'application Google, 16 lettres) doivent exister. Le mot de passe régulier
   du compte ne fonctionne pas avec le robot.
3. Onglet **Actions** → « Relève des gardiens USHL » → **Run workflow** pour
   le premier passage. Ensuite, il roule tout seul.

## Lancer une relève à la main

Onglet **Actions** → « Relève des gardiens USHL » → **Run workflow**, par
exemple juste après une simulation. Le panneau Admin de l'interface a un
lien direct vers cette page.

## Saisies dans l'interface

- Un clic sur la colonne **Limite** permet de saisir une limite à la main.
- Le panneau **Importer les limites par collage** accepte un tableau copié
  depuis la page de gestion des gardiens.
- Ces deux saisies restent dans le navigateur de la personne qui les fait et
  ont priorité sur les limites du robot. Elles n'influencent pas les alertes.

## Page admin

Le bouton **Admin** ouvre le panneau du robot : saison, date du dernier
relevé, sources, état des limites, lien pour lancer une relève et effacement
des limites saisies à la main. Identifiants inchangés. Sur un site statique,
cette protection décourage les curieux (aucun identifiant en clair, seulement
des empreintes SHA-256), sans équivaloir à une authentification serveur.

## Tester sur ton ordinateur

Dans PowerShell, à la racine du dépôt :

```powershell
npm install
npm test
```

Le banc d'essai n'utilise pas le réseau : les pages de la ligue sont
simulées à partir de fixtures réelles (feuille des limites Y21, relevé des
alignements du 14 octobre 2026, lignes de matchs Y21).

Pour une vraie relève locale (Node 20 ou plus) : `npm run releve`. La
variable `SAISON` force une saison au besoin, par exemple
`$env:SAISON = "22"; npm run releve`.
