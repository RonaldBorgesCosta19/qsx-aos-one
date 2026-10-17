import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// ============================================================
// QSX-AOS ONE - Replay Test (G1) - Multi-Account
// "EventStore -> replay -> State Engine = estado identico"
// Projeta deterministicamente o Event Store (AuditEvent) em:
//  - posicoes abertas por CONTA (quantidade + preco medio)
//  - P&L realizado por CONTA
// e compara com o estado materializado (PaperPosition /
// PortfolioState de cada conta). Divergencia = replay falha.
// Eventos sem campo account sao tratados como AGGRESSIVE.
// ============================================================

const ACCOUNTS = ['AGGRESSIVE', 'CONSERVATIVE'];
const DEFAULT_ACCOUNT = 'AGGRESSIVE';

async function listRecords(db: any, name: string): Promise<any[]> {
  const e = db.entities[name];
  let res: any;
  try { res = await e.list(); } catch (_) { try { res = await e.list({ limit: 500 }); } catch (__) { res = null; } }
  if (Array.isArray(res)) return res;
  if (res && Array.isArray(res.items)) return res.items;
  if (res && Array.isArray(res.records)) return res.records;
  if (res && Array.isArray(res.data)) return res.data;
  return [];
}

// ---------- State Engine: projecao deterministica do EventStore ----------
interface ProjPosition { qty: number; avg: number; }
interface Projection {
  positions: Record<string, ProjPosition>; // chave: "account|symbol"
  realized: Record<string, number>;        // por conta
  exits: Record<string, number>;
  eventsProcessed: number;
  entries: number;
  vetoes: number;
  prices: Record<string, number>;
}

function project(events: any[]): Projection {
  const positions: Record<string, ProjPosition> = {};
  const realized: Record<string, number> = {};
  const exits: Record<string, number> = {};
  for (const a of ACCOUNTS) { realized[a] = 0; exits[a] = 0; }
  let entries = 0, vetoes = 0, processed = 0;
  const prices: Record<string, number> = {};

  for (const ev of events) {
    const type = String(ev.action || ev.event_type || '');
    let p: any = null;
    if (ev.payload_json) { try { p = JSON.parse(String(ev.payload_json)); } catch (_) { p = null; } }
    processed++;

    const account = p && p.account ? String(p.account) : DEFAULT_ACCOUNT;
    if (!realized.hasOwnProperty(account)) { realized[account] = 0; exits[account] = 0; }

    if (type === 'market.data.received' && p && p.symbol && p.price !== undefined) {
      prices[p.symbol] = Number(p.price);
      continue;
    }
    if (type === 'risk.vetoed') { vetoes++; continue; }
    if (type === 'order.simulated' && p && p.reason === 'entry') {
      const key = `${account}|${p.symbol}`;
      const qtyDelta = (p.side === 'BUY' ? 1 : -1) * Number(p.quantity);
      const price = Number(p.price);
      const cur = positions[key];
      if (cur && ((cur.qty > 0 && qtyDelta > 0) || (cur.qty < 0 && qtyDelta < 0))) {
        const newQty = cur.qty + qtyDelta;
        cur.avg = (cur.avg * Math.abs(cur.qty) + price * Math.abs(qtyDelta)) / (Math.abs(cur.qty) + Math.abs(qtyDelta));
        cur.qty = newQty;
      } else {
        positions[key] = { qty: qtyDelta, avg: price };
      }
      entries++;
      continue;
    }
    if ((type === 'position.closed_tp' || type === 'position.closed_sl' || type === 'position.closed_reversal') && p) {
      const key = `${account}|${p.symbol}`;
      if (p.pnl !== undefined) realized[account] += Number(p.pnl);
      if (positions[key]) positions[key] = { qty: 0, avg: 0 };
      exits[account]++;
      continue;
    }
    // signal.generated, risk.approved, regime/alpha/swarm, risk.snapshot: sem efeito de estado
  }

  return { positions, realized, exits, eventsProcessed: processed, entries, vetoes, prices };
}

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const db = (base44 as any).asServiceRole ?? base44;

  try {
    const evts = await listRecords(db, 'AuditEvent');
    const chained = evts
      .filter((e: any) => e.event_hash)
      .sort((a: any, b: any) =>
        (a.timestamp || 0) - (b.timestamp || 0) ||
        String(a.created_date || '').localeCompare(String(b.created_date || '')));

    const proj = project(chained);

    // estado materializado
    const allPositions = await listRecords(db, 'PaperPosition');
    const psAll = await listRecords(db, 'PortfolioState');
    const diffs: string[] = [];
    const perAccount: any[] = [];

    for (const an of ACCOUNTS) {
      const statePositions = allPositions.filter((p: any) =>
        Math.abs(Number(p.quantity) || 0) > 1e-10 &&
        (p.account ? String(p.account) : DEFAULT_ACCOUNT) === an);
      const portfolio = psAll.find((p: any) => (p.account ? String(p.account) : DEFAULT_ACCOUNT) === an);
      const stateRealized = portfolio ? Number(portfolio.realized_pnl) || 0 : 0;

      const projOpen = Object.entries(proj.positions).filter(([k, v]) =>
        k.startsWith(an + '|') && Math.abs((v as ProjPosition).qty) > 1e-10);

      const stateSymbols = new Set(statePositions.map((p: any) => p.symbol));
      const projSymbols = new Set(projOpen.map(([k]) => k.split('|')[1]));
      for (const s of stateSymbols) if (!projSymbols.has(s)) diffs.push(`[${an}] Posicao ${s} existe no estado mas nao no replay`);
      for (const s of projSymbols) if (!stateSymbols.has(s)) diffs.push(`[${an}] Posicao ${s} existe no replay mas nao no estado`);

      for (const [k, pvRaw] of projOpen) {
        const sym = k.split('|')[1];
        const pv = pvRaw as ProjPosition;
        const rec = statePositions.find((p: any) => p.symbol === sym);
        if (!rec) continue;
        const sq = Number(rec.quantity), sa = Number(rec.average_price);
        if (Math.abs(Math.abs(pv.qty) - Math.abs(sq)) > 1e-6) diffs.push(`[${an}] ${sym}: quantidade replay ${pv.qty.toFixed(8)} != estado ${sq.toFixed(8)}`);
        if (Math.sign(pv.qty) !== Math.sign(sq)) diffs.push(`[${an}] ${sym}: direcao divergente entre replay e estado`);
        if (Math.abs(pv.avg - sa) > 0.01) diffs.push(`[${an}] ${sym}: preco medio replay ${pv.avg.toFixed(2)} != estado ${sa.toFixed(2)}`);
      }

      const nExits = proj.exits[an] || 0;
      const pnlTolerance = 0.01 * (nExits + 1) + 0.01;
      const projRealized = proj.realized[an] || 0;
      if (Math.abs(projRealized - stateRealized) > pnlTolerance) {
        diffs.push(`[${an}] P&L realizado replay ${projRealized.toFixed(2)} != estado ${stateRealized.toFixed(2)}`);
      }

      perAccount.push({
        account: an,
        realized_pnl_replay: +projRealized.toFixed(2),
        realized_pnl_state: stateRealized,
        open_positions_replay: projOpen.map(([k, v]) => ({
          symbol: k.split('|')[1],
          quantity: +((v as ProjPosition).qty).toFixed(8),
          average_price: +((v as ProjPosition).avg).toFixed(2),
        })),
        open_positions_state: statePositions.map((p: any) => ({
          symbol: p.symbol, quantity: Number(p.quantity), average_price: Number(p.average_price),
        })),
      });
    }

    const replayPass = diffs.length === 0;

    return new Response(JSON.stringify({
      ok: true,
      replay_test: replayPass ? 'PASS' : 'FAIL',
      events_replayed: proj.eventsProcessed,
      entries_replayed: proj.entries,
      exits_replayed: Object.values(proj.exits).reduce((a: any, b: any) => a + (b as number), 0),
      vetoes_replayed: proj.vetoes,
      per_account: perAccount,
      last_prices: proj.prices,
      differences: diffs,
      verdict: replayPass
        ? 'REPLAY PASS - projecao do EventStore reproduz o estado identico em todas as contas'
        : 'REPLAY FAIL - estado divergente do EventStore',
    }), { headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err && (err as any).message || err) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
});
