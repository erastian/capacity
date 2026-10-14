import { Controller, Get, Query } from '@nestjs/common';
import { CurrentPrincipal, RequireScopes } from '../shared/auth/decorators.js';
import type { Principal } from '../shared/auth/principal.types.js';
import { Scope } from '../shared/auth/scopes.js';
import { DeclinesQuery } from './reservation-queries.dto.js';
import { ReservationQueries } from './reservation.queries.js';

@Controller('v1/declines')
@RequireScopes(Scope.ReservationsWrite)
export class DeclinesController {
  constructor(private readonly queries: ReservationQueries) {}

  @Get()
  list(@Query() query: DeclinesQuery, @CurrentPrincipal() principal: Principal) {
    return this.queries.declines(principal.subject, query.invoiceId, query.limit, query.cursor);
  }
}