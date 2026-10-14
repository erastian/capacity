import { Decimal } from 'decimal.js';
import type { ProgramStatus } from '../../shared/domain/program.types.js';
import { isCurrency } from '../../shared/money/currency.js';
import { fitsMinorUnits } from '../../shared/money/money.js';
import type {
  Command,
  CommandResult,
  FxRateStatus,
  FxRateType,
  InvoiceCommand,
  Money,
  VersionedMoney,
} from './commands.types.js';
import { isIdentifier, parseVersion } from './envelope.js';
import type { Envelope } from './envelope.types.js';

export const SUPPORTED_SCHEMA_VERSION = 1;

const AMOUNT = /^(0|[1-9]\d{0,15})(\.\d{1,4})?$/;
const RATE = /^(0|[1-9]\d{0,19})(\.\d{1,18})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES: readonly ProgramStatus[] = ['ACTIVE', 'SUSPENDED', 'CLOSED'];
const RATE_TYPES: readonly FxRateType[] = ['VALUATION', 'CONVERSION'];
const RATE_STATUSES: readonly FxRateStatus[] = ['ACTIVE', 'SUSPENDED'];

class Invalid extends Error {}

function fail(reason: string): never {
  throw new Invalid(reason);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, max = 256): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) fail(`${field} must be a non-empty string`);
  return value;
}

function optionalText(value: unknown, field: string): string | null {
  return value === undefined || value === null ? null : text(value, field);
}

function currency(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isCurrency(value)) fail(`${field} must be an ISO 4217 code`);
  return value;
}

function money(value: unknown, field: string): Money {
  const raw = object(value, field);
  if (typeof raw.amount !== 'string' || !AMOUNT.test(raw.amount)) {
    fail(`${field}.amount must be a non-negative decimal string with at most 4 places`);
  }
  return { amount: new Decimal(raw.amount), currency: currency(raw.currency, `${field}.currency`) };
}

function version(value: unknown, field: string): bigint {
  return parseVersion(value) ?? fail(`${field} must be a non-negative integer`);
}

function versionedMoney(value: unknown, field: string): VersionedMoney {
  const raw = object(value, field);
  return { ...money(raw, field), version: version(raw.version, `${field}.version`) };
}

function status(value: unknown, field: string): ProgramStatus {
  if (!STATUSES.includes(value as ProgramStatus)) fail(`${field} must be one of ${STATUSES.join(', ')}`);
  return value as ProgramStatus;
}

function programId(envelope: Envelope): string {
  return envelope.programId ?? fail('programId is missing or invalid');
}

function envelopeVersion(envelope: Envelope): bigint {
  return envelope.version ?? fail('version is missing or invalid');
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (!allowed.includes(value as T)) fail(`${field} must be one of ${allowed.join(', ')}`);
  return value as T;
}

function fxRate(envelope: Envelope): Command {
  const payload = envelope.payload;
  if (!isIdentifier(payload.rateId)) fail('rateId is missing or invalid');
  const from = currency(payload.from, 'from');
  const to = currency(payload.to, 'to');
  if (from === to) fail('from and to must differ');
  const rateStatus = oneOf(payload.status, RATE_STATUSES, 'status');

  let rate: Decimal | undefined;
  if (rateStatus === 'ACTIVE') {
    if (typeof payload.rate !== 'string' || !RATE.test(payload.rate)) {
      fail('rate must be a decimal string with at most 18 places');
    }
    rate = new Decimal(payload.rate);
    if (rate.lte(0)) fail('rate must be greater than zero');
  } else if (payload.rate !== undefined && payload.rate !== null) {
    fail('a suspended quote carries no rate');
  }

  return {
    type: 'FX_RATE_PUBLISHED',
    rateId: payload.rateId,
    from,
    to,
    rateType: oneOf(payload.rateType, RATE_TYPES, 'rateType'),
    version: envelopeVersion(envelope),
    status: rateStatus,
    rate,
  };
}

function breakId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail(`${field} must be a break id`);
  return value.toLowerCase();
}

function identifier(value: unknown, field: string): string {
  if (!isIdentifier(value)) fail(`${field} is missing or invalid`);
  return value;
}

function invoiceMoney(value: unknown, field: string): Money {
  const raw = object(value, field);
  const parsed = money(raw, field);
  if (parsed.amount.lte(0)) fail(`${field}.amount must be greater than zero`);
  if (!fitsMinorUnits(raw.amount as string, parsed.currency)) {
    fail(`${field}.amount has more decimals than ${parsed.currency} allows`);
  }
  return parsed;
}

function allocation(envelope: Envelope): Command {
  const payload = envelope.payload;
  const payment = invoiceMoney(payload.payment, 'payment');
  const settledAmount = invoiceMoney(payload.settledAmount, 'settledAmount');
  const fxRateId = payload.fxRateId === undefined || payload.fxRateId === null ? null : identifier(payload.fxRateId, 'fxRateId');

  if (payment.currency === settledAmount.currency) {
    if (fxRateId !== null) fail('fxRateId is only allowed when the payment is in another currency');
    if (!payment.amount.eq(settledAmount.amount)) fail('payment and settledAmount must be equal in the same currency');
  } else if (fxRateId === null) {
    fail('fxRateId is required when the payment is in another currency');
  }

  return {
    type: 'INVOICE_PAYMENT_ALLOCATED',
    programId: programId(envelope),
    invoiceId: identifier(payload.invoiceId, 'invoiceId'),
    allocationId: identifier(payload.allocationId, 'allocationId'),
    paymentId: identifier(payload.paymentId, 'paymentId'),
    payment,
    settledAmount,
    fxRateId,
  };
}

function build(envelope: Envelope): Command | undefined {
  const payload = envelope.payload;
  switch (envelope.type) {
    case 'INVOICE_FUNDED':
    case 'INVOICE_FUNDING_RETURNED':
      return {
        type: envelope.type,
        programId: programId(envelope),
        invoiceId: identifier(payload.invoiceId, 'invoiceId'),
        fundingRef: identifier(payload.fundingRef, 'fundingRef'),
      };
    case 'INVOICE_PAYMENT_ALLOCATED':
      return allocation(envelope);
    case 'INVOICE_BALANCE_WRITTEN_OFF':
      return {
        type: 'INVOICE_BALANCE_WRITTEN_OFF',
        programId: programId(envelope),
        invoiceId: identifier(payload.invoiceId, 'invoiceId'),
        writeOffId: identifier(payload.writeOffId, 'writeOffId'),
        amount: invoiceMoney(payload.amount, 'amount'),
        writeOffReason: text(payload.writeOffReason, 'writeOffReason', 64),
      };
    case 'INVOICE_FUNDING_CANCELLED':
      return {
        type: 'INVOICE_FUNDING_CANCELLED',
        programId: programId(envelope),
        invoiceId: identifier(payload.invoiceId, 'invoiceId'),
        cancellationId: identifier(payload.cancellationId, 'cancellationId'),
        cancellationReason: text(payload.cancellationReason, 'cancellationReason', 64),
      };
    case 'INVOICE_RELEASE_REVERSED':
      return {
        type: 'INVOICE_RELEASE_REVERSED',
        programId: programId(envelope),
        invoiceId: identifier(payload.invoiceId, 'invoiceId'),
        reversalId: identifier(payload.reversalId, 'reversalId'),
        externalRef: identifier(payload.externalRef, 'externalRef'),
      };
    case 'BREAK_RESOLVED':
      return {
        type: 'BREAK_RESOLVED',
        programId: programId(envelope),
        breakId: breakId(payload.breakId, 'breakId'),
      };
    case 'RECONCILIATION_BATCH_COMPLETED': {
      const count = payload.programCount;
      if (!Number.isSafeInteger(count) || (count as number) < 1) fail('programCount must be a positive integer');
      return {
        type: 'RECONCILIATION_BATCH_COMPLETED',
        batchId: envelope.batchId ?? fail('batchId is missing or invalid'),
        programCount: count as number,
      };
    }
    case 'PROGRAM_SNAPSHOT': {
      const statusField = object(payload.status, 'status');
      const resolved = payload.resolvedBreaks ?? [];
      if (!Array.isArray(resolved)) fail('resolvedBreaks must be a list of break ids');
      const resolvedBreaks = resolved.map((id, index) => breakId(id, `resolvedBreaks[${index}]`));
      return {
        type: 'PROGRAM_SNAPSHOT',
        programId: programId(envelope),
        currency: currency(payload.currency, 'currency'),
        clientRef: text(payload.clientRef, 'clientRef', 128),
        creditLimit: versionedMoney(payload.creditLimit, 'creditLimit'),
        externalUtilized: versionedMoney(payload.externalUtilized, 'externalUtilized'),
        status: {
          value: status(statusField.value, 'status.value'),
          reason: optionalText(statusField.reason, 'status.reason'),
          version: version(statusField.version, 'status.version'),
        },
        resolvedBreaks,
      };
    }
    case 'LIMIT_UPDATED':
      return {
        type: 'LIMIT_UPDATED',
        programId: programId(envelope),
        creditLimit: { ...money(payload.creditLimit, 'creditLimit'), version: envelopeVersion(envelope) },
      };
    case 'EXTERNAL_UTILIZATION_UPDATED':
      return {
        type: 'EXTERNAL_UTILIZATION_UPDATED',
        programId: programId(envelope),
        externalUtilized: { ...money(payload.externalUtilized, 'externalUtilized'), version: envelopeVersion(envelope) },
      };
    case 'PROGRAM_STATUS_CHANGED':
      return {
        type: 'PROGRAM_STATUS_CHANGED',
        programId: programId(envelope),
        status: {
          value: status(payload.status, 'status'),
          reason: optionalText(payload.reason, 'reason'),
          version: envelopeVersion(envelope),
        },
      };
    case 'PROGRAM_REINSTATED':
      return {
        type: 'PROGRAM_REINSTATED',
        programId: programId(envelope),
        amendmentRef: text(payload.amendmentRef, 'amendmentRef', 128),
        version: envelopeVersion(envelope),
      };
    case 'FX_RATE_PUBLISHED':
      return fxRate(envelope);
    default:
      return undefined;
  }
}

export function isInvoiceCommand(command: Command): command is InvoiceCommand {
  return command.type.startsWith('INVOICE_');
}

export function toCommand(envelope: Envelope): CommandResult {
  if (envelope.schemaVersion !== SUPPORTED_SCHEMA_VERSION) return { kind: 'unsupported' };
  try {
    const command = build(envelope);
    return command ? { kind: 'command', command } : { kind: 'unsupported' };
  } catch (error) {
    if (error instanceof Invalid) return { kind: 'invalid', reason: error.message };
    throw error;
  }
}