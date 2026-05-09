// SharpFeed — netlify/functions/odds.js
// Uses The Odds API (your existing key) as primary source
// Pinnacle is used as the sharp/devig reference line when available
// Full no-vig EV math with multiplicative devig

const ODDS_API_KEY = "6635c126db560626e7df684998a93061";
const ODDS_API_BASE = "https://api.the-odds-api.com/v4";

// All books we pull — Pinnacle is the sharp line reference
const ALL_BOOKS = "draftkings,fanduel,caesars,betmgm,pinnacle,pointsbet,betrivers,unibet";
const SHARP_BOOK = "Pinnacle"; // used as devig reference if present

// Sport key map
const SPORT_MAP = {
  // NBA Playoffs — active key May/June
  nba:       "basketball_nba",
  nba_champ: "basketball_nba_championship_winner",
  // Other sports
  mlb:    "baseball_mlb",
  nhl:    "icehockey_nhl",
  nfl:    "americanfootball_nfl",
  ncaab:  "basketball_ncaab",
  ncaaf:  "americanfootball_ncaaf",
  wnba:   "basketball_wnba",
  tennis: "tennis_atp_french_open",
  mls:    "soccer_usa_mls",
  ufc:    "mma_mixed_martial_arts",
  epl:    "soccer_epl",
};

// Try multiple sport keys if first returns empty
const SPORT_FALLBACKS = {
  nba: ["basketball_nba", "basketball_nba_championship_winner"],
  nhl: ["icehockey_nhl", "icehockey_nhl_championship_winner"],
  tennis: ["tennis_atp_french_open", "tennis_wta_french_open", "tennis_atp_us_open", "tennis_atp"],
};

// ── Math ───────────────────────────────────────────────────────────────────
function americanToDec(a) {
  a = Number(a);
  if (!a || isNaN(a)) return 1;
  return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a);
}
function decToAmerican(d) {
  d = Number(d);
  if (!d || d <= 1) return 0;
  return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
}

// Multiplicative devig: removes vig proportionally
function devigOdds(odds1, odds2) {
  const imp1 = 1 / americanToDec(odds1);
  const imp2 = 1 / americanToDec(odds2);
  const total = imp1 + imp2;
  return [imp1 / total, imp2 / total]; // [fairProb1, fairProb2]
}

// Consensus fair prob: average devig across all books
function consensusFairProbs(side1Odds, side2Odds) {
  const pairs = Math.min(side1Odds.length, side2Odds.length);
  if (pairs === 0) return [0.5, 0.5];
  let sumP1 = 0, sumP2 = 0;
  // Pair each book with opposing side best odds
  for (let i = 0; i < side1Odds.length; i++) {
    const o1 = side1Odds[i];
    // use average of side2 as the opposing line
    const avgO2 = side2Odds.reduce((s, o) => s + americanToDec(o), 0) / side2Odds.length;
    const o2 = decToAmerican(avgO2);
    const [p1] = devigOdds(o1, o2);
    sumP1 += p1;
  }
  for (let i = 0; i < side2Odds.length; i++) {
    const o2 = side2Odds[i];
    const avgO1 = side1Odds.reduce((s, o) => s + americanToDec(o), 0) / side1Odds.length;
    const o1 = decToAmerican(avgO1);
    const [, p2] = devigOdds(o1, o2);
    sumP2 += p2;
  }
  const fp1 = sumP1 / side1Odds.length;
  const fp2 = sumP2 / side2Odds.length;
  const tot = fp1 + fp2;
  return [fp1 / tot, fp2 / tot];
}

function calcEV(fairProb, bestAmerican) {
  return (fairProb * americanToDec(bestAmerican) - 1) * 100;
}

function formatGameTime(isoString) {
  if (!isoString) return null;
  try {
    const d = new Date(isoString);
    return d.toLocaleString("en-US", {
      weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit", timeZoneName: "short",
      timeZone: "America/New_York"
    });
  } catch { return isoString; }
}

// ── Core EV extractor ─────────────────────────────────────────────────────
function extractEVPlays(games, marketKey, minEV) {
  const plays = [];

  for (const game of games) {
    const matchup  = `${game.away_team} @ ${game.home_team}`;
    const gameTime = formatGameTime(game.commence_time);
    const sport    = game.sport_title || "";

    // Build per-outcome book map
    const outcomeMap = {}; // { outcomeName: [{book, price, point}] }

    // Try to use Pinnacle as reference if present
    let pinnacleOutcomes = null;
    for (const bm of (game.bookmakers || [])) {
      for (const mk of (bm.markets || [])) {
        if (mk.key !== marketKey) continue;
        if (bm.title === SHARP_BOOK) {
          pinnacleOutcomes = {};
          for (const oc of mk.outcomes) {
            pinnacleOutcomes[oc.name] = oc.price;
          }
        }
        for (const oc of mk.outcomes) {
          const label = oc.name + (oc.point != null
            ? ` ${oc.point > 0 ? "+" : ""}${oc.point}` : "");
          if (!outcomeMap[label]) outcomeMap[label] = [];
          outcomeMap[label].push({ book: bm.title, price: oc.price, point: oc.point });
        }
      }
    }

    const keys = Object.keys(outcomeMap);
    if (keys.length < 2) continue;

    // Pair opposing sides
    for (let i = 0; i < keys.length - 1; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const sA = outcomeMap[keys[i]].filter(b => b.price && !isNaN(b.price));
        const sB = outcomeMap[keys[j]].filter(b => b.price && !isNaN(b.price));
        if (!sA.length || !sB.length) continue;

        const bestA = sA.reduce((a, b) => a.price > b.price ? a : b);
        const bestB = sB.reduce((a, b) => a.price > b.price ? a : b);
        const oddsA = sA.map(b => b.price);
        const oddsB = sB.map(b => b.price);

        let fpA, fpB;

        // If Pinnacle present, use it as the devig reference (most accurate)
        const pinKeyA = keys[i].split(" ")[0]; // strip point
        const pinKeyB = keys[j].split(" ")[0];
        if (pinnacleOutcomes &&
            pinnacleOutcomes[pinKeyA] &&
            pinnacleOutcomes[pinKeyB]) {
          [fpA, fpB] = devigOdds(pinnacleOutcomes[pinKeyA], pinnacleOutcomes[pinKeyB]);
        } else {
          // Fall back to consensus devig across all books
          [fpA, fpB] = consensusFairProbs(oddsA, oddsB);
        }

        const evA = calcEV(fpA, bestA.price);
        const evB = calcEV(fpB, bestB.price);

        const makePlay = (bet, ev, best, fp, allBooks) => ({
          matchup, sport, gameTime,
          bet, ev: Math.round(ev * 100) / 100,
          bestOdds: best.price,
          bestBook: best.book,
          fairOdds: decToAmerican(1 / fp),
          fairProb: Math.round(fp * 1000) / 10,
          vig: Math.round((1 - fp - (1 - fp)) * 100) / 100, // for display
          allBooks: allBooks.sort((a, b) => b.price - a.price),
          usingPinnacle: !!pinnacleOutcomes,
        });

        if (evA >= minEV) plays.push(makePlay(keys[i], evA, bestA, fpA, sA));
        if (evB >= minEV) plays.push(makePlay(keys[j], evB, bestB, fpB, sB));
      }
    }
  }

  return plays.sort((a, b) => b.ev - a.ev);
}

// ── Parlay Builder ─────────────────────────────────────────────────────────
function buildParlays(plays) {
  // Use only plays with EV >= 3% and from different games
  const pool = plays.filter(p => p.ev >= 3);
  const parlays = [];

  // 2-leg parlays — top combinations by combined EV
  for (let i = 0; i < Math.min(pool.length, 8) - 1; i++) {
    for (let j = i + 1; j < Math.min(pool.length, 8); j++) {
      if (pool[i].matchup === pool[j].matchup) continue; // no same-game parlays
      const legA = pool[i];
      const legB = pool[j];
      const parlayDec = americanToDec(legA.bestOdds) * americanToDec(legB.bestOdds);
      const parlayOdds = decToAmerican(parlayDec);
      const combinedFP = (legA.fairProb / 100) * (legB.fairProb / 100);
      const parlayEV = calcEV(combinedFP, parlayOdds);
      if (parlayEV > 0) {
        parlays.push({
          legs: [
            { bet: legA.bet, matchup: legA.matchup, odds: legA.bestOdds, book: legA.bestBook, ev: legA.ev },
            { bet: legB.bet, matchup: legB.matchup, odds: legB.bestOdds, book: legB.bestBook, ev: legB.ev },
          ],
          parlayOdds,
          parlayEV: Math.round(parlayEV * 100) / 100,
          combinedFairProb: Math.round(combinedFP * 1000) / 10,
        });
      }
    }
  }

  // 3-leg parlays — top 3 EV plays from different games
  const top = pool.slice(0, 6);
  for (let i = 0; i < top.length - 2; i++) {
    for (let j = i + 1; j < top.length - 1; j++) {
      for (let k = j + 1; k < top.length; k++) {
        const legs = [top[i], top[j], top[k]];
        // All different games
        const matchups = new Set(legs.map(l => l.matchup));
        if (matchups.size < 3) continue;
        const parlayDec = legs.reduce((p, l) => p * americanToDec(l.bestOdds), 1);
        const parlayOdds = decToAmerican(parlayDec);
        const combinedFP = legs.reduce((p, l) => p * (l.fairProb / 100), 1);
        const parlayEV = calcEV(combinedFP, parlayOdds);
        if (parlayEV > 0) {
          parlays.push({
            legs: legs.map(l => ({
              bet: l.bet, matchup: l.matchup,
              odds: l.bestOdds, book: l.bestBook, ev: l.ev,
            })),
            parlayOdds,
            parlayEV: Math.round(parlayEV * 100) / 100,
            combinedFairProb: Math.round(combinedFP * 1000) / 10,
          });
        }
      }
    }
  }

  return parlays.sort((a, b) => b.parlayEV - a.parlayEV).slice(0, 8);
}

// ── Handler ────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  const p      = event.queryStringParameters || {};
  const league = (p.league  || "nba").toLowerCase();
  const market = (p.market  || "h2h").toLowerCase();
  const minEV  = parseFloat(p.min_ev || "2");

  const sportKey = SPORT_MAP[league];
  if (!sportKey) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: `Unknown league: ${league}` }) };
  }

  // Build list of keys to try (primary + fallbacks)
  const keysToTry = SPORT_FALLBACKS[league]
    ? [sportKey, ...SPORT_FALLBACKS[league].filter(k => k !== sportKey)]
    : [sportKey];

  try {
    let games = [];
    let usedKey = sportKey;

    // Try each key until we get games
    for (const key of keysToTry) {
      const url = `${ODDS_API_BASE}/sports/${key}/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=${market}&oddsFormat=american&bookmakers=${ALL_BOOKS}`;
      const res  = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        games  = data;
        usedKey = key;
        break;
      }
    }

    if (games.length === 0) {
      // Last attempt: fetch active sports list and find matching ones
      const sportsRes = await fetch(`${ODDS_API_BASE}/sports/?apiKey=${ODDS_API_KEY}`);
      let activeSuggestion = "";
      if (sportsRes.ok) {
        const activeSports = await sportsRes.json();
        const active = activeSports
          .filter(s => s.active && s.key.includes(league.replace("nba","basketball").replace("mlb","baseball").replace("nhl","hockey")))
          .map(s => s.key);
        if (active.length) activeSuggestion = ` Active keys found: ${active.join(", ")}`;
      }
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          plays: [], parlays: [],
          meta: {
            games_found: 0, plays_found: 0,
            league, market, min_ev: minEV,
            message: `No games found for ${league.toUpperCase()} right now.${activeSuggestion} Try MLB, NHL, Tennis, or MLS.`,
            devig_method: "n/a",
            books_checked: ALL_BOOKS.split(",").length,
          },
        }),
      };
    }

    const plays   = extractEVPlays(games, market, minEV);
    const parlays = buildParlays(plays);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        plays,
        parlays,
        meta: {
          games_found:  games.length,
          plays_found:  plays.length,
          league, market,
          min_ev: minEV,
          devig_method: "pinnacle_reference_with_consensus_fallback",
          books_checked: ALL_BOOKS.split(",").length,
        },
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
