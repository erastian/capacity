import type { Principal, TokenClaims } from './principal.types.js';
import { KNOWN_SCOPES, Scope } from './scopes.js';

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function toPrincipal(claims: TokenClaims): Principal | undefined {
  const subject = text(claims.sub);
  if (!subject) return undefined;

  const clientRef = text(claims.client_ref);
  const scopes = new Set(
    (text(claims.scope) ?? '')
      .split(' ')
      .filter((scope): scope is Scope => KNOWN_SCOPES.has(scope))
      .filter((scope) => scope !== Scope.ProgramsReadOwn || clientRef),
  );

  return {
    subject,
    clientId: text(claims.azp) ?? text(claims.client_id),
    scopes,
    clientRef,
  };
}