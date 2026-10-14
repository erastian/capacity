import { Prisma } from '../generated/prisma/client.js';
import { givesUp } from './retry-policy.js';

const postgres = (originalCode: string, code = 'P2010') =>
  new Prisma.PrismaClientKnownRequestError('failed', {
    code,
    clientVersion: 'test',
    meta: { driverAdapterError: { cause: { originalCode } } },
  });

const adapter = (kind: string) =>
  new Prisma.PrismaClientKnownRequestError('failed', {
    code: 'P2010',
    clientVersion: 'test',
    meta: { driverAdapterError: { cause: { kind } } },
  });

describe('retry policy', () => {
  it('gives up on a data error at once', () => {
    expect(givesUp(postgres('22003'), 1, 10)).toBe(true);
    expect(givesUp(postgres('23514'), 1, 10)).toBe(true);
  });

  it('retries any other error until the attempts run out', () => {
    expect(givesUp(new Error('[DecimalError] Invalid argument'), 9, 10)).toBe(false);
    expect(givesUp(new Error('[DecimalError] Invalid argument'), 10, 10)).toBe(true);
    expect(givesUp(postgres('23503'), 10, 10)).toBe(true);
  });

  it.each([
    ['a deadlock', postgres('40P01')],
    ['a serialization failure', postgres('40001')],
    ['a statement timeout', postgres('57014')],
    ['a lock timeout', postgres('55P03')],
    ['a lost connection', postgres('08006')],
    ['too many connections', postgres('53300')],
    ['a transaction that could not start', postgres('', 'P2028')],
    ['an unreachable database', adapter('DatabaseNotReachable')],
    ['a closed connection', adapter('ConnectionClosed')],
    ['a client query timeout', new Error('Query read timeout')],
    ['a terminated connection', new Error('Connection terminated unexpectedly')],
  ])('never gives up on %s', (_, error) => {
    expect(givesUp(error, 100, 10)).toBe(false);
  });
});
