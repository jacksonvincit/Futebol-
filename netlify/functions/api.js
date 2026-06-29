// Um único arquivo de backend. Duas ações:
// ?action=fixtures&scope=today|live   -> lista de jogos
// ?action=predict&home=ID&away=ID     -> previsão de chutes/escanteios/cartões/faltas/gols
//   somando a média recente de cada time

const MARKETS = {
  shots_total: { label: 'Total de chutes', typeIds: [42] },
  corners: { label: 'Escanteios', typeIds: [34] },
  cards: { label: 'Cartões (amarelos + vermelhos)', typeIds: [84, 83] },
  fouls: { label: 'Faltas', typeIds: [56] },
  goals: { label: 'Gols', typeIds: [52] },
};

const MAX_PAGES = 3;
const TEAM_DAYS_BACK = 45;
const MAX_MATCHES_PER_TEAM = 10;

async function sportmonksGet(path, params = {}) {
  const token = process.env.SPORTMONKS_API_TOKEN;
  if (!token) throw new Error('SPORTMONKS_API_TOKEN não configurado nas variáveis de ambiente da Netlify.');
  const url = new URL('https://api.sportmonks.com/v3/football' + path);
  url.searchParams.set('api_token', token);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString());
  if (res.status === 429) throw new Error('RATE_LIMIT: limite de chamadas da Sportmonks atingido, tente de novo em alguns minutos.');
  if (!res.ok) throw new Error(`Sportmonks HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  return res.json();
}

function fmtDate(d) { return d.toISOString().slice(0, 10); }

function mapFixture(fx) {
  const participants = fx.participants || [];
  const home = participants.find((p) => p.meta && p.meta.location === 'home') || participants[0];
  const away = participants.find((p) => p.meta && p.meta.location === 'away') || participants[1];
  const scoreFor = (id) => {
    if (!fx.scores || !id) return null;
    const s = fx.scores.find((sc) => sc.participant_id === id && sc.description === 'CURRENT');
    return s ? s.score.goals : null;
  };
  return {
    id: fx.id,
    league: fx.league ? fx.league.name : null,
    startingAt: fx.starting_at,
    stateId: fx.state_id,
    home: home ? home.name : '?',
    away: away ? away.name : '?',
    homeId: home ? home.id : null,
    awayId: away ? away.id : null,
    homeGoals: scoreFor(home && home.id),
    awayGoals: scoreFor(away && away.id),
  };
}

async function handleFixtures(qs) {
  const scope = qs.scope === 'live' ? 'live' : 'today';
  if (scope === 'live') {
    const json = await sportmonksGet('/livescores/inplay', { include: 'participants;league;scores' });
    return { fixtures: (json.data || []).map(mapFixture) };
  }
  const date = qs.date || fmtDate(new Date());
  const json = await sportmonksGet(`/fixtures/date/${date}`, { include: 'participants;league;scores' });
  return { fixtures: (json.data || []).map(mapFixture) };
}

function sumStat(statistics, participantId, typeIds) {
  return statistics
    .filter((s) => s.participant_id === participantId && typeIds.includes(s.type_id))
    .reduce((acc, s) => acc + (s.data && typeof s.data.value === 'number' ? s.data.value : 0), 0);
}

async function teamAverages(teamId) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - TEAM_DAYS_BACK);

  let page = 1;
  let all = [];
  while (page <= MAX_PAGES) {
    const json = await sportmonksGet(`/fixtures/between/${fmtDate(start)}/${fmtDate(end)}/${teamId}`, {
      include: 'statistics;participants',
      page,
    });
    all = all.concat(json.data || []);
    if (!json.pagination || !json.pagination.has_more) break;
    page += 1;
  }

  const finished = all
    .filter((f) => f.state_id === 5 && Array.isArray(f.statistics) && f.statistics.length > 0)
    .sort((a, b) => new Date(b.starting_at) - new Date(a.starting_at))
    .slice(0, MAX_MATCHES_PER_TEAM);

  const totals = {};
  for (const key of Object.keys(MARKETS)) totals[key] = [];

  for (const fx of finished) {
    for (const [key, def] of Object.entries(MARKETS)) {
      totals[key].push(sumStat(fx.statistics, teamId, def.typeIds));
    }
  }

  const averages = {};
  for (const [key, values] of Object.entries(totals)) {
    averages[key] = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  }

  return { averages, matchesAnalyzed: finished.length };
}

function roundLine(predicted) {
  const floor = Math.floor(predicted);
  return predicted - floor >= 0.5 ? floor + 0.5 : floor - 0.5;
}

async function handlePredict(qs) {
  const homeId = parseInt(qs.home, 10);
  const awayId = parseInt(qs.away, 10);
  if (!homeId || !awayId) throw new Error('Informe os parâmetros "home" e "away" (IDs dos times).');

  const [homeStats, awayStats] = await Promise.all([teamAverages(homeId), teamAverages(awayId)]);

  const markets = [];
  for (const [key, def] of Object.entries(MARKETS)) {
    const h = homeStats.averages[key];
    const a = awayStats.averages[key];
    if (h === null || a === null) continue;
    const predicted = Math.round((h + a) * 10) / 10;
    markets.push({
      marketLabel: def.label,
      predictedTotal: predicted,
      homeAvg: Math.round(h * 10) / 10,
      awayAvg: Math.round(a * 10) / 10,
      suggestedLine: roundLine(predicted),
    });
  }

  return {
    homeMatchesAnalyzed: homeStats.matchesAnalyzed,
    awayMatchesAnalyzed: awayStats.matchesAnalyzed,
    markets,
  };
}

exports.handler = async (event) => {
  const qs = event.queryStringParameters || {};
  const action = qs.action;
  try {
    let result;
    if (action === 'fixtures') result = await handleFixtures(qs);
    else if (action === 'predict') result = await handlePredict(qs);
    else return { statusCode: 400, body: JSON.stringify({ error: 'Use ?action=fixtures ou ?action=predict.' }) };

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    const status = /RATE_LIMIT/.test(msg) ? 429 : /Informe/.test(msg) ? 400 : 500;
    return { statusCode: status, body: JSON.stringify({ error: msg }) };
  }
};
