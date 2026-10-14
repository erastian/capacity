import { Controller, Get, Query } from '@nestjs/common';
import { RequireScopes } from '../shared/auth/decorators.js';
import { Scope } from '../shared/auth/scopes.js';
import { RatesQuery } from './rates.dto.js';
import { RateQueries } from './rates.queries.js';

@Controller('v1/fx-rates')
@RequireScopes(Scope.ProgramsReadAll)
export class RatesController {
  constructor(private readonly rates: RateQueries) {}

  @Get()
  list(@Query() query: RatesQuery) {
    return this.rates.list({ from: query.from, to: query.to, rateType: query.type }, query.limit, query.cursor);
  }
}