import { Injectable } from '@nestjs/common';
import { toDecimal as dec } from '../../shared/db/numeric.js';
import type { Tx } from '../../shared/db/prisma.service.js';
import type { FxRatePublished } from '../adapter/commands.types.js';
import type { Envelope } from '../adapter/envelope.types.js';
import type { StoredQuote } from '../domain/fx-rate-decision.types.js';
import type { FxRateRow, KafkaCoordinates } from '../inbound.types.js';

const FX_COLUMNS = `external_id, from_currency, to_currency, rate_type::text AS rate_type, version,
  status::text AS status, rate`;

function toQuote(row: FxRateRow): StoredQuote {
  return {
    rateId: row.external_id,
    from: row.from_currency,
    to: row.to_currency,
    rateType: row.rate_type,
    version: BigInt(row.version.toString()),
    status: row.status,
    rate: row.rate === null ? undefined : dec(row.rate),
  };
}

@Injectable()
export class QuoteRepository {
  async findQuoteByRateId(tx: Tx, rateId: string): Promise<StoredQuote | undefined> {
    const rows = await tx.$queryRawUnsafe<FxRateRow[]>(`SELECT ${FX_COLUMNS} FROM fx_rate WHERE external_id = $1`, rateId);
    return rows[0] && toQuote(rows[0]);
  }

  async findQuoteByPairVersion(tx: Tx, quote: FxRatePublished): Promise<StoredQuote | undefined> {
    const rows = await tx.$queryRawUnsafe<FxRateRow[]>(
      `SELECT ${FX_COLUMNS} FROM fx_rate
       WHERE from_currency = $1 AND to_currency = $2 AND rate_type = $3::"FxRateType" AND version = $4`,
      quote.from,
      quote.to,
      quote.rateType,
      quote.version,
    );
    return rows[0] && toQuote(rows[0]);
  }

  async insertQuote(tx: Tx, quote: FxRatePublished, envelope: Envelope, coordinates: KafkaCoordinates): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO fx_rate (external_id, from_currency, to_currency, rate_type, version, rate, status, as_of, kafka_timestamp, message_id)
      VALUES (
        ${quote.rateId}, ${quote.from}, ${quote.to}, ${quote.rateType}::"FxRateType", ${quote.version},
        ${quote.rate?.toString() ?? null}::numeric, ${quote.status}::"FxRateStatus", ${envelope.asOf},
        ${coordinates.timestamp}, ${envelope.messageId}
      )
    `;
  }
}
