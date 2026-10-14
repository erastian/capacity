import { Injectable } from '@nestjs/common';
import { toDecimal } from '../shared/db/numeric.js';
import { PrismaService } from '../shared/db/prisma.service.js';
import { CURSOR_PART, decodeCursor, toPage } from '../shared/http/pagination.js';
import type { Page } from '../shared/http/pagination.types.js';
import type { CurrentQuote, QuoteRow, QuoteView, RateType } from './rates.types.js';

const CURRENT = `
  SELECT DISTINCT ON (from_currency, to_currency, rate_type)
         external_id, from_currency, to_currency, rate_type::text AS rate_type, version, status::text AS status, rate,
         least(as_of, kafka_timestamp) AS effective_as_of
  FROM fx_rate`;

function toQuote(row: QuoteRow): CurrentQuote {
  return {
    rateId: row.external_id,
    from: row.from_currency,
    to: row.to_currency,
    rateType: row.rate_type,
    version: BigInt(row.version.toString()),
    status: row.status,
    rate: row.rate === null ? undefined : toDecimal(row.rate),
    asOf: row.effective_as_of,
  };
}

export function quoteView(quote: CurrentQuote): QuoteView {
  return {
    rateId: quote.rateId,
    from: quote.from,
    to: quote.to,
    rateType: quote.rateType,
    version: quote.version.toString(),
    status: quote.status,
    rate: quote.rate?.toFixed() ?? null,
    asOf: quote.asOf.toISOString(),
  };
}

@Injectable()
export class RateQueries {
  constructor(private readonly prisma: PrismaService) {}

  async current(from: string, to: string, rateType: RateType): Promise<CurrentQuote | undefined> {
    const rows = await this.prisma.$queryRawUnsafe<QuoteRow[]>(
      `${CURRENT}
       WHERE from_currency = $1 AND to_currency = $2 AND rate_type = $3::"FxRateType"
       ORDER BY from_currency, to_currency, rate_type, version DESC`,
      from,
      to,
      rateType,
    );
    return rows[0] && toQuote(rows[0]);
  }

  async list(
    filter: { from?: string; to?: string; rateType?: RateType },
    limit: number,
    cursor: string | undefined,
  ): Promise<Page<QuoteView>> {
    const after = decodeCursor(cursor, [CURSOR_PART.text, CURSOR_PART.text, CURSOR_PART.text]);
    const rows = await this.prisma.$queryRawUnsafe<QuoteRow[]>(
      `${CURRENT}
       WHERE ($1::text IS NULL OR from_currency = $1)
         AND ($2::text IS NULL OR to_currency = $2)
         AND ($3::text IS NULL OR rate_type::text = $3)
         AND ($4::text IS NULL OR (from_currency::text, to_currency::text, rate_type::text) > ($4, $5, $6))
       ORDER BY from_currency, to_currency, rate_type, version DESC
       LIMIT $7`,
      filter.from ?? null,
      filter.to ?? null,
      filter.rateType ?? null,
      after?.[0] ?? null,
      after?.[1] ?? null,
      after?.[2] ?? null,
      limit + 1,
    );
    return toPage(rows, limit, (row) => [row.from_currency, row.to_currency, row.rate_type], (row) => quoteView(toQuote(row)));
  }
}