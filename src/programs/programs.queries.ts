import { Injectable } from '@nestjs/common';
import { clientRefFilter } from '../shared/auth/visibility.js';
import type { ProgramScope } from '../shared/auth/visibility.types.js';
import { toDecimal } from '../shared/db/numeric.js';
import { PrismaService } from '../shared/db/prisma.service.js';
import { CURSOR_PART, decodeCursor, toPage } from '../shared/http/pagination.js';
import type { Page } from '../shared/http/pagination.types.js';
import { capacityOf } from '../shared/money/capacity.js';
import { formatCapacity } from '../shared/money/money.js';
import type { AvailabilityRow, AvailabilityView } from './programs.types.js';

const AVAILABILITY = `
  SELECT p.external_id, p.client_ref, p.currency, p.status::text AS status, p.credit_limit, p.external_utilized,
         p.reserved, coalesce(r.funded, 0) AS funded, p.open_blocking_breaks, p.treasury_synced_at
  FROM program p
  LEFT JOIN LATERAL (
    SELECT sum(x.amount - x.released_amount) FILTER (WHERE x.funded_at IS NOT NULL) AS funded
    FROM reservation x WHERE x.program_id = p.id AND x.status IN ('ACTIVE', 'PARTIALLY_RELEASED')
  ) r ON true`;

function toView(row: AvailabilityRow): AvailabilityView {
  const balances = {
    creditLimit: toDecimal(row.credit_limit),
    externalUtilized: toDecimal(row.external_utilized),
    reserved: toDecimal(row.reserved),
  };
  const funded = toDecimal(row.funded);
  const { totalUtilized, available, overLimit } = capacityOf(balances);
  return {
    programId: row.external_id,
    clientRef: row.client_ref,
    currency: row.currency,
    status: row.status,
    onHold: row.open_blocking_breaks > 0,
    creditLimit: formatCapacity(balances.creditLimit),
    externalUtilized: formatCapacity(balances.externalUtilized),
    reserved: formatCapacity(balances.reserved),
    committed: formatCapacity(balances.reserved.minus(funded)),
    funded: formatCapacity(funded),
    totalUtilized: formatCapacity(totalUtilized),
    available: formatCapacity(available),
    overLimit: formatCapacity(overLimit),
    asOf: row.treasury_synced_at?.toISOString() ?? null,
  };
}

@Injectable()
export class ProgramQueries {
  constructor(private readonly prisma: PrismaService) {}

  async list(scope: ProgramScope, limit: number, cursor: string | undefined): Promise<Page<AvailabilityView>> {
    if (scope.kind === 'none') return { items: [], nextCursor: null };
    const after = decodeCursor(cursor, [CURSOR_PART.text]);
    const rows = await this.prisma.$queryRawUnsafe<AvailabilityRow[]>(
      `${AVAILABILITY}
       WHERE ($1::text IS NULL OR p.client_ref = $1) AND ($2::text IS NULL OR p.external_id > $2)
       ORDER BY p.external_id
       LIMIT $3`,
      clientRefFilter(scope),
      after?.[0] ?? null,
      limit + 1,
    );
    return toPage(rows, limit, (row) => [row.external_id], toView);
  }

  async availability(scope: ProgramScope, programId: string): Promise<AvailabilityView | undefined> {
    if (scope.kind === 'none') return undefined;
    const rows = await this.prisma.$queryRawUnsafe<AvailabilityRow[]>(
      `${AVAILABILITY}
       WHERE p.external_id = $1 AND ($2::text IS NULL OR p.client_ref = $2)`,
      programId,
      clientRefFilter(scope),
    );
    return rows[0] && toView(rows[0]);
  }
}
