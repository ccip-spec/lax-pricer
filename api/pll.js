// /api/pll.js — Vercel serverless proxy for the PLL stats API.
// Wraps stats.premierlacrosseleague.com's REST + GraphQL endpoints (server-side: no CORS).
//
// REST:
//   /api/pll?type=players&year=2024         -> season-stats (regular)
//   /api/pll?type=players&year=2024&seg=post
//   /api/pll?type=games&year=2024           -> games (incl CS + WLL)
// GraphQL:
//   /api/pll?type=teams&year=2024           -> allTeams w/ full stats
//   /api/pll?type=standings&year=2024
//   /api/pll?type=leaders&year=2024         -> playerStatLeaders
//
// Add &raw=1 to see the unwrapped upstream response (debug).

const API = 'https://stats.premierlacrosseleague.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

const baseHeaders = {
  'accept': '*/*',
  'accept-language': 'en-US,en;q=0.9',
  'user-agent': UA,
  'referer': `${API}/player-table`,
  'time-zone': 'America/New_York',
};

async function getREST(path) {
  const r = await fetch(`${API}${path}`, { headers: baseHeaders });
  if (!r.ok) throw new Error(`REST ${r.status} ${path}`);
  return r.json();
}

async function postGQL(body) {
  const r = await fetch(`${API}/api/graphql`, {
    method: 'POST',
    headers: { ...baseHeaders, 'content-type': 'application/json', 'origin': API },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`GQL ${r.status}`);
  const j = await r.json();
  if (j.errors) throw new Error('GQL errors: ' + JSON.stringify(j.errors).slice(0,200));
  return j.data;
}

const TEAMS_QUERY = `
query($year: Int!, $sortBy: String, $includeChampSeries: Boolean!) {
  allTeams(year: $year, sortBy: $sortBy) {
    officialId locationCode location fullName teamWins teamLosses teamTies
    teamWinsPost teamLossesPost teamTiesPost league conference
    stats(year: $year, segment:regular) { ...F }
    postStats: stats(year: $year, segment: post) { ...F }
  }
}
fragment F on TeamStatsType {
  scores scoresAgainst saa faceoffPct shotPct twoPointShotPct clearPct ridesPct savePct
  gamesPlayed goals twoPointGoals onePointGoals assists groundBalls turnovers causedTurnovers
  faceoffsWon faceoffsLost faceoffs shots twoPointShots shotsOnGoal goalsAgainst twoPointGoalsAgainst
  saves clears clearAttempts rides rideAttempts powerPlayPct powerPlayGoals powerPlayShots
  scoresPG shotsPG totalPasses touches
}`;

const STANDINGS_QUERY = `
query($year: Int!, $champSeries: Boolean!) {
  standings(season: $year, champSeries: $champSeries){
    team{ officialId location locationCode fullName }
    seed wins losses ties scores scoresAgainst scoreDiff
    conferenceWins conferenceLosses conferenceTies conference conferenceSeed
  }
}`;

const LEADERS_QUERY = `
query($year: Int!, $seasonSegment: SeasonSegment, $statList: [String], $limit: Int){
  playerStatLeaders(year: $year, seasonSegment: $seasonSegment, statList: $statList, limit: $limit) {
    officialId firstName lastName position statType slug statValue playerRank jerseyNum teamId year
  }
}`;

const LEADER_STATS = ["points","goals","twoPointGoals","assists","shots","shotPct",
  "faceoffPct","faceoffWinsPG","savesPG","savePct","causedTurnovers","groundBalls"];

const cache = {};
const TTL = 60 * 60 * 1000;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const q = req.query || {};
  const type = q.type || 'players';
  const year = parseInt(q.year || '2026', 10);
  const seg = q.seg === 'post' ? 'post' : 'regular';
  const raw = q.raw === '1';

  const cacheKey = `${type}:${year}:${seg}`;
  const now = Date.now();
  if (!raw && cache[cacheKey] && now - cache[cacheKey].at < TTL) {
    res.status(200).json({ ok:true, type, year, cached:true, ...cache[cacheKey].payload });
    return;
  }

  try {
    let data, count;
    if (type === 'players') {
      data = await getREST(`/api/v4/players/season-stats?year=${year}&seasonSegment=${seg}`);
      // upstream may wrap in {players:[...]} or be a bare array
      if (data && data.players) data = data.players;
      count = Array.isArray(data) ? data.length : 0;
    } else if (type === 'games') {
      data = await getREST(`/api/v4/games?year=${year}&includeCS=true&includeWLL=true`);
      if (data && data.games) data = data.games;
      if (Array.isArray(data)) data = data.filter(g => g.league === 'PLL');
      count = Array.isArray(data) ? data.length : 0;
    } else if (type === 'teams') {
      const d = await postGQL({ variables:{ year, sortBy:'points', includeChampSeries:false }, query: TEAMS_QUERY });
      data = (d.allTeams || []).filter(t => t.league === 'PLL');
      count = data.length;
    } else if (type === 'standings') {
      const d = await postGQL({ variables:{ year, champSeries:false }, query: STANDINGS_QUERY });
      data = d.standings || [];
      count = data.length;
    } else if (type === 'leaders') {
      const d = await postGQL({ variables:{ year, seasonSegment:seg, statList:LEADER_STATS, limit:10 }, query: LEADERS_QUERY });
      data = d.playerStatLeaders || [];
      count = data.length;
    } else {
      res.status(400).json({ ok:false, error:'bad type' }); return;
    }

    if (raw) { res.status(200).json({ ok:true, type, year, count, sample: Array.isArray(data)?data.slice(0,2):data }); return; }

    const payload = { count, data, fetchedAt: new Date(now).toISOString() };
    cache[cacheKey] = { at: now, payload };
    res.status(200).json({ ok:true, type, year, cached:false, ...payload });
  } catch (e) {
    res.status(502).json({ ok:false, type, year, error: String(e) });
  }
};
