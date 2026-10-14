export interface OverdueReservation {
  reservationId: string;
  programId: string;
  invoiceId: string;
  dueDate: string;
  funded: boolean;
}

export interface AgedParkedMessage {
  messageId: string;
  programId: string;
  awaitingKind: string;
  awaitingRef: string;
  parkedAt: Date;
}

export interface StaleProgram {
  programId: string;
  syncedAt: Date | null;
}

export interface MonitorSnapshot {
  overdue: OverdueReservation[];
  agedParked: AgedParkedMessage[];
  staleTreasury: StaleProgram[];
}

export interface Mismatch {
  check: string;
  subject: string;
  expected: string;
  actual: string;
}

export interface ReconciliationReport {
  checkedAt: string;
  ok: boolean;
  mismatches: Mismatch[];
}

export interface ProgramTotalsRow {
  external_id: string;
  reserved: string;
  live_exposure: string;
  reserved_off: boolean;
  balances: string;
  ledger: string;
  ledger_off: boolean;
  open_blocking_breaks: number;
  counted_breaks: number;
}

export interface LedgerChainRow {
  id: string;
  expected: string;
  actual: string;
  off: boolean;
}

export interface DirtyReservationRow {
  id: string;
  updated_at: Date;
  releases_expected: string;
  releases_actual: string;
  releases_off: boolean;
  funding_expected: string;
  funding_actual: string;
  funding_off: boolean;
}

export interface CheckResult {
  check: string;
  count: number;
  sample: Mismatch[];
}

export interface CleanupResult {
  outboxEvents: number;
  idempotencyRecords: number;
}