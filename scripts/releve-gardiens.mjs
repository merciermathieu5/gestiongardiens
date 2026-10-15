#!/usr/bin/env node
/**
 * Relève des gardiens USHL : qui garde les buts de chaque équipe, combien de
 * matchs chacun a joués (V + D + N, jamais la colonne GP) et quelle est sa
 * limite d'utilisation pour la saison en cours.
 *
 * Tourne côté serveur (GitHub Actions) : aucun relais anti-CORS. L'interface
 * lit ensuite data/gardiens.json en même origine, comme les interfaces de DG
 * lisent data/rosters.json.
 *
 * Trois sources :
 *  1. Alignements : le relevé quotidien des 32 clubs déjà produit par le dépôt
 *     des Sharks (data/rosters.json). Aucune requête de plus à ushl.ca.
 *  2. Matchs : la page texte STHS de la saison régulière,
 *     USHL{N}TeamScoring.html (blocs GOALTENDING). La saison N est trouvée en
 *     sondant ces pages : la plus récente qui existe est la saison en cours.
 *  3. Limites : le classeur Excel publié dans gestion_gardiens/y{N}/. Tant que
 *     le dossier de la saison en cours n'existe pas, les limites sont « à
 *     venir » : on n'applique jamais les limites d'une saison précédente.
 *
 * Écrit data/gardiens.json (interface et alertes) et limites.json (même format
 * qu'avant : les interfaces de DG le lisent pour l'utilisation des gardiens).
 *
 * Garde-fous : une source qui ne répond pas ne vide jamais les données. Si la
 * relève n'est pas fiable (page anti-robot, page des matchs illisible), le
 * script sort en code 1 sans rien écrire et le job de reprise réessaie.
 *
 * Usage : node scripts/releve-gardiens.mjs
 * Variables facultatives : SAISON (force la saison), URL_ALIGNEMENTS,
 * URL_MATCHS (modèle avec {N}), URL_DOSSIERS_LIMITES.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const SOURCES = {
  alignements: 'https://raw.githubusercontent.com/merciermathieu5/Sharks/main/data/rosters.json',
  matchs: 'https://ushl.ca/ushl/menu_sim/USHL-pro/USHL{N}TeamScoring.html',
  dossiersLimites: 'https://ushl.ca/ushl/menu_ushl/gestion_dg/gestion_gardiens/'
};

export const FICHIER_GARDIENS = 'data/gardiens.json';
export const FICHIER_LIMITES = 'limites.json';
const DOSSIER_DIAGNOSTIC = 'diagnostic';

const MIN_EQUIPES = 28;   // un relevé d'alignements plus court est jugé incomplet
const MIN_JOUEURS = 10;   // par équipe, même règle que les interfaces de DG
const MIN_LIMITES = 20;   // un classeur qui en donne moins est jugé illisible
const DELAI_MS = 20000;
const ESSAIS = 3;
const PAUSE_MS = 600;
const UA = 'ushl-gardiens-bot/1.0 (+github actions)';

/* Nom affiché et abréviation de repli de chaque club (codes de la ligue).
   L'abréviation lue sur la page des matchs (lignes « Totals ») a priorité. */
export const EQUIPES = {
  ANAHEIM: ['Anaheim', 'ANA'], BOSTON: ['Boston', 'BOS'], BUFFALO: ['Buffalo', 'BUF'],
  CALGARY: ['Calgary', 'CGY'], CAROLINA: ['Caroline', 'CAR'], CHICAGO: ['Chicago', 'CHI'],
  COLORADO: ['Colorado', 'COL'], COLUMBUS: ['Columbus', 'CBJ'], DALLAS: ['Dallas', 'DAL'],
  DETROIT: ['Détroit', 'DET'], EDMONTON: ['Edmonton', 'EDM'], FLORIDE: ['Floride', 'FLA'],
  ISLANDERS: ['NY Islanders', 'NYI'], LOSANGELES: ['Los Angeles', 'LA'], MINNESOTA: ['Minnesota', 'MIN'],
  MONTREAL: ['Montréal', 'MTL'], NASHVILLE: ['Nashville', 'NSH'], NEWJERSEY: ['New Jersey', 'NJ'],
  NYRANGERS: ['NY Rangers', 'NYR'], OTTAWA: ['Ottawa', 'OTT'], PHILLY: ['Philadelphie', 'PHI'],
  PITTSBURGH: ['Pittsburgh', 'PIT'], SANJOSE: ['San Jose', 'SJ'], SEATTLE: ['Seattle', 'SEA'],
  'ST.LOUIS': ['St. Louis', 'STL'], TAMPABAY: ['Tampa Bay', 'TB'], TORONTO: ['Toronto', 'TOR'],
  UTAH: ['Utah', 'UTA'], VANCOUVER: ['Vancouver', 'VAN'], VEGAS: ['Vegas', 'VGK'],
  WASHINGTON: ['Washington', 'WSH'], WINNIPEG: ['Winnipeg', 'WPG']
};

/** Relève jugée non fiable : rien n'est écrit, le workflow réessaie. */
export class ErreurReleve extends Error {}

const dodo = ms => new Promise(r => setTimeout(r, ms));

/* =====================================================================
   RÉSEAU
   ===================================================================== */

/** Décode une page : UTF-8, sinon windows-1252 (exports Excel et STHS). */
export function decoder(buffer) {
  let texte = buffer.toString('utf8');
  if (/�|Ã[©¨´¢«»‰€§®]|â€™/.test(texte)) {
    try { texte = new TextDecoder('windows-1252').decode(buffer); }
    catch { texte = buffer.toString('latin1'); }
  }
  return texte;
}

/** Renvoie {statut, texte}. Un statut HTTP n'est pas une erreur : un 404 a un
    sens ici (saison ou classeur pas encore publié). Seules les pannes réseau,
    les 429 et les 5xx sont réessayés. */
export async function recupererReseau(url) {
  let derniere = null;
  for (let essai = 1; essai <= ESSAIS; essai++) {
    try {
      const ctl = new AbortController();
      const minuterie = setTimeout(() => ctl.abort(), DELAI_MS);
      const rep = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'User-Agent': UA } });
      clearTimeout(minuterie);
      const texte = decoder(Buffer.from(await rep.arrayBuffer()));
      if (rep.status === 429 || rep.status >= 500) throw new Error('HTTP ' + rep.status);
      return { statut: rep.status, texte };
    } catch (e) {
      derniere = e.name === 'AbortError' ? new Error('délai dépassé') : e;
      if (essai < ESSAIS) await dodo(PAUSE_MS * essai);
    }
  }
  throw derniere;
}

/** Page de vérification servie parfois aux robots (même symptôme que pour les DG). */
export function estPageAntiRobot(html) {
  return /please wait while your request is being verified|request is being verified|verifying (that )?you are (a )?human|just a moment\.\.\.|attention required|captcha|challenge-platform/i
    .test(String(html || ''));
}

function estPage404(html) {
  return /\b404\b|not found|introuvable|page non trouv/i.test(String(html || ''));
}

/** Extrait lisible d'une page suspecte, pour le journal du workflow. */
export function extraitDePage(html) {
  const corps = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return corps ? corps.slice(0, 160) : '(page sans texte visible)';
}

/* =====================================================================
   HTML → TEXTE
   ===================================================================== */

const ACCENTS = {
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', agrave: 'à', acirc: 'â', auml: 'ä', aacute: 'á',
  ccedil: 'ç', ocirc: 'ô', ouml: 'ö', oacute: 'ó', icirc: 'î', iuml: 'ï', iacute: 'í',
  ucirc: 'û', ugrave: 'ù', uuml: 'ü', uacute: 'ú', ntilde: 'ñ', aring: 'å', oslash: 'ø', scaron: 'š', ccaron: 'č'
};

export function decoderEntites(t) {
  return String(t)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&([A-Za-z])(acute|grave|circ|cedil|uml|tilde|ring|slash|caron);/g, (tout, lettre, sorte) => {
      const c = ACCENTS[(lettre + sorte).toLowerCase()];
      if (!c) return ' ';
      return lettre === lettre.toUpperCase() ? c.toUpperCase() : c;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&[a-z]+;/gi, ' ');
}

/** Reproduit l'essentiel de innerText : cellules séparées par des espaces,
    rangées et blocs séparés par des sauts de ligne. */
export function texteDepuisHtml(html) {
  return decoderEntites(String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(td|th)>/gi, ' ')
    .replace(/<(br|\/tr|\/p|\/div|\/h[1-6]|\/pre|\/li|\/table|\/title)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ''));
}

/** Toutes les valeurs href d'une page (avec ou sans guillemets). */
export function extraireHrefs(html) {
  const liens = [];
  const re = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/gi;
  let m;
  while ((m = re.exec(String(html))) !== null) liens.push(decoderEntites(m[1] ?? m[2] ?? m[3] ?? '').trim());
  return liens.filter(Boolean);
}

/* =====================================================================
   PAGE DES MATCHS (format texte STHS, blocs GOALTENDING)
   ===================================================================== */

const COLONNES_DEFAUT = ['GP', 'MIN', 'AVG', 'W', 'L', 'T', 'SO', 'GA', 'SA', 'PCT', 'PIM', 'AS'];

function entier(s) {
  const t = String(s ?? '').trim();
  return /^-?\d+$/.test(t) ? parseInt(t, 10) : NaN;
}

/**
 * Lit la page « Team Scoring » d'une saison. Matchs joués = V + D + N, jamais
 * GP. Les colonnes sont repérées par l'en-tête du bloc (TEAM GP MIN AVG W L T
 * ...) plutôt que par une position fixe, au cas où STHS en ajouterait.
 * Renvoie {titre, asOf, gardiens[], abbrVersCode{}, matchsEquipe{}, totauxAvecMatchs}.
 */
export function analyserMatchs(html) {
  const brut = String(html || '');
  const texte = /<html|<body|<pre|<br|<p[\s>]|<div/i.test(brut) ? texteDepuisHtml(brut) : brut;
  const titre = (brut.match(/<title>([^<]*)<\/title>/i) || [])[1]?.trim() || null;
  const mAsOf = texte.match(/\(As of ([^)]+)\)/i);
  const gardiens = [];
  const abbrVersCode = {};
  const matchsEquipe = {};
  let totauxAvecMatchs = 0;
  let dansGardiens = false;
  let colonnes = null;

  for (const ligneBrute of texte.split(/\r?\n/)) {
    const t = ligneBrute.replace(/ /g, ' ').trim();
    if (!t) continue;
    if (/^GOALTENDING$/i.test(t)) { dansGardiens = true; colonnes = null; continue; }
    if (/^SCORING$/i.test(t)) { dansGardiens = false; continue; }

    const tot = t.match(/^([A-Z][A-Z.\-]+)\s+Totals\s+([A-Z][A-Z.]{0,4})(?:\s+(.*))?$/);
    if (tot) {
      abbrVersCode[tot[2]] = tot[1];
      if (dansGardiens) {
        const c = colonnes || COLONNES_DEFAUT;
        const nums = (tot[3] || '').trim().split(/\s+/);
        const v = entier(nums[c.indexOf('W')]), d = entier(nums[c.indexOf('L')]), n = entier(nums[c.indexOf('T')]);
        if ([v, d, n].every(Number.isFinite)) {
          matchsEquipe[tot[1]] = v + d + n;
          if (v + d + n > 0) totauxAvecMatchs++;
        }
        dansGardiens = false;
      }
      continue;
    }
    if (!dansGardiens) continue;

    const jetons = t.split(/\s+/);
    const iTeam = jetons.indexOf('TEAM');
    if (iTeam >= 0 && jetons.includes('GP')) { colonnes = jetons.slice(iTeam + 1); continue; }
    if (/^-{5,}$/.test(t)) continue;

    const c = colonnes || COLONNES_DEFAUT;
    if (jetons.length < c.length + 2) continue;
    const nums = jetons.slice(-c.length);
    const equipe = jetons[jetons.length - c.length - 1];
    if (!/^[A-Z][A-Z.]{0,4}$/.test(equipe)) continue;
    let parties = jetons.slice(0, jetons.length - c.length - 1);
    if (/^\d+$/.test(parties[0])) parties = parties.slice(1); // numéro de chandail
    let recrue = false;
    if (parties[0] && parties[0].startsWith('*')) {
      recrue = true;
      parties[0] = parties[0].slice(1);
      if (!parties[0]) parties.shift();
    }
    const nom = parties.join(' ').trim();
    if (!nom || !/[A-Za-zÀ-ÿ]/.test(nom)) continue;
    const v = entier(nums[c.indexOf('W')]), d = entier(nums[c.indexOf('L')]), n = entier(nums[c.indexOf('T')]);
    if (![v, d, n].every(Number.isFinite)) continue;
    gardiens.push({ nom, recrue, equipe, v, d, n, mj: v + d + n, gp: entier(nums[c.indexOf('GP')]) });
  }
  return { titre, asOf: mAsOf ? mAsOf[1].trim() : null, gardiens, abbrVersCode, matchsEquipe, totauxAvecMatchs };
}

/* =====================================================================
   NOMS : normalisation et appariement (mêmes règles que l'interface)
   ===================================================================== */

export function normaliserNom(nom) {
  return String(nom).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
}

export function decomposerNom(nom) {
  const t = String(nom).replace(/ /g, ' ').trim();
  if (t.includes(',')) {
    const [fam, pre] = t.split(',').map(s => s.trim());
    if (fam && pre) return { prenom: pre, famille: fam };
  }
  const mPoint = t.match(/^([A-Za-zÀ-ÿ])\.\s*([A-Za-zÀ-ÿ'\-]{2,}(?:\s+[A-Za-zÀ-ÿ'\-]+)*)$/);
  if (mPoint) return { prenom: mPoint[1], famille: mPoint[2] };
  const mots = t.split(/\s+/).filter(Boolean);
  if (mots.length >= 2) return { prenom: mots[0], famille: mots.slice(1).join(' ') };
  return { prenom: '', famille: t };
}

export function clesNom(nom) {
  const { prenom, famille } = decomposerNom(nom);
  const cles = new Set();
  const complet = normaliserNom(prenom + famille);
  const inverse = normaliserNom(famille + prenom);
  if (complet.length > 2) { cles.add(complet); cles.add(inverse); }
  const initiale = normaliserNom(prenom).charAt(0);
  if (initiale && famille) cles.add(initiale + normaliserNom(famille));
  return { cles: Array.from(cles), famille: normaliserNom(famille), initiale };
}

/**
 * Prépare un apparieur sur une liste. Ordre : nom complet (ou inversé), puis
 * initiale + nom de famille, puis nom de famille seul, mais seulement s'il est
 * unique des deux côtés et que les initiales ne se contredisent pas (deux
 * Gibson dans la ligue : jamais d'appariement au hasard).
 */
export function apparieur(liste, nomDe, nomsAutreCote = []) {
  const parCle = new Map();
  const parFamille = new Map();
  for (const x of liste) {
    const { cles, famille } = clesNom(nomDe(x));
    for (const c of cles) if (!parCle.has(c)) parCle.set(c, x);
    if (famille) parFamille.set(famille, parFamille.has(famille) ? null : x);
  }
  const famillesAutreCote = new Map();
  for (const n of nomsAutreCote) {
    const f = clesNom(n).famille;
    if (f) famillesAutreCote.set(f, (famillesAutreCote.get(f) || 0) + 1);
  }
  return nom => {
    const { cles, famille, initiale } = clesNom(nom);
    for (const c of cles) if (parCle.has(c)) return parCle.get(c);
    if (!famille) return null;
    const x = parFamille.get(famille);
    if (!x) return null;
    if ((famillesAutreCote.get(famille) || 1) > 1) return null;
    const autre = clesNom(nomDe(x)).initiale;
    if (initiale && autre && initiale !== autre) return null;
    return x;
  };
}

/* =====================================================================
   CLASSEUR DES LIMITES (export Excel « page Web » avec cadres)
   ===================================================================== */

export function extraireSrcCadres(html) {
  const srcs = [];
  const re = /<i?frame\b[^>]*?\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>"']+))/gi;
  let m;
  while ((m = re.exec(String(html))) !== null) srcs.push(m[1] ?? m[2] ?? m[3]);
  return srcs;
}

export function extraireLiensHtm(html) {
  return extraireHrefs(html).map(h => h.split('#')[0]).filter(h => /\.html?($|\?)/i.test(h));
}

/** Transforme le HTML d'une feuille en rangées de cellules texte. */
export function rangeesDepuisHtml(html) {
  const rangees = [];
  const reTr = /<tr[\s\S]*?<\/tr>/gi;
  const reTd = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  let mTr;
  while ((mTr = reTr.exec(String(html))) !== null) {
    const cellules = [];
    let mTd;
    reTd.lastIndex = 0;
    while ((mTd = reTd.exec(mTr[0])) !== null) {
      const brut = mTd[1].replace(/<[^>]*>/g, ' ');
      cellules.push(decoderEntites(brut).replace(/ /g, ' ').replace(/\s+/g, ' ').trim());
    }
    if (cellules.some(c => c !== '')) rangees.push(cellules);
  }
  return rangees;
}

function ressembleANom(texte) {
  const t = String(texte).trim();
  if (t.length < 4 || t.length > 45) return false;
  if (/\d/.test(t)) return false;
  if (!/^[A-Za-zÀ-ÿ'.,\- ]+$/.test(t)) return false;
  const mots = t.replace(',', ' ').split(/\s+/).filter(Boolean);
  if (mots.length >= 2 && mots.length <= 4) return true;
  return /^[A-Za-zÀ-ÿ]\.[A-Za-zÀ-ÿ'\-]{3,}$/.test(t);
}

function estMotSeul(texte) {
  const t = String(texte).trim();
  if (/^[A-Z]{2,4}$/.test(t)) return false; // code d'équipe (NJ, PHI, NSH...), pas un prénom
  return t.length >= 2 && t.length <= 20 && /^[A-Za-zÀ-ÿ'.\-]+$/.test(t) && !/^\d/.test(t);
}

/**
 * Repère les noms et la colonne des limites dans une feuille. Logique éprouvée
 * sur la feuille Y21 réelle (88 limites) : l'en-tête ne fait foi que s'il est
 * court, sans chiffre (« Max 55 matchs » est une phrase, pas un en-tête) et
 * que sa colonne produit réellement des valeurs plausibles.
 */
export function analyserRangees(rangees, etiquette = '', journal = () => {}) {
  let colEntete = -1;
  for (const r of rangees.slice(0, 40)) {
    for (let i = 0; i < r.length; i++) {
      const c = String(r[i]).toLowerCase().trim();
      if (c.length === 0 || c.length > 40 || /\d/.test(c)) continue;
      if (/(max|limite|nb|quota|nombre).{0,14}(match|partie|mj)|(match|partie|mj).{0,14}(max|limite|permis)|partie[s]? permise|^max$/.test(c)) {
        colEntete = i; break;
      }
    }
    if (colEntete >= 0) break;
  }
  const candidats = [];
  for (const r of rangees) {
    let nom = null, idxNomFin = -1;
    for (let i = 0; i < r.length; i++) {
      if (ressembleANom(r[i])) { nom = String(r[i]).trim(); idxNomFin = i; break; }
    }
    if (!nom) {
      for (let i = 0; i + 1 < r.length; i++) {
        if (estMotSeul(r[i]) && estMotSeul(r[i + 1])) {
          const joint = String(r[i]).trim() + ' ' + String(r[i + 1]).trim();
          if (ressembleANom(joint)) { nom = joint; idxNomFin = i + 1; break; }
        }
      }
    }
    if (!nom) continue;
    const numeriques = [];
    for (let i = 0; i < r.length; i++) {
      if (i <= idxNomFin && i >= idxNomFin - 1) continue;
      const val = String(r[i]).replace(',', '.').replace(/\s/g, '');
      if (/^\d{1,3}(\.\d+)?$/.test(val)) numeriques.push({ col: i, val: Math.round(parseFloat(val)) });
    }
    if (numeriques.length) candidats.push({ nom, numeriques });
  }
  if (!candidats.length) {
    journal(`  [${etiquette}] aucune rangée reconnue`);
    return [];
  }
  const extrairePour = col => {
    const out = [];
    for (const c of candidats) {
      const nq = c.numeriques.find(x => x.col === col);
      if (nq && nq.val >= 1 && nq.val <= 82) out.push({ nom: c.nom, nomNorm: normaliserNom(c.nom), limite: nq.val });
    }
    return out;
  };
  let colChoisie = -1;
  if (colEntete >= 0 && extrairePour(colEntete).length >= Math.max(3, Math.floor(candidats.length / 3))) colChoisie = colEntete;
  if (colChoisie < 0) {
    const scores = {};
    for (const c of candidats) for (const nq of c.numeriques) if (nq.val >= 25 && nq.val <= 66) scores[nq.col] = (scores[nq.col] || 0) + 1;
    let meilleur = -1, meilleurScore = 0;
    for (const col of Object.keys(scores)) {
      const cc = parseInt(col, 10);
      if (scores[col] > meilleurScore || (scores[col] === meilleurScore && cc > meilleur)) { meilleur = cc; meilleurScore = scores[col]; }
    }
    colChoisie = meilleur;
  }
  if (colChoisie < 0) {
    journal(`  [${etiquette}] ${candidats.length} noms trouvés, mais aucune colonne de limite plausible`);
    return [];
  }
  return extrairePour(colChoisie);
}

/** Dossiers de saison (y16/, y17/...) listés par l'index du serveur. */
export function analyserDossiersSaisons(html, urlListe) {
  const base = new URL(urlListe);
  const vus = new Map();
  for (const href of extraireHrefs(html)) {
    let abs;
    try { abs = new URL(href, base); } catch { continue; }
    if (abs.origin !== base.origin || !abs.pathname.startsWith(base.pathname)) continue;
    const m = abs.pathname.slice(base.pathname.length).match(/^y(\d{1,3})\/?$/i);
    if (m) vus.set(parseInt(m[1], 10), base.origin + base.pathname + 'y' + m[1] + '/');
  }
  return [...vus.entries()].sort((a, b) => a[0] - b[0]).map(([numero, url]) => ({ numero, url }));
}

/** Pages .htm d'un dossier de saison (le nom varie : gestiongardiensy20_1.htm en Y20). */
export function trouverClasseurs(html, urlDossier) {
  const base = new URL(urlDossier);
  const fichiers = [];
  for (const href of extraireHrefs(html)) {
    let abs;
    try { abs = new URL(href, base); } catch { continue; }
    if (abs.origin !== base.origin || !abs.pathname.startsWith(base.pathname)) continue;
    const rel = decodeURIComponent(abs.pathname.slice(base.pathname.length));
    if (!rel || rel.includes('/') || !/\.html?$/i.test(rel)) continue;
    if (!fichiers.includes(abs.href)) fichiers.push(abs.href);
  }
  return fichiers.sort((a, b) => Number(/gardien/i.test(b)) - Number(/gardien/i.test(a)));
}

/** Lit toutes les feuilles d'un classeur publié. Renvoie {absent} ou {limites, feuilles, copies}. */
export async function lireClasseur(urlHtm, recuperer, journal = () => {}) {
  const r = await recuperer(urlHtm);
  if (r.statut === 404 || r.statut === 410) return { absent: true };
  if (r.statut !== 200) throw new Error(`HTTP ${r.statut} pour ${urlHtm}`);
  if (estPageAntiRobot(r.texte)) throw new Error('page de vérification anti-robot');
  const htmlCadres = r.texte;
  const feuilles = new Set();
  const tabstrips = [];
  for (const src of extraireSrcCadres(htmlCadres)) {
    const abs = new URL(src, urlHtm).href;
    if (!/\.html?($|\?)/i.test(abs)) continue;
    if (/tabstrip/i.test(abs)) tabstrips.push(abs); else feuilles.add(abs);
  }
  let ongletsLus = false;
  for (const t of tabstrips) {
    try {
      const rt = await recuperer(t);
      if (rt.statut !== 200) continue;
      ongletsLus = true;
      for (const lien of extraireLiensHtm(rt.texte)) {
        const abs = new URL(lien, t).href;
        if (!/tabstrip/i.test(abs)) feuilles.add(abs);
      }
    } catch (e) { journal(`  barre d'onglets inaccessible : ${e.message}`); }
  }
  // Sondage prudent (sheet002, sheet003...) seulement si la barre d'onglets n'a rien donné
  if (!ongletsLus && feuilles.size === 1) {
    const modele = [...feuilles][0];
    const m = modele.match(/sheet0*(\d+)(\.html?)/i);
    if (m) {
      const base = modele.slice(0, modele.search(/sheet0*\d+\.html?/i));
      for (let n = parseInt(m[1], 10) + 1; n <= parseInt(m[1], 10) + 6; n++) {
        const candidate = base + 'sheet' + String(n).padStart(3, '0') + m[2];
        try {
          const rf = await recuperer(candidate);
          if (rf.statut === 200 && /<table|<tr/i.test(rf.texte)) feuilles.add(candidate); else break;
        } catch { break; }
      }
    }
  }
  if (!feuilles.size) feuilles.add(urlHtm); // classeur d'une seule feuille, sans cadres
  const copies = {};
  let toutes = [];
  for (const f of feuilles) {
    const nomFichier = f.split('/').pop().split('?')[0] || 'feuille.htm';
    let html;
    if (f === urlHtm) html = htmlCadres;
    else {
      try {
        const rf = await recuperer(f);
        if (rf.statut !== 200) { journal(`  ${nomFichier} : HTTP ${rf.statut}`); continue; }
        html = rf.texte;
      } catch (e) { journal(`  ${nomFichier} : ${e.message}`); continue; }
    }
    copies[nomFichier] = html;
    const lims = analyserRangees(rangeesDepuisHtml(html), nomFichier, journal);
    journal(`  ${nomFichier} : ${lims.length} limites`);
    toutes = toutes.concat(lims);
  }
  const vues = new Set();
  toutes = toutes.filter(l => (vues.has(l.nomNorm) ? false : (vues.add(l.nomNorm), true)));
  return { limites: toutes.map(({ nom, limite }) => ({ nom, limite })), feuilles: [...feuilles], copies };
}

/* =====================================================================
   SAISON EN COURS
   ===================================================================== */

export function urlMatchs(n, modele = SOURCES.matchs) { return modele.replace('{N}', String(n)); }

/** Sonde la page des matchs d'une saison : 'presente', 'absente' ou 'erreur'. */
export async function sonderMatchs(n, recuperer, modele) {
  const url = urlMatchs(n, modele);
  let r;
  try { r = await recuperer(url); }
  catch (e) { return { etat: 'erreur', url, raison: e.message }; }
  if (r.statut === 404 || r.statut === 410) return { etat: 'absente', url };
  if (r.statut !== 200) return { etat: 'erreur', url, raison: 'HTTP ' + r.statut };
  if (estPageAntiRobot(r.texte)) return { etat: 'erreur', url, raison: 'page de vérification anti-robot · « ' + extraitDePage(r.texte) + ' »' };
  if (new RegExp('USHL\\s*' + n + '(?!\\d)', 'i').test(r.texte) && /Team Scoring|As of/i.test(r.texte)) {
    return { etat: 'presente', url, html: r.texte };
  }
  if (estPage404(r.texte)) return { etat: 'absente', url };
  return { etat: 'erreur', url, raison: 'page inattendue · « ' + extraitDePage(r.texte) + ' »' };
}

/**
 * La saison en cours est la plus récente dont la page des matchs existe, en
 * partant de la dernière saison connue (jamais en reculant). Une page
 * ambiguë (anti-robot, panne) fait échouer la relève plutôt que de deviner.
 */
export async function determinerSaison({ connue, forcee, recuperer, modele }) {
  if (forcee) {
    const s = await sonderMatchs(forcee, recuperer, modele);
    if (s.etat !== 'presente') throw new ErreurReleve(`saison forcée ${forcee} : page des matchs ${s.etat} (${s.raison || s.url})`);
    return { saison: forcee, page: s };
  }
  if (!connue) throw new ErreurReleve('aucune saison connue : définir SAISON pour le premier passage');
  let courante = null;
  let n = connue + 1;
  for (; n <= connue + 3; n++) {
    const s = await sonderMatchs(n, recuperer, modele);
    if (s.etat === 'erreur') throw new ErreurReleve(`page des matchs Y${n} : ${s.raison}`);
    if (s.etat === 'absente') break;
    courante = s;
  }
  if (courante) return { saison: n - 1, page: courante };
  const s = await sonderMatchs(connue, recuperer, modele);
  if (s.etat === 'presente') return { saison: connue, page: s };
  throw new ErreurReleve(`aucune page des matchs pour Y${connue} ni Y${connue + 1} (${s.raison || 'absente'})`);
}

/* =====================================================================
   ALIGNEMENTS (relevé des Sharks)
   ===================================================================== */

/** Gardiens par équipe d'un data/rosters.json de DG. Lance une erreur si le relevé est incomplet. */
export function gardiensDesAlignements(data) {
  if (!data || typeof data !== 'object' || !data.equipes) throw new Error('fichier sans équipes');
  const equipes = [];
  for (const [code, e] of Object.entries(data.equipes)) {
    if (!e || !Array.isArray(e.joueurs) || e.joueurs.length < MIN_JOUEURS) continue;
    const gardiens = e.joueurs
      .filter(j => j && j.po === 'G' && !j.backup && j.nom)
      .map(j => ({ nom: String(j.nom).trim(), ov: Number.isFinite(j.ov) ? j.ov : null, age: Number.isFinite(j.age) ? j.age : null, clubEcole: !!j.horsAlignement }));
    const mFiche = String(e.fiche || '').match(/(\d+)-(\d+)-(\d+)\s*$/);
    equipes.push({ code, fiche: mFiche ? `${mFiche[1]}-${mFiche[2]}-${mFiche[3]}` : null, gardiens });
  }
  if (equipes.length < MIN_EQUIPES) throw new Error(`${equipes.length} équipes exploitables (< ${MIN_EQUIPES})`);
  return { maj: data.maj || null, equipes };
}

/* =====================================================================
   FUSION
   ===================================================================== */

function matchsDeFiche(fiche) {
  const m = String(fiche || '').match(/(\d+)-(\d+)-(\d+)/);
  return m ? (+m[1]) + (+m[2]) + (+m[3]) : 0;
}

/**
 * Réunit alignements, matchs et limites. Les lignes de matchs d'un même
 * gardien (échangé en cours de saison) sont additionnées. Un gardien présent
 * dans les matchs mais absent des alignements est rangé avec l'équipe de sa
 * dernière ligne de matchs (signalé « absent du relevé »).
 */
export function fusionner({ alignements, matchs, limites }) {
  const avertissements = [];
  const codeVersAbbr = {};
  for (const [abbr, code] of Object.entries(matchs.abbrVersCode || {})) codeVersAbbr[code] = abbr;

  // 1) Matchs regroupés par gardien
  const statsParNom = new Map();
  for (const l of matchs.gardiens) {
    const cle = normaliserNom(l.nom);
    const s = statsParNom.get(cle) || { nom: l.nom, v: 0, d: 0, n: 0, mj: 0, recrue: false, equipes: [] };
    s.v += l.v; s.d += l.d; s.n += l.n; s.mj += l.mj;
    s.recrue = s.recrue || l.recrue;
    if (!s.equipes.includes(l.equipe)) s.equipes.push(l.equipe);
    statsParNom.set(cle, s);
  }
  const listeStats = [...statsParNom.values()];
  const nomsAlignement = alignements.equipes.flatMap(e => e.gardiens.map(g => g.nom));
  const trouverStats = apparieur(listeStats, s => s.nom, nomsAlignement);

  // 2) Équipes et gardiens des alignements
  const utilisees = new Set();
  const equipes = alignements.equipes.map(e => {
    const [nom, abbrRepli] = EQUIPES[e.code] || [e.code, e.code.slice(0, 3)];
    return {
      code: e.code, nom, abbr: codeVersAbbr[e.code] || abbrRepli, fiche: e.fiche,
      matchs: Number.isFinite(matchs.matchsEquipe?.[e.code]) ? matchs.matchsEquipe[e.code] : matchsDeFiche(e.fiche),
      gardiens: e.gardiens.map(g => {
        const s = trouverStats(g.nom);
        if (s) utilisees.add(s);
        const gardien = {
          nom: g.nom, ov: g.ov, age: g.age, clubEcole: !!g.clubEcole, recrue: !!s?.recrue,
          v: s ? s.v : 0, d: s ? s.d : 0, n: s ? s.n : 0, mj: s ? s.mj : 0, limite: null
        };
        if (s && s.equipes.length > 1) gardien.equipesStats = s.equipes.slice();
        return gardien;
      })
    };
  });

  // 3) Gardiens des matchs absents du relevé d'alignements
  const parCode = new Map(equipes.map(e => [e.code, e]));
  const autres = [];
  for (const s of listeStats) {
    if (utilisees.has(s)) continue;
    const abbr = s.equipes[s.equipes.length - 1];
    const code = matchs.abbrVersCode?.[abbr];
    const g = { nom: s.nom, ov: null, age: null, clubEcole: false, recrue: s.recrue, horsReleve: true, v: s.v, d: s.d, n: s.n, mj: s.mj, limite: null };
    if (s.equipes.length > 1) g.equipesStats = s.equipes.slice();
    if (code && parCode.has(code)) parCode.get(code).gardiens.push(g);
    else autres.push({ ...g, equipeStats: abbr || null });
    avertissements.push(`${s.nom} (${abbr || '?'}) figure dans les matchs mais pas dans le relevé des alignements.`);
  }

  // 4) Limites
  const tous = [...equipes.flatMap(e => e.gardiens), ...autres];
  const trouverLimite = apparieur(limites, l => l.nom, tous.map(g => g.nom));
  const limitesUtilisees = new Set();
  for (const g of tous) {
    const l = trouverLimite(g.nom);
    if (l) { g.limite = l.limite; limitesUtilisees.add(l); }
  }
  const limitesNonAssociees = limites.filter(l => !limitesUtilisees.has(l)).map(({ nom, limite }) => ({ nom, limite }));

  for (const g of tous) {
    if (g.equipesStats) avertissements.push(`${g.nom} : matchs additionnés de ${g.equipesStats.join(' + ')} (échange en cours de saison).`);
  }
  return { equipes, autres, limitesNonAssociees, avertissements };
}

/* =====================================================================
   FICHIERS
   ===================================================================== */

async function lireJson(chemin) {
  try { return JSON.parse(await fs.readFile(chemin, 'utf8')); }
  catch { return null; }
}

/** Saison d'un limites.json : champ « saison », sinon le dossier y{N} de sa source. */
export function saisonDesLimites(l) {
  if (!l) return null;
  if (Number.isFinite(l.saison)) return l.saison;
  const m = String(l.source || '').match(/\/y(\d{1,3})\//i);
  return m ? parseInt(m[1], 10) : null;
}

function memesLimites(a, b) {
  if (!a || !b) return false;
  const cle = x => JSON.stringify({ source: x.source ?? null, saison: x.saison ?? null, statut: x.statut ?? null, limites: x.limites || [] });
  return cle(a) === cle(b);
}

/* =====================================================================
   RELÈVE
   ===================================================================== */

/**
 * Relève complète. Écrit data/gardiens.json et, s'il a changé, limites.json.
 * Lance ErreurReleve si la relève n'est pas fiable (rien n'est alors écrit).
 */
export async function releve({ racine = process.cwd(), recuperer = recupererReseau, env = process.env, journal = console.log, maintenant = () => new Date() } = {}) {
  const urls = {
    alignements: env.URL_ALIGNEMENTS || SOURCES.alignements,
    matchs: env.URL_MATCHS || SOURCES.matchs,
    dossiersLimites: env.URL_DOSSIERS_LIMITES || SOURCES.dossiersLimites
  };
  const cheminGardiens = path.join(racine, FICHIER_GARDIENS);
  const cheminLimites = path.join(racine, FICHIER_LIMITES);
  const existant = await lireJson(cheminGardiens);
  const limitesExistantes = await lireJson(cheminLimites);
  const avertissements = [];

  // 1) Saison en cours et page des matchs
  const connue = Math.max(existant?.saison || 0, saisonDesLimites(limitesExistantes) || 0) || null;
  const forcee = env.SAISON ? parseInt(env.SAISON, 10) : null;
  const { saison, page } = await determinerSaison({ connue, forcee, recuperer, modele: urls.matchs });
  if (existant?.saison && saison < existant.saison) throw new ErreurReleve(`saison Y${saison} antérieure au relevé existant (Y${existant.saison})`);
  journal(`Saison en cours : Y${saison} (${page.url})`);

  // 2) Matchs
  const matchs = analyserMatchs(page.html);
  journal(`Matchs : ${matchs.gardiens.length} lignes de gardiens, en date du ${matchs.asOf || '?'}`);

  // 3) Alignements (repris du relevé précédent si la source ne répond pas)
  let alignements;
  let alignementsRepris = false;
  try {
    const r = await recuperer(urls.alignements);
    if (r.statut !== 200) throw new Error('HTTP ' + r.statut);
    alignements = gardiensDesAlignements(JSON.parse(r.texte));
    journal(`Alignements : ${alignements.equipes.length} équipes, relevé du ${alignements.maj || '?'}`);
  } catch (e) {
    if (existant && Array.isArray(existant.equipes) && existant.equipes.length >= MIN_EQUIPES && existant.saison === saison) {
      alignements = {
        maj: existant.alignements?.maj || null,
        equipes: existant.equipes.map(eq => ({
          code: eq.code, fiche: eq.fiche || null,
          gardiens: eq.gardiens.filter(g => !g.horsReleve).map(g => ({ nom: g.nom, ov: g.ov ?? null, age: g.age ?? null, clubEcole: !!g.clubEcole }))
        }))
      };
      alignementsRepris = true;
      avertissements.push(`Relevé des alignements inaccessible (${e.message}) : gardiens par équipe repris du relevé précédent.`);
      journal(`Alignements : ${e.message} · reprise du relevé précédent`);
    } else {
      throw new ErreurReleve(`relevé des alignements inaccessible (${e.message}) et aucun relevé précédent à reprendre`);
    }
  }

  // 4) Cohérence des matchs : une page vide alors que des matchs ont été joués n'efface rien
  if (matchs.gardiens.length === 0) {
    if (matchs.totauxAvecMatchs > 0) {
      throw new ErreurReleve(`la page des matchs montre ${matchs.totauxAvecMatchs} équipe(s) avec des matchs, mais aucune ligne de gardien n'a été lue (format changé?)`);
    }
    const avaitDesMatchs = existant?.saison === saison && (existant.equipes || []).some(e => (e.gardiens || []).some(g => g.mj > 0));
    if (avaitDesMatchs) throw new ErreurReleve('la page des matchs ne contient plus aucun gardien alors que le relevé précédent en avait');
    if (alignements.equipes.some(e => matchsDeFiche(e.fiche) > 0)) {
      avertissements.push("Les fiches d'équipes montrent des matchs joués, mais la page des matchs n'a encore aucune ligne de gardien.");
    }
  }

  // 5) Limites de la saison en cours
  let limites = { statut: 'a-venir', source: null, liste: [], lues: null, repris: false };
  const precedentes = limitesExistantes && saisonDesLimites(limitesExistantes) === saison ? limitesExistantes : null;
  const statutPrecedent = precedentes ? (precedentes.statut || ((precedentes.limites || []).length ? 'publiees' : 'a-venir')) : null;
  const reprendre = raison => {
    if (precedentes && statutPrecedent === 'publiees' && (precedentes.limites || []).length) {
      limites = { statut: 'publiees', source: precedentes.source || null, liste: precedentes.limites, lues: precedentes.horodatage || null, repris: true };
      avertissements.push(`${raison} : limites Y${saison} reprises du relevé précédent.`);
      return true;
    }
    return false;
  };
  const copiesDiagnostic = {};
  let dossiers = null;
  try {
    const r = await recuperer(urls.dossiersLimites);
    if (r.statut !== 200) throw new Error('HTTP ' + r.statut);
    if (estPageAntiRobot(r.texte)) throw new Error('page de vérification anti-robot');
    dossiers = analyserDossiersSaisons(r.texte, urls.dossiersLimites);
    if (!dossiers.length) throw new Error('aucun dossier de saison dans la page');
    journal(`Dossiers des limites : ${dossiers.map(d => 'y' + d.numero).join(', ')}`);
  } catch (e) {
    journal(`Dossiers des limites : ${e.message}`);
    if (!reprendre(`Dossier des limites inaccessible (${e.message})`)) {
      avertissements.push(`Dossier des limites inaccessible (${e.message}) : nouvelle vérification au prochain passage.`);
    }
  }
  if (dossiers) {
    const dossier = dossiers.find(d => d.numero === saison);
    if (!dossier) {
      journal(`Limites Y${saison} : pas encore publiées (dernier dossier : y${dossiers[dossiers.length - 1].numero})`);
    } else {
      let candidats = [];
      try {
        const rd = await recuperer(dossier.url);
        if (rd.statut === 200 && !estPageAntiRobot(rd.texte)) candidats = trouverClasseurs(rd.texte, dossier.url);
      } catch (e) { journal(`Index du dossier y${saison} : ${e.message}`); }
      if (!candidats.length) candidats = [`${dossier.url}gestiongardiensy${saison}.htm`, `${dossier.url}gestiongardiensy${saison}_1.htm`];
      let lu = null, erreur = null;
      for (const url of candidats) {
        try {
          const c = await lireClasseur(url, recuperer, journal);
          if (c.absent) continue;
          lu = { url, ...c };
          break;
        } catch (e) { erreur = e; journal(`Classeur ${url} : ${e.message}`); }
      }
      if (lu && lu.limites.length >= MIN_LIMITES) {
        limites = { statut: 'publiees', source: lu.url, liste: lu.limites, lues: maintenant().toISOString(), repris: false };
        journal(`Limites Y${saison} : ${lu.limites.length} lues dans ${lu.url}`);
      } else {
        if (lu) for (const [nom, html] of Object.entries(lu.copies)) copiesDiagnostic['limites-' + nom] = html;
        const raison = lu ? `classeur Y${saison} lu mais seulement ${lu.limites.length} limite(s) reconnue(s)`
          : `classeur Y${saison} introuvable ou illisible${erreur ? ' (' + erreur.message + ')' : ''}`;
        if (!reprendre(raison[0].toUpperCase() + raison.slice(1))) {
          limites = { statut: 'illisible', source: lu ? lu.url : dossier.url, liste: [], lues: null, repris: false };
          avertissements.push(`Le dossier y${saison} est en ligne, mais ${raison}. Copie brute dans ${DOSSIER_DIAGNOSTIC}/.`);
        }
      }
    }
  }

  // 6) Fusion
  const fusion = fusionner({ alignements, matchs, limites: limites.liste });
  avertissements.push(...fusion.avertissements);
  if (existant?.saison === saison) {
    const avant = new Map();
    for (const e of existant.equipes || []) for (const g of e.gardiens || []) avant.set(normaliserNom(g.nom), g.mj);
    for (const e of fusion.equipes) for (const g of e.gardiens) {
      const mjAvant = avant.get(normaliserNom(g.nom));
      if (Number.isFinite(mjAvant) && g.mj < mjAvant) avertissements.push(`${g.nom} : ${mjAvant} matchs au relevé précédent, ${g.mj} maintenant (correction de la ligue?).`);
    }
  }

  // 7) Écriture. limites.json n'est réécrit que si son contenu change : son
  //    horodatage dit alors depuis quand les limites en vigueur sont connues.
  const horodatage = maintenant().toISOString();
  const nouvellesLimites = {
    source: limites.source, saison, statut: limites.statut,
    horodatage: limites.lues || horodatage,
    nombre: limites.liste.length,
    limites: limites.liste.map(({ nom, limite }) => ({ nom, limite }))
  };
  const limitesEcrites = !memesLimites(nouvellesLimites, limitesExistantes);
  if (!limitesEcrites) nouvellesLimites.horodatage = limitesExistantes.horodatage || nouvellesLimites.horodatage;

  const sortie = {
    version: 1,
    genere: horodatage,
    saison,
    depot: env.GITHUB_REPOSITORY || existant?.depot || null,
    ...(env.AMORCE ? { amorce: true } : {}),
    matchs: { source: page.url, asOf: matchs.asOf, lignes: matchs.gardiens.length },
    alignements: { source: urls.alignements, maj: alignements.maj, repris: alignementsRepris },
    limites: {
      statut: limites.statut, source: limites.source, nombre: limites.liste.length,
      depuis: limites.statut === 'a-venir' ? null : nouvellesLimites.horodatage, repris: limites.repris
    },
    equipes: fusion.equipes,
    autres: fusion.autres,
    limitesNonAssociees: fusion.limitesNonAssociees,
    avertissements
  };
  await fs.mkdir(path.dirname(cheminGardiens), { recursive: true });
  await fs.writeFile(cheminGardiens, JSON.stringify(sortie, null, 1) + '\n', 'utf8');
  if (limitesEcrites) await fs.writeFile(cheminLimites, JSON.stringify(nouvellesLimites, null, 1) + '\n', 'utf8');

  if (Object.keys(copiesDiagnostic).length) {
    const dossierDiag = path.join(racine, DOSSIER_DIAGNOSTIC);
    await fs.mkdir(dossierDiag, { recursive: true });
    for (const [nom, html] of Object.entries(copiesDiagnostic)) await fs.writeFile(path.join(dossierDiag, nom), html, 'utf8');
  }

  const nbGardiens = sortie.equipes.reduce((t, e) => t + e.gardiens.length, 0) + sortie.autres.length;
  journal(`Écrit : ${FICHIER_GARDIENS} (Y${saison}, ${sortie.equipes.length} équipes, ${nbGardiens} gardiens, limites ${limites.statut})` +
    (limitesEcrites ? ` et ${FICHIER_LIMITES}` : ''));
  for (const a of avertissements) journal('  ! ' + a);
  return { sortie, limitesEcrites };
}

async function principal() {
  try {
    await releve();
  } catch (e) {
    if (e instanceof ErreurReleve) console.error(`Relève non fiable : ${e.message}. Les fichiers existants sont laissés intacts.`);
    else console.error('Échec :', e.stack || e.message);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) principal();
