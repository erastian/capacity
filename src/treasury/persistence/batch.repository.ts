import { Injectable } from '@nestjs/common';
import type { Tx } from '../../shared/db/prisma.service.js';
import type { BatchProgress, BatchProgressRow } from '../inbound.types.js';

const toProgress = (row: BatchProgressRow): BatchProgress => ({
  batchId: row.batch_id,
  programCount: row.program_count,
  received: row.received,
  alertedAt: row.alerted_at,
});

@Injectable()
export class BatchRepository {
  async findBatch(tx: Tx, batchId: string): Promise<{ programCount: number } | undefined> {
    const rows = await tx.$queryRaw<{ program_count: number }[]>`
      SELECT program_count FROM reconciliation_batch WHERE batch_id = ${batchId}
    `;
    return rows[0] && { programCount: rows[0].program_count };
  }

  async insertBatch(tx: Tx, batchId: string, programCount: number, messageId: string, deadlineAt: Date): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO reconciliation_batch (batch_id, program_count, completed_message_id, deadline_at)
      VALUES (${batchId}, ${programCount}, ${messageId}, ${deadlineAt})
    `;
  }

  async completeBatch(tx: Tx, batchId: string): Promise<BatchProgress | undefined> {
    const rows = await tx.$queryRaw<BatchProgressRow[]>`
      UPDATE reconciliation_batch b SET completed_at = now()
      FROM (
        SELECT count(DISTINCT program_external_id)::int AS received FROM processed_message
        WHERE batch_id = ${batchId} AND type = 'PROGRAM_SNAPSHOT'
      ) s
      WHERE b.batch_id = ${batchId} AND b.completed_at IS NULL AND s.received >= b.program_count
      RETURNING b.batch_id, b.program_count, s.received, b.alerted_at
    `;
    return rows[0] && toProgress(rows[0]);
  }

  async completePendingBatches(tx: Tx): Promise<BatchProgress[]> {
    const rows = await tx.$queryRaw<BatchProgressRow[]>`
      UPDATE reconciliation_batch b SET completed_at = now()
      FROM (
        SELECT m.batch_id, count(DISTINCT m.program_external_id)::int AS received
        FROM processed_message m
        JOIN reconciliation_batch pending ON pending.batch_id = m.batch_id AND pending.completed_at IS NULL
        WHERE m.type = 'PROGRAM_SNAPSHOT'
        GROUP BY m.batch_id
      ) s
      WHERE b.batch_id = s.batch_id AND b.completed_at IS NULL AND s.received >= b.program_count
      RETURNING b.batch_id, b.program_count, s.received, b.alerted_at
    `;
    return rows.map(toProgress);
  }

  async flagOverdueBatches(tx: Tx): Promise<BatchProgress[]> {
    const rows = await tx.$queryRaw<BatchProgressRow[]>`
      UPDATE reconciliation_batch b SET alerted_at = now()
      WHERE b.completed_at IS NULL AND b.alerted_at IS NULL AND b.deadline_at < now()
      RETURNING b.batch_id, b.program_count, b.alerted_at, (
        SELECT count(DISTINCT m.program_external_id)::int FROM processed_message m
        WHERE m.batch_id = b.batch_id AND m.type = 'PROGRAM_SNAPSHOT'
      ) AS received
    `;
    return rows.map(toProgress);
  }
}
