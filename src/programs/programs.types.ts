import type { Numeric } from '../shared/db/db.types.js';
import type { ProgramStatus } from '../shared/domain/program.types.js';

export interface AvailabilityRow {
  external_id: string;
  client_ref: string;
  currency: string;
  status: ProgramStatus;
  credit_limit: Numeric;
  external_utilized: Numeric;
  reserved: Numeric;
  funded: Numeric;
  open_blocking_breaks: number;
  treasury_synced_at: Date | null;
}

export interface AvailabilityView {
  programId: string;
  clientRef: string;
  currency: string;
  status: ProgramStatus;
  onHold: boolean;
  creditLimit: string;
  externalUtilized: string;
  reserved: string;
  committed: string;
  funded: string;
  totalUtilized: string;
  available: string;
  overLimit: string;
  asOf: string | null;
}