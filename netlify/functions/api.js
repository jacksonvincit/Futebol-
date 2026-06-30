// Backend único, usando a API-Football (api-sports.io / dashboard.api-football.com).
// ?action=fixtures       -> lista de jogos
// ?action=predict        -> previsão dos mercados
// ?action=live_compare   -> compara previsão com estatísticas reais do jogo ao vivo

const BASE_URL = 'https://v3.football.api-sports.io';
const MAX_MATCHES_PER_TEAM = 5;

const STAT_NAMES = {
  shots_total: 'Total de chutes',
  shots_on_target: 'Chutes no gol',
  shots_off_target: 'Chutes para fora',
  corners: 'Escanteios',
  cards: 'Cartões (amarelos + vermelhos)',
  yellow_cards: 'Cartões amarelos',
  fouls: 'Faltas',
  offsides: 'Impedimentos',
  goals: 'Gols',
};

const GENERIC_TEAM_AVERAGE = {
  shots_total: 12,
  shots_on_target: 4.5,
  shots_off_target: 5.5,
  corners: 5,
  cards: 2.2,
  yellow_cards: 1.9,
  fouls: 11,
  offsides: 1.8,
  goals: 1.3,
};

const STAT_API_NAME = {
  shots_total: 'Total Shots',
  shots_on_target: 'Shots on Goal',
  shots_off_target: 'Shots off Goal',
  corners: 'Corner Kicks',
  fouls: 'Fouls',
  offsides: 'Offsides',
};

async function apiFootballGet(path, params = {}) {
  const key = process.env.APIFOOTBALL_KEY;
  if (!key) throw new Error('APIFOOTBALL_KEY não configurada nas variáveis de ambiente da Netlify.');
  const url = new URL(BASE_URL + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), { headers: { 'x-apisports-key': key } });
  if (res.status === 429) throw new Error('RATE_LIMIT: limite diário atingido. Tente amanhã.');
  if (!res.ok) throw new Error(`API-Football HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  return res.json();
}

function fmtDate(d) { return d.toISOString().slice(0, 10); }

function mapFixture(item) {
  return {
    id: item.fixture.id,
    league: item.league ? item.league.name : null,
    leagueId: item.league ? item.league.id : null,
    leagueCountry: item.league ? item.league.country : null,
    leagueLogo: item.league ? item.league.logo : null,
    startingAt: item.fixture.date,
    statusShort: item.fixture.status ? item.fixture.status.short : null,
    elapsed: item.fixture.status ? item.fixture.status.elapsed : null,
    home: item.teams.home.name,
    away: item.teams.away.name,
    homeId: item.teams.home.id,
    awayId: item.teams.away.id,
    homeLogo: item.teams.home.logo,
    awayLogo: item.teams.away.logo,
    homeGoals: item.goals ? item.goals.home : null,
    awayGoals: item.goals ? item.goals.away : null,
  };
}

async function handleFixtures(qs) {
  const scope = qs.scope === 'live' ? 'live' : 'today';
  if (scope === 'live') {
    const json = await apiFootballGet('/fixtures', { live: 'all' });
    return { fixtures: (json.response || []).map(mapFixture) };
  }
  const date = qs.date || fmtDate(new Date());
  const json = await apiFootballGet('/fixtures', { date });
  return { fixtures: (json.response || []).map(mapFixture) };
}

function extractStat(statsResponse, teamId, statName) {
  const teamBlock = (statsResponse.response || []).find((b) => b.team.id === teamId);
  if (!teamBlock) return null;
  const entry = teamBlock.statistics.find((s) => s.type === statName);
  if (!entry || entry.value === null || entry.value === undefined) return null;
  return typeof entry.value === 'string' ? parseFloat(entry.value) : entry.value;
}

async function teamAverages(teamId) {
  const fixturesJson = await apiFootballGet('/fixtures', { team: teamId, last: MAX_MATCHES_PER_TEAM, status: 'FT' });
  const fixtures = fixturesJson.response || [];
  const totals = { shots_total: [], shots_on_target: [], shots_off_target: [], corners: [], cards: [], yellow_cards: [], fouls: [], offsides: [], goals: [] };

  for (const fx of fixtures) {
    const fixtureId = fx.fixture.id;
    const isHome = fx.teams.home.id === teamId;
    const goalsFor = isHome ? fx.goals.home : fx.goals.away;
    if (typeof goalsFor === 'number') totals.goals.push(goalsFor);
    try {
      const statsJson = await apiFootballGet('/fixtures/statistics', { fixture: fixtureId });
      const shots = extractStat(statsJson, teamId, 'Total Shots');
      const shotsOn = extractStat(statsJson, teamId, 'Shots on Goal');
      const shotsOff = extractStat(statsJson, teamId, 'Shots off Goal');
      const corners = extractStat(statsJson, teamId, 'Corner Kicks');
      const fouls = extractStat(statsJson, teamId, 'Fouls');
      const offsides = extractStat(statsJson, teamId, 'Offsides');
      const yellow = extractStat(statsJson, teamId, 'Yellow Cards');
      const red = extractStat(statsJson, teamId, 'Red Cards');
      if (shots !== null) totals.shots_total.push(shots);
      if (shotsOn !== null) totals.shots_on_target.push(shotsOn);
      if (shotsOff !== null) totals.shots_off_target.push(shotsOff);
      if (corners !== null) totals.corners.push(corners);
      if (fouls !== null) totals.fouls.push(fouls);
      if (offsides !== null) totals.offsides.push(offsides);
      if (yellow !== null) totals.yellow_cards.push(yellow);
      if (yellow !== null || red !== null) totals.cards.push((yellow || 0) + (red || 0));
    } catch (_) {}
  }

  const averages = {};
  const isReal = {};
  for (const [key, values] of Object.entries(totals)) {
    if (values.length >= 2) {
      averages[key] = values.reduce((a, b) => a + b, 0) / values.length;
      isReal[key] = true;
    } else {
      averages[key] = GENERIC_TEAM_AVERAGE[key];
      isReal[key] = false;
    }
  }
  return { averages, isReal, matchesAnalyzed: fixtures.length };
}

function roundLine(predicted) {
  const floor = Math.floor(predicted);
  return predicted - floor >= 0.5 ? floor + 0.5 : floor - 0.5;
}

async function handlePredict(qs) {
  const homeId = parseInt(qs.home, 10);
  const awayId = parseInt(qs.away, 10);
  if (!homeId || !awayId) throw new Error('Informe "home" e "away".');
  const [homeStats, awayStats] = await Promise.all([teamAverages(homeId), teamAverages(awayId)]);
  const markets = [];
  for (const [key, label] of Object.entries(STAT_NAMES)) {
    const h = homeStats.averages[key];
    const a = awayStats.averages[key];
    const predicted = Math.round((h + a) * 10) / 10;
    markets.push({ marketLabel: label, predictedTotal: predicted, homeAvg: Math.round(h * 10) / 10, awayAvg: Math.round(a * 10) / 10, suggestedLine: roundLine(predicted), isEstimate: !homeStats.isReal[key] || !awayStats.isReal[key] });
  }
  return { homeMatchesAnalyzed: homeStats.matchesAnalyzed, awayMatchesAnalyzed: awayStats.matchesAnalyzed, markets };
}

async function handleLiveCompare(qs) {
  const fixtureId = qs.fixture;
  const homeId = parseInt(qs.home, 10);
  const awayId = parseInt(qs.away, 10);
  if (!fixtureId || !homeId || !awayId) throw new Error('Informe "fixture", "home" e "away".');
  const [homeStats, awayStats, liveJson] = await Promise.all([teamAverages(homeId), teamAverages(awayId), apiFootballGet('/fixtures/statistics', { fixture: fixtureId })]);
  const markets = [];
  for (const [key, label] of Object.entries(STAT_NAMES)) {
    const h = homeStats.averages[key];
    const a = awayStats.averages[key];
    const predicted = Math.round((h + a) * 10) / 10;
    let actual = null;
    if (key === 'cards') {
      actual = [(extractStat(liveJson, homeId, 'Yellow Cards') || 0) + (extractStat(liveJson, homeId, 'Red Cards') || 0) + (extractStat(liveJson, awayId, 'Yellow Cards') || 0) + (extractStat(liveJson, awayId, 'Red Cards') || 0)].find(() => true);
    } else if (key === 'yellow_cards') {
      actual = (extractStat(liveJson, homeId, 'Yellow Cards') || 0) + (extractStat(liveJson, awayId, 'Yellow Cards') || 0);
    } else if (STAT_API_NAME[key]) {
      const vH = extractStat(liveJson, homeId, STAT_API_NAME[key]);
      const vA = extractStat(liveJson, awayId, STAT_API_NAME[key]);
      actual = (vH !== null || vA !== null) ? (vH || 0) + (vA || 0) : null;
    }
    markets.push({ marketLabel: label, predictedTotal: predicted, suggestedLine: roundLine(predicted), isEstimate: !homeStats.isReal[key] || !awayStats.isReal[key], actual });
  }
  return { markets };
}

exports.handler = async (event) => {
  const qs = event.queryStringParameters || {};
  const action = qs.action;
  try {
    let result;
    if (action === 'fixtures') result = await handleFixtures(qs);
    else if (action === 'predict') result = await handlePredict(qs);
    else if (action === 'live_compare') result = await handleLiveCompare(qs);
    else return { statusCode: 400, body: JSON.stringify({ error: 'Use ?action=fixtures, predict ou live_compare.' }) };
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    const status = /RATE_LIMIT/.test(msg) ? 429 : /Informe/.test(msg) ? 400 : 500;
    return { statusCode: status, body: JSON.stringify({ error: msg }) };
  }
};
