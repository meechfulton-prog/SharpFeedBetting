// netlify/functions/breakdown.js
// Fetches real team + player stats, then uses AI to explain picks

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  const body = JSON.parse(event.body || "{}");
  const { play, parlay, sport } = body;

  try {
    // 1. Fetch real stats for the teams/players involved
    const stats = await fetchStats(play, sport);

    // 2. Build AI prompt with real data
    const playAnalysis   = play    ? await analyzePlay(play, stats)     : null;
    const parlayAnalysis = parlay  ? await analyzeParlay(parlay, stats) : null;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ playAnalysis, parlayAnalysis, stats }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};

// ── Fetch real stats from free sports APIs ─────────────────────────────────
async function fetchStats(play, sport) {
  if (!play) return {};

  const league = (sport || "nba").toLowerCase();
  const stats  = {};

  try {
    if (league === "nba" || league === "wnba") {
      // Ball Don't Lie — free NBA/WNBA stats API
      const teamStats = await fetchNBAStats(play);
      Object.assign(stats, teamStats);
    } else if (league === "mlb") {
      const mlbStats = await fetchMLBStats(play);
      Object.assign(stats, mlbStats);
    } else if (league === "nfl") {
      const nflStats = await fetchNFLStats(play);
      Object.assign(stats, nflStats);
    } else if (league === "nhl") {
      const nhlStats = await fetchNHLStats(play);
      Object.assign(stats, nhlStats);
    }
  } catch (e) {
    stats.fetchError = e.message;
  }

  return stats;
}

// ── NBA Stats (Ball Don't Lie — free, no key) ──────────────────────────────
async function fetchNBAStats(play) {
  const matchup = play.matchup || "";
  // Extract team names from "Away @ Home"
  const parts = matchup.split(" @ ");
  const away  = parts[0]?.trim();
  const home  = parts[1]?.trim();

  const stats = { away, home, league: "NBA" };

  try {
    // Search for teams
    const teamsRes  = await fetch("https://api.balldontlie.io/v1/teams", {
      headers: { "Authorization": "0" } // public endpoint
    });
    if (!teamsRes.ok) throw new Error("BDL teams unavailable");
    const teamsData = await teamsRes.json();
    const teams     = teamsData.data || [];

    // Match teams
    const awayTeam = teams.find(t =>
      away?.toLowerCase().includes(t.name?.toLowerCase()) ||
      away?.toLowerCase().includes(t.abbreviation?.toLowerCase())
    );
    const homeTeam = teams.find(t =>
      home?.toLowerCase().includes(t.name?.toLowerCase()) ||
      home?.toLowerCase().includes(t.abbreviation?.toLowerCase())
    );

    if (awayTeam) stats.awayTeamId = awayTeam.id;
    if (homeTeam) stats.homeTeamId = homeTeam.id;

    // Get season averages for current season
    const season = 2024;
    if (awayTeam || homeTeam) {
      const teamIds = [awayTeam?.id, homeTeam?.id].filter(Boolean).join("&team_ids[]=");
      const gamesRes = await fetch(
        `https://api.balldontlie.io/v1/games?seasons[]=${season}&team_ids[]=${teamIds}&per_page=10`
      );
      if (gamesRes.ok) {
        const gamesData = await gamesRes.json();
        const games = gamesData.data || [];

        // Calculate recent form (last 5 games)
        const awayGames = games.filter(g =>
          g.home_team?.id === awayTeam?.id || g.visitor_team?.id === awayTeam?.id
        ).slice(0, 5);
        const homeGames = games.filter(g =>
          g.home_team?.id === homeTeam?.id || g.visitor_team?.id === homeTeam?.id
        ).slice(0, 5);

        if (awayGames.length) {
          stats.awayRecentForm = awayGames.map(g => {
            const isHome = g.home_team?.id === awayTeam?.id;
            const teamScore = isHome ? g.home_team_score : g.visitor_team_score;
            const oppScore  = isHome ? g.visitor_team_score : g.home_team_score;
            return { result: teamScore > oppScore ? "W" : "L", score: `${teamScore}-${oppScore}` };
          });
          const awayWins = stats.awayRecentForm.filter(g => g.result === "W").length;
          stats.awayRecord = `${awayWins}-${awayGames.length - awayWins} last ${awayGames.length}`;
          stats.awayAvgPts = awayGames.reduce((s, g) => {
            const isHome = g.home_team?.id === awayTeam?.id;
            return s + (isHome ? g.home_team_score : g.visitor_team_score);
          }, 0) / awayGames.length;
        }

        if (homeGames.length) {
          stats.homeRecentForm = homeGames.map(g => {
            const isHome = g.home_team?.id === homeTeam?.id;
            const teamScore = isHome ? g.home_team_score : g.visitor_team_score;
            const oppScore  = isHome ? g.visitor_team_score : g.home_team_score;
            return { result: teamScore > oppScore ? "W" : "L", score: `${teamScore}-${oppScore}` };
          });
          const homeWins = stats.homeRecentForm.filter(g => g.result === "W").length;
          stats.homeRecord = `${homeWins}-${homeGames.length - homeWins} last ${homeGames.length}`;
          stats.homeAvgPts = homeGames.reduce((s, g) => {
            const isHome = g.home_team?.id === homeTeam?.id;
            return s + (isHome ? g.home_team_score : g.visitor_team_score);
          }, 0) / homeGames.length;
        }

        // Average total
        if (games.length) {
          stats.avgTotal = games.reduce((s, g) =>
            s + g.home_team_score + g.visitor_team_score, 0) / games.length;
        }
      }
    }
  } catch (e) {
    stats.nbaError = e.message;
  }

  return stats;
}

// ── MLB Stats (MLB Stats API — free, no key) ───────────────────────────────
async function fetchMLBStats(play) {
  const stats = { league: "MLB" };
  try {
    const parts    = (play.matchup || "").split(" @ ");
    stats.away     = parts[0]?.trim();
    stats.home     = parts[1]?.trim();

    // Get standings for context
    const res = await fetch(
      "https://statsapi.mlb.com/api/v1/standings?leagueId=103,104&season=2025&standingsTypes=regularSeason"
    );
    if (!res.ok) return stats;
    const data     = await res.json();
    const records  = data.records || [];

    for (const division of records) {
      for (const team of (division.teamRecords || [])) {
        const name = team.team?.name || "";
        if (stats.away && name.toLowerCase().includes(stats.away.toLowerCase().split(" ").pop())) {
          stats.awayRecord = `${team.wins}-${team.losses}`;
          stats.awayGB     = team.gamesBack;
          stats.awayRS     = team.runsScored;
          stats.awayRA     = team.runsAllowed;
          stats.awayRunDiff = team.runDifferential;
          stats.awayStreak = team.streak?.streakCode;
          stats.awayLast10 = team.records?.splitRecords?.find(r => r.type === "lastTen")?.wins + "-" +
                              team.records?.splitRecords?.find(r => r.type === "lastTen")?.losses;
        }
        if (stats.home && name.toLowerCase().includes(stats.home.toLowerCase().split(" ").pop())) {
          stats.homeRecord = `${team.wins}-${team.losses}`;
          stats.homeGB     = team.gamesBack;
          stats.homeRS     = team.runsScored;
          stats.homeRA     = team.runsAllowed;
          stats.homeRunDiff = team.runDifferential;
          stats.homeStreak = team.streak?.streakCode;
          stats.homeLast10 = team.records?.splitRecords?.find(r => r.type === "lastTen")?.wins + "-" +
                              team.records?.splitRecords?.find(r => r.type === "lastTen")?.losses;
        }
      }
    }
  } catch (e) {
    stats.mlbError = e.message;
  }
  return stats;
}

// ── NFL Stats (ESPN public API) ────────────────────────────────────────────
async function fetchNFLStats(play) {
  const stats = { league: "NFL" };
  try {
    const parts = (play.matchup || "").split(" @ ");
    stats.away  = parts[0]?.trim();
    stats.home  = parts[1]?.trim();

    const res = await fetch(
      "https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams"
    );
    if (!res.ok) return stats;
    const data  = await res.json();
    const teams = data.sports?.[0]?.leagues?.[0]?.teams || [];

    for (const { team } of teams) {
      const name = team.displayName || "";
      if (stats.away && name.toLowerCase().includes(stats.away.toLowerCase().split(" ").pop())) {
        stats.awayRecord = team.record?.items?.[0]?.summary;
        stats.awayRank   = team.rank;
      }
      if (stats.home && name.toLowerCase().includes(stats.home.toLowerCase().split(" ").pop())) {
        stats.homeRecord = team.record?.items?.[0]?.summary;
        stats.homeRank   = team.rank;
      }
    }
  } catch (e) {
    stats.nflError = e.message;
  }
  return stats;
}

// ── NHL Stats (NHL API — free, no key) ────────────────────────────────────
async function fetchNHLStats(play) {
  const stats = { league: "NHL" };
  try {
    const parts = (play.matchup || "").split(" @ ");
    stats.away  = parts[0]?.trim();
    stats.home  = parts[1]?.trim();

    const res = await fetch("https://api-web.nhle.com/v1/standings/now");
    if (!res.ok) return stats;
    const data     = await res.json();
    const standings = data.standings || [];

    for (const team of standings) {
      const name = team.teamName?.default || team.teamCommonName?.default || "";
      if (stats.away && name.toLowerCase().includes(stats.away.toLowerCase().split(" ").pop())) {
        stats.awayRecord = `${team.wins}-${team.losses}-${team.otLosses}`;
        stats.awayPoints = team.points;
        stats.awayGF     = team.goalFor;
        stats.awayGA     = team.goalAgainst;
        stats.awayStreak = team.streakCode;
        stats.awayL10    = `${team.l10Wins}-${team.l10Losses}-${team.l10OtLosses}`;
        stats.awayPP     = team.powerPlayPct;
        stats.awayPK     = team.penaltyKillPct;
      }
      if (stats.home && name.toLowerCase().includes(stats.home.toLowerCase().split(" ").pop())) {
        stats.homeRecord = `${team.wins}-${team.losses}-${team.otLosses}`;
        stats.homePoints = team.points;
        stats.homeGF     = team.goalFor;
        stats.homeGA     = team.goalAgainst;
        stats.homeStreak = team.streakCode;
        stats.homeL10    = `${team.l10Wins}-${team.l10Losses}-${team.l10OtLosses}`;
        stats.homePP     = team.powerPlayPct;
        stats.homePK     = team.penaltyKillPct;
      }
    }
  } catch (e) {
    stats.nhlError = e.message;
  }
  return stats;
}

// ── AI Analysis ────────────────────────────────────────────────────────────
async function analyzePlay(play, stats) {
  const statsStr = buildStatsString(stats);

  const prompt = `You are SharpFeed AI, a sharp sports betting analyst at High Frequency Tech.

Analyze this +EV bet using REAL team data. Be specific with numbers. Max 6 sentences.

BETTING DATA:
- Bet: ${play.bet}
- Game: ${play.matchup}
- Game time: ${play.gameTime || "TBD"}
- Best odds: ${play.bestOdds > 0 ? "+" : ""}${play.bestOdds} @ ${play.bestBook}
- Fair odds (devig): ${play.fairOdds > 0 ? "+" : ""}${play.fairOdds}
- True win probability: ${play.fairProb}%
- Expected Value: +${play.ev}%
- All books: ${play.allBooks?.map(b => b.book + " " + (b.price > 0 ? "+" : "") + b.price).join(", ")}
- Devig method: Pinnacle reference + consensus

REAL TEAM/PLAYER STATS:
${statsStr}

Explain:
1. Why the line is wrong and this is +EV (cite the stats)
2. What the real win probability should be based on team data
3. Which book to use and why
4. Key matchup edges or risk factors
5. Confidence level

Be direct, data-driven, sharp. No fluff.`;

  const res  = await callClaude(prompt, 350);
  return res;
}

async function analyzeParlay(parlay, stats) {
  const legsStr  = parlay.legs.map((l, i) =>
    `Leg ${i+1}: ${l.bet} (${l.matchup}) @ ${l.odds > 0 ? "+" : ""}${l.odds} | EV: +${l.ev.toFixed(1)}%`
  ).join("\n");
  const statsStr = buildStatsString(stats);

  const prompt = `You are SharpFeed AI, a sharp sports betting analyst at High Frequency Tech.

Analyze this +EV parlay using real data. Be specific. Max 6 sentences.

PARLAY DATA:
${legsStr}
- Combined parlay odds: ${parlay.parlayOdds > 0 ? "+" : ""}${parlay.parlayOdds}
- Combined EV: +${parlay.parlayEV.toFixed(1)}%
- True hit probability: ${parlay.combinedFairProb}%

REAL TEAM STATS:
${statsStr}

Explain:
1. Why each leg is +EV (use stats)
2. Why these legs correlate well together (or are independent)
3. The main risk to this parlay hitting
4. Whether this parlay is worth it vs betting legs straight
5. Confidence level

Be sharp and factual.`;

  const res = await callClaude(prompt, 350);
  return res;
}

function buildStatsString(stats) {
  const lines = [];
  if (stats.away)        lines.push(`Away team: ${stats.away}`);
  if (stats.awayRecord)  lines.push(`Away record: ${stats.awayRecord}`);
  if (stats.awayStreak)  lines.push(`Away streak: ${stats.awayStreak}`);
  if (stats.awayLast10 || stats.awayL10) lines.push(`Away last 10: ${stats.awayLast10 || stats.awayL10}`);
  if (stats.awayAvgPts)  lines.push(`Away avg pts (recent): ${stats.awayAvgPts?.toFixed(1)}`);
  if (stats.awayRS)      lines.push(`Away runs scored: ${stats.awayRS}, runs allowed: ${stats.awayRA}`);
  if (stats.awayRunDiff) lines.push(`Away run differential: ${stats.awayRunDiff > 0 ? "+" : ""}${stats.awayRunDiff}`);
  if (stats.awayGF)      lines.push(`Away goals for: ${stats.awayGF}, goals against: ${stats.awayGA}`);
  if (stats.awayPP)      lines.push(`Away PP%: ${stats.awayPP}, PK%: ${stats.awayPK}`);

  if (stats.home)        lines.push(`Home team: ${stats.home}`);
  if (stats.homeRecord)  lines.push(`Home record: ${stats.homeRecord}`);
  if (stats.homeStreak)  lines.push(`Home streak: ${stats.homeStreak}`);
  if (stats.homeLast10 || stats.homeL10) lines.push(`Home last 10: ${stats.homeLast10 || stats.homeL10}`);
  if (stats.homeAvgPts)  lines.push(`Home avg pts (recent): ${stats.homeAvgPts?.toFixed(1)}`);
  if (stats.homeRS)      lines.push(`Home runs scored: ${stats.homeRS}, runs allowed: ${stats.homeRA}`);
  if (stats.homeRunDiff) lines.push(`Home run differential: ${stats.homeRunDiff > 0 ? "+" : ""}${stats.homeRunDiff}`);
  if (stats.homeGF)      lines.push(`Home goals for: ${stats.homeGF}, goals against: ${stats.homeGA}`);
  if (stats.homePP)      lines.push(`Home PP%: ${stats.homePP}, PK%: ${stats.homePK}`);

  if (stats.avgTotal)    lines.push(`Average combined total (recent games): ${stats.avgTotal?.toFixed(1)}`);
  if (stats.fetchError)  lines.push(`Note: Some stats unavailable (${stats.fetchError})`);

  return lines.length ? lines.join("\n") : "Team stats not available for this sport/matchup.";
}

async function callClaude(prompt, maxTokens = 350) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}`);
  const data = await res.json();
  return data.content?.[0]?.text || "Analysis unavailable.";
}