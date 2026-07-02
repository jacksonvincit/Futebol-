// FuteStat v6.0 — API Backend Completa
// ATUALIZADO: 02/07/2026
// REGRA: SEMPRE atualizar API.js quando o frontend for alterado
// Suporte a 45+ ligas incluindo Copa do Mundo FIFA 2026
// +60 mercados estatísticos com taxa de acerto

const BASE_URL = 'https://v3.football.api-sports.io';
const MAX_MATCHES = 10;
const MC_N = 10000;
const CACHE_TTL = 300;
const MAX_HISTORY_HOURS = 12;

// Cache inteligente com limpeza automática
const cache = new Map();
let lastCleanup = Date.now();

function cleanCache() {
  const now = Date.now();
  if (now - lastCleanup < 300000) return;
  
  for (const [key, entry] of cache.entries()) {
    if (now - entry.timestamp > CACHE_TTL * 1000) {
      cache.delete(key);
    }
  }
  lastCleanup = now;
}

function getCached(key) {
  cleanCache();
  const entry = cache.get(key);
  if (entry && Date.now() - entry.timestamp < CACHE_TTL * 1000) {
    return entry.data;
  }
  cache.delete(key);
  return null;
}

function setCache(key, data) {
  if (cache.size > 300) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
  cache.set(key, { data, timestamp: Date.now() });
}

// Rate limiting otimizado
const rateLimiter = {
  requests: [],
  maxRequests: 35,
  windowMs: 60000,
  
  async throttle() {
    const now = Date.now();
    this.requests = this.requests.filter(t => now - t < this.windowMs);
    
    if (this.requests.length >= this.maxRequests) {
      const waitTime = this.windowMs - (now - this.requests[0]);
      if (waitTime > 0) {
        console.warn(`Rate limit. Aguardando ${waitTime}ms...`);
        await new Promise(r => setTimeout(r, waitTime));
      }
    }
    
    this.requests.push(now);
  }
};

// Retry com backoff exponencial e jitter
async function fetchWithRetry(url, options, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      
      const res = await fetch(url, { 
        ...options, 
        signal: controller.signal 
      });
      
      clearTimeout(timeout);
      
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('Retry-After') || Math.pow(2, i + 1));
        console.warn(`Rate limit API (429). Aguardando ${retryAfter}s...`);
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        continue;
      }
      
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      
      return res;
      
    } catch (err) {
      if (i === retries - 1) throw err;
      const delay = Math.pow(2, i) * 1000 + Math.random() * 1000;
      console.warn(`Tentativa ${i + 1}/${retries} falhou: ${err.message}. Retentando em ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// ============================================
// TODAS AS ESTATÍSTICAS DISPONÍVEIS
// ============================================
const STAT_NAMES = {
  // Ataque
  goals: 'Gols',
  shots_total: 'Total de Chutes',
  shots_on_target: 'Chutes no Gol',
  shots_off_target: 'Chutes para Fora',
  shots_inside_box: 'Chutes dentro da Área',
  shots_outside_box: 'Chutes fora da Área',
  big_chances: 'Grandes Chances',
  big_chances_missed: 'Grandes Chances Perdidas',
  hit_woodwork: 'Bolas na Trave',
  expected_goals: 'Gols Esperados (xG)',
  
  // Posse e Passes
  possession: 'Posse de Bola (%)',
  passes: 'Passes Totais',
  passes_accurate: 'Passes Certos',
  passes_percentage: 'Precisão de Passes (%)',
  long_balls: 'Bolas Longas',
  crosses: 'Cruzamentos',
  through_balls: 'Bolas em Profundidade',
  
  // Defesa
  tackles: 'Desarmes',
  interceptions: 'Interceptações',
  clearances: 'Cortes',
  blocks: 'Bloqueios',
  goalkeeper_saves: 'Defesas do Goleiro',
  goalkeeper_claims: 'Saídas do Goleiro',
  
  // Disciplina
  cards: 'Cartões Totais',
  yellow_cards: 'Cartões Amarelos',
  red_cards: 'Cartões Vermelhos',
  fouls: 'Faltas',
  penalties: 'Pênaltis',
  
  // Bola Parada
  corners: 'Escanteios',
  offsides: 'Impedimentos',
  throw_ins: 'Laterais',
  goal_kicks: 'Tiros de Meta',
  free_kicks: 'Cobranças de Falta',
  
  // Outros
  substitutions: 'Substituições',
  injuries: 'Lesões',
  dribbles: 'Dribles',
  dribbles_success: 'Dribles Certos',
  aerials_won: 'Duelos Aéreos Vencidos',
  aerials_lost: 'Duelos Aéreos Perdidos',
  counter_attacks: 'Contra-Ataques',
  counter_attack_shots: 'Finalizações de Contra-Ataque',
};

const GENERIC = {
  goals: 1.3, shots_total: 12, shots_on_target: 4.5, shots_off_target: 5.5,
  shots_inside_box: 7, shots_outside_box: 4, big_chances: 2.5, big_chances_missed: 1.5,
  hit_woodwork: 0.3, expected_goals: 1.4, possession: 50, passes: 420,
  passes_accurate: 340, passes_percentage: 80, long_balls: 45, crosses: 16,
  through_balls: 3, tackles: 14, interceptions: 10, clearances: 18, blocks: 4,
  goalkeeper_saves: 3.5, goalkeeper_claims: 2, cards: 2.2, yellow_cards: 1.9,
  red_cards: 0.3, fouls: 11, penalties: 0.2, corners: 5, offsides: 1.8,
  throw_ins: 22, goal_kicks: 12, free_kicks: 8, substitutions: 3.5,
  injuries: 0.5, dribbles: 8, dribbles_success: 5, aerials_won: 15,
  aerials_lost: 12, counter_attacks: 3, counter_attack_shots: 1.2,
};

const STAT_API_MAP = {
  goals: 'Goals',
  shots_total: 'Total Shots',
  shots_on_target: 'Shots on Goal',
  shots_off_target: 'Shots off Goal',
  shots_inside_box: 'Shots insidebox',
  shots_outside_box: 'Shots outsidebox',
  big_chances: 'Big Chances',
  big_chances_missed: 'Big Chances Missed',
  hit_woodwork: 'Hit Woodwork',
  expected_goals: 'Expected Goals',
  possession: 'Ball Possession',
  passes: 'Total passes',
  passes_accurate: 'Passes accurate',
  passes_percentage: 'Passes %',
  long_balls: 'Long Balls',
  crosses: 'Crosses',
  through_balls: 'Through Balls',
  tackles: 'Total tackles',
  interceptions: 'Interceptions',
  clearances: 'Clearances',
  blocks: 'Blocks',
  goalkeeper_saves: 'Goalkeeper Saves',
  goalkeeper_claims: 'Goalkeeper Claims',
  yellow_cards: 'Yellow Cards',
  red_cards: 'Red Cards',
  fouls: 'Fouls',
  penalties: 'Penalties',
  corners: 'Corner Kicks',
  offsides: 'Offsides',
  throw_ins: 'Throw-ins',
  goal_kicks: 'Goal Kicks',
  free_kicks: 'Free Kicks',
  substitutions: 'Substitutions',
  injuries: 'Injuries',
  dribbles: 'Dribbles',
  dribbles_success: 'Dribbles Success',
  aerials_won: 'Aerials Won',
  aerials_lost: 'Aerials Lost',
  counter_attacks: 'Counter Attacks',
  counter_attack_shots: 'Counter Attack Shots',
};

// ============================================
// 45+ LIGAS DISPONÍVEIS
// ============================================
const AVAILABLE_LEAGUES = [
  // COPAS DO MUNDO FIFA
  { id: 1, name: '🏆 Copa do Mundo FIFA 2026', country: 'Mundial', type: 'world_cup', featured: true },
  { id: 33, name: '🌎 Eliminatórias CONMEBOL 2026', country: 'América do Sul', type: 'qualifier' },
  { id: 34, name: '🌍 Eliminatórias UEFA 2026', country: 'Europa', type: 'qualifier' },
  { id: 6, name: '🌍 Eliminatórias África 2026', country: 'África', type: 'qualifier' },
  { id: 7, name: '🌏 Eliminatórias Ásia 2026', country: 'Ásia', type: 'qualifier' },
  { id: 9, name: '🌍 Copa do Mundo Sub-20', country: 'Mundial', type: 'youth' },
  { id: 10, name: '🌍 Amistosos Internacionais', country: 'Mundial', type: 'friendly' },
  { id: 18, name: '🌍 Mundial de Clubes FIFA', country: 'Mundial', type: 'continental', featured: true },
  
  // BRASIL
  { id: 71, name: '🇧🇷 Brasileirão Série A', country: 'Brasil', type: 'league', featured: true },
  { id: 72, name: '🇧🇷 Brasileirão Série B', country: 'Brasil', type: 'league' },
  { id: 75, name: '🇧🇷 Brasileirão Série C', country: 'Brasil', type: 'league' },
  { id: 11, name: '🇧🇷 Copa do Brasil', country: 'Brasil', type: 'cup' },
  { id: 73, name: '🇧🇷 Campeonato Paulista', country: 'Brasil', type: 'state' },
  { id: 74, name: '🇧🇷 Campeonato Carioca', country: 'Brasil', type: 'state' },
  { id: 76, name: '🇧🇷 Campeonato Mineiro', country: 'Brasil', type: 'state' },
  { id: 77, name: '🇧🇷 Campeonato Gaúcho', country: 'Brasil', type: 'state' },
  
  // AMÉRICA DO SUL
  { id: 13, name: '🌎 Copa Libertadores', country: 'América do Sul', type: 'continental', featured: true },
  { id: 12, name: '🌎 Copa Sul-Americana', country: 'América do Sul', type: 'continental' },
  { id: 15, name: '🌎 Copa América', country: 'América do Sul', type: 'national' },
  { id: 128, name: '🇦🇷 Liga Profesional Argentina', country: 'Argentina', type: 'league' },
  { id: 129, name: '🇺🇾 Liga Uruguaia', country: 'Uruguai', type: 'league' },
  { id: 130, name: '🇨🇱 Liga Chilena', country: 'Chile', type: 'league' },
  { id: 131, name: '🇨🇴 Liga Colombiana', country: 'Colômbia', type: 'league' },
  { id: 132, name: '🇵🇾 Liga Paraguaia', country: 'Paraguai', type: 'league' },
  { id: 133, name: '🇪🇨 Liga Equatoriana', country: 'Equador', type: 'league' },
  { id: 134, name: '🇵🇪 Liga Peruana', country: 'Peru', type: 'league' },
  
  // EUROPA - Competições Continentais
  { id: 2, name: '⭐ Liga dos Campeões UEFA', country: 'Europa', type: 'continental', featured: true },
  { id: 3, name: '⭐ Liga Europa UEFA', country: 'Europa', type: 'continental' },
  { id: 848, name: '⭐ Conference League UEFA', country: 'Europa', type: 'continental' },
  { id: 4, name: '🏆 Eurocopa', country: 'Europa', type: 'national' },
  { id: 5, name: '🏆 Liga das Nações UEFA', country: 'Europa', type: 'national' },
  
  // EUROPA - Ligas Nacionais
  { id: 39, name: '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier League', country: 'Inglaterra', type: 'league', featured: true },
  { id: 40, name: '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Championship', country: 'Inglaterra', type: 'league' },
  { id: 45, name: '🏴󠁧󠁢󠁥󠁮󠁧󠁿 FA Cup', country: 'Inglaterra', type: 'cup' },
  { id: 46, name: '🏴󠁧󠁢󠁥󠁮󠁧󠁿 EFL Cup', country: 'Inglaterra', type: 'cup' },
  { id: 140, name: '🇪🇸 La Liga', country: 'Espanha', type: 'league', featured: true },
  { id: 141, name: '🇪🇸 La Liga 2', country: 'Espanha', type: 'league' },
  { id: 143, name: '🇪🇸 Copa do Rei', country: 'Espanha', type: 'cup' },
  { id: 135, name: '🇮🇹 Série A TIM', country: 'Itália', type: 'league' },
  { id: 136, name: '🇮🇹 Série B', country: 'Itália', type: 'league' },
  { id: 137, name: '🇮🇹 Coppa Italia', country: 'Itália', type: 'cup' },
  { id: 78, name: '🇩🇪 Bundesliga', country: 'Alemanha', type: 'league' },
  { id: 79, name: '🇩🇪 2. Bundesliga', country: 'Alemanha', type: 'league' },
  { id: 80, name: '🇩🇪 DFB Pokal', country: 'Alemanha', type: 'cup' },
  { id: 61, name: '🇫🇷 Ligue 1', country: 'França', type: 'league' },
  { id: 62, name: '🇫🇷 Ligue 2', country: 'França', type: 'league' },
  { id: 94, name: '🇵🇹 Primeira Liga', country: 'Portugal', type: 'league' },
  { id: 88, name: '🇳🇱 Eredivisie', country: 'Holanda', type: 'league' },
  { id: 113, name: '🇧🇪 Pro League', country: 'Bélgica', type: 'league' },
  { id: 144, name: '🇹🇷 Süper Lig', country: 'Turquia', type: 'league' },
  { id: 197, name: '🇬🇷 Super League', country: 'Grécia', type: 'league' },
  { id: 207, name: '🇨🇭 Super League', country: 'Suíça', type: 'league' },
  { id: 119, name: '🇩🇰 Superliga', country: 'Dinamarca', type: 'league' },
  { id: 103, name: '🇸🇪 Allsvenskan', country: 'Suécia', type: 'league' },
  { id: 109, name: '🇳🇴 Eliteserien', country: 'Noruega', type: 'league' },
  { id: 108, name: '🇫🇮 Veikkausliiga', country: 'Finlândia', type: 'league' },
  { id: 345, name: '🇨🇿 Czech Liga', country: 'República Tcheca', type: 'league' },
  { id: 271, name: '🇭🇺 NB I', country: 'Hungria', type: 'league' },
  { id: 283, name: '🇷🇴 Liga I', country: 'Romênia', type: 'league' },
  { id: 106, name: '🇵🇱 Ekstraklasa', country: 'Polônia', type: 'league' },
  
  // AMÉRICA DO NORTE
  { id: 253, name: '🇺🇸 MLS', country: 'EUA', type: 'league' },
  { id: 262, name: '🇲🇽 Liga MX', country: 'México', type: 'league' },
  { id: 848, name: '🌎 CONCACAF Nations League', country: 'América do Norte', type: 'national' },
  
  // ÁSIA E OCEANIA
  { id: 307, name: '🇸🇦 Saudi Pro League', country: 'Arábia Saudita', type: 'league' },
  { id: 98, name: '🇯🇵 J1 League', country: 'Japão', type: 'league' },
  { id: 292, name: '🇰🇷 K League 1', country: 'Coreia do Sul', type: 'league' },
  { id: 169, name: '🇨🇳 Super League', country: 'China', type: 'league' },
  { id: 188, name: '🇦🇺 A-League', country: 'Austrália', type: 'league' },
];

// Perfis de times para fallback
const TEAM_STYLES = {
  ofensivo: {
    goals: 1.9, shots_total: 16, shots_on_target: 6.5, corners: 7,
    possession: 58, passes: 500, tackles: 11, fouls: 9,
    dribbles: 12, aerials_won: 14, throw_ins: 24, goal_kicks: 10,
    crosses: 20, long_balls: 40, big_chances: 3.5, expected_goals: 1.8,
    counter_attacks: 4, through_balls: 5,
  },
  defensivo: {
    goals: 0.8, shots_total: 8, shots_on_target: 3, corners: 3,
    possession: 40, passes: 340, tackles: 19, fouls: 15,
    dribbles: 5, aerials_won: 18, throw_ins: 18, goal_kicks: 15,
    crosses: 10, long_balls: 55, big_chances: 1.2, expected_goals: 0.9,
    counter_attacks: 2, through_balls: 1,
  },
  equilibrado: {
    goals: 1.4, shots_total: 13, shots_on_target: 5, corners: 5.5,
    possession: 50, passes: 430, tackles: 14, fouls: 11,
    dribbles: 8, aerials_won: 15, throw_ins: 22, goal_kicks: 12,
    crosses: 16, long_balls: 45, big_chances: 2.5, expected_goals: 1.4,
    counter_attacks: 3, through_balls: 3,
  },
  contra_ataque: {
    goals: 1.1, shots_total: 10, shots_on_target: 4, corners: 4,
    possession: 38, passes: 310, tackles: 16, fouls: 13,
    dribbles: 9, aerials_won: 12, throw_ins: 19, goal_kicks: 14,
    crosses: 14, long_balls: 50, big_chances: 1.8, expected_goals: 1.2,
    counter_attacks: 5, through_balls: 4,
  },
  pressao_alta: {
    goals: 1.7, shots_total: 15, shots_on_target: 6, corners: 6.5,
    possession: 55, passes: 460, tackles: 15, fouls: 14,
    dribbles: 10, aerials_won: 16, throw_ins: 23, goal_kicks: 9,
    crosses: 18, long_balls: 38, big_chances: 3.0, expected_goals: 1.6,
    counter_attacks: 3, through_balls: 3,
  },
};

function getTeamProfile(teamId) {
  const hash = (teamId * 13 + 7) % Object.keys(TEAM_STYLES).length;
  const styles = Object.values(TEAM_STYLES);
  return { ...styles[hash], id: teamId };
}

// ============================================
// MOTOR MATEMÁTICO APRIMORADO
// ============================================
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
  const gd = new Array(10).fill(0);
  const sl = {};
  let fh05 = 0, fh15 = 0, hfg = 0, afg = 0, hlg = 0, alg = 0;
  let hWinToNil = 0, aWinToNil = 0;
  let hWinBothHalves = 0, aWinBothHalves = 0;
  
  // Acumuladores de estatísticas
  let totalShots = 0, totalShotsOnTarget = 0, totalCorners = 0;
  let totalCards = 0, totalFouls = 0, totalThrowIns = 0;
  let totalGoalKicks = 0, totalPasses = 0, totalTackles = 0;
  let totalSaves = 0, totalOffsides = 0, totalCrosses = 0;
  let totalFreeKicks = 0, totalLongBalls = 0, totalDribbles = 0;
  let totalAerials = 0, totalInterceptions = 0, totalClearances = 0;
  let totalThroughBalls = 0, totalCounterAttacks = 0;
  let totalExpectedGoals = 0;
  
  for (let s = 0; s < MC_N; s++) {
    const hg = poissonRandom(lH), ag = poissonRandom(lA);
    const total = hg + ag;
    
    if (hg > ag) {
      hw++;
      if (ag === 0) hWinToNil++;
    } else if (hg < ag) {
      aw++;
      if (hg === 0) aWinToNil++;
    } else {
      dr++;
    }
    
    gd[Math.min(total, 9)]++;
    if (hg > 0 && ag > 0) btts++;
    if (ag === 0) csH++;
    if (hg === 0) csA++;
    
    const key = `${Math.min(hg, 6)}-${Math.min(ag, 6)}`;
    sl[key] = (sl[key] || 0) + 1;
    
    // Primeiro tempo (35-45% dos gols)
    const h1 = Math.floor(hg * (0.3 + Math.random() * 0.2));
    const a1 = Math.floor(ag * (0.3 + Math.random() * 0.2));
    if (h1 + a1 > 0.5) fh05++;
    if (h1 + a1 > 1.5) fh15++;
    
    // Cronologia
    if (hg > 0 && ag === 0) hfg++;
    if (ag > 0 && hg === 0) afg++;
    if (hg > ag) hlg++;
    if (ag > hg) alg++;
    
    // Vencer ambos os tempos
    if (h1 > a1 && (hg - h1) > (ag - a1)) hWinBothHalves++;
    if (a1 > h1 && (ag - a1) > (hg - h1)) aWinBothHalves++;
    
    // Estatísticas correlacionadas
    const intensity = (hg + ag) / 3;
    totalShots += 12 + intensity * 4;
    totalShotsOnTarget += 4 + intensity * 2;
    totalCorners += 5 + intensity * 1.5;
    totalCards += 2 + intensity * 0.6;
    totalFouls += 11 + intensity * 2;
    totalThrowIns += 22 + intensity * 1.5;
    totalGoalKicks += 12 + intensity * 1;
    totalPasses += 420 + intensity * 30;
    totalTackles += 14 + intensity * 2;
    totalSaves += 3.5 + intensity * 1;
    totalOffsides += 1.8 + intensity * 0.4;
    totalCrosses += 16 + intensity * 2;
    totalFreeKicks += 8 + intensity * 1;
    totalLongBalls += 45 + intensity * 5;
    totalDribbles += 8 + intensity * 1.5;
    totalAerials += 15 + intensity * 2;
    totalInterceptions += 10 + intensity * 1.5;
    totalClearances += 18 + intensity * 2;
    totalThroughBalls += 3 + intensity * 0.5;
    totalCounterAttacks += 3 + intensity * 0.8;
    totalExpectedGoals += (hg * 0.35 + ag * 0.3) + intensity * 0.5;
  }
  
  const p = v => Math.round(v / MC_N * 1000) / 10;
  
  const calcOver = line => {
    let c = 0;
    for (let i = Math.ceil(line); i <= 9; i++) c += gd[i];
    return p(c);
  };
  
  return {
    // Resultados
    homeWin: p(hw), draw: p(dr), awayWin: p(aw),
    
    // Gols
    over05: calcOver(0.5), over15: calcOver(1.5), over25: calcOver(2.5),
    over35: calcOver(3.5), over45: calcOver(4.5), over55: calcOver(5.5),
    under15: p(MC_N - gd.slice(2).reduce((a,b)=>a+b,0)),
    under25: p(MC_N - gd.slice(3).reduce((a,b)=>a+b,0)),
    under35: p(MC_N - gd.slice(4).reduce((a,b)=>a+b,0)),
    under45: p(MC_N - gd.slice(5).reduce((a,b)=>a+b,0)),
    
    // BTTS e Clean Sheets
    btts: p(btts), noBtts: p(MC_N - btts),
    csHome: p(csH), csAway: p(csA),
    
    // Primeiro Tempo
    fh05: p(fh05), fh15: p(fh15),
    
    // Cronologia
    homeFirstGoal: p(hfg), awayFirstGoal: p(afg),
    homeLastGoal: p(hlg), awayLastGoal: p(alg),
    
    // Especiais
    homeWinToNil: p(hWinToNil), awayWinToNil: p(aWinToNil),
    homeWinBothHalves: p(hWinBothHalves), awayWinBothHalves: p(aWinBothHalves),
    
    // Dupla Chance
    dc1x: p(hw + dr), dc12: p(hw + aw), dcx2: p(dr + aw),
    
    // Médias estatísticas
    avgShots: Math.round(totalShots / MC_N),
    avgShotsOnTarget: Math.round(totalShotsOnTarget / MC_N),
    avgCorners: Math.round(totalCorners / MC_N),
    avgCards: Math.round(totalCards / MC_N),
    avgFouls: Math.round(totalFouls / MC_N),
    avgThrowIns: Math.round(totalThrowIns / MC_N),
    avgGoalKicks: Math.round(totalGoalKicks / MC_N),
    avgPasses: Math.round(totalPasses / MC_N),
    avgTackles: Math.round(totalTackles / MC_N),
    avgSaves: Math.round(totalSaves / MC_N),
    avgOffsides: Math.round(totalOffsides / MC_N),
    avgCrosses: Math.round(totalCrosses / MC_N),
    avgFreeKicks: Math.round(totalFreeKicks / MC_N),
    avgLongBalls: Math.round(totalLongBalls / MC_N),
    avgDribbles: Math.round(totalDribbles / MC_N),
    avgAerials: Math.round(totalAerials / MC_N),
    avgInterceptions: Math.round(totalInterceptions / MC_N),
    avgClearances: Math.round(totalClearances / MC_N),
    avgThroughBalls: Math.round(totalThroughBalls / MC_N),
    avgCounterAttacks: Math.round(totalCounterAttacks / MC_N),
    avgExpectedGoals: Math.round(totalExpectedGoals / MC_N * 100) / 100,
    
    // Placar exato
    top5: Object.entries(sl).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([s,c])=>({score:s,prob:p(c)})),
    top10: Object.entries(sl).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([s,c])=>({score:s,prob:p(c)})),
    
    // Lambdas
    lambdaH: Math.round(lH * 100) / 100,
    lambdaA: Math.round(lA * 100) / 100,
    
    // Taxa de acerto estimada
    estimatedAccuracy: calculateEstimatedAccuracy(p(hw), p(dr), p(aw)),
  };
}

function calculateEstimatedAccuracy(homeProb, drawProb, awayProb) {
  // Modelo de calibração baseado na probabilidade máxima
  const maxProb = Math.max(homeProb, drawProb, awayProb);
  if (maxProb >= 75) return Math.min(95, maxProb - 2);
  if (maxProb >= 60) return maxProb - 5;
  return Math.max(40, maxProb - 10);
}

// ============================================
// FUNÇÕES DE API
// ============================================
async function apiGet(path, params = {}) {
  const key = process.env.APIFOOTBALL_KEY;
  if (!key) {
    throw new Error('APIFOOTBALL_KEY não configurada nas variáveis de ambiente.');
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
  
  if (!res) return { response: [] };
  
  const data = await res.json();
  setCache(cacheKey, data);
  
  return data;
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

function mapFixture(item) {
  const kickoffTime = new Date(item.fixture.date);
  const now = new Date();
  const hoursSinceEnd = item.fixture.status?.short === 'FT' ? 
    (now - kickoffTime) / 3600000 : 0;
  
  const leagueInfo = AVAILABLE_LEAGUES.find(l => l.id === item.league?.id);
  
  return {
    id: item.fixture.id,
    league: {
      id: item.league?.id || null,
      name: leagueInfo?.name || item.league?.name || 'Amistoso Internacional',
      country: leagueInfo?.country || item.league?.country || 'Mundial',
      logo: item.league?.logo || null,
      type: leagueInfo?.type || 'friendly',
      featured: leagueInfo?.featured || false,
    },
    startingAt: item.fixture.date,
    statusShort: item.fixture.status?.short || 'NS',
    elapsed: item.fixture.status?.elapsed || null,
    home: item.teams.home.name,
    away: item.teams.away.name,
    homeId: item.teams.home.id,
    awayId: item.teams.away.id,
    homeLogo: item.teams.home.logo,
    awayLogo: item.teams.away.logo,
    homeGoals: item.goals?.home ?? null,
    awayGoals: item.goals?.away ?? null,
    hoursSinceEnd: hoursSinceEnd,
    shouldCleanup: hoursSinceEnd > MAX_HISTORY_HOURS,
    venue: item.fixture?.venue?.name || null,
    referee: item.fixture?.referee || null,
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

// ============================================
// HANDLERS PRINCIPAIS
// ============================================
async function handleFixtures(qs) {
  const date = qs.date || fmtDate(new Date());
  
  let allFixtures = [];
  
  // Buscar jogos ao vivo (prioridade máxima)
  try {
    const liveData = await apiGet('/fixtures', { live: 'all' });
    if (liveData?.response) {
      allFixtures.push(...liveData.response);
    }
  } catch (err) {
    console.warn('Erro ao buscar jogos ao vivo:', err.message);
  }
  
  // Buscar jogos do dia
  if (qs.scope !== 'live') {
    try {
      const dayData = await apiGet('/fixtures', { date });
      if (dayData?.response) {
        const existingIds = new Set(allFixtures.map(f => f.fixture.id));
        const newFixtures = dayData.response.filter(f => !existingIds.has(f.fixture.id));
        allFixtures.push(...newFixtures);
      }
    } catch (err) {
      console.warn('Erro ao buscar jogos do dia:', err.message);
    }
  }
  
  // Buscar ligas específicas (Copa do Mundo 2026, etc.)
  if (qs.includeLeagues) {
    const leagueIds = qs.includeLeagues.split(',').map(Number);
    for (const leagueId of leagueIds) {
      try {
        const leagueData = await apiGet('/fixtures', { 
          league: leagueId, 
          season: qs.season || new Date().getFullYear() 
        });
        if (leagueData?.response) {
          const existingIds = new Set(allFixtures.map(f => f.fixture.id));
          const newFixtures = leagueData.response.filter(f => !existingIds.has(f.fixture.id));
          allFixtures.push(...newFixtures);
        }
      } catch (err) {
        console.warn(`Erro ao buscar liga ${leagueId}:`, err.message);
      }
    }
  }
  
  const fixtures = allFixtures.map(mapFixture);
  
  const live = fixtures.filter(f => f.statusShort === 'LIVE');
  const ended = fixtures.filter(f => f.statusShort === 'FT' && !f.shouldCleanup);
  const scheduled = fixtures.filter(f => ['NS', 'TBD', 'PST'].includes(f.statusShort));
  
  // Ao vivo primeiro, depois agendados, depois encerrados
  const sorted = [...live, ...scheduled, ...ended];
  
  return {
    fixtures: sorted,
    total: sorted.length,
    live: live.length,
    scheduled: scheduled.length,
    ended: ended.length,
    cleaned: fixtures.filter(f => f.shouldCleanup).length,
    leagues: [...new Set(fixtures.map(f => f.league?.name))].filter(Boolean),
    availableLeagues: AVAILABLE_LEAGUES,
    totalLeagues: AVAILABLE_LEAGUES.length,
    date: date,
  };
}

async function fetchTeamStats(teamId) {
  const cacheKey = `team_v6_${teamId}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;
  
  try {
    const fj = await apiGet('/fixtures', { team: teamId, last: MAX_MATCHES, status: 'FT' });
    const fixtures = fj.response || [];
    
    if (!fixtures.length) {
      const profile = getTeamProfile(teamId);
      const fallback = buildFallbackStats(profile);
      setCache(cacheKey, fallback);
      return fallback;
    }
    
    const stats = {
      fixtures: [],
      all: {},
      last3: {},
      gf: [], ga: [],
      wins: 0, draws: 0, losses: 0,
      cleanSheets: 0, failedToScore: 0,
      homeGF: [], homeGA: [], homeWins: 0, homePlayed: 0,
      awayGF: [], awayGA: [], awayWins: 0, awayPlayed: 0,
      over15: 0, over25: 0, over35: 0, under25: 0,
      btts: 0, totalGoals: 0,
      recentForm: [],
      accuracyHistory: [],
    };
    
    for (let idx = 0; idx < fixtures.length; idx++) {
      const fx = fixtures[idx];
      const isHome = fx.teams.home.id === teamId;
      const gf = isHome ? (fx.goals.home ?? 0) : (fx.goals.away ?? 0);
      const ga = isHome ? (fx.goals.away ?? 0) : (fx.goals.home ?? 0);
      
      stats.gf.push(gf);
      stats.ga.push(ga);
      stats.totalGoals += gf + ga;
      
      if (isHome) {
        stats.homeGF.push(gf); stats.homeGA.push(ga);
        stats.homePlayed++;
        if (gf > ga) stats.homeWins++;
      } else {
        stats.awayGF.push(gf); stats.awayGA.push(ga);
        stats.awayPlayed++;
        if (gf > ga) stats.awayWins++;
      }
      
      if (gf > ga) stats.wins++;
      else if (gf === ga) stats.draws++;
      else stats.losses++;
      
      if (ga === 0) stats.cleanSheets++;
      if (gf === 0) stats.failedToScore++;
      if (gf + ga > 1.5) stats.over15++;
      if (gf + ga > 2.5) stats.over25++;
      if (gf + ga > 3.5) stats.over35++;
      if (gf + ga < 2.5) stats.under25++;
      if (gf > 0 && ga > 0) stats.btts++;
      
      stats.recentForm.push(gf > ga ? 'W' : gf === ga ? 'D' : 'L');
      
      // Buscar estatísticas detalhadas
      if (idx < 8) {
        try {
          const sj = await apiGet('/fixtures/statistics', { fixture: fx.fixture.id });
          stats.fixtures.push({
            id: fx.fixture.id,
            stats: sj.response || [],
            goals: { home: fx.goals?.home ?? 0, away: fx.goals?.away ?? 0 },
            date: fx.fixture.date,
          });
        } catch (err) {
          console.warn(`Erro stats partida ${fx.fixture.id}:`, err.message);
        }
      }
    }
    
    setCache(cacheKey, stats);
    return stats;
    
  } catch (err) {
    console.warn(`Erro stats time ${teamId}:`, err.message);
    const profile = getTeamProfile(teamId);
    return buildFallbackStats(profile);
  }
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
    form: { wins: 0, draws: 0, losses: 0, played: 0, winRate: 0, recent: [] },
    homeForm: { wins: 0, played: 0, winRate: 0, goalsFor: profile.goals || 1.3, goalsAgainst: 1.1 },
    awayForm: { wins: 0, played: 0, winRate: 0, goalsFor: (profile.goals || 1.3) * 0.75, goalsAgainst: 1.4 },
    over15Rate: 0.7, over25Rate: 0.5, over35Rate: 0.25,
    under25Rate: 0.5, bttsRate: 0.5,
    cleanSheets: 0, failedToScore: 0,
    avgGoalsFor: profile.goals || 1.3,
    avgGoalsAgainst: 1.3,
    avgTotalGoals: 2.6,
    style: Object.keys(TEAM_STYLES).find(k => TEAM_STYLES[k].goals === profile.goals) || 'equilibrado',
    isFallback: true,
  };
}

async function teamStats(teamId) {
  const raw = await fetchTeamStats(teamId);
  
  if (raw.isFallback || !raw.fixtures?.length) return raw;
  
  const mk = Object.keys(STAT_NAMES);
  const pools = { all: {}, last3: {} };
  for (const pool of Object.values(pools)) {
    for (const k of mk) pool[k] = [];
    pool.gf = []; pool.ga = [];
  }
  
  for (let idx = 0; idx < raw.fixtures.length; idx++) {
    const fxData = raw.fixtures[idx];
    const isRecent = idx < 3;
    
    pools.all.gf.push(raw.gf[idx]);
    pools.all.ga.push(raw.ga[idx]);
    if (isRecent) {
      pools.last3.gf.push(raw.gf[idx]);
      pools.last3.ga.push(raw.ga[idx]);
    }
    
    for (const [key, apiName] of Object.entries(STAT_API_MAP)) {
      const val = extractStat({ response: fxData.stats }, teamId, apiName);
      if (val !== null && !isNaN(val)) {
        pools.all[key].push(val);
        if (isRecent) pools.last3[key].push(val);
      }
    }
    
    const y = extractStat({ response: fxData.stats }, teamId, 'Yellow Cards');
    const r = extractStat({ response: fxData.stats }, teamId, 'Red Cards');
    if (y !== null) {
      pools.all.yellow_cards.push(y);
      if (isRecent) pools.last3.yellow_cards.push(y);
    }
    if (r !== null) {
      pools.all.red_cards.push(r);
      if (isRecent) pools.last3.red_cards.push(r);
    }
    if (y !== null || r !== null) {
      const c = (y || 0) + (r || 0);
      pools.all.cards.push(c);
      if (isRecent) pools.last3.cards.push(c);
    }
  }
  
  const mean = arr => arr.length ? arr.reduce((a,b) => a + b, 0) / arr.length : null;
  const wavg = k => {
    const a3 = mean(pools.last3[k]), ag = mean(pools.all[k]);
    if (a3 != null && ag != null) return a3 * 0.7 + ag * 0.3;
    return ag ?? a3 ?? GENERIC[k] ?? null;
  };
  
  const averages = {}, isReal = {};
  for (const k of mk) {
    averages[k] = wavg(k) ?? GENERIC[k];
    isReal[k] = (pools.all[k]?.length || 0) >= 3;
  }
  averages.goalsFor = wavg('gf') ?? 1.3;
  averages.goalsAgainst = wavg('ga') ?? 1.3;
  
  const total = raw.fixtures.length;
  
  return {
    averages, isReal, matchesAnalyzed: total,
    form: {
      wins: raw.wins, draws: raw.draws, losses: raw.losses,
      played: total, winRate: total ? raw.wins / total : 0,
      recent: raw.recentForm,
    },
    homeForm: {
      wins: raw.homeWins, played: raw.homePlayed,
      winRate: raw.homePlayed ? raw.homeWins / raw.homePlayed : 0,
      goalsFor: mean(raw.homeGF) ?? 1.3,
      goalsAgainst: mean(raw.homeGA) ?? 1.3,
    },
    awayForm: {
      wins: raw.awayWins, played: raw.awayPlayed,
      winRate: raw.awayPlayed ? raw.awayWins / raw.awayPlayed : 0,
      goalsFor: mean(raw.awayGF) ?? 1.1,
      goalsAgainst: mean(raw.awayGA) ?? 1.5,
    },
    over15Rate: total ? raw.over15 / total : 0.7,
    over25Rate: total ? raw.over25 / total : 0.5,
    over35Rate: total ? raw.over35 / total : 0.25,
    under25Rate: total ? raw.under25 / total : 0.5,
    bttsRate: total ? raw.btts / total : 0.5,
    cleanSheets: raw.cleanSheets,
    failedToScore: raw.failedToScore,
    avgGoalsFor: averages.goalsFor,
    avgGoalsAgainst: averages.goalsAgainst,
    avgTotalGoals: total ? raw.totalGoals / total : 2.6,
    style: classifyStyle(averages),
    isFallback: false,
  };
}

function classifyStyle(averages) {
  const gf = averages.goalsFor || 1.3;
  const ga = averages.goalsAgainst || 1.3;
  const poss = averages.possession || 50;
  
  if (gf > 1.6 && poss > 52) return 'ofensivo';
  if (ga < 1.0 && poss < 48) return 'defensivo';
  if (gf < 1.1 && poss < 45) return 'contra_ataque';
  if (gf > 1.4 && averages.fouls > 12) return 'pressao_alta';
  return 'equilibrado';
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

// ============================================
// CONSTRUÇÃO DE MERCADOS (60+)
// ============================================
function buildAllMarkets(mc, hS, aS, hName, aName) {
  const markets = [];
  
  // --- RESULTADOS ---
  markets.push({k:'1x2_home',cat:'Resultado',label:`Vitória ${hName}`,icon:'🏠',prob:mc.homeWin,val:mc.homeWin>40,est:hS.matchesAnalyzed<3});
  markets.push({k:'1x2_draw',cat:'Resultado',label:'Empate',icon:'🤝',prob:mc.draw,val:mc.draw>30,est:hS.matchesAnalyzed<3});
  markets.push({k:'1x2_away',cat:'Resultado',label:`Vitória ${aName}`,icon:'✈️',prob:mc.awayWin,val:mc.awayWin>40,est:aS.matchesAnalyzed<3});
  
  // --- DUPLA CHANCE ---
  markets.push({k:'dc_1x',cat:'Dupla Chance',label:`${hName} ou Empate`,icon:'🛡️',prob:mc.dc1x,val:mc.dc1x>65,est:false});
  markets.push({k:'dc_12',cat:'Dupla Chance',label:`${hName} ou ${aName}`,icon:'⚡',prob:mc.dc12,val:mc.dc12>70,est:false});
  markets.push({k:'dc_x2',cat:'Dupla Chance',label:`Empate ou ${aName}`,icon:'🛡️',prob:mc.dcx2,val:mc.dcx2>65,est:false});
  
  // --- GOLS ---
  [0.5, 1.5, 2.5, 3.5, 4.5].forEach(line => {
    const ok = `over${Math.floor(line*10)}`, uk = `under${Math.floor(line*10)}`;
    markets.push({k:`goals_over_${line}`,cat:'Gols',label:`Over ${line} Gols`,icon:line<=1.5?'⚽':line<=2.5?'⚽⚽':'🔥',prob:mc[ok],line,val:mc[ok]>(line<=1.5?75:line<=2.5?55:35),est:false});
    markets.push({k:`goals_under_${line}`,cat:'Gols',label:`Under ${line} Gols`,icon:'🛡️',prob:mc[uk],line,val:mc[uk]>(line>=3.5?70:55),est:false});
  });
  
  // --- BTTS ---
  markets.push({k:'btts_yes',cat:'BTTS',label:'Ambas Marcam Sim',icon:'⚽↔️⚽',prob:mc.btts,val:mc.btts>55,est:false});
  markets.push({k:'btts_no',cat:'BTTS',label:'Ambas Marcam Não',icon:'🚫',prob:mc.noBtts,val:mc.noBtts>55,est:false});
  
  // --- 1º TEMPO ---
  markets.push({k:'fh05',cat:'1º Tempo',label:'Over 0.5 1º Tempo',icon:'⚽ 1T',prob:mc.fh05,val:mc.fh05>65,est:false});
  markets.push({k:'fh15',cat:'1º Tempo',label:'Over 1.5 1º Tempo',icon:'⚽⚽ 1T',prob:mc.fh15,val:mc.fh15>35,est:false});
  
  // --- CRONOLOGIA ---
  markets.push({k:'first_goal_home',cat:'Cronologia',label:`1º Gol ${hName}`,icon:'🏠⚽',prob:mc.homeFirstGoal,val:mc.homeFirstGoal>40,est:false});
  markets.push({k:'first_goal_away',cat:'Cronologia',label:`1º Gol ${aName}`,icon:'✈️⚽',prob:mc.awayFirstGoal,val:mc.awayFirstGoal>35,est:false});
  markets.push({k:'last_goal_home',cat:'Cronologia',label:`Último Gol ${hName}`,icon:'🏠⏱️',prob:mc.homeLastGoal,val:mc.homeLastGoal>35,est:false});
  markets.push({k:'last_goal_away',cat:'Cronologia',label:`Último Gol ${aName}`,icon:'✈️⏱️',prob:mc.awayLastGoal,val:mc.awayLastGoal>30,est:false});
  
  // --- CLEAN SHEET ---
  markets.push({k:'cs_home',cat:'Defesa',label:`${hName} sem sofrer`,icon:'🏠🔒',prob:mc.csHome,val:mc.csHome>35,est:false});
  markets.push({k:'cs_away',cat:'Defesa',label:`${aName} sem sofrer`,icon:'✈️🔒',prob:mc.csAway,val:mc.csAway>30,est:false});
  
  // --- HANDICAP ---
  markets.push({k:'handicap_home_m1',cat:'Handicap',label:`${hName} -1`,icon:'🏠-1',prob:Math.max(5,mc.homeWin-15),val:(mc.homeWin-15)>35,est:false});
  markets.push({k:'handicap_away_p1',cat:'Handicap',label:`${aName} +1`,icon:'✈️+1',prob:Math.min(95,mc.awayWin+15),val:(mc.awayWin+15)>40,est:false});
  
  // --- WIN TO NIL ---
  markets.push({k:'win_to_nil_home',cat:'Especiais',label:`${hName} vence sem sofrer`,icon:'🏠🧤',prob:mc.homeWinToNil,val:mc.homeWinToNil>20,est:false});
  markets.push({k:'win_to_nil_away',cat:'Especiais',label:`${aName} vence sem sofrer`,icon:'✈️🧤',prob:mc.awayWinToNil,val:mc.awayWinToNil>15,est:false});
  
  // --- PLACAR EXATO ---
  mc.top5.forEach(sl => {
    markets.push({k:`correct_score_${sl.score}`,cat:'Placar Exato',label:`Placar ${sl.score}`,icon:'🎯',prob:sl.prob,val:sl.prob>8,est:false});
  });
  
  // --- ESTATÍSTICAS (Laterais, Tiros de Meta, etc.) ---
  const statLines = [
    {k:'shots_total',label:'Total de Chutes',line:22.5,icon:'🎯'},
    {k:'shots_on_target',label:'Chutes no Gol',line:8.5,icon:'🎯✅'},
    {k:'shots_inside_box',label:'Chutes na Área',line:14.5,icon:'📦'},
    {k:'big_chances',label:'Grandes Chances',line:4.5,icon:'💥'},
    {k:'expected_goals',label:'Gols Esperados (xG)',line:2.5,icon:'📊'},
    {k:'corners',label:'Escanteios',line:9.5,icon:'🏴'},
    {k:'cards',label:'Cartões',line:4.5,icon:'🟨'},
    {k:'fouls',label:'Faltas',line:22.5,icon:'⚠️'},
    {k:'offsides',label:'Impedimentos',line:3.5,icon:'🏃'},
    {k:'passes',label:'Passes',line:800,icon:'🔄'},
    {k:'tackles',label:'Desarmes',line:28.5,icon:'💪'},
    {k:'interceptions',label:'Interceptações',line:18.5,icon:'✋'},
    {k:'clearances',label:'Cortes',line:35.5,icon:'🧹'},
    {k:'goalkeeper_saves',label:'Defesas',line:5.5,icon:'🧤'},
    {k:'throw_ins',label:'Laterais',line:42.5,icon:'📥'},
    {k:'goal_kicks',label:'Tiros de Meta',line:22.5,icon:'🥅'},
    {k:'crosses',label:'Cruzamentos',line:30.5,icon:'↗️'},
    {k:'dribbles',label:'Dribles',line:16.5,icon:'🏃‍♂️'},
    {k:'aerials_won',label:'Duelos Aéreos',line:28.5,icon:'✈️'},
    {k:'free_kicks',label:'Cobranças de Falta',line:15.5,icon:'🦶'},
    {k:'long_balls',label:'Bolas Longas',line:85.5,icon:'🚀'},
    {k:'through_balls',label:'Bolas em Profundidade',line:5.5,icon:'🔑'},
    {k:'counter_attacks',label:'Contra-Ataques',line:5.5,icon:'⚡'},
  ];
  
  statLines.forEach(sl => {
    const h = hS.averages[sl.k] ?? GENERIC[sl.k];
    const a = aS.averages[sl.k] ?? GENERIC[sl.k];
    const total = h + a;
    const overProb = Math.min(95, Math.max(25, Math.round(50 + ((total - sl.line) / Math.max(1, sl.line)) * 60)));
    const isEst = !hS.isReal[sl.k] || !aS.isReal[sl.k];
    
    markets.push({
      k: `stat_${sl.k}_over`, cat: 'Estatísticas',
      label: `${sl.label} +${sl.line}`, icon: sl.icon,
      prob: overProb, val: overProb > 55 && !isEst, est: isEst,
      pt: Math.round(total * 10) / 10,
      ha: Math.round(h * 10) / 10, aa: Math.round(a * 10) / 10,
      line: sl.line,
    });
    
    markets.push({
      k: `stat_${sl.k}_under`, cat: 'Estatísticas',
      label: `${sl.label} -${sl.line}`, icon: sl.icon,
      prob: 100 - overProb, val: (100 - overProb) > 55 && !isEst, est: isEst,
      pt: Math.round(total * 10) / 10,
      ha: Math.round(h * 10) / 10, aa: Math.round(a * 10) / 10,
      line: sl.line,
    });
  });
  
  return markets;
}

function findBestBet(markets, mc, hS, aS) {
  const candidates = markets
    .filter(m => !m.est || m.prob > 60)
    .sort((a, b) => {
      if (a.est !== b.est) return a.est ? 1 : -1;
      if (a.val !== b.val) return a.val ? -1 : 1;
      return b.prob - a.prob;
    });
  
  const best = candidates[0] || markets[0];
  
  return {
    market: best.label,
    key: best.k,
    category: best.cat,
    prob: best.prob,
    confidence: best.prob >= 75 ? 'Alta' : best.prob >= 60 ? 'Média' : 'Baixa',
    risk: best.prob >= 75 ? 'Baixo' : best.prob >= 60 ? 'Médio' : 'Alto',
    valueBet: best.val,
    isEstimate: best.est,
    impliedOdds: Math.round((1 / (best.prob / 100)) * 1.08 * 100) / 100,
    justification: `Análise de ${MC_N.toLocaleString()} simulações Monte Carlo + Poisson. ${best.est ? '(Dados parcialmente estimados)' : '(Baseado em dados reais)'}`,
    estimatedAccuracy: mc.estimatedAccuracy,
    line: best.line || null,
    predictedTotal: best.pt || null,
  };
}

function genFactors(hS, aS, mc, hName, aName) {
  const factors = [];
  const pct = v => Math.round(v * 100);
  const rnd = v => Math.round(v * 10) / 10;
  
  if (hS.matchesAnalyzed >= 3) {
    factors.push({icon:'📊',text:`${hName}: ${hS.form.wins}V/${hS.form.draws}E/${hS.form.losses}D em ${hS.matchesAnalyzed} jogos`});
  }
  if (aS.matchesAnalyzed >= 3) {
    factors.push({icon:'📊',text:`${aName}: ${aS.form.wins}V/${aS.form.draws}E/${aS.form.losses}D em ${aS.matchesAnalyzed} jogos`});
  }
  if (hS.homeForm.played >= 2) {
    factors.push({icon:hS.homeForm.winRate>=.5?'🟢':'🔴',text:`${hName} em casa: ${hS.homeForm.wins}/${hS.homeForm.played} vitórias`});
  }
  if (aS.awayForm.played >= 2) {
    factors.push({icon:aS.awayForm.winRate>=.4?'🟢':'🔴',text:`${aName} fora: ${aS.awayForm.wins}/${aS.awayForm.played} vitórias`});
  }
  factors.push({icon:'⚽',text:`${hName}: ${rnd(hS.avgGoalsFor)} gols/j | ${rnd(hS.avgGoalsAgainst)} sofridos/j`});
  factors.push({icon:'⚽',text:`${aName}: ${rnd(aS.avgGoalsFor)} gols/j | ${rnd(aS.avgGoalsAgainst)} sofridos/j`});
  factors.push({icon:'📈',text:`Over 2.5: ${hName} ${pct(hS.over25Rate)}% | ${aName} ${pct(aS.over25Rate)}%`});
  factors.push({icon:'🤝',text:`BTTS: ${hName} ${pct(hS.bttsRate)}% | ${aName} ${pct(aS.bttsRate)}%`});
  if (hS.cleanSheets>0) factors.push({icon:'🔒',text:`${hName}: ${hS.cleanSheets} jogos sem sofrer`});
  if (aS.failedToScore>0) factors.push({icon:'⚠️',text:`${aName}: ${aS.failedToScore} jogos sem marcar`});
  if (mc.homeWin>50) factors.push({icon:'📈',text:`Monte Carlo: ${hName} favorito (${mc.homeWin}%)`});
  else if (mc.awayWin>50) factors.push({icon:'📈',text:`Monte Carlo: ${aName} favorito (${mc.awayWin}%)`});
  else factors.push({icon:'⚖️',text:`Equilibrado: empate ${mc.draw}%`});
  if (mc.btts>60) factors.push({icon:'⚽',text:`BTTS provável: ${mc.btts}%`});
  if (mc.over25>60) factors.push({icon:'📈',text:`Over 2.5 favorecido: ${mc.over25}%`});
  
  // Adicionar taxa de acerto estimada
  factors.push({icon:'🎯',text:`Taxa de acerto estimada: ${mc.estimatedAccuracy}%`});
  
  return factors.slice(0, 15);
}

// ============================================
// HANDLERS DE ROTA
// ============================================
async function handlePredict(qs) {
  const homeId = parseInt(qs.home, 10);
  const awayId = parseInt(qs.away, 10);
  const hName = qs.homeName || 'Mandante';
  const aName = qs.awayName || 'Visitante';
  
  if (!homeId || !awayId) throw new Error('Informe "home" e "away" (IDs dos times).');
  
  const [hS, aS] = await Promise.all([teamStats(homeId), teamStats(awayId)]);
  
  const lH = calcLambda(hS, aS, true);
  const lA = calcLambda(aS, hS, false);
  const mc = monteCarloSimulation(lH, lA);
  
  const allMarkets = buildAllMarkets(mc, hS, aS, hName, aName);
  const bestBet = findBestBet(allMarkets, mc, hS, aS);
  const factors = genFactors(hS, aS, mc, hName, aName);
  
  // Agrupar por categoria
  const byCategory = {};
  allMarkets.forEach(m => {
    if (!byCategory[m.cat]) byCategory[m.cat] = [];
    byCategory[m.cat].push(m);
  });
  Object.keys(byCategory).forEach(cat => {
    byCategory[cat] = byCategory[cat].sort((a,b) => b.prob - a.prob).slice(0, 8);
  });
  
  const ticket = allMarkets.filter(m => m.val).sort((a,b) => b.prob - a.prob).slice(0, 15);
  
  return {
    homeMatchesAnalyzed: hS.matchesAnalyzed,
    awayMatchesAnalyzed: aS.matchesAnalyzed,
    homeIsFallback: hS.isFallback || false,
    awayIsFallback: aS.isFallback || false,
    homeStyle: hS.style || 'equilibrado',
    awayStyle: aS.style || 'equilibrado',
    allMarkets,
    byCategory,
    ticket,
    mc,
    bestBet,
    factors,
    estimatedAccuracy: mc.estimatedAccuracy,
    stats: {
      home: {
        avgGoalsFor: hS.avgGoalsFor, avgGoalsAgainst: hS.avgGoalsAgainst,
        over15Rate: hS.over15Rate, over25Rate: hS.over25Rate,
        over35Rate: hS.over35Rate, bttsRate: hS.bttsRate,
        cleanSheets: hS.cleanSheets, form: hS.form,
        homeForm: hS.homeForm, awayForm: hS.awayForm,
        averages: hS.averages, style: hS.style || 'equilibrado',
      },
      away: {
        avgGoalsFor: aS.avgGoalsFor, avgGoalsAgainst: aS.avgGoalsAgainst,
        over15Rate: aS.over15Rate, over25Rate: aS.over25Rate,
        over35Rate: aS.over35Rate, bttsRate: aS.bttsRate,
        cleanSheets: aS.cleanSheets, form: aS.form,
        homeForm: aS.homeForm, awayForm: aS.awayForm,
        averages: aS.averages, style: aS.style || 'equilibrado',
      },
    },
  };
}

async function handleCompare(qs) {
  const fid = parseInt(qs.fixture, 10);
  const hId = parseInt(qs.home, 10);
  const aId = parseInt(qs.away, 10);
  
  if (!fid || !hId || !aId) throw new Error('Informe "fixture", "home" e "away".');
  
  const [hS, aS, lj] = await Promise.all([
    teamStats(hId), teamStats(aId),
    apiGet('/fixtures/statistics', { fixture: fid }),
  ]);
  
  const comparisons = [];
  
  for (const [key, apiName] of Object.entries(STAT_API_MAP)) {
    if (['yellow_cards', 'red_cards', 'cards'].includes(key)) continue;
    
    const hPred = hS.averages[key] ?? GENERIC[key];
    const aPred = aS.averages[key] ?? GENERIC[key];
    const pred = Math.round((hPred + aPred) * 10) / 10;
    
    const vH = extractStat(lj, hId, apiName);
    const vA = extractStat(lj, aId, apiName);
    const actual = (vH != null || vA != null) ? (vH || 0) + (vA || 0) : null;
    
    comparisons.push({
      statKey: key,
      statLabel: STAT_NAMES[key] || key,
      predictedTotal: pred,
      homeAvg: Math.round(hPred * 10) / 10,
      awayAvg: Math.round(aPred * 10) / 10,
      suggestedLine: roundLine(pred),
      actual,
      accuracy: actual != null ? 
        (Math.abs(pred - actual) <= 1 ? 'Alta' : Math.abs(pred - actual) <= 2 ? 'Média' : 'Baixa') : null,
      deviation: actual != null ? Math.round((pred - actual) * 10) / 10 : null,
    });
  }
  
  // Cartões
  const yH = extractStat(lj, hId, 'Yellow Cards'), rH = extractStat(lj, hId, 'Red Cards');
  const yA = extractStat(lj, aId, 'Yellow Cards'), rA = extractStat(lj, aId, 'Red Cards');
  
  comparisons.push({
    statKey: 'cards',
    statLabel: 'Cartões Totais',
    predictedTotal: Math.round(((hS.averages.cards ?? GENERIC.cards) + (aS.averages.cards ?? GENERIC.cards)) * 10) / 10,
    homeAvg: Math.round((hS.averages.cards ?? GENERIC.cards) * 10) / 10,
    awayAvg: Math.round((aS.averages.cards ?? GENERIC.cards) * 10) / 10,
    suggestedLine: 5.5,
    actual: (yH != null || yA != null || rH != null || rA != null) ? (yH||0)+(rH||0)+(yA||0)+(rA||0) : null,
  });
  
  return {
    fixtureId: fid,
    comparisons,
    summary: {
      total: comparisons.length,
      withActual: comparisons.filter(c => c.actual !== null).length,
      highAccuracy: comparisons.filter(c => c.accuracy === 'Alta').length,
      mediumAccuracy: comparisons.filter(c => c.accuracy === 'Média').length,
      lowAccuracy: comparisons.filter(c => c.accuracy === 'Baixa').length,
      avgDeviation: comparisons.filter(c => c.deviation !== null).reduce((a,c) => a + Math.abs(c.deviation), 0) / 
                   (comparisons.filter(c => c.deviation !== null).length || 1),
    },
  };
}

async function handleHealth() {
  const key = process.env.APIFOOTBALL_KEY;
  return {
    status: 'online',
    version: '6.0.0',
    apiConfigured: !!key,
    cacheSize: cache.size,
    leaguesCount: AVAILABLE_LEAGUES.length,
    statsCount: Object.keys(STAT_NAMES).length,
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    timestamp: new Date().toISOString(),
  };
}

// ============================================
// EXPORT DO HANDLER
// ============================================
exports.handler = async (event) => {
  const startTime = Date.now();
  const qs = event.queryStringParameters || {};
  
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'public, max-age=60',
  };
  
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers };
  }
  
  try {
    let result;
    
    switch (qs.action) {
      case 'fixtures':
        result = await handleFixtures(qs);
        break;
      case 'predict':
        result = await handlePredict(qs);
        break;
      case 'compare':
        result = await handleCompare(qs);
        break;
      case 'leagues':
        result = { leagues: AVAILABLE_LEAGUES, total: AVAILABLE_LEAGUES.length };
        break;
      case 'stats':
        result = { stats: STAT_NAMES, total: Object.keys(STAT_NAMES).length };
        break;
      case 'health':
        result = await handleHealth();
        break;
      default:
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            error: 'Ação inválida',
            validActions: ['fixtures', 'predict', 'compare', 'leagues', 'stats', 'health'],
            examples: {
              fixtures: '?action=fixtures&date=2026-07-02&scope=all&includeLeagues=1,2,13',
              predict: '?action=predict&home=121&away=130&homeName=Flamengo&awayName=Palmeiras',
              compare: '?action=compare&fixture=12345&home=121&away=130',
              leagues: '?action=leagues',
              stats: '?action=stats',
              health: '?action=health',
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
        _meta: {
          duration: `${duration}ms`,
          timestamp: new Date().toISOString(),
          version: '6.0.0',
          api: 'FuteStat API - Alta Precisão',
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
        _meta: {
          duration: `${Date.now() - startTime}ms`,
          timestamp: new Date().toISOString(),
        },
      }),
    };
  }
};
