import { ProduceAcks, Producer, stringSerializers } from '@platformatic/kafka';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { CachedToken, Credentials, Money, ProgramMessage, Quote, Scenario, SimulatorConfig, World } from './treasury-simulator.types.js';

const env = process.env;

const config: SimulatorConfig = {
  apiUrl: env.SIMULATOR_API_URL ?? 'http://localhost:3000',
  tokenUrl: env.SIMULATOR_TOKEN_URL ?? 'http://localhost:8080/realms/capacity/protocol/openid-connect/token',
  originationClient: { id: 'origination', secret: env.SIMULATOR_ORIGINATION_SECRET ?? 'origination-local-secret' },
  auditor: { username: 'auditor', password: env.SIMULATOR_AUDITOR_PASSWORD ?? 'auditor' },
  brokers: env.KAFKA_BROKERS ?? 'localhost:9092',
  treasury: { username: 'treasury', password: env.SIMULATOR_TREASURY_PASSWORD ?? 'treasury-secret' },
};

const unique = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;
let quoteVersion = BigInt(Date.now()) * 1000n;

const ORIGINATION: Credentials = {
  grant_type: 'client_credentials',
  client_id: config.originationClient.id,
  client_secret: config.originationClient.secret,
};
const AUDITOR: Credentials = { grant_type: 'password', client_id: 'capacity-local', ...config.auditor };

const tokens = new Map<Credentials, CachedToken>();

async function token(credentials: Credentials): Promise<string> {
  const cached = tokens.get(credentials);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const res = await fetch(config.tokenUrl, { method: 'POST', body: new URLSearchParams(credentials) });
  if (!res.ok) throw new Error(`token request failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  tokens.set(credentials, { value: body.access_token, expiresAt: Date.now() + (body.expires_in - 30) * 1000 });
  return body.access_token;
}

async function api(as: Credentials, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${config.apiUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${await token(as)}`, 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
  } catch {
    throw new Error(`${method} ${path} answered ${res.status}: ${text.slice(0, 200)}`);
  }
}

async function list<T>(path: string): Promise<T[]> {
  const res = await api(AUDITOR, 'GET', path);
  if (res.status !== 200) throw new Error(`GET ${path} answered ${res.status} ${String(res.body.code ?? '')}`);
  return res.body.items as T[];
}

const snapshot = (limit: string, extra: Record<string, unknown> = {}) => ({
  currency: 'EUR',
  clientRef: 'C-ACME',
  creditLimit: { amount: limit, currency: 'EUR', version: 1 },
  externalUtilized: { amount: '0', currency: 'EUR', version: 1 },
  status: { value: 'ACTIVE', version: 1 },
  ...extra,
});

const FRESH_QUOTES: Omit<Quote, 'rateId'>[] = [
  { from: 'USD', to: 'EUR', rateType: 'VALUATION', rate: '0.92' },
  { from: 'GBP', to: 'EUR', rateType: 'VALUATION', rate: '1.17' },
  { from: 'CHF', to: 'EUR', rateType: 'VALUATION', rate: '1.05' },
  { from: 'EUR', to: 'USD', rateType: 'VALUATION', rate: '1.08' },
  { from: 'GBP', to: 'USD', rateType: 'VALUATION', rate: '1.27' },
  { from: 'EUR', to: 'GBP', rateType: 'VALUATION', rate: '0.85' },
  { from: 'USD', to: 'GBP', rateType: 'VALUATION', rate: '0.79' },
  { from: 'GBP', to: 'USD', rateType: 'CONVERSION', rate: '1.265' },
  { from: 'EUR', to: 'USD', rateType: 'CONVERSION', rate: '1.075' },
  { from: 'USD', to: 'EUR', rateType: 'CONVERSION', rate: '0.915' },
  { from: 'GBP', to: 'EUR', rateType: 'CONVERSION', rate: '1.165' },
];

const scenarios: Record<string, Scenario> = {
  demo: {
    description: 'the programme P-DEMO of C-ACME used by the http/*.http requests, plus fresh quotes',
    run: async (world) => {
      await world.sendProgram({ type: 'PROGRAM_SNAPSHOT', programId: 'P-DEMO', payload: snapshot('1000000') });
      for (const quote of FRESH_QUOTES) await world.sendQuote({ ...quote, rateId: world.unique('R') });
      await world.settle();
      await world.show('P-DEMO');
    },
  },

  rates: {
    description: 'publish fresh VALUATION and CONVERSION quotes for the usual pairs (quotes go stale after 6h)',
    run: async (world) => {
      for (const quote of FRESH_QUOTES) await world.sendQuote({ ...quote, rateId: world.unique('R') });
      await world.settle();
      await world.showRates();
    },
  },

  onboarding: {
    description: 'a programme appears with its first snapshot',
    run: async (world) => {
      await world.sendProgram({
        type: 'PROGRAM_SNAPSHOT',
        payload: snapshot('1000000', { externalUtilized: { amount: '200000', currency: 'EUR', version: 1 } }),
      });
      await world.settle();
      await world.show();
    },
  },

  'reserve-fund-repay': {
    description: 'reserve an invoice, fund it, repay it in two parts',
    run: async (world) => {
      await world.sendProgram({ type: 'PROGRAM_SNAPSHOT', payload: snapshot('1000000') });
      await world.settle();
      const invoice = await world.reserve({ amount: '100000.00', currency: 'EUR' });
      await world.sendProgram({ type: 'INVOICE_FUNDED', payload: { invoiceId: invoice.invoiceId, fundingRef: world.unique('F') } });
      for (const amount of ['40000.00', '60000.00']) {
        await world.sendProgram({
          type: 'INVOICE_PAYMENT_ALLOCATED',
          payload: {
            invoiceId: invoice.invoiceId,
            allocationId: world.unique('A'),
            paymentId: world.unique('PAY'),
            payment: { amount, currency: 'EUR' },
            settledAmount: { amount, currency: 'EUR' },
          },
        });
      }
      await world.settle();
      await world.show();
    },
  },

  'fx-payment': {
    description: 'a USD invoice paid in GBP; the payment waits for its quote, then applies',
    run: async (world) => {
      await world.sendProgram({ type: 'PROGRAM_SNAPSHOT', payload: snapshot('1000000') });
      await world.sendQuote({ rateId: world.unique('R'), from: 'USD', to: 'EUR', rateType: 'VALUATION', rate: '0.92' });
      await world.settle();
      const invoice = await world.reserve({ amount: '50000.00', currency: 'USD' });
      const conversion = world.unique('R');
      await world.sendProgram({
        type: 'INVOICE_PAYMENT_ALLOCATED',
        payload: {
          invoiceId: invoice.invoiceId,
          allocationId: world.unique('A'),
          paymentId: world.unique('PAY'),
          payment: { amount: '10000.00', currency: 'GBP' },
          settledAmount: { amount: '12650.00', currency: 'USD' },
          fxRateId: conversion,
        },
      });
      await world.settle();
      world.log('the payment is parked until the CONVERSION quote arrives');
      await world.sendQuote({ rateId: conversion, from: 'GBP', to: 'USD', rateType: 'CONVERSION', rate: '1.265' });
      await world.settle();
      await world.show();
    },
  },

  'limit-cut': {
    description: 'treasury cuts the limit below what is reserved; the programme goes over limit',
    run: async (world) => {
      await world.sendProgram({ type: 'PROGRAM_SNAPSHOT', payload: snapshot('100000') });
      await world.settle();
      await world.reserve({ amount: '80000.00', currency: 'EUR' });
      await world.sendProgram({ type: 'LIMIT_UPDATED', version: 2, payload: { creditLimit: { amount: '50000', currency: 'EUR' } } });
      await world.settle();
      await world.reserve({ amount: '1000.00', currency: 'EUR' });
      await world.show();
    },
  },

  'currency-mismatch': {
    description: 'a limit in the wrong currency puts the programme on hold until treasury fixes it',
    run: async (world) => {
      await world.sendProgram({ type: 'PROGRAM_SNAPSHOT', payload: snapshot('100000') });
      await world.sendProgram({ type: 'LIMIT_UPDATED', version: 2, payload: { creditLimit: { amount: '90000', currency: 'USD' } } });
      await world.settle();
      await world.reserve({ amount: '1000.00', currency: 'EUR' });
      await world.sendProgram({ type: 'LIMIT_UPDATED', version: 3, payload: { creditLimit: { amount: '90000', currency: 'EUR' } } });
      await world.settle();
      for (const breakId of await world.openBreaks()) {
        await world.sendProgram({ type: 'BREAK_RESOLVED', payload: { breakId } });
      }
      await world.settle();
      await world.reserve({ amount: '1000.00', currency: 'EUR' });
      await world.show();
    },
  },

  'bulk-batch': {
    description: 'a reconciliation batch of three snapshots and its trailer',
    run: async (world) => {
      const batchId = world.unique('BATCH');
      const programs = [world.unique('P'), world.unique('P'), world.unique('P')];
      for (const programId of programs) {
        await world.sendProgram({ type: 'PROGRAM_SNAPSHOT', programId, batchId, payload: snapshot('500000') });
      }
      await world.sendProgram({ type: 'RECONCILIATION_BATCH_COMPLETED', batchId, payload: { programCount: programs.length } });
      await world.settle();
      for (const programId of programs) await world.show(programId);
    },
  },
};

async function main(): Promise<void> {
  const requested = process.argv[2];
  const names = requested === 'all' ? Object.keys(scenarios) : requested ? [requested] : [];
  if (names.length === 0 || names.some((name) => !scenarios[name])) {
    console.log('usage: npm run simulate -- <scenario|all>\n');
    for (const [name, scenario] of Object.entries(scenarios)) console.log(`  ${name.padEnd(20)} ${scenario.description}`);
    process.exitCode = names.length === 0 ? 0 : 1;
    return;
  }

  await token(ORIGINATION);
  await token(AUDITOR);
  const producer = new Producer({
    clientId: 'treasury-simulator',
    bootstrapBrokers: config.brokers
      .split(',')
      .map((broker) => broker.trim())
      .filter(Boolean),
    sasl: { mechanism: 'PLAIN', ...config.treasury },
    serializers: stringSerializers,
    idempotent: true,
    acks: ProduceAcks.ALL,
    retries: 5,
  });

  try {
    for (const name of names) {
      console.log(`\n== ${name}: ${scenarios[name]!.description}`);
      await scenarios[name]!.run(world(producer));
    }
  } finally {
    await producer.close();
  }
}

function world(producer: Producer<string, string, string, string>): World {
  const programId = unique('P');
  const pending = new Set<string>();
  const log = (line: string) => console.log(`   ${line}`);

  const send = async (topic: string, key: string, value: Record<string, unknown>) => {
    const messageId = unique('m');
    await producer.send({ messages: [{ topic, key, value: JSON.stringify({ messageId, schemaVersion: 1, asOf: new Date().toISOString(), ...value }) }] });
    pending.add(messageId);
    return messageId;
  };

  return {
    programId,
    log,
    unique,

    sendProgram: async (message: ProgramMessage) => {
      const target = message.programId ?? (message.type === 'RECONCILIATION_BATCH_COMPLETED' ? undefined : programId);
      const messageId = await send('treasury.program-capacity', target ?? message.batchId!, {
        type: message.type,
        programId: target,
        batchId: message.batchId,
        version: message.version,
        payload: message.payload,
      });
      log(`-> ${message.type} ${messageId}`);
      return messageId;
    },

    sendQuote: async (quote: Quote) => {
      const messageId = await send('treasury.fx-rates', `${quote.from}:${quote.to}:${quote.rateType}`, {
        type: 'FX_RATE_PUBLISHED',
        version: (++quoteVersion).toString(),
        payload: { status: 'ACTIVE', ...quote },
      });
      log(`-> FX_RATE_PUBLISHED ${quote.from}/${quote.to} ${quote.rateType} ${quote.rate ?? ''} (${quote.rateId})`);
      return messageId;
    },

    reserve: async (invoice: Money & { dueDate?: string; programId?: string }) => {
      const invoiceId = unique('INV');
      const res = await api(
        ORIGINATION,
        'POST',
        '/v1/reservations',
        {
          programId: invoice.programId ?? programId,
          invoiceId,
          amount: invoice.amount,
          currency: invoice.currency,
          dueDate: invoice.dueDate ?? new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10),
        },
        { 'idempotency-key': unique('key') },
      );
      log(`<- reserve ${invoice.amount} ${invoice.currency}: ${res.status} ${res.status === 201 ? res.body.id : res.body.code}`);
      return { id: String(res.body.id ?? ''), invoiceId, status: res.status, body: res.body };
    },

    settle: async () => {
      const deadline = Date.now() + 15_000;
      while (pending.size > 0 && Date.now() < deadline) {
        for (const messageId of pending) {
          const [inbox, parked] = await Promise.all([
            list(`/v1/audit/inbox?messageId=${messageId}`),
            list<{ messageId: string }>(`/v1/audit/parked?unresolved=true&limit=200`),
          ]);
          const decided = inbox.length > 0;
          const waiting = parked.some((item) => item.messageId === messageId);
          if (decided || waiting) pending.delete(messageId);
        }
        if (pending.size > 0) await sleep(300);
      }
      if (pending.size > 0) log(`!! not processed in 15s: ${[...pending].join(', ')} (is the app with the consumer running?)`);
    },

    openBreaks: async () => {
      const breaks = await list<{ id: string }>(`/v1/breaks?programId=${programId}&open=true`);
      return breaks.map((item) => item.id);
    },

    showRates: async () => {
      for (const item of await list<Record<string, unknown>>('/v1/fx-rates?limit=200')) {
        log(`   ${item.from}/${item.to} ${String(item.rateType).padEnd(10)} ${String(item.rate ?? '-').padEnd(10)} ${item.status} as of ${item.asOf}`);
      }
    },

    show: async (target = programId) => {
      const availability = await api(AUDITOR, 'GET', `/v1/programs/${target}/availability`);
      if (availability.status !== 200) {
        log(`programme ${target}: ${availability.body.code}`);
      } else {
        const a = availability.body;
        log(
          `programme ${target} ${a.status}${a.onHold ? ' ON HOLD' : ''}: limit ${a.creditLimit}, external ${a.externalUtilized}, ` +
            `reserved ${a.reserved} (funded ${a.funded}), available ${a.available}, over limit ${a.overLimit} ${a.currency}`,
        );
      }
      const inbox = await list<Record<string, unknown>>(`/v1/audit/inbox?programId=${target}&limit=50`);
      for (const item of inbox.reverse()) {
        log(`   ${String(item.type).padEnd(28)} ${String(item.outcome).padEnd(8)} ${item.reason ?? ''}`);
      }
      for (const item of await list<Record<string, unknown>>(`/v1/breaks?programId=${target}&open=true`)) {
        log(`   open break ${item.id} ${item.reason}${item.blocking ? ' (blocking)' : ''}`);
      }
    },
  };
}

try {
  await main();
} catch (error) {
  console.error(`simulator failed: ${[...new Set(messages(error))].join('; ')}`);
  process.exitCode = 1;
}

function messages(error: unknown): string[] {
  const { message, errors = [], cause } = error as Error & { errors?: unknown[] };
  return [message, ...errors.flatMap(messages), ...(cause ? messages(cause) : [])].filter(Boolean);
}
