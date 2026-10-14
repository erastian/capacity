import type { Principal } from '../shared/auth/principal.types.js';
import type { Decimal } from 'decimal.js';
import type { ReserveRequest } from './reserve.dto.js';

export interface StoredResponse {
  requestHash: string;
  status: number;
  body: unknown;
}

export interface ExistingReservation {
  id: string;
  status: string;
  programId: string;
  invoiceId: string;
}

export interface NewReservation {
  programId: string;
  invoiceId: string;
  originalAmount: Decimal;
  originalCurrency: string;
  fxRateId: string | null;
  amount: Decimal;
  dueDate: string;
  createdBy: string;
  correlationId: string;
}

export interface Decline {
  programId: string;
  invoiceId: string;
  requestedAmount: Decimal;
  requestedCurrency: string;
  code: string;
  details: Record<string, unknown>;
  createdBy: string;
  correlationId: string;
}

export interface ReserveCommand {
  principal: Principal;
  idempotencyKey: string;
  request: ReserveRequest;
  correlationId: string;
  instance: string;
}

export interface ReserveResult {
  status: number;
  body: unknown;
  replayed: boolean;
}

export interface ReserveOutcome {
  status: number;
  body: unknown;
}
