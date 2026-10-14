import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsBoolean } from 'class-validator';

export const BooleanFlag = () =>
  applyDecorators(
    Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value)),
    IsBoolean(),
  );