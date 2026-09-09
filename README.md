# QSX-AOS ONE: Verifiable Quantitative Trading System

**Core Thesis**: Every decision, event, and state transition must be traceable, auditable, and reproducible.

## Architecture Overview

```
MarketDataReceived
    ↓ [FeatureEngine]
FeatureCalculated
    ↓ [RegimeEngine]
RegimeDetected
    ↓ [AlphaRegistry + AI Swarm]
AlphaGenerated
    ↓ [SignalEngine]
SignalGenerated
    ↓ [RiskGovernor]
RiskCheckRequested ──→ RiskRejected (VETO)
    ↓ (approved)
RiskApproved
    ↓ [PaperExecution]
SimulatedOrderSubmitted
    ↓
PaperFill
    ↓
PositionUpdated
    ↓
PnLUpdated
    ↓
EventStore (append-only, hash-chained)
```

**Golden Rule**: No module skips stages. No agent bypasses Risk Governor.

---

## 3 Pillars of Verifiability

### **G0 — Data Integrity**
- Data Contracts with canonical schema
- Event identity (event_id, correlation_id, causation_id)
- Hash chain (previous_hash, event_hash)
- Version control for all payloads

**Goal**: Answer "What was the source data for this position?"

### **G1 — Event Integrity**
- Event Store (append-only, immutable)
- SHA256 hash chain validation
- Idempotency (duplicate event_id returns existing event)
- State Engine (deterministic projection of EventStore)
- Replay Test: `EventStore → replay → State Engine = identical state`

**Goal**: Detect any historical alterations. Support replay and retries.

### **G2 — Decision Integrity**
- Entire decision chain as events (market → features → regime → alpha → signal → risk → execution)
- PortfolioBrain (context evaluation)
- Risk Governor (final authority)
- Audit trail of every rejection and approval

**Goal**: Complete audit of "why" behind every position.

---

## Directory Structure

```
qsx-aos-one/
├── core/
│   ├── events/
│   │   ├── __init__.py
│   │   ├── base.py              # BaseEvent, EventMetadata
│   │   └── definitions.py       # 12 canonical events
│   ├── event_store/
│   │   ├── __init__.py
│   │   ├── storage.py           # EventStore interface
│   │   ├── postgres_store.py    # PostgreSQL implementation
│   │   └── memory_store.py      # In-memory for testing
│   ├── state_engine/
│   │   ├── __init__.py
│   │   ├── projections.py       # State projections
│   │   └── replay.py            # Replay mechanism
│   └── audit/
│       ├── __init__.py
│       ├── chain.py             # Hash chain validation
│       └── health.py            # HealthMonitor events
├── engines/
│   ├── market_data/
│   │   ├── __init__.py
│   │   ├── normalizer.py
│   │   ├── quality_gate.py
│   │   └── engine.py
│   ├── features/
│   │   ├── __init__.py
│   │   └── engine.py
│   ├── regime/
│   │   ├── __init__.py
│   │   └── engine.py
│   ├── alpha/
│   │   ├── __init__.py
│   │   ├── registry.py
│   │   └── swarm.py
│   ├── signal/
│   │   ├── __init__.py
│   │   └── engine.py
│   ├── risk/
│   │   ├── __init__.py
│   │   └── governor.py
│   └── execution/
│       ├── __init__.py
│       └── paper.py
├── models/
│   ├── __init__.py
│   ├── market.py
│   ├── portfolio.py
│   ├── position.py
│   └── pnl.py
├── tests/
│   ├── __init__.py
│   ├── test_g0_data_contracts.py
│   ├── test_g1_event_integrity.py
│   ├── test_g2_decision_integrity.py
│   └── fixtures/
├── cockpit/
│   ├── __init__.py
│   ├── api.py
│   ├── dashboard.py
│   └── audit_trail.py
├── config.py
├── requirements.txt
└── docker-compose.yml
```

---

## Development Roadmap

### **Phase 1: Foundations (G0 + G1)**
- [ ] Event Store with SHA256 hash chain
- [ ] 12 canonical event definitions
- [ ] Event integrity validation
- [ ] Replay mechanism
- [ ] State Engine projections
- [ ] Tests for G0 + G1

### **Phase 2: Deterministic Engines (G2 Part 1)**
- [ ] Market Data Engine (normalizer → quality gate → event)
- [ ] Feature Engine (versionized features, no lookahead)
- [ ] Regime Engine (regime detection)

### **Phase 3: Decision Integration (G2 Part 2)**
- [ ] Alpha Registry + AI Swarm
- [ ] Signal Engine
- [ ] PortfolioBrain
- [ ] Risk Governor (veto authority)
- [ ] Paper Execution (simulation)

### **Phase 4: Auditable Observability**
- [ ] HealthMonitor as Events
- [ ] Cockpit with traceability (click through to causal event)
- [ ] Complete audit trail interface

---

## Running Locally

```bash
# Clone and install dependencies
git clone https://github.com/RonaldBorgesCosta19/qsx-aos-one.git
cd qsx-aos-one
pip install -r requirements.txt

# Start services
docker-compose up -d

# Run tests
pytest tests/

# Start cockpit (dashboard)
python -m cockpit.api
```

---

## Key Concepts

### Event Anatomy
```json
{
  "event_id": "evt_uuid_v4",
  "event_type": "MarketDataReceived",
  "timestamp": "2026-09-09T14:32:45.123Z",
  "source": "exchange_binance",
  "correlation_id": "corr_uuid",
  "causation_id": "evt_parent_uuid",
  "aggregate_id": "btcusdt",
  "schema_version": "1.0",
  "payload": { ... },
  "previous_hash": "sha256_of_previous_event",
  "event_hash": "sha256(event_id + type + timestamp + correlation_id + causation_id + payload + previous_hash)"
}
```

### Verifiability Chain
```
Position Exists
    ↓
PositionUpdated Event
    ↓
PaperFill Event
    ↓
SimulatedOrderSubmitted Event
    ↓
RiskApproved Event
    ↓
RiskCheckRequested Event
    ↓
SignalGenerated Event
    ↓
AlphaGenerated Event
    ↓
RegimeDetected Event
    ↓
FeatureCalculated Event
    ↓
MarketDataReceived Event (SOURCE OF TRUTH)
```

Each event cryptographically proves causation to its predecessor.

### Idempotency
```
event_id = "evt_abc123"
    ↓ [First call]
Event stored, returns event_id

    ↓ [Retry/Duplicate call]
Same event_id
    ↓
Returns existing event (no duplicate created)
```

---

## Cockpit Audit Interface

Every metric is clickable and traces to its causal event:

```
MARKET
  BTCUSDT | Regime: BULL | Quality: 99.8% ─→ [Click] MarketDataReceived
                                               ├─ Source: binance
                                               ├─ Timestamp: 2026-09-09T14:32:45Z
                                               └─ Data Quality Metrics: {...}

ALPHA
  Alpha #A017 | Status: SHADOW | Confidence: 82% ─→ [Click] AlphaGenerated
                                                       ├─ Caused by: SignalGenerated
                                                       ├─ Model: ensemble_v2
                                                       └─ Validation: leakage_free

RISK
  Risk Score: 24 | Governor: APPROVED ─→ [Click] RiskApproved
                                          ├─ Reason: within_limits
                                          ├─ Max Drawdown: 15%
                                          └─ Correlation Risk: MEDIUM

EXECUTION
  Mode: PAPER | Order: SIMULATED | Fill: CONFIRMED ─→ [Click] PaperFill
                                                       ├─ Order ID: ord_xyz789
                                                       ├─ Quantity: 0.5 BTC
                                                       └─ Price: $42,500

AUDIT
  Event Chain: VALID ─→ [Click] Verify Chain
  Last Event: PnLUpdated         ├─ All 47 events in chain validated
  Events Total: 47               ├─ No tampering detected
                                 └─ Replay Test: PASS
```

---

## Golden Rules

1. **No Skipped Stages**: Every decision flows through the defined pipeline.
2. **Risk Governor Veto**: No signal, alpha, or order bypasses risk approval.
3. **Event Immutability**: Once written, events are append-only and hash-chained.
4. **State is Derived**: State Engine is a projection, not a source of truth.
5. **Replay Fidelity**: `EventStore → replay → State Engine` must produce identical state.
6. **No Lookahead**: Features never use future data. Validated at gate.
7. **Audit Completeness**: Every health change, rejection, approval is an event.
8. **Traceability**: Any position must trace back to original market data.

---

## Status: FOUNDATION PHASE

🔧 **Current Work**: Building G0 (Data Contracts) + G1 (Event Store) foundations.

Next: Event definitions, Event Store implementation, Replay tests.

---

**Repository**: https://github.com/RonaldBorgesCosta19/qsx-aos-one

**Contact**: Ronald Borges Costa
