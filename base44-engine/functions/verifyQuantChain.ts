import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// ============================================================
// QSX-AOS ONE - Verificador de Cadeia de Eventos (G1)
// Suporta schemas 1.0 (payload textual) e 1.1 (payload_json
// estruturado). Valida hash SHA256 de cada evento, encadeamento
// previous_hash, causalidade causation_id e cabeca vs PortfolioState.
// ============================================================

async function sha256Hex(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

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

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const db = (base44 as any).asServiceRole ?? base44;

  try {
    const evts = await listRecords(db, 'AuditEvent');
    const legacy = evts.filter((e: any) => !e.event_hash);
    const chained = evts
      .filter((e: any) => e.event_hash)
      .sort((a: any, b: any) =>
        (a.timestamp || 0) - (b.timestamp || 0) ||
        String(a.created_date || '').localeCompare(String(b.created_date || '')));

    let valid = true, brokenAt: number | null = null, reason = '';
    let prevHash = 'GENESIS', prevId = 'GENESIS';
    let causationOK = true;
    let v10 = 0, v11 = 0;
    const byType: Record<string, number> = {};

    for (let i = 0; i < chained.length; i++) {
      const ev = chained[i];
      const isV11 = String(ev.schema_version || '1.0') === '1.1';
      if (isV11) v11++; else v10++;
      byType[ev.action || ev.event_type || '?'] = (byType[ev.action || ev.event_type || '?'] || 0) + 1;

      const payload = isV11
        ? JSON.stringify({ object_type: ev.object_type, object_id: ev.object_id, details: ev.details, payload_json: String(ev.payload_json ?? '') })
        : JSON.stringify({ object_type: ev.object_type, object_id: ev.object_id, details: ev.details });

      const expected = await sha256Hex(
        String(ev.event_id) + '|' + String(ev.action) + '|' + Number(ev.timestamp) + '|' +
        String(ev.correlation_id || '') + '|' + String(ev.causation_id || 'GENESIS') + '|' +
        payload + '|' + String(ev.previous_hash || 'GENESIS'));

      if (expected !== String(ev.event_hash)) {
        valid = false; brokenAt = i; reason = 'hash_mismatch'; break;
      }
      if (String(ev.previous_hash || 'GENESIS') !== prevHash) {
        valid = false; brokenAt = i; reason = 'chain_break'; break;
      }
      if (String(ev.causation_id || 'GENESIS') !== prevId) causationOK = false;

      prevHash = String(ev.event_hash);
      prevId = String(ev.event_id);
    }

    // cabeca da cadeia vs estado
    let headMatches = null as boolean | null;
    try {
      const ps = await listRecords(db, 'PortfolioState');
      if (ps.length) {
        headMatches = chained.length > 0
          ? String(ps[0].chain_head_hash || '') === prevHash
          : !ps[0].chain_head_hash;
      }
    } catch (_) {}

    const last = chained.length ? chained[chained.length - 1] : null;
    const genesisOK = chained.length === 0 || String(chained[0].previous_hash || '') === 'GENESIS';

    return new Response(JSON.stringify({
      ok: true,
      total_events: evts.length,
      chained_events: chained.length,
      legacy_events: legacy.length,
      schema_v10: v10,
      schema_v11: v11,
      events_by_type: byType,
      chain_valid: valid,
      broken_at: brokenAt,
      reason,
      causation_consistent: causationOK,
      genesis_ok: genesisOK,
      head_matches_state: headMatches,
      head_hash: prevHash,
      last_event: last ? {
        event_id: last.event_id, event_type: last.action || last.event_type,
        correlation_id: last.correlation_id, timestamp: last.timestamp,
        object_type: last.object_type, object_id: last.object_id, details: last.details,
      } : null,
      verdict: valid && causationOK && genesisOK
        ? 'INTEGRIDADE CONFIRMADA - nenhum evento adulterado'
        : 'FALHA DE INTEGRIDADE - verificar eventos reportados',
    }), { headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err && (err as any).message || err) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
});
