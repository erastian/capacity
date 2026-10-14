import type { ClientConfig } from 'pg';

const SERVER_KEEPALIVES = '-c tcp_keepalives_idle=30 -c tcp_keepalives_interval=10 -c tcp_keepalives_count=3';
const CLIENT_GRACE_MS = 1000;

export function boundedConnection(connectionString: string, timeoutMs: number, waitMs = timeoutMs): ClientConfig {
  return {
    connectionString,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    connectionTimeoutMillis: waitMs + CLIENT_GRACE_MS,
    statement_timeout: timeoutMs,
    lock_timeout: timeoutMs,
    idle_in_transaction_session_timeout: timeoutMs,
    query_timeout: timeoutMs + CLIENT_GRACE_MS,
    options: SERVER_KEEPALIVES,
  };
}
