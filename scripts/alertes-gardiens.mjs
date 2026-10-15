#!/usr/bin/env node
/**
 * Alerte courriel de dépassement de limite (USHL).
 *
 * Lit data/gardiens.json, produit juste avant par releve-gardiens.mjs : mêmes
 * données que l'interface, donc mêmes matchs joués (V + D + N, jamais GP) et
 * mêmes limites. Un gardien dépasse quand MJ > limite.
 *
 * Un gardien n'est signalé qu'une fois par saison, sauf si son écart augmente.
 * L'état des alertes déjà envoyées (data/alertes-envoyees.json) n'avance
 * qu'une fois le courriel parti : le script dépose un état « candidat » que
 * le workflow met en place seulement si l'envoi réussit. Sinon, l'alerte est
 * retentée au passage suivant.
 *
 * Sorties pour le workflow (GITHUB_OUTPUT) : envoyer=true|false, objet=...
 * Fichiers de travail (non commités) : courriel-alerte.html, alertes-etat-candidat.json
 *
 * Usage : node scripts/alertes-gardiens.mjs
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { normaliserNom, FICHIER_GARDIENS } from './releve-gardiens.mjs';

export const FICHIER_ETAT = 'data/alertes-envoyees.json';
export const FICHIER_CANDIDAT = 'alertes-etat-candidat.json';
export const FICHIER_COURRIEL = 'courriel-alerte.html';

/** Tous les gardiens du relevé, avec le nom de leur équipe. */
export function tousLesGardiens(donnees) {
  const liste = [];
  for (const e of donnees.equipes || []) for (const g of e.gardiens || []) liste.push({ ...g, equipe: e.nom || e.code });
  for (const g of donnees.autres || []) liste.push({ ...g, equipe: g.equipeStats || '?' });
  return liste;
}

/**
 * Compare le relevé à l'état des alertes déjà envoyées.
 * Renvoie {depassements, nouveaux, nouvelEtat}. Un changement de saison remet
 * l'état à zéro.
 */
export function evaluerAlertes(donnees, etatPrecedent, maintenant = new Date()) {
  const saison = donnees.saison;
  const connus = etatPrecedent && etatPrecedent.saison === saison ? (etatPrecedent.gardiens || {}) : {};
  const depassements = tousLesGardiens(donnees)
    .filter(g => Number.isFinite(g.limite) && Number.isFinite(g.mj) && g.mj > g.limite)
    .map(g => ({ ...g, ecart: g.mj - g.limite }))
    .sort((a, b) => b.ecart - a.ecart || a.nom.localeCompare(b.nom, 'fr'));
  const nouveaux = [];
  const nouvelEtat = { saison, gardiens: {} };
  for (const g of depassements) {
    const cle = normaliserNom(g.nom);
    const connu = connus[cle];
    if (!connu || g.ecart > connu.ecart) nouveaux.push({ ...g, ecartPrecedent: connu ? connu.ecart : null });
    nouvelEtat.gardiens[cle] = {
      nom: g.nom, equipe: g.equipe, mj: g.mj, limite: g.limite, ecart: g.ecart,
      date: connu && connu.ecart === g.ecart ? connu.date : maintenant.toISOString()
    };
  }
  return { depassements, nouveaux, nouvelEtat };
}

export function construireObjet(nouveaux, saison) {
  const n = nouveaux.length;
  return `🚨 USHL Y${saison} : ${n} ${n > 1 ? 'gardiens ont dépassé leur' : 'gardien a dépassé sa'} limite de matchs`;
}

function echapper(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Adresse publique de l'interface (GitHub Pages) à partir de « proprio/depot ». */
export function urlTableau(depot) {
  if (!depot || !depot.includes('/')) return '';
  const [proprio, nom] = depot.split('/');
  if (!proprio || !nom) return '';
  if (/\.github\.io$/i.test(nom)) return `https://${nom}/`;
  return `https://${proprio.toLowerCase()}.github.io/${nom}/`;
}

export function construireCourriel({ nouveaux, depassements, donnees, lien, maintenant = new Date() }) {
  const quand = new Intl.DateTimeFormat('fr-CA', { dateStyle: 'long', timeStyle: 'short', timeZone: 'America/Toronto' }).format(maintenant);
  const cellule = 'padding:6px 10px;border-bottom:1px solid #e5e5e5;';
  const rangs = nouveaux.map(g => '<tr>' +
    `<td style="${cellule}">${echapper(g.nom)}</td>` +
    `<td style="${cellule}">${echapper(g.equipe)}</td>` +
    `<td style="${cellule}text-align:right;">${g.mj}</td>` +
    `<td style="${cellule}text-align:right;">${g.limite}</td>` +
    `<td style="${cellule}text-align:right;"><span style="background:#fdecea;color:#a32d2d;padding:2px 8px;border-radius:6px;font-weight:bold;">+${g.ecart}</span></td>` +
    `<td style="${cellule}color:#555555;">${g.ecartPrecedent === null ? 'Nouveau' : 'Écart accru (était +' + g.ecartPrecedent + ')'}</td>` +
    '</tr>').join('');
  const total = depassements.length;
  return '<div style="font-family:Arial,Helvetica,sans-serif;max-width:680px;color:#1a1a1a;">' +
    '<p style="font-size:14px;">Salut,</p>' +
    '<p style="font-size:14px;">Le robot de suivi vient de vérifier les matchs (MJ = V + D + N). ' +
    `${nouveaux.length > 1 ? 'Ces gardiens ont' : 'Ce gardien a'} <strong style="color:#a32d2d;">dépassé ${nouveaux.length > 1 ? 'leur' : 'sa'} limite d'utilisation</strong> pour la saison Y${donnees.saison} :</p>` +
    '<table style="border-collapse:collapse;width:100%;font-size:13px;">' +
    '<tr style="border-bottom:2px solid #cccccc;">' +
    '<th style="text-align:left;padding:6px 10px;">Gardien</th>' +
    '<th style="text-align:left;padding:6px 10px;">Équipe</th>' +
    '<th style="text-align:right;padding:6px 10px;">MJ (V+D+N)</th>' +
    '<th style="text-align:right;padding:6px 10px;">Limite</th>' +
    '<th style="text-align:right;padding:6px 10px;">Écart</th>' +
    '<th style="text-align:left;padding:6px 10px;">Signalement</th></tr>' +
    rangs + '</table>' +
    `<p style="font-size:13px;color:#444444;">Gardiens en dépassement au total : ${total}.` +
    (donnees.matchs?.asOf ? ` Données de la ligue en date du ${echapper(donnees.matchs.asOf)}.` : '') + '</p>' +
    (lien ? `<p style="font-size:14px;">Tableau complet : <a href="${echapper(lien)}">interface de suivi des gardiens</a></p>` : '') +
    `<p style="font-size:11px;color:#8a8a8a;">Courriel envoyé automatiquement par le robot GitHub Actions le ${echapper(quand)} ` +
    "(vérification deux fois par jour). Chaque gardien n'est signalé qu'une fois par saison, sauf si son écart augmente.</p></div>";
}

function sortieWorkflow(nom, valeur) {
  if (process.env.GITHUB_OUTPUT) return fs.appendFile(process.env.GITHUB_OUTPUT, `${nom}=${valeur}\n`);
  return Promise.resolve();
}

async function lireJson(chemin) {
  try { return JSON.parse(await fs.readFile(chemin, 'utf8')); }
  catch { return null; }
}

/** Passage complet. Renvoie {envoyer, objet, nouveaux, depassements, etatEcrit}. */
export async function verifier({ racine = process.cwd(), env = process.env, journal = console.log, maintenant = () => new Date(), sortie = sortieWorkflow } = {}) {
  const donnees = await lireJson(path.join(racine, FICHIER_GARDIENS));
  if (!donnees || !Array.isArray(donnees.equipes)) throw new Error(`${FICHIER_GARDIENS} introuvable ou illisible : lancer releve-gardiens.mjs d'abord`);
  const cheminEtat = path.join(racine, FICHIER_ETAT);
  const etat = await lireJson(cheminEtat);
  const quand = maintenant();
  const { depassements, nouveaux, nouvelEtat } = evaluerAlertes(donnees, etat, quand);
  journal(`Y${donnees.saison} · limites ${donnees.limites?.statut || '?'} · ${depassements.length} dépassement(s), ${nouveaux.length} à signaler`);

  if (!nouveaux.length) {
    // Rien à envoyer : l'état suit quand même (gardiens qui ne dépassent plus, nouvelle saison)
    let etatEcrit = false;
    if (JSON.stringify(etat) !== JSON.stringify(nouvelEtat) && (etat || depassements.length)) {
      await fs.writeFile(cheminEtat, JSON.stringify(nouvelEtat, null, 1) + '\n', 'utf8');
      etatEcrit = true;
    }
    await sortie('envoyer', 'false');
    return { envoyer: false, objet: null, nouveaux, depassements, etatEcrit };
  }

  const objet = construireObjet(nouveaux, donnees.saison);
  const lien = urlTableau(env.GITHUB_REPOSITORY || donnees.depot);
  await fs.writeFile(path.join(racine, FICHIER_COURRIEL), construireCourriel({ nouveaux, depassements, donnees, lien, maintenant: quand }), 'utf8');
  await fs.writeFile(path.join(racine, FICHIER_CANDIDAT), JSON.stringify(nouvelEtat, null, 1) + '\n', 'utf8');
  await sortie('envoyer', 'true');
  await sortie('objet', objet);
  journal(`Courriel préparé : ${objet}`);
  for (const g of nouveaux) journal(`  - ${g.nom} (${g.equipe}) : ${g.mj}/${g.limite}, +${g.ecart}`);
  return { envoyer: true, objet, nouveaux, depassements, etatEcrit: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  verifier().catch(e => { console.error('ERREUR : ' + e.message); process.exit(1); });
}
