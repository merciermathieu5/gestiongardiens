// =====================================================================
// worker-proxy.js — Proxy personnel Cloudflare Worker pour le suivi USHL
// Déploiement : dash.cloudflare.com -> Workers -> Create -> coller ce code.
// Usage par l'interface : https://ton-worker.workers.dev/?url=URL_ENCODEE
// Sécurité : seul le domaine ushl.ca est autorisé.
// =====================================================================
export default {
  async fetch(requete) {
    const url = new URL(requete.url);
    const cible = url.searchParams.get("url");
    if (!cible) return new Response("Paramètre ?url= manquant", { status: 400 });

    let urlCible;
    try { urlCible = new URL(cible); }
    catch (e) { return new Response("URL invalide", { status: 400 }); }

    if (!/(^|\.)ushl\.ca$/i.test(urlCible.hostname)) {
      return new Response("Domaine non autorisé", { status: 403 });
    }

    const reponse = await fetch(urlCible.href, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; SuiviGardiensUSHL/1.0)" },
      redirect: "follow",
    });
    const corps = await reponse.arrayBuffer();
    return new Response(corps, {
      status: reponse.status,
      headers: {
        "Content-Type": reponse.headers.get("Content-Type") || "text/html; charset=windows-1252",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      },
    });
  },
};
