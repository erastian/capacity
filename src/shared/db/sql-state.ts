import { Prisma } from '../../generated/prisma/client.js';
import type { DriverAdapterMeta } from './db.types.js';

const CHECK_VIOLATION = '23514';
const TRANSACTION_UNAVAILABLE = 'P2028';
const START_TIMED_OUT = 'Unable to start a transaction in the given time';
const LOCK_NOT_AVAILABLE = '55P03';
const TRANSIENT_CLASSES = ['08', '40', '53', '57', '58'];
const TRANSIENT_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028', 'P2034']);
const TRANSIENT_KINDS = new Set([
  'DatabaseNotReachable',
  'ConnectionClosed',
  'SocketTimeout',
  'TooManyConnections',
  'TlsConnectionError',
  'TransactionWriteConflict',
]);
const CONNECTION_MESSAGES = new Set([
  'Connection terminated',
  'Connection terminated unexpectedly',
  'Connection terminated due to connection timeout',
  'Client has encountered a connection error and is not queryable',
  'Query read timeout',
  'timeout exceeded when trying to connect',
  'timeout expired',
]);

function adapterCause(error: Prisma.PrismaClientKnownRequestError) {
  return (error.meta as DriverAdapterMeta | undefined)?.driverAdapterError?.cause;
}

export function sqlState(error: unknown): string | undefined {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return undefined;
  const code = adapterCause(error)?.originalCode;
  return typeof code === 'string' ? code : undefined;
}

export function isDataError(error: unknown): boolean {
  const code = sqlState(error);
  return code !== undefined && (code.startsWith('22') || code === CHECK_VIOLATION);
}

export function isPoolExhausted(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === TRANSACTION_UNAVAILABLE && error.message.includes(START_TIMED_OUT);
}

export function isTransient(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientInitializationError || error instanceof Prisma.PrismaClientUnknownRequestError) {
    return true;
  }
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return error instanceof Error && CONNECTION_MESSAGES.has(error.message);
  }
  if (TRANSIENT_CODES.has(error.code)) return true;
  const kind = adapterCause(error)?.kind;
  if (typeof kind === 'string' && TRANSIENT_KINDS.has(kind)) return true;
  const code = sqlState(error);
  return code !== undefined && (code === LOCK_NOT_AVAILABLE || TRANSIENT_CLASSES.includes(code.slice(0, 2)));
}
