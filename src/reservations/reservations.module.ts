import { Module } from '@nestjs/common';
import { RatesModule } from '../rates/rates.module.js';
import { DeclinesController } from './declines.controller.js';
import { ReservationQueries } from './reservation.queries.js';
import { ReservationRepository } from './reservation.repository.js';
import { ReservationsController } from './reservations.controller.js';
import { ReservationsService } from './reservations.service.js';

@Module({
  imports: [RatesModule],
  controllers: [ReservationsController, DeclinesController],
  providers: [ReservationsService, ReservationRepository, ReservationQueries],
})
export class ReservationsModule {}
