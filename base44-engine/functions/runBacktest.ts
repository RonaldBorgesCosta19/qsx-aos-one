import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// ============================================================
// Quant Omega Engine - Backtest
// Reexecuta a MESMA logica de sinais do runQuantCycle sobre
// dados historicos (Kraken) com custo de 0.1% por lado,
// take-profit 4% / stop-loss 2% e saida por sinal contrario.
// Salva o resultado em BacktestRun e devolve a curva de capital.
// ============================================================

interface Candle {
  openTime: number; open: number; high: number; low: number;
  close: number; volume: number; closeTime: number;
}

const INITIAL_CAPITAL = 100000;
const POSITION_SIZE_PCT = 0.10;
const TAKE_PROFIT_PCT = 0.04;
const STOP_LOSS_PCT = 0.02;
const FEE_PCT = 0.001;

// ---------- indicadores (identicos ao runQuantCycle) ----------
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

// ---------- dados (Kraken principal, OKX fallback) ----------
function krakenPair(symbol: string): string {
  if (symbol === 'BTCUSDT') return 'XBTUSDT';
  return 'ETHUSDT';
}

async function fetchKraken(symbol: string, intervalMin: number): Promise<Candle[]> {
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
    if (t + intervalMin * 60 > nowSec) continue;
    out.push({
      openTime: t * 1000, open: +k[1], high: +k[2], low: +k[3],
      close: +k[4], volume: +k[6], closeTime: (t + intervalMin * 60) * 1000,
    });
  }
  if (out.length < 60) throw new Error(`Kraken insuficiente (${out.length} candles)`);
  return out;
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

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

async function fetchOkx(symbol: string, intervalMin: number): Promise<Candle[]> {
  const instId = symbol === 'BTCUSDT' ? 'BTC-USDT' : 'ETH-USDT';
  const bar = intervalMin === 15 ? '15m' : '1H';
  let after: string | undefined = undefined;
  const out: Candle[] = [];
  let pages = 0;
  while (out.length < 700 && pages < 8) {
    let url = `https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=100`;
    if (after) url = `https://www.okx.com/api/v5/market/history-candles?instId=${instId}&bar=${bar}&after=${after}&limit=100`;
    const j = await okxGet(url);
    if (j.code !== '0' || !Array.isArray(j.data) || j.data.length === 0) break;
    for (const k of j.data) {
      if (!after && String(k[8]) === '0') continue;
      out.push({
        openTime: Number(k[0]), open: +k[1], high: +k[2], low: +k[3],
        close: +k[4], volume: +k[5], closeTime: Number(k[0]) + intervalMin * 60000,
      });
    }
    after = j.data[j.data.length - 1][0];
    pages++;
  }
  out.reverse();
  if (out.length < 60) throw new Error('OKX insuficiente');
  return out;
}

async function fetchKlines(symbol: string, intervalMin: number): Promise<Candle[]> {
  try { return await fetchKraken(symbol, intervalMin); }
  catch (e) { return await fetchOkx(symbol, intervalMin); }
}

// ---------- sinal por candle (mesma regra do ciclo ao vivo) ----------
function signalAt(code: string, candles: Candle[], i: number): 'LONG' | 'SHORT' | null {
  if (i < 21) return null;
  const closes = candles.map(c => c.close);
  const vols = candles.map(c => c.volume);
  const cur = candles[i], prev = candles[i - 1];
  const avgVol = mean(vols.slice(i - 20, i));

  if (code === 'TREND_HUNTER') {
    const e9 = emaSeries(closes, 9), e21 = emaSeries(closes, 21);
    if (isNaN(e9[i - 1]) || isNaN(e21[i - 1])) return null;
    const pd = e9[i - 1] - e21[i - 1], cd = e9[i] - e21[i];
    if (cur.volume <= avgVol) return null;
    if (pd <= 0 && cd > 0) return 'LONG';
    if (pd >= 0 && cd < 0) return 'SHORT';
    return null;
  }
  if (code === 'MEAN_REVERSION_GUARD') {
    const rsi = rsiSeries(closes, 14);
    if (isNaN(rsi[i - 1])) return null;
    if (rsi[i - 1] < 30 && rsi[i] > rsi[i - 1]) return 'LONG';
    if (rsi[i - 1] > 70 && rsi[i] < rsi[i - 1]) return 'SHORT';
    return null;
  }
  if (code === 'BREAKOUT_SCALPER') {
    const prior = candles.slice(i - 20, i);
    const maxH = Math.max(...prior.map(c => c.high));
    const minL = Math.min(...prior.map(c => c.low));
    if (cur.volume <= avgVol * 1.5) return null;
    if (cur.close > maxH) return 'LONG';
    if (cur.close < minL) return 'SHORT';
    return null;
  }
  return null;
}

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const db = (base44 as any).asServiceRole ?? base44;

  try {
    let payload: any = {};
    try { payload = await req.json(); } catch (_) {}
    const strategyCode = payload.strategy_code || 'TREND_HUNTER';
    const timeframe = payload.timeframe || '15m';
    const intervalMin = timeframe === '15m' ? 15 : 60;

    // estrategia: pega simbolo e nome da entidade, se existir
    let symbol = payload.symbol || 'BTCUSDT';
    let strategyName = strategyCode;
    try {
      const e = db.entities.Strategy;
      let res: any;
      try { res = await e.list(); } catch (_) { try { res = await e.list({ limit: 500 }); } catch (__) { res = null; } }
      const list = Array.isArray(res) ? res : (res.items || res.records || []);
      const strat = list.find((s: any) => s.code === strategyCode);
      if (strat) { symbol = strat.symbol || symbol; strategyName = strat.name || strategyCode; }
    } catch (_) {}

    const candles = await fetchKlines(symbol, intervalMin);
    const n = candles.length;
    if (n < 60) throw new Error('Historico insuficiente para backtest');

    // ---------- simulacao ----------
    let capital = INITIAL_CAPITAL;
    let realized = 0;
    let pos: { qty: number; avg: number; dir: 'LONG' | 'SHORT'; entryTime: number } | null = null;
    const trades: any[] = [];
    const equityCurve: { t: number; equity: number }[] = [];
    let peak = INITIAL_CAPITAL, maxDD = 0;

    for (let i = 25; i < n; i++) {
      const c = candles[i];
      const sig = signalAt(strategyCode, candles, i);

      if (pos) {
        // verifica TP/SL dentro do candle
        let exitPrice: number | null = null, reason = '';
        if (pos.dir === 'LONG') {
          if (c.low <= pos.avg * (1 - STOP_LOSS_PCT)) { exitPrice = pos.avg * (1 - STOP_LOSS_PCT); reason = 'stop_loss'; }
          else if (c.high >= pos.avg * (1 + TAKE_PROFIT_PCT)) { exitPrice = pos.avg * (1 + TAKE_PROFIT_PCT); reason = 'take_profit'; }
        } else {
          if (c.high >= pos.avg * (1 + STOP_LOSS_PCT)) { exitPrice = pos.avg * (1 + STOP_LOSS_PCT); reason = 'stop_loss'; }
          else if (c.low <= pos.avg * (1 - TAKE_PROFIT_PCT)) { exitPrice = pos.avg * (1 - TAKE_PROFIT_PCT); reason = 'take_profit'; }
        }
        // saida por sinal contrario
        if (!exitPrice && sig && ((pos.dir === 'LONG' && sig === 'SHORT') || (pos.dir === 'SHORT' && sig === 'LONG'))) {
          exitPrice = c.close; reason = 'signal_reversal';
        }
        if (exitPrice !== null) {
          const gross = (exitPrice - pos.avg) * pos.qty;
          const fees = Math.abs(pos.qty) * pos.avg * FEE_PCT + Math.abs(pos.qty) * exitPrice * FEE_PCT;
          const net = gross - fees;
          realized += net;
          trades.push({
            dir: pos.dir, entry_time: pos.entryTime, exit_time: c.openTime,
            entry: pos.avg, exit: exitPrice, reason, pnl: +net.toFixed(2),
          });
          pos = null;
        }
      }

      if (!pos && sig) {
        const qty = ((capital * POSITION_SIZE_PCT) / c.close) * (sig === 'LONG' ? 1 : -1);
        const fee = Math.abs(qty) * c.close * FEE_PCT;
        realized -= fee;
        pos = { qty, avg: c.close, dir: sig, entryTime: c.openTime };
      }

      const unreal = pos ? (c.close - pos.avg) * pos.qty : 0;
      const equity = capital + realized + unreal;
      peak = Math.max(peak, equity);
      maxDD = Math.max(maxDD, peak > 0 ? ((peak - equity) / peak) * 100 : 0);
      equityCurve.push({ t: c.openTime, equity: +equity.toFixed(2) });
    }

    const finalEquity = capital + realized;
    const totalReturnPct = ((finalEquity - INITIAL_CAPITAL) / INITIAL_CAPITAL) * 100;
    const wins = trades.filter(t => t.pnl > 0).length;
    const winRatePct = trades.length ? (wins / trades.length) * 100 : 0;

    // ---------- grava resultado ----------
    const params: any = {
      capital_inicial: INITIAL_CAPITAL, position_size_pct: POSITION_SIZE_PCT,
      take_profit_pct: TAKE_PROFIT_PCT, stop_loss_pct: STOP_LOSS_PCT, fee_pct: FEE_PCT,
      candles: n, data_source: 'kraken/okx',
    };
    let runId = '';
    try {
      const run = await db.entities.BacktestRun.create({
        strategy_code: strategyCode, strategy_name: strategyName,
        symbol, timeframe,
        period_start: new Date(candles[0].openTime).toISOString(),
        period_end: new Date(candles[n - 1].openTime).toISOString(),
        total_return_pct: +totalReturnPct.toFixed(2),
        max_drawdown_pct: +maxDD.toFixed(2),
        win_rate_pct: +winRatePct.toFixed(2),
        num_trades: trades.length, params,
      });
      runId = run.id || run._id || '';
    } catch (e) { /* grava e melhor esforco */ }

    // curva reduzida para exibicao (ate 150 pontos)
    const step = Math.max(1, Math.floor(equityCurve.length / 150));
    const curve = equityCurve.filter((_, idx) => idx % step === 0);

    return new Response(JSON.stringify({
      ok: true, strategy: strategyCode, symbol, timeframe, candles: n,
      period_start: new Date(candles[0].openTime).toISOString(),
      period_end: new Date(candles[n - 1].openTime).toISOString(),
      final_equity: +finalEquity.toFixed(2),
      total_return_pct: +totalReturnPct.toFixed(2),
      max_drawdown_pct: +maxDD.toFixed(2),
      win_rate_pct: +winRatePct.toFixed(2),
      num_trades: trades.length,
      backtest_run_id: runId,
      trades: trades.slice(-20),
      equity_curve: curve,
    }), { headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err && (err as any).message || err) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
});
