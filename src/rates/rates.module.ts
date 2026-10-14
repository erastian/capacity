import { Module } from '@nestjs/common';
import { RatesController } from './rates.controller.js';
import { RateQueries } from './rates.queries.js';

@Module({
  controllers: [RatesController],
  providers: [RateQueries],
  exports: [RateQueries],
})
export class RatesModule {}
