import { Controller, Get } from '@nestjs/common';
import { RequireScopes } from '../shared/auth/decorators.js';
import { Scope } from '../shared/auth/scopes.js';
import { InternalReconciliation } from './internal-reconciliation.js';

@Controller('v1/audit/reconciliation')
@RequireScopes(Scope.AuditRead)
export class ReconciliationController {
  constructor(private readonly reconciliation: InternalReconciliation) {}

  @Get()
  run() {
    return this.reconciliation.run();
  }
}
