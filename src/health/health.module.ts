import { Module } from '@nestjs/common';
import { TreasuryModule } from '../treasury/treasury.module.js';
import { HealthController } from './health.controller.js';

@Module({
  imports: [TreasuryModule],
  controllers: [HealthController],
})
export class HealthModule {}