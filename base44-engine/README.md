# QSX-AOS ONE — Motor de Paper Trading Auditável

Implementação de referência do QSX-AOS ONE: motor de trading quantitativo
de criptomoedas em **paper trading** (100% simulado, nenhuma ordem real),
com arquitetura orientada a eventos verificável.

## Pilares

- **G0 — Integridade de dados**: MarketDataReceived é a fonte da verdade;
  apenas candles fechados (Kraken principal, OKX fallback).
- **G1 — Integridade de eventos**: event store append-only com hash chain
  SHA256 (`event_id`, `correlation_id`, `causation_id`, `previous_hash`,
  `event_hash`), payloads canônicos estruturados (schema 1.1).
- **G2 — Decisão auditável**: Regime Engine (BULL/BEAR/RANGE), Alpha
  Registry + AI Swarm (ensemble ponderado), gates de regime/swarm e Risk
  Governor com circuit breaker de drawdown. Nenhum módulo é bypassado.

## Golden Rule

```
EventStore -> replay -> State Engine = estado identico
```

O replay (`replayQuantState`) projeta deterministicamente o event store em
posições e P&L por carteira e compara com o estado materializado. Divergência
= falha detectável.

## Multi-carteiras (v1.3)

| Conta | Posição | TP | SL | Veto drawdown |
|---|---|---|---|---|
| AGGRESSIVE | 10% | 4% | 2% | 10% |
| CONSERVATIVE | 5% | 3% | 1,5% | 6% |

Cada carteira tem capital virtual, estratégias, snapshots e alertas próprios;
a cadeia de eventos é global (conta dentro do payload).

## Conteúdo

- `functions/runQuantCycle.ts` — ciclo completo (mercado → regime → swarm →
  sinais → gates → risk governor → execução simulada → snapshot)
- `functions/runBacktest.ts` — backtest determinístico sobre histórico
- `functions/verifyQuantChain.ts` — auditoria da cadeia (hashes, encadeamento,
  causalidade, cabeça vs estado)
- `functions/replayQuantState.ts` — replay test multi-conta
- `SETUP.md` — kit de instalação passo a passo (entidades, seeds, deploys,
  workflow agendado e testes de validação)

## Instalação

Os módulos são funções backend TypeScript/Deno (Base44 SDK), mas a lógica
(pipeline, indicadores, hash chain, state engine) é portátil para qualquer
runtime. Para instalar em um Superagent Base44, siga o `SETUP.md` — cria as
entidades, implanta as 4 funções, agenda o ciclo e valida com os 3 testes
(ciclo, cadeia, replay).

## Aviso

Sistema educacional/paper trading. Não é conselho de investimento. Não
conecte a correções reais sem semanas de paper positivo, testnet e chave de
API sem permissão de saque.
