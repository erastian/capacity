import { Controller, Get, Query } from '@nestjs/common';
import { RequireScopes } from '../shared/auth/decorators.js';
import { Scope } from '../shared/auth/scopes.js';
import {
  DeclineJournalQuery,
  FundingsQuery,
  InboxQuery,
  LedgerQuery,
  OutboxQuery,
  ParkedQuery,
} from './audit.dto.js';
import { AuditQueries } from './audit.queries.js';

@Controller('v1/audit')
@RequireScopes(Scope.AuditRead)
export class AuditController {
  constructor(private readonly audit: AuditQueries) {}

  @Get('ledger')
  ledger(@Query() query: LedgerQuery) {
    return this.audit.ledger(query.programId, query.limit, query.cursor);
  }

  @Get('inbox')
  inbox(@Query() query: InboxQuery) {
    const { limit, cursor, ...filter } = query;
    return this.audit.inbox(filter, limit, cursor);
  }

  @Get('parked')
  parked(@Query() query: ParkedQuery) {
    const { limit, cursor, ...filter } = query;
    return this.audit.parked(filter, limit, cursor);
  }

  @Get('fundings')
  fundings(@Query() query: FundingsQuery) {
    return this.audit.fundings(query.reservationId, query.limit, query.cursor);
  }

  @Get('outbox')
  outbox(@Query() query: OutboxQuery) {
    const { limit, cursor, ...filter } = query;
    return this.audit.outbox(filter, limit, cursor);
  }

  @Get('declines')
  declines(@Query() query: DeclineJournalQuery) {
    const { limit, cursor, ...filter } = query;
    return this.audit.declines(filter, limit, cursor);
  }
}