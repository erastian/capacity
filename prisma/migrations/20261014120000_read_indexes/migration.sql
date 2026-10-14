CREATE INDEX "reservation_program_id_created_at_id_idx" ON "reservation"("program_id", "created_at" DESC, "id" DESC);

CREATE INDEX "reservation_decline_invoice_id_created_by_created_at_idx" ON "reservation_decline"("invoice_id", "created_by", "created_at" DESC);