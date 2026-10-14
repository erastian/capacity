import { Module } from '@nestjs/common';
import { AuditController } from './audit.controller.js';
import { AuditQueries } from './audit.queries.js';
import { BreaksController } from './breaks.controller.js';

@Module({
  controllers: [BreaksController, AuditController],
  providers: [AuditQueries],
})
export class AuditModule {}
