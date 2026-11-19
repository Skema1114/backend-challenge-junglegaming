# Arquitetura: Distributed Wagering Processor

O serviço separa domínio, casos de uso, persistência/mensageria e camada HTTP sobre Bun 1.x, NestJS, TypeScript em modo estrito, MikroORM, PostgreSQL e AWS SQS (LocalStack).

```
src/
├── shared/          # Money, FailureCode, JSON canônico, AuthGuard, logger e métricas
├── domain/          # Wallet, WalletLedgerEntry, WagerTransaction, Inbox, Outbox, IntegrationEvent
├── application/     # Casos de uso e portas (UnitOfWorkPort e repositórios transacionais)
├── infrastructure/  # EntitySchema, migrations SQL, cliente SQS e workers
└── presentation/    # Controllers HTTP e filtro global de exceções
```

As classes de domínio em `src/domain` e `src/shared/domain` não importam decorators do NestJS nem tipos do ORM. A camada de persistência mapeia registros planos (`src/infrastructure/persistence/entities/records.ts`) via `EntitySchema` do MikroORM e reconstrói os objetos de domínio usando `rehydrate(...)`.

## ORM e representação monetária

O MikroORM foi escolhido pelo controle transacional explícito com `EntityManager.transactional()`, isolamento por `em.fork()` e suporte nativo a `LockMode.PESSIMISTIC_WRITE`. Usar `EntitySchema` separado evita colocar metadata de banco dentro das entidades de domínio.

Valores monetários nunca passam por `number`. A classe `Money` encapsula `Decimal` (`decimal.js`, precisão 30, `ROUND_HALF_UP`) e um código de moeda ISO-4217 (`^[A-Z]{3}$`), sempre com duas casas decimais. O contrato de entrada barra `NaN`, `Infinity`, notação científica, strings vazias, negativos ou mais de duas casas decimais usando `/^\d+(\.\d{1,2})?$/`. No PostgreSQL, valor e moeda ficam em `NUMERIC(19, 2)` e `CHAR(3)`. O driver devolve `NUMERIC` como `string`, o que permite reidratar `Money` direto sem passar por float. Embora os testes rodem em `BRL`, o modelo é multimoeda e rejeita operações entre moedas diferentes com `CURRENCY_MISMATCH`.

## Concorrência e garantias no banco

A unidade de concorrência é a `walletId`. Toda operação que lê ou altera saldo (`ProcessWagerTransactionUseCase`, `PendingReferenceWorker` e `ReconcileWalletUseCase`) segue a mesma ordem de lock dentro da transação SQL: primeiro trava a linha em `wallets` com `SELECT ... FOR UPDATE`, depois checa a idempotência por `idempotency_key` e `(provider_id, external_transaction_id)`. Em seguida, executa as regras de domínio, atualiza a wallet checando o `version` esperado (`WHERE id = $1 AND version = $2`), grava a transação, insere o lançamento no ledger e grava os eventos na outbox no mesmo commit.

Essa ordem evita lock global entre carteiras diferentes e serializa disputas simultâneas na mesma hot wallet entre várias instâncias. Como todas as transações travam `wallets` antes de `wager_transactions`, também não há deadlock com o `PendingReferenceWorker`. A coluna `version` começa em `1` na abertura da carteira e só sobe quando o saldo muda.

No schema criado em `Migration202611190001_InitialSchema`, as principais invariantes ficam protegidas direto no PostgreSQL:

- `wallets` tem `UNIQUE (player_id, currency)`, `CHECK (balance >= 0)` e `CHECK (version >= 1)`.
- `wager_transactions` tem `UNIQUE (idempotency_key)`, `UNIQUE (provider_id, external_transaction_id)` e o índice único parcial `uq_wager_tx_single_processed_reversal` em `(reference_transaction_id, kind) WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK') AND reference_transaction_id IS NOT NULL`, impedindo reversão dupla mesmo em corrida.
- `wallet_ledger_entries` tem `UNIQUE (wallet_id, transaction_id)`, `CHECK (amount > 0)`, `CHECK` aritmético conferindo `balance_before ± amount = balance_after` e a trigger `trg_wallet_ledger_immutable` bloqueando qualquer `UPDATE` ou `DELETE`.
- `inbox_messages` usa chave primária composta `(consumer_name, message_id)`.

## Idempotência e hash de payload

`POST /wagering/transactions` exige o header `Idempotency-Key` (padrão recomendado: `{providerId}:{externalTransactionId}`). Antes de gerar o hash SHA-256 em `src/shared/domain/canonical-json.ts`, o serviço ordena recursivamente as chaves dos campos de negócio (`providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` e `referenceExternalTransactionId`), deixando de fora propriedades `undefined`, headers e metadados de transporte.

Cada transação salva `observed_balance_amount` e `observed_balance_currency` com o saldo registrado no momento do processamento. Se o provedor reenviar a mesma chave e o mesmo payload depois de outras movimentações na carteira, a API responde com `idempotentReplay: true` e o saldo observado originalmente. Reenviar a mesma chave ou o mesmo `(providerId, externalTransactionId)` com payload diferente devolve `409 Conflict` (`IDEMPOTENCY_CONFLICT`).

## Autenticação

Por conta do prazo do desafio, a API expõe `ProviderIdentityPort` e `ProviderAuthGuard` (`src/shared/auth/auth.guard.ts`) nos endpoints de carteiras e transações. As rotas `/health/live`, `/health/ready` e o consumidor SQS ficam fora dessa autenticação.

Em produção com Keycloak ou Zitadel, os provedores obteriam JWT via `client_credentials`, um `OidcProviderIdentityAdapter` validaria a assinatura via JWKS em cache (`iss`, `aud`, `exp`) extraindo a claim `provider_id`, e o caso de uso barraria requisições em que `identity.providerId` divergisse de `body.providerId`.

## Mensageria: inbox, outbox e fora de ordem

O `SqsWagerConsumer` consome `wager-transactions.fifo` por long polling e chama o mesmo `ProcessWagerTransactionUseCase` da API HTTP, deduplicando por `(consumer_name, message_id)` na tabela `inbox_messages` dentro da transação financeira. O `DeleteMessage` só ocorre depois que o PostgreSQL confirma o commit. Se o worker cair entre o commit e o ack, o reenvio da fila encontra o registro processado na inbox e ignora sem repetir débito ou crédito.

Mensagens malformadas ou rejeitadas por conflito permanente vão para `wager-transactions-dlq.fifo` e saem da fila principal. Transações gravadas como `PROCESSED`, `REJECTED` ou `PENDING_REFERENCE` recebem ack após o commit. Falhas transitórias de banco devolvem a visibilidade com backoff exponencial até o `RedrivePolicy` (`maxReceiveCount = 5`) mover para a DLQ. No `SIGTERM`, o consumidor interrompe novos polls, aguarda as mensagens em andamento e zera o `VisibilityTimeout` das mensagens ainda não iniciadas.

Os eventos de domínio (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged` e `WagerTransactionPendingReference`) são inseridos em `outbox_messages` na mesma transação da mudança de saldo. O `OutboxPublisherWorker` busca lotes pendentes com `SELECT ... FOR UPDATE SKIP LOCKED`, permitindo múltiplos publishers em paralelo sem duplicar leitura, e publica em `wager-events.fifo` usando `aggregateId` como `MessageGroupId` e `eventId` como `MessageDeduplicationId`.

Transações `REFUND`, `ROLLBACK` (ou `WIN` com referência informada) cuja referência ainda não chegou ficam em `PENDING_REFERENCE`. O `PendingReferenceWorker` reprocessa com backoff exponencial (`500ms * 2^tentativa`, teto de 30s) até `PENDING_REF_MAX_ATTEMPTS` (padrão 10). Se o limite esgotar sem a referência aparecer, a transação muda para `REJECTED` com `failureCode: REFERENCE_NOT_FOUND` e publica `WagerTransactionRejected`.

## Códigos de falha e status HTTP

| Situação | HTTP | Código |
|---|---|---|
| Transação nova processada | `201` | `idempotentReplay: false` |
| Replay idempotente | `200` | `idempotentReplay: true` |
| Referência ausente aguardando reprocessamento | `202` | `status: "PENDING_REFERENCE"` |
| JSON malformado, `Money` inválido ou header ausente | `400` | `INVALID_JSON`, `VALIDATION_ERROR`, `MISSING_IDEMPOTENCY_KEY` |
| Carteira ou transação inexistente | `404` | `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND` |
| Carteira duplicada ou conflito de idempotência | `409` | `WALLET_ALREADY_EXISTS`, `IDEMPOTENCY_CONFLICT` |
| Regra de negócio violada | `422` | `INSUFFICIENT_FUNDS`, `REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE`, `CURRENCY_MISMATCH`, `PLAYER_MISMATCH`, `WALLET_MISMATCH`, `ROUND_MISMATCH`, `INVALID_REFERENCE_KIND`, `REFERENCE_NOT_PROCESSED`, `ALREADY_REVERSED`, `AMOUNT_MISMATCH`, `REFERENCE_NOT_FOUND` |
| Banco ou SQS indisponível | `503` | `SERVICE_UNAVAILABLE` |

## Trade-offs e limitações conhecidas

O lock pessimista (`SELECT ... FOR UPDATE`) serializa requisições que tocam a mesma carteira diretamente no PostgreSQL, evitando desperdício com retries de optimistic locking sob disputa na mesma hot wallet. Caso uma única carteira passe a receber milhares de requisições por segundo, seria necessário evoluir para fila particionada ou ator single-writer por shard de `walletId`.

As métricas em `/metrics` ficam em memória por instância; em cluster, o Prometheus faria o scrape de cada réplica pelo `instanceId` ou exportaria via OpenTelemetry. No publisher da outbox, cada evento é enviado em uma chamada SQS individual em lotes de 25 registros, o que explica eventos ainda pendentes após 1 segundo de rajada no teste de carga local; trocar para `SendMessageBatch` (até 10 mensagens por chamada) aumentaria bastante a vazão do publisher.
