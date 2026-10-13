import type { Principal } from './principal.js';
import { Scope } from './scopes.js';

export function canSeeProgram(principal: Principal, clientRef: string): boolean {
  if (principal.scopes.has(Scope.ProgramsReadAll)) return true;
  return (
    principal.scopes.has(Scope.ProgramsReadOwn) &&
    principal.clientRef !== undefined &&
    principal.clientRef === clientRef
  );
}