import { Module } from '@nestjs/common';
import { ProgramsController } from './programs.controller.js';
import { ProgramQueries } from './programs.queries.js';

@Module({
  controllers: [ProgramsController],
  providers: [ProgramQueries],
})
export class ProgramsModule {}