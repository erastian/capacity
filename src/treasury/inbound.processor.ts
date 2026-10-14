import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Decimal } from 'decimal.js';
import type { Env } from '../config/env.js';
import type { OutboundEventType } from '../outbox/outbox.types.js';
import { writeOutbox } from '../outbox/outbox.writer.js';
import { type Tx, PrismaService } from '../shared/db/prisma.service.js';
import { minorUnits } from '../shared/money/currency.js';
import { CAPACITY_SCALE, formatAmount } from '../shared/money/money.js';
import { Clock } from '../shared/time/clock.js';
import { isInvoiceCommand, toCommand } from './adapter/commands.js';
import type { FxRatePublished, InvoiceCommand, ProgramCommand } from './adapter/commands.types.js';
import { parseEnvelope } from './adapter/envelope.js';
import type { RawMessage } from './adapter/envelope.types.js';
import { DeadLetterPublisher } from './dead-letter.js';
import { decideFxRate } from './domain/fx-rate-decision.js';
import { decideInvoiceCommand } from './domain/invoice-decision.js';
import type {
  InvoiceBreak,
  InvoiceEffect,
  InvoiceFacts,
  ReleaseReason,
  ReservationView,
} from './domain/invoice-decision.types.js';
import { decideProgramCommand, overLimit } from './domain/program-decision.js';
import type { Balances, BreakSpec, ProgramPlan, ProgramView } from './domain/program-decision.types.js';
import { InboundMetrics } from './inbound.metrics.js';
import { InboundRepository, KNOWN_TYPES } from './inbound.repository.js';
import type { AwaitingKind, Decision, ProcessingContext as Context } from './inbound.types.js';
import { writeStatus } from './status.writer.js';

const ZERO_BALANCES = (program: ProgramView): Balances => ({
  creditLimit: program.creditLimit.mul(0),
  externalUtilized: program.externalUtilized.mul(0),
  reserved: program.reserved,
});

const balancesOf = (program: ProgramView): Balances => ({
  creditLimit: program.creditLimit,
  externalUtilized: program.externalUtilized,
  reserved: program.reserved,
});

const effectiveAsOf = ({ envelope, coordinates }: Context): Date =>
  envelope.asOf < coordinates.timestamp ? envelope.asOf : coordinates.timestamp;

const RELEASE_EVENTS: Record<ReleaseReason, OutboundEventType> = {
  REPAYMENT: 'RESERVATION_RELEASED',
  WRITE_OFF: 'RESERVATION_RELEASED',
  CANCELLATION: 'RESERVATION_CANCELLED',
  REVERSAL: 'RESERVATION_RELEASE_REVERSED',
};

@Injectable()
export class InboundProcessor {
  private readonly logger = new Logger(InboundProcessor.name);
  private readonly publishAccepted: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: InboundRepository,
    private readonly metrics: InboundMetrics,
    private readonly deadLetters: DeadLetterPublisher,
    private readonly clock: Clock,
    config: ConfigService<Env, true>,
  ) {
    this.publishAccepted = config.get('PUBLISH_ACCEPTED_STATUS', { infer: true });
  }

  async process(raw: RawMessage): Promise<void> {
    this.metrics.received(raw.topic, raw.timestamp, this.clock.now());

    const parsed = parseEnvelope(raw);
    if (parsed.kind === 'unreadable') {
      await this.deadLetters.send(raw, `UNREADABLE_ENVELOPE: ${parsed.reason}`);
      this.metrics.deadLettered('UNREADABLE_ENVELOPE');
      return;
    }

    const envelope = parsed.envelope;
    this.metrics.checkClock(envelope, raw.timestamp);

    const decision = await this.prisma.inTransaction((tx) =>
      this.decide(tx, {
        envelope,
        coordinates: { topic: raw.topic, partition: raw.partition, offset: raw.offset, timestamp: raw.timestamp },
        partitionKey: raw.key ?? envelope.programId ?? envelope.messageId,
        fromParked: false,
      }),
    );

    if (decision.deadLetter) {
      await this.deadLetters.send(raw, decision.deadLetter);
      this.metrics.deadLettered(decision.deadLetter);
    }
    if (decision.wake) await this.resolveParked(decision.wake);
    if (decision.wakeRate) await this.resolveAwaitingRate(decision.wakeRate);
  }

  async resolveAwaitingRate(rateId: string): Promise<void> {
    const programs = await this.prisma.inTransaction((tx) => this.repository.programsAwaitingRate(tx, rateId));
    for (const programExternalId of programs) await this.resolveParked(programExternalId);
  }

  async resolveParked(programExternalId: string): Promise<void> {
    for (;;) {
      const progressed = await this.prisma.inTransaction(async (tx) => {
        const program = await this.repository.lockProgram(tx, programExternalId);
        if (!program) return false;
        const parked = await this.repository.nextResolvableParked(tx, programExternalId);
        if (!parked) return false;

        const decision = await this.decide(tx, {
          envelope: parked.envelope,
          coordinates: parked.coordinates,
          partitionKey: programExternalId,
          fromParked: true,
        });
        if (!decision.parked) await this.repository.markResolved(tx, parked.messageId);
        return true;
      });
      if (!progressed) return;
    }
  }

  async resolveAllParked(): Promise<void> {
    const programs = await this.prisma.inTransaction((tx) => this.repository.programsWithResolvableParked(tx));
    for (const programExternalId of programs) await this.resolveParked(programExternalId);
  }

  private async decide(tx: Tx, context: Context): Promise<Decision> {
    const { envelope } = context;
    const programExternalId = envelope.programId;
    const program = programExternalId ? await this.repository.lockProgram(tx, programExternalId) : undefined;

    if (!context.fromParked) {
      const duplicate = await this.answerDuplicate(tx, context, program);
      if (duplicate) return duplicate;
    }

    const result = toCommand(envelope);
    if (result.kind !== 'command') {
      const reason = result.kind === 'invalid' ? 'INVALID_FORMAT' : 'UNKNOWN_MESSAGE_TYPE';
      await this.repository.insertInbox(tx, envelope, context.coordinates, {
        type: KNOWN_TYPES.has(envelope.type) ? envelope.type : null,
        outcome: 'REJECTED',
        reason,
        programId: program?.id ?? null,
        programExternalId: programExternalId ?? null,
      });
      await this.status(tx, context, program, 'RJCT', { reason });
      this.metrics.decided(envelope.type, 'REJECTED');
      if (result.kind === 'invalid') this.logger.warn(`${envelope.messageId}: ${result.reason}`);
      return { deadLetter: reason };
    }

    const command = result.command;
    if (command.type === 'FX_RATE_PUBLISHED') return this.applyRate(tx, context, command);

    const creating = !program && command.type === 'PROGRAM_SNAPSHOT';
    const reservation =
      program && isInvoiceCommand(command) ? await this.repository.findReservation(tx, command.invoiceId) : undefined;
    const queue = reservation && reservation.programId === program?.id ? reservation.id : null;
    if (!context.fromParked && !creating) {
      const predecessor = await this.repository.lastUnresolvedParked(tx, command.programId, queue);
      if (predecessor) return this.park(tx, context, command, program, queue, 'PRECEDING_MESSAGE', predecessor);
    }
    if (!program && !creating) return this.park(tx, context, command, program, null, 'PROGRAM', command.programId);

    if (isInvoiceCommand(command)) return this.applyInvoice(tx, context, command, program!, reservation);
    return this.apply(tx, context, command, program, decideProgramCommand(command, program));
  }

  private async applyInvoice(
    tx: Tx,
    context: Context,
    command: InvoiceCommand,
    program: ProgramView,
    found: ReservationView | undefined,
  ): Promise<Decision> {
    const { envelope, coordinates } = context;
    const own = found && found.programId === program.id ? await this.repository.lockReservation(tx, found.id) : undefined;
    const reservation = own ?? found;
    const facts = own ? await this.invoiceFacts(tx, command, own) : {};
    const plan = decideInvoiceCommand(command, program.id, reservation, facts);

    if (plan.outcome === 'AWAIT_RATE') {
      return this.park(tx, context, command, program, own!.id, 'FX_RATE', plan.rateId);
    }
    this.metrics.decided(command.type, plan.outcome);

    const references: Record<string, string> = reservation ? { reservationId: reservation.id } : {};
    const inbox = (outcome: 'APPLIED' | 'STALE' | 'REJECTED', reason: string | null = null) =>
      this.repository.insertInbox(tx, envelope, coordinates, {
        type: command.type,
        outcome,
        reason,
        programId: program.id,
        programExternalId: command.programId,
      });

    if (plan.outcome === 'REJECTED') {
      await inbox('REJECTED', plan.reason);
      if (plan.break) {
        const target =
          plan.break.reason === 'PROGRAM_MISMATCH'
            ? await this.repository.lockProgram(tx, reservation!.programExternalId)
            : program;
        references.breakId = await this.openBreak(tx, plan.break, target!, target!.externalId, envelope.messageId);
      }
      await this.status(tx, context, program, 'RJCT', { reason: plan.reason, references });
      return {};
    }

    if (plan.outcome === 'STALE') {
      await inbox('STALE');
      await this.status(tx, context, program, 'ACCP', { references });
      return {};
    }

    await inbox('APPLIED');
    const effect = plan.effect;
    if (effect.kind === 'FUND') {
      await this.repository.fund(tx, own!.id, effect.fundingRef, effectiveAsOf(context), envelope.messageId);
    } else if (effect.kind === 'RETURN_FUNDING') {
      await this.repository.returnFunding(tx, own!.id, effect.fundingRef, effectiveAsOf(context), envelope.messageId);
    } else {
      references.releaseId = await this.release(tx, context, program, own!, effect);
    }
    await this.status(tx, context, program, 'ACCP', { references });
    return {};
  }

  private async invoiceFacts(tx: Tx, command: InvoiceCommand, reservation: ReservationView): Promise<InvoiceFacts> {
    const release = (externalRef: string) => this.repository.findRelease(tx, reservation.id, externalRef);
    switch (command.type) {
      case 'INVOICE_FUNDED':
      case 'INVOICE_FUNDING_RETURNED':
        return { funding: await this.repository.findFunding(tx, command.fundingRef) };
      case 'INVOICE_PAYMENT_ALLOCATED':
        return {
          sameRef: await release(command.allocationId),
          quote: command.fxRateId ? await this.repository.findQuoteByRateId(tx, command.fxRateId) : undefined,
        };
      case 'INVOICE_BALANCE_WRITTEN_OFF':
        return { sameRef: await release(command.writeOffId) };
      case 'INVOICE_FUNDING_CANCELLED':
        return { sameRef: await release(command.cancellationId) };
      case 'INVOICE_RELEASE_REVERSED':
        return { sameRef: await release(command.reversalId), target: await release(command.externalRef) };
    }
  }

  private async release(
    tx: Tx,
    context: Context,
    program: ProgramView,
    reservation: ReservationView,
    effect: Extract<InvoiceEffect, { kind: 'RELEASE' }>,
  ): Promise<string> {
    const { envelope } = context;
    const { release: row, balances, reservedDelta } = effect;
    const releaseId = await this.repository.insertRelease(tx, reservation.id, row, envelope.messageId);
    await this.repository.rebalanceReservation(tx, reservation, balances);
    const after = await this.repository.addReserved(tx, program.id, reservedDelta);
    await this.repository.insertReleaseLedger(
      tx,
      after,
      reservation.id,
      releaseId,
      row.reason === 'REVERSAL',
      reservedDelta,
      envelope.messageId,
    );

    const invoiceScale = minorUnits(reservation.originalCurrency);
    const capacity = (value: Decimal) => formatAmount(value, CAPACITY_SCALE);
    const available = Decimal.max(0, after.creditLimit.minus(after.externalUtilized).minus(after.reserved));
    await writeOutbox(tx, {
      type: RELEASE_EVENTS[row.reason],
      programId: program.id,
      partitionKey: program.externalId,
      correlationId: envelope.messageId,
      occurredAt: this.clock.now(),
      data: {
        reservationId: reservation.id,
        invoiceId: reservation.invoiceId,
        programId: program.externalId,
        releaseId,
        externalRef: row.externalRef,
        reason: row.reason,
        reversesReleaseId: row.reversesReleaseId,
        cancellationReason: row.cancellationReason,
        writeOffReason: row.writeOffReason,
        originalAmount: formatAmount(row.originalAmount, invoiceScale),
        originalCurrency: reservation.originalCurrency,
        amount: capacity(row.amount),
        currency: program.currency,
        status: balances.status,
        outstanding: formatAmount(reservation.originalAmount.minus(balances.releasedOriginalAmount), invoiceScale),
        capacityOutstanding: capacity(reservation.amount.minus(balances.releasedAmount)),
        reservedAfter: capacity(after.reserved),
        available: capacity(available),
      },
    });
    await this.limitExcess(tx, after, balancesOf(program), envelope.messageId);
    return releaseId;
  }

  private async openBreak(
    tx: Tx,
    spec: BreakSpec | InvoiceBreak,
    program: ProgramView | undefined,
    programExternalId: string,
    messageId: string,
  ): Promise<string> {
    const opened = await this.repository.openBreak(tx, spec, program, programExternalId, messageId);
    if (opened.created) {
      await writeOutbox(tx, {
        type: 'PROGRAM_BREAK_OPENED',
        programId: program?.id ?? null,
        partitionKey: programExternalId,
        correlationId: messageId,
        occurredAt: this.clock.now(),
        data: {
          breakId: opened.id,
          programId: programExternalId,
          reservationId: 'reservationId' in spec ? spec.reservationId : null,
          reason: spec.reason,
          blocking: program ? spec.blocking : false,
          messageId,
          details: spec.details,
        },
      });
    }
    return opened.id;
  }

  private async applyRate(tx: Tx, context: Context, quote: FxRatePublished): Promise<Decision> {
    const plan = decideFxRate(
      quote,
      await this.repository.findQuoteByRateId(tx, quote.rateId),
      await this.repository.findQuoteByPairVersion(tx, quote),
    );
    this.metrics.decided(quote.type, plan.outcome);

    await this.repository.insertInbox(tx, context.envelope, context.coordinates, {
      type: quote.type,
      outcome: plan.outcome,
      reason: plan.outcome === 'REJECTED' ? plan.reason : null,
      programId: null,
      programExternalId: null,
    });

    if (plan.outcome === 'REJECTED') {
      this.logger.warn(
        `FX_RATE_CONFLICT: ${quote.rateId} (${quote.from}/${quote.to} ${quote.rateType} v${quote.version}) conflicts with ${plan.conflictsWith}`,
      );
      await this.status(tx, context, undefined, 'RJCT', {
        reason: plan.reason,
        references: { conflictsWith: plan.conflictsWith },
      });
      return {};
    }

    if (plan.outcome === 'APPLIED') {
      await this.repository.insertQuote(tx, quote, context.envelope, context.coordinates);
    }
    await this.status(tx, context, undefined, 'ACCP');
    return plan.outcome === 'APPLIED' ? { wakeRate: quote.rateId } : {};
  }

  private async answerDuplicate(tx: Tx, context: Context, program: ProgramView | undefined): Promise<Decision | undefined> {
    const { messageId } = context.envelope;
    const inbox = await this.repository.findInbox(tx, messageId);
    if (inbox) {
      await this.status(tx, context, program, inbox.outcome === 'REJECTED' ? 'RJCT' : 'ACCP', {
        reason: inbox.reason,
        force: true,
      });
      this.metrics.duplicate(inbox.outcome);
      const formal = inbox.reason === 'INVALID_FORMAT' || inbox.reason === 'UNKNOWN_MESSAGE_TYPE';
      return formal ? { deadLetter: inbox.reason! } : {};
    }

    const parked = await this.repository.findParked(tx, messageId);
    if (parked) {
      if (!parked.resolvedAt) {
        await this.status(tx, context, program, 'PDNG', {
          awaiting: { kind: parked.awaitingKind, ref: parked.awaitingRef },
        });
      }
      this.metrics.duplicate('PARKED');
      return {};
    }
    return undefined;
  }

  private async park(
    tx: Tx,
    context: Context,
    command: ProgramCommand | InvoiceCommand,
    program: ProgramView | undefined,
    reservationId: string | null,
    awaitingKind: AwaitingKind,
    awaitingRef: string,
  ): Promise<Decision> {
    if (context.fromParked) {
      await this.repository.awaitAgain(tx, context.envelope.messageId, awaitingKind, awaitingRef);
    } else {
      await this.repository.insertParked(tx, {
        messageId: context.envelope.messageId,
        type: command.type,
        programId: program?.id ?? null,
        programExternalId: command.programId,
        reservationId,
        awaitingKind,
        awaitingRef,
        envelope: context.envelope,
        coordinates: context.coordinates,
      });
    }
    await this.status(tx, context, program, 'PDNG', { awaiting: { kind: awaitingKind, ref: awaitingRef } });
    this.metrics.decided(command.type, 'PARKED');
    return { wake: command.programId, parked: true };
  }

  private async apply(
    tx: Tx,
    context: Context,
    command: ProgramCommand,
    program: ProgramView | undefined,
    plan: ProgramPlan,
  ): Promise<Decision> {
    const { envelope, coordinates } = context;
    const asOf = effectiveAsOf(context);
    this.metrics.decided(command.type, plan.outcome);

    const inbox = (outcome: 'APPLIED' | 'STALE' | 'REJECTED', programId: string | null, reason: string | null = null) =>
      this.repository.insertInbox(tx, envelope, coordinates, {
        type: command.type,
        outcome,
        reason,
        programId,
        programExternalId: command.programId,
      });

    if (plan.outcome === 'REJECTED') {
      await inbox('REJECTED', program?.id ?? null, plan.reason);
      const breakId = await this.openBreak(tx, plan.break, program, command.programId, envelope.messageId);
      await this.status(tx, context, program, 'RJCT', { reason: plan.reason, references: { breakId } });
      return {};
    }

    if (plan.outcome === 'STALE') {
      await inbox('STALE', program!.id);
      await this.repository.touchSyncedAt(tx, program!.id, asOf);
      await this.status(tx, context, program, 'ACCP');
      return {};
    }

    const before = program ? balancesOf(program) : undefined;
    const after =
      'create' in plan
        ? await this.repository.createProgram(tx, plan.create, asOf)
        : await this.repository.updateProgram(tx, program!, plan.changes, asOf);

    await inbox('APPLIED', after.id);
    await this.repository.insertTreasuryLedger(
      tx,
      after.id,
      plan.ledger,
      before ?? ZERO_BALANCES(after),
      balancesOf(after),
      envelope.messageId,
    );
    await this.limitExcess(tx, after, before, envelope.messageId);
    await this.status(tx, context, after, 'ACCP');
    return 'create' in plan ? { wake: command.programId } : {};
  }

  private async limitExcess(tx: Tx, program: ProgramView, before: Balances | undefined, messageId: string): Promise<void> {
    const was = before ? overLimit(before) : overLimit(ZERO_BALANCES(program));
    const now = overLimit(balancesOf(program));
    const started = was.isZero() && !now.isZero();
    const ended = !was.isZero() && now.isZero();
    if (!started && !ended) return;

    if (started) {
      this.logger.warn(`LIMIT_EXCESS: program ${program.externalId} is over limit by ${now.toFixed(CAPACITY_SCALE)}`);
    }
    await writeOutbox(tx, {
      type: started ? 'PROGRAM_LIMIT_EXCESS_STARTED' : 'PROGRAM_LIMIT_EXCESS_ENDED',
      programId: program.id,
      partitionKey: program.externalId,
      correlationId: messageId,
      occurredAt: this.clock.now(),
      data: {
        programId: program.externalId,
        overLimit: formatAmount(now, CAPACITY_SCALE),
        currency: program.currency,
        creditLimit: formatAmount(program.creditLimit, CAPACITY_SCALE),
        externalUtilized: formatAmount(program.externalUtilized, CAPACITY_SCALE),
        reserved: formatAmount(program.reserved, CAPACITY_SCALE),
        causeMessageId: messageId,
      },
    });
  }

  private async status(
    tx: Tx,
    context: Context,
    program: ProgramView | undefined,
    status: 'ACCP' | 'RJCT' | 'PDNG',
    options: {
      reason?: string | null;
      awaiting?: { kind: string; ref: string };
      references?: Record<string, string>;
      force?: boolean;
    } = {},
  ): Promise<void> {
    if (status === 'ACCP' && !this.publishAccepted && !context.fromParked && !options.force) return;
    await writeStatus(tx, {
      messageId: context.envelope.messageId,
      status,
      reason: options.reason,
      awaiting: options.awaiting,
      references: options.references,
      programId: program?.id ?? null,
      partitionKey: context.partitionKey,
      correlationId: context.envelope.messageId,
      decidedAt: this.clock.now(),
    });
  }
}