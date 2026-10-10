-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('ACTIVE', 'PARTIALLY_RELEASED', 'RELEASED');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('RESERVE', 'RELEASE', 'LIMIT_CHANGED', 'EXTERNAL_SYNC');

-- CreateTable
CREATE TABLE "program" (
    "id" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "credit_limit" DECIMAL(20,4) NOT NULL,
    "external_utilized" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "reserved" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "treasury_version" BIGINT,
    "treasury_synced_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "program_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservation" (
    "id" UUID NOT NULL,
    "program_id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "original_amount" DECIMAL(20,4) NOT NULL,
    "original_currency" CHAR(3) NOT NULL,
    "fx_rate" DECIMAL(20,10) NOT NULL,
    "fx_rate_as_of" TIMESTAMPTZ(3) NOT NULL,
    "amount" DECIMAL(20,4) NOT NULL,
    "released_amount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "released_original_amount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "status" "ReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "due_date" DATE NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservation_release" (
    "id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "original_amount" DECIMAL(20,4) NOT NULL,
    "amount" DECIMAL(20,4) NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reservation_release_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capacity_ledger" (
    "id" BIGSERIAL NOT NULL,
    "program_id" TEXT NOT NULL,
    "type" "LedgerEntryType" NOT NULL,
    "reserved_delta" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "external_utilized_delta" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "credit_limit_delta" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "reservation_id" UUID,
    "release_id" UUID,
    "message_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "capacity_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_message" (
    "message_id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "partition" INTEGER NOT NULL,
    "offset" BIGINT NOT NULL,
    "processed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_message_pkey" PRIMARY KEY ("message_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reservation_invoice_id_key" ON "reservation"("invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "reservation_idempotency_key_key" ON "reservation"("idempotency_key");

-- CreateIndex
CREATE INDEX "reservation_program_id_status_created_at_id_idx" ON "reservation"("program_id", "status", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "reservation_release_idempotency_key_key" ON "reservation_release"("idempotency_key");

-- CreateIndex
CREATE INDEX "reservation_release_reservation_id_idx" ON "reservation_release"("reservation_id");

-- CreateIndex
CREATE INDEX "capacity_ledger_program_id_id_idx" ON "capacity_ledger"("program_id", "id");

-- AddForeignKey
ALTER TABLE "reservation" ADD CONSTRAINT "reservation_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "program"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation_release" ADD CONSTRAINT "reservation_release_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capacity_ledger" ADD CONSTRAINT "capacity_ledger_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "program"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE program
  ADD CONSTRAINT program_non_negative
  CHECK (credit_limit >= 0 AND external_utilized >= 0 AND reserved >= 0);

ALTER TABLE reservation
  ADD CONSTRAINT reservation_amounts
  CHECK (amount > 0 AND released_amount >= 0 AND released_amount <= amount
         AND released_original_amount <= original_amount);