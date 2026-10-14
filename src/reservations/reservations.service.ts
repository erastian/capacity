import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type { Env } from '../config/env.js';
import { writeOutbox } from '../outbox/outbox.writer.js';
import { type Tx, PrismaService } from '../shared/db/prisma.service.js';
import { AppError } from '../shared/errors/app-error.js';
import { problem } from '../shared/errors/problem.js';
import { Decimal } from 'decimal.js';
import { capacityOf } from '../shared/money/capacity.js';
import type { CapacityBalances } from '../shared/money/capacity.types.js';
import { minorUnits } from '../shared/money/currency.js';
import { fitsMinorUnits, formatAmount, formatCapacity } from '../shared/money/money.js';
import { businessDate, Clock } from '../shared/time/clock.js';
import { assess, DECLINE_STATUS, needsFx } from './domain/assess.js';
import type {
  AssessContext,
  DeclineCode,
  FxQuote,
  ProgramState,
  ReserveInput,
} from './domain/assess.types.js';
import { ReservationRepository } from './reservation.repository.js';
import type {
  ExistingReservation,
  ReserveCommand,
  ReserveOutcome as Outcome,
  ReserveResult,
} from './reservation.types.js';
import type { ReserveRequest } from './reserve.dto.js';

export function requestHash(request: ReserveRequest): string {
  const canonical = {
    amount: new Decimal(request.amount).toString(),
    currency: request.currency,
    dueDate: request.dueDate,
    invoiceId: request.invoiceId,
    programId: request.programId,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function validate(request: ReserveRequest): void {
  const errors: { field: string; messages: string[] }[] = [];
  if (!fitsMinorUnits(request.amount, request.currency)) {
    errors.push({
      field: 'amount',
      messages: [`amount must have at most ${minorUnits(request.currency)} decimal places for ${request.currency}`],
    });
  }
  if (new Decimal(request.amount).lte(0)) {
    errors.push({ field: 'amount', messages: ['amount must be greater than zero'] });
  }
  if (errors.length > 0) {
    throw new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'VALIDATION_FAILED', {
      detail: 'Request validation failed',
      extensions: { errors },
    });
  }
}

@Injectable()
export class ReservationsService {
  private readonly timeZone: string;
  private readonly fxMaxAgeMs: number;
  private readonly idempotencyTtlMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: ReservationRepository,
    private readonly clock: Clock,
    config: ConfigService<Env, true>,
  ) {
    this.timeZone = config.get('BUSINESS_TIMEZONE', { infer: true });
    this.fxMaxAgeMs = config.get('FX_RATE_MAX_AGE_SECONDS', { infer: true }) * 1000;
    this.idempotencyTtlMs = config.get('IDEMPOTENCY_TTL_SECONDS', { infer: true }) * 1000;
  }

  async reserve(command: ReserveCommand): Promise<ReserveResult> {
    validate(command.request);
    const hash = requestHash(command.request);
    const clientId = command.principal.subject;

    return this.prisma.inTransaction(async (tx) => {
      await this.repository.lockIdempotencyKey(tx, clientId, command.idempotencyKey);

      const stored = await this.repository.findStoredResponse(tx, clientId, command.idempotencyKey);
      if (stored) {
        if (stored.requestHash !== hash) {
          throw new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'IDEMPOTENCY_KEY_REUSED', {
            detail: 'Idempotency-Key was already used with a different request',
          });
        }
        return { status: stored.status, body: stored.body, replayed: true };
      }

      const outcome = await this.decide(tx, command);
      const now = this.clock.now();
      await this.repository.storeResponse(
        tx,
        clientId,
        command.idempotencyKey,
        { requestHash: hash, ...outcome },
        new Date(now.getTime() + this.idempotencyTtlMs),
      );
      return { ...outcome, replayed: false };
    });
  }

  private async decide(tx: Tx, command: ReserveCommand): Promise<Outcome> {
    const { request, principal } = command;

    const program = await this.repository.lockProgram(tx, request.programId);
    if (!program) {
      return this.problem(command, HttpStatus.NOT_FOUND, 'PROGRAM_NOT_FOUND', {
        detail: `Program ${request.programId} not found`,
      });
    }

    const existing = await this.repository.findByInvoice(tx, request.invoiceId);
    if (existing) return this.alreadyReserved(command, existing);

    const input: ReserveInput = {
      originalAmount: new Decimal(request.amount),
      currency: request.currency,
      dueDate: request.dueDate,
    };
    const fx = needsFx(program, input)
      ? await this.repository.currentValuationRate(tx, input.currency, program.currency)
      : undefined;

    const now = this.clock.now();
    const context: AssessContext = {
      businessDate: businessDate(now, this.timeZone),
      now,
      fxMaxAgeMs: this.fxMaxAgeMs,
    };

    const assessment = assess(program, input, fx, context);
    if (assessment.outcome === 'decline') {
      return this.decline(tx, command, program, input, assessment, context);
    }

    await this.repository.savepoint(tx);
    const created = await this.repository.insertReservation(tx, {
      programId: program.id,
      invoiceId: request.invoiceId,
      originalAmount: input.originalAmount,
      originalCurrency: input.currency,
      fxRateId: assessment.fx?.id ?? null,
      amount: assessment.amount,
      dueDate: input.dueDate,
      createdBy: principal.subject,
      correlationId: command.correlationId,
    });
    if (!created) {
      await this.repository.rollbackToSavepoint(tx);
      const winner = await this.repository.findByInvoice(tx, request.invoiceId);
      if (!winner) throw new Error(`Reservation for ${request.invoiceId} vanished`);
      return this.alreadyReserved(command, winner);
    }

    const after = await this.repository.consumeCapacity(tx, program.id, assessment.amount);
    if (!after) {
      await this.repository.rollbackToSavepoint(tx);
      return this.decline(
        tx,
        command,
        program,
        input,
        { code: 'INSUFFICIENT_CAPACITY', amount: assessment.amount, fx: assessment.fx },
        context,
      );
    }
    await this.repository.insertReserveLedger(tx, program.id, created.id, assessment.amount, after);
    await this.repository.releaseSavepoint(tx);

    const body = this.reservationBody(
      program,
      request.invoiceId,
      input,
      assessment.amount,
      assessment.fx,
      created,
      after,
    );
    const { id, program: balances, createdAt: _createdAt, ...reservation } = body;
    await writeOutbox(tx, {
      type: 'RESERVATION_CREATED',
      programId: program.id,
      partitionKey: program.externalId,
      correlationId: command.correlationId,
      occurredAt: context.now,
      data: {
        reservationId: id,
        ...reservation,
        reservedAfter: balances.reserved,
        available: balances.available,
      },
    });
    return { status: HttpStatus.CREATED, body };
  }

  private reservationBody(
    program: ProgramState,
    invoiceId: string,
    input: ReserveInput,
    amount: Decimal,
    fx: FxQuote | undefined,
    created: { id: string; createdAt: Date },
    after: CapacityBalances,
  ) {
    const original = formatAmount(input.originalAmount, minorUnits(input.currency));
    const { available } = capacityOf(after);
    return {
      id: created.id,
      programId: program.externalId,
      invoiceId,
      status: 'ACTIVE',
      originalAmount: original,
      originalCurrency: input.currency,
      amount: formatCapacity(amount),
      currency: program.currency,
      fxRateId: fx?.rateId ?? null,
      dueDate: input.dueDate,
      outstanding: original,
      capacityOutstanding: formatCapacity(amount),
      createdAt: created.createdAt.toISOString(),
      program: {
        available: formatCapacity(available),
        reserved: formatCapacity(after.reserved),
        currency: program.currency,
      },
    };
  }

  private async decline(
    tx: Tx,
    command: ReserveCommand,
    program: ProgramState,
    input: ReserveInput,
    assessment: { code: DeclineCode; amount?: Decimal; fx?: FxQuote },
    context: AssessContext,
  ): Promise<Outcome> {
    const { available, overLimit } = capacityOf(program);
    const details = {
      programStatus: program.status,
      openBlockingBreaks: program.openBlockingBreaks,
      creditLimit: formatCapacity(program.creditLimit),
      externalUtilized: formatCapacity(program.externalUtilized),
      reserved: formatCapacity(program.reserved),
      available: formatCapacity(available),
      overLimit: formatCapacity(overLimit),
      currency: program.currency,
      requestedCapacity: assessment.amount ? formatCapacity(assessment.amount) : null,
      fxRateId: assessment.fx?.rateId ?? null,
      fxRate: assessment.fx?.rate?.toString() ?? null,
      dueDate: input.dueDate,
      businessDate: context.businessDate,
    };

    await this.repository.insertDecline(tx, {
      programId: program.id,
      invoiceId: command.request.invoiceId,
      requestedAmount: input.originalAmount,
      requestedCurrency: input.currency,
      code: assessment.code,
      details,
      createdBy: command.principal.subject,
      correlationId: command.correlationId,
    });
    await writeOutbox(tx, {
      type: 'RESERVATION_DECLINED',
      programId: program.id,
      partitionKey: program.externalId,
      correlationId: command.correlationId,
      occurredAt: context.now,
      data: {
        programId: program.externalId,
        invoiceId: command.request.invoiceId,
        requestedAmount: formatAmount(input.originalAmount, minorUnits(input.currency)),
        requestedCurrency: input.currency,
        code: assessment.code,
        details,
      },
    });

    return this.problem(command, DECLINE_STATUS[assessment.code], assessment.code, {
      extensions: { available: formatCapacity(available), currency: program.currency },
    });
  }

  private alreadyReserved(command: ReserveCommand, existing: ExistingReservation): Outcome {
    return this.problem(command, HttpStatus.CONFLICT, 'INVOICE_ALREADY_RESERVED', {
      detail: `Invoice ${existing.invoiceId} is already reserved`,
      extensions: { reservation: existing },
    });
  }

  private problem(
    command: ReserveCommand,
    status: number,
    code: string,
    options: { detail?: string; extensions?: Record<string, unknown> } = {},
  ): Outcome {
    return {
      status,
      body: problem({
        status,
        code,
        ...options,
        instance: command.instance,
        correlationId: command.correlationId,
      }),
    };
  }
}