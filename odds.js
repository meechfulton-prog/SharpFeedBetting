// netlify/functions/odds.js
// Serverless function — proxies SharpAPI, runs EV math, returns plays
 
const API_KEY  = "sk_live_CoKPbimEySSsGyC7tHVHXV";
const BASE_URL = "https://api.sharpapi.io/api/v1";
 
// ── EV Math ────────────────────────────────────────────────────────────────
function americanToDec(a) {
  a = Number(a);
  return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a);
}
function decToAmerican(d) {
  d = Number(d);
  if (d <= 1) return 0;
  return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
}
function noVigProbs(oddsA, oddsB) {
  const impA = oddsA.reduce((s, o) => s + 1 / americanToDec(o), 0) / oddsA.length;
  const impB = oddsB.reduce((s, o) => s + 1 / americanToDec(o), 0) / oddsB.length;
  const tot  = impA + impB;
  return [impA / tot, impB / tot];
}
function calcEV(fp, bestAmerican) {
  return (fp * americanToDec(bestAmerican) - 1) * 100;
}
 
// ── Parse flat SharpAPI rows → EV plays ───────────────────────────────────
function extractPlays(rows, marketKey, minEV) {
  const filtered = rows.filter(r =>
    (r.market_type || "").toLowerCase() === marketKey.toLowerCase()
  );
 
  // Group by event
  const events = {};
  for (const row of filtered) {
    const home = row.home_team || "Home";
    const away = row.away_team || "Away";
    const key  = `${away}||${home}`;
    const sel  = row.selection || "";
    if (!events[key]) events[key] = { home, away, selections: {} };
    if (!events[key].selections[sel]) events[key].selections[sel] = [];
    events[key].selections[sel].push({
      book:  row.sportsbook || "?",
      odds:  Number(row.odds_american),
      sport: (row.league || row.sport || "").toUpperCase(),
    });
  }
 
  const plays = [];
  for (const evt of Object.values(events)) {
    const matchup = `${evt.away} @ ${evt.home}`;
    const sels    = Object.entries(evt.selections);
    if (sels.length < 2) continue;
 
    for (let i = 0; i < sels.length - 1; i++) {
      for (let j = i + 1; j < sels.length; j++) {
        const [selA, booksA] = sels[i];
        const [selB, booksB] = sels[j];
 
        const bA = booksA.filter(b => b.odds && !isNaN(b.odds));
        const bB = booksB.filter(b => b.odds && !isNaN(b.odds));
        if (!bA.length || !bB.length) continue;
 
        const sport  = bA[0].sport;
        const bestA  = bA.reduce((a, b) => a.odds > b.odds ? a : b);
        const bestB  = bB.reduce((a, b) => a.odds > b.odds ? a : b);
        const oddsA  = bA.map(b => b.odds);
        const oddsB  = bB.map(b => b.odds);
 
        try {
          const [fpA, fpB] = noVigProbs(oddsA, oddsB);
          const evA = calcEV(fpA, bestA.odds);
          const evB = calcEV(fpB, bestB.odds);
 
          if (evA >= minEV) plays.push({
            matchup, sport, bet: selA,
            ev:       Math.round(evA * 100) / 100,
            bestOdds: bestA.odds,
            bestBook: bestA.book,
            fairOdds: decToAmerican(1 / fpA),
            fairProb: Math.round(fpA * 1000) / 10,
            allBooks: bA.sort((a, b) => b.odds - a.odds),
          });
 
          if (evB >= minEV) plays.push({
            matchup, sport, bet: selB,
            ev:       Math.round(evB * 100) / 100,
            bestOdds: bestB.odds,
            bestBook: bestB.book,
            fairOdds: decToAmerican(1 / fpB),
            fairProb: Math.round(fpB * 1000) / 10,
            allBooks: bB.sort((a, b) => b.odds - a.odds),
          });
        } catch (_) {}
      }
    }
  }
 
  return plays.sort((a, b) => b.ev - a.ev);
}
 
// ── Handler ────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
 
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }
 
  const params   = event.queryStringParameters || {};
  const league   = (params.league   || "nba").toLowerCase();
  const market   = (params.market   || "moneyline").toLowerCase();
  const minEV    = parseFloat(params.min_ev || "2");
 
  try {
    const url = `${BASE_URL}/odds?league=${league}&market=${market}&limit=200`;
    const res  = await fetch(url, {
      headers: { "X-API-Key": API_KEY, "Accept": "application/json" },
    });
 
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return {
        statusCode: res.status,
        headers,
        body: JSON.stringify({ error: `SharpAPI ${res.status}: ${txt.slice(0, 200)}` }),
      };
    }
 
    const json   = await res.json();
    const rows   = Array.isArray(json) ? json : (json.data ?? []);
    const plays  = extractPlays(rows, market, minEV);
 
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        plays,
        meta: { total_rows: rows.length, plays_found: plays.length, league, market, min_ev: minEV },
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};