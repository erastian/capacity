import { Module } from '@nestjs/common';
import { InternalReconciliation } from './internal-reconciliation.js';
import { MaintenanceCleanup } from './maintenance-cleanup.js';
import { OperationalMonitors } from './monitors.js';
import { ReconciliationController } from './reconciliation.controller.js';

@Module({
  controllers: [ReconciliationController],
  providers: [OperationalMonitors, InternalReconciliation, MaintenanceCleanup],
})
export class OperationsModule {}
