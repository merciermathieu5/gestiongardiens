// =====================================================================
// outil-alertes.mjs — Robot d'alerte de dépassement de limite (USHL)
// Exécuté par GitHub Actions après outil-limites.mjs (ou en local :
// `node outil-alertes.mjs`, ou `STATS_FICHIER=fixture.html node ...`).
//
// 1. Lit la page des statistiques des gardiens (MJ = V + D + N, jamais GP).
// 2. Lit limites.json (produit par outil-limites.mjs juste avant).
// 3. Apparie gardiens et limites avec la même logique que l'interface.
// 4. Compare à alertes-envoyees.json : un gardien n'est signalé qu'une
//    fois, sauf si son écart augmente.
// 5. S'il y a du nouveau : écrit courriel-alerte.html et signale au
//    workflow (sorties `envoyer` et `objet`) d'expédier le courriel.
// Aucune dépendance.
// =====================================================================

import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";

const URL_STATS = process.env.URL_STATS ||
  "https://ushl.ca/ushl/menu_sim/USHL-pro/jamesishot/StatsGoalies.php?seasonId=&seasonType=PLF";
const FICHIER_LIMITES = process.env.FICHIER_LIMITES || "limites.json";
const FICHIER_ETAT = process.env.FICHIER_ETAT || "alertes-envoyees.json";
const FICHIER_COURRIEL = "courriel-alerte.html";

// ---------------------------------------------------------------- réseau
async function recuperer(url) {
  const rep = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; SuiviGardiensUSHL/1.0)" },
    redirect: "follow",
  });
  if (!rep.ok) throw new Error("HTTP " + rep.status + " pour " + url);
  const buffer = Buffer.from(await rep.arrayBuffer());
  let texte = buffer.toString("utf8");
  if (/\uFFFD|Ã[©¨´¢«»‰€]|â€™/.test(texte)) texte = buffer.toString("latin1");
  return texte;
}

// ------------------------------------------- HTML → texte (côté Node)
// Reproduit l'essentiel de innerText : cellules séparées par des espaces,
// rangées et blocs séparés par des sauts de ligne.
function texteDepuisHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(td|th)>/gi, " ")
    .replace(/<(br|\/tr|\/p|\/div|\/h[1-6]|\/pre|\/li|\/table)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&[a-z]+;/gi, " ");
}

// -------------------------------------------------- analyse des stats
// Copie fidèle de parseGardiens() de l'interface (index.html).
// Matchs joués = V + D + N — jamais la colonne GP.
function parseGardiens(texte) {
  const gardiens = [];
  const equipes = {};
  const lignes = texte.split(/\r?\n/);
  let dansGoaltending = false;
  for (const brut of lignes) {
    const ligne = brut.replace(/\u00a0/g, " ");
    if (/^\s*GOALTENDING\s*$/.test(ligne)) { dansGoaltending = true; continue; }
    if (/^\s*SCORING\s*$/.test(ligne)) { dansGoaltending = false; continue; }
    const tot = ligne.match(/^([A-Z][A-Z\.\-]+)\s+Totals\s+([A-Z]{1,4})\s/);
    if (tot) { equipes[tot[2]] = tot[1]; if (dansGoaltending) dansGoaltending = false; continue; }
    if (!dansGoaltending) continue;
    const tokens = ligne.trim().split(/\s+/);
    if (tokens.length < 15) continue;
    if (!/^\d+$/.test(tokens[0])) continue;
    const equipe = tokens[tokens.length - 13];
    if (!/^[A-Z]{1,4}$/.test(equipe)) continue;
    const nums = tokens.slice(-12); // GP MIN AVG W L T SO GA SA PCT PIM AS
    let partiesNom = tokens.slice(1, tokens.length - 13);
    let recrue = false;
    if (partiesNom[0] && partiesNom[0].startsWith("*")) {
      recrue = true;
      partiesNom[0] = partiesNom[0].slice(1);
      if (partiesNom[0] === "") partiesNom.shift();
    }
    const v = parseInt(nums[3], 10), d = parseInt(nums[4], 10), n = parseInt(nums[5], 10);
    if ([v, d, n].some(isNaN) || partiesNom.length === 0) continue;
    gardiens.push({ nom: partiesNom.join(" "), recrue, equipe, v, d, n, mj: v + d + n });
  }
  return { gardiens, equipes };
}

// ------------------------------------------- appariement des noms
// Copies fidèles de normaliserNom / decomposerNom / clesNom (index.html).
function normaliserNom(nom) {
  return String(nom)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}
function decomposerNom(nom) {
  let t = String(nom).replace(/\u00a0/g, " ").trim();
  if (t.includes(",")) {
    const [fam, pre] = t.split(",").map(s => s.trim());
    if (fam && pre) return { prenom: pre, famille: fam };
  }
  const mDot = t.match(/^([A-Za-zÀ-ÿ])\.\s*([A-Za-zÀ-ÿ'\-]{2,}(?:\s+[A-Za-zÀ-ÿ'\-]+)*)$/);
  if (mDot) return { prenom: mDot[1], famille: mDot[2] };
  const mots = t.split(/\s+/).filter(Boolean);
  if (mots.length >= 2) return { prenom: mots[0], famille: mots.slice(1).join(" ") };
  return { prenom: "", famille: t };
}
function clesNom(nom) {
  const { prenom, famille } = decomposerNom(nom);
  const cles = new Set();
  const complet = normaliserNom(prenom + famille);
  const inverse = normaliserNom(famille + prenom);
  if (complet.length > 2) { cles.add(complet); cles.add(inverse); }
  if (prenom && famille) cles.add(normaliserNom(prenom[0]) + normaliserNom(famille));
  return { cles: Array.from(cles), famille: normaliserNom(famille) };
}
function associerLimites(gardiens, limites) {
  const parCle = new Map();
  const parFamille = new Map();
  for (const lim of limites) {
    const { cles, famille } = clesNom(lim.nom);
    for (const c of cles) if (!parCle.has(c)) parCle.set(c, lim);
    if (famille) parFamille.set(famille, parFamille.has(famille) ? null : lim);
  }
  for (const g of gardiens) {
    const { cles, famille } = clesNom(g.nom);
    let lim = null;
    for (const c of cles) { if (parCle.has(c)) { lim = parCle.get(c); break; } }
    if (!lim && famille && parFamille.get(famille)) lim = parFamille.get(famille);
    g.limite = lim ? lim.limite : null;
  }
}

// ------------------------------------------------------- courriel HTML
function echapper(t) {
  return String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function construireCourriel(depassements, equipes, urlTableau) {
  const horodatage = new Intl.DateTimeFormat("fr-CA", {
    dateStyle: "long", timeStyle: "short", timeZone: "America/Toronto",
  }).format(new Date());
  const rangs = depassements.map(g => {
    const nomEquipe = equipes[g.equipe] || g.equipe;
    return '<tr>' +
      '<td style="padding:6px 10px;border-bottom:1px solid #e5e5e5;">' + echapper(g.nom) + '</td>' +
      '<td style="padding:6px 10px;border-bottom:1px solid #e5e5e5;">' + echapper(nomEquipe) + '</td>' +
      '<td style="padding:6px 10px;border-bottom:1px solid #e5e5e5;text-align:right;">' + g.mj + '</td>' +
      '<td style="padding:6px 10px;border-bottom:1px solid #e5e5e5;text-align:right;">' + g.limite + '</td>' +
      '<td style="padding:6px 10px;border-bottom:1px solid #e5e5e5;text-align:right;">' +
      '<span style="background:#fdecea;color:#a32d2d;padding:2px 8px;border-radius:6px;font-weight:bold;">+' +
      (g.mj - g.limite) + '</span></td></tr>';
  }).join("");
  const lienTableau = urlTableau
    ? '<p style="font-size:14px;">Tableau de bord complet : <a href="' + urlTableau + '">interface de suivi des gardiens</a></p>'
    : "";
  return '<div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;color:#1a1a1a;">' +
    '<p style="font-size:14px;">Salut,</p>' +
    '<p style="font-size:14px;">Le robot de suivi vient de vérifier les statistiques (matchs joués = V + D + N). ' +
    'Les gardiens suivants ont <strong style="color:#a32d2d;">dépassé leur limite d\'utilisation</strong> pour la saison Y21 :</p>' +
    '<table style="border-collapse:collapse;width:100%;font-size:13px;">' +
    '<tr style="border-bottom:2px solid #cccccc;">' +
    '<th style="text-align:left;padding:6px 10px;">Gardien</th>' +
    '<th style="text-align:left;padding:6px 10px;">Équipe</th>' +
    '<th style="text-align:right;padding:6px 10px;">MJ (V+D+N)</th>' +
    '<th style="text-align:right;padding:6px 10px;">Limite</th>' +
    '<th style="text-align:right;padding:6px 10px;">Écart</th></tr>' +
    rangs + '</table>' + lienTableau +
    '<p style="font-size:11px;color:#8a8a8a;">Courriel envoyé automatiquement par le workflow GitHub Actions le ' +
    echapper(horodatage) + ' (vérification deux fois par jour). ' +
    'Chaque gardien n\'est signalé qu\'une seule fois, sauf si son écart augmente.</p></div>';
}

// -------------------------------------------------------------- sorties
function sortieWorkflow(nom, valeur) {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, nom + "=" + valeur + "\n");
  }
}
function urlTableauDepuisDepot() {
  const depot = process.env.GITHUB_REPOSITORY; // ex. « mathieu/gestiongardiens »
  if (!depot) return "";
  const [proprio, nom] = depot.split("/");
  if (!proprio || !nom) return "";
  if (/\.github\.io$/i.test(nom)) return "https://" + nom + "/";
  return "https://" + proprio.toLowerCase() + ".github.io/" + nom + "/";
}

// ----------------------------------------------------------------- main
async function principal() {
  // 1) Statistiques (ou fixture locale pour les tests)
  let htmlStats;
  if (process.env.STATS_FICHIER) {
    htmlStats = readFileSync(process.env.STATS_FICHIER, "utf8");
    console.log("Stats lues depuis le fichier de test " + process.env.STATS_FICHIER);
  } else {
    htmlStats = await recuperer(URL_STATS);
    console.log("Stats récupérées (" + htmlStats.length + " caractères)");
  }
  const { gardiens, equipes } = parseGardiens(texteDepuisHtml(htmlStats));
  console.log(gardiens.length + " gardiens lus dans les statistiques.");
  if (gardiens.length === 0) throw new Error("Aucun gardien lu : structure de page inattendue.");

  // 2) Limites
  if (!existsSync(FICHIER_LIMITES)) throw new Error(FICHIER_LIMITES + " introuvable — exécuter outil-limites.mjs d'abord.");
  const limites = JSON.parse(readFileSync(FICHIER_LIMITES, "utf8")).limites || [];
  console.log(limites.length + " limites chargées.");
  associerLimites(gardiens, limites);

  // 3) Dépassements (MJ strictement supérieur à la limite)
  const depassements = gardiens
    .filter(g => g.limite !== null && g.mj > g.limite)
    .sort((a, b) => (b.mj - b.limite) - (a.mj - a.limite));
  console.log(depassements.length + " dépassement(s) au total.");

  // 4) État : ne signaler que le nouveau (nouveau gardien, ou écart accru)
  let etat = {};
  if (existsSync(FICHIER_ETAT)) {
    try { etat = JSON.parse(readFileSync(FICHIER_ETAT, "utf8")); } catch (e) { etat = {}; }
  }
  const nouveaux = depassements.filter(g => {
    const cle = normaliserNom(g.nom);
    const connu = etat[cle];
    return !connu || (g.mj - g.limite) > connu.ecart;
  });

  // 5) Mettre l'état à jour (retirer aussi ceux qui ne dépassent plus)
  const nouvelEtat = {};
  for (const g of depassements) {
    nouvelEtat[normaliserNom(g.nom)] = {
      nom: g.nom, ecart: g.mj - g.limite, date: new Date().toISOString(),
    };
  }
  writeFileSync(FICHIER_ETAT, JSON.stringify(nouvelEtat, null, 1), "utf8");

  if (nouveaux.length === 0) {
    console.log("Rien de nouveau à signaler : aucun courriel.");
    sortieWorkflow("envoyer", "false");
    return;
  }

  // 6) Courriel
  const objet = "🚨 USHL — " + nouveaux.length +
    (nouveaux.length > 1 ? " gardiens ont dépassé leur limite de matchs"
                         : " gardien a dépassé sa limite de matchs");
  writeFileSync(FICHIER_COURRIEL, construireCourriel(nouveaux, equipes, urlTableauDepuisDepot()), "utf8");
  sortieWorkflow("envoyer", "true");
  sortieWorkflow("objet", objet);
  console.log("Courriel préparé : " + objet);
  for (const g of nouveaux) console.log("  - " + g.nom + " (" + g.equipe + ") : " + g.mj + "/" + g.limite);
}

principal().catch(err => { console.error("ERREUR : " + err.message); process.exit(1); });
