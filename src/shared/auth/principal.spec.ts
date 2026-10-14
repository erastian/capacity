import { toPrincipal } from './principal.js';

describe('toPrincipal', () => {
  it('reads subject, client, scopes and client_ref', () => {
    expect(
      toPrincipal({
        sub: 'u1',
        azp: 'web',
        scope: 'openid programs:read:own profile',
        client_ref: 'C1',
      }),
    ).toEqual({
      subject: 'u1',
      clientId: 'web',
      scopes: new Set(['programs:read:own']),
      clientRef: 'C1',
    });
  });

  it('falls back to client_id when azp is absent', () => {
    expect(toPrincipal({ sub: 's', client_id: 'origination' })?.clientId).toBe('origination');
  });

  it('drops programs:read:own without client_ref', () => {
    expect(toPrincipal({ sub: 'u1', scope: 'programs:read:own breaks:read' })?.scopes).toEqual(new Set(['breaks:read']));
  });

  it('ignores unknown scopes', () => {
    expect(toPrincipal({ sub: 'u1', scope: 'admin *' })?.scopes.size).toBe(0);
  });

  it.each([{}, { sub: '' }, { sub: 42 }])('rejects a token without subject: %o', (claims) => {
    expect(toPrincipal(claims)).toBeUndefined();
  });
});
