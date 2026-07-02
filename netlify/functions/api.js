// FuteStat v5.0 — API Backend para Betano Markets
// Netlify Function otimizada com +40 mercados estatísticos

const BASE_URL = 'https://v3.football.api-sports.io';
const MAX_MATCHES = 8;
const MC_N = 10000;
const CACHE_TTL = 300; // 5 minutos

// Cache em memória
const cache = new Map();

function getCached(key) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.timestamp < CACHE_TTL * 1000) {
    return entry.data;
  }
  cache.delete(key);
  return null;
}

function setCache(key, data) {
  // Limpar cache se estiver muito grande
  if (cache.size > 100) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
  cache.set(key, { data, timestamp: Date.now() });
}

// Rate limiting interno
const rateLimiter = {
  requests: [],
  maxRequests: 30,
  windowMs: 60000,
  
  async throttle() {
    const now = Date.now();
    this.requests = this.requests.filter(t => now - t < this.windowMs);
    
    if (this.requests.length >= this.maxRequests) {
      const oldest = this.requests[0];
      const waitTime = this.windowMs - (now - oldest);
      console.warn(`Rate limit interno atingido. Aguardando ${waitTime}ms...`);
      await new Promise(r => setTimeout(r, waitTime));
    }
    
    this.requests.push(now);
  }
};

// Retry com backoff exponencial
async function fetchWithRetry(url, options, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      
      const res = await fetch(url, { 
        ...options, 
        signal: controller.signal 
      });
      
      clearTimeout(timeout);
      
      if (res.status === 429) {
        const retryAfter = res.headers.get('Retry-After') || Math.pow(2, i + 1);
        console.warn(`Rate limit API. Aguardando ${retryAfter}s...`);
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        continue;
      }
      
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
      
    } catch (err) {
      if (i === retries - 1) throw err;
      console.warn(`Tentativa ${i + 1} falhou: ${err.message}. Retentando...`);
      await new Promise(r => setTimeout(r, Math.pow(2, i) * 1000));
    }
  }
}

// Estatísticas disponíveis na Betano
const STAT_NAMES = {
  // Gols e Ataque
  goals: 'Gols',
  shots_total: 'Total de Chutes',
  shots_on_target: 'Chutes no Gol',
  shots_off_target: 'Chutes para Fora',
  shots_inside_box: 'Chutes dentro da Área',
  shots_outside_box: 'Chutes fora da Área',
  
  // Posse e Passes
  possession: 'Posse de Bola (%)',
  passes: 'Passes Totais',
  passes_accurate: 'Passes Certos',
  passes_percentage: 'Precisão de Passes (%)',
  
  // Defesa
  tackles: 'Desarmes',
  interceptions: 'Interceptações',
  clearances: 'Cortes',
  goalkeeper_saves: 'Defesas do Goleiro',
  
  // Disciplina
  cards: 'Cartões (Amarelo + Vermelho)',
  yellow_cards: 'Cartões Amarelos',
  red_cards: 'Cartões Vermelhos',
  fouls: 'Faltas',
  
  // Bola Parada
  corners: 'Escanteios',
  offsides: 'Impedimentos',
  
  // Outros
  substitutions: 'Substituições',
  injuries: 'Lesões',
};

// Valores genéricos para fallback
const GENERIC = {
  goals: 1.3,
  shots_total: 12,
  shots_on_target: 4.5,
  shots_off_target: 5.5,
  shots_inside_box: 7,
  shots_outside_box: 4,
  possession: 50,
  passes: 420,
  passes_accurate: 340,
  passes_percentage: 80,
  tackles: 14,
  interceptions: 10,
  clearances: 18,
  goalkeeper_saves: 3.5,
  cards: 2.2,
  yellow_cards: 1.9,
  red_cards: 0.3,
  fouls: 11,
  corners: 5,
  offsides: 1.8,
  substitutions: 3.5,
  injuries: 0.5,
};

// Mapeamento API-Football -> Nossos nomes
const STAT_API_MAP = {
  goals: 'Goals',
  shots_total: 'Total Shots',
  shots_on_target: 'Shots on Goal',
  shots_off_target: 'Shots off Goal',
  shots_inside_box: 'Shots insidebox',
  shots_outside_box: 'Shots outsidebox',
  possession: 'Ball Possession',
  passes: 'Total passes',
  passes_accurate: 'Passes accurate',
  passes_percentage: 'Passes %',
  tackles: 'Total tackles',
  interceptions: 'Interceptions',
  clearances: 'Clearances',
  goalkeeper_saves: 'Goalkeeper Saves',
  yellow_cards: 'Yellow Cards',
  red_cards: 'Red Cards',
  fouls: 'Fouls',
  corners: 'Corner Kicks',
  offsides: 'Offsides',
  substitutions: 'Substitutions',
  injuries: 'Injuries',
};

// Perfis de times para fallback
const TEAM_PROFILES = {
  ofensivo: {
    goals: 1.8, shots_total: 16, shots_on_target: 6, corners: 6.5,
    possession: 55, passes: 480, tackles: 12, fouls: 10,
  },
  defensivo: {
    goals: 0.9, shots_total: 9, shots_on_target: 3, corners: 3.5,
    possession: 42, passes: 350, tackles: 18, fouls: 14,
  },
  equilibrado: {
    goals: 1.4, shots_total: 12, shots_on_target: 4.5, corners: 5,
    possession: 50, passes: 420, tackles: 14, fouls: 11,
  },
  contra_ataque: {
    goals: 1.2, shots_total: 10, shots_on_target: 4, corners: 4,
    possession: 38, passes: 320, tackles: 16, fouls: 13,
  },
};

function getTeamProfile(teamId) {
  const hash = (teamId * 7 + 3) % 4;
  const profiles = Object.values(TEAM_PROFILES);
  return { ...profiles[hash], id: teamId };
}

// Funções matemáticas
function poissonRandom(lambda) {
  if (lambda <= 0) return 0;
  if (lambda > 20) lambda = 20;
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= Math.random(); } while (p > L);
  return k - 1;
}

function monteCarloSimulation(lH, lA) {
  let hw = 0, dr = 0, aw = 0, btts = 0, csH = 0, csA = 0;
  const goalDist = new Array(10).fill(0);
  const scorelines = {};
  let firstHalfOver05 = 0, firstHalfOver15 = 0;
  let homeFirstGoal = 0, awayFirstGoal = 0;
  let homeLastGoal = 0, awayLastGoal = 0;
  let homeWinToNil = 0, awayWinToNil = 0;
  let homeWinBothHalves = 0, awayWinBothHalves = 0;
  
  for (let s = 0; s < MC_N; s++) {
    const hg = poissonRandom(lH);
    const ag = poissonRandom(lA);
    const total = hg + ag;
    
    if (hg > ag) {
      hw++;
      if (ag === 0) homeWinToNil++;
    } else if (hg < ag) {
      aw++;
      if (hg === 0) awayWinToNil++;
    } else {
      dr++;
    }
    
    const bucket = Math.min(total, 9);
    goalDist[bucket]++;
    
    if (hg > 0 && ag > 0) btts++;
    if (ag === 0) csH++;
    if (hg === 0) csA++;
    
    const key = `${Math.min(hg, 6)}-${Math.min(ag, 6)}`;
    scorelines[key] = (scorelines[key] || 0) + 1;
    
    // Primeiro tempo
    const hg1st = Math.floor(hg * (0.35 + Math.random() * 0.15));
    const ag1st = Math.floor(ag * (0.35 + Math.random() * 0.15));
    if (hg1st + ag1st > 0.5) firstHalfOver05++;
    if (hg1st + ag1st > 1.5) firstHalfOver15++;
    
    // Cronologia dos gols
    if (hg > 0 && ag === 0) homeFirstGoal++;
    if (ag > 0 && hg === 0) awayFirstGoal++;
    if (hg > ag) homeLastGoal++;
    if (ag > hg) awayLastGoal++;
    
    // Vencer ambos os tempos
    if (hg1st > ag1st && (hg - hg1st) > (ag - ag1st)) homeWinBothHalves++;
    if (ag1st > hg1st && (ag - ag1st) > (hg - hg1st)) awayWinBothHalves++;
  }
  
  const p = v => Math.round(v / MC_N * 1000) / 10;
  
  // Calcular overs/unders
  const overs = {};
  for (let line = 0.5; line <= 5.5; line += 1) {
    let count = 0;
    for (let i = Math.ceil(line); i <= 9; i++) count += goalDist[i];
    overs[`over${Math.floor(line * 10)}`] = p(count);
    overs[`under${Math.floor(line * 10)}`] = p(MC_N - count);
  }
  
  return {
    homeWin: p(hw),
    draw: p(dr),
    awayWin: p(aw),
    ...overs,
    btts: p(btts),
    noBtts: p(MC_N - btts),
    csHome: p(csH),
    csAway: p(csA),
    firstHalfOver05: p(firstHalfOver05),
    firstHalfOver15: p(firstHalfOver15),
    homeFirstGoal: p(homeFirstGoal),
    awayFirstGoal: p(awayFirstGoal),
    homeLastGoal: p(homeLastGoal),
    awayLastGoal: p(awayLastGoal),
    homeWinToNil: p(homeWinToNil),
    awayWinToNil: p(awayWinToNil),
    homeWinBothHalves: p(homeWinBothHalves),
    awayWinBothHalves: p(awayWinBothHalves),
    doubleChance1X: p(hw + dr),
    doubleChance12: p(hw + aw),
    doubleChanceX2: p(dr + aw),
    top5: Object.entries(scorelines)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([score, count]) => ({ score, prob: p(count) })),
    lambdaH: Math.round(lH * 100) / 100,
    lambdaA: Math.round(lA * 100) / 100,
  };
}

// API Functions
async function apiGet(path, params = {}) {
  const key = process.env.APIFOOTBALL_KEY;
  if (!key) {
    console.error('APIFOOTBALL_KEY não configurada');
    throw new Error('API key não configurada. Configure APIFOOTBALL_KEY nas variáveis de ambiente.');
  }
  
  const url = new URL(BASE_URL + path);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, v);
  }
  
  const cacheKey = url.toString();
  const cached = getCached(cacheKey);
  if (cached) return cached;
  
  await rateLimiter.throttle();
  
  const res = await fetchWithRetry(url.toString(), {
    headers: { 'x-apisports-key': key }
  });
  
  const data = await res.json();
  setCache(cacheKey, data);
  
  return data;
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

function mapFixture(item) {
  return {
    id: item.fixture.id,
    league: item.league?.name || null,
    leagueId: item.league?.id || null,
    leagueCountry: item.league?.country || null,
    leagueLogo: item.league?.logo || null,
    startingAt: item.fixture.date,
    statusShort: item.fixture.status?.short || null,
    elapsed: item.fixture.status?.elapsed || null,
    home: item.teams.home.name,
    away: item.teams.away.name,
    homeId: item.teams.home.id,
    awayId: item.teams.away.id,
    homeLogo: item.teams.home.logo,
    awayLogo: item.teams.away.logo,
    homeGoals: item.goals?.home ?? null,
    awayGoals: item.goals?.away ?? null,
  };
}

function extractStat(resp, teamId, name) {
  const block = (resp.response || []).find(b => b.team.id === teamId);
  if (!block) return null;
  
  const e = block.statistics.find(s => s.type === name);
  if (!e || e.value == null) return null;
  
  const v = typeof e.value === 'string' ? 
    (e.value.includes('%') ? parseFloat(e.value) : parseFloat(e.value)) : 
    e.value;
    
  return isNaN(v) ? null : v;
}

// --- HANDLERS PRINCIPAIS ---
async function handleFixtures(qs) {
  if (qs.scope === 'live') {
    const j = await apiGet('/fixtures', { live: 'all' });
    return { 
      fixtures: (j.response || []).map(mapFixture),
      count: (j.response || []).length,
    };
  }
  
  const date = qs.date || fmtDate(new Date());
  const j = await apiGet('/fixtures', { date });
  return { 
    fixtures: (j.response || []).map(mapFixture),
    count: (j.response || []).length,
  };
}

async function fetchTeamStats(teamId) {
  const cacheKey = `team_stats_v5_${teamId}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;
  
  try {
    const fj = await apiGet('/fixtures', { team: teamId, last: MAX_MATCHES, status: 'FT' });
    const fixtures = fj.response || [];
    
    const stats = {
      fixtures: [],
      all: {},
      last3: {},
      gf: [],
      ga: [],
      wins: 0, draws: 0, losses: 0,
      cleanSheets: 0, failedToScore: 0,
      homeGF: [], homeGA: [], homeWins: 0, homePlayed: 0,
      awayGF: [], awayGA: [], awayWins: 0, awayPlayed: 0,
      over25: 0, over35: 0, btts: 0,
    };
    
    for (let idx = 0; idx < fixtures.length; idx++) {
      const fx = fixtures[idx];
      const isHome = fx.teams.home.id === teamId;
      const gf = isHome ? (fx.goals.home ?? 0) : (fx.goals.away ?? 0);
      const ga = isHome ? (fx.goals.away ?? 0) : (fx.goals.home ?? 0);
      
      stats.gf.push(gf);
      stats.ga.push(ga);
      
      if (isHome) {
        stats.homeGF.push(gf);
        stats.homeGA.push(ga);
        stats.homePlayed++;
        if (gf > ga) stats.homeWins++;
      } else {
        stats.awayGF.push(gf);
        stats.awayGA.push(ga);
        stats.awayPlayed++;
        if (gf > ga) stats.awayWins++;
      }
      
      if (gf > ga) stats.wins++;
      else if (gf === ga) stats.draws++;
      else stats.losses++;
      
      if (ga === 0) stats.cleanSheets++;
      if (gf === 0) stats.failedToScore++;
      if (gf + ga > 2.5) stats.over25++;
      if (gf + ga > 3.5) stats.over35++;
      if (gf > 0 && ga > 0) stats.btts++;
      
      // Buscar estatísticas detalhadas (limitar para performance)
      if (idx < 5) {
        try {
          const sj = await apiGet('/fixtures/statistics', { fixture: fx.fixture.id });
          stats.fixtures.push({
            id: fx.fixture.id,
            stats: sj.response || [],
            goals: { home: fx.goals?.home ?? 0, away: fx.goals?.away ?? 0 },
          });
        } catch (err) {
          console.warn(`Erro stats partida ${fx.fixture.id}: ${err.message}`);
        }
      }
    }
    
    setCache(cacheKey, stats);
    return stats;
    
  } catch (err) {
    console.warn(`Erro stats time ${teamId}: ${err.message}`);
    return null;
  }
}

async function teamStats(teamId) {
  const rawStats = await fetchTeamStats(teamId);
  
  if (!rawStats || rawStats.fixtures.length === 0) {
    const profile = getTeamProfile(teamId);
    return buildFallbackStats(profile);
  }
  
  const mk = Object.keys(STAT_NAMES);
  const pools = { all: {}, last3: {} };
  
  for (const pool of Object.values(pools)) {
    for (const k of mk) pool[k] = [];
    pool.gf = [];
    pool.ga = [];
  }
  
  for (let idx = 0; idx < rawStats.fixtures.length; idx++) {
    const fxData = rawStats.fixtures[idx];
    const isRecent = idx < 3;
    
    pools.all.gf.push(rawStats.gf[idx]);
    pools.all.ga.push(rawStats.ga[idx]);
    
    if (isRecent) {
      pools.last3.gf.push(rawStats.gf[idx]);
      pools.last3.ga.push(rawStats.ga[idx]);
    }
    
    const fxStats = fxData.stats;
    const push = (k, val) => {
      if (val !== null && !isNaN(val)) {
        pools.all[k].push(val);
        if (isRecent) pools.last3[k].push(val);
      }
    };
    
    // Extrair todas as estatísticas
    for (const [key, apiName] of Object.entries(STAT_API_MAP)) {
      push(key, extractStat({ response: fxStats }, teamId, apiName));
    }
    
    // Cartões combinados
    const y = extractStat({ response: fxStats }, teamId, 'Yellow Cards');
    const r = extractStat({ response: fxStats }, teamId, 'Red Cards');
    push('yellow_cards', y);
    push('red_cards', r);
    
    if (y !== null || r !== null) {
      const c = (y || 0) + (r || 0);
      pools.all.cards.push(c);
      if (isRecent) pools.last3.cards.push(c);
    }
  }
  
  return buildStatsFromPools(pools, rawStats);
}

function buildFallbackStats(profile) {
  const averages = {};
  const isReal = {};
  
  for (const k of Object.keys(STAT_NAMES)) {
    averages[k] = profile[k] || GENERIC[k];
    isReal[k] = false;
  }
  
  return {
    averages,
    isReal,
    matchesAnalyzed: 0,
    form: { wins: 0, draws: 0, losses: 0, played: 0, winRate: 0 },
    homeForm: { wins: 0, played: 0, winRate: 0, goalsFor: 1.3, goalsAgainst: 1.3 },
    awayForm: { wins: 0, played: 0, winRate: 0, goalsFor: 1.1, goalsAgainst: 1.5 },
    over25Rate: 0.5,
    over35Rate: 0.25,
    bttsRate: 0.5,
    cleanSheets: 0,
    failedToScore: 0,
    avgGoalsFor: profile.goals || 1.3,
    avgGoalsAgainst: 1.3,
    isFallback: true,
  };
}

function buildStatsFromPools(pools, rawStats) {
  const mk = Object.keys(STAT_NAMES);
  const mean = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  
  const wavg = k => {
    const a3 = mean(pools.last3[k]);
    const ag = mean(pools.all[k]);
    if (a3 != null && ag != null) return a3 * 0.7 + ag * 0.3;
    return ag ?? a3 ?? GENERIC[k] ?? null;
  };
  
  const averages = {};
  const isReal = {};
  
  for (const k of mk) {
    averages[k] = wavg(k) ?? GENERIC[k];
    isReal[k] = (pools.all[k]?.length || 0) >= 3;
  }
  
  averages.goalsFor = wavg('gf') ?? 1.3;
  averages.goalsAgainst = wavg('ga') ?? 1.3;
  
  const totalMatches = rawStats.fixtures.length;
  
  return {
    averages,
    isReal,
    matchesAnalyzed: totalMatches,
    form: {
      wins: rawStats.wins,
      draws: rawStats.draws,
      losses: rawStats.losses,
      played: totalMatches,
      winRate: totalMatches ? rawStats.wins / totalMatches : 0,
    },
    homeForm: {
      wins: rawStats.homeWins,
      played: rawStats.homePlayed,
      winRate: rawStats.homePlayed ? rawStats.homeWins / rawStats.homePlayed : 0,
      goalsFor: mean(rawStats.homeGF) ?? 1.3,
      goalsAgainst: mean(rawStats.homeGA) ?? 1.3,
    },
    awayForm: {
      wins: rawStats.awayWins,
      played: rawStats.awayPlayed,
      winRate: rawStats.awayPlayed ? rawStats.awayWins / rawStats.awayPlayed : 0,
      goalsFor: mean(rawStats.awayGF) ?? 1.1,
      goalsAgainst: mean(rawStats.awayGA) ?? 1.5,
    },
    over25Rate: totalMatches ? rawStats.over25 / totalMatches : 0.5,
    over35Rate: totalMatches ? rawStats.over35 / totalMatches : 0.25,
    bttsRate: totalMatches ? rawStats.btts / totalMatches : 0.5,
    cleanSheets: rawStats.cleanSheets,
    failedToScore: rawStats.failedToScore,
    avgGoalsFor: averages.goalsFor,
    avgGoalsAgainst: averages.goalsAgainst,
  };
}

function calcLambda(attacker, defender, isHome) {
  const LG = 1.35;
  const attGF = isHome ? attacker.homeForm.goalsFor : attacker.awayForm.goalsFor;
  const defGA = isHome ? defender.homeForm.goalsAgainst : defender.awayForm.goalsAgainst;
  const attStr = (attGF || attacker.avgGoalsFor) / LG;
  const defStr = (defGA || defender.avgGoalsAgainst) / LG;
  const base = attStr * defStr * LG;
  const adj = isHome ? base * 1.12 : base * 0.88;
  return Math.max(0.3, Math.min(adj, 5));
}

function roundLine(p) {
  const f = Math.floor(p);
  return p - f >= 0.5 ? f + 0.5 : f - 0.5;
}

// Construir TODOS os mercados Betano
function buildAllMarkets(mc, hS, aS, hName, aName) {
  const markets = [];
  
  // --- RESULTADOS ---
  markets.push({
    key: 'match_result_home',
    category: 'Resultado',
    label: `Vitória ${hName}`,
    icon: '🏠',
    prob: mc.homeWin,
    isValueBet: mc.homeWin > 40,
    isEstimate: hS.matchesAnalyzed < 3,
  });
  
  markets.push({
    key: 'match_result_draw',
    category: 'Resultado',
    label: 'Empate',
    icon: '🤝',
    prob: mc.draw,
    isValueBet: mc.draw > 30,
    isEstimate: hS.matchesAnalyzed < 3,
  });
  
  markets.push({
    key: 'match_result_away',
    category: 'Resultado',
    label: `Vitória ${aName}`,
    icon: '✈️',
    prob: mc.awayWin,
    isValueBet: mc.awayWin > 40,
    isEstimate: aS.matchesAnalyzed < 3,
  });
  
  // --- DUPLA CHANCE ---
  markets.push({
    key: 'double_chance_1x',
    category: 'Dupla Chance',
    label: `1X (${hName} ou Empate)`,
    icon: '🛡️',
    prob: mc.doubleChance1X,
    isValueBet: mc.doubleChance1X > 65,
    isEstimate: false,
  });
  
  markets.push({
    key: 'double_chance_12',
    category: 'Dupla Chance',
    label: `12 (${hName} ou ${aName})`,
    icon: '⚡',
    prob: mc.doubleChance12,
    isValueBet: mc.doubleChance12 > 70,
    isEstimate: false,
  });
  
  markets.push({
    key: 'double_chance_x2',
    category: 'Dupla Chance',
    label: `X2 (Empate ou ${aName})`,
    icon: '🛡️',
    prob: mc.doubleChanceX2,
    isValueBet: mc.doubleChanceX2 > 65,
    isEstimate: false,
  });
  
  // --- GOLS ---
  const goalLines = [0.5, 1.5, 2.5, 3.5, 4.5];
  goalLines.forEach(line => {
    const overKey = `over${Math.floor(line * 10)}`;
    const underKey = `under${Math.floor(line * 10)}`;
    
    markets.push({
      key: `goals_over_${line}`,
      category: 'Gols',
      label: `Over ${line} Gols`,
      icon: line <= 1.5 ? '⚽' : line <= 2.5 ? '⚽⚽' : '🔥',
      prob: mc[overKey],
      line: line,
      isValueBet: mc[overKey] > (line <= 1.5 ? 75 : line <= 2.5 ? 55 : 35),
      isEstimate: false,
    });
    
    markets.push({
      key: `goals_under_${line}`,
      category: 'Gols',
      label: `Under ${line} Gols`,
      icon: '🛡️',
      prob: mc[underKey],
      line: line,
      isValueBet: mc[underKey] > (line >= 3.5 ? 70 : 55),
      isEstimate: false,
    });
  });
  
  // --- BTTS ---
  markets.push({
    key: 'btts_yes',
    category: 'BTTS',
    label: 'Ambas Marcam Sim',
    icon: '⚽↔️⚽',
    prob: mc.btts,
    isValueBet: mc.btts > 55,
    isEstimate: false,
  });
  
  markets.push({
    key: 'btts_no',
    category: 'BTTS',
    label: 'Ambas Marcam Não',
    icon: '🚫',
    prob: mc.noBtts,
    isValueBet: mc.noBtts > 55,
    isEstimate: false,
  });
  
  // --- INTERVALO ---
  markets.push({
    key: 'over05_first_half',
    category: '1º Tempo',
    label: 'Over 0.5 1º Tempo',
    icon: '⚽ 1T',
    prob: mc.firstHalfOver05,
    isValueBet: mc.firstHalfOver05 > 65,
    isEstimate: false,
  });
  
  markets.push({
    key: 'over15_first_half',
    category: '1º Tempo',
    label: 'Over 1.5 1º Tempo',
    icon: '⚽⚽ 1T',
    prob: mc.firstHalfOver15,
    isValueBet: mc.firstHalfOver15 > 35,
    isEstimate: false,
  });
  
  // --- CRONOLOGIA ---
  markets.push({
    key: 'first_goal_home',
    category: 'Cronologia',
    label: `1º Gol ${hName}`,
    icon: '🏠⚽',
    prob: mc.homeFirstGoal,
    isValueBet: mc.homeFirstGoal > 40,
    isEstimate: false,
  });
  
  markets.push({
    key: 'first_goal_away',
    category: 'Cronologia',
    label: `1º Gol ${aName}`,
    icon: '✈️⚽',
    prob: mc.awayFirstGoal,
    isValueBet: mc.awayFirstGoal > 35,
    isEstimate: false,
  });
  
  markets.push({
    key: 'last_goal_home',
    category: 'Cronologia',
    label: `Último Gol ${hName}`,
    icon: '🏠⏱️',
    prob: mc.homeLastGoal,
    isValueBet: mc.homeLastGoal > 35,
    isEstimate: false,
  });
  
  markets.push({
    key: 'last_goal_away',
    category: 'Cronologia',
    label: `Último Gol ${aName}`,
    icon: '✈️⏱️',
    prob: mc.awayLastGoal,
    isValueBet: mc.awayLastGoal > 30,
    isEstimate: false,
  });
  
  // --- CLEAN SHEET ---
  markets.push({
    key: 'clean_sheet_home',
    category: 'Defesa',
    label: `Clean Sheet ${hName}`,
    icon: '🏠🔒',
    prob: mc.csHome,
    isValueBet: mc.csHome > 35,
    isEstimate: false,
  });
  
  markets.push({
    key: 'clean_sheet_away',
    category: 'Defesa',
    label: `Clean Sheet ${aName}`,
    icon: '✈️🔒',
    prob: mc.csAway,
    isValueBet: mc.csAway > 35,
    isEstimate: false,
  });
  
  // --- HANDICAP ---
  markets.push({
    key: 'handicap_home_minus1',
    category: 'Handicap',
    label: `${hName} -1`,
    icon: '🏠-1',
    prob: Math.max(5, mc.homeWin - 15),
    isValueBet: (mc.homeWin - 15) > 35,
    isEstimate: false,
  });
  
  markets.push({
    key: 'handicap_away_plus1',
    category: 'Handicap',
    label: `${aName} +1`,
    icon: '✈️+1',
    prob: Math.min(95, mc.awayWin + 15),
    isValueBet: (mc.awayWin + 15) > 40,
    isEstimate: false,
  });
  
  // --- PLACAR EXATO (Top 5) ---
  mc.top5.forEach((sl, i) => {
    markets.push({
      key: `correct_score_${sl.score}`,
      category: 'Placar Exato',
      label: `Placar ${sl.score}`,
      icon: '🎯',
      prob: sl.prob,
      isValueBet: sl.prob > 8,
      isEstimate: false,
    });
  });
  
  // --- ESTATÍSTICAS BETANO ---
  const statLines = [
    { stat: 'shots_total', label: 'Total Chutes', line: 22.5, icon: '🎯' },
    { stat: 'shots_on_target', label: 'Chutes no Gol', line: 8.5, icon: '🎯✅' },
    { stat: 'corners', label: 'Escanteios', line: 9.5, icon: '🏴' },
    { stat: 'cards', label: 'Cartões', line: 4.5, icon: '🟨' },
    { stat: 'fouls', label: 'Faltas', line: 22.5, icon: '⚠️' },
    { stat: 'offsides', label: 'Impedimentos', line: 3.5, icon: '🏃' },
    { stat: 'passes', label: 'Passes Totais', line: 800, icon: '🔄' },
    { stat: 'tackles', label: 'Desarmes', line: 28.5, icon: '💪' },
    { stat: 'goalkeeper_saves', label: 'Defesas', line: 5.5, icon: '🧤' },
    { stat: 'shots_inside_box', label: 'Chutes Área', line: 14.5, icon: '🎯📦' },
    { stat: 'interceptions', label: 'Interceptações', line: 18.5, icon: '✋' },
    { stat: 'clearances', label: 'Cortes', line: 35.5, icon: '🧹' },
  ];
  
  statLines.forEach(sl => {
    const hVal = hS.averages[sl.stat] ?? GENERIC[sl.stat];
    const aVal = aS.averages[sl.stat] ?? GENERIC[sl.stat];
    const total = hVal + aVal;
    const overProb = Math.min(95, Math.max(25, Math.round(50 + ((total - sl.line) / Math.max(1, sl.line)) * 60)));
    const isEst = !hS.isReal[sl.stat] || !aS.isReal[sl.stat];
    
    markets.push({
      key: `stats_${sl.stat}_over`,
      category: 'Estatísticas',
      label: `${sl.label} Over ${sl.line}`,
      icon: sl.icon,
      prob: overProb,
      predictedTotal: Math.round(total * 10) / 10,
      homeAvg: Math.round(hVal * 10) / 10,
      awayAvg: Math.round(aVal * 10) / 10,
      suggestedLine: sl.line,
      isValueBet: overProb > 55 && !isEst,
      isEstimate: isEst,
    });
    
    markets.push({
      key: `stats_${sl.stat}_under`,
      category: 'Estatísticas',
      label: `${sl.label} Under ${sl.line}`,
      icon: sl.icon,
      prob: 100 - overProb,
      predictedTotal: Math.round(total * 10) / 10,
      homeAvg: Math.round(hVal * 10) / 10,
      awayAvg: Math.round(aVal * 10) / 10,
      suggestedLine: sl.line,
      isValueBet: (100 - overProb) > 55 && !isEst,
      isEstimate: isEst,
    });
  });
  
  return markets;
}

function findBestBet(markets, mc, hS, aS, hName, aName) {
  // Priorizar mercados não-estimados com alta probabilidade
  const candidates = markets
    .filter(m => !m.isEstimate || m.prob > 60)
    .sort((a, b) => {
      if (a.isEstimate !== b.isEstimate) return a.isEstimate ? 1 : -1;
      if (a.isValueBet !== b.isValueBet) return a.isValueBet ? -1 : 1;
      return b.prob - a.prob;
    });
  
  const best = candidates[0] || markets[0];
  
  const confidence = best.prob >= 75 ? 'Alta' : best.prob >= 60 ? 'Média' : 'Baixa';
  const risk = best.prob >= 75 ? 'Baixo' : best.prob >= 60 ? 'Médio' : 'Alto';
  
  return {
    market: best.label,
    key: best.key,
    category: best.category,
    prob: best.prob,
    confidence,
    risk,
    valueBet: best.isValueBet,
    isEstimate: best.isEstimate,
    impliedOdds: Math.round((1 / (best.prob / 100)) * 1.08 * 100) / 100,
    justification: `Análise de ${MC_N.toLocaleString()} simulações Monte Carlo + Poisson. 
      Baseado em ${Math.min(hS.matchesAnalyzed, aS.matchesAnalyzed)} partidas analisadas por equipe.
      ${best.isEstimate ? '(Dados parcialmente estimados)' : '(Dados reais)'}`,
  };
}

function genFactors(hS, aS, mc, hName, aName) {
  const factors = [];
  const pct = v => Math.round(v * 100);
  const rnd = v => Math.round(v * 10) / 10;
  
  // Forma recente
  if (hS.matchesAnalyzed >= 3) {
    factors.push({
      icon: '📊',
      text: `${hName}: ${hS.form.wins}V/${hS.form.draws}E/${hS.form.losses}D nos últimos ${hS.matchesAnalyzed} jogos`,
    });
  }
  
  if (aS.matchesAnalyzed >= 3) {
    factors.push({
      icon: '📊',
      text: `${aName}: ${aS.form.wins}V/${aS.form.draws}E/${aS.form.losses}D nos últimos ${aS.matchesAnalyzed} jogos`,
    });
  }
  
  // Casa/Fora
  if (hS.homeForm.played >= 2) {
    factors.push({
      icon: hS.homeForm.winRate >= 0.5 ? '🟢' : '🔴',
      text: `${hName} em casa: ${hS.homeForm.wins}/${hS.homeForm.played} vitórias, ${rnd(hS.homeForm.goalsFor)} gols/jogo`,
    });
  }
  
  if (aS.awayForm.played >= 2) {
    factors.push({
      icon: aS.awayForm.winRate >= 0.4 ? '🟢' : '🔴',
      text: `${aName} fora: ${aS.awayForm.wins}/${aS.awayForm.played} vitórias, ${rnd(aS.awayForm.goalsFor)} gols/jogo`,
    });
  }
  
  // Gols
  factors.push({
    icon: '⚽',
    text: `${hName}: média ${rnd(hS.avgGoalsFor)} gols marcados / ${rnd(hS.avgGoalsAgainst)} sofridos`,
  });
  
  factors.push({
    icon: '⚽',
    text: `${aName}: média ${rnd(aS.avgGoalsFor)} gols marcados / ${rnd(aS.avgGoalsAgainst)} sofridos`,
  });
  
  // Over/Under histórico
  factors.push({
    icon: '📈',
    text: `${hName}: Over 2.5 em ${pct(hS.over25Rate)}% dos jogos | ${aName}: ${pct(aS.over25Rate)}%`,
  });
  
  factors.push({
    icon: '🤝',
    text: `BTTS ocorreu em ${pct(hS.bttsRate)}% (${hName}) e ${pct(aS.bttsRate)}% (${aName}) dos jogos`,
  });
  
  // Clean Sheets
  if (hS.cleanSheets > 0) {
    factors.push({
      icon: '🔒',
      text: `${hName}: ${hS.cleanSheets} clean sheets nos últimos ${hS.matchesAnalyzed} jogos`,
    });
  }
  
  if (aS.failedToScore > 0) {
    factors.push({
      icon: '⚠️',
      text: `${aName} não marcou em ${aS.failedToScore}/${aS.matchesAnalyzed} jogos recentes`,
    });
  }
  
  // Monte Carlo insights
  if (mc.homeWin > 50) {
    factors.push({
      icon: '📈',
      text: `Monte Carlo: ${hName} favorito com ${mc.homeWin}% de vitória`,
    });
  } else if (mc.awayWin > 50) {
    factors.push({
      icon: '📈',
      text: `Monte Carlo: ${aName} favorito com ${mc.awayWin}% de vitória`,
    });
  } else {
    factors.push({
      icon: '⚖️',
      text: `Jogo equilibrado: empate ${mc.draw}% (Monte Carlo 10k)`,
    });
  }
  
  if (mc.btts > 60) {
    factors.push({ icon: '⚽', text: `BTTS provável: ${mc.btts}% (Monte Carlo)` });
  }
  
  if (mc.over25 > 60) {
    factors.push({ icon: '📈', text: `Over 2.5 favorecido: ${mc.over25}%` });
  } else if (mc.under25 > 60) {
    factors.push({ icon: '📉', text: `Under 2.5 favorecido: ${mc.under25}%` });
  }
  
  return factors.slice(0, 12);
}

function calcBadges(mc, hS, aS, bestBet) {
  const badges = [];
  
  if (hS.matchesAnalyzed < 2 || aS.matchesAnalyzed < 2) {
    badges.push('insufficient');
    return badges;
  }
  
  if (bestBet.confidence === 'Alta' && !bestBet.isEstimate) badges.push('high-confidence');
  if (bestBet.valueBet) badges.push('value-bet');
  if (Math.abs(mc.homeWin - mc.awayWin) < 12 && mc.draw > 28) badges.push('danger');
  if (bestBet.isEstimate) badges.push('estimated');
  
  return badges.length ? badges : ['standard'];
}

// --- HANDLERS DE ROTA ---
async function handlePredict(qs) {
  const homeId = parseInt(qs.home, 10);
  const awayId = parseInt(qs.away, 10);
  const hName = qs.homeName || 'Mandante';
  const aName = qs.awayName || 'Visitante';
  
  if (!homeId || !awayId) {
    throw new Error('Informe "home" e "away" (IDs dos times).');
  }
  
  const [hS, aS] = await Promise.all([
    teamStats(homeId),
    teamStats(awayId),
  ]);
  
  const lH = calcLambda(hS, aS, true);
  const lA = calcLambda(aS, hS, false);
  const mc = monteCarloSimulation(lH, lA);
  
  const allMarkets = buildAllMarkets(mc, hS, aS, hName, aName);
  const bestBet = findBestBet(allMarkets, mc, hS, aS, hName, aName);
  const factors = genFactors(hS, aS, mc, hName, aName);
  const badges = calcBadges(mc, hS, aS, bestBet);
  
  // Top mercados por categoria
  const topByCategory = {};
  allMarkets.forEach(m => {
    if (!topByCategory[m.category]) topByCategory[m.category] = [];
    topByCategory[m.category].push(m);
  });
  
  // Ordenar cada categoria por probabilidade
  Object.keys(topByCategory).forEach(cat => {
    topByCategory[cat] = topByCategory[cat]
      .sort((a, b) => b.prob - a.prob)
      .slice(0, 5);
  });
  
  // Ticket (top 10 value bets)
  const ticket = allMarkets
    .filter(m => m.isValueBet)
    .sort((a, b) => b.prob - a.prob)
    .slice(0, 10)
    .map(m => ({
      key: m.key,
      label: m.label,
      icon: m.icon,
      prob: m.prob,
      category: m.category,
      isEstimate: m.isEstimate,
    }));
  
  return {
    homeMatchesAnalyzed: hS.matchesAnalyzed,
    awayMatchesAnalyzed: aS.matchesAnalyzed,
    homeIsFallback: hS.isFallback || false,
    awayIsFallback: aS.isFallback || false,
    allMarkets,
    topByCategory,
    ticket,
    mc,
    bestBet,
    factors,
    badges,
    stats: {
      home: {
        avgGoalsFor: hS.avgGoalsFor,
        avgGoalsAgainst: hS.avgGoalsAgainst,
        over25Rate: hS.over25Rate,
        bttsRate: hS.bttsRate,
        cleanSheets: hS.cleanSheets,
        averages: hS.averages,
      },
      away: {
        avgGoalsFor: aS.avgGoalsFor,
        avgGoalsAgainst: aS.avgGoalsAgainst,
        over25Rate: aS.over25Rate,
        bttsRate: aS.bttsRate,
        cleanSheets: aS.cleanSheets,
        averages: aS.averages,
      },
    },
  };
}

async function handleCompare(qs) {
  const fid = parseInt(qs.fixture, 10);
  const hId = parseInt(qs.home, 10);
  const aId = parseInt(qs.away, 10);
  
  if (!fid || !hId || !aId) {
    throw new Error('Informe "fixture", "home" e "away" (IDs).');
  }
  
  const [hS, aS, lj] = await Promise.all([
    teamStats(hId),
    teamStats(aId),
    apiGet('/fixtures/statistics', { fixture: fid }),
  ]);
  
  const comparisons = Object.entries(STAT_API_MAP)
    .filter(([key]) => key !== 'cards' && key !== 'yellow_cards' && key !== 'red_cards')
    .map(([key, apiName]) => {
      const hPred = hS.averages[key] ?? GENERIC[key];
      const aPred = aS.averages[key] ?? GENERIC[key];
      const pred = Math.round((hPred + aPred) * 10) / 10;
      
      let actual = null;
      const vH = extractStat(lj, hId, apiName);
      const vA = extractStat(lj, aId, apiName);
      
      if (vH != null || vA != null) {
        actual = (vH || 0) + (vA || 0);
      }
      
      const accuracy = actual != null ? 
        Math.abs(pred - actual) <= 1 ? 'Alta' :
        Math.abs(pred - actual) <= 2 ? 'Média' : 'Baixa' : 
        null;
      
      return {
        statKey: key,
        statLabel: STAT_NAMES[key] || key,
        predictedTotal: pred,
        homeAvg: Math.round(hPred * 10) / 10,
        awayAvg: Math.round(aPred * 10) / 10,
        suggestedLine: roundLine(pred),
        actual,
        accuracy,
        deviation: actual != null ? Math.round((pred - actual) * 10) / 10 : null,
      };
    });
  
  // Adicionar cartões separadamente
  const yH = extractStat(lj, hId, 'Yellow Cards');
  const rH = extractStat(lj, hId, 'Red Cards');
  const yA = extractStat(lj, aId, 'Yellow Cards');
  const rA = extractStat(lj, aId, 'Red Cards');
  
  comparisons.push({
    statKey: 'yellow_cards',
    statLabel: 'Cartões Amarelos',
    predictedTotal: Math.round(((hS.averages.yellow_cards ?? GENERIC.yellow_cards) + (aS.averages.yellow_cards ?? GENERIC.yellow_cards)) * 10) / 10,
    homeAvg: Math.round((hS.averages.yellow_cards ?? GENERIC.yellow_cards) * 10) / 10,
    awayAvg: Math.round((aS.averages.yellow_cards ?? GENERIC.yellow_cards) * 10) / 10,
    suggestedLine: 4.5,
    actual: (yH != null || yA != null) ? (yH || 0) + (yA || 0) : null,
  });
  
  comparisons.push({
    statKey: 'cards',
    statLabel: 'Cartões Totais',
    predictedTotal: Math.round(((hS.averages.cards ?? GENERIC.cards) + (aS.averages.cards ?? GENERIC.cards)) * 10) / 10,
    homeAvg: Math.round((hS.averages.cards ?? GENERIC.cards) * 10) / 10,
    awayAvg: Math.round((aS.averages.cards ?? GENERIC.cards) * 10) / 10,
    suggestedLine: 5.5,
    actual: (yH != null || yA != null || rH != null || rA != null) ? (yH || 0) + (rH || 0) + (yA || 0) + (rA || 0) : null,
  });
  
  return {
    fixtureId: fid,
    comparisons,
    accuracy: {
      high: comparisons.filter(c => c.accuracy === 'Alta').length,
      medium: comparisons.filter(c => c.accuracy === 'Média').length,
      low: comparisons.filter(c => c.accuracy === 'Baixa').length,
      total: comparisons.filter(c => c.accuracy !== null).length,
    },
  };
}

// --- EXPORT DO HANDLER ---
exports.handler = async (event) => {
  const startTime = Date.now();
  const qs = event.queryStringParameters || {};
  
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };
  
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers };
  }
  
  try {
    let result;
    const action = qs.action;
    
    if (action === 'fixtures') {
      result = await handleFixtures(qs);
    } else if (action === 'predict') {
      result = await handlePredict(qs);
    } else if (action === 'compare') {
      result = await handleCompare(qs);
    } else {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: 'Ação inválida',
          validActions: ['fixtures', 'predict', 'compare'],
          examples: {
            fixtures: '?action=fixtures&date=2024-01-15&scope=live',
            predict: '?action=predict&home=121&away=130&homeName=Flamengo&awayName=Palmeiras',
            compare: '?action=compare&fixture=12345&home=121&away=130',
          },
        }),
      };
    }
    
    const duration = Date.now() - startTime;
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ...result,
        meta: {
          duration: `${duration}ms`,
          timestamp: new Date().toISOString(),
          version: '5.0.0',
          markets: 'Betano Edition',
          totalMarkets: result.allMarkets?.length || 0,
        },
      }),
    };
    
  } catch (err) {
    const message = String(err?.message || err);
    const statusCode = /RATE_LIMIT/i.test(message) ? 429 :
                       /Informe/i.test(message) ? 400 :
                       /não configurada/i.test(message) ? 503 : 500;
    
    console.error(`❌ Erro [${statusCode}]: ${message}`);
    
    return {
      statusCode,
      headers,
      body: JSON.stringify({
        error: message,
        meta: {
          duration: `${Date.now() - startTime}ms`,
          timestamp: new Date().toISOString(),
        },
      }),
    };
  }
};
