import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../errors/app-error.js';
import { PUBLIC_KEY, SCOPES_KEY } from './decorators.js';
import type { Principal } from './principal.types.js';
import type { Scope } from './scopes.js';
import { TokenVerifier } from './token-verifier.js';

const BEARER = /^Bearer +([A-Za-z0-9._~+/-]+=*)$/i;

function unauthenticated(): AppError {
  return new AppError(HttpStatus.UNAUTHORIZED, 'UNAUTHENTICATED', {
    headers: { 'www-authenticate': 'Bearer error="invalid_token"' },
  });
}

function forbidden(scopes: readonly Scope[]): AppError {
  return new AppError(HttpStatus.FORBIDDEN, 'FORBIDDEN', {
    headers: {
      'www-authenticate': `Bearer error="insufficient_scope", scope="${scopes.join(' ')}"`,
    },
  });
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: TokenVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<FastifyRequest & { principal?: Principal }>();

    const token = BEARER.exec(request.headers.authorization ?? '')?.[1];
    const principal = token ? await this.verifier.verify(token) : undefined;
    if (!principal) throw unauthenticated();

    const required =
      this.reflector.getAllAndOverride<Scope[]>(SCOPES_KEY, targets) ?? [];
    if (!required.some((scope) => principal.scopes.has(scope))) {
      throw forbidden(required);
    }

    request.principal = principal;
    return true;
  }
}