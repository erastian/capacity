import { Body, Controller, Get, Headers, HttpStatus, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CurrentPrincipal, RequireScopes } from '../shared/auth/decorators.js';
import type { Principal } from '../shared/auth/principal.types.js';
import { Scope } from '../shared/auth/scopes.js';
import { AppError } from '../shared/errors/app-error.js';
import { PROBLEM_CONTENT_TYPE } from '../shared/errors/problem.js';
import { PayoffQuoteQuery, ReservationsQuery } from './reservation-queries.dto.js';
import { ReservationQueries, viewerOf } from './reservation.queries.js';
import { IDEMPOTENCY_KEY, ReserveRequest } from './reserve.dto.js';
import { ReservationsService } from './reservations.service.js';

@Controller('v1/reservations')
export class ReservationsController {
  constructor(
    private readonly reservations: ReservationsService,
    private readonly queries: ReservationQueries,
  ) {}

  @Get()
  @RequireScopes(Scope.ProgramsReadAll, Scope.ProgramsReadOwn)
  list(@Query() query: ReservationsQuery, @CurrentPrincipal() principal: Principal) {
    return this.queries.list(viewerOf(principal), { programId: query.programId, invoiceId: query.invoiceId, status: query.status }, query.limit, query.cursor);
  }

  @Get(':id')
  @RequireScopes(Scope.ProgramsReadAll, Scope.ProgramsReadOwn)
  card(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.queries.card(viewerOf(principal), id);
  }

  @Get(':id/payoff-quote')
  @RequireScopes(Scope.ProgramsReadAll, Scope.ProgramsReadOwn)
  payoffQuote(@Param('id') id: string, @Query() query: PayoffQuoteQuery, @CurrentPrincipal() principal: Principal) {
    return this.queries.payoff(viewerOf(principal), id, query.currency);
  }

  @Post()
  @RequireScopes(Scope.ReservationsWrite)
  async reserve(
    @Body() request: ReserveRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentPrincipal() principal: Principal,
    @Req() http: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'VALIDATION_FAILED', {
        detail: 'Request validation failed',
        extensions: {
          errors: [
            {
              field: 'Idempotency-Key',
              messages: ['Idempotency-Key header must be 8-255 characters of [A-Za-z0-9._:-]'],
            },
          ],
        },
      });
    }

    const result = await this.reservations.reserve({
      principal,
      idempotencyKey,
      request,
      correlationId: String(http.id),
      instance: http.url,
    });

    void reply.status(result.status);
    if (result.status >= 400) void reply.type(PROBLEM_CONTENT_TYPE);
    if (result.replayed) void reply.header('idempotent-replayed', 'true');
    return result.body;
  }
}
