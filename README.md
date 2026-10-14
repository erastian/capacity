# Program Capacity & Invoice Reservation

A NestJS service that answers one question for a supply chain finance (payables finance) programme: **can another invoice of amount X be financed under programme Y right now?**

- **Origination** (the bank's invoice approval system) reserves capacity over REST when an invoice is approved for early payment.
- **Treasury** owns the money facts and sends them over Kafka: limits, external utilisation, programme status, FX quotes, payouts, payment allocations, write-offs, cancellations, reversals, bulk reconciliation snapshots.
- Capacity is released **only** on treasury facts. The service takes capacity on its own; it gives capacity back only on evidence from whoever sees the money.

Key decisions in one breath: Postgres is the single source of truth and the capacity invariant is held by one conditional `UPDATE` under a row lock (no Redis, no distributed locks); every treasury message is decided exactly once (inbox), out-of-order data is parked rather than rejected, every outgoing event goes through a transactional outbox, money is `decimal` end to end and amounts travel as strings, and every journal is append-only and enforced by database grants, not by code discipline.

## Requirements

- **Docker** with Docker Compose v2, and **internet access to pull images** on first run:
  | Image | Version | Used by |
  |---|---|---|
  | `postgres` | `17` | compose, e2e tests |
  | `quay.io/keycloak/keycloak` | `26.3` | compose (identity provider) |
  | `apache/kafka` | `4.3.1` | compose (broker and one-shot `kafka-init`), e2e tests |
  | `ghcr.io/kafbat/kafka-ui` | `v1.4.2` | compose (Kafka UI) |
  | `testcontainers/ryuk` | pulled by Testcontainers | e2e tests (container cleanup) |
- **Node.js 24** (`engines: >=24 <25`) with npm 11. Node 24 also runs the TypeScript treasury simulator directly, no build step.
- Free ports: `3000` (API), `9464` (metrics), `5432` (Postgres), `8080` (Keycloak), `9092` (Kafka), `8081` (Kafka UI).
- Internet access for `npm ci`: the npm registry and `binaries.prisma.sh` (the Prisma CLI downloads its schema engine for migrations at install). Nothing is compiled locally: the Kafka client is pure TypeScript and the Prisma query layer runs on the `pg` driver adapter.
- npm 11 blocks dependency install scripts by default. `allowScripts` in `package.json` permits only the Prisma ones (Node version check, schema engine download) and denies the optional ones (`ssh2`, `cpu-features`, `protobufjs`), so `npm ci` runs without `node-gyp` and `npm install-scripts ls` is empty.

## Quick start

```bash
cp .env.example .env
docker compose up -d                 # Postgres, Keycloak (realm imported), Kafka with SASL + ACLs, Kafka UI
npm ci                               # postinstall runs prisma generate into src/generated/prisma (reads .env)
npx prisma migrate deploy            # runs as the schema owner role, see "Database roles"
npm run start:dev                    # API on :3000, metrics on :9464

npm run simulate -- demo             # programme P-DEMO of C-ACME + fresh FX quotes
npm run simulate -- all              # every treasury scenario, printed step by step
```

- `http/*.http` — ready requests for the WebStorm HTTP client (environment `local`): run `auth.http` first, it stores tokens for origination, operator, auditor and a buyer.
- Kafka UI: <http://localhost:8081>. Keycloak admin: <http://localhost:8080> (`admin` / `admin`).
- `.env.example` holds only what has no default (connections and credentials). Every setting, with its default and validation, is in `src/config/env.ts` (intervals, thresholds, TTLs, feature flags).
- Local users (password = username): `operator`, `auditor`, `buyer-acme` (client `C-ACME`), `buyer-globex` (client `C-GLOBEX`); service client `origination` / `origination-local-secret`.
- Simulator scenarios: `demo`, `rates`, `onboarding`, `reserve-fund-repay`, `fx-payment` (a payment waits for its FX quote, then applies), `limit-cut` (limit excess), `currency-mismatch` (programme on hold until treasury fixes it), `bulk-batch`. FX quotes older than 6 h are stale for reservations: `npm run simulate -- rates` refreshes them.

## Architecture

```
            REST (JWT)                          Kafka (SASL, ACL)
origination ─────────► reservations ──┐   treasury ──► treasury.* ──► inbound consumer
buyers, ops, audit ──► read API       │                               │ adapter (anti-corruption layer)
                                      ▼                               ▼
                               ┌─────────────── Postgres ───────────────┐
                               │ program · reservation · release · ledger │
                               │ inbox · parked · breaks · fx_rate        │
                               │ outbox_event                             │
                               └──────────────────────────────────────────┘
                                      │ outbox relay (single leader)
                                      ▼
                     capacity.reservation-events · capacity.message-status · capacity.dlq
```

Modules by subject: `reservations` (reserve + reads), `treasury` (inbound adapter, decisions, processor, consumer), `programs`, `rates`, `audit`, `operations` (monitors, internal reconciliation, cleanup), `outbox`, `shared` (auth, db, errors, http, kafka, money, time). Domain decisions are pure functions with unit tests (`*/domain/*`); persistence is raw SQL through Prisma where the SQL matters (locks, conditional updates, keyset pages).

The treasury inbound side is deliberately split this way: every decision is a pure function in `treasury/domain/` with its own tests, SQL lives in per-aggregate repositories under `treasury/persistence/` (inbox and parked queue, programme state, settlements, breaks, quotes, batches), and `inbound.processor.ts` is a transaction script that only applies decided effects. It stays one file on purpose: one treasury message is one transaction, and its whole path (lock, duplicate check, park, decide, apply, status) reads top to bottom in one place.

**Reserve** (`POST /v1/reservations`, `Idempotency-Key` required), one transaction:
1. advisory lock on `(client, key)`; a stored outcome is replayed as is;
2. `SELECT … FOR UPDATE` on the programme, then checks in a fixed order: visible programme → invoice not reserved yet → due date → status → no blocking break → FX quote (valuation, active, fresh) → capacity;
3. `UPDATE program SET reserved = reserved + x WHERE … AND reserved + external_utilized + x <= credit_limit` decides; zero rows means re-classify;
4. reservation, ledger entry and `RESERVATION_CREATED` in the outbox, all in the same transaction. Declines (credit decisions) are journalled and published as `RESERVATION_DECLINED`.

Exposure in the programme currency is `ceil(outstanding × valuation rate, 4)`; a release returns `exposure before − exposure after`, so the last payment returns the exact remainder and exposure is never understated.

**Treasury message**, one transaction per message: lock the programme → duplicate check (inbox and parked queue) → adapter turns the envelope into a command → pure decision → effects (balances, ledger, breaks, outbox) → status `ACCP` / `RJCT` / `PDNG` to `capacity.message-status`. The Kafka offset is committed only after the database commit. Messages that lack data (programme not created yet, FX quote not arrived, an earlier message of the same reservation still waiting) are **parked**, not rejected, and replayed in treasury order as soon as the data arrives; the outcome does not depend on arrival timing. A periodic sweep (`PARKED_SWEEP_INTERVAL_MS`) replays whatever a failed wake-up left behind and completes reconciliation batches whose last snapshot is already in.

**Failures on the consumer path**: a transient error (lost connection, timeout, deadlock, serialization failure) is retried with backoff for as long as it lasts, and the stream is reopened after a broker or consumer group error. A message that fails on its data (a Postgres data exception or CHECK violation) is rejected at once; any other error is rejected after `INBOUND_MAX_ATTEMPTS` (10) attempts. Rejection records `RJCT PROCESSING_FAILED`, copies the message to `capacity.dlq` and raises `POISON_MESSAGE`; the inbox row is written before the DLQ copy, and a redelivery copies it again, so the copy is not lost. A parked message whose replay fails the same way is rejected by the same rule (attempts are counted per sweep) and the queue of its programme moves on. Consumer state is the `treasury_consumer_up` gauge, failed attempts are `treasury_processing_failures_total`; neither takes the REST API out of rotation.

**Outbox relay**: one leader via a session advisory lock, batches in id order, idempotent producer with `acks=all`, `published_at` set only after the broker acknowledges. Delivery is at least once; consumers deduplicate by `event_id`.

## API

All endpoints require a bearer JWT from the identity provider (signature via JWKS, `iss`, `aud`, `exp`). Access is by scope; a foreign or unknown resource is `404`, not `403`. Errors are RFC 9457 `application/problem+json` with a machine `code`. Lists use keyset pagination: `limit` (default 50, max 200), opaque `cursor`, response `{ items, nextCursor }`.

| Endpoint | Scope | Roles | Purpose |
|---|---|---|---|
| `POST /v1/reservations` | `reservations:write` | origination | reserve capacity for an approved invoice |
| `GET /v1/declines?invoiceId=` | `reservations:write` | origination | the caller's own declines for an invoice (reconciliation after a lost response) |
| `GET /v1/programs` | `programs:read:all` / `programs:read:own` | origination, operator, auditor; buyer: own programmes only | visible programmes with availability |
| `GET /v1/programs/:id/availability` | `programs:read:all` / `programs:read:own` | origination, operator, auditor; buyer: own programmes only | limit, external utilisation, reserved (committed vs funded), available, over limit, on hold, as of |
| `GET /v1/reservations?programId=&invoiceId=&status=` | `programs:read:all` / `programs:read:own` | origination, operator, auditor; buyer: own programmes only | reservations with outstanding debt and capacity |
| `GET /v1/reservations/:id` | `programs:read:all` / `programs:read:own` | origination, operator, auditor; buyer: own programmes only | card: debt movements (payments as paid, with FX rate and settled amount), pending messages; breaks of the reservation only with `breaks:read` (operator, auditor) |
| `GET /v1/reservations/:id/payoff-quote?currency=` | `programs:read:all` / `programs:read:own` | origination, operator, auditor; buyer: own programmes only | amount to pay off, converted at the current treasury quote |
| `GET /v1/fx-rates?from=&to=&type=` | `programs:read:all` | origination, operator, auditor | current treasury quotes |
| `GET /v1/breaks`, `GET /v1/programs/:id/breaks` | `breaks:read` | operator, auditor | reconciliation breaks with treasury |
| `GET /v1/audit/{ledger,inbox,parked,fundings,outbox,declines}` | `audit:read` | auditor | append-only journals |
| `GET /v1/audit/reconciliation` | `audit:read` | auditor | internal reconciliation on demand |
| `GET /health/live`, `GET /health/ready` | — | public | probes; ready checks the database within 2 s; Kafka state is a metric, so a broker outage does not stop reservations |

**Idempotency of `POST /v1/reservations`** (following the IETF `Idempotency-Key` draft):
- The client generates the key, one per logical reservation attempt (a UUID or `invoiceId:attempt`), and stores it before sending, in the same transaction that approves the invoice (an outbox on the client side). A retry after a timeout, a lost connection or a crash then reuses the key and gets the stored response back (`Idempotent-Replayed: true`) instead of creating a second reservation.
- A new attempt after circumstances change (the programme was suspended and is active again) uses a new key: one key, one outcome.
- Keys are scoped to the calling client (`sub`), 8–255 characters of `[A-Za-z0-9._:-]`, kept for at least `IDEMPOTENCY_TTL_SECONDS` (7 days) and until the next cleanup run (stored outcomes are immutable, so an expired key is reusable only once the cleanup has removed it). The same key with a different body is `422 IDEMPOTENCY_KEY_REUSED`.
- Stored: every outcome of an attempt that reached execution — success and business errors (`404`, `409`, `422` declines). Not stored: `401`, `403`, `422 VALIDATION_FAILED` and `5xx` (nothing happened, a corrected retry with the same key is legitimate).
- A retry that lost its key still cannot double-reserve: `invoiceId` is unique, the answer is `409 INVOICE_ALREADY_RESERVED` with the existing reservation in the body, so the client can reconcile without manual work.

The service checks scopes only; roles are the identity provider's configuration (the local Keycloak realm), so the bank can regroup them without code changes. A buyer's `programs:read:own` is bound to the `client_ref` claim of its token. `reservations:write` alone is enough to reserve: it is the bank's origination scope and reaches every programme.

Signing keys are cached without expiry and refreshed in the background every 10 minutes; a token with an unknown `kid` triggers an immediate reload (key rotation). If the identity provider is down, the last good key set stays in use and the failure is logged, so an IdP outage does not lock everyone out. The price: a key withdrawn while the IdP is unreachable stays trusted until the next successful refresh.

## Kafka contract

| Topic | Key | Producer → consumer |
|---|---|---|
| `treasury.program-capacity` | `programId` (`batchId` for a batch trailer) | treasury → capacity |
| `treasury.fx-rates` | `from:to:rateType` | treasury → capacity |
| `capacity.reservation-events` | `programId` | capacity → payments, risk, treasury |
| `capacity.message-status` | key of the original message | capacity → treasury |
| `capacity.dlq` | original key | capacity → ops |

Envelope: `messageId`, `type`, `schemaVersion`, `programId`, `batchId`, `version`, `asOf`, `payload`. Inbound types: `PROGRAM_SNAPSHOT`, `LIMIT_UPDATED`, `EXTERNAL_UTILIZATION_UPDATED`, `PROGRAM_STATUS_CHANGED`, `PROGRAM_REINSTATED`, `FX_RATE_PUBLISHED`, `INVOICE_FUNDED`, `INVOICE_FUNDING_RETURNED`, `INVOICE_PAYMENT_ALLOCATED`, `INVOICE_BALANCE_WRITTEN_OFF`, `INVOICE_FUNDING_CANCELLED`, `INVOICE_RELEASE_REVERSED`, `BREAK_RESOLVED`, `RECONCILIATION_BATCH_COMPLETED`. Amounts and rates are decimal strings with an explicit currency. Each programme field carries its own monotonic version; order comes from versions, not timestamps. Every message gets a status, modelled on ISO 20022 `pacs.002`: `ACCP`, `RJCT` with a reason code, or `PDNG` with what it waits for. Formal rejections (`INVALID_FORMAT`, `UNKNOWN_MESSAGE_TYPE`, `UNSUPPORTED_SCHEMA_VERSION`) and `PROCESSING_FAILED` are also copied to `capacity.dlq`; an unreadable envelope (not JSON, no `messageId`, a NUL character) goes to the DLQ only, since there is nothing to answer.

Outgoing events share one envelope: `eventId`, `schemaVersion` (1), `type`, `occurredAt`, `correlationId`, `data`; Kafka headers repeat `event-id`, `event-type` and `correlation-id`. Amounts are decimal strings: invoice amounts at the currency's minor units, capacity amounts (programme currency) at 4 places. `data` by type:

| Type | `data` |
|---|---|
| `RESERVATION_CREATED` | `reservationId`, `programId`, `invoiceId`, `status`, `originalAmount`, `originalCurrency`, `amount`, `currency`, `fxRateId`, `dueDate`, `outstanding`, `capacityOutstanding`, `reservedAfter`, `available` |
| `RESERVATION_RELEASED`, `RESERVATION_CANCELLED`, `RESERVATION_RELEASE_REVERSED` | `reservationId`, `programId`, `invoiceId`, `releaseId`, `externalRef`, `reason`, `reversesReleaseId`, `cancellationReason`, `writeOffReason`, `originalAmount`, `originalCurrency`, `amount`, `currency`, `status`, `outstanding`, `capacityOutstanding`, `reservedAfter`, `available` (amounts of this release; balances after it) |
| `RESERVATION_DECLINED` | `programId`, `invoiceId`, `requestedAmount`, `requestedCurrency`, `code`, `details` |
| `PROGRAM_BREAK_OPENED` | `breakId`, `programId`, `reservationId`, `reason`, `blocking`, `messageId`, `details` |
| `PROGRAM_BREAK_RESOLVED` | `breakId`, `programId`, `reservationId`, `reason`, `blocking`, `resolutionMessageId` |
| `PROGRAM_LIMIT_EXCESS_STARTED`, `PROGRAM_LIMIT_EXCESS_ENDED` | `programId`, `overLimit` (`0.0000` on `ENDED`), `currency`, `creditLimit`, `externalUtilized`, `reserved`, `causeMessageId` |
| `INBOUND_MESSAGE_STATUS` | `messageId`, `status`, `reason`, `awaitingKind`, `awaitingRef`, `references`, `asOf` |

A new field is added within `schemaVersion` 1; renaming or removing one raises the version.

## Assumptions and trade-offs

**Domain**
- Programmes are payables finance with an irrevocable payment undertaking by the buyer: credit notes and disputes after approval do not reduce the debt to the bank and are not sent to the service. Programmes without IPU are a different product.
- `externalUtilized` from treasury never includes invoices reserved here; exposure of an invoice lives only in its reservation here.
- `invoiceId` is a unique id from origination and is never reused; one invoice, one reservation for life.
- Tenor rules (maximum tenor, minimum days to maturity, grace before overdue) belong to credit and the programme agreements and are applied by origination before it reserves; the service only refuses a due date already in the past.
- Origination is the only REST writer and chooses the programme; cancellations go to treasury, which reports the outcome.
- The treasury message contract is designed here as an assumption, summarised in [Kafka contract](#kafka-contract).
- Limits are not hierarchical (obligor, group) and there are no sub-limits per supplier or tenor; treasury sets programme limits consistently with them.
- No revaluation of FX exposure: exposure is fixed at the reservation rate. Banks revalue daily, and a currency move alone can cause a limit excess. Next step: `FX_REVALUATION` at the current valuation quote, a revaluation ledger entry, excess handled by the existing `overLimit` rules.
- The payoff quote is informational and accepts a quote of any age: it returns the quote's `rateId` and `asOf`, the operator passes `rateId` to treasury with the allocation, and treasury checks the quote's validity under its own grace period. Reservations, by contrast, refuse a valuation quote older than `FX_RATE_MAX_AGE_SECONDS`.
- No cross rates, holiday calendars, value dates, cut-offs or multiple legal entities. The business date uses `BUSINESS_TIMEZONE` (default `Europe/London`).
- Treasury silence does not block reservations (an outage of Kafka or treasury would otherwise stop financing); it raises `TREASURY_DATA_STALE`.

**FX quotes come from Kafka, not from a rate service.** In a bank the source of truth is the market data service, where quotes are immutable and addressable by id, including history. The service subscribes to its distribution and keeps an immutable replica; reservations and payments refer to quotes by `rateId`, values are never copied into them. Why a replica instead of a call by `rateId`: reservations do not depend on the rate service being up (a stale quote is caught by `FX_RATE_STALE`), revaluation (the next step) needs the whole current set locally, and limit and risk systems are usually built this way. The price is a race between topics (a payment before its quote), closed by parking.

**Kafka client.** `@platformatic/kafka` is a deliberate choice after comparing live Node.js clients: `kafkajs` has been unmaintained since 2023 and Kafka 4.x removed the old protocol versions it relies on; `@confluentinc/kafka-javascript` (librdkafka) is the most mature but a native module whose install downloads binaries from GitHub, a failure point for "runnable locally". `@platformatic/kafka` is pure TypeScript and actively developed, but young and officially tested against Kafka 3.5–4.2; compatibility with 4.3.1 is covered by the e2e tests of this repository. The client sits behind the service's own publisher and consumer interfaces; fallbacks are the Confluent client or a 4.2 broker. One youth issue is guarded explicitly: the client emits `'error'` events nobody listens to, so a connection reset during the SASL handshake or a failed group rejoin would crash the process. Every connection gets a listener through the client's `plt:kafka:instances` diagnostics channel (the failure still reaches the caller of `send` or `consume`), and the consumer's own `'error'` closes the stream so the reopen loop takes over.

**Security in production** (outside the module)
- Kafka: mTLS instead of passwords, credential rotation, message signing (JWS) if the transport is not trusted. Locally: SASL/PLAIN principals `treasury`, `capacity`, `consumer` with topic ACLs, `LogAppendTime` on treasury topics.
- History is append-only by database grants: the application role cannot update or delete the ledger, inbox, releases or quotes. Current state is not: the application role updates programme balances and could, in principle, write a balance together with a matching ledger row; internal reconciliation checks totals against details, it does not prove who wrote them. The maintenance role may delete outbox rows, and only the code limits it to published ones. The schema owner technically can do anything. In production that is closed by separation of duties (owner credentials only in the migration pipeline, break-glass access through PAM with approval and session recording) and by `pgaudit` shipping privileged DML and DDL to the bank's SIEM. Next step in code: a hash chain over the ledger with the chain head periodically published outside the database.
- Row-level security in Postgres is the next step after the single visibility point in code.

**Operations**
- Logs are structured JSON to stdout (twelve-factor). Shipping, storage and retention (ELK, Loki, SIEM) belong to the platform. Logs are diagnostics, not audit: the audit trail is in the database journals and exposed under `/v1/audit/*`. Every alert is also a metric for alerting rules.
- Internal reconciliation (totals against details, daily and on demand) costs proportionally to the live book and daily growth: live reservations only, incremental checks from persisted watermarks, a full sweep every 7 days, short transactions. In production it belongs on a read replica.
- Timers are `setInterval` from process start, not cron: the daily run is not "at 02:00".
- Monitors keep their last state in memory: with several instances each logs its own transitions. Their gauges are database-wide and every instance exports the same value, so alerting rules take `max` across instances, not `sum`.
- Treasury alert and decision counters are recorded after the transaction commits, so a retried message counts once; consumer lag is observed once per delivered message.
- Records are never deleted by the module (except the outbox transport and expired idempotency keys). Retention follows the bank's policy (at least the regulatory minimum, e.g. FCA record keeping, but not forever under UK GDPR) and would use time partitions.
- Scaling path for the relay: shard by `hash(program_id) % N`. An alternative to the relay is CDC (Debezium).
- The capacity ledger records movements of limit, utilisation and reservations only. Status changes of a programme are not ledger entries: their history is the inbox and the programme's `status_version`.
- A reconciliation batch counts every distinct programme snapshot received under its `batchId`, rejected ones included: the batch checks delivery, and a rejected snapshot already has its own status and break.
- `DB_TX_MAX_WAIT_MS` (5 s) bounds the wait for a pooled connection. A burst beyond the pool gets `503 BUSY` with `Retry-After: 1`; the client retries with the same `Idempotency-Key`. Other transient database failures (deadlock, serialization failure, statement or lock timeout, lost connection, an expired transaction) return `503 DATABASE_UNAVAILABLE` with `Retry-After: 1`; everything else is a 500. Every database connection (Prisma pool, relay leader, maintenance pool) carries `statement_timeout`, `lock_timeout` and `idle_in_transaction_session_timeout` equal to `DB_TX_TIMEOUT_MS`, a client-side query timeout one second longer, and TCP keepalives, so a hung or unreachable database frees pool slots instead of holding them until TCP gives up. The e2e test with 100 concurrent reservations raises the wait to 30 s, since it asserts the capacity invariant, not queueing.
- The outbox relay publishes in id order and stops on a publish error rather than skip an event: a deterministic failure (missing topic, ACL) is a configuration error, and skipping would leave a gap in a programme's event stream. The stall is visible as `capacity_outbox_oldest_unpublished_seconds` and `OUTBOX_STALLED` past `OUTBOX_MAX_LAG_SECONDS` (5 min).
- Indexes cover the hot paths (availability, the reservation card, the parked queue, open breaks, the overdue monitor). Audit lists with filters sort by time over the whole journal; at bank volume they would get time partitions together with retention.
- The DLQ is a copy for operations; there is no automatic redrive. A fixed message is resent by treasury under a new `messageId`.
- A parked message whose replay fails raises `PARKED_REPLAY_FAILED` and holds the queue of its programme until it succeeds or is rejected as `PROCESSING_FAILED`; a transient error (the database is down) holds it for as long as it lasts. Replay attempts are counted in memory, so a restart starts the count again. The DLQ copy of a parked message is its envelope as stored, not the original bytes.
- A message that reverses another programme's release (`PROGRAM_MISMATCH`) locks two programmes. With several instances on different partitions two such messages can deadlock; Postgres detects it within `deadlock_timeout` and the consumer retries (on the parked sweep the replay waits for the next sweep). Locking in a fixed order is the fix if it shows up in practice.
- Reservation `created_at` is the transaction start time (`now()` in Postgres) and `occurredAt` of events is the application clock, so neither is strictly ordered with the ledger; order comes from ledger and outbox ids.
- A break is keyed by its reason and an essence; for `FUNDING_CONFLICT`, `OVERPAYMENT`, `EXTERNAL_REF_CONFLICT` and similar the essence is the reservation, so a second distinct problem of the same reason on the same reservation joins the open break instead of opening a new one.
- The deadline of a reconciliation batch is the trailer's broker timestamp plus the grace period; a consumer catching up on a backlog can raise `RECONCILIATION_BATCH_INCOMPLETE` that clears once the snapshots are read.
- A snapshot is applied whole or not at all: one invalid field (a status transition, a version conflict) rejects the newer limit and utilisation in it too, and the next snapshot carries them again.
- A redelivered message gets its status again without `references` (`breakId`, `releaseId`, `conflictsWith`); the original status carried them.
- Internal reconciliation on demand is not single-flight: two parallel calls do the same read-only work twice. The endpoint needs `audit:read` and its cost is bounded by the incremental design.
- The metrics port is unauthenticated and listens on all interfaces, as Prometheus scraping usually is; access is restricted by network policy.
- No generated OpenAPI/Swagger, a deliberate trade-off. The API is documented in the [API](#api) section above and as runnable requests in `http/*.http`.
- `overrides` in `package.json` lift `mysql2` and `deepmerge-ts` inside the Prisma CLI (dev dependency, never in the runtime) past their advisories, since no patched Prisma 7.x exists. MySQL is not used and the config merge sees only the local `prisma.config.ts`. Remove them once a fixed Prisma release is out.

## Database roles

Roles and the database are created outside migrations (`docker/postgres/init`, in production by infrastructure):
- `capacity_migrator` owns the schema and runs migrations; the application never uses it.
- `capacity_app` is the application: column-level `UPDATE` grants (a new column is immutable until explicitly granted), no `DELETE` anywhere.
- `capacity_maintenance` only selects and deletes from the outbox and idempotency tables (cleanup job).

Rules Prisma cannot express (CHECK constraints, partial indexes, grants) are appended to the migration SQL. The schema has a single `init` migration.

## Testing

```bash
npm test            # unit: domain decisions, adapter, money, versioning, pagination
npm run test:e2e    # e2e on Testcontainers: real Postgres 17 and Kafka 4.3.1
npm run lint        # oxlint
npm run typecheck   # tsc over src, test and scripts
```

E2e tests cover: every database guard (CHECKs and grants, per role), authentication and scopes, reserve (all decline paths, idempotency, 100 concurrent reservations against a limit of 60), every treasury message type and its decision table, parking and replay order, breaks and their closing conditions, reconciliation batches, read API visibility ("A does not see B" on every endpoint), audit journals, monitors, internal reconciliation and cleanup, and the real Kafka path (relay ordering, leader failover, consumer, DLQ, and payments releasing capacity end to end: REST reservation → allocation through the broker → `RESERVATION_RELEASED` back on the bus, including an invoice in another currency paid in a third one).

CI is not set up yet. Next step: a GitHub Actions pipeline running `npm ci`, lint, type check, build, unit and e2e tests on every push and pull request (Testcontainers runs on the hosted Ubuntu runners, no external services needed).

## Observability

Metrics on `:9464/metrics` (Prometheus): consumer lag, consumer up, failed processing attempts, age of the oldest unpublished outbox event, decisions by type and outcome, duplicates, dead letters, alerts, overdue reservations (funded vs unfunded), aged parked messages, stale programmes, internal reconciliation mismatches by check, plus default Node.js metrics. Correlation id comes from `X-Correlation-Id`, else `traceparent`, else is generated; it is returned in responses and carried into logs and outbox events.

Alerts: `LIMIT_EXCESS`, `RESERVATION_OVERDUE`, `PARKED_MESSAGE_AGED`, `TREASURY_DATA_STALE`, `RECONCILIATION_BATCH_INCOMPLETE`, `BATCH_CONFLICT`, `FX_RATE_CONFLICT`, `DLQ_MESSAGE`, `POISON_MESSAGE`, `PARKED_REPLAY_FAILED`, `INTERNAL_RECONCILIATION_FAILED`, `TREASURY_CLOCK_SKEW`, `CONSUMER_LAG`, `OUTBOX_STALLED`.