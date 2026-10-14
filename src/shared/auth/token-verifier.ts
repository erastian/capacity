import { BeforeApplicationShutdown, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, errors, jwtVerify } from 'jose';
import type { Env } from '../../config/env.js';
import { Periodic } from '../time/periodic.js';
import { toPrincipal } from './principal.js';
import type { Principal } from './principal.types.js';

const ALGORITHMS = ['RS256', 'PS256', 'ES256'];
const KEYS_REFRESH_MS = 10 * 60 * 1000;

@Injectable()
export class TokenVerifier implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(TokenVerifier.name);
  private readonly keys: ReturnType<typeof createRemoteJWKSet>;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly clockTolerance: number;
  private readonly refresh = new Periodic(
    () => this.keys.reload(),
    (error) => this.logger.warn(`Signing keys not refreshed, the cached set stays in use: ${(error as Error).message}`),
  );

  constructor(config: ConfigService<Env, true>) {
    this.keys = createRemoteJWKSet(new URL(config.get('AUTH_JWKS_URL', { infer: true })), {
      cacheMaxAge: Infinity,
    });
    this.issuer = config.get('AUTH_ISSUER', { infer: true });
    this.audience = config.get('AUTH_AUDIENCE', { infer: true });
    this.clockTolerance = config.get('AUTH_CLOCK_TOLERANCE_SECONDS', {
      infer: true,
    });
  }

  onApplicationBootstrap(): void {
    void this.keys.reload().catch((error: Error) => this.logger.warn(`Signing keys not loaded at start, retried on demand: ${error.message}`));
    this.refresh.start(KEYS_REFRESH_MS);
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.refresh.stop();
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
    } catch (error) {
      if (error instanceof errors.JWKSTimeout || !(error instanceof errors.JOSEError)) {
        this.logger.warn(`Signing keys unavailable: ${(error as Error).message}`);
      }
      return undefined;
    }
  }
}
