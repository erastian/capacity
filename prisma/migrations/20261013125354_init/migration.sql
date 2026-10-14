-- CreateEnum
CREATE TYPE "ProgramStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "OutboundEventType" AS ENUM ('RESERVATION_CREATED', 'RESERVATION_RELEASED', 'RESERVATION_CANCELLED', 'PROGRAM_BREAK_OPENED', 'PROGRAM_BREAK_RESOLVED', 'RESERVATION_RELEASE_REVERSED', 'RESERVATION_DECLINED', 'PROGRAM_LIMIT_EXCESS_STARTED', 'PROGRAM_LIMIT_EXCESS_ENDED', 'INBOUND_MESSAGE_STATUS');

-- CreateEnum
CREATE TYPE "BreakReason" AS ENUM ('CURRENCY_MISMATCH', 'VERSION_CONFLICT', 'OVERPAYMENT', 'FX_SETTLED_AMOUNT_MISMATCH', 'UNKNOWN_INVOICE', 'CANCELLATION_AFTER_SETTLEMENT', 'PROGRAM_MISMATCH', 'INVALID_STATUS_TRANSITION', 'UNKNOWN_RELEASE', 'FUNDED_AFTER_CANCELLATION', 'FUNDING_CONFLICT', 'FX_RATE_MISMATCH', 'CANCELLATION_WHILE_FUNDED', 'CLIENT_MISMATCH', 'EXTERNAL_REF_CONFLICT');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('ACTIVE', 'PARTIALLY_RELEASED', 'RELEASED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReleaseReason" AS ENUM ('REPAYMENT', 'CANCELLATION', 'REVERSAL', 'WRITE_OFF');

-- CreateEnum
CREATE TYPE "FxRateType" AS ENUM ('VALUATION', 'CONVERSION');

-- CreateEnum
CREATE TYPE "FxRateStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('RESERVE', 'RELEASE', 'TREASURY_LIMIT_UPDATED', 'TREASURY_EXTERNAL_UTILIZATION_UPDATED', 'TREASURY_SNAPSHOT', 'RELEASE_REVERSAL');

-- CreateEnum
CREATE TYPE "InboundMessageType" AS ENUM ('LIMIT_UPDATED', 'EXTERNAL_UTILIZATION_UPDATED', 'PROGRAM_SNAPSHOT', 'PROGRAM_STATUS_CHANGED', 'RECONCILIATION_BATCH_COMPLETED', 'INVOICE_FUNDED', 'INVOICE_PAYMENT_ALLOCATED', 'INVOICE_FUNDING_CANCELLED', 'FX_RATE_PUBLISHED', 'BREAK_RESOLVED', 'INVOICE_RELEASE_REVERSED', 'PROGRAM_REINSTATED', 'INVOICE_FUNDING_RETURNED', 'INVOICE_BALANCE_WRITTEN_OFF');

-- CreateEnum
CREATE TYPE "AwaitingKind" AS ENUM ('FX_RATE', 'PROGRAM', 'PRECEDING_MESSAGE');

-- CreateEnum
CREATE TYPE "InboundMessageOutcome" AS ENUM ('APPLIED', 'STALE', 'REJECTED');

-- CreateTable
CREATE TABLE "program" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "external_id" TEXT NOT NULL,
    "client_ref" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "credit_limit" DECIMAL(20,4) NOT NULL,
    "external_utilized" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "reserved" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "status" "ProgramStatus" NOT NULL DEFAULT 'ACTIVE',
    "status_reason" TEXT,
    "status_changed_at" TIMESTAMPTZ(3),
    "status_version" BIGINT,
    "credit_limit_version" BIGINT,
    "external_utilized_version" BIGINT,
    "open_blocking_breaks" INTEGER NOT NULL DEFAULT 0,
    "treasury_synced_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "program_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "program_break" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "program_id" UUID,
    "program_external_id" TEXT,
    "reservation_id" UUID,
    "reason" "BreakReason" NOT NULL,
    "blocking" BOOLEAN NOT NULL,
    "message_id" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(3),
    "resolution_message_id" TEXT,

    CONSTRAINT "program_break_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "program_id" UUID NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "original_amount" DECIMAL(20,4) NOT NULL,
    "original_currency" CHAR(3) NOT NULL,
    "fx_rate_id" UUID,
    "amount" DECIMAL(20,4) NOT NULL,
    "released_amount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "released_original_amount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "status" "ReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "due_date" DATE NOT NULL,
    "funded_at" TIMESTAMPTZ(3),
    "funding_ref" TEXT,
    "created_by" TEXT NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservation_funding" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "reservation_id" UUID NOT NULL,
    "funding_ref" TEXT NOT NULL,
    "funded_at" TIMESTAMPTZ(3) NOT NULL,
    "message_id" TEXT NOT NULL,
    "returned_at" TIMESTAMPTZ(3),
    "return_message_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reservation_funding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservation_release" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "reservation_id" UUID NOT NULL,
    "reason" "ReleaseReason" NOT NULL,
    "external_ref" TEXT NOT NULL,
    "payment_id" TEXT,
    "payment_amount" DECIMAL(20,4),
    "payment_currency" CHAR(3),
    "payment_fx_rate_id" UUID,
    "cancellation_reason" TEXT,
    "write_off_reason" TEXT,
    "original_amount" DECIMAL(20,4) NOT NULL,
    "amount" DECIMAL(20,4) NOT NULL,
    "reverses_release_id" UUID,
    "message_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reservation_release_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capacity_ledger" (
    "id" BIGSERIAL NOT NULL,
    "program_id" UUID NOT NULL,
    "type" "LedgerEntryType" NOT NULL,
    "reserved_delta" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "external_utilized_delta" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "credit_limit_delta" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "credit_limit_after" DECIMAL(20,4) NOT NULL,
    "external_utilized_after" DECIMAL(20,4) NOT NULL,
    "reserved_after" DECIMAL(20,4) NOT NULL,
    "reservation_id" UUID,
    "release_id" UUID,
    "message_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "capacity_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fx_rate" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "external_id" TEXT NOT NULL,
    "from_currency" CHAR(3) NOT NULL,
    "to_currency" CHAR(3) NOT NULL,
    "rate_type" "FxRateType" NOT NULL,
    "version" BIGINT NOT NULL,
    "rate" DECIMAL(38,18),
    "status" "FxRateStatus" NOT NULL,
    "as_of" TIMESTAMPTZ(3) NOT NULL,
    "kafka_timestamp" TIMESTAMPTZ(3) NOT NULL,
    "message_id" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fx_rate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_message" (
    "message_id" TEXT NOT NULL,
    "type" "InboundMessageType",
    "outcome" "InboundMessageOutcome" NOT NULL,
    "reason" TEXT,
    "program_id" UUID,
    "program_external_id" TEXT,
    "batch_id" TEXT,
    "version" BIGINT,
    "as_of" TIMESTAMPTZ(3) NOT NULL,
    "kafka_timestamp" TIMESTAMPTZ(3) NOT NULL,
    "topic" TEXT NOT NULL,
    "partition" INTEGER NOT NULL,
    "offset" BIGINT NOT NULL,
    "processed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_message_pkey" PRIMARY KEY ("message_id")
);

-- CreateTable
CREATE TABLE "parked_message" (
    "message_id" TEXT NOT NULL,
    "type" "InboundMessageType" NOT NULL,
    "program_id" UUID,
    "program_external_id" TEXT NOT NULL,
    "reservation_id" UUID,
    "awaiting_kind" "AwaitingKind" NOT NULL,
    "awaiting_ref" TEXT NOT NULL,
    "envelope" JSONB NOT NULL,
    "kafka_timestamp" TIMESTAMPTZ(3) NOT NULL,
    "topic" TEXT NOT NULL,
    "partition" INTEGER NOT NULL,
    "offset" BIGINT NOT NULL,
    "parked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(3),

    CONSTRAINT "parked_message_pkey" PRIMARY KEY ("message_id")
);

-- CreateTable
CREATE TABLE "outbox_event" (
    "id" BIGSERIAL NOT NULL,
    "event_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "type" "OutboundEventType" NOT NULL,
    "program_id" UUID,
    "partition_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(3),

    CONSTRAINT "outbox_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservation_decline" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "program_id" UUID NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "requested_amount" DECIMAL(20,4) NOT NULL,
    "requested_currency" CHAR(3) NOT NULL,
    "code" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "created_by" TEXT NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reservation_decline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_batch" (
    "batch_id" TEXT NOT NULL,
    "program_count" INTEGER NOT NULL,
    "completed_message_id" TEXT NOT NULL,
    "deadline_at" TIMESTAMPTZ(3) NOT NULL,
    "completed_at" TIMESTAMPTZ(3),
    "alerted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reconciliation_batch_pkey" PRIMARY KEY ("batch_id")
);

-- CreateTable
CREATE TABLE "idempotency_record" (
    "client_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_status" INTEGER NOT NULL,
    "response_body" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "idempotency_record_pkey" PRIMARY KEY ("client_id","key")
);

-- CreateTable
CREATE TABLE "reconciliation_checkpoint" (
    "check" TEXT NOT NULL,
    "watermark" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reconciliation_checkpoint_pkey" PRIMARY KEY ("check")
);

-- CreateIndex
CREATE UNIQUE INDEX "program_external_id_key" ON "program"("external_id");

-- CreateIndex
CREATE INDEX "program_client_ref_idx" ON "program"("client_ref");

-- CreateIndex
CREATE INDEX "program_break_program_id_opened_at_idx" ON "program_break"("program_id", "opened_at" DESC);

-- CreateIndex
CREATE INDEX "program_break_reservation_id_idx" ON "program_break"("reservation_id");

-- CreateIndex
CREATE INDEX "program_break_program_external_id_idx" ON "program_break"("program_external_id");

-- CreateIndex
CREATE UNIQUE INDEX "reservation_invoice_id_key" ON "reservation"("invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "reservation_funding_ref_key" ON "reservation"("funding_ref");

-- CreateIndex
CREATE INDEX "reservation_program_id_created_at_id_idx" ON "reservation"("program_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "reservation_updated_at_idx" ON "reservation"("updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "reservation_funding_funding_ref_key" ON "reservation_funding"("funding_ref");

-- CreateIndex
CREATE UNIQUE INDEX "reservation_funding_message_id_key" ON "reservation_funding"("message_id");

-- CreateIndex
CREATE UNIQUE INDEX "reservation_funding_return_message_id_key" ON "reservation_funding"("return_message_id");

-- CreateIndex
CREATE INDEX "reservation_funding_reservation_id_idx" ON "reservation_funding"("reservation_id");

-- CreateIndex
CREATE UNIQUE INDEX "reservation_release_reverses_release_id_key" ON "reservation_release"("reverses_release_id");

-- CreateIndex
CREATE UNIQUE INDEX "reservation_release_message_id_key" ON "reservation_release"("message_id");

-- CreateIndex
CREATE UNIQUE INDEX "reservation_release_reservation_id_external_ref_key" ON "reservation_release"("reservation_id", "external_ref");

-- CreateIndex
CREATE INDEX "capacity_ledger_program_id_id_idx" ON "capacity_ledger"("program_id", "id");

-- CreateIndex
CREATE INDEX "capacity_ledger_reservation_id_idx" ON "capacity_ledger"("reservation_id");

-- CreateIndex
CREATE UNIQUE INDEX "fx_rate_external_id_key" ON "fx_rate"("external_id");

-- CreateIndex
CREATE UNIQUE INDEX "fx_rate_message_id_key" ON "fx_rate"("message_id");

-- CreateIndex
CREATE UNIQUE INDEX "fx_rate_from_currency_to_currency_rate_type_version_key" ON "fx_rate"("from_currency", "to_currency", "rate_type", "version");

-- CreateIndex
CREATE INDEX "processed_message_batch_id_program_external_id_idx" ON "processed_message"("batch_id", "program_external_id");

-- CreateIndex
CREATE INDEX "processed_message_program_id_processed_at_idx" ON "processed_message"("program_id", "processed_at");

-- CreateIndex
CREATE INDEX "processed_message_program_external_id_idx" ON "processed_message"("program_external_id");

-- CreateIndex
CREATE INDEX "processed_message_program_external_id_processed_at_message__idx" ON "processed_message"("program_external_id", "processed_at" DESC, "message_id" DESC);

-- CreateIndex
CREATE INDEX "parked_message_awaiting_kind_awaiting_ref_idx" ON "parked_message"("awaiting_kind", "awaiting_ref");

-- CreateIndex
CREATE INDEX "parked_message_reservation_id_partition_offset_idx" ON "parked_message"("reservation_id", "partition", "offset");

-- CreateIndex
CREATE INDEX "parked_message_program_external_id_partition_offset_idx" ON "parked_message"("program_external_id", "partition", "offset");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_event_event_id_key" ON "outbox_event"("event_id");

-- CreateIndex
CREATE INDEX "reservation_decline_program_id_created_at_idx" ON "reservation_decline"("program_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "reservation_decline_invoice_id_idx" ON "reservation_decline"("invoice_id");

-- CreateIndex
CREATE INDEX "reservation_decline_invoice_id_created_by_created_at_idx" ON "reservation_decline"("invoice_id", "created_by", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "reconciliation_batch_completed_message_id_key" ON "reconciliation_batch"("completed_message_id");

-- CreateIndex
CREATE INDEX "idempotency_record_expires_at_idx" ON "idempotency_record"("expires_at");

-- AddForeignKey
ALTER TABLE "program_break" ADD CONSTRAINT "program_break_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "program"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "program_break" ADD CONSTRAINT "program_break_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservation"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "program_break" ADD CONSTRAINT "program_break_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "processed_message"("message_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "program_break" ADD CONSTRAINT "program_break_resolution_message_id_fkey" FOREIGN KEY ("resolution_message_id") REFERENCES "processed_message"("message_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "reservation" ADD CONSTRAINT "reservation_fx_rate_id_fkey" FOREIGN KEY ("fx_rate_id") REFERENCES "fx_rate"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "reservation" ADD CONSTRAINT "reservation_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "program"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "reservation_funding" ADD CONSTRAINT "reservation_funding_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservation"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "reservation_funding" ADD CONSTRAINT "reservation_funding_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "processed_message"("message_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "reservation_funding" ADD CONSTRAINT "reservation_funding_return_message_id_fkey" FOREIGN KEY ("return_message_id") REFERENCES "processed_message"("message_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "reservation_release" ADD CONSTRAINT "reservation_release_payment_fx_rate_id_fkey" FOREIGN KEY ("payment_fx_rate_id") REFERENCES "fx_rate"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "reservation_release" ADD CONSTRAINT "reservation_release_reverses_release_id_fkey" FOREIGN KEY ("reverses_release_id") REFERENCES "reservation_release"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "reservation_release" ADD CONSTRAINT "reservation_release_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "processed_message"("message_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "reservation_release" ADD CONSTRAINT "reservation_release_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservation"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "capacity_ledger" ADD CONSTRAINT "capacity_ledger_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "program"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "capacity_ledger" ADD CONSTRAINT "capacity_ledger_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservation"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "capacity_ledger" ADD CONSTRAINT "capacity_ledger_release_id_fkey" FOREIGN KEY ("release_id") REFERENCES "reservation_release"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "capacity_ledger" ADD CONSTRAINT "capacity_ledger_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "processed_message"("message_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fx_rate" ADD CONSTRAINT "fx_rate_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "processed_message"("message_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "processed_message" ADD CONSTRAINT "processed_message_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "program"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "parked_message" ADD CONSTRAINT "parked_message_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "program"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "parked_message" ADD CONSTRAINT "parked_message_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservation"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "outbox_event" ADD CONSTRAINT "outbox_event_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "program"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "reservation_decline" ADD CONSTRAINT "reservation_decline_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "program"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "reconciliation_batch" ADD CONSTRAINT "reconciliation_batch_completed_message_id_fkey" FOREIGN KEY ("completed_message_id") REFERENCES "processed_message"("message_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Checks: program
ALTER TABLE "program"
    ADD CONSTRAINT "program_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
    ADD CONSTRAINT "program_amounts_check" CHECK ("credit_limit" >= 0 AND "external_utilized" >= 0 AND "reserved" >= 0),
    ADD CONSTRAINT "program_open_blocking_breaks_check" CHECK ("open_blocking_breaks" >= 0);

-- Checks: program_break
ALTER TABLE "program_break"
    ADD CONSTRAINT "program_break_program_ref_check" CHECK ("program_id" IS NOT NULL OR "program_external_id" IS NOT NULL),
    ADD CONSTRAINT "program_break_blocking_check" CHECK ("program_id" IS NOT NULL OR NOT "blocking"),
    ADD CONSTRAINT "program_break_resolution_check" CHECK (("resolved_at" IS NULL) = ("resolution_message_id" IS NULL));

-- Checks: reservation
ALTER TABLE "reservation"
    ADD CONSTRAINT "reservation_currency_check" CHECK ("original_currency" ~ '^[A-Z]{3}$'),
    ADD CONSTRAINT "reservation_amounts_check" CHECK ("original_amount" > 0 AND "amount" > 0),
    ADD CONSTRAINT "reservation_released_check" CHECK (
        "released_original_amount" BETWEEN 0 AND "original_amount"
        AND "released_amount" BETWEEN 0 AND "amount"
    ),
    ADD CONSTRAINT "reservation_same_currency_check" CHECK ("fx_rate_id" IS NOT NULL OR "amount" = "original_amount"),
    ADD CONSTRAINT "reservation_status_check" CHECK (
        CASE "status"
            WHEN 'ACTIVE' THEN "released_original_amount" = 0 AND "released_amount" = 0
            WHEN 'PARTIALLY_RELEASED' THEN "released_original_amount" > 0 AND "released_original_amount" < "original_amount"
            ELSE "released_original_amount" = "original_amount" AND "released_amount" = "amount"
        END
    ),
    ADD CONSTRAINT "reservation_funding_check" CHECK (("funded_at" IS NULL) = ("funding_ref" IS NULL));

-- Checks: reservation_funding
ALTER TABLE "reservation_funding"
    ADD CONSTRAINT "reservation_funding_return_check" CHECK (("returned_at" IS NULL) = ("return_message_id" IS NULL));

CREATE UNIQUE INDEX "reservation_funding_one_active_key" ON "reservation_funding"("reservation_id") WHERE "returned_at" IS NULL;

-- Checks: reservation_release
ALTER TABLE "reservation_release"
    ADD CONSTRAINT "reservation_release_amounts_check" CHECK ("original_amount" > 0 AND "amount" >= 0),
    ADD CONSTRAINT "reservation_release_reversal_check" CHECK (("reason" = 'REVERSAL') = ("reverses_release_id" IS NOT NULL)),
    ADD CONSTRAINT "reservation_release_payment_check" CHECK (
        CASE
            WHEN "reason" = 'REPAYMENT' THEN
                "payment_amount" IS NOT NULL AND "payment_amount" > 0
                AND "payment_currency" IS NOT NULL AND "payment_currency" ~ '^[A-Z]{3}$'
            ELSE "payment_id" IS NULL AND "payment_amount" IS NULL AND "payment_currency" IS NULL AND "payment_fx_rate_id" IS NULL
        END
    ),
    ADD CONSTRAINT "reservation_release_cancellation_reason_check" CHECK ("cancellation_reason" IS NULL OR "reason" = 'CANCELLATION'),
    ADD CONSTRAINT "reservation_release_write_off_reason_check" CHECK ("write_off_reason" IS NULL OR "reason" = 'WRITE_OFF');

-- Checks: capacity_ledger
ALTER TABLE "capacity_ledger"
    ADD CONSTRAINT "capacity_ledger_after_check" CHECK ("credit_limit_after" >= 0 AND "external_utilized_after" >= 0 AND "reserved_after" >= 0),
    ADD CONSTRAINT "capacity_ledger_shape_check" CHECK (
        CASE "type"
            WHEN 'RESERVE' THEN
                "reservation_id" IS NOT NULL AND "release_id" IS NULL AND "message_id" IS NULL
                AND "reserved_delta" > 0 AND "external_utilized_delta" = 0 AND "credit_limit_delta" = 0
            WHEN 'RELEASE' THEN
                "reservation_id" IS NOT NULL AND "release_id" IS NOT NULL AND "message_id" IS NOT NULL
                AND "reserved_delta" <= 0 AND "external_utilized_delta" = 0 AND "credit_limit_delta" = 0
            WHEN 'RELEASE_REVERSAL' THEN
                "reservation_id" IS NOT NULL AND "release_id" IS NOT NULL AND "message_id" IS NOT NULL
                AND "reserved_delta" >= 0 AND "external_utilized_delta" = 0 AND "credit_limit_delta" = 0
            WHEN 'TREASURY_LIMIT_UPDATED' THEN
                "reservation_id" IS NULL AND "release_id" IS NULL AND "message_id" IS NOT NULL
                AND "reserved_delta" = 0 AND "external_utilized_delta" = 0 AND "credit_limit_delta" <> 0
            WHEN 'TREASURY_EXTERNAL_UTILIZATION_UPDATED' THEN
                "reservation_id" IS NULL AND "release_id" IS NULL AND "message_id" IS NOT NULL
                AND "reserved_delta" = 0 AND "external_utilized_delta" <> 0 AND "credit_limit_delta" = 0
            WHEN 'TREASURY_SNAPSHOT' THEN
                "reservation_id" IS NULL AND "release_id" IS NULL AND "message_id" IS NOT NULL
                AND "reserved_delta" = 0 AND ("external_utilized_delta" <> 0 OR "credit_limit_delta" <> 0)
        END
    );

-- Checks: fx_rate
ALTER TABLE "fx_rate"
    ADD CONSTRAINT "fx_rate_currency_check" CHECK (
        "from_currency" ~ '^[A-Z]{3}$' AND "to_currency" ~ '^[A-Z]{3}$' AND "from_currency" <> "to_currency"
    ),
    ADD CONSTRAINT "fx_rate_status_check" CHECK (
        CASE "status"
            WHEN 'ACTIVE' THEN "rate" IS NOT NULL AND "rate" > 0
            ELSE "rate" IS NULL
        END
    ),
    ADD CONSTRAINT "fx_rate_version_check" CHECK ("version" >= 0);

-- Checks: processed_message
ALTER TABLE "processed_message"
    ADD CONSTRAINT "processed_message_reason_check" CHECK ("outcome" <> 'REJECTED' OR "reason" IS NOT NULL),
    ADD CONSTRAINT "processed_message_unknown_type_check" CHECK ("type" IS NOT NULL OR "reason" IS NOT DISTINCT FROM 'UNKNOWN_MESSAGE_TYPE'),
    ADD CONSTRAINT "processed_message_coordinates_check" CHECK ("partition" >= 0 AND "offset" >= 0);

-- Checks and indexes: parked_message
ALTER TABLE "parked_message"
    ADD CONSTRAINT "parked_message_coordinates_check" CHECK ("partition" >= 0 AND "offset" >= 0);

CREATE INDEX "parked_message_unresolved_idx" ON "parked_message"("awaiting_kind", "awaiting_ref") WHERE "resolved_at" IS NULL;

-- Indexes: outbox_event
CREATE INDEX "outbox_event_unpublished_idx" ON "outbox_event"("id") WHERE "published_at" IS NULL;

-- Indexes: reservation
CREATE INDEX "reservation_live_program_id_idx" ON "reservation"("program_id")
    WHERE "status" IN ('ACTIVE', 'PARTIALLY_RELEASED');

-- Checks: reservation_decline
ALTER TABLE "reservation_decline"
    ADD CONSTRAINT "reservation_decline_amount_check" CHECK ("requested_amount" > 0 AND "requested_currency" ~ '^[A-Z]{3}$');

-- Checks: reconciliation_batch
ALTER TABLE "reconciliation_batch"
    ADD CONSTRAINT "reconciliation_batch_program_count_check" CHECK ("program_count" > 0);

-- Checks: idempotency_record
ALTER TABLE "idempotency_record"
    ADD CONSTRAINT "idempotency_record_status_check" CHECK ("response_status" BETWEEN 200 AND 599),
    ADD CONSTRAINT "idempotency_record_expiry_check" CHECK ("expires_at" > "created_at");

-- Grants
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO capacity_app, capacity_maintenance;

GRANT SELECT, INSERT ON "program" TO capacity_app;
GRANT UPDATE ("credit_limit", "external_utilized", "reserved", "status", "status_reason", "status_changed_at", "status_version", "credit_limit_version", "external_utilized_version", "open_blocking_breaks", "treasury_synced_at", "updated_at") ON "program" TO capacity_app;

GRANT SELECT, INSERT ON "program_break" TO capacity_app;
GRANT UPDATE ("resolved_at", "resolution_message_id") ON "program_break" TO capacity_app;

GRANT SELECT, INSERT ON "reservation" TO capacity_app;
GRANT UPDATE ("released_amount", "released_original_amount", "status", "funded_at", "funding_ref", "updated_at") ON "reservation" TO capacity_app;

GRANT SELECT, INSERT ON "reservation_funding" TO capacity_app;
GRANT UPDATE ("returned_at", "return_message_id") ON "reservation_funding" TO capacity_app;

GRANT SELECT, INSERT ON "parked_message" TO capacity_app;
GRANT UPDATE ("resolved_at", "awaiting_kind", "awaiting_ref") ON "parked_message" TO capacity_app;

GRANT SELECT, INSERT ON "outbox_event" TO capacity_app;
GRANT UPDATE ("published_at") ON "outbox_event" TO capacity_app;

GRANT SELECT, INSERT ON "reconciliation_batch" TO capacity_app;
GRANT UPDATE ("completed_at", "alerted_at") ON "reconciliation_batch" TO capacity_app;

GRANT SELECT, INSERT ON "reconciliation_checkpoint" TO capacity_app;
GRANT UPDATE ("watermark", "updated_at") ON "reconciliation_checkpoint" TO capacity_app;

GRANT SELECT, INSERT ON "reservation_release", "capacity_ledger", "processed_message", "fx_rate", "reservation_decline", "idempotency_record" TO capacity_app;

GRANT USAGE ON SEQUENCE "capacity_ledger_id_seq", "outbox_event_id_seq" TO capacity_app;

GRANT SELECT, DELETE ON "outbox_event", "idempotency_record" TO capacity_maintenance;
