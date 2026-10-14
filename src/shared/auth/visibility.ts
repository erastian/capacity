import type { Principal } from './principal.types.js';
import { Scope } from './scopes.js';
import type { ProgramScope } from './visibility.types.js';

export function programScope(principal: Principal): ProgramScope {
  if (principal.scopes.has(Scope.ProgramsReadAll)) return { kind: 'all' };
  if (principal.scopes.has(Scope.ProgramsReadOwn) && principal.clientRef !== undefined) {
    return { kind: 'client', clientRef: principal.clientRef };
  }
  return { kind: 'none' };
}

export function canSeeProgram(principal: Principal, clientRef: string): boolean {
  const scope = programScope(principal);
  return scope.kind === 'all' || (scope.kind === 'client' && scope.clientRef === clientRef);
}

export function clientRefFilter(scope: ProgramScope): string | null {
  if (scope.kind === 'none') throw new Error('An invisible scope has nothing to filter');
  return scope.kind === 'client' ? scope.clientRef : null;
}
