import { Controller, Get, HttpStatus, Param, Query } from '@nestjs/common';
import { CurrentPrincipal, RequireScopes } from '../shared/auth/decorators.js';
import type { Principal } from '../shared/auth/principal.types.js';
import { Scope } from '../shared/auth/scopes.js';
import { programScope } from '../shared/auth/visibility.js';
import { AppError } from '../shared/errors/app-error.js';
import { PageQuery } from '../shared/http/pagination.js';
import { ProgramQueries } from './programs.queries.js';

@Controller('v1/programs')
@RequireScopes(Scope.ProgramsReadAll, Scope.ProgramsReadOwn)
export class ProgramsController {
  constructor(private readonly programs: ProgramQueries) {}

  @Get()
  list(@Query() query: PageQuery, @CurrentPrincipal() principal: Principal) {
    return this.programs.list(programScope(principal), query.limit, query.cursor);
  }

  @Get(':programId/availability')
  async availability(@Param('programId') programId: string, @CurrentPrincipal() principal: Principal) {
    const view = await this.programs.availability(programScope(principal), programId);
    if (!view) throw new AppError(HttpStatus.NOT_FOUND, 'PROGRAM_NOT_FOUND', { detail: `Program ${programId} not found` });
    return view;
  }
}
