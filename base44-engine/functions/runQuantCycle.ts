import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// ============================================================
// QSX-AOS ONE v1.3 / Quant Omega Engine - Multi-Account
// Duas carteiras virtuais independentes:
//   AGGRESSIVE    - pos 10%, TP 4%, SL 2%, veto dd 10%
//   CONSERVATIVE  - pos 5%,  TP 3%, SL 1.5%, veto dd 6%
// Pipeline por conta: MarketData -> Regime -> Alpha Swarm ->
// Signal -> Gates (regime/swarm) -> RiskGovernor -> Paper
// Execution -> RiskSnapshot. Event Store global append-only
// com hash chain SHA256 (payloads schema 1.1, campo account).
// NENHUMA execucao real - apenas simulacao.
// ============================================================

interface Candle {
  openTime: number; open: number; high: number; low: number;
  close: number; volume: number; closeTime: number;
}

const TIMEFRAME_MS = 15 * 60 * 1000;
const INITIAL_CAPITAL = 100000;
const FEE_PCT = 0.001;

const ACCOUNTS = [
  { name: 'AGGRESSIVE', size_pct: 0.10, tp_pct: 0.04, sl_pct: 0.02, veto_dd_pct: 10 },
  { name: 'CONSERVATIVE', size_pct: 0.05, tp_pct: 0.03, sl_pct: 0.015, veto_dd_pct: 6 },
];
const DEFAULT_ACCOUNT = 'AGGRESSIVE';

// ---------- indicadores ----------
function emaSeries(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function rsiSeries(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  if (values.length < period + 1) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgG = gain / period, avgL = loss / period;
  out[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
    out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return out;
}

function mean(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / (arr.length || 1);
}

// ---------- dados de mercado (Kraken principal, OKX fallback) ----------
function krakenPair(symbol: string): string {
  if (symbol === 'BTCUSDT') return 'XBTUSDT';
  return 'ETHUSDT';
}

function okxInst(symbol: string): string {
  if (symbol === 'BTCUSDT') return 'BTC-USDT';
  if (symbol === 'ETHUSDT') return 'ETH-USDT';
  return symbol.replace('USDT', '-USDT');
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

async function fetchKraken(symbol: string, interval: string, limit: number): Promise<Candle[]> {
  const intervalMin = interval === '15m' ? 15 : 60;
  const pair = krakenPair(symbol);
  const url = `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${intervalMin}`;
  const r = await fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'quant-omega/1.0' } });
  if (!r.ok) throw new Error(`Kraken API ${r.status} para ${pair}`);
  const j = await r.json();
  if (j.error && j.error.length) throw new Error(`Kraken erro: ${j.error[0]}`);
  const key = j.result ? Object.keys(j.result).find(k => k !== 'last') : null;
  if (!key || !Array.isArray(j.result[key])) throw new Error(`Kraken sem serie para ${pair}`);
  const nowSec = Date.now() / 1000;
  const out: Candle[] = [];
  for (const k of j.result[key]) {
    const t = Number(k[0]);
    if (t + intervalMin * 60 > nowSec) continue; // candle em formacao
    out.push({
      openTime: t * 1000, open: +k[1], high: +k[2], low: +k[3],
      close: +k[4], volume: +k[6], closeTime: (t + intervalMin * 60) * 1000,
    });
  }
  if (out.length < limit) throw new Error(`Kraken insuficiente (${out.length} candles)`);
  return out.slice(-limit);
}

async function okxGet(url: string, tries = 3): Promise<any> {
  let lastErr = '';
  for (let t = 0; t < tries; t++) {
    const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (r.ok) return await r.json();
    lastErr = String(r.status);
    if (r.status === 429) { await sleep(800 * (t + 1)); continue; }
    throw new Error(`OKX API ${r.status}`);
  }
  throw new Error(`OKX API ${lastErr} (rate limit)`);
}

async function fetchOkx(symbol: string, interval: string, limit: number): Promise<Candle[]> {
  const instId = okxInst(symbol);
  const bar = interval;
  let url = `https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=100`;
  const j = await okxGet(url);
  if (j.code !== '0' || !Array.isArray(j.data)) throw new Error(`OKX erro para ${instId}: ${j.msg || 'sem dados'}`);
  const out: Candle[] = [];
  for (const k of j.data) {
    if (String(k[8]) === '0') continue;
    out.push({
      openTime: Number(k[0]), open: +k[1], high: +k[2], low: +k[3],
      close: +k[4], volume: +k[5], closeTime: Number(k[0]) + TIMEFRAME_MS,
    });
  }
  out.reverse();
  return out.slice(-limit);
}

async function fetchKlines(symbol: string, interval: string, limit: number): Promise<Candle[]> {
  try {
    return await fetchKraken(symbol, interval, limit);
  } catch (e) {
    return await fetchOkx(symbol, interval, limit);
  }
}

// ---------- acesso a entidades ----------
function ents(db: any) { return db.entities; }

async function listRecords(db: any, name: string): Promise<any[]> {
  const e = ents(db)[name];
  let res: any;
  try { res = await e.list(); } catch (_) { try { res = await e.list({ limit: 500 }); } catch (__) { res = null; } }
  if (Array.isArray(res)) return res;
  if (res && Array.isArray(res.items)) return res.items;
  if (res && Array.isArray(res.records)) return res.records;
  if (res && Array.isArray(res.data)) return res.data;
  if (res && res.result && Array.isArray(res.result)) return res.result;
  return [];
}

async function createRecord(db: any, name: string, data: any): Promise<any> {
  return await ents(db)[name].create(data);
}

async function updateRecord(db: any, name: string, id: string, data: any): Promise<any> {
  return await ents(db)[name].update(id, data);
}

function acctOf(rec: any): string { return rec && rec.account ? String(rec.account) : DEFAULT_ACCOUNT; }

// ---------- event store com hash chain (G1, schema 1.1) ----------
interface ChainCtx { lastHash: string; lastEventId: string; corrId: string; }

async function sha256Hex(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function initChain(db: any): Promise<ChainCtx> {
  const corrId = crypto.randomUUID();
  try {
    // cabeca global: qualquer PortfolioState com chain_head_hash serve
    const ps = await listRecords(db, 'PortfolioState');
    const withHead = ps.filter((p: any) => p.chain_head_hash);
    if (withHead.length) {
      withHead.sort((a: any, b: any) => String(b.updated_date || '').localeCompare(String(a.updated_date || '')));
      return { lastHash: String(withHead[0].chain_head_hash), lastEventId: String(withHead[0].chain_head_event_id || ''), corrId };
    }
    const evts = await listRecords(db, 'AuditEvent');
    const withHash = evts.filter((e: any) => e.event_hash);
    if (!withHash.length) return { lastHash: '', lastEventId: '', corrId };
    withHash.sort((a: any, b: any) =>
      (a.timestamp || 0) - (b.timestamp || 0) || String(a.created_date || '').localeCompare(String(b.created_date || '')));
    const last = withHash[withHash.length - 1];
    return { lastHash: String(last.event_hash), lastEventId: String(last.event_id || ''), corrId };
  } catch (_) { return { lastHash: '', lastEventId: '', corrId }; }
}

async function audit(db: any, chain: ChainCtx, action: string, objectType: string, objectId: string, details: string, payloadObj?: any) {
  try {
    const eventId = 'evt_' + crypto.randomUUID();
    const ts = Date.now();
    const payloadJson = payloadObj === undefined ? '' : JSON.stringify(payloadObj);
    const payload = JSON.stringify({ object_type: objectType, object_id: objectId, details, payload_json: payloadJson });
    const prevHash = chain.lastHash || 'GENESIS';
    const causationId = chain.lastEventId || 'GENESIS';
    const eventHash = await sha256Hex(eventId + '|' + action + '|' + ts + '|' + chain.corrId + '|' + causationId + '|' + payload + '|' + prevHash);
    await createRecord(db, 'AuditEvent', {
      actor: 'quant_engine_v1', action, event_type: action,
      object_type: objectType, object_id: objectId, details, timestamp: ts,
      event_id: eventId, correlation_id: chain.corrId, causation_id: causationId,
      schema_version: '1.1', previous_hash: prevHash, event_hash: eventHash,
      payload_json: payloadJson,
    });
    chain.lastHash = eventHash;
    chain.lastEventId = eventId;
  } catch (e) { /* auditoria nunca quebra o ciclo */ }
}

// ---------- Regime Engine (BULL/BEAR/RANGE) ----------
interface RegimeInfo { regime: 'BULL' | 'BEAR' | 'RANGE'; strength: number; slope_pct: number; rationale: string; }

function detectRegime(candles: Candle[]): RegimeInfo {
  const n = candles.length;
  const closes = candles.map(c => c.close);
  const e21 = emaSeries(closes, 21);
  const price = closes[n - 1];
  const emaNow = e21[n - 1];
  const emaBefore = e21[Math.max(0, n - 22)];
  if (!isFinite(emaNow) || !isFinite(emaBefore) || !emaBefore) {
    return { regime: 'RANGE', strength: 0, slope_pct: 0, rationale: 'dados insuficientes' };
  }
  const slopePct = (emaNow - emaBefore) / emaBefore * 100;
  const above = price > emaNow;
  let regime: 'BULL' | 'BEAR' | 'RANGE' = 'RANGE';
  if (slopePct >= 0.25 && above) regime = 'BULL';
  else if (slopePct <= -0.25 && !above) regime = 'BEAR';
  else regime = 'RANGE';
  const strength = regime === 'RANGE'
    ? Math.max(0, 100 - Math.abs(slopePct) * 80)
    : Math.min(100, 50 + Math.abs(slopePct) * 30);
  return {
    regime, strength: Math.round(strength), slope_pct: +slopePct.toFixed(2),
    rationale: `EMA21 slope ${slopePct.toFixed(2)}% em 21 candles; preco ${above ? 'acima' : 'abaixo'} da EMA21`,
  };
}

function regimeAllowed(strategyCode: string, regime: string): boolean {
  if (strategyCode === 'TREND_HUNTER') return regime !== 'RANGE';
  if (strategyCode === 'MEAN_REVERSION_GUARD') return regime === 'RANGE';
  return true;
}

// ---------- Alpha Registry + AI Swarm ----------
interface AlphaView { model: string; view: 'LONG' | 'SHORT' | 'NEUTRAL'; confidence: number; }
interface SwarmResult { view: 'LONG' | 'SHORT' | 'NEUTRAL'; confidence: number; score: number; volFactor: number; }

function alphaViews(candles: Candle[]): { views: AlphaView[]; volFactor: number } {
  const n = candles.length;
  const closes = candles.map(c => c.close);
  const e9 = emaSeries(closes, 9), e21 = emaSeries(closes, 21), rsi = rsiSeries(closes, 14);
  const price = closes[n - 1];
  const views: AlphaView[] = [];

  if (isFinite(e9[n - 1]) && isFinite(e21[n - 1])) {
    const diff = e9[n - 1] - e21[n - 1];
    views.push({
      model: 'ALPHA_TREND',
      view: diff > 0 ? 'LONG' : 'SHORT',
      confidence: Math.min(100, Math.abs(diff) / price * 4000 + 20),
    });
  }
  if (isFinite(rsi[n - 1])) {
    const r = rsi[n - 1];
    let view: 'LONG' | 'SHORT' | 'NEUTRAL' = 'NEUTRAL';
    if (r < 35) view = 'LONG'; else if (r > 65) view = 'SHORT';
    views.push({ model: 'ALPHA_REVERSION', view, confidence: Math.min(100, Math.abs(r - 50) * 2.4) });
  }
  const win = candles.slice(n - 20);
  const maxH = Math.max(...win.map(c => c.high)), minL = Math.min(...win.map(c => c.low));
  const pos = maxH > minL ? (price - minL) / (maxH - minL) : 0.5;
  let bView: 'LONG' | 'SHORT' | 'NEUTRAL' = 'NEUTRAL';
  if (pos > 0.7) bView = 'LONG'; else if (pos < 0.3) bView = 'SHORT';
  views.push({ model: 'ALPHA_BREAKOUT', view: bView, confidence: Math.min(100, Math.abs(pos - 0.5) * 200) });

  const trPct = mean(candles.slice(n - 14).map(c => (c.high - c.low) / c.close * 100));
  const volFactor = Math.max(0.5, Math.min(1, trPct / 0.35));
  views.push({ model: 'ALPHA_VOLATILITY', view: 'NEUTRAL', confidence: Math.min(100, trPct * 200) });

  return { views, volFactor };
}

function swarmConsensus(views: AlphaView[], weights: Record<string, number>, activeModels: Set<string>, volFactor: number): SwarmResult {
  let num = 0, den = 0;
  for (const v of views) {
    if (v.view === 'NEUTRAL') continue;
    if (!activeModels.has(v.model)) continue;
    const w = weights[v.model] ?? 0.25;
    num += w * (v.view === 'LONG' ? 1 : -1) * v.confidence;
    den += w * 100;
  }
  let score = den > 0 ? num / den : 0;
  score *= volFactor;
  const view = score > 0.25 ? 'LONG' : score < -0.25 ? 'SHORT' : 'NEUTRAL';
  const confidence = Math.min(100, Math.abs(score) * 100);
  return { view, confidence, score: +score.toFixed(3), volFactor };
}

// ---------- geracao de sinais ----------
interface SignalDraft {
  strategy_code: string; strategy_name: string; symbol: string; direction: 'LONG' | 'SHORT';
  score: number; rationale: string; candle_time: number;
}

function generateSignalForStrategy(strategy: any, candles: Candle[]): SignalDraft | null {
  const n = candles.length;
  if (n < 25) return null;
  const closes = candles.map(c => c.close);
  const vols = candles.map(c => c.volume);
  const last = candles[n - 1];
  const code = strategy.code;

  if (code === 'TREND_HUNTER') {
    const e9 = emaSeries(closes, 9), e21 = emaSeries(closes, 21);
    if (isNaN(e9[n - 2]) || isNaN(e21[n - 2])) return null;
    const prevDiff = e9[n - 2] - e21[n - 2];
    const curDiff = e9[n - 1] - e21[n - 1];
    const avgVol = mean(vols.slice(n - 21, n - 1));
    const volOK = last.volume > avgVol;
    if (!volOK) return null;
    if (prevDiff <= 0 && curDiff > 0) {
      const score = Math.min(100, 50 + Math.min(35, (Math.abs(curDiff) / last.close) * 1500) + Math.min(15, (last.volume / avgVol - 1) * 15));
      return { strategy_code: code, strategy_name: strategy.name, symbol: strategy.symbol,
        direction: 'LONG', score: Math.round(score),
        rationale: `EMA9 cruzou acima da EMA21 (diff ${curDiff.toFixed(2)}), volume ${last.volume.toFixed(2)} > media ${avgVol.toFixed(2)}. Tendencia de alta confirmada no fechamento do candle 15m.`,
        candle_time: last.openTime };
    }
    if (prevDiff >= 0 && curDiff < 0) {
      const score = Math.min(100, 50 + Math.min(35, (Math.abs(curDiff) / last.close) * 1500) + Math.min(15, (last.volume / avgVol - 1) * 15));
      return { strategy_code: code, strategy_name: strategy.name, symbol: strategy.symbol,
        direction: 'SHORT', score: Math.round(score),
        rationale: `EMA9 cruzou abaixo da EMA21 (diff ${curDiff.toFixed(2)}), volume ${last.volume.toFixed(2)} > media ${avgVol.toFixed(2)}. Tendencia de baixa confirmada no fechamento do candle 15m.`,
        candle_time: last.openTime };
    }
    return null;
  }

  if (code === 'MEAN_REVERSION_GUARD') {
    const rsi = rsiSeries(closes, 14);
    if (isNaN(rsi[n - 2])) return null;
    const cur = rsi[n - 1], pr = rsi[n - 2];
    if (pr < 30 && cur > pr) {
      const score = Math.min(100, 50 + (30 - pr) * 1.5 + (cur - pr) * 2);
      return { strategy_code: code, strategy_name: strategy.name, symbol: strategy.symbol,
        direction: 'LONG', score: Math.round(score),
        rationale: `RSI saiu de sobrevenda: ${pr.toFixed(1)} -> ${cur.toFixed(1)} (virando para cima abaixo de 30). Reversao de extremo de baixa a favor de compra.`,
        candle_time: last.openTime };
    }
    if (pr > 70 && cur < pr) {
      const score = Math.min(100, 50 + (pr - 70) * 1.5 + (pr - cur) * 2);
      return { strategy_code: code, strategy_name: strategy.name, symbol: strategy.symbol,
        direction: 'SHORT', score: Math.round(score),
        rationale: `RSI saiu de sobrecompra: ${pr.toFixed(1)} -> ${cur.toFixed(1)} (virando para baixo acima de 70). Extremo de alta sendo revertido.`,
        candle_time: last.openTime };
    }
    return null;
  }

  if (code === 'BREAKOUT_SCALPER') {
    const priorHighs = candles.slice(n - 21, n - 1).map(c => c.high);
    const priorLows = candles.slice(n - 21, n - 1).map(c => c.low);
    const maxH = Math.max(...priorHighs), minL = Math.min(...priorLows);
    const avgVol = mean(vols.slice(n - 21, n - 1));
    const volOK = last.volume > avgVol * 1.5;
    if (!volOK) return null;
    if (last.close > maxH) {
      const score = Math.min(100, 50 + Math.min(30, ((last.close - maxH) / maxH) * 3000) + 15);
      return { strategy_code: code, strategy_name: strategy.name, symbol: strategy.symbol,
        direction: 'LONG', score: Math.round(score),
        rationale: `Rompeu maxima de 20 candles (${maxH.toFixed(2)}) fechando em ${last.close.toFixed(2)} com volume ${last.volume.toFixed(2)} > 1.5x media ${avgVol.toFixed(2)}. Breakout de alta.`,
        candle_time: last.openTime };
    }
    if (last.close < minL) {
      const score = Math.min(100, 50 + Math.min(30, ((minL - last.close) / minL) * 3000) + 15);
      return { strategy_code: code, strategy_name: strategy.name, symbol: strategy.symbol,
        direction: 'SHORT', score: Math.round(score),
        rationale: `Rompeu minima de 20 candles (${minL.toFixed(2)}) fechando em ${last.close.toFixed(2)} com volume ${last.volume.toFixed(2)} > 1.5x media ${avgVol.toFixed(2)}. Breakout de baixa.`,
        candle_time: last.openTime };
    }
    return null;
  }
  return null;
}

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const db = (base44 as any).asServiceRole ?? base44;

  try {
    // 1) dados de mercado (compartilhados entre as contas)
    const btc = await fetchKlines('BTCUSDT', '15m', 100);
    await sleep(300);
    const eth = await fetchKlines('ETHUSDT', '15m', 100);
    const btcClosed = btc;
    const ethClosed = eth;
    const prices: Record<string, number> = {
      BTCUSDT: btcClosed[btcClosed.length - 1].close,
      ETHUSDT: ethClosed[ethClosed.length - 1].close,
    };
    const candleTimes: Record<string, number> = {
      BTCUSDT: btcClosed[btcClosed.length - 1].openTime,
      ETHUSDT: ethClosed[ethClosed.length - 1].openTime,
    };

    // 2) cadeia global de eventos
    const chain = await initChain(db);

    // 3) MarketDataReceived - fonte da verdade (G0)
    await audit(db, chain, 'market.data.received', 'MarketData', 'BTCUSDT',
      `BTCUSDT ${prices.BTCUSDT} (fonte kraken/okx, candle 15m fechado)`,
      { symbol: 'BTCUSDT', price: prices.BTCUSDT.toFixed(2), source: 'kraken_okx', timeframe: '15m', candle_time: String(candleTimes.BTCUSDT) });
    await audit(db, chain, 'market.data.received', 'MarketData', 'ETHUSDT',
      `ETHUSDT ${prices.ETHUSDT} (fonte kraken/okx, candle 15m fechado)`,
      { symbol: 'ETHUSDT', price: prices.ETHUSDT.toFixed(2), source: 'kraken_okx', timeframe: '15m', candle_time: String(candleTimes.ETHUSDT) });

    // 3a) Regime Engine
    const regimes: Record<string, RegimeInfo> = {
      BTCUSDT: detectRegime(btcClosed),
      ETHUSDT: detectRegime(ethClosed),
    };
    for (const sym of ['BTCUSDT', 'ETHUSDT']) {
      const r = regimes[sym];
      await audit(db, chain, 'regime.detected', 'MarketData', sym,
        `Regime ${sym}: ${r.regime} (forca ${r.strength}) - ${r.rationale}`,
        { symbol: sym, regime: r.regime, strength: String(r.strength), slope_pct: String(r.slope_pct) });
    }

    // 3b) Alpha Registry + AI Swarm
    const registry = await listRecords(db, 'AlphaModel');
    const defaultWeights: Record<string, number> = {
      ALPHA_TREND: 0.35, ALPHA_REVERSION: 0.30, ALPHA_BREAKOUT: 0.20, ALPHA_VOLATILITY: 0.15,
    };
    const weights: Record<string, number> = {};
    const activeModels = new Set<string>();
    for (const m of registry) {
      weights[m.code] = typeof m.weight === 'number' ? m.weight : (defaultWeights[m.code] ?? 0.25);
      if ((m.status || 'active') === 'active') activeModels.add(m.code);
    }
    const swarms: Record<string, SwarmResult> = {};
    for (const sym of ['BTCUSDT', 'ETHUSDT']) {
      const candles = sym === 'ETHUSDT' ? ethClosed : btcClosed;
      const { views, volFactor } = alphaViews(candles);
      for (const v of views) {
        const voting = activeModels.has(v.model);
        await audit(db, chain, 'alpha.generated', 'AlphaModel', v.model,
          `Alpha ${v.model}: ${v.view} ${sym} conf ${v.confidence.toFixed(0)}% (${voting ? 'votante' : 'shadow'})`,
          { model: v.model, symbol: sym, view: v.view, confidence: v.confidence.toFixed(1),
            weight: String(weights[v.model] ?? defaultWeights[v.model] ?? 0.25), voting: voting ? 'true' : 'false' });
      }
      const c = swarmConsensus(views, weights, activeModels, volFactor);
      swarms[sym] = c;
      await audit(db, chain, 'swarm.consensus', 'AlphaSwarm', sym,
        `Consenso swarm ${sym}: ${c.view} ${c.confidence.toFixed(0)}% (score ${c.score}, vol ${c.volFactor.toFixed(2)})`,
        { symbol: sym, view: c.view, confidence: c.confidence.toFixed(1),
          score: String(c.score), vol_factor: c.volFactor.toFixed(2) });
    }

    // 4) listas globais (filtradas por conta no loop)
    const strategyAll = await listRecords(db, 'Strategy');
    const signalAll = await listRecords(db, 'Signal');
    const positionAll = await listRecords(db, 'PaperPosition');
    const psAll = await listRecords(db, 'PortfolioState');
    const alertAll = await listRecords(db, 'Alert');

    const now = Date.now();
    const fix = (v: any, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);

    const summaries: Record<string, any> = {};
    const newSignalsAll: any[] = [];
    let totalOrders = 0, totalAlerts = 0;
    const portfoliosTouched: any[] = [];

    // ================== LOOP POR CONTA ==================
    for (const acct of ACCOUNTS) {
      const an = acct.name;

      let portfolio = psAll.find(p => acctOf(p) === an) || null;
      if (!portfolio) {
        portfolio = await createRecord(db, 'PortfolioState', {
          account: an, capital: INITIAL_CAPITAL, realized_pnl: 0, unrealized_pnl: 0, peak_equity: INITIAL_CAPITAL,
        });
      }
      portfoliosTouched.push(portfolio);

      const strategies = strategyAll.filter(s => acctOf(s) === an);
      const positionsAcct = positionAll.filter(p => acctOf(p) === an);
      const signalsAcct = signalAll.filter(s => acctOf(s) === an);

      // dedup: ultimo sinal por estrategia+conta
      const lastByStrategy: Record<string, any> = {};
      for (const s of signalsAcct) {
        const key = `${s.strategy_code}#${an}`;
        if (!lastByStrategy[key] || (s.timestamp || 0) > (lastByStrategy[key].timestamp || 0)) lastByStrategy[key] = s;
      }

      // sinais
      const newSignals: any[] = [];
      const executedSignals: any[] = [];

      for (const strat of strategies) {
        if (strat.status === 'paused') continue;
        const candles = strat.symbol === 'ETHUSDT' ? ethClosed : btcClosed;
        const draft = generateSignalForStrategy(strat, candles);
        if (!draft) continue;

        const lastSig = lastByStrategy[`${strat.code}#${an}`];
        if (lastSig && lastSig.direction === draft.direction &&
            draft.candle_time - (lastSig.timestamp || 0) < 3 * TIMEFRAME_MS) continue;

        const created = await createRecord(db, 'Signal', {
          account: an,
          strategy_id: strat.id, strategy_code: strat.code, strategy_name: strat.name,
          symbol: draft.symbol, timeframe: strat.timeframe || '15m',
          timestamp: draft.candle_time, direction: draft.direction,
          score: draft.score, rationale: draft.rationale,
          status: strat.status === 'active' ? 'generated' : 'expired',
          ai_explanation: `Regime ${regimes[draft.symbol].regime} | Swarm ${swarms[draft.symbol].view} ${swarms[draft.symbol].confidence.toFixed(0)}%`,
        });
        newSignals.push(created);
        newSignalsAll.push({ account: an, strategy: strat.code, direction: draft.direction,
          symbol: draft.symbol, score: draft.score, status: created.status });
        await audit(db, chain, 'signal.generated', 'Signal', created.id,
          `[${an}] ${strat.code} ${draft.direction} ${draft.symbol} score ${draft.score} (modo ${strat.status})`,
          { account: an, strategy_code: strat.code, direction: draft.direction, symbol: draft.symbol,
            score: draft.score, mode: strat.status, candle_time: String(draft.candle_time), signal_id: created.id });

        if (strat.status === 'active') executedSignals.push({ signal: created, draft, strategy: strat });
      }

      // saidas TP/SL
      const orders: any[] = [];
      let realizedDelta = 0;
      const remaining: any[] = [];

      for (const pos of positionsAcct) {
        const qty = fix(pos.quantity);
        if (Math.abs(qty) < 1e-10) continue;
        const mark = prices[pos.symbol];
        if (mark === undefined) { remaining.push(pos); continue; }

        const pnlPct = ((mark - fix(pos.average_price)) / fix(pos.average_price)) * (qty > 0 ? 1 : -1) * 100;
        const isTP = pnlPct >= acct.tp_pct * 100;
        const isSL = pnlPct <= -acct.sl_pct * 100;

        if (isTP || isSL) {
          const grossPnl = (mark - fix(pos.average_price)) * qty;
          const fee = Math.abs(qty) * mark * FEE_PCT;
          const netPnl = grossPnl - fee;
          realizedDelta += netPnl;
          const side = qty > 0 ? 'SELL' : 'BUY';
          const reason = isTP ? 'take_profit' : 'stop_loss';
          const order = await createRecord(db, 'PaperOrder', {
            signal_id: '', symbol: pos.symbol, side: side as any, order_type: 'market',
            quantity: Math.abs(qty), price: mark, status: 'filled',
            reason,
          });
          orders.push(order);
          await audit(db, chain, isTP ? 'position.closed_tp' : 'position.closed_sl', 'PaperPosition', pos.id,
            `[${an}] ${pos.symbol} fechada em ${mark.toFixed(2)} com P&L ${netPnl.toFixed(2)} USDT (${pnlPct.toFixed(2)}%)`,
            { account: an, symbol: pos.symbol, price: mark.toFixed(2), pnl: netPnl.toFixed(2),
              pnl_pct: pnlPct.toFixed(2), quantity: qty.toFixed(8), reason, order_id: order.id });
        } else {
          remaining.push(pos);
        }
      }

      // entradas: gates + risk governor + execucao
      const openRulesNow = new Set(alertAll
        .filter(a => (a.status || 'open') !== 'acknowledged' && acctOf(a) === an)
        .map(a => a.rule));

      for (const { signal, draft, strategy } of executedSignals) {
        const mark = prices[draft.symbol];
        if (mark === undefined) continue;
        const openPositions = remaining.filter(p => p.symbol === draft.symbol && Math.abs(fix(p.quantity)) > 1e-10);
        const targetQty = ((fix(portfolio.capital, INITIAL_CAPITAL) * acct.size_pct) / mark) *
          (draft.direction === 'LONG' ? 1 : -1);

        // Regime gate
        const regime = regimes[draft.symbol] || { regime: 'RANGE', strength: 0, slope_pct: 0, rationale: '' };
        if (!regimeAllowed(strategy.code, regime.regime)) {
          await updateRecord(db, 'Signal', signal.id, { status: 'regime_filtered' });
          await audit(db, chain, 'regime.filtered', 'Signal', signal.id,
            `[${an}] Sinal ${strategy.code} ${draft.direction} ${draft.symbol} filtrado: regime ${regime.regime} incompativel`,
            { account: an, strategy_code: strategy.code, direction: draft.direction, symbol: draft.symbol,
              regime: regime.regime, regime_strength: String(regime.strength), signal_id: signal.id });
          continue;
        }

        // Swarm gate
        const swarm = swarms[draft.symbol] || { view: 'NEUTRAL', confidence: 0, score: 0, volFactor: 1 };
        if (swarm.view !== 'NEUTRAL' && swarm.view !== draft.direction && swarm.confidence > 40) {
          await updateRecord(db, 'Signal', signal.id, { status: 'swarm_filtered' });
          await audit(db, chain, 'swarm.filtered', 'Signal', signal.id,
            `[${an}] Sinal ${strategy.code} ${draft.direction} ${draft.symbol} filtrado: swarm ${swarm.view} ${swarm.confidence.toFixed(0)}% contrario`,
            { account: an, strategy_code: strategy.code, direction: draft.direction, symbol: draft.symbol,
              swarm_view: swarm.view, swarm_confidence: swarm.confidence.toFixed(1), signal_id: signal.id });
          continue;
        }

        // RiskGovernor
        let preUnrealized = 0;
        for (const p of remaining) {
          const q = fix(p.quantity);
          if (Math.abs(q) < 1e-10) continue;
          const mk = prices[p.symbol] ?? fix(p.mark_price);
          preUnrealized += (mk - fix(p.average_price)) * q;
        }
        const equityNow = fix(portfolio.capital, INITIAL_CAPITAL) + fix(portfolio.realized_pnl) + realizedDelta + preUnrealized;
        const peakNow = Math.max(fix(portfolio.peak_equity, INITIAL_CAPITAL), equityNow);
        const ddNow = peakNow > 0 ? ((peakNow - equityNow) / peakNow) * 100 : 0;

        if (ddNow > acct.veto_dd_pct) {
          await audit(db, chain, 'risk.vetoed', 'Signal', signal.id,
            `[${an}] Entrada ${draft.direction} ${draft.symbol} VETADA: drawdown ${ddNow.toFixed(2)}% > limite ${acct.veto_dd_pct}%`,
            { account: an, symbol: draft.symbol, direction: draft.direction, reason: 'drawdown_breaker',
              drawdown_pct: ddNow.toFixed(2), limit_pct: acct.veto_dd_pct, signal_id: signal.id });
          if (!openRulesNow.has('risk_veto_drawdown')) {
            openRulesNow.add('risk_veto_drawdown');
            await createRecord(db, 'Alert', {
              account: an, severity: 'warning', rule: 'risk_veto_drawdown', status: 'open',
              message: `[${an}] Risk Governor vetou entradas: drawdown ${ddNow.toFixed(1)}% acima do breaker de ${acct.veto_dd_pct}%.`,
            });
            totalAlerts++;
          }
          continue;
        }

        await audit(db, chain, 'risk.approved', 'Signal', signal.id,
          `[${an}] Entrada ${draft.direction} ${draft.symbol} aprovada (within_limits): drawdown ${ddNow.toFixed(2)}%, tamanho ${(acct.size_pct * 100).toFixed(0)}% do capital`,
          { account: an, symbol: draft.symbol, direction: draft.direction, reason: 'within_limits',
            drawdown_pct: ddNow.toFixed(2), size_pct: acct.size_pct, signal_id: signal.id });

        // fecha posicao contraria
        for (const pos of openPositions) {
          const qty = fix(pos.quantity);
          if ((qty > 0 && targetQty > 0) || (qty < 0 && targetQty < 0)) continue;
          const grossPnl = (mark - fix(pos.average_price)) * qty;
          const fee = Math.abs(qty) * mark * FEE_PCT;
          const netPnl = grossPnl - fee;
          realizedDelta += netPnl;
          const order = await createRecord(db, 'PaperOrder', {
            signal_id: signal.id, symbol: pos.symbol, side: (qty > 0 ? 'SELL' : 'BUY') as any,
            order_type: 'market', quantity: Math.abs(qty), price: mark, status: 'filled',
            reason: 'signal_reversal',
          });
          orders.push(order);
          const idx = remaining.indexOf(pos);
          if (idx >= 0) remaining.splice(idx, 1);
          await audit(db, chain, 'position.closed_reversal', 'PaperPosition', pos.id,
            `[${an}] ${pos.symbol} fechada por sinal contrario (${strategy.code} ${draft.direction})`,
            { account: an, symbol: pos.symbol, price: mark.toFixed(2), pnl: netPnl.toFixed(2),
              quantity: qty.toFixed(8), reason: 'signal_reversal', order_id: order.id, signal_id: signal.id });
          await updateRecord(db, 'PaperPosition', pos.id, { quantity: 0, mark_price: mark, unrealized_pnl: 0 });
        }

        // abre/adiciona posicao
        const same = remaining.find(p => p.symbol === draft.symbol &&
          ((fix(p.quantity) > 0 && targetQty > 0) || (fix(p.quantity) < 0 && targetQty < 0)));
        if (same) {
          const q = fix(same.quantity);
          const newAvg = (fix(same.average_price) * Math.abs(q) + mark * Math.abs(targetQty)) /
            (Math.abs(q) + Math.abs(targetQty));
          const newQty = q + targetQty;
          await updateRecord(db, 'PaperPosition', same.id, { average_price: newAvg, quantity: newQty, mark_price: mark });
        } else {
          const pos = await createRecord(db, 'PaperPosition', {
            account: an, symbol: draft.symbol, quantity: targetQty, average_price: mark, mark_price: mark,
            realized_pnl: 0, unrealized_pnl: 0, strategy_code: strategy.code,
          });
          remaining.push(pos);
        }

        const order = await createRecord(db, 'PaperOrder', {
          signal_id: signal.id, symbol: draft.symbol,
          side: (targetQty > 0 ? 'BUY' : 'SELL') as any, order_type: 'market',
          quantity: Math.abs(targetQty), price: mark, status: 'filled', reason: 'entry',
        });
        orders.push(order);
        await updateRecord(db, 'Signal', signal.id, { status: 'executed' });
        await audit(db, chain, 'order.simulated', 'PaperOrder', order.id,
          `[${an}] Entrada ${draft.direction} ${draft.symbol} qty ${Math.abs(targetQty).toFixed(6)} @ ${mark.toFixed(2)} via ${strategy.code}`,
          { account: an, symbol: draft.symbol, side: targetQty > 0 ? 'BUY' : 'SELL',
            quantity: Math.abs(targetQty).toFixed(8), price: mark.toFixed(2),
            reason: 'entry', strategy_code: strategy.code, order_id: order.id, signal_id: signal.id });
      }

      // P&L nao realizado + exposicao
      let unrealized = 0, gross = 0, net = 0, maxPosValue = 0;
      const openCount = remaining.filter(p => Math.abs(fix(p.quantity)) > 1e-10).length;
      for (const pos of remaining) {
        const qty = fix(pos.quantity);
        if (Math.abs(qty) < 1e-10) continue;
        const mark = prices[pos.symbol] ?? fix(pos.mark_price);
        const upnl = (mark - fix(pos.average_price)) * qty;
        unrealized += upnl;
        const value = qty * mark;
        gross += Math.abs(value); net += value;
        maxPosValue = Math.max(maxPosValue, Math.abs(value));
        await updateRecord(db, 'PaperPosition', pos.id, { mark_price: mark, unrealized_pnl: upnl });
      }

      const newRealized = fix(portfolio.realized_pnl) + realizedDelta;
      const equity = fix(portfolio.capital, INITIAL_CAPITAL) + newRealized + unrealized;
      const peak = Math.max(fix(portfolio.peak_equity, INITIAL_CAPITAL), equity);
      const drawdownPct = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
      const concentrationPct = gross > 0 ? (maxPosValue / gross) * 100 : 0;

      await updateRecord(db, 'PortfolioState', portfolio.id, {
        realized_pnl: newRealized, unrealized_pnl: unrealized, peak_equity: peak,
      });

      // snapshot de risco da conta
      const snapshot = await createRecord(db, 'RiskSnapshot', {
        account: an, timestamp: now, gross_exposure: gross, net_exposure: net,
        drawdown_pct: drawdownPct, concentration_pct: concentrationPct,
        open_positions: openCount, equity,
        breaches: drawdownPct > acct.veto_dd_pct ? 'drawdown' : (concentrationPct > 50 ? 'concentration' : ''),
      });
      await audit(db, chain, 'risk.snapshot', 'RiskSnapshot', snapshot.id,
        `[${an}] equity ${equity.toFixed(2)} | drawdown ${drawdownPct.toFixed(2)}% | concentracao ${concentrationPct.toFixed(0)}%`,
        { account: an, equity: equity.toFixed(2), realized_pnl: newRealized.toFixed(2),
          unrealized_pnl: unrealized.toFixed(2), drawdown_pct: drawdownPct.toFixed(2),
          concentration_pct: concentrationPct.toFixed(1), open_positions: openCount,
          gross_exposure: gross.toFixed(2), net_exposure: net.toFixed(2) });

      // alertas da conta
      if (drawdownPct > 20 && !openRulesNow.has('drawdown_critical')) {
        openRulesNow.add('drawdown_critical');
        await createRecord(db, 'Alert', {
          account: an, severity: 'critical', rule: 'drawdown_critical', status: 'open',
          message: `[${an}] Drawdown de ${drawdownPct.toFixed(1)}% acima do limite critico de 20%.`,
        });
        totalAlerts++;
      } else if (drawdownPct > acct.veto_dd_pct && !openRulesNow.has('drawdown_warning')) {
        openRulesNow.add('drawdown_warning');
        await createRecord(db, 'Alert', {
          account: an, severity: 'warning', rule: 'drawdown_warning', status: 'open',
          message: `[${an}] Drawdown de ${drawdownPct.toFixed(1)}% acima do limite de ${acct.veto_dd_pct}%.`,
        });
        totalAlerts++;
      }
      if (concentrationPct > 50 && !openRulesNow.has('concentration_warning')) {
        openRulesNow.add('concentration_warning');
        await createRecord(db, 'Alert', {
          account: an, severity: 'warning', rule: 'concentration_warning', status: 'open',
          message: `[${an}] Concentracao de ${concentrationPct.toFixed(0)}% em uma unica posicao (limite 50%).`,
        });
        totalAlerts++;
      }

      totalOrders += orders.length;
      summaries[an] = {
        equity: +equity.toFixed(2),
        realized_pnl: +newRealized.toFixed(2),
        unrealized_pnl: +unrealized.toFixed(2),
        drawdown_pct: +drawdownPct.toFixed(2),
        concentration_pct: +concentrationPct.toFixed(1),
        open_positions: openCount,
        strategies_loaded: strategies.length,
        new_signals: newSignals.length,
        new_orders: orders.length,
      };
    }

    // 5) cabeca da cadeia global persistida em todas as contas
    for (const p of portfoliosTouched) {
      await updateRecord(db, 'PortfolioState', p.id, {
        chain_head_hash: chain.lastHash || '', chain_head_event_id: chain.lastEventId || '',
      });
    }

    const totalEquity = Object.values(summaries).reduce((a: any, b: any) => a + (b as any).equity, 0);

    return new Response(JSON.stringify({
      ok: true, prices,
      total_equity: +totalEquity.toFixed(2),
      accounts: summaries,
      regimes: { BTCUSDT: regimes.BTCUSDT.regime, ETHUSDT: regimes.ETHUSDT.regime },
      swarm: { BTCUSDT: { view: swarms.BTCUSDT.view, confidence: +swarms.BTCUSDT.confidence.toFixed(0) },
               ETHUSDT: { view: swarms.ETHUSDT.view, confidence: +swarms.ETHUSDT.confidence.toFixed(0) } },
      correlation_id: chain.corrId, chain_head: chain.lastHash,
      new_signals: newSignalsAll,
      new_alerts: totalAlerts,
    }), { headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err && (err as any).message || err) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
});
