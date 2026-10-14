import { Controller, Get, HttpStatus, Param, Query } from '@nestjs/common';
import { RequireScopes } from '../shared/auth/decorators.js';
import { Scope } from '../shared/auth/scopes.js';
import { AppError } from '../shared/errors/app-error.js';
import { BreaksQuery, ProgramBreaksQuery } from './audit.dto.js';
import { AuditQueries } from './audit.queries.js';

@Controller('v1')
@RequireScopes(Scope.BreaksRead)
export class BreaksController {
  constructor(private readonly audit: AuditQueries) {}

  @Get('breaks')
  list(@Query() query: BreaksQuery) {
    return this.audit.breaks({ programId: query.programId, open: query.open, reason: query.reason }, query.limit, query.cursor);
  }

  @Get('programs/:programId/breaks')
  async ofProgram(@Param('programId') programId: string, @Query() query: ProgramBreaksQuery) {
    if (!(await this.audit.programExists(programId))) {
      throw new AppError(HttpStatus.NOT_FOUND, 'PROGRAM_NOT_FOUND', { detail: `Program ${programId} not found` });
    }
    return this.audit.breaks({ programId, open: query.open, reason: query.reason }, query.limit, query.cursor);
  }
}
