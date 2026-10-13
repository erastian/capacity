import { HttpStatus, ValidationError, ValidationPipe } from '@nestjs/common';
import { AppError } from './app-error.js';

interface FieldError {
  field: string;
  messages: string[];
}

function flatten(errors: ValidationError[], parent = ''): FieldError[] {
  return errors.flatMap((error) => {
    const field = parent ? `${parent}.${error.property}` : error.property;
    const own = error.constraints
      ? [{ field, messages: Object.values(error.constraints) }]
      : [];
    return [...own, ...flatten(error.children ?? [], field)];
  });
}

export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    exceptionFactory: (errors) =>
      new AppError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'VALIDATION_FAILED',
        'Request validation failed',
        { errors: flatten(errors) },
      ),
  });
}