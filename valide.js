/* Harnais de validation : Suivi des gardiens USHL (jsdom)
   Lancer : npm install, puis npm test (ou node valide.js).
   Aucun accès réseau : les pages de la ligue sont simulées. Les fixtures
   réelles sont dans tests/fixtures/ (feuille des limites Y21, extrait du
   relevé des alignements du 14 octobre 2026, lignes de matchs Y21 transcrites
   en juillet). Les scénarios « saison commencée » sont des simulations. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JSDOM } = require('jsdom');

let total = 0, echecs = 0;
function ok(cond, msg) { total++; if (!cond) { echecs++; console.error('  ✗ ' + msg); } }
function egal(a, b, msg) { ok(a === b, msg + ` (obtenu: ${JSON.stringify(a)}, attendu: ${JSON.stringify(b)})`); }
function tableauEgal(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), msg + ` (obtenu: ${JSON.stringify(a)}, attendu: ${JSON.stringify(b)})`); }
const section = t => console.log('— ' + t);
const attendre = ms => new Promise(r => setTimeout(r, ms));
const F = n => path.join(__dirname, 'tests', 'fixtures', n);
const lire = n => fs.readFileSync(F(n), 'utf8');
const dossierTemp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gardiens-'));
const lireJsonDe = (racine, fichier) => JSON.parse(fs.readFileSync(path.join(racine, fichier), 'utf8'));

/* ---------------------------------------------------------------------
   Pages simulées de la ligue
   --------------------------------------------------------------------- */
const URL_MATCHS = n => `https://ushl.ca/ushl/menu_sim/USHL-pro/USHL${n}TeamScoring.html`;
const URL_DOSSIERS = 'https://ushl.ca/ushl/menu_ushl/gestion_dg/gestion_gardiens/';
const URL_ALIGNEMENTS = 'https://raw.githubusercontent.com/merciermathieu5/Sharks/main/data/rosters.json';

function indexServeur(titre, entrees) {
  return '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 3.2 Final//EN"><html><head><title>Index of ' + titre + '</title></head><body>' +
    '<h1>Index of ' + titre + '</h1><table><tr><th><a href="?ND">Name</a></th><th><a href="?MA">Last modified</a></th><th><a href="?SA">Size</a></th></tr>' +
    entrees.map(([href, nom, date]) => `<tr><td><a href="${href}">${nom}</a></td><td align="right">${date}</td><td align="right">-</td></tr>`).join('') +
    '</table></body></html>';
}
const INDEX_SAISONS = (jusqua) => indexServeur('/ushl/menu_ushl/gestion_dg/gestion_gardiens', [
  ['/ushl/menu_ushl/gestion_dg/', 'Parent Directory', ''],
  ['y16/', 'y16/', '2020-10-23 03:54'], ['y17/', 'y17/', '2021-10-28 03:27'], ['y18/', 'y18/', '2022-12-09 21:00'],
  ['y19/', 'y19/', '2023-10-16 04:09'], ['y20/', 'y20/', '2024-10-19 01:58'], ['y21/', 'y21/', '2025-10-11 01:39'],
  ...(jusqua >= 22 ? [['y22/', 'y22/', '2026-10-20 02:10']] : [])
]);
const INDEX_DOSSIER = (n, base = `gestiongardiensy${n}`) => indexServeur(`/ushl/menu_ushl/gestion_dg/gestion_gardiens/y${n}`, [
  ['/ushl/menu_ushl/gestion_dg/gestion_gardiens/', 'Parent Directory', ''],
  [`${base}_fichiers/`, `${base}_fichiers/`, '2025-10-11 01:39'],
  [`${base}.htm`, `${base}.htm`, '2025-10-11 01:39'],
  [`${base}.xlsx`, `${base}.xlsx`, '2025-10-11 01:39']
]);
const CADRES_EXCEL = dossier => '<html xmlns:v="urn:schemas-microsoft-com:vml"><head><meta name="Excel Workbook Frameset">' +
  '<meta http-equiv=Content-Type content="text/html; charset=windows-1252"><meta name=ProgId content=Excel.Sheet>' +
  `<link rel=File-List href="${dossier}/filelist.xml"></head>` +
  `<frameset rows="*,39" border=0 width=0 frameborder=no framespacing=0><frame src="${dossier}/sheet001.htm" name="frSheet">` +
  `<frame src="${dossier}/tabstrip.htm" name="frTabs" marginwidth=0 marginheight=0>` +
  '<noframes><body><p>Cette page utilise des cadres, mais votre navigateur ne les prend pas en charge.</p></body></noframes></frameset></html>';
const ONGLETS_EXCEL = '<html><head><meta name="Excel Workbook Frameset"></head><body><table border=0 cellspacing=1><tr>' +
  '<td bgcolor="#FFFFFF" nowrap><b><small><small>&nbsp;<a href="sheet001.htm" target="frSheet"><font face="Arial" color="#000000">Feuil1</font></a>&nbsp;</small></small></b></td>' +
  '</tr></table></body></html>';
const PAGE_Y22_CE_SOIR = '<html><head><title>USHL22 Team Scoring</title></head><body><h1>Team Scoring</h1><p>(As of mardi, oct 13 2026)</p></body></html>';
const ANTI_ROBOT = '<html><head><title>Vérification</title></head><body><p>Please wait while your request is being verified...</p></body></html>';

/** Page « Team Scoring » au format STHS : un <h2> et un bloc <pre> par équipe. */
function pageMatchs(saison, asOf, blocs) {
  return `<html><head><title>USHL${saison} Team Scoring</title></head><body><h1>Team Scoring</h1><p>(As of ${asOf})</p>` +
    blocs.map(([equipe, texte]) => `<h2>${equipe}</h2><pre>${texte}</pre>`).join('') + '</body></html>';
}
const ENTETE_G = '                           TEAM  GP  MIN   AVG   W   L   T  SO  GA   SA   PCT PIM AS';
const TIRETS = '------------------------------------------------------------------------------------';
/* Simulation d'une saison Y22 commencée (valeurs inventées pour les tests) :
   Desrosiers dépasse (66/65), Vasilevskiy est pile à sa limite (64/64),
   Samsonov est en alerte (61/64), Blomqvist a des lignes à NSH et BOS
   (échangé), Jean Simule n'existe dans aucun alignement, Hrabal n'a pas de
   numéro de chandail, Wall a GP 5 mais V+D+N = 3. */
const BLOCS_Y22 = [
  ['SANJOSE', ['GOALTENDING', ENTETE_G,
    '  30  Philippe Desrosiers   SJ   66 3900  2,51  41  20   5   3 163 1800  ,909   0  1',
    '  35  Tyler Wall            SJ    5  210  3,10   2   1   0   0  11  100  ,890   0  0',
    '  99  Jean Simule           SJ    2  120  3,00   1   1   0   0   6   60  ,900   0  0',
    TIRETS, 'SANJOSE Totals              SJ   71 4230  2,55  44  22   5   3 180 1960  ,908'].join('\n')],
  ['WASHINGTON', ['GOALTENDING', ENTETE_G,
    '  88  Andrey Vasilevskiy    WSH  64 3800  2,40  40  18   6   4 152 1700  ,911   0  2',
    '  36  John Gibson           WSH   8  420  3,00   4   4   0   0  21  200  ,895   0  0',
    TIRETS, 'WASHINGTON Totals           WSH  72 4220  2,46  44  22   6   4 173 1900  ,909'].join('\n')],
  ['NASHVILLE', ['GOALTENDING', ENTETE_G,
    '  74  Ilya Samsonov         NSH  61 3600  2,70  35  20   6   2 162 1650  ,902   0  1',
    '  56  Joel Blomqvist        NSH  10  560  3,20   5   5   0   0  30  280  ,893   0  0',
    TIRETS, 'NASHVILLE Totals            NSH  71 4160  2,77  40  25   6   2 192 1930  ,901'].join('\n')],
  ['BOSTON', ['GOALTENDING', ENTETE_G,
    '  31  Joel Blomqvist        BOS   5  290  2,90   3   2   0   0  14  150  ,907   0  0',
    '  41  Joel Hofer            BOS  20 1150  2,80  12   7   1   1  54  560  ,904   0  0',
    TIRETS, 'BOSTON Totals               BOS  25 1440  2,83  15   9   1   1  68  710  ,904'].join('\n')],
  ['NYRANGERS', ['GOALTENDING', ENTETE_G,
    '  40  Daniil Tarasov        NYR  40 2350  2,60  25  12   3   2 102 1100  ,907   0  0',
    TIRETS, 'NYRANGERS Totals            NYR  40 2350  2,60  25  12   3   2 102 1100  ,907'].join('\n')],
  ['TORONTO', ['GOALTENDING', ENTETE_G,
    '  33  Chris Gibson          TOR  30 1700  2,90  17  11   2   1  82  850  ,904   0  0',
    '      Michael Hrabal        TOR   1   60  2,00   1   0   0   0   2   30  ,933   0  0',
    TIRETS, 'TORONTO Totals              TOR  31 1760  2,86  18  11   2   1  84  880  ,905'].join('\n')]
];
const PAGE_Y22_COMMENCEE = pageMatchs(22, 'lundi, janv 11 2027', BLOCS_Y22);

/** Serveur simulé : table url → {statut, texte}; tout le reste répond 404. */
function serveur(pages) {
  const appels = [];
  const recuperer = async url => {
    appels.push(url);
    const p = pages[url];
    if (p instanceof Error) throw p;
    if (typeof p === 'string') return { statut: 200, texte: p };
    return p || { statut: 404, texte: '<html><body><h1>404 Not Found</h1></body></html>' };
  };
  return { recuperer, appels };
}
const ROSTERS = lire('rosters-extrait-2026-10-14.json');
const FEUILLE_Y21 = lire('limites-y21-sheet001.htm');
const LIMITES_Y21_DEPOT = fs.readFileSync(path.join(__dirname, 'tests', 'fixtures', 'limites-y21.json'), 'utf8');

function pagesCeSoir() {
  return {
    [URL_MATCHS(22)]: PAGE_Y22_CE_SOIR,
    [URL_ALIGNEMENTS]: ROSTERS,
    [URL_DOSSIERS]: INDEX_SAISONS(21)
  };
}
function pagesSaisonCommencee() {
  const base = URL_DOSSIERS + 'y22/';
  return {
    [URL_MATCHS(22)]: PAGE_Y22_COMMENCEE,
    [URL_ALIGNEMENTS]: ROSTERS,
    [URL_DOSSIERS]: INDEX_SAISONS(22),
    [base]: INDEX_DOSSIER(22),
    [base + 'gestiongardiensy22.htm']: CADRES_EXCEL('gestiongardiensy22_fichiers'),
    [base + 'gestiongardiensy22_fichiers/tabstrip.htm']: ONGLETS_EXCEL,
    [base + 'gestiongardiensy22_fichiers/sheet001.htm']: FEUILLE_Y21
  };
}
const MAINTENANT = new Date('2026-10-15T02:10:00Z');
const silence = () => {};

(async () => {
  const R = await import('./scripts/releve-gardiens.mjs');
  const A = await import('./scripts/alertes-gardiens.mjs');

  /* =================================================================
     1. PAGE DES MATCHS
     ================================================================= */
  section('Page des matchs : lignes réelles Y21 (séries, transcrites en juillet)');
  const echantillon = lire('matchs-y21-series-extrait.txt');
  const m21 = R.analyserMatchs(echantillon);
  egal(m21.gardiens.length, 9, '9 lignes de gardiens lues');
  const g21 = nom => m21.gardiens.find(g => g.nom === nom);
  const mark = g21('Jacob Markstrom');
  ok(mark && mark.v === 6 && mark.d === 5 && mark.n === 0 && mark.mj === 11, 'Markstrom : 6-5-0, MJ 11');
  egal(g21('Hugo Hanefelt')?.gp, 1, 'Hanefelt : GP 1 dans la page');
  egal(g21('Hugo Hanefelt')?.mj, 0, 'Hanefelt : MJ 0 (V + D + N, jamais GP)');
  egal(g21('Joel Blomqvist')?.mj, 0, 'Blomqvist : MJ 0 malgré GP 6');
  egal(g21('Devon Levi')?.mj, 11, 'Levi : MJ 11 malgré GP 13');
  egal(g21('Ilya Samsonov')?.mj, 27, 'Samsonov : MJ 27');
  ok(g21('Drew Commesso')?.recrue === true && g21('Erik Portillo')?.recrue === true, 'Recrues repérées (astérisque collé ou détaché)');
  egal(g21('Erik Portillo')?.nom, 'Erik Portillo', 'Astérisque retiré du nom');
  egal(g21('Jacob Markstrom')?.equipe, 'NJ', 'Abréviation d’équipe lue sur la ligne');
  tableauEgal(m21.abbrVersCode, { NJ: 'NEWJERSEY', NSH: 'NASHVILLE', PHI: 'PHILLY', SEA: 'SEATTLE' }, 'Lignes « Totals » : abréviation → code de la ligue');
  tableauEgal(m21.matchsEquipe, { NEWJERSEY: 11, NASHVILLE: 27, PHILLY: 18, SEATTLE: 7 }, 'Matchs d’équipe lus dans les totaux des gardiens');
  egal(m21.totauxAvecMatchs, 4, '4 équipes avec des matchs');
  ok(!m21.gardiens.some(g => g.nom.includes('Sillinger')), 'Les lignes SCORING ne sont pas prises pour des gardiens');
  egal(m21.gardiens.filter(g => g.nom === 'Jacob Markstrom').length, 1, 'Markstrom (aussi dans SCORING) n’est compté qu’une fois');

  section('Page des matchs : variantes de balisage');
  const enPre = '<html><head><title>USHL21PLF Team Scoring</title></head><body><h1>Team Scoring</h1><p>(As of samedi, juil 4 2026)</p>' +
    echantillon.split(/^## /m).filter(Boolean).map(b => { const [t, ...r] = b.split('\n'); return `<h2>${t}</h2><pre>${r.join('\n')}</pre>`; }).join('') + '</body></html>';
  const mPre = R.analyserMatchs(enPre);
  egal(mPre.gardiens.length, 9, 'Blocs <pre> : 9 gardiens');
  egal(mPre.asOf, 'samedi, juil 4 2026', 'Date « As of » lue');
  egal(mPre.titre, 'USHL21PLF Team Scoring', 'Titre de la page lu');
  const enBr = '<html><body>' + echantillon.replace(/ /g, '&nbsp;').replace(/\n/g, '<br>\n') + '</body></html>';
  egal(R.analyserMatchs(enBr).gardiens.length, 9, 'Lignes en <br> et &nbsp; : 9 gardiens');
  const avecOtl = echantillon
    .replace(/ W   L   T  SO/g, ' W   L   T OTL  SO')
    .replace(/^(\s+\d+\s+\*?[A-Za-z][^\n]*?\s(NJ|NSH|PHI|SEA)\s+\d+\s+\d+\s+[\d,]+\s+\d+\s+\d+\s+\d+)(\s)/gm, '$1   0$3');
  const mOtl = R.analyserMatchs(avecOtl);
  const levi = mOtl.gardiens.find(g => g.nom === 'Devon Levi');
  ok(mOtl.gardiens.length === 9 && levi && levi.v === 6 && levi.d === 5 && levi.n === 0, 'Colonne ajoutée (OTL) : V, D, N repérés par l’en-tête');
  const sansNumero = R.analyserMatchs(['GOALTENDING', ENTETE_G, '      Michael Hrabal        TOR   1   60  2,00   1   0   0   0   2   30  ,933   0  0'].join('\n'));
  egal(sansNumero.gardiens[0]?.nom, 'Michael Hrabal', 'Ligne sans numéro de chandail lue');

  section('Page des matchs : Y22 telle que publiée ce soir (aucun match)');
  const m22 = R.analyserMatchs(PAGE_Y22_CE_SOIR);
  egal(m22.gardiens.length, 0, 'Aucune ligne de gardien');
  egal(m22.asOf, 'mardi, oct 13 2026', 'En date du mardi 13 octobre');
  egal(m22.totauxAvecMatchs, 0, 'Aucune équipe avec des matchs');

  /* =================================================================
     2. LIMITES
     ================================================================= */
  section('Limites : feuille Y21 réelle');
  const limY21 = R.analyserRangees(R.rangeesDepuisHtml(FEUILLE_Y21), 'sheet001');
  egal(limY21.length, 88, '88 limites lues');
  const lim = nom => limY21.find(l => l.nom === nom)?.limite;
  egal(lim('Philippe Desrosiers'), 65, 'Desrosiers : 65');
  egal(lim('Andrey Vasilevskiy'), 64, 'Vasilevskiy : 64');
  egal(lim('John Gibson'), 58, 'John Gibson : 58');
  egal(lim('Chris Gibson'), 57, 'Chris Gibson : 57');
  const depot = JSON.parse(LIMITES_Y21_DEPOT).limites;
  ok(depot.length === 88 && depot.every(l => lim(l.nom) === l.limite), 'Identique au limites.json Y21 du dépôt (88 sur 88)');

  section('Limites : index du serveur et classeur Excel');
  const dossiers = R.analyserDossiersSaisons(INDEX_SAISONS(21), URL_DOSSIERS);
  tableauEgal(dossiers.map(d => d.numero), [16, 17, 18, 19, 20, 21], 'Dossiers y16 à y21 repérés');
  egal(dossiers[5].url, URL_DOSSIERS + 'y21/', 'Adresse absolue du dossier y21');
  const absolus = indexServeur('x', [[URL_DOSSIERS + 'y21/', 'y21', ''], ['https://autre.site/y22/', 'y22', '']]);
  tableauEgal(R.analyserDossiersSaisons(absolus, URL_DOSSIERS).map(d => d.numero), [21], 'Liens absolus acceptés, autres sites ignorés');
  tableauEgal(R.trouverClasseurs(INDEX_DOSSIER(21), URL_DOSSIERS + 'y21/'), [URL_DOSSIERS + 'y21/gestiongardiensy21.htm'], 'Classeur Y21 trouvé (ni .xlsx ni dossier _fichiers)');
  tableauEgal(R.trouverClasseurs(INDEX_DOSSIER(20, 'gestiongardiensy20_1'), URL_DOSSIERS + 'y20/'), [URL_DOSSIERS + 'y20/gestiongardiensy20_1.htm'], 'Nom variable (gestiongardiensy20_1.htm) trouvé');
  const sc = serveur(pagesSaisonCommencee());
  const classeur = await R.lireClasseur(URL_DOSSIERS + 'y22/gestiongardiensy22.htm', sc.recuperer);
  egal(classeur.limites.length, 88, 'Classeur à cadres : barre d’onglets suivie, 88 limites');
  ok(sc.appels.includes(URL_DOSSIERS + 'y22/gestiongardiensy22_fichiers/sheet001.htm'), 'Feuille sheet001 lue via la barre d’onglets');
  const unePage = serveur({ 'https://ushl.ca/x/seul.htm': FEUILLE_Y21 });
  egal((await R.lireClasseur('https://ushl.ca/x/seul.htm', unePage.recuperer)).limites.length, 88, 'Classeur sans cadres : la page elle-même est lue');
  ok((await R.lireClasseur('https://ushl.ca/x/absent.htm', unePage.recuperer)).absent === true, 'Classeur absent (404) signalé comme absent');

  section('Appariement des noms');
  const lims = [{ nom: 'Markstrom, Jacob', limite: 60 }, { nom: 'J. Oettinger', limite: 62 }, { nom: 'John Gibson', limite: 58 }, { nom: 'Chris Gibson', limite: 57 }, { nom: 'Sebastian Cossa', limite: 50 }];
  const trouver = R.apparieur(lims, l => l.nom, ['Jacob Markstrom', 'Jake Oettinger', 'John Gibson', 'Chris Gibson', 'Seb Cossa']);
  egal(trouver('Jacob Markstrom')?.limite, 60, '« Markstrom, Jacob » apparié');
  egal(trouver('Jake Oettinger')?.limite, 62, '« J. Oettinger » apparié par l’initiale');
  egal(trouver('John Gibson')?.limite, 58, 'John Gibson reçoit sa limite');
  egal(trouver('Chris Gibson')?.limite, 57, 'Chris Gibson reçoit la sienne');
  egal(trouver('Seb Cossa')?.limite, 50, 'Nom de famille unique et même initiale : apparié');
  const unSeulGibson = R.apparieur([{ nom: 'Chris Gibson', limite: 57 }], l => l.nom, ['John Gibson', 'Chris Gibson']);
  egal(unSeulGibson('John Gibson'), null, 'Deux Gibson dans la ligue : jamais d’appariement par le nom de famille seul');
  egal(R.apparieur([{ nom: 'Adam Hill', limite: 40 }], l => l.nom, ['Bruno Hill'])('Bruno Hill'), null, 'Initiales contradictoires : pas d’appariement');

  /* =================================================================
     3. SAISON EN COURS
     ================================================================= */
  section('Saison en cours');
  let s = await R.determinerSaison({ connue: 21, recuperer: serveur({ [URL_MATCHS(22)]: PAGE_Y22_CE_SOIR }).recuperer });
  egal(s.saison, 22, 'Dernière connue Y21, page Y22 en ligne : saison Y22');
  s = await R.determinerSaison({ connue: 22, recuperer: serveur({ [URL_MATCHS(22)]: PAGE_Y22_CE_SOIR }).recuperer });
  egal(s.saison, 22, 'Saison Y22 confirmée tant que Y23 n’existe pas');
  s = await R.determinerSaison({ connue: 22, recuperer: serveur({ [URL_MATCHS(22)]: PAGE_Y22_CE_SOIR, [URL_MATCHS(23)]: pageMatchs(23, 'mardi, oct 12 2027', []) }).recuperer });
  egal(s.saison, 23, 'Page Y23 en ligne : passage à Y23');
  s = await R.determinerSaison({ connue: 21, forcee: 22, recuperer: serveur({ [URL_MATCHS(22)]: PAGE_Y22_CE_SOIR }).recuperer });
  egal(s.saison, 22, 'Saison forcée par SAISON');
  s = await R.determinerSaison({ connue: 22, recuperer: serveur({ [URL_MATCHS(22)]: PAGE_Y22_CE_SOIR, [URL_MATCHS(23)]: '<html><body>Page non trouvée</body></html>' }).recuperer });
  egal(s.saison, 22, 'Fausse page 404 (statut 200) traitée comme absente');
  let err = null;
  try { await R.determinerSaison({ connue: 21, recuperer: serveur({ [URL_MATCHS(22)]: ANTI_ROBOT }).recuperer }); } catch (e) { err = e; }
  ok(err instanceof R.ErreurReleve && /anti-robot/.test(err.message), 'Page anti-robot : relève refusée plutôt que de deviner la saison');
  err = null;
  try { await R.determinerSaison({ connue: 21, recuperer: serveur({}).recuperer }); } catch (e) { err = e; }
  ok(err instanceof R.ErreurReleve, 'Aucune page des matchs : relève refusée');
  err = null;
  try { await R.determinerSaison({ connue: null, recuperer: serveur({}).recuperer }); } catch (e) { err = e; }
  ok(err instanceof R.ErreurReleve && /SAISON/.test(err.message), 'Aucune saison connue : demande de définir SAISON');

  /* =================================================================
     4. RELÈVE DE BOUT EN BOUT
     ================================================================= */
  section('Relève : ce soir (Y22 sans match, limites Y22 pas publiées)');
  const r1 = dossierTemp();
  fs.writeFileSync(path.join(r1, 'limites.json'), LIMITES_Y21_DEPOT);
  const s1 = serveur(pagesCeSoir());
  const res1 = await R.releve({ racine: r1, recuperer: s1.recuperer, env: { GITHUB_REPOSITORY: 'merciermathieu5/gestiongardiens' }, journal: silence, maintenant: () => MAINTENANT });
  const d1 = lireJsonDe(r1, 'data/gardiens.json');
  egal(d1.saison, 22, 'Saison Y22');
  egal(d1.equipes.length, 32, '32 équipes');
  egal(d1.equipes.reduce((t, e) => t + e.gardiens.length, 0), 91, '91 gardiens par équipe, avant le premier match');
  ok(d1.equipes.every(e => e.gardiens.every(g => g.mj === 0 && g.v === 0 && g.d === 0 && g.n === 0)), 'Tous à 0-0-0, MJ 0');
  egal(d1.limites.statut, 'a-venir', 'Limites Y22 à venir');
  ok(d1.equipes.every(e => e.gardiens.every(g => g.limite === null)), 'Aucune limite Y21 appliquée à Y22');
  egal(d1.matchs.asOf, 'mardi, oct 13 2026', 'Date de la ligue reprise');
  egal(d1.alignements.maj, 'oct 13 2026', 'Date du relevé des alignements reprise');
  egal(d1.depot, 'merciermathieu5/gestiongardiens', 'Dépôt noté (lien vers le workflow)');
  tableauEgal(d1.avertissements, [], 'Aucun avertissement');
  const sj = d1.equipes.find(e => e.code === 'SANJOSE');
  tableauEgal(sj.gardiens.map(g => g.nom), ['Philippe Desrosiers', 'Rasmus Korhonen', 'Tyler Wall'], 'San Jose : Desrosiers, Korhonen, Wall');
  egal(sj.fiche, '0-0-0', 'San Jose : fiche 0-0-0');
  ok(d1.equipes.find(e => e.code === 'UTAH').gardiens.find(g => g.nom === 'Adam Gajan').clubEcole === true, 'Utah : Gajan marqué hors alignement');
  egal(d1.equipes.find(e => e.code === 'ST.LOUIS').nom, 'St. Louis', 'Nom affiché de ST.LOUIS');
  const l1 = lireJsonDe(r1, 'limites.json');
  ok(l1.saison === 22 && l1.statut === 'a-venir' && l1.nombre === 0 && Array.isArray(l1.limites) && l1.limites.length === 0, 'limites.json (lu par les DG) : Y22 à venir, liste vide');
  ok(res1.limitesEcrites, 'limites.json réécrit (Y21 → Y22)');
  egal(s1.appels.length, 4, '4 requêtes seulement (matchs Y22 et Y23, alignements, dossiers)');
  ok(!s1.appels.some(u => /StatsGoalies\.php|allorigins|corsproxy|codetabs/.test(u)), 'Ni page PHP ni relais public');

  const res1b = await R.releve({ racine: r1, recuperer: serveur(pagesCeSoir()).recuperer, env: {}, journal: silence, maintenant: () => new Date('2026-10-15T12:23:00Z') });
  egal(res1b.limitesEcrites, false, 'Deuxième passage : limites.json inchangé, pas réécrit');
  egal(lireJsonDe(r1, 'limites.json').horodatage, l1.horodatage, 'Horodatage des limites conservé');
  egal(lireJsonDe(r1, 'data/gardiens.json').genere, '2026-10-15T12:23:00.000Z', 'data/gardiens.json : nouvel horodatage de relève');
  egal(lireJsonDe(r1, 'data/gardiens.json').depot, 'merciermathieu5/gestiongardiens', 'Dépôt conservé d’un passage à l’autre');

  section('Relève : saison commencée et classeur Y22 publié (simulation)');
  const r2 = dossierTemp();
  fs.mkdirSync(path.join(r2, 'data'));
  fs.copyFileSync(path.join(r1, 'data/gardiens.json'), path.join(r2, 'data/gardiens.json'));
  fs.copyFileSync(path.join(r1, 'limites.json'), path.join(r2, 'limites.json'));
  await R.releve({ racine: r2, recuperer: serveur(pagesSaisonCommencee()).recuperer, env: {}, journal: silence, maintenant: () => new Date('2027-01-12T12:23:00Z') });
  const d2 = lireJsonDe(r2, 'data/gardiens.json');
  const g2 = nom => d2.equipes.flatMap(e => e.gardiens.map(g => ({ ...g, equipe: e.code }))).find(g => g.nom === nom);
  egal(d2.limites.statut, 'publiees', 'Limites Y22 publiées');
  egal(d2.limites.nombre, 88, '88 limites lues dans le classeur Y22');
  ok(d2.limites.source.endsWith('/y22/gestiongardiensy22.htm'), 'Source : classeur du dossier y22');
  egal(d2.matchs.lignes, 12, '12 lignes de matchs lues (Blomqvist sur deux lignes)');
  ok(g2('Philippe Desrosiers').mj === 66 && g2('Philippe Desrosiers').limite === 65, 'Desrosiers : 66 matchs, limite 65');
  ok(g2('Andrey Vasilevskiy').mj === 64 && g2('Andrey Vasilevskiy').limite === 64, 'Vasilevskiy : 64 sur 64');
  egal(g2('Tyler Wall').mj, 3, 'Wall : MJ 3 (GP 5 ignoré)');
  egal(g2('John Gibson').limite, 58, 'John Gibson : limite 58');
  egal(g2('Chris Gibson').limite, 57, 'Chris Gibson : limite 57');
  const blom = g2('Joel Blomqvist');
  ok(blom.equipe === 'BOSTON' && blom.mj === 15 && blom.v === 8 && blom.d === 7, 'Blomqvist (échangé) : 10 MJ à NSH + 5 à BOS, rangé à Boston');
  tableauEgal(blom.equipesStats, ['NSH', 'BOS'], 'Blomqvist : équipes des matchs notées');
  egal(g2('Michael Hrabal').mj, 1, 'Hrabal (sans numéro) : 1 match');
  const simule = g2('Jean Simule');
  ok(simule && simule.equipe === 'SANJOSE' && simule.horsReleve === true, 'Gardien absent des alignements rangé avec son équipe des matchs');
  egal(d2.equipes.find(e => e.code === 'SANJOSE').abbr, 'SJ', 'Abréviation lue sur la page des matchs');
  egal(d2.equipes.find(e => e.code === 'SANJOSE').matchs, 71, 'Matchs d’équipe lus dans les totaux');
  egal(d2.limitesNonAssociees.length, 12, '12 limites Y22 sans gardien correspondant');
  ok(d2.avertissements.some(a => a.includes('Jean Simule')) && d2.avertissements.some(a => a.includes('Blomqvist')), 'Avertissements : gardien hors relevé et matchs additionnés');
  const l2 = lireJsonDe(r2, 'limites.json');
  ok(l2.saison === 22 && l2.statut === 'publiees' && l2.limites.length === 88 && l2.limites[0].nom && Number.isFinite(l2.limites[0].limite), 'limites.json : 88 limites Y22, format { nom, limite } des DG');

  section('Relève : garde-fous');
  // Page anti-robot : rien n'est écrit
  const r3 = dossierTemp();
  fs.writeFileSync(path.join(r3, 'limites.json'), LIMITES_Y21_DEPOT);
  err = null;
  try { await R.releve({ racine: r3, recuperer: serveur({ ...pagesCeSoir(), [URL_MATCHS(22)]: ANTI_ROBOT }).recuperer, env: {}, journal: silence }); } catch (e) { err = e; }
  ok(err instanceof R.ErreurReleve, 'Page anti-robot : relève refusée');
  ok(!fs.existsSync(path.join(r3, 'data/gardiens.json')), 'Aucun data/gardiens.json écrit');
  egal(fs.readFileSync(path.join(r3, 'limites.json'), 'utf8'), LIMITES_Y21_DEPOT, 'limites.json laissé intact');

  // Page des matchs vidée alors que le relevé précédent avait des matchs
  const avant2 = fs.readFileSync(path.join(r2, 'data/gardiens.json'), 'utf8');
  err = null;
  try { await R.releve({ racine: r2, recuperer: serveur({ ...pagesSaisonCommencee(), [URL_MATCHS(22)]: PAGE_Y22_CE_SOIR }).recuperer, env: {}, journal: silence }); } catch (e) { err = e; }
  ok(err instanceof R.ErreurReleve && /plus aucun gardien/.test(err.message), 'Page des matchs vidée : relève refusée');
  egal(fs.readFileSync(path.join(r2, 'data/gardiens.json'), 'utf8'), avant2, 'Relevé précédent laissé intact');

  // Totaux d'équipes avec des matchs mais aucune ligne de gardien (format changé)
  const totauxSeuls = pageMatchs(22, 'lundi, janv 11 2027', [['SANJOSE', ['GOALTENDING', 'NOUVEL EN-TETE', TIRETS, 'SANJOSE Totals              SJ   71 4230  2,55  44  22   5   3 180 1960  ,908'].join('\n')]]);
  err = null;
  try { await R.releve({ racine: dossierTemp(), recuperer: serveur({ ...pagesCeSoir(), [URL_MATCHS(22)]: totauxSeuls }).recuperer, env: { SAISON: '22' }, journal: silence }); } catch (e) { err = e; }
  ok(err instanceof R.ErreurReleve && /format changé/.test(err.message), 'Matchs d’équipe sans ligne de gardien lisible : relève refusée');

  // Alignements inaccessibles : reprise du relevé précédent
  const r4 = dossierTemp();
  fs.mkdirSync(path.join(r4, 'data'));
  fs.copyFileSync(path.join(r1, 'data/gardiens.json'), path.join(r4, 'data/gardiens.json'));
  fs.copyFileSync(path.join(r1, 'limites.json'), path.join(r4, 'limites.json'));
  await R.releve({ racine: r4, recuperer: serveur({ ...pagesCeSoir(), [URL_ALIGNEMENTS]: { statut: 503, texte: 'indisponible' } }).recuperer, env: {}, journal: silence });
  const d4 = lireJsonDe(r4, 'data/gardiens.json');
  ok(d4.alignements.repris === true && d4.equipes.reduce((t, e) => t + e.gardiens.length, 0) === 91, 'Alignements inaccessibles : 91 gardiens repris du relevé précédent');
  ok(d4.avertissements.some(a => /alignements inaccessible/.test(a)), 'Avertissement de reprise');
  err = null;
  try { await R.releve({ racine: dossierTemp(), recuperer: serveur({ ...pagesCeSoir(), [URL_ALIGNEMENTS]: { statut: 503, texte: '' } }).recuperer, env: { SAISON: '22' }, journal: silence }); } catch (e) { err = e; }
  ok(err instanceof R.ErreurReleve, 'Alignements inaccessibles sans relevé précédent : relève refusée');

  // Dossier des limites inaccessible : limites de la même saison reprises
  const r5 = dossierTemp();
  fs.mkdirSync(path.join(r5, 'data'));
  fs.copyFileSync(path.join(r2, 'data/gardiens.json'), path.join(r5, 'data/gardiens.json'));
  fs.copyFileSync(path.join(r2, 'limites.json'), path.join(r5, 'limites.json'));
  const avantLimites5 = fs.readFileSync(path.join(r5, 'limites.json'), 'utf8');
  const res5 = await R.releve({ racine: r5, recuperer: serveur({ ...pagesSaisonCommencee(), [URL_DOSSIERS]: { statut: 503, texte: '' } }).recuperer, env: {}, journal: silence });
  const d5 = lireJsonDe(r5, 'data/gardiens.json');
  ok(d5.limites.statut === 'publiees' && d5.limites.repris === true && d5.limites.nombre === 88, 'Dossier inaccessible : 88 limites Y22 reprises');
  egal(lireJsonDe(r5, 'data/gardiens.json').equipes.find(e => e.code === 'SANJOSE').gardiens[0].limite, 65, 'Desrosiers garde sa limite 65');
  ok(!res5.limitesEcrites && fs.readFileSync(path.join(r5, 'limites.json'), 'utf8') === avantLimites5, 'limites.json inchangé');

  // Classeur Y22 en ligne mais illisible
  const r6 = dossierTemp();
  fs.writeFileSync(path.join(r6, 'limites.json'), LIMITES_Y21_DEPOT);
  const illisible = { ...pagesSaisonCommencee(), [URL_DOSSIERS + 'y22/gestiongardiensy22_fichiers/sheet001.htm']: '<html><body><table><tr><td>Feuille en construction</td></tr></table></body></html>' };
  await R.releve({ racine: r6, recuperer: serveur(illisible).recuperer, env: {}, journal: silence });
  const d6 = lireJsonDe(r6, 'data/gardiens.json');
  egal(d6.limites.statut, 'illisible', 'Classeur illisible : statut « illisible »');
  egal(d6.matchs.lignes, 12, 'Les matchs sont quand même relevés');
  ok(fs.existsSync(path.join(r6, 'diagnostic', 'limites-sheet001.htm')), 'Copie brute déposée dans diagnostic/');
  ok(d6.avertissements.some(a => a.includes('y22') && a.includes('diagnostic/')), 'Avertissement avec le dossier de diagnostic');
  egal(lireJsonDe(r6, 'limites.json').statut, 'illisible', 'limites.json : statut illisible, sans limites Y21');

  // Nouvelle saison : Y23 démarre, limites Y23 pas publiées
  const r7 = dossierTemp();
  fs.mkdirSync(path.join(r7, 'data'));
  fs.copyFileSync(path.join(r2, 'data/gardiens.json'), path.join(r7, 'data/gardiens.json'));
  fs.copyFileSync(path.join(r2, 'limites.json'), path.join(r7, 'limites.json'));
  await R.releve({ racine: r7, recuperer: serveur({ ...pagesSaisonCommencee(), [URL_MATCHS(23)]: pageMatchs(23, 'mardi, oct 12 2027', []) }).recuperer, env: {}, journal: silence });
  const d7 = lireJsonDe(r7, 'data/gardiens.json');
  ok(d7.saison === 23 && d7.limites.statut === 'a-venir', 'Y23 : nouvelle saison, limites à venir');
  ok(d7.equipes.every(e => e.gardiens.every(g => g.mj === 0 && g.limite === null)), 'Y23 : compteurs à zéro, aucune limite Y22 reportée');
  egal(lireJsonDe(r7, 'limites.json').saison, 23, 'limites.json passe à Y23');
  err = null;
  try { await R.releve({ racine: r7, recuperer: serveur({ [URL_MATCHS(22)]: PAGE_Y22_COMMENCEE, [URL_ALIGNEMENTS]: ROSTERS, [URL_DOSSIERS]: INDEX_SAISONS(22) }).recuperer, env: { SAISON: '22' }, journal: silence }); } catch (e) { err = e; }
  ok(err instanceof R.ErreurReleve && /antérieure/.test(err.message), 'Jamais de retour à une saison précédente');

  /* =================================================================
     5. ALERTES COURRIEL
     ================================================================= */
  section('Alertes courriel');
  const ra = dossierTemp();
  fs.mkdirSync(path.join(ra, 'data'));
  fs.copyFileSync(path.join(r2, 'data/gardiens.json'), path.join(ra, 'data/gardiens.json'));
  const sorties = [];
  const capter = async (n, v) => { sorties.push(n + '=' + v); };
  const quand = () => new Date('2027-01-12T12:24:00Z');
  let a1 = await A.verifier({ racine: ra, env: {}, journal: silence, maintenant: quand, sortie: capter });
  egal(a1.envoyer, true, 'Premier dépassement : courriel à envoyer');
  egal(a1.depassements.length, 1, 'Un seul gardien en dépassement (Desrosiers)');
  egal(a1.objet, '🚨 USHL Y22 : 1 gardien a dépassé sa limite de matchs', 'Objet du courriel');
  ok(sorties.includes('envoyer=true') && sorties.some(x => x.startsWith('objet=🚨 USHL Y22')), 'Sorties du workflow : envoyer et objet');
  const courriel = fs.readFileSync(path.join(ra, 'courriel-alerte.html'), 'utf8');
  ok(courriel.includes('Philippe Desrosiers') && courriel.includes('San Jose') && courriel.includes('+1'), 'Courriel : gardien, équipe et écart');
  ok(courriel.includes('saison Y22') && !courriel.includes('Y21'), 'Courriel : saison Y22 (plus de « Y21 » écrit en dur)');
  ok(courriel.includes('https://merciermathieu5.github.io/gestiongardiens/'), 'Courriel : lien vers l’interface');
  ok(courriel.includes('Nouveau') && courriel.includes('lundi, janv 11 2027'), 'Courriel : signalement « Nouveau » et date de la ligue');
  ok(!/[—]/.test(courriel + a1.objet), 'Courriel sans tiret cadratin');
  ok(fs.existsSync(path.join(ra, 'alertes-etat-candidat.json')), 'État candidat déposé');
  ok(!fs.existsSync(path.join(ra, 'data/alertes-envoyees.json')), 'État officiel pas encore modifié (en attente de l’envoi)');

  // Courriel non parti : le passage suivant réessaie
  let a2 = await A.verifier({ racine: ra, env: {}, journal: silence, maintenant: quand, sortie: capter });
  egal(a2.envoyer, true, 'Courriel non parti : l’alerte est retentée au passage suivant');

  // Courriel parti : le workflow met l'état candidat en place
  fs.renameSync(path.join(ra, 'alertes-etat-candidat.json'), path.join(ra, 'data/alertes-envoyees.json'));
  let a3 = await A.verifier({ racine: ra, env: {}, journal: silence, maintenant: quand, sortie: capter });
  ok(a3.envoyer === false && a3.etatEcrit === false, 'Même situation après l’envoi : aucun nouveau courriel');

  // L'écart augmente
  const donneesA = lireJsonDe(ra, 'data/gardiens.json');
  const desro = donneesA.equipes.find(e => e.code === 'SANJOSE').gardiens.find(g => g.nom === 'Philippe Desrosiers');
  desro.mj = 68; desro.v = 43;
  const vasi = donneesA.equipes.find(e => e.code === 'WASHINGTON').gardiens.find(g => g.nom === 'Andrey Vasilevskiy');
  vasi.mj = 65; vasi.v = 41;
  fs.writeFileSync(path.join(ra, 'data/gardiens.json'), JSON.stringify(donneesA));
  let a4 = await A.verifier({ racine: ra, env: {}, journal: silence, maintenant: quand, sortie: capter });
  ok(a4.envoyer && a4.nouveaux.length === 2, 'Écart accru (Desrosiers) et nouveau dépassement (Vasilevskiy) : 2 à signaler');
  egal(a4.objet, '🚨 USHL Y22 : 2 gardiens ont dépassé leur limite de matchs', 'Objet au pluriel');
  const courriel4 = fs.readFileSync(path.join(ra, 'courriel-alerte.html'), 'utf8');
  ok(courriel4.includes('Écart accru (était +1)') && courriel4.includes('+3'), 'Courriel : écart accru de +1 à +3');
  fs.renameSync(path.join(ra, 'alertes-etat-candidat.json'), path.join(ra, 'data/alertes-envoyees.json'));

  // Limite corrigée : Desrosiers ne dépasse plus, l'état suit sans courriel
  desro.mj = 60; desro.v = 35;
  fs.writeFileSync(path.join(ra, 'data/gardiens.json'), JSON.stringify(donneesA));
  let a5 = await A.verifier({ racine: ra, env: {}, journal: silence, maintenant: quand, sortie: capter });
  ok(a5.envoyer === false && a5.etatEcrit === true, 'Plus de dépassement pour Desrosiers : état mis à jour sans courriel');
  tableauEgal(Object.keys(lireJsonDe(ra, 'data/alertes-envoyees.json').gardiens), ['andreyvasilevskiy'], 'État : seul Vasilevskiy reste');

  // Nouvelle saison : remise à zéro
  donneesA.saison = 23;
  for (const e of donneesA.equipes) for (const g of e.gardiens) { g.mj = 0; g.limite = null; }
  donneesA.limites = { statut: 'a-venir' };
  fs.writeFileSync(path.join(ra, 'data/gardiens.json'), JSON.stringify(donneesA));
  let a6 = await A.verifier({ racine: ra, env: {}, journal: silence, maintenant: quand, sortie: capter });
  ok(a6.envoyer === false && a6.etatEcrit === true, 'Nouvelle saison : aucun courriel');
  tableauEgal(lireJsonDe(ra, 'data/alertes-envoyees.json'), { saison: 23, gardiens: {} }, 'État remis à zéro pour Y23');

  // Limites à venir et aucun état : rien n'est créé
  const rb = dossierTemp();
  fs.mkdirSync(path.join(rb, 'data'));
  fs.copyFileSync(path.join(r1, 'data/gardiens.json'), path.join(rb, 'data/gardiens.json'));
  let a7 = await A.verifier({ racine: rb, env: {}, journal: silence, maintenant: quand, sortie: capter });
  ok(a7.envoyer === false && !fs.existsSync(path.join(rb, 'data/alertes-envoyees.json')), 'Limites à venir : aucun courriel, aucun fichier d’état créé');
  egal(A.urlTableau('merciermathieu5/gestiongardiens'), 'https://merciermathieu5.github.io/gestiongardiens/', 'Adresse de l’interface');

  /* =================================================================
     6. INTERFACE (jsdom)
     ================================================================= */
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  async function ouvrir({ donnees = null, statut = 200, rejet = false, cache = null, admin = false, stockage = {} } = {}) {
    const appels = [];
    const dom = new JSDOM(html, {
      runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://merciermathieu5.github.io/gestiongardiens/',
      beforeParse(w) {
        for (const [k, v] of Object.entries(stockage)) w.localStorage.setItem(k, v);
        if (cache) w.localStorage.setItem('ushl_gardiens_cache_v3', JSON.stringify(cache));
        if (admin) w.sessionStorage.setItem('ushl_gardiens_admin_session', '1');
        w.fetch = async u => {
          appels.push(String(u));
          if (rejet) throw new Error('réseau coupé');
          return { ok: statut >= 200 && statut < 300, status: statut, json: async () => JSON.parse(JSON.stringify(donnees)) };
        };
        w.__reponse = null;
        w.prompt = () => w.__reponse;
        w.confirm = () => true;
        w.alert = () => {};
        if (!w.crypto || !w.crypto.subtle) Object.defineProperty(w, 'crypto', { value: require('crypto').webcrypto, configurable: true });
        if (!w.TextEncoder) w.TextEncoder = TextEncoder;
      }
    });
    await attendre(60);
    const d = dom.window.document;
    const texte = sel => (d.querySelector(sel)?.textContent || '').replace(/\s+/g, ' ').trim();
    return { dom, w: dom.window, d, appels, texte };
  }
  const lignes = d => [...d.querySelectorAll('#contenu tbody tr')];
  const ligneDe = (d, nom) => lignes(d).find(tr => tr.querySelector('.g-nom').textContent.includes(nom));

  section('Interface : ce soir (gardiens par équipe, limites à venir)');
  let ui = await ouvrir({ donnees: d1, stockage: { ushl_gardiens_urls_v1: '{"urlStats":"x"}', ushl_gardiens_proxy_prefere_v1: '"allorigins"' } });
  egal(ui.d.title, 'USHL · Suivi des gardiens Y22', 'Titre de l’onglet avec la saison');
  ok(ui.texte('.sous-titre').endsWith('· Y22'), 'Sous-titre : saison Y22 tirée des données');
  egal(ui.d.querySelectorAll('#contenu .equipe').length, 32, '32 cartes d’équipe affichées');
  egal(lignes(ui.d).length, 91, '91 gardiens affichés avant le premier match');
  ok(lignes(ui.d).every(tr => tr.children[1].textContent === '0-0-0' && tr.children[2].textContent === '0'), 'Chaque gardien : 0-0-0, MJ 0');
  egal(ui.d.querySelectorAll('#contenu .badge.b-avenir').length, 91, '91 badges « Limite à venir »');
  ok(!ui.d.getElementById('puceSansLimite').hidden && ui.texte('#sSansLimite') === '91' && ui.texte('#libSansLimite') === 'Limite à venir', 'Pastille du sommaire : 91 limites à venir');
  ok(ui.texte('#avis').includes('Les limites Y22 ne sont pas encore publiées'), 'Avis : limites Y22 pas encore publiées');
  ok(ui.texte('#majReleve').startsWith('Relevé du robot :') && ui.texte('#majLigue').includes('mardi, oct 13 2026'), 'En-tête : date du relevé et date de la ligue');
  tableauEgal(ui.appels.map(u => u.split('?')[0]), ['data/gardiens.json'], 'Une seule requête : data/gardiens.json, en même origine');
  ok(!/allorigins|corsproxy|codetabs|workers\.dev|StatsGoalies/.test(html), 'Aucun relais public ni page PHP dans le code de l’interface');
  ok(ui.w.localStorage.getItem('ushl_gardiens_urls_v1') === null && ui.w.localStorage.getItem('ushl_gardiens_proxy_prefere_v1') === null, 'Anciennes clés (sources, relais) effacées du navigateur');
  const carteSJ = ui.d.querySelector('.equipe[data-equipe="SANJOSE"]');
  tableauEgal([...carteSJ.querySelectorAll('tbody tr')].map(tr => tr.querySelector('.g-nom').childNodes[0].textContent), ['Philippe Desrosiers', 'Rasmus Korhonen', 'Tyler Wall'], 'Carte San Jose : gardiens par OV décroissant');
  ok(carteSJ.querySelector('.abbr').textContent === 'SJ' && carteSJ.textContent.includes('Fiche 0-0-0'), 'Carte San Jose : abréviation et fiche');
  ok(ligneDe(ui.d, 'Adam Gajan').textContent.includes('hors alignement'), 'Gajan (Utah) : étiquette hors alignement');
  egal(ui.d.querySelector('#contenu .equipe .nom').textContent, 'Anaheim', 'Équipes en ordre alphabétique (Anaheim en premier)');

  const recherche = ui.d.getElementById('recherche');
  recherche.value = 'desros'; recherche.dispatchEvent(new ui.w.Event('input'));
  egal(lignes(ui.d).length, 1, 'Recherche « desros » : 1 gardien');
  recherche.value = 'san jose'; recherche.dispatchEvent(new ui.w.Event('input'));
  egal(lignes(ui.d).length, 3, 'Recherche « san jose » : 3 gardiens');
  recherche.value = ''; recherche.dispatchEvent(new ui.w.Event('input'));
  ui.d.querySelector('.filtre-btn[data-filtre="alerte"]').click();
  ok(ui.texte('#contenu').includes('pas encore publiées'), 'Filtre « En alerte » : explique que les limites ne sont pas publiées');
  ui.d.querySelector('.filtre-btn[data-filtre="tous"]').click();

  ui.w.__reponse = '60';
  ligneDe(ui.d, 'Philippe Desrosiers').querySelector('.limite-cell').click();
  let tr = ligneDe(ui.d, 'Philippe Desrosiers');
  ok(tr.querySelector('.limite-cell').textContent === '60man.' && tr.dataset.statut === 'ok', 'Limite saisie à la main : 60, « man. », en règle');
  egal(JSON.parse(ui.w.localStorage.getItem('ushl_gardiens_limites_manuelles_v1')).philippedesrosiers, 60, 'Saisie gardée dans ce navigateur');
  egal(ui.texte('#sOk'), '1', 'Sommaire : 1 gardien en règle');
  ui.d.getElementById('zoneCollage').value = 'Philippe Desrosiers\t65\nTyler Wall\t40\nGardien Disparu\t50';
  ui.d.getElementById('btnImporterCollage').click();
  ok(ui.texte('#resultatCollage') === '3 limites importées.', 'Collage : 3 limites importées');
  ok(ligneDe(ui.d, 'Tyler Wall').querySelector('.limite-cell').textContent === '40coll.', 'Wall : limite collée 40 « coll. »');
  ok(ligneDe(ui.d, 'Philippe Desrosiers').querySelector('.limite-cell').textContent === '60man.', 'La saisie manuelle garde priorité sur le collage');
  ok(!ui.d.getElementById('panneauNonAssocies').hidden && ui.texte('#corpsNonAssocies').includes('Gardien Disparu'), 'Limite collée sans gardien : listée comme non associée');
  ui.w.__reponse = '';
  ligneDe(ui.d, 'Philippe Desrosiers').querySelector('.limite-cell').click();
  ok(ligneDe(ui.d, 'Philippe Desrosiers').querySelector('.limite-cell').textContent === '65coll.', 'Saisie effacée : retour à la limite collée');
  ui.dom.window.close();

  section('Interface : saison commencée (simulation)');
  ui = await ouvrir({ donnees: d2 });
  egal(lignes(ui.d).length, 92, '92 gardiens (91 + 1 absent du relevé)');
  egal(ligneDe(ui.d, 'Philippe Desrosiers').dataset.statut, 'depasse', 'Desrosiers : dépassement');
  ok(ligneDe(ui.d, 'Philippe Desrosiers').textContent.includes('Dépassement') && ligneDe(ui.d, 'Philippe Desrosiers').children[4].textContent === '-1', 'Desrosiers : badge et -1 restant');
  egal(ligneDe(ui.d, 'Andrey Vasilevskiy').dataset.statut, 'lampe', 'Vasilevskiy : limite atteinte');
  egal(ligneDe(ui.d, 'Ilya Samsonov').dataset.statut, 'alerte', 'Samsonov : alerte (3 restants)');
  egal(ligneDe(ui.d, 'Daniil Tarasov').dataset.statut, 'ok', 'Tarasov : en règle');
  egal(ligneDe(ui.d, 'Rasmus Korhonen').dataset.statut, 'inconnu', 'Korhonen (absent du classeur) : limite ?');
  tableauEgal([ui.texte('#sGardiens'), ui.texte('#sOk'), ui.texte('#sAlerte'), ui.texte('#sLampe'), ui.texte('#sSansLimite')], ['92', '73', '1', '2', '16'], 'Sommaire : 92 gardiens, 73 en règle, 1 en alerte, 2 à la limite, 16 sans limite');
  ok(ui.texte('#libSansLimite') === 'Sans limite', 'Pastille « Sans limite » une fois les limites publiées');
  ok(ligneDe(ui.d, 'Joel Blomqvist').textContent.includes('MJ additionnés : NSH + BOS'), 'Blomqvist : MJ additionnés NSH + BOS');
  ok(ligneDe(ui.d, 'Jean Simule').textContent.includes('absent du relevé'), 'Jean Simule : absent du relevé');
  ok(!ui.d.getElementById('panneauAvertissements').hidden && ui.texte('#nbAvertissements') === String(d2.avertissements.length), 'Avertissements du robot listés');
  ok(ui.texte('#nbNonAssocies') === '12', '12 limites non associées');
  ok(!ui.texte('#avis').includes('pas encore publiées'), 'Plus d’avis « à venir »');
  ui.d.querySelector('.filtre-btn[data-filtre="lampe"]').click();
  tableauEgal(lignes(ui.d).map(t => t.dataset.statut).sort(), ['depasse', 'lampe'], 'Filtre « Limite atteinte » : dépassement et limite atteinte seulement');
  ui.d.querySelector('.filtre-btn[data-filtre="alerte"]').click();
  egal(lignes(ui.d).length, 3, 'Filtre « En alerte » : 3 gardiens');
  ui.d.querySelector('.filtre-btn[data-filtre="tous"]').click();
  const tri = ui.d.getElementById('tri');
  tri.value = 'restants'; tri.dispatchEvent(new ui.w.Event('change'));
  ok(ui.d.querySelector('#contenu tbody tr').textContent.includes('Philippe Desrosiers'), 'Tri par matchs restants : Desrosiers en tête');
  ui.dom.window.close();

  section('Interface : relevé introuvable, cache, fraîcheur, admin');
  ui = await ouvrir({ rejet: true });
  ok(ui.texte('#avis').includes('onglet Actions'), 'Relevé introuvable sans cache : marche à suivre affichée');
  ok(ui.texte('#contenu').includes('Aucun relevé'), 'Aucun gardien affiché');
  ui.dom.window.close();
  ui = await ouvrir({ statut: 404, cache: d1 });
  egal(lignes(ui.d).length, 91, 'Fichier en erreur : les 91 gardiens du cache restent affichés');
  ok(ui.texte('#avis').includes('Données en cache') && ui.texte('#avis').includes('HTTP 404'), 'Avis : cache affiché et erreur HTTP 404');
  ui.dom.window.close();
  const vieux = { ...d1, genere: new Date(Date.now() - 3 * 86400000).toISOString() };
  ui = await ouvrir({ donnees: vieux });
  ok(ui.texte('#avis').includes('date de 3 jour(s)'), 'Relevé vieux de 3 jours : avis que le robot ne passe peut-être plus');
  ok(ui.d.getElementById('panneauRobot').hidden, 'Panneau du robot caché sans connexion admin');
  ui.d.getElementById('champUtilisateur').value = 'USHL';
  ui.d.getElementById('champMdp').value = 'mauvais';
  ui.d.getElementById('btnConnexion').click();
  await attendre(40);
  ok(ui.texte('#erreurConnexion') === 'Nom d\'utilisateur ou mot de passe incorrect.', 'Mauvais mot de passe refusé');
  ui.dom.window.close();
  ui = await ouvrir({ donnees: { ...d1, amorce: true }, admin: true });
  ok(!ui.d.getElementById('panneauRobot').hidden, 'Session admin : panneau du robot visible');
  egal(ui.d.getElementById('lienWorkflow').href, 'https://github.com/merciermathieu5/gestiongardiens/actions/workflows/releve-gardiens.yml', 'Lien « Lancer une relève maintenant »');
  ok(ui.texte('#ficheRobot').includes('Y22') && ui.texte('#ficheRobot').includes('à venir'), 'Fiche du robot : saison et statut des limites');
  ok(ui.texte('#majReleve').startsWith('Relevé initial :') && ui.texte('#avis').includes('Relevé initial'), 'Relevé initial signalé comme tel');
  ui.dom.window.close();

  /* =================================================================
     7. FICHIERS DU DÉPÔT
     ================================================================= */
  section('Fichiers du dépôt');
  const wf = fs.readFileSync(path.join(__dirname, '.github', 'workflows', 'releve-gardiens.yml'), 'utf8');
  ok(/schedule:/.test(wf) && /workflow_dispatch:/.test(wf), 'Workflow : horaire et bouton manuel');
  ok(/reprise:/.test(wf) && /sleep 300/.test(wf) && /needs\.relever\.outputs\.ok != 'true'/.test(wf), 'Workflow : job de reprise après 5 minutes, comme les DG');
  ok(!/git add[^\n]*\|\| true/.test(wf) && (wf.match(/git add -A/g) || []).length === 2, 'Workflow : plus de « git add ... || true » qui avalait les erreurs');
  ok((wf.match(/if: steps\.courriel\.outcome == 'success'\n\s+run: mv alertes-etat-candidat\.json data\/alertes-envoyees\.json/g) || []).length === 2, 'Workflow : état des alertes retenu seulement si le courriel est parti');
  ok(/dawidd6\/action-send-mail@v22/.test(wf) && /to: ushl_pro@hotmail\.com/.test(wf), 'Workflow : envoi à ushl_pro@hotmail.com');
  ok(!fs.existsSync(path.join(__dirname, '.github', 'workflows', 'maj-limites.yml')), 'Ancien workflow retiré (sinon deux robots écriraient limites.json)');
  const ignore = fs.readFileSync(path.join(__dirname, '.gitignore'), 'utf8');
  ok(ignore.includes('courriel-alerte.html') && ignore.includes('alertes-etat-candidat.json'), '.gitignore : fichiers de travail des alertes jamais commités');
  const textes = ['index.html', 'scripts/releve-gardiens.mjs', 'scripts/alertes-gardiens.mjs', '.github/workflows/releve-gardiens.yml', 'LISEZMOI.md']
    .map(f => [f, fs.readFileSync(path.join(__dirname, f), 'utf8')]);
  for (const [f, t] of textes) ok(!t.includes('—'), `${f} : aucun tiret cadratin`);
  const graine = path.join(__dirname, 'data', 'gardiens.json');
  if (fs.existsSync(graine)) {
    const g = JSON.parse(fs.readFileSync(graine, 'utf8'));
    ok(g.saison === 22 && g.equipes.length === 32 && g.limites.statut === 'a-venir', 'data/gardiens.json livré : Y22, 32 équipes, limites à venir');
    const lj = JSON.parse(fs.readFileSync(path.join(__dirname, 'limites.json'), 'utf8'));
    ok(lj.saison === 22 && Array.isArray(lj.limites), 'limites.json livré : Y22, liste lisible par les DG');
  }

  console.log(`\n${total - echecs}/${total} vérifications réussies`);
  process.exit(echecs ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
