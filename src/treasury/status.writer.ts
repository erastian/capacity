import { writeOutbox } from '../outbox/outbox.writer.js';
import type { Tx } from '../shared/db/prisma.service.js';
import type { StatusReport } from './inbound.types.js';

export async function writeStatus(tx: Tx, report: StatusReport): Promise<void> {
  await writeOutbox(tx, {
    type: 'INBOUND_MESSAGE_STATUS',
    programId: report.programId,
    partitionKey: report.partitionKey,
    correlationId: report.correlationId,
    occurredAt: report.decidedAt,
    data: {
      messageId: report.messageId,
      status: report.status,
      reason: report.reason ?? null,
      awaitingKind: report.awaiting?.kind ?? null,
      awaitingRef: report.awaiting?.ref ?? null,
      references: report.references ?? {},
      asOf: report.decidedAt.toISOString(),
    },
  });
}