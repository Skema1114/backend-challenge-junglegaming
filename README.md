# Distributed Wagering Processor

Serviço em Bun, NestJS, TypeScript, MikroORM, PostgreSQL e AWS SQS (LocalStack) para processar transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) com controle de concorrência por wallet, idempotência persistente, ledger imutável e Inbox/Outbox transacionais.

As decisões de modelagem e trade-offs estão em [ARCHITECTURE.md](./ARCHITECTURE.md) e o enunciado original ficou salvo em [CHALLENGE.md](./CHALLENGE.md).

## Como subir localmente

Você precisa de [Bun](https://bun.sh) 1.x e Docker Compose instalados.

Copie as variáveis de ambiente, instale as dependências e suba PostgreSQL 16 + LocalStack SQS:

```bash
cp .env.example .env
bun install
docker compose up -d
```

O script [docker/localstack/init-sqs.sh](./docker/localstack/init-sqs.sh) cria automaticamente as filas `wager-transactions.fifo` (com `RedrivePolicy` após `maxReceiveCount=5`), `wager-transactions-dlq.fifo` e `wager-events.fifo`. Por padrão o compose expõe o PostgreSQL na porta `5439` (`DB_PORT`) e o LocalStack na `4566`; a aplicação sobe na `3100` (`PORT`).

Rode as migrations e inicie o servidor:

```bash
bun run migration:up
bun run start:dev
```

Para reverter a migration, use `bun run migration:down`.

## Endpoints HTTP

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/wallets` | Cria carteira (se `initialBalance > 0`, cria transação `OPENING` + lançamento `CREDIT` na mesma transação SQL) |
| `GET` | `/wallets/:walletId` | Consulta saldo e versão da carteira |
| `GET` | `/wallets/:walletId/ledger?cursor=...&limit=50` | Lista lançamentos com paginação por cursor opaco |
| `POST` | `/wallets/:walletId/reconciliation` | Compara saldo materializado com a soma do ledger |
| `POST` | `/wagering/transactions` | Processa transação (exige header `Idempotency-Key`) |
| `GET` | `/wagering/transactions/:transactionId` | Busca transação por ID interno |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Busca transação por ID externo do provedor |
| `GET` | `/health/live` | Liveness probe |
| `GET` | `/health/ready` | Readiness probe verificando PostgreSQL e SQS |
| `GET` | `/metrics` | Métricas em formato Prometheus (`/metrics/json` para JSON) |

## Testes e verificação

```bash
bun run typecheck
bun run build
bun run test:unit
bun run test:integration
bun run test:concurrency
bun run test
bun run test:load
```

`bun run test` executa as suítes unitária, de integração (contra PostgreSQL e LocalStack reais) e de concorrência (8 cenários reais incluindo 50 apostas paralelas idênticas, disputa de saldo `100.00` vs `2x 80.00`, 3 instâncias em processos separados, queda de worker após commit antes do ack, dois publishers na outbox, entrega fora de ordem e reinício de serviço).

## Medição do teste de carga (`bun run test:load`)

Rodei o teste de carga localmente contra os containers Docker com 3 instâncias simultâneas (`load-1`, `load-2`, `load-3`) e 24 workers concorrentes enviando 300 requisições (`BET`, `WIN`, `LOSS` e replays idempotentes) para 12 carteiras, com 2 delas concentrando cerca de um terço do tráfego.

As 300 requisições terminaram em `1223.74 ms` (`245.15 req/s`), com latência `p50 = 81.49 ms`, `p95 = 191.07 ms`, `p99 = 263.99 ms` e máxima de `303.31 ms`. Foram `281` respostas `201` e `19` replays `200`, sem erros `5xx` nem conflitos de deadlock, e todas as 12 carteiras fecharam consistentes na reconciliação final. Na outbox, dos `552` eventos gerados, `392` ainda estavam na fila após 1 segundo porque o publisher atual envia 1 evento por chamada SQS em lotes de 25.
