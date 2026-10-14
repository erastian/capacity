import { ValidateBy, type ValidationOptions } from 'class-validator';
import { isCurrency } from './currency.js';

export function IsCurrency(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isCurrency',
      validator: {
        validate: (value: unknown) => typeof value === 'string' && isCurrency(value),
        defaultMessage: (args) => `${args?.property ?? 'value'} must be an ISO 4217 code`,
      },
    },
    options,
  );
}
