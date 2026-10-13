import { Global, Module } from '@nestjs/common';
import { MetricsServer } from './metrics.server.js';

@Global()
@Module({
  providers: [MetricsServer],
  exports: [MetricsServer],
})
export class MetricsModule {}