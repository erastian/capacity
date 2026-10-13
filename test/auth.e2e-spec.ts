import { Controller, Get, Module } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module.js';
import { CurrentPrincipal, RequireScopes } from '../src/shared/auth/decorators.js';
import type { Principal } from '../src/shared/auth/principal.types.js';
import { Scope } from '../src/shared/auth/scopes.js';
import { startApp } from './support/app.js';
import { hmacToken, token, unsignedToken } from './support/issuer.js';

@Controller('probe')
class ProbeController {
  @Get('write')
  @RequireScopes(Scope.ReservationsWrite)
  write(@CurrentPrincipal() principal: Principal) {
    return { ...principal, scopes: [...principal.scopes] };
  }

  @Get('read')
  @RequireScopes(Scope.ProgramsReadAll, Scope.ProgramsReadOwn)
  read(@CurrentPrincipal() principal: Principal) {
    return { clientRef: principal.clientRef ?? null };
  }

  @Get('undeclared')
  undeclared() {
    return { reached: true };
  }
}

@Module({ imports: [AppModule], controllers: [ProbeController] })
class ProbeModule {}

describe('authentication', () => {
  let app: NestFastifyApplication;

  const get = (url: string, bearer?: string) =>
    app.inject({
      method: 'GET',
      url,
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    });

  beforeAll(async () => {
    app = await startApp(ProbeModule);
  });

  afterAll(async () => {
    await app.close();
  });

  it('lets a valid token with the scope through and exposes the principal', async () => {
    const res = await get(
      '/probe/write',
      await token({ claims: { sub: 'svc-origination', azp: 'origination', scope: 'reservations:write' } }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      subject: 'svc-origination',
      clientId: 'origination',
      scopes: ['reservations:write'],
    });
  });

  it('keeps health public', async () => {
    expect((await get('/health/live')).statusCode).toBe(200);
  });

  describe('rejects with 401', () => {
    it.each<[string, () => Promise<string | undefined>]>([
      ['no token', async () => undefined],
      ['garbage', async () => 'not-a-jwt'],
      ['foreign issuer', () => token({ issuer: 'https://evil.test', claims: { scope: 'reservations:write' } })],
      ['foreign audience', () => token({ audience: 'other-api', claims: { scope: 'reservations:write' } })],
      ['expired beyond tolerance', () => token({ expiresIn: Math.floor(Date.now() / 1000) - 120, claims: { scope: 'reservations:write' } })],
      ['signed with an unknown key', () => token({ foreignKey: true, claims: { scope: 'reservations:write' } })],
      ['alg none', async () => unsignedToken({ scope: 'reservations:write' })],
      ['HS256', () => hmacToken('shared-secret')],
      ['no subject', () => token({ claims: { sub: '', scope: 'reservations:write' } })],
    ])('%s', async (_, make) => {
      const res = await get('/probe/write', await make());
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Bearer error="invalid_token"');
      expect(res.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
    });
  });

  describe('rejects with 403', () => {
    it('without the required scope', async () => {
      const res = await get('/probe/write', await token({ claims: { scope: 'programs:read:all' } }));
      expect(res.statusCode).toBe(403);
      expect(res.headers['www-authenticate']).toBe(
        'Bearer error="insufficient_scope", scope="reservations:write"',
      );
      expect(res.json()).toMatchObject({ code: 'FORBIDDEN' });
    });

    it('programs:read:own without client_ref', async () => {
      const res = await get('/probe/read', await token({ claims: { scope: 'programs:read:own' } }));
      expect(res.statusCode).toBe(403);
    });

    it('an endpoint without declared scopes', async () => {
      const res = await get(
        '/probe/undeclared',
        await token({ claims: { scope: 'reservations:write programs:read:all breaks:read audit:read' } }),
      );
      expect(res.statusCode).toBe(403);
    });
  });

  describe('either read scope is enough', () => {
    it('programs:read:all', async () => {
      const res = await get('/probe/read', await token({ claims: { scope: 'programs:read:all' } }));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ clientRef: null });
    });

    it('programs:read:own with client_ref', async () => {
      const res = await get(
        '/probe/read',
        await token({ claims: { scope: 'programs:read:own', client_ref: 'C1' } }),
      );
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ clientRef: 'C1' });
    });
  });
});