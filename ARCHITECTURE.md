# ARCHITECTURE — Distributed Wagering Processor

## 1. Visão Geral e Estrutura de Camadas

O serviço foi estruturado seguindo princípios de **Domain-Driven Design (DDD)** e **Arquitetura Hexagonal (Ports & Adapters)** sobre **Bun 1.x**, **NestJS**, **TypeScript (strict mode)**, **MikroORM**, **PostgreSQL** e **AWS SQS (LocalStack)**.

```
src/
├── shared/          # Primitivas transversais (Money, FailureCode, JSON canônico, AuthGuard, Logs, Métricas)
├── domain/          # Entidades e invariantes puras (Wallet, WalletLedgerEntry, WagerTransaction, Inbox, Outbox, IntegrationEvent)
├── application/     # Casos de uso e portas (UnitOfWorkPort, repositórios transacionais)
├── infrastructure/  # Adaptadores concretos (MikroORM EntitySchema, Migrations SQL, SQS client, Workers)
└── presentation/    # Controladores HTTP e filtro global de exceções
```

A camada de domínio (`src/domain` e `src/shared/domain`) não possui dependências de NestJS, decorators de ORM ou drivers de banco. A persistência utiliza `EntitySchema` do MikroORM mapeando registros planos (`src/infrastructure/persistence/entities/records.ts`) e mappers explícitos que reconstroem as entidades via `rehydrate(...)`.

---

## 2. Escolha de ORM e Mapeamento de `Money`

### Por que MikroORM
Optou-se pelo **MikroORM** (opção preferencial do desafio) pelos seguintes motivos:
- Controle explícito de transações com `EntityManager.transactional()` e isolamento por `em.fork()`.
- Suporte nativo a `LockMode.PESSIMISTIC_WRITE` (`SELECT ... FOR UPDATE`) sobre entidades específicas.
- Separação limpa entre domínio e esquema via `EntitySchema`, evitando acoplamento do domínio com decorators de persistência.

### Representação de `Money`
- **No domínio:** `Money` encapsula `Decimal` (`decimal.js`, precisão 30, arredondamento `ROUND_HALF_UP`) e código de moeda ISO-4217 (`^[A-Z]{3}$`). Toda operação retorna uma nova instância imutável com escala fixa de 2 casas decimais. Entradas inválidas (`NaN`, `Infinity`, notação científica, strings vazias, mais de 2 casas decimais ou valores negativos em contratos de entrada) são rejeitadas por regex estrita (`/^\d+(\.\d{1,2})?$/`).
- **No banco:** Armazenado em colunas separadas `NUMERIC(19, 2)` e `CHAR(3)`. O driver PostgreSQL retorna colunas `NUMERIC` como `string`, permitindo reidratação direta em `Money.rehydrate(...)` sem passar por `number` (IEEE-754) em nenhuma etapa.
- **Multi-moeda:** Embora os fluxos de teste operem majoritariamente em `BRL`, o modelo é multi-moeda e rejeita operações entre moedas distintas tanto em `Money` quanto na validação contra a moeda da `Wallet` (`CURRENCY_MISMATCH`).

---

## 3. Estratégia Transacional, Concorrência e Invariantes de Banco

### Controle de concorrência por `walletId`
A unidade de concorrência é a `walletId`. Toda operação mutável sobre uma carteira (`ProcessWagerTransactionUseCase`, `PendingReferenceWorker`, `ReconcileWalletUseCase`) segue estritamente a mesma ordem de lock:

1. Abre transação SQL (`EntityManager.transactional()`).
2. Adquire lock pessimista na linha da wallet alvo (`SELECT ... FROM wallets WHERE id = $1 FOR UPDATE` via `LockMode.PESSIMISTIC_WRITE`).
3. Verifica idempotência (`idempotency_key` e `(provider_id, external_transaction_id)`).
4. Executa validações e mutações de domínio (`Wallet.debit` / `Wallet.credit` retornam `WalletLedgerEntry` e incrementam `version`).
5. Persiste `wager_transactions`, atualiza `wallets` verificando `version` esperado (`WHERE id = $1 AND version = $2`), insere `wallet_ledger_entries` e enfileira `outbox_messages` na **mesma transação SQL**.

**Por que essa combinação:**
- Não há lock global: carteiras distintas executam em paralelo sem contenção mútua.
- Múltiplas instâncias (3+ processos OS) competindo pela mesma *hot wallet* são serializadas pelo PostgreSQL no nível da linha da carteira, eliminando *lost updates* sem necessidade de loops de retry em carga moderada.
- A coluna `version` (iniciando em `1` e incrementada exclusivamente quando o saldo muda) atua como segunda linha de defesa otimista.
- A ordem fixa de aquisição de lock (`wallets` sempre antes de `wager_transactions`) previne deadlocks entre transações HTTP/SQS e o `PendingReferenceWorker`.

### Garantias estruturais no schema PostgreSQL (`Migration202611190001_InitialSchema`)
- `wallets`: `UNIQUE (player_id, currency)`, `CHECK (balance >= 0)`, `CHECK (version >= 1)`.
- `wager_transactions`: `UNIQUE (idempotency_key)`, `UNIQUE (provider_id, external_transaction_id)` e índice único parcial `uq_wager_tx_single_processed_reversal` em `(reference_transaction_id, kind) WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK') AND reference_transaction_id IS NOT NULL`, impedindo dupla reversão até em nível de banco.
- `wallet_ledger_entries`: `UNIQUE (wallet_id, transaction_id)`, `CHECK (amount > 0)`, `CHECK (balance_before >= 0)`, `CHECK (balance_after >= 0)`, `CHECK` aritmético validando `balance_before ± amount = balance_after` e **trigger `trg_wallet_ledger_immutable`** bloqueando `UPDATE` e `DELETE` na tabela.
- `inbox_messages`: chave primária composta `(consumer_name, message_id)`.

---

## 4. Idempotência e Algoritmo de Payload Hash

- O header `Idempotency-Key` é obrigatório em `POST /wagering/transactions` (padrão recomendado para provedores: `"{providerId}:{externalTransactionId}"`).
- **JSON Canônico (`src/shared/domain/canonical-json.ts`):** antes do hash, o subconjunto de campos de negócio (`providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money`, e `referenceExternalTransactionId` quando presente) tem suas chaves ordenadas recursivamente em ordem lexicográfica, ignorando propriedades `undefined`, headers e metadados de transporte. O resultado serializado em UTF-8 recebe hash **SHA-256**.
- **Replay fiel:** `wager_transactions` armazena `observed_balance_amount` e `observed_balance_currency` capturados no momento da conclusão original. Reenvios com a mesma chave e mesmo `payloadHash` retornam o mesmo `transactionId`, `status`, `failureCode` (se houver) e o **saldo observado naquele instante**, com `idempotentReplay: true`.
- **Conflito:** reutilizar a mesma `Idempotency-Key` ou `(providerId, externalTransactionId)` com `payloadHash` distinto retorna `409 Conflict` (`IDEMPOTENCY_CONFLICT`).

---

## 5. Autenticação e Autorização (Seção 2)

Seguindo a diretriz do desafio de priorizar o núcleo financeiro no timebox, a autenticação HTTP não foi acoplada a um Identity Provider em execução, mas possui fronteira arquitetural explícita:

- **No código:** `ProviderIdentityPort` (`src/shared/auth/auth.guard.ts`) define o contrato de resolução de identidade de provedor, conectado ao `ProviderAuthGuard` aplicado nos controllers de domínio (`WalletsController` e `WageringController`). Endpoints de saúde (`/health/live`, `/health/ready`) e o canal interno SQS ficam deliberadamente fora da guarda HTTP.
- **Desenho alvo para produção (Keycloak / Zitadel OIDC):**
  1. Provedores autenticam via `client_credentials` (OAuth2/OIDC) no Keycloak/Zitadel e enviam `Authorization: Bearer <JWT>`.
  2. Um `OidcProviderIdentityAdapter` validaria assinatura via JWKS em cache, `iss`, `exp`, `aud` e extrairia a claim `provider_id`.
  3. O controller/use case confrontaria `identity.providerId === body.providerId`, impedindo que um provedor submeta ou consulte transações em nome de outro.

---

## 6. Mensageria Assíncrona: Inbox, Outbox e Out-of-Order

### Consumidor SQS (`SqsWagerConsumer`)
- Consome `wager-transactions.fifo` por long polling e reutiliza exatamente o mesmo `ProcessWagerTransactionUseCase` da API HTTP.
- Deduplicação persistente na tabela `inbox_messages` por `(consumer_name, message_id)` dentro da mesma transação SQL da operação financeira.
- **Ack pós-commit:** `DeleteMessage` só é chamado após a transação no PostgreSQL confirmar o commit. Se o worker cair entre o commit e o ack, a redelivery do SQS encontra o registro `processed_at` na inbox e ignora sem reaplicar efeitos.
- **Classificação de erros:**
  - Payloads malformados ou erros permanentes de contrato/conflito são enviados para `wager-transactions-dlq.fifo` e removidos da fila principal.
  - Rejeições de negócio (`PROCESSED`, `REJECTED`, `PENDING_REFERENCE`) são terminais para a entrega da mensagem e recebem ack após o commit.
  - Erros transitórios (`TransientInfrastructureError`) não recebem ack; a visibilidade retorna com backoff exponencial até o `RedrivePolicy` (`maxReceiveCount = 5`) mover para a DLQ.
- **Shutdown (`SIGTERM`):** interrompe novos polls, aguarda mensagens *in-flight* e devolve visibilidade (`VisibilityTimeout = 0`) para mensagens ainda não iniciadas.

### Transactional Outbox (`OutboxPublisherWorker`)
- Eventos (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged`, `WagerTransactionPendingReference`) são gravados na tabela `outbox_messages` na mesma transação SQL da mudança de saldo/estado.
- Múltiplos publishers concorrentes usam `SELECT ... FOR UPDATE SKIP LOCKED` sobre `published_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())`, evitando contenção e publicação simultânea duplicada.
- A publicação para `wager-events.fifo` usa `MessageGroupId = aggregateId` (`walletId`) e `MessageDeduplicationId = eventId`. Falhas transitórias agendam backoff exponencial limitado a 30s.

### Transações Fora de Ordem (`PendingReferenceWorker`)
- `REFUND` e `ROLLBACK` (e `WIN` quando informa `referenceExternalTransactionId`) cuja referência ainda não existe ou não atingiu estado terminal são persistidos como `PENDING_REFERENCE`, emitindo `WagerTransactionPendingReference`.
- O `PendingReferenceWorker` reavalia periodicamente com backoff exponencial (`500ms * 2^tentativa`, teto 30s) até o limite configurável (`PENDING_REF_MAX_ATTEMPTS`, padrão `10`, totalizando janela de ~2,5 minutos para recuperação de atrasos entre filas/provedores). Esgotado o limite, transiciona para `REJECTED` com `failureCode: REFERENCE_NOT_FOUND` e publica `WagerTransactionRejected`.

---

## 7. Taxonomia de `FailureCode` e Mapeamento HTTP

| Situação | Status HTTP | Código / `failureCode` |
|---|---|---|
| Sucesso novo (`PROCESSED`) | `201 Created` | `idempotentReplay: false` |
| Replay idempotente de transação processada | `200 OK` | `idempotentReplay: true` |
| Referência ainda ausente (`PENDING_REFERENCE`) | `202 Accepted` | `status: "PENDING_REFERENCE"` |
| Payload inválido, `Money` inválido, `Idempotency-Key` ausente | `400 Bad Request` | `VALIDATION_ERROR` / `MISSING_IDEMPOTENCY_KEY` |
| Wallet ou transação inexistente | `404 Not Found` | `WALLET_NOT_FOUND` / `TRANSACTION_NOT_FOUND` |
| Wallet duplicada ou `Idempotency-Key` com payload divergente | `409 Conflict` | `WALLET_ALREADY_EXISTS` / `IDEMPOTENCY_CONFLICT` |
| Regra de negócio violada | `422 Unprocessable Entity` | `INSUFFICIENT_FUNDS`, `REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE`, `CURRENCY_MISMATCH`, `PLAYER_MISMATCH`, `WALLET_MISMATCH`, `ROUND_MISMATCH`, `INVALID_REFERENCE_KIND`, `REFERENCE_NOT_PROCESSED`, `ALREADY_REVERSED`, `AMOUNT_MISMATCH`, `REFERENCE_NOT_FOUND` |
| Erro transitório de PostgreSQL ou SQS | `503 Service Unavailable` | `SERVICE_UNAVAILABLE` |

---

## 8. Trade-offs, Limitações Conhecidas e Evolução

1. **Lock Pessimista vs Optimistic Locking puro:** Escolheu-se `SELECT ... FOR UPDATE` por `walletId` porque em *hot wallets* o optimistic locking puro gera alta taxa de retries e desperdício de CPU em conflitos. O trade-off é serializar requisições da mesma carteira no PostgreSQL; caso uma única carteira atinja milhares de TPS no futuro, recomenda-se particionamento lógico de sub-saldos ou *single-writer actor* por shard de `walletId`.
2. **Métricas em memória:** `MetricsService` expõe métricas em formato Prometheus (`GET /metrics`) e JSON (`GET /metrics/json`) por instância. Em produção multi-réplica, um scraper Prometheus agregaria por `instanceId` ou exportaria via OpenTelemetry Collector.
3. **Auth no-op no escopo atual:** A API aceita chamadas locais sem token até a plugagem do adaptador OIDC em `PROVIDER_IDENTITY_PORT`.
