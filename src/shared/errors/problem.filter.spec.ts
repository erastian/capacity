import type { ArgumentsHost } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { ProblemFilter } from './problem.filter.js';

function respond(exception: unknown) {
  const sent: { status?: number; headers: Record<string, string>; body?: { code: string } } = { headers: {} };
  const reply = {
    headers: (values: Record<string, string>) => Object.assign(sent.headers, values) && reply,
    header: (name: string, value: string) => ((sent.headers[name] = value), reply),
    status: (status: number) => ((sent.status = status), reply),
    type: () => reply,
    send: (body: { code: string }) => ((sent.body = body), reply),
  };
  const host = {
    switchToHttp: () => ({ getRequest: () => ({ url: '/v1/x', id: 'cid' }), getResponse: () => reply }),
  } as unknown as ArgumentsHost;
  new ProblemFilter().catch(exception, host);
  return sent;
}

const prismaError = (code: string, message = 'failed', originalCode?: string) =>
  new Prisma.PrismaClientKnownRequestError(message, {
    code,
    clientVersion: 'test',
    meta: originalCode ? { driverAdapterError: { cause: { originalCode } } } : undefined,
  });

describe('problem filter', () => {
  it('answers an exhausted pool with 503 BUSY and Retry-After', () => {
    const sent = respond(prismaError('P2028', 'Transaction API error: Unable to start a transaction in the given time.'));
    expect(sent).toMatchObject({ status: 503, body: { code: 'BUSY' }, headers: { 'retry-after': '1' } });
  });

  it('answers a deadlock with 503 DATABASE_UNAVAILABLE and Retry-After', () => {
    const sent = respond(prismaError('P2010', 'failed', '40P01'));
    expect(sent).toMatchObject({ status: 503, body: { code: 'DATABASE_UNAVAILABLE' }, headers: { 'retry-after': '1' } });
  });

  it('answers any other error with 500 and no Retry-After', () => {
    const sent = respond(prismaError('P2010', 'failed', '23503'));
    expect(sent).toMatchObject({ status: 500, body: { code: 'INTERNAL_ERROR' } });
    expect(sent.headers['retry-after']).toBeUndefined();
  });
});
