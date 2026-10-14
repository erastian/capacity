import { Prisma } from '../../generated/prisma/client.js';
import type { DriverAdapterMeta } from './db.types.js';

const CHECK_VIOLATION = '23514';

export function sqlState(error: unknown): string | undefined {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return undefined;
  const code = (error.meta as DriverAdapterMeta | undefined)?.driverAdapterError?.cause?.originalCode;
  return typeof code === 'string' ? code : undefined;
}

export function isDataError(error: unknown): boolean {
  const code = sqlState(error);
  return code !== undefined && (code.startsWith('22') || code === CHECK_VIOLATION);
}