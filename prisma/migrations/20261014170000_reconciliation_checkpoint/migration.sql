CREATE TABLE "reconciliation_checkpoint" (
    "check" TEXT NOT NULL,
    "watermark" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reconciliation_checkpoint_pkey" PRIMARY KEY ("check")
);

CREATE INDEX "reservation_updated_at_idx" ON "reservation"("updated_at");

CREATE INDEX "reservation_live_program_id_idx" ON "reservation"("program_id")
    WHERE "status" IN ('ACTIVE', 'PARTIALLY_RELEASED');

GRANT SELECT, INSERT ON "reconciliation_checkpoint" TO capacity_app;
GRANT UPDATE ("watermark", "updated_at") ON "reconciliation_checkpoint" TO capacity_app;