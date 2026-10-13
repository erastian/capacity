import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Env } from '../../config/env.js';
import { toPrincipal } from './principal.js';
import type { Principal } from './principal.types.js';

const ALGORITHMS = ['RS256', 'PS256', 'ES256'];

@Injectable()
export class TokenVerifier {
  private readonly keys: JWTVerifyGetKey;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly clockTolerance: number;

  constructor(config: ConfigService<Env, true>) {
    this.keys = createRemoteJWKSet(
      new URL(config.get('AUTH_JWKS_URL', { infer: true })),
    );
    this.issuer = config.get('AUTH_ISSUER', { infer: true });
    this.audience = config.get('AUTH_AUDIENCE', { infer: true });
    this.clockTolerance = config.get('AUTH_CLOCK_TOLERANCE_SECONDS', {
      infer: true,
    });
  }

  async verify(token: string): Promise<Principal | undefined> {
    try {
      const { payload } = await jwtVerify(token, this.keys, {
        algorithms: ALGORITHMS,
        issuer: this.issuer,
        audience: this.audience,
        clockTolerance: this.clockTolerance,
        requiredClaims: ['sub', 'exp'],
      });
      return toPrincipal(payload);
    } catch {
      return undefined;
    }
  }
}