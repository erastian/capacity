import { isDataError, isTransient } from '../shared/db/sql-state.js';

export function givesUp(error: unknown, attempts: number, maxAttempts: number): boolean {
  return isDataError(error) || (attempts >= maxAttempts && !isTransient(error));
}
