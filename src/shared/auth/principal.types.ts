import type { Scope } from './scopes.js';

export interface Principal {
  subject: string;
  clientId?: string;
  scopes: ReadonlySet<Scope>;
  clientRef?: string;
}

export interface TokenClaims {
  sub?: unknown;
  azp?: unknown;
  client_id?: unknown;
  scope?: unknown;
  client_ref?: unknown;
}