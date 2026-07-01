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
  passes: 'Passes totais',
  goalkeeper_saves: 'Defesas do goleiro',
  tackles: 'Desarmes',
};

const GENERIC_TEAM_AVERAGE = {
  shots_total: 12, shots_on_target: 4.5, shots_off_target: 5.5,
  corners: 5, cards: 2.2, yellow_cards: 1.9, fouls: 11,
  offsides: 1.8, goals: 1.3, passes: 420, goalkeeper_saves: 3.5, tackles: 14,
};

const STAT_API_NAME = {
  shots_total: 'Total Shots', shots_on_target: 'Shots on Goal',
  shots_off_target: 'Shots off Goal', corners: 'Corner Kicks',
  fouls: 'Fouls', offsides: 'Offsides', passes: 'Total passes',
  goalkeeper_saves: 'Goalkeeper Saves', tackles: 'Total tackles',
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
  const totals = {
    shots_total: [], shots_on_target: [], shots_off_target: [],
    corners: [], cards: [], yellow_cards: [], fouls: [],
    offsides: [], goals: [], passes: [], goalkeeper_saves: [], tackles: [],
  };

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
      const passes = extractStat(statsJson, teamId, 'Total passes');
      const saves = extractStat(statsJson, teamId, 'Goalkeeper Saves');
      const tackles = extractStat(statsJson, teamId, 'Total tackles');
      if (shots !== null) totals.shots_total.push(shots);
      if (shotsOn !== null) totals.shots_on_target.push(shotsOn);
      if (shotsOff !== null) totals.shots_off_target.push(shotsOff);
      if (corners !== null) totals.corners.push(corners);
      if (fouls !== null) totals.fouls.push(fouls);
      if (offsides !== null) totals.offsides.push(offsides);
      if (yellow !== null) totals.yellow_cards.push(yellow);
      if (yellow !== null || red !== null) totals.cards.push((yellow || 0) + (red || 0));
      if (passes !== null) totals.passes.push(passes);
      if (saves !== null) totals.goalkeeper_saves.push(saves);
      if (tackles !== null) totals.tackles.push(tackles);
    } catch (_) {}
  }

  const averages = {}, isReal = {};
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

// Gera sugestões de "mais" e "menos" para cada mercado
function buildMarkets(homeStats, awayStats) {
  const markets = [];
  for (const [key, label] of Object.entries(STAT_NAMES)) {
    const h = homeStats.averages[key], a = awayStats.averages[key];
    const predicted = Math.round((h + a) * 10) / 10;
    const line = roundLine(predicted);
    const isEstimate = !homeStats.isReal[key] || !awayStats.isReal[key];
    // probabilidade simples baseada na distância da linha
    const diffOver = predicted - line;
    const overProb = Math.min(95, Math.max(30, Math.round(50 + (diffOver / Math.max(1, predicted)) * 60)));
    const underProb = 100 - overProb;
    markets.push({
      marketKey: key,
      marketLabel: label,
      predictedTotal: predicted,
      homeAvg: Math.round(h * 10) / 10,
      awayAvg: Math.round(a * 10) / 10,
      suggestedLine: line,
      overProb,
      underProb,
      isEstimate,
      // qual lado tem maior probabilidade
      bestSide: overProb >= underProb ? 'over' : 'under',
      bestProb: Math.max(overProb, underProb),
    });
  }
  return markets;
}

async function handlePredict(qs) {
  const homeId = parseInt(qs.home, 10);
  const awayId = parseInt(qs.away, 10);
  if (!homeId || !awayId) throw new Error('Informe "home" e "away".');
  const [homeStats, awayStats] = await Promise.all([teamAverages(homeId), teamAverages(awayId)]);
  const markets = buildMarkets(homeStats, awayStats);

  // monta bilhete com as 13 melhores apostas por probabilidade
  const ticket = [...markets]
    .sort((a, b) => b.bestProb - a.bestProb)
    .slice(0, 13)
    .map(m => ({
      marketLabel: m.marketLabel,
      side: m.bestSide,
      line: m.suggestedLine,
      prob: m.bestProb,
      label: m.bestSide === 'over'
        ? `Mais de ${m.suggestedLine} ${m.marketLabel.toLowerCase()}`
        : `Menos de ${m.suggestedLine} ${m.marketLabel.toLowerCase()}`,
    }));

  return {
    homeMatchesAnalyzed: homeStats.matchesAnalyzed,
    awayMatchesAnalyzed: awayStats.matchesAnalyzed,
    markets,
    ticket,
  };
}

async function handleLiveCompare(qs) {
  const fixtureId = qs.fixture;
  const homeId = parseInt(qs.home, 10);
  const awayId = parseInt(qs.away, 10);
  if (!fixtureId || !homeId || !awayId) throw new Error('Informe "fixture", "home" e "away".');
  const [homeStats, awayStats, liveJson] = await Promise.all([
    teamAverages(homeId), teamAverages(awayId),
    apiFootballGet('/fixtures/statistics', { fixture: fixtureId }),
  ]);
  const markets = [];
  for (const [key, label] of Object.entries(STAT_NAMES)) {
    const h = homeStats.averages[key], a = awayStats.averages[key];
    const predicted = Math.round((h + a) * 10) / 10;
    let actual = null;
    if (key === 'cards') {
      const yH = extractStat(liveJson, homeId, 'Yellow Cards'), rH = extractStat(liveJson, homeId, 'Red Cards');
      const yA = extractStat(liveJson, awayId, 'Yellow Cards'), rA = extractStat(liveJson, awayId, 'Red Cards');
      actual = (yH !== null || yA !== null) ? (yH||0)+(rH||0)+(yA||0)+(rA||0) : null;
    } else if (key === 'yellow_cards') {
      const yH = extractStat(liveJson, homeId, 'Yellow Cards'), yA = extractStat(liveJson, awayId, 'Yellow Cards');
      actual = (yH !== null || yA !== null) ? (yH||0)+(yA||0) : null;
    } else if (key === 'goals') {
      actual = null;
    } else if (STAT_API_NAME[key]) {
      const vH = extractStat(liveJson, homeId, STAT_API_NAME[key]), vA = extractStat(liveJson, awayId, STAT_API_NAME[key]);
      actual = (vH !== null || vA !== null) ? (vH||0)+(vA||0) : null;
    }
    markets.push({ marketLabel: label, predictedTotal: predicted, suggestedLine: roundLine(predicted), isEstimate: !homeStats.isReal[key]||!awayStats.isReal[key], actual });
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
