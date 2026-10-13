import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { startApp } from './support/app.js';

describe('health', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await startApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('is live', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
  });

  it('is ready when the database answers', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('echoes the correlation id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-correlation-id': 'test-cid-1' },
    });
    expect(res.headers['x-correlation-id']).toBe('test-cid-1');
  });

  it('answers unknown routes with a problem document', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/nope',
      headers: { 'x-correlation-id': 'test-cid-2' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      instance: '/nope',
      correlationId: 'test-cid-2',
    });
  });
});