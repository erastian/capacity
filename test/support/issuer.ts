import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from 'jose';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export const ISSUER = 'https://idp.test/realms/capacity';
export const AUDIENCE = 'capacity-api';

const KID = 'test-key';
const signing = await generateKeyPair('RS256');
const foreign = await generateKeyPair('RS256');

const jwks = { keys: [{ ...(await exportJWK(signing.publicKey)), kid: KID, alg: 'RS256', use: 'sig' }] };

const server = createServer((_, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(jwks));
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
server.unref();

export const JWKS_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/certs`;

export interface TokenOptions {
  claims?: JWTPayload & Record<string, unknown>;
  issuer?: string;
  audience?: string;
  expiresIn?: string | number;
  foreignKey?: boolean;
}

export async function token(options: TokenOptions = {}): Promise<string> {
  const { claims = {}, issuer = ISSUER, audience = AUDIENCE, expiresIn = '5m' } = options;
  return new SignJWT({ sub: 'subject-1', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(options.foreignKey ? foreign.privateKey : signing.privateKey);
}

function base64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function unsignedToken(claims: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  return [
    base64url({ alg: 'none', typ: 'JWT' }),
    base64url({ sub: 'subject-1', iss: ISSUER, aud: AUDIENCE, exp: now + 300, ...claims }),
    '',
  ].join('.');
}

export async function hmacToken(secret: string): Promise<string> {
  return new SignJWT({ sub: 'subject-1' })
    .setProtectedHeader({ alg: 'HS256', kid: KID })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(secret));
}