# Suivi des gardiens USHL — installation

## Contenu
| Fichier | Rôle |
|---|---|
| `index.html` | L'interface (servie automatiquement à la racine de GitHub Pages) |
| `outil-limites.mjs` | Robot qui lit le classeur Excel des limites et écrit `limites.json` |
| `maj-limites.yml` | Workflow GitHub Actions qui exécute le robot automatiquement |
| `worker-proxy.js` | Proxy personnel Cloudflare (optionnel, solution B) |

## Solution A (recommandée) : robot GitHub Actions
Le classeur Excel des limites est lu **côté serveur** par GitHub, où il n'y a
ni barrière CORS ni proxys capricieux. Le robot écrit `limites.json` à côté de
l'interface, qui le lit alors localement — fiable à 100 %.

1. Dans ton dépôt GitHub Pages, place à la racine :
   `index.html` et `outil-limites.mjs`.
2. Place `maj-limites.yml` dans `.github/workflows/maj-limites.yml`.
3. Dans **Settings → Actions → General → Workflow permissions**, coche
   **Read and write permissions**.
4. Onglet **Actions** → « Mise à jour des limites de gardiens » →
   **Run workflow** pour la première exécution. Ensuite, il roule tout seul
   deux fois par jour.
5. Vérifie que `limites.json` est apparu à la racine du dépôt. C'est tout :
   l'interface le détecte automatiquement à chaque « Actualiser ».

En cas de pépin, le robot dépose aussi une copie brute des feuilles Excel dans
`debug-limites/` — utile pour diagnostiquer (ou pour me la montrer).

Tu peux aussi tester le robot sur ton ordinateur : `node outil-limites.mjs`
(Node 18+). Il crée `limites.json` dans le dossier courant.

## Solution B (optionnelle) : proxy personnel Cloudflare
Si tu préfères tout garder « en direct » sans robot :
1. Sur dash.cloudflare.com → **Workers** → crée un worker et colle
   `worker-proxy.js`.
2. Copie son adresse (ex. `https://ushl-proxy.toncompte.workers.dev`) dans le
   champ **Proxy personnel** du panneau « Sources de données » de l'interface,
   puis « Enregistrer les sources ».
3. Ce canal passe alors en premier pour toutes les requêtes (stats comprises),
   sans limite de débit. Le worker n'accepte que le domaine ushl.ca.

## Page admin
Le bouton **Admin** (en haut à droite) ouvre le panneau de gestion des liens
de sources de données — et rien d'autre. Identifiants : nom d'utilisateur en
majuscules, mot de passe fourni en privé. La session dure tant que l'onglet
est ouvert. À savoir : sur un site statique public comme GitHub Pages, cette
protection décourage les curieux (aucun identifiant n'est en clair dans le
code, seulement des empreintes SHA-256), mais elle n'équivaut pas à une
authentification serveur. Comme les sources modifiées ne sont enregistrées
que dans le navigateur de la personne qui les change, le risque réel est nul.

## Rappels
- Matchs joués = V + D + N, jamais la colonne GP.
- Les limites lues sont conservées 7 jours (elles sont fixes pour la saison).
- Dépannage express : panneau « Importer les limites par collage ».

## Alerte courriel de dépassement de limite
Le workflow envoie maintenant un courriel à `ushl_pro@hotmail.com` dès qu'un
gardien **dépasse** sa limite de matchs (MJ = V + D + N > limite). Le fichier
`alertes-envoyees.json`, commité par le robot, garantit qu'un gardien n'est
signalé qu'une seule fois — sauf si son écart augmente ensuite.

### Configuration (une seule fois)
1. Sur le compte expéditeur Gmail (`gardienushl@gmail.com`) :
   myaccount.google.com → **Sécurité** → active la **validation en deux
   étapes**, puis crée un **mot de passe d'application** (16 lettres).
   Le mot de passe régulier du compte ne fonctionne pas avec le robot.
2. Dans le dépôt GitHub : **Settings → Secrets and variables → Actions →
   New repository secret**, crée :
   - `MAIL_USERNAME` = `gardienushl@gmail.com`
   - `MAIL_PASSWORD` = le mot de passe d'application (16 lettres, sans espaces)
3. Remplace `outil-alertes.mjs` (nouveau) à la racine et
   `.github/workflows/maj-limites.yml` (mis à jour).
4. Test : onglet **Actions** → « Mise à jour des limites de gardiens » →
   **Run workflow**. S'il y a des dépassements non encore signalés, le
   courriel part immédiatement.

### Détails
- Vérification au même horaire que le robot des limites : 6 h et 18 h.
- Test local possible : `node outil-limites.mjs && node outil-alertes.mjs`.
- Pour repartir à zéro (re-signaler tous les dépassements), supprime
  `alertes-envoyees.json` du dépôt.
