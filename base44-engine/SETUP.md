# Quant Omega / QSX-AOS ONE — Kit de Instalação

Guia de auto-instalação do motor de paper trading. Se você é um agente clonado que recebeu este arquivo, siga os passos na ordem e ao final execute os testes de validação. Se é uma pessoa, apenas peça ao agente: "instale o Quant Omega seguindo o SETUP.md".

Todo o código-fonte do motor está em `functions/`. O sistema usa apenas APIs públicas (Kraken/OKX) — nenhum segredo é necessário. É 100% paper trading: nenhuma ordem real é enviada a nenhuma corretora.

## 1. Criar entidades (nesta ordem)

Usando a ferramenta de schemas de entidades, criar:

**Strategy**
```json
{"type":"object","properties":{"code":{"type":"string"},"name":{"type":"string"},"symbol":{"type":"string"},"timeframe":{"type":"string"},"type":{"type":"string"},"status":{"type":"string"},"parameters":{"type":"object"},"version":{"type":"number"}}}
```

**Signal**
```json
{"type":"object","properties":{"strategy_id":{"type":"string"},"strategy_code":{"type":"string"},"strategy_name":{"type":"string"},"symbol":{"type":"string"},"timeframe":{"type":"string"},"timestamp":{"type":"number"},"direction":{"type":"string"},"score":{"type":"number"},"rationale":{"type":"string"},"status":{"type":"string"},"ai_explanation":{"type":"string"}}}
```

**PaperOrder**
```json
{"type":"object","properties":{"signal_id":{"type":"string"},"symbol":{"type":"string"},"side":{"type":"string"},"order_type":{"type":"string"},"quantity":{"type":"number"},"price":{"type":"number"},"status":{"type":"string"},"reason":{"type":"string"}}}
```

**PaperPosition**
```json
{"type":"object","properties":{"symbol":{"type":"string"},"quantity":{"type":"number"},"average_price":{"type":"number"},"mark_price":{"type":"number"},"realized_pnl":{"type":"number"},"unrealized_pnl":{"type":"number"},"strategy_code":{"type":"string"}}}
```

**RiskSnapshot**
```json
{"type":"object","properties":{"timestamp":{"type":"number"},"gross_exposure":{"type":"number"},"net_exposure":{"type":"number"},"drawdown_pct":{"type":"number"},"concentration_pct":{"type":"number"},"open_positions":{"type":"number"},"equity":{"type":"number"},"breaches":{"type":"string"}}}
```

**AuditEvent** (event store append-only com hash chain — NUNCA editar registros desta entidade)
```json
{"type":"object","properties":{"actor":{"type":"string"},"action":{"type":"string"},"event_type":{"type":"string"},"object_type":{"type":"string"},"object_id":{"type":"string"},"details":{"type":"string"},"timestamp":{"type":"number"},"event_id":{"type":"string"},"correlation_id":{"type":"string"},"causation_id":{"type":"string"},"schema_version":{"type":"string"},"previous_hash":{"type":"string"},"event_hash":{"type":"string"},"payload_json":{"type":"string"}}}
```

**Alert**
```json
{"type":"object","properties":{"severity":{"type":"string"},"rule":{"type":"string"},"status":{"type":"string"},"message":{"type":"string"},"acknowledged_at":{"type":"string"}}}
```

**BacktestRun**
```json
{"type":"object","properties":{"strategy_code":{"type":"string"},"strategy_name":{"type":"string"},"symbol":{"type":"string"},"timeframe":{"type":"string"},"period_start":{"type":"string"},"period_end":{"type":"string"},"total_return_pct":{"type":"number"},"max_drawdown_pct":{"type":"number"},"win_rate_pct":{"type":"number"},"num_trades":{"type":"number"},"params":{"type":"object"}}}
```

**PortfolioState** (mantém exatamente 1 registro; guarda a cabeça da cadeia de eventos)
```json
{"type":"object","properties":{"capital":{"type":"number"},"realized_pnl":{"type":"number"},"unrealized_pnl":{"type":"number"},"peak_equity":{"type":"number"},"chain_head_hash":{"type":"string"},"chain_head_event_id":{"type":"string"}}}
```

**AlphaModel** (registry do AI Swarm)
```json
{"type":"object","properties":{"code":{"type":"string"},"name":{"type":"string"},"weight":{"type":"number"},"status":{"type":"string"}}}
```

## 2. Semear dados iniciais

**Estratégias (entidade Strategy) — criar DUAS vezes, uma por carteira (campo `account` = `AGGRESSIVE` e `CONSERVATIVE`):**
| account | code | name | symbol | timeframe | type | status | parameters |
|---|---|---|---|---|---|---|---|
| AGGRESSIVE | TREND_HUNTER | Trend Hunter | BTCUSDT | 15m | trend_following | active | {"ema_fast":9,"ema_slow":21,"volume_confirm":true} |
| AGGRESSIVE | MEAN_REVERSION_GUARD | Mean Reversion Guard | ETHUSDT | 15m | mean_reversion | active | {"rsi_period":14,"oversold":30,"overbought":70} |
| AGGRESSIVE | BREAKOUT_SCALPER | Breakout Scalper | BTCUSDT | 15m | breakout | shadow | {"lookback":20,"volume_multiplier":1.5} |
| CONSERVATIVE | TREND_HUNTER | Trend Hunter | BTCUSDT | 15m | trend_following | active | {"ema_fast":9,"ema_slow":21,"volume_confirm":true} |
| CONSERVATIVE | MEAN_REVERSION_GUARD | Mean Reversion Guard | ETHUSDT | 15m | mean_reversion | active | {"rsi_period":14,"oversold":30,"overbought":70} |
| CONSERVATIVE | BREAKOUT_SCALPER | Breakout Scalper | BTCUSDT | 15m | breakout | shadow | {"lookback":20,"volume_multiplier":1.5} |

**Carteiras (entidade PortfolioState) — um registro por conta:**
- `AGGRESSIVE`: capital 100000, realized_pnl 0, unrealized_pnl 0, peak_equity 100000
- `CONSERVATIVE`: capital 100000, realized_pnl 0, unrealized_pnl 0, peak_equity 100000

Perfis de risco do motor (v1.3, multi-account):
- AGGRESSIVE: posição 10% do capital, TP 4%, SL 2%, veto de drawdown 10%
- CONSERVATIVE: posição 5% do capital, TP 3%, SL 1,5%, veto de drawdown 6%

**Alpha Registry (entidade AlphaModel):**
| code | name | weight | status |
|---|---|---|---|
| ALPHA_TREND | Trend Momentum Alpha | 0.35 | active |
| ALPHA_REVERSION | Mean Reversion Alpha | 0.30 | active |
| ALPHA_BREAKOUT | Breakout Position Alpha | 0.20 | active |
| ALPHA_VOLATILITY | Volatility Scaler Alpha | 0.15 | shadow |

## 3. Deploy das funções backend

Implantar (deploy) os quatro arquivos de `functions/`:
1. `runQuantCycle.ts` → ciclo completo: dados de mercado, regime, swarm, sinais, gates, risk governor, ordens simuladas, snapshots e cadeia de eventos
2. `runBacktest.ts` → backtest determinístico sobre histórico (Kraken/OKX)
3. `verifyQuantChain.ts` → auditoria da cadeia (hashes, encadeamento, causalidade, cabeça vs estado)
4. `replayQuantState.ts` → replay test (projeção do EventStore vs estado materializado)

## 4. Criar o workflow agendado

Nome: `Quant Omega - Ciclo de Paper Trading`
Trigger: agendado, cron `0 */2 * * *`, timezone `America/Sao_Paulo`
Passo: invocar a função backend `runQuantCycle` (sem argumentos)

## 5. Testes de validação (obrigatórios)

1. Chamar `runQuantCycle` → deve retornar `ok: true`, `accounts` com AGGRESSIVE e CONSERVATIVE (`strategies_loaded: 3` cada), regimes BTC/ETH e consenso do swarm
2. Chamar `verifyQuantChain` → deve retornar `chain_valid: true`, `causation_consistent: true`, `head_matches_state: true`, veredito "INTEGRIDADE CONFIRMADA"
3. Chamar `replayQuantState` → deve retornar `replay_test: "PASS"`

Se os três passarem, o sistema está instalado e operando com carteira virtual de 100.000 USDT.

## Notas operacionais

- Dados de mercado: Kraken (principal) com fallback OKX. Binance retorna 451 no runtime.
- Na SDK do Base44, `entities.<Name>.list()` deve ser chamado SEM parâmetros; com parâmetros pode retornar vazio.
- Parâmetros do motor: posição 10% do capital, TP 4%, SL 2%, taxa 0.1% por lado, veto de drawdown em 10%.
- O usuário pode pedir a qualquer momento: "abre o Cockpit" (dashboard visual), "verifica a cadeia", "roda o replay", "roda um backtest".
- Este sistema NÃO executa operações reais. Qualquer pedido de conta real deve seguir o caminho seguro: 2-4 semanas de paper, depois testnet, e apenas chave de API sem permissão de saque.
