import { MultipleErrors, NetworkError, TimeoutError } from '@platformatic/kafka';
import { isDataError, isTransient } from '../shared/db/sql-state.js';

export function isTransientFailure(error: unknown): boolean {
  return isTransient(error) || error instanceof NetworkError || error instanceof TimeoutError || error instanceof MultipleErrors;
}

export function givesUp(error: unknown, attempts: number, maxAttempts: number): boolean {
  return isDataError(error) || (attempts >= maxAttempts && !isTransientFailure(error));
}
