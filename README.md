# Distributed Wagering Processor

Serviço financeiro distribuído para processamento de transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) com foco em correção monetária, concorrência multi-instância, idempotência persistente, ledger imutável, Inbox/Outbox transacionais e recuperação após falhas.

- Documentação de decisões arquiteturais e trade-offs: [ARCHITECTURE.md](./ARCHITECTURE.md)
- Enunciado original do desafio: [CHALLENGE.md](./CHALLENGE.md)

---

## Stack

- **Runtime / Package Manager / Test Runner:** Bun 1.x
- **Linguagem:** TypeScript (`strict: true`)
- **Framework:** NestJS 11
- **ORM / Migrations:** MikroORM 6 (`@mikro-orm/postgresql`, `@mikro-orm/migrations`)
- **Banco de Dados:** PostgreSQL 16
- **Mensageria:** AWS SQS FIFO via LocalStack (`wager-transactions.fifo`, `wager-transactions-dlq.fifo`, `wager-events.fifo`)
- **Precisão Monetária:** `decimal.js` + `NUMERIC(19,2)` no PostgreSQL

---

## Setup Local

### 1. Pré-requisitos
- [Bun](https://bun.sh) 1.x
- Docker e Docker Compose

### 2. Variáveis de ambiente e dependências
```bash
cp .env.example .env
bun install
```

### 3. Subir infraestrutura (PostgreSQL + LocalStack SQS)
```bash
docker compose up -d
```
O script [`docker/localstack/init-sqs.sh`](./docker/localstack/init-sqs.sh) cria automaticamente as filas FIFO:
- `wager-transactions.fifo` (com `RedrivePolicy` apontando para a DLQ após `maxReceiveCount=5`)
- `wager-transactions-dlq.fifo`
- `wager-events.fifo` (destino dos eventos publicados pela Outbox)

> Nota de portas locais: o `docker-compose.yml` expõe PostgreSQL na porta `5439` (configurável via `DB_PORT`) e LocalStack na `4566`; a aplicação sobe por padrão na porta `3100` (`PORT`).

### 4. Executar migrations (versionadas e reversíveis)
```bash
bun run migration:up
# Para reverter:
bun run migration:down
```

### 5. Iniciar a aplicação
```bash
bun run start:dev
# ou produção/direto:
bun run start
```

---

## Endpoints HTTP

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/wallets` | Cria wallet (se `initialBalance > 0`, cria transação `OPENING` + `CREDIT` no ledger atomicamente) |
| `GET` | `/wallets/:walletId` | Consulta estado e versão da wallet |
| `GET` | `/wallets/:walletId/ledger?cursor=...&limit=50` | Consulta paginada por cursor opaco do ledger |
| `POST` | `/wallets/:walletId/reconciliation` | Compara saldo materializado vs soma do ledger |
| `POST` | `/wagering/transactions` | Submete transação (header `Idempotency-Key` obrigatório) |
| `GET` | `/wagering/transactions/:transactionId` | Consulta transação por ID interno |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta transação por ID do provedor |
| `GET` | `/health/live` | Liveness probe (sem autenticação) |
| `GET` | `/health/ready` | Readiness probe verificando PostgreSQL e SQS (sem autenticação) |
| `GET` | `/metrics` | Métricas em formato Prometheus |
| `GET` | `/metrics/json` | Métricas em formato JSON |

---

## Scripts e Testes

```bash
# Verificação de tipos (TypeScript strict)
bun run typecheck

# Testes unitários (Money, Wallet, Ledger, WagerTransaction, IntegrationEvent, Outbox)
bun run test:unit

# Testes de integração reais (PostgreSQL + LocalStack SQS)
bun run test:integration

# Testes de concorrência e crash recovery (paralelismo real, >= 3 processos OS, kill pós-commit)
bun run test:concurrency

# Suíte completa em sequência (unit -> integration -> concurrency)
bun run test

# Experimento de carga contra 3 instâncias simultâneas + reconciliação final
bun run test:load
```

---

## Resultados do Teste de Carga (`bun run test:load`)

Experimento executado localmente contra PostgreSQL 16 e LocalStack 3.8 em containers Docker, com **3 instâncias NestJS/Bun simultâneas** (`load-1`, `load-2`, `load-3`) e **24 workers concorrentes**:

- **Cenário:** 300 requisições (`BET`, `WIN`, `LOSS` e replays idempotentes intencionais) distribuídas entre 12 wallets, sendo 2 *hot wallets* recebendo ~1/3 de todo o tráfego para forçar contenção de lock.
- **Duração total:** `1223.74 ms`
- **Throughput:** `245.15 req/s`
- **Latência:** `p50 = 81.49 ms` | `p95 = 191.07 ms` | `p99 = 263.99 ms` | `max = 303.31 ms`
- **Distribuição de respostas:** `281` criadas (`201`), `19` replays idempotentes (`200`), `0%` de erros inesperados (`5xx`/rede)
- **Conflitos de lock / deadlocks:** `0` (serialização determinística por linha via `SELECT ... FOR UPDATE` por `walletId`)
- **Outbox lag sob rajada:** `552` eventos gerados, `392` ainda pendentes após `1s` de dreno (o publisher atual envia 1 evento por chamada HTTP ao LocalStack SQS em lotes de `25`; em produção de maior vazão, recomenda-se `SendMessageBatch` com até 10 eventos por requisição SQS)
- **Reconciliação final:** `12 / 12` wallets consistentes (`wallet.balance == ledger`)
