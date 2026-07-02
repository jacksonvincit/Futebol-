// FuteStat v4.1 — Motor Híbrido de Inteligência Esportiva
// Netlify Function otimizada com cache, retry e fallback inteligente

const BASE_URL = 'https://v3.football.api-sports.io';
const MAX_MATCHES = 8; // Aumentado de 5 para 8 para melhor análise
const MC_N = 10000;
const CACHE_TTL = 300; // 5 minutos de cache

// Cache em memória para reduzir chamadas à API
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
  cache.set(key, { data, timestamp: Date.now() });
}

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
        console.warn(`Rate limit atingido. Aguardando ${retryAfter}s...`);
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        continue;
      }
      
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
      
    } catch (err) {
      if (i === retries - 1) throw err;
      console.warn(`Tentativa ${i + 1} falhou: ${err.message}. Retentando em ${Math.pow(2, i)}s...`);
      await new Promise(r => setTimeout(r, Math.pow(2, i) * 1000));
    }
  }
}

// Rate limiting interno
const rateLimiter = {
  requests: [],
  maxRequests: 30, // Máximo de requisições por minuto
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

// Estatísticas e times brasileiros para fallback
const STAT_NAMES = {
  shots_total: 'Total de chutes',
  shots_on_target: 'Chutes no gol',
  shots_off_target: 'Chutes para fora',
  corners: 'Escanteios',
  cards: 'Cartões (amar. + verm.)',
  yellow_cards: 'Cartões amarelos',
  fouls: 'Faltas',
  offsides: 'Impedimentos',
  goals: 'Gols',
  passes: 'Passes totais',
  goalkeeper_saves: 'Defesas do goleiro',
  tackles: 'Desarmes',
};

const GENERIC = {
  shots_total: 12, shots_on_target: 4.5, shots_off_target: 5.5,
  corners: 5, cards: 2.2, yellow_cards: 1.9, fouls: 11,
  offsides: 1.8, goals: 1.3, passes: 420, goalkeeper_saves: 3.5, tackles: 14,
};

const STAT_API = {
  shots_total: 'Total Shots',
  shots_on_target: 'Shots on Goal',
  shots_off_target: 'Shots off Goal',
  corners: 'Corner Kicks',
  fouls: 'Fouls',
  offsides: 'Offsides',
  passes: 'Total passes',
  goalkeeper_saves: 'Goalkeeper Saves',
  tackles: 'Total tackles',
};

// Times com estatísticas pré-carregadas para fallback
const TEAM_PROFILES = {
  // Brasileirão - Ataque forte
  forte: { goalsFor: 1.8, goalsAgainst: 1.0, shots_total: 15, shots_on_target: 5.5, corners: 6.5 },
  // Brasileirão - Defesa sólida
  solido: { goalsFor: 1.3, goalsAgainst: 0.8, shots_total: 10, shots_on_target: 3.5, corners: 4 },
  // Brasileirão - Meio de tabela
  medio: { goalsFor: 1.2, goalsAgainst: 1.3, shots_total: 11, shots_on_target: 4, corners: 5 },
  // Brasileirão - Ataque fraco
  fraco: { goalsFor: 0.8, goalsAgainst: 1.6, shots_total: 9, shots_on_target: 3, corners: 3.5 },
};

function getTeamProfile(teamId) {
  // Usa o ID do time para gerar um perfil pseudo-aleatório mas consistente
  const hash = teamId % 4;
  const profiles = Object.values(TEAM_PROFILES);
  return profiles[hash];
}

// --- FUNÇÕES MATEMÁTICAS ---
function poissonRandom(lambda) {
  if (lambda <= 0) return 0;
  if (lambda > 30) lambda = 30; // Evitar overflow
  
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  
  do {
    k++;
    p *= Math.random();
  } while (p > L);
  
  return k - 1;
}

function monteCarlo(lH, lA) {
  let hw = 0, dr = 0, aw = 0, btts = 0, csH = 0, csA = 0;
  const goalsDistribution = new Array(7).fill(0); // 0-6+ gols
  const scorelines = {};
  
  for (let i = 0; i < MC_N; i++) {
    const hg = poissonRandom(lH);
    const ag = poissonRandom(lA);
    const total = hg + ag;
    
    // Resultado
    if (hg > ag) hw++;
    else if (hg < ag) aw++;
    else dr++;
    
    // Distribuição de gols
    const bucket = Math.min(total, 6);
    goalsDistribution[bucket]++;
    
    // BTTS e Clean Sheets
    if (hg > 0 && ag > 0) btts++;
    if (ag === 0) csH++;
    if (hg === 0) csA++;
    
    // Placar exato
    const key = `${Math.min(hg, 6)}-${Math.min(ag, 6)}`;
    scorelines[key] = (scorelines[key] || 0) + 1;
  }
  
  const p = v => Math.round(v / MC_N * 1000) / 10;
  
  // Calcular overs
  const overs = {};
  for (let line = 0.5; line <= 5.5; line += 1) {
    let count = 0;
    for (let i = Math.ceil(line); i <= 6; i++) {
      count += goalsDistribution[i];
    }
    overs[`over${Math.floor(line * 10)}`] = p(count);
    overs[`under${Math.floor(line * 10)}`] = p(MC_N - count);
  }
  
  // Top 5 placares
  const top5 = Object.entries(scorelines)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([score, count]) => ({ score, prob: p(count) }));
  
  return {
    homeWin: p(hw),
    draw: p(dr),
    awayWin: p(aw),
    ...overs,
    btts: p(btts),
    noBtts: p(MC_N - btts),
    csHome: p(csH),
    csAway: p(csA),
    top5,
    lambdaH: Math.round(lH * 100) / 100,
    lambdaA: Math.round(lA * 100) / 100,
  };
}

// --- FUNÇÕES DE API ---
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

// --- HANDLERS PRINCIPAIS ---
async function handleFixtures(qs) {
  if (qs.scope === 'live') {
    const j = await apiGet('/fixtures', { live: 'all' });
    return { fixtures: (j.response || []).map(mapFixture) };
  }
  
  const date = qs.date || fmtDate(new Date());
  const j = await apiGet('/fixtures', { date });
  return { fixtures: (j.response || []).map(mapFixture) };
}

function extractStat(resp, teamId, name) {
  const block = (resp.response || []).find(b => b.team.id === teamId);
  if (!block) return null;
  
  const e = block.statistics.find(s => s.type === name);
  if (!e || e.value == null) return null;
  
  const v = typeof e.value === 'string' ? parseFloat(e.value) : e.value;
  return isNaN(v) ? null : v;
}

async function fetchTeamStats(teamId) {
  const cacheKey = `team_stats_${teamId}`;
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
      
      // Buscar estatísticas detalhadas
      if (idx < 5) { // Limitar para evitar muitas chamadas
        try {
          const sj = await apiGet('/fixtures/statistics', { fixture: fx.fixture.id });
          stats.fixtures.push({
            id: fx.fixture.id,
            stats: sj.response || []
          });
        } catch (err) {
          console.warn(`Erro ao buscar estatísticas da partida ${fx.fixture.id}: ${err.message}`);
        }
      }
    }
    
    setCache(cacheKey, stats);
    return stats;
    
  } catch (err) {
    console.warn(`Erro ao buscar estatísticas do time ${teamId}: ${err.message}`);
    return null;
  }
}

async function teamStats(teamId) {
  const rawStats = await fetchTeamStats(teamId);
  
  // Fallback para perfil genérico se API falhar
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
  
  // Processar estatísticas
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
      if (val !== null) {
        pools.all[k].push(val);
        if (isRecent) pools.last3[k].push(val);
      }
    };
    
    push('shots_total', extractStat({ response: fxStats }, teamId, 'Total Shots'));
    push('shots_on_target', extractStat({ response: fxStats }, teamId, 'Shots on Goal'));
    push('shots_off_target', extractStat({ response: fxStats }, teamId, 'Shots off Goal'));
    push('corners', extractStat({ response: fxStats }, teamId, 'Corner Kicks'));
    push('fouls', extractStat({ response: fxStats }, teamId, 'Fouls'));
    push('offsides', extractStat({ response: fxStats }, teamId, 'Offsides'));
    push('passes', extractStat({ response: fxStats }, teamId, 'Total passes'));
    push('goalkeeper_saves', extractStat({ response: fxStats }, teamId, 'Goalkeeper Saves'));
    push('tackles', extractStat({ response: fxStats }, teamId, 'Total tackles'));
    
    const y = extractStat({ response: fxStats }, teamId, 'Yellow Cards');
    const r = extractStat({ response: fxStats }, teamId, 'Red Cards');
    push('yellow_cards', y);
    
    const c = (y || 0) + (r || 0);
    if (y !== null || r !== null) {
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
    homeForm: { wins: 0, played: 0, winRate: 0, goalsFor: profile.goalsFor, goalsAgainst: profile.goalsAgainst },
    awayForm: { wins: 0, played: 0, winRate: 0, goalsFor: profile.goalsFor * 0.8, goalsAgainst: profile.goalsAgainst * 1.2 },
    cleanSheets: 0,
    failedToScore: 0,
    avgGoalsFor: profile.goalsFor,
    avgGoalsAgainst: profile.goalsAgainst,
    isFallback: true,
  };
}

function buildStatsFromPools(pools, rawStats) {
  const mk = Object.keys(STAT_NAMES);
  const mean = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  
  const wavg = k => {
    const a3 = mean(pools.last3[k]);
    const ag = mean(pools.all[k]);
    if (a3 != null && ag != null) return a3 * 0.7 + ag * 0.3; // Maior peso para recentes
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
  
  return {
    averages,
    isReal,
    matchesAnalyzed: rawStats.fixtures.length,
    form: {
      wins: rawStats.wins,
      draws: rawStats.draws,
      losses: rawStats.losses,
      played: rawStats.fixtures.length,
      winRate: rawStats.fixtures.length ? rawStats.wins / rawStats.fixtures.length : 0,
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
      goalsFor: mean(rawStats.awayGF) ?? 1.3,
      goalsAgainst: mean(rawStats.awayGA) ?? 1.3,
    },
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
  const adj = isHome ? base * 1.15 : base * 0.85; // Ajuste mais realista
  return Math.max(0.3, Math.min(adj, 5));
}

function roundLine(p) {
  const f = Math.floor(p);
  return p - f >= 0.5 ? f + 0.5 : f - 0.5;
}

function buildMarkets(hS, aS) {
  return Object.entries(STAT_NAMES).map(([key, label]) => {
    const h = hS.averages[key] ?? GENERIC[key];
    const a = aS.averages[key] ?? GENERIC[key];
    const pred = Math.round((h + a) * 10) / 10;
    const line = roundLine(pred);
    const isEst = !hS.isReal[key] || !aS.isReal[key];
    const diff = pred - line;
    const op = Math.min(95, Math.max(25, Math.round(50 + (diff / Math.max(1, pred)) * 70)));
    
    return {
      marketKey: key,
      marketLabel: label,
      predictedTotal: pred,
      homeAvg: Math.round(h * 10) / 10,
      awayAvg: Math.round(a * 10) / 10,
      suggestedLine: line,
      overProb: op,
      underProb: 100 - op,
      isEstimate: isEst,
      bestSide: op >= 50 ? 'over' : 'under',
      bestProb: Math.max(op, 100 - op),
    };
  });
}

function genFactors(hS, aS, mc, hName, aName) {
  const factors = [];
  const pct = v => Math.round(v * 100);
  const rnd = v => Math.round(v * 10) / 10;
  
  if (hS.matchesAnalyzed >= 3) {
    factors.push({
      icon: '📊',
      text: `${hName} venceu ${pct(hS.form.winRate)}% dos últimos ${hS.matchesAnalyzed} jogos`
    });
  }
  
  if (aS.matchesAnalyzed >= 3) {
    factors.push({
      icon: '📊',
      text: `${aName} venceu ${pct(aS.form.winRate)}% dos últimos ${aS.matchesAnalyzed} jogos`
    });
  }
  
  if (hS.homeForm.played >= 2) {
    factors.push({
      icon: hS.homeForm.winRate >= 0.5 ? '🟢' : '🔴',
      text: `${hName}: ${hS.homeForm.wins}/${hS.homeForm.played} vitórias em casa`
    });
  }
  
  if (aS.awayForm.played >= 2) {
    factors.push({
      icon: aS.awayForm.winRate >= 0.4 ? '🟢' : '🔴',
      text: `${aName}: ${aS.awayForm.wins}/${aS.awayForm.played} vitórias fora`
    });
  }
  
  factors.push({
    icon: '⚽',
    text: `${hName} marca ${rnd(hS.avgGoalsFor)} gol(s)/jogo e sofre ${rnd(hS.avgGoalsAgainst)}`
  });
  
  factors.push({
    icon: '⚽',
    text: `${aName} marca ${rnd(aS.avgGoalsFor)} gol(s)/jogo e sofre ${rnd(aS.avgGoalsAgainst)}`
  });
  
  if (hS.cleanSheets > 0) {
    factors.push({
      icon: '🔒',
      text: `${hName} manteve ${hS.cleanSheets} clean sheet(s) nos últimos ${hS.matchesAnalyzed} jogos`
    });
  }
  
  if (aS.failedToScore > 0) {
    factors.push({
      icon: '⚠️',
      text: `${aName} não marcou em ${aS.failedToScore}/${aS.matchesAnalyzed} jogos recentes`
    });
  }
  
  // Fatores do Monte Carlo
  if (mc.homeWin > 50) {
    factors.push({
      icon: '📈',
      text: `Monte Carlo 10k: mandante favorito com ${mc.homeWin}% de chance`
    });
  } else if (mc.awayWin > 50) {
    factors.push({
      icon: '📈',
      text: `Monte Carlo 10k: visitante favorito com ${mc.awayWin}% de chance`
    });
  } else {
    factors.push({
      icon: '⚖️',
      text: `Jogo equilibrado — empate tem ${mc.draw}% de probabilidade`
    });
  }
  
  if (mc.btts > 60) {
    factors.push({
      icon: '⚽',
      text: `Ambas marcam: ${mc.btts}% de probabilidade`
    });
  }
  
  if (mc.over25 > 60) {
    factors.push({
      icon: '📈',
      text: `Over 2.5 gols favorecido: ${mc.over25}%`
    });
  } else if (mc.under25 > 60) {
    factors.push({
      icon: '📉',
      text: `Under 2.5 gols favorecido: ${mc.under25}%`
    });
  }
  
  return factors.slice(0, 10);
}

function findBestBet(markets, mc, hS, aS, hName, aName) {
  const candidates = [
    { market: `Vitória ${hName}`, prob: mc.homeWin, isEst: hS.matchesAnalyzed < 3, cat: '1X2' },
    { market: 'Empate', prob: mc.draw, isEst: hS.matchesAnalyzed < 3, cat: '1X2' },
    { market: `Vitória ${aName}`, prob: mc.awayWin, isEst: aS.matchesAnalyzed < 3, cat: '1X2' },
    { market: 'Over 2.5 gols', prob: mc.over25, isEst: false, cat: 'Gols' },
    { market: 'Under 2.5 gols', prob: mc.under25, isEst: false, cat: 'Gols' },
    { market: 'Ambas marcam — Sim', prob: mc.btts, isEst: false, cat: 'BTTS' },
    { market: 'Ambas marcam — Não', prob: mc.noBtts, isEst: false, cat: 'BTTS' },
    { market: 'Over 1.5 gols', prob: mc.over15, isEst: false, cat: 'Gols' },
    { market: 'Under 3.5 gols', prob: mc.under35, isEst: false, cat: 'Gols' },
    ...markets.map(m => ({
      market: `${m.bestSide === 'over' ? 'Mais' : 'Menos'} de ${m.suggestedLine} ${m.marketLabel.toLowerCase()}`,
      prob: m.bestProb,
      isEst: m.isEstimate,
      cat: 'Estatísticas',
    })),
  ];
  
  const best = [...candidates].sort((a, b) => {
    if (a.isEst !== b.isEst) return a.isEst ? 1 : -1;
    return b.prob - a.prob;
  })[0];
  
  const confidence = best.prob >= 75 ? 'Alta' : best.prob >= 60 ? 'Média' : 'Baixa';
  const risk = best.prob >= 75 ? 'Baixo' : best.prob >= 60 ? 'Médio' : 'Alto';
  const valueBet = !best.isEst && best.prob >= 62;
  
  return {
    market: best.market,
    prob: best.prob,
    confidence,
    risk,
    valueBet,
    cat: best.cat,
    impliedOdds: Math.round((1 / (best.prob / 100)) * 1.08 * 100) / 100,
    justification: `Calculado via Monte Carlo (${MC_N.toLocaleString()} simulações) e Distribuição de Poisson. Confiança ${confidence.toLowerCase()} com base em ${Math.min(hS.matchesAnalyzed, aS.matchesAnalyzed)} partidas analisadas por equipe.`,
  };
}

function calcBadges(mc, hS, aS, bestBet) {
  const badges = [];
  
  if (hS.matchesAnalyzed < 2 || aS.matchesAnalyzed < 2) {
    badges.push('insufficient');
    return badges;
  }
  
  if (bestBet.confidence === 'Alta') badges.push('high-confidence');
  if (bestBet.valueBet) badges.push('value-bet');
  if (Math.abs(mc.homeWin - mc.awayWin) < 12 && mc.draw > 28) badges.push('danger');
  
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
  
  // Buscar estatísticas em paralelo
  const [hS, aS] = await Promise.all([
    teamStats(homeId),
    teamStats(awayId),
  ]);
  
  const lH = calcLambda(hS, aS, true);
  const lA = calcLambda(aS, hS, false);
  const mc = monteCarlo(lH, lA);
  const markets = buildMarkets(hS, aS);
  
  const ticket = [...markets]
    .sort((a, b) => b.bestProb - a.bestProb)
    .slice(0, 8) // Top 8 mercados
    .map(m => ({
      marketLabel: m.marketLabel,
      side: m.bestSide,
      line: m.suggestedLine,
      prob: m.bestProb,
      label: `${m.bestSide === 'over' ? 'Mais' : 'Menos'} de ${m.suggestedLine} ${m.marketLabel.toLowerCase()}`,
    }));
  
  const bestBet = findBestBet(markets, mc, hS, aS, hName, aName);
  const factors = genFactors(hS, aS, mc, hName, aName);
  const badges = calcBadges(mc, hS, aS, bestBet);
  
  return {
    homeMatchesAnalyzed: hS.matchesAnalyzed,
    awayMatchesAnalyzed: aS.matchesAnalyzed,
    homeIsFallback: hS.isFallback || false,
    awayIsFallback: aS.isFallback || false,
    markets,
    ticket,
    mc,
    bestBet,
    factors,
    badges,
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
  
  const markets = Object.entries(STAT_NAMES).map(([key, label]) => {
    const h = hS.averages[key] ?? GENERIC[key];
    const a = aS.averages[key] ?? GENERIC[key];
    const pred = Math.round((h + a) * 10) / 10;
    let actual = null;
    
    if (key === 'cards') {
      const yH = extractStat(lj, hId, 'Yellow Cards');
      const rH = extractStat(lj, hId, 'Red Cards');
      const yA = extractStat(lj, aId, 'Yellow Cards');
      const rA = extractStat(lj, aId, 'Red Cards');
      actual = (yH != null || yA != null) ? (yH || 0) + (rH || 0) + (yA || 0) + (rA || 0) : null;
    } else if (key === 'yellow_cards') {
      const yH = extractStat(lj, hId, 'Yellow Cards');
      const yA = extractStat(lj, aId, 'Yellow Cards');
      actual = (yH != null || yA != null) ? (yH || 0) + (yA || 0) : null;
    } else if (key === 'goals') {
      actual = null;
    } else if (STAT_API[key]) {
      const vH = extractStat(lj, hId, STAT_API[key]);
      const vA = extractStat(lj, aId, STAT_API[key]);
      actual = (vH != null || vA != null) ? (vH || 0) + (vA || 0) : null;
    }
    
    const accuracy = actual != null ? 
      Math.abs(pred - actual) <= 1 ? 'Alta' :
      Math.abs(pred - actual) <= 2 ? 'Média' : 'Baixa' : 
      null;
    
    return {
      marketLabel: label,
      predictedTotal: pred,
      suggestedLine: roundLine(pred),
      actual,
      accuracy,
    };
  });
  
  return { markets };
}

// --- EXPORT DO HANDLER ---
exports.handler = async (event) => {
  const startTime = Date.now();
  const qs = event.queryStringParameters || {};
  
  // Headers CORS para permitir chamadas do frontend
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };
  
  // Responder a preflight requests
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
          usage: {
            fixtures: '?action=fixtures&date=YYYY-MM-DD&scope=live',
            predict: '?action=predict&home=ID&away=ID&homeName=Nome&awayName=Nome',
            compare: '?action=compare&fixture=ID&home=ID&away=ID',
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
          version: '4.1.0',
        },
      }),
    };
    
  } catch (err) {
    const message = String(err?.message || err);
    const statusCode = /RATE_LIMIT/i.test(message) ? 429 :
                       /Informe/i.test(message) ? 400 :
                       /não configurada/i.test(message) ? 503 : 500;
    
    console.error(`Erro [${statusCode}]: ${message}`);
    
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
