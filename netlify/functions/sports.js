// netlify/functions/sports.js
// Returns all currently active sports from The Odds API

const ODDS_API_KEY  = "6635c126db560626e7df684998a93061";
const ODDS_API_BASE = "https://api.the-odds-api.com/v4";

exports.handler = async () => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };
  try {
    const res  = await fetch(`${ODDS_API_BASE}/sports/?apiKey=${ODDS_API_KEY}`);
    const data = await res.json();
    const active = data.filter(s => s.active).map(s => ({
      key: s.key, title: s.title, group: s.group,
    }));
    return { statusCode: 200, headers, body: JSON.stringify({ sports: active }) };
  } catch(e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
