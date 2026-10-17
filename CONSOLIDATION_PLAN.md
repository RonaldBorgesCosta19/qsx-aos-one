# Plano de Consolidação — "Super App" de Cripto (QSX-AOS ONE)

Este documento descreve os próximos passos práticos para consolidar os projetos existentes neste repositório e evoluir para um "super aplicativo" de criptomoedas com monorepo, CI, backlog priorizado e scaffolding inicial.

Resumo executivo
- Objetivo: Unificar funcionalidades de motor quant (QSX-AOS ONE) e componentes de cockpit/dashboard, backtesting e infra numa estrutura monorepo organizada em workspaces.
- Recomenda-se monorepo usando pnpm workspaces / Turborepo / Nx (opção: pnpm + TypeScript + Python libs isoladas) para compartilhar UI, tipos e lógica.

Estrutura proposta
```
/ (root)
  /apps
    /web          # Cockpit / dashboard (React + TypeScript, Next.js opcional)
    /mobile       # App móvel (React Native) — opcional
    /api          # API/Backend (FastAPI Python) ou Node (Nest/Express)
  /engines       # Implementações em Python (core engines)
  /base44-engine # Funções Deno/TypeScript já presentes — manter e versionar
  /packages
    /ui-kit
    /crypto-sdk
    /shared-types
  /infra
    /k8s
    /ci
  /docs
  /tests
```

Backlog inicial (prioritário)
1. Inventory automático das entidades e funções (script) — listar entidades Base44 (Strategy, AuditEvent, PortfolioState, etc.)
2. Criar monorepo skeleton com workspace e READMEs
3. Criar CI pipeline base (GitHub Actions): lint, tests, build, deploy function
4. Scaffold do Cockpit (Next.js) com páginas: Overview, Audit Trail, Backtests, Replay
5. Criar issue templates e PR template
6. Exportar tests automatizados: G0 (contracts), G1 (chain verify), G2 (replay)
7. Documentar SETUP.md para instalação e correr os testes (já existe; melhorar)

Ações imediatas que realizei
- Criei este arquivo CONSOLIDATION_PLAN.md com o plano de alto-nível e backlog inicial.

Próximos passos que posso executar agora (escolha um):
A. Gerar o monorepo skeleton (criar package.json, pnpm workspace config, apps/api skeleton).
B. Criar issues no repositório para cada item do backlog (faço uma issue por tarefa priorizada).
C. Scaffold GitHub Actions workflow para CI (lint, tests, build).
D. Gerar o Cockpit inicial (Next.js) em apps/web com páginas estáticas e integração mínima ao endpoint runQuantCycle.
E. Rodar inventário automático das funções Base44 (listar endpoints e entidades) — preciso de permissão API se você quiser que eu leia dinamicamente.

Como prefere que eu continue? Se não escolher, seguirei com (B) criar issues representando o backlog e milestones.
