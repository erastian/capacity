import {
  createParamDecorator,
  type ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type { Principal } from './principal.js';
import type { Scope } from './scopes.js';

export const PUBLIC_KEY = 'auth:public';
export const SCOPES_KEY = 'auth:scopes';

export const Public = () => SetMetadata(PUBLIC_KEY, true);

export const RequireScopes = (...anyOf: [Scope, ...Scope[]]) =>
  SetMetadata(SCOPES_KEY, anyOf);

export const CurrentPrincipal = createParamDecorator(
  (_: unknown, context: ExecutionContext): Principal =>
    context.switchToHttp().getRequest<{ principal: Principal }>().principal,
);