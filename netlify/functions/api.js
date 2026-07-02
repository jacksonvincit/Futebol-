// FuteStat v4.0 — Motor Híbrido de Inteligência Esportiva
// Preserva toda funcionalidade existente + Poisson + Monte Carlo + Ponderação temporal

const BASE_URL = 'https://v3.football.api-sports.io';
const MAX_MATCHES = 5;
const MC_N = 10000;

const STAT_NAMES = {
  shots_total:'Total de chutes', shots_on_target:'Chutes no gol',
  shots_off_target:'Chutes para fora', corners:'Escanteios',
  cards:'Cartões (amar. + verm.)', yellow_cards:'Cartões amarelos',
  fouls:'Faltas', offsides:'Impedimentos', goals:'Gols',
  passes:'Passes totais', goalkeeper_saves:'Defesas do goleiro', tackles:'Desarmes',
};

const GENERIC = {
  shots_total:12, shots_on_target:4.5, shots_off_target:5.5,
  corners:5, cards:2.2, yellow_cards:1.9, fouls:11,
  offsides:1.8, goals:1.3, passes:420, goalkeeper_saves:3.5, tackles:14,
};

const STAT_API = {
  shots_total:'Total Shots', shots_on_target:'Shots on Goal',
  shots_off_target:'Shots off Goal', corners:'Corner Kicks',
  fouls:'Fouls', offsides:'Offsides', passes:'Total passes',
  goalkeeper_saves:'Goalkeeper Saves', tackles:'Total tackles',
};

async function apiGet(path, params = {}) {
  const key = process.env.APIFOOTBALL_KEY;
  if (!key) throw new Error('APIFOOTBALL_KEY não configurada nas variáveis de ambiente da Netlify.');
  const url = new URL(BASE_URL + path);
  for (const [k,v] of Object.entries(params)) if (v!=null) url.searchParams.set(k,v);
  const res = await fetch(url.toString(), { headers: {'x-apisports-key': key} });
  if (res.status===429) throw new Error('RATE_LIMIT: limite diário atingido. Tente amanhã.');
  if (!res.ok) throw new Error(`API-Football HTTP ${res.status}`);
  return res.json();
}

function fmtDate(d) { return d.toISOString().slice(0,10); }

function poissonRandom(lambda) {
  if (lambda <= 0) return 0;
  const L = Math.exp(-Math.min(lambda, 30));
  let k=0, p=1;
  do { k++; p*=Math.random(); } while (p > L);
  return k-1;
}

function monteCarlo(lH, lA) {
  let hw=0, dr=0, aw=0, btts=0, csH=0, csA=0;
  const g=[0,0,0,0,0,0];
  const lines={};
  for (let i=0; i<MC_N; i++) {
    const hg=poissonRandom(lH), ag=poissonRandom(lA);
    if (hg>ag) hw++; else if (hg<ag) aw++; else dr++;
    const t=hg+ag;
    for (let l=0;l<6;l++) if (t>l+.5) g[l]++;
    if (hg>0&&ag>0) btts++;
    if (ag===0) csH++;
    if (hg===0) csA++;
    const key=`${Math.min(hg,6)}-${Math.min(ag,6)}`;
    lines[key]=(lines[key]||0)+1;
  }
  const p=v=>Math.round(v/MC_N*1000)/10;
  const top5=Object.entries(lines).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([s,c])=>({score:s,prob:p(c)}));
  return {
    homeWin:p(hw), draw:p(dr), awayWin:p(aw),
    over05:p(g[0]), over15:p(g[1]), over25:p(g[2]), over35:p(g[3]), over45:p(g[4]), over55:p(g[5]),
    under15:p(MC_N-g[1]), under25:p(MC_N-g[2]), under35:p(MC_N-g[3]),
    btts:p(btts), noBtts:p(MC_N-btts), csHome:p(csH), csAway:p(csA), top5,
    lambdaH:Math.round(lH*100)/100, lambdaA:Math.round(lA*100)/100,
  };
}

function mapFixture(item) {
  return {
    id: item.fixture.id, league: item.league?.name||null, leagueId: item.league?.id||null,
    leagueCountry: item.league?.country||null, leagueLogo: item.league?.logo||null,
    startingAt: item.fixture.date, statusShort: item.fixture.status?.short||null,
    elapsed: item.fixture.status?.elapsed||null,
    home: item.teams.home.name, away: item.teams.away.name,
    homeId: item.teams.home.id, awayId: item.teams.away.id,
    homeLogo: item.teams.home.logo, awayLogo: item.teams.away.logo,
    homeGoals: item.goals?.home??null, awayGoals: item.goals?.away??null,
  };
}

async function handleFixtures(qs) {
  if (qs.scope==='live') {
    const j=await apiGet('/fixtures',{live:'all'});
    return {fixtures:(j.response||[]).map(mapFixture)};
  }
  const date=qs.date||fmtDate(new Date());
  const j=await apiGet('/fixtures',{date});
  return {fixtures:(j.response||[]).map(mapFixture)};
}

function extractStat(resp, teamId, name) {
  const block=(resp.response||[]).find(b=>b.team.id===teamId);
  if (!block) return null;
  const e=block.statistics.find(s=>s.type===name);
  if (!e||e.value==null) return null;
  const v=typeof e.value==='string'?parseFloat(e.value):e.value;
  return isNaN(v)?null:v;
}

async function teamStats(teamId) {
  const fj=await apiGet('/fixtures',{team:teamId,last:MAX_MATCHES,status:'FT'});
  const fixtures=fj.response||[];
  const mk=Object.keys(STAT_NAMES);
  const pools={ all:{}, last3:{} };
  for (const pool of Object.values(pools)) { for (const k of mk) pool[k]=[]; pool.gf=[]; pool.ga=[]; }
  let wins=0,draws=0,losses=0,cleanSheets=0,failedToScore=0;
  let homeWins=0,homePlayed=0,awayWins=0,awayPlayed=0;
  const homeGF=[],homeGA=[],awayGF=[],awayGA=[];

  for (let idx=0;idx<fixtures.length;idx++) {
    const fx=fixtures[idx];
    const isHome=fx.teams.home.id===teamId;
    const gf=isHome?(fx.goals.home??0):(fx.goals.away??0);
    const ga=isHome?(fx.goals.away??0):(fx.goals.home??0);
    const isRecent=idx<3;
    pools.all.gf.push(gf); pools.all.ga.push(ga);
    if (isRecent) { pools.last3.gf.push(gf); pools.last3.ga.push(ga); }
    if (isHome) { homeGF.push(gf); homeGA.push(ga); homePlayed++; if(gf>ga) homeWins++; }
    else { awayGF.push(gf); awayGA.push(ga); awayPlayed++; if(gf>ga) awayWins++; }
    if (gf>ga) wins++; else if (gf===ga) draws++; else losses++;
    if (ga===0) cleanSheets++;
    if (gf===0) failedToScore++;
    try {
      const sj=await apiGet('/fixtures/statistics',{fixture:fx.fixture.id});
      const push=(k,val)=>{ if(val!==null){ pools.all[k].push(val); if(isRecent) pools.last3[k].push(val); } };
      push('shots_total',extractStat(sj,teamId,'Total Shots'));
      push('shots_on_target',extractStat(sj,teamId,'Shots on Goal'));
      push('shots_off_target',extractStat(sj,teamId,'Shots off Goal'));
      push('corners',extractStat(sj,teamId,'Corner Kicks'));
      push('fouls',extractStat(sj,teamId,'Fouls'));
      push('offsides',extractStat(sj,teamId,'Offsides'));
      push('passes',extractStat(sj,teamId,'Total passes'));
      push('goalkeeper_saves',extractStat(sj,teamId,'Goalkeeper Saves'));
      push('tackles',extractStat(sj,teamId,'Total tackles'));
      const y=extractStat(sj,teamId,'Yellow Cards');
      const r=extractStat(sj,teamId,'Red Cards');
      push('yellow_cards',y);
      const c=(y||0)+(r||0);
      if(y!==null||r!==null){ pools.all.cards.push(c); if(isRecent) pools.last3.cards.push(c); }
    } catch(_) {}
  }

  const mean=arr=>arr.length?arr.reduce((a,b)=>a+b,0)/arr.length:null;
  const wavg=k=>{
    const a3=mean(pools.last3[k]), ag=mean(pools.all[k]);
    if (a3!=null&&ag!=null) return a3*.6+ag*.4;
    return ag??a3??GENERIC[k]??null;
  };
  const averages={}, isReal={};
  for (const k of mk) { averages[k]=wavg(k)??GENERIC[k]; isReal[k]=(pools.all[k]?.length||0)>=2; }
  averages.goalsFor=wavg('gf')??1.3;
  averages.goalsAgainst=wavg('ga')??1.3;

  return {
    averages, isReal, matchesAnalyzed:fixtures.length,
    form:{wins,draws,losses,played:fixtures.length,winRate:fixtures.length?wins/fixtures.length:0},
    homeForm:{wins:homeWins,played:homePlayed,winRate:homePlayed?homeWins/homePlayed:0,goalsFor:mean(homeGF)??1.3,goalsAgainst:mean(homeGA)??1.3},
    awayForm:{wins:awayWins,played:awayPlayed,winRate:awayPlayed?awayWins/awayPlayed:0,goalsFor:mean(awayGF)??1.3,goalsAgainst:mean(awayGA)??1.3},
    cleanSheets, failedToScore,
    avgGoalsFor:averages.goalsFor, avgGoalsAgainst:averages.goalsAgainst,
  };
}

function calcLambda(attacker, defender, isHome) {
  const LG=1.35;
  const attGF=isHome?attacker.homeForm.goalsFor:attacker.awayForm.goalsFor;
  const defGA=isHome?defender.homeForm.goalsAgainst:defender.awayForm.goalsAgainst;
  const attStr=(attGF||attacker.avgGoalsFor)/LG;
  const defStr=(defGA||defender.avgGoalsAgainst)/LG;
  const base=attStr*defStr*LG;
  const adj=isHome?base*1.1:base*0.9;
  return Math.max(0.3,Math.min(adj,5));
}

function roundLine(p){ const f=Math.floor(p); return p-f>=.5?f+.5:f-.5; }

function buildMarkets(hS, aS) {
  return Object.entries(STAT_NAMES).map(([key,label])=>{
    const h=hS.averages[key]??GENERIC[key], a=aS.averages[key]??GENERIC[key];
    const pred=Math.round((h+a)*10)/10;
    const line=roundLine(pred);
    const isEst=!hS.isReal[key]||!aS.isReal[key];
    const diff=pred-line;
    const op=Math.min(95,Math.max(25,Math.round(50+(diff/Math.max(1,pred))*70)));
    return { marketKey:key, marketLabel:label, predictedTotal:pred,
      homeAvg:Math.round(h*10)/10, awayAvg:Math.round(a*10)/10,
      suggestedLine:line, overProb:op, underProb:100-op,
      isEstimate:isEst, bestSide:op>=50?'over':'under', bestProb:Math.max(op,100-op) };
  });
}

function genFactors(hS,aS,mc,hName,aName) {
  const factors=[];
  const pct=v=>Math.round(v*100);
  const rnd=v=>Math.round(v*10)/10;
  if(hS.matchesAnalyzed>=3) factors.push({icon:'📊',text:`${hName} venceu ${pct(hS.form.winRate)}% dos últimos ${hS.matchesAnalyzed} jogos`});
  if(aS.matchesAnalyzed>=3) factors.push({icon:'📊',text:`${aName} venceu ${pct(aS.form.winRate)}% dos últimos ${aS.matchesAnalyzed} jogos`});
  if(hS.homeForm.played>=2) factors.push({icon:hS.homeForm.winRate>=.5?'🟢':'🔴',text:`${hName}: ${hS.homeForm.wins}/${hS.homeForm.played} vitórias em casa`});
  if(aS.awayForm.played>=2) factors.push({icon:aS.awayForm.winRate>=.4?'🟢':'🔴',text:`${aName}: ${aS.awayForm.wins}/${aS.awayForm.played} vitórias fora`});
  factors.push({icon:'⚽',text:`${hName} marca ${rnd(hS.avgGoalsFor)} gol(s)/jogo e sofre ${rnd(hS.avgGoalsAgainst)}`});
  factors.push({icon:'⚽',text:`${aName} marca ${rnd(aS.avgGoalsFor)} gol(s)/jogo e sofre ${rnd(aS.avgGoalsAgainst)}`});
  if(hS.cleanSheets>0) factors.push({icon:'🔒',text:`${hName} manteve ${hS.cleanSheets} clean sheet(s) nos últimos ${hS.matchesAnalyzed} jogos`});
  if(aS.failedToScore>0) factors.push({icon:'⚠️',text:`${aName} não marcou em ${aS.failedToScore}/${aS.matchesAnalyzed} jogos recentes`});
  if(mc.homeWin>50) factors.push({icon:'📈',text:`Monte Carlo 10k: mandante favorito com ${mc.homeWin}% de chance de vitória`});
  else if(mc.awayWin>50) factors.push({icon:'📈',text:`Monte Carlo 10k: visitante favorito com ${mc.awayWin}% de chance de vitória`});
  else factors.push({icon:'⚖️',text:`Jogo equilibrado — empate tem ${mc.draw}% de probabilidade (Monte Carlo 10k)`});
  if(mc.btts>60) factors.push({icon:'⚽',text:`Ambas marcam: ${mc.btts}% de probabilidade (Poisson)`});
  if(mc.over25>60) factors.push({icon:'📈',text:`Over 2.5 gols favorecido: ${mc.over25}% (Poisson + Monte Carlo)`});
  else if(mc.under25>60) factors.push({icon:'📉',text:`Under 2.5 gols favorecido: ${mc.under25}% (Poisson + Monte Carlo)`});
  return factors.slice(0,8);
}

function findBestBet(markets,mc,hS,aS,hName,aName) {
  const cands=[
    {market:`Vitória ${hName}`,prob:mc.homeWin,isEst:hS.matchesAnalyzed<3,cat:'1X2'},
    {market:'Empate',prob:mc.draw,isEst:hS.matchesAnalyzed<3,cat:'1X2'},
    {market:`Vitória ${aName}`,prob:mc.awayWin,isEst:aS.matchesAnalyzed<3,cat:'1X2'},
    {market:'Over 2.5 gols',prob:mc.over25,isEst:false,cat:'Gols'},
    {market:'Under 2.5 gols',prob:mc.under25,isEst:false,cat:'Gols'},
    {market:'Ambas marcam — Sim',prob:mc.btts,isEst:false,cat:'BTTS'},
    {market:'Ambas marcam — Não',prob:mc.noBtts,isEst:false,cat:'BTTS'},
    {market:'Over 1.5 gols',prob:mc.over15,isEst:false,cat:'Gols'},
    {market:'Under 3.5 gols',prob:mc.under35,isEst:false,cat:'Gols'},
    ...markets.map(m=>({market:`${m.bestSide==='over'?'Mais':'Menos'} de ${m.suggestedLine} ${m.marketLabel.toLowerCase()}`,prob:m.bestProb,isEst:m.isEstimate,cat:'Estatísticas'})),
  ];
  const best=[...cands].sort((a,b)=>{ if(a.isEst!==b.isEst) return a.isEst?1:-1; return b.prob-a.prob; })[0];
  const confidence=best.prob>=75?'Alta':best.prob>=60?'Média':'Baixa';
  const risk=best.prob>=75?'Baixo':best.prob>=60?'Médio':'Alto';
  const valueBet=!best.isEst&&best.prob>=62;
  return { market:best.market, prob:best.prob, confidence, risk, valueBet, cat:best.cat,
    impliedOdds:Math.round((1/(best.prob/100))*1.08*100)/100,
    justification:`Calculado via Monte Carlo (10.000 simulações) e Distribuição de Poisson. Confiança ${confidence.toLowerCase()} com base em ${Math.min(hS.matchesAnalyzed,aS.matchesAnalyzed)} partidas analisadas por equipe.` };
}

function calcBadges(mc,hS,aS,bestBet) {
  const b=[];
  if (hS.matchesAnalyzed<2||aS.matchesAnalyzed<2) { b.push('insufficient'); return b; }
  if (bestBet.confidence==='Alta') b.push('high-confidence');
  if (bestBet.valueBet) b.push('value-bet');
  if (Math.abs(mc.homeWin-mc.awayWin)<12&&mc.draw>28) b.push('danger');
  return b.length?b:['standard'];
}

async function handlePredict(qs) {
  const homeId=parseInt(qs.home,10), awayId=parseInt(qs.away,10);
  const hName=qs.homeName||'Mandante', aName=qs.awayName||'Visitante';
  if (!homeId||!awayId) throw new Error('Informe "home" e "away".');
  const [hS,aS]=await Promise.all([teamStats(homeId),teamStats(awayId)]);
  const lH=calcLambda(hS,aS,true), lA=calcLambda(aS,hS,false);
  const mc=monteCarlo(lH,lA);
  const markets=buildMarkets(hS,aS);
  const ticket=[...markets].sort((a,b)=>b.bestProb-a.bestProb).map(m=>({
    marketLabel:m.marketLabel, side:m.bestSide, line:m.suggestedLine, prob:m.bestProb,
    label:`${m.bestSide==='over'?'Mais':'Menos'} de ${m.suggestedLine} ${m.marketLabel.toLowerCase()}`,
  }));
  const bestBet=findBestBet(markets,mc,hS,aS,hName,aName);
  const factors=genFactors(hS,aS,mc,hName,aName);
  const badges=calcBadges(mc,hS,aS,bestBet);
  return { homeMatchesAnalyzed:hS.matchesAnalyzed, awayMatchesAnalyzed:aS.matchesAnalyzed, markets, ticket, mc, bestBet, factors, badges };
}

async function handleCompare(qs) {
  const fid=qs.fixture, hId=parseInt(qs.home,10), aId=parseInt(qs.away,10);
  if (!fid||!hId||!aId) throw new Error('Informe "fixture", "home" e "away".');
  const [hS,aS,lj]=await Promise.all([teamStats(hId),teamStats(aId),apiGet('/fixtures/statistics',{fixture:fid})]);
  const markets=Object.entries(STAT_NAMES).map(([key,label])=>{
    const h=hS.averages[key]??GENERIC[key], a=aS.averages[key]??GENERIC[key];
    const pred=Math.round((h+a)*10)/10;
    let actual=null;
    if(key==='cards'){const yH=extractStat(lj,hId,'Yellow Cards'),rH=extractStat(lj,hId,'Red Cards'),yA=extractStat(lj,aId,'Yellow Cards'),rA=extractStat(lj,aId,'Red Cards');actual=(yH!=null||yA!=null)?(yH||0)+(rH||0)+(yA||0)+(rA||0):null;}
    else if(key==='yellow_cards'){const yH=extractStat(lj,hId,'Yellow Cards'),yA=extractStat(lj,aId,'Yellow Cards');actual=(yH!=null||yA!=null)?(yH||0)+(yA||0):null;}
    else if(key==='goals'){actual=null;}
    else if(STAT_API[key]){const vH=extractStat(lj,hId,STAT_API[key]),vA=extractStat(lj,aId,STAT_API[key]);actual=(vH!=null||vA!=null)?(vH||0)+(vA||0):null;}
    return {marketLabel:label,predictedTotal:pred,suggestedLine:roundLine(pred),actual};
  });
  return {markets};
}

exports.handler=async(event)=>{
  const qs=event.queryStringParameters||{};
  try{
    let r;
    if(qs.action==='fixtures') r=await handleFixtures(qs);
    else if(qs.action==='predict') r=await handlePredict(qs);
    else if(qs.action==='compare') r=await handleCompare(qs);
    else return{statusCode:400,body:JSON.stringify({error:'Use ?action=fixtures, predict ou compare.'})};
    return{statusCode:200,headers:{'Content-Type':'application/json'},body:JSON.stringify(r)};
  }catch(err){
    const msg=String(err?.message||err);
    return{statusCode:/RATE_LIMIT/.test(msg)?429:/Informe/.test(msg)?400:500,body:JSON.stringify({error:msg})};
  }
};
