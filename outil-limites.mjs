// =====================================================================
// outil-limites.mjs — Robot de lecture des limites de matchs USHL
// Exécuté par GitHub Actions (ou en local : `node outil-limites.mjs`).
// Lit le classeur Excel publié (cadres + onglets), en extrait les limites,
// et écrit `limites.json` à côté de l'interface. Aucune dépendance.
// =====================================================================

import { writeFileSync, mkdirSync } from "node:fs";

const URL_LIMITES = process.env.URL_LIMITES ||
  "https://ushl.ca/ushl/menu_ushl/gestion_dg/gestion_gardiens/y21/gestiongardiensy21.htm";

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

// ------------------------------------------------------- extraction HTML
function extraireSrcCadres(html) {
  const srcs = [];
  const re = /<i?frame[^>]+src\s*=\s*(?:["']([^"']+)["']|([^\s>"']+))/gi;
  let m;
  while ((m = re.exec(html)) !== null) srcs.push(m[1] || m[2]);
  return srcs;
}
function extraireLiensHtm(html) {
  const liens = [];
  const re = /<a[^>]+href\s*=\s*(?:["']([^"']+)["']|([^\s>"']+))/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const h = (m[1] || m[2] || "").split("#")[0];
    if (/\.html?($|\?)/i.test(h)) liens.push(h);
  }
  return liens;
}
function decoderEntites(t) {
  const accents = { eacute: "é", egrave: "è", ecirc: "ê", agrave: "à", acirc: "â",
    ccedil: "ç", ocirc: "ô", icirc: "î", iuml: "ï", ucirc: "û", ugrave: "ù", euml: "ë" };
  return t
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&([A-Za-z])(acute|grave|circ|cedil|uml);/g, (tout, lettre, sorte) => {
      const cle = (lettre + sorte).toLowerCase();
      const c = accents[cle];
      if (!c) return " ";
      return lettre === lettre.toUpperCase() ? c.toUpperCase() : c;
    })
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&[a-z]+;/gi, " ");
}
// Transforme le HTML d'une feuille en rangées de cellules texte
function rangeesDepuisHtml(html) {
  const rangees = [];
  const reTr = /<tr[\s\S]*?<\/tr>/gi;
  const reTd = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  let mTr;
  while ((mTr = reTr.exec(html)) !== null) {
    const cellules = [];
    let mTd;
    reTd.lastIndex = 0;
    while ((mTd = reTd.exec(mTr[0])) !== null) {
      const brut = mTd[1].replace(/<[^>]*>/g, " ");
      cellules.push(decoderEntites(brut).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim());
    }
    if (cellules.some(c => c !== "")) rangees.push(cellules);
  }
  return rangees;
}

// ------------------------------------------------- reconnaissance des noms
function normaliserNom(nom) {
  return String(nom).normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z]/g, "");
}
function ressembleANom(texte) {
  const t = String(texte).trim();
  if (t.length < 4 || t.length > 45) return false;
  if (/\d/.test(t)) return false;
  if (!/^[A-Za-zÀ-ÿ'.,\- ]+$/.test(t)) return false;
  const mots = t.replace(",", " ").split(/\s+/).filter(Boolean);
  if (mots.length >= 2 && mots.length <= 4) return true;
  return /^[A-Za-zÀ-ÿ]\.[A-Za-zÀ-ÿ'\-]{3,}$/.test(t);
}
function estMotSeul(texte) {
  const t = String(texte).trim();
  if (/^[A-Z]{2,4}$/.test(t)) return false; // code d'équipe (NJ, PHI, NSH...), pas un prénom
  return t.length >= 2 && t.length <= 20 && /^[A-Za-zÀ-ÿ'.\-]+$/.test(t) && !/^\d/.test(t);
}

// ------------------------------------------ analyse générique des rangées
function analyserRangees(rangees, etiquette) {
  let colLimiteEntete = -1;
  for (const r of rangees.slice(0, 40)) {
    for (let i = 0; i < r.length; i++) {
      const c = String(r[i]).toLowerCase();
      if (/(max|limite|nb|quota).{0,14}(match|partie|mj)|(match|partie|mj).{0,14}(max|limite)|^max$/.test(c)) {
        colLimiteEntete = i; break;
      }
    }
    if (colLimiteEntete >= 0) break;
  }
  const candidats = [];
  for (const r of rangees) {
    let nomTrouve = null, idxNomFin = -1;
    for (let i = 0; i < r.length; i++) {
      if (ressembleANom(r[i])) { nomTrouve = String(r[i]).trim(); idxNomFin = i; break; }
    }
    if (!nomTrouve) {
      for (let i = 0; i + 1 < r.length; i++) {
        if (estMotSeul(r[i]) && estMotSeul(r[i + 1])) {
          const joint = String(r[i]).trim() + " " + String(r[i + 1]).trim();
          if (ressembleANom(joint)) { nomTrouve = joint; idxNomFin = i + 1; break; }
        }
      }
    }
    if (!nomTrouve) continue;
    const numeriques = [];
    for (let i = 0; i < r.length; i++) {
      if (i <= idxNomFin && i >= idxNomFin - 1) continue;
      const val = String(r[i]).replace(",", ".").replace(/\s/g, "");
      if (/^\d{1,3}(\.\d+)?$/.test(val)) numeriques.push({ col: i, val: Math.round(parseFloat(val)) });
    }
    if (numeriques.length) candidats.push({ nom: nomTrouve, numeriques });
  }
  if (!candidats.length) {
    const echantillon = rangees.slice(0, 8).map(r => r.filter(Boolean).join(" | ")).join("\n    ");
    console.log("  [" + etiquette + "] aucune rangée reconnue. Échantillon :\n    " + (echantillon || "(vide)"));
    return [];
  }
  let colChoisie = colLimiteEntete;
  if (colChoisie < 0) {
    const scores = {};
    for (const c of candidats)
      for (const nq of c.numeriques)
        if (nq.val >= 25 && nq.val <= 66) scores[nq.col] = (scores[nq.col] || 0) + 1;
    let meilleur = -1, meilleurScore = 0;
    for (const col of Object.keys(scores)) {
      const cc = parseInt(col, 10);
      if (scores[col] > meilleurScore || (scores[col] === meilleurScore && cc > meilleur)) {
        meilleur = cc; meilleurScore = scores[col];
      }
    }
    colChoisie = meilleur;
  }
  if (colChoisie < 0) {
    console.log("  [" + etiquette + "] " + candidats.length + " noms trouvés, mais aucune colonne de limite plausible.");
    return [];
  }
  const limites = [];
  for (const c of candidats) {
    const nq = c.numeriques.find(x => x.col === colChoisie);
    if (nq && nq.val >= 1 && nq.val <= 82)
      limites.push({ nom: c.nom, nomNorm: normaliserNom(c.nom), limite: nq.val });
  }
  return limites;
}

// ------------------------------------------------------------- exécution
const principal = async () => {
  console.log("Lecture du classeur :", URL_LIMITES);
  const htmlCadres = await recuperer(URL_LIMITES);

  const feuilles = new Set();
  const tabstrips = [];
  for (const src of extraireSrcCadres(htmlCadres)) {
    const abs = new URL(src, URL_LIMITES).href;
    if (!/\.html?($|\?)/i.test(abs)) continue;
    if (/tabstrip/i.test(abs)) tabstrips.push(abs);
    else feuilles.add(abs);
  }
  for (const t of tabstrips) {
    try {
      const htmlTab = await recuperer(t);
      for (const lien of extraireLiensHtm(htmlTab)) {
        const abs = new URL(lien, t).href;
        if (!/tabstrip/i.test(abs)) feuilles.add(abs);
      }
    } catch (e) { console.log("Barre d'onglets inaccessible :", t, "-", e.message); }
  }
  // Sondage séquentiel de secours : sheet002, sheet003, ...
  const modele = Array.from(feuilles).find(f => /sheet0*\d+\.html?/i.test(f));
  if (modele) {
    const m = modele.match(/sheet0*(\d+)(\.html?)/i);
    const base = modele.slice(0, modele.search(/sheet0*\d+\.html?/i));
    for (let n = parseInt(m[1], 10) + 1; n <= parseInt(m[1], 10) + 10; n++) {
      const candidate = base + "sheet" + String(n).padStart(3, "0") + m[2];
      if (feuilles.has(candidate)) continue;
      try {
        const h = await recuperer(candidate);
        if (/<table|<tr/i.test(h)) feuilles.add(candidate);
        else break;
      } catch (e) { break; }
    }
  }
  if (!feuilles.size) feuilles.add(URL_LIMITES);
  console.log(feuilles.size + " feuille(s) à lire :", Array.from(feuilles).map(f => f.split("/").pop()).join(", "));

  mkdirSync("debug-limites", { recursive: true });
  let toutes = [];
  for (const f of feuilles) {
    const nomFichier = f.split("/").pop().split("?")[0] || "feuille.htm";
    try {
      const html = f === URL_LIMITES ? htmlCadres : await recuperer(f);
      writeFileSync("debug-limites/" + nomFichier, html); // copie brute pour diagnostic
      const lims = analyserRangees(rangeesDepuisHtml(html), nomFichier);
      console.log("  " + nomFichier + " : " + lims.length + " limites");
      toutes = toutes.concat(lims);
    } catch (e) {
      console.log("  " + nomFichier + " : inaccessible -", e.message);
    }
  }
  const vues = new Set();
  toutes = toutes.filter(l => (vues.has(l.nomNorm) ? false : (vues.add(l.nomNorm), true)));

  const sortie = {
    source: URL_LIMITES,
    horodatage: new Date().toISOString(),
    nombre: toutes.length,
    limites: toutes.map(({ nom, limite }) => ({ nom, limite })),
  };
  writeFileSync("limites.json", JSON.stringify(sortie, null, 1));
  console.log("limites.json écrit : " + toutes.length + " limites.");
  if (!toutes.length) {
    console.log("ATTENTION : aucune limite extraite. Les copies brutes des feuilles sont dans debug-limites/ pour analyse.");
    process.exitCode = 0; // on n'échoue pas le workflow : les copies brutes servent au diagnostic
  }
};

export { rangeesDepuisHtml, analyserRangees, extraireSrcCadres, extraireLiensHtm };

if (import.meta.url === "file://" + process.argv[1]) {
  principal().catch(e => { console.error("ERREUR :", e.message); process.exit(1); });
}
