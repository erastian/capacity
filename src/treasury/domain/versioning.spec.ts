import type { ProgramStatus } from '../../shared/domain/program.types.js';
import { decideField, isReinstatementAllowed, isStatusChangeAllowed } from './versioning.js';

const same = (a: number, b: number) => a === b;

describe('decideField', () => {
  it.each<[string, bigint | null, bigint, number, string]>([
    ['first value', null, 1n, 100, 'apply'],
    ['newer version', 5n, 6n, 100, 'apply'],
    ['newer version with a gap', 5n, 9n, 100, 'apply'],
    ['older version', 5n, 4n, 100, 'stale'],
    ['same version, same value', 5n, 5n, 50, 'stale'],
    ['same version, different value', 5n, 5n, 100, 'conflict'],
  ])('%s → %s', (_, currentVersion, incomingVersion, incomingValue, decision) => {
    expect(
      decideField({ value: 50, version: currentVersion }, { value: incomingValue, version: incomingVersion }, same),
    ).toBe(decision);
  });
});

describe('program status transitions', () => {
  it.each<[ProgramStatus, ProgramStatus, boolean]>([
    ['ACTIVE', 'SUSPENDED', true],
    ['SUSPENDED', 'ACTIVE', true],
    ['ACTIVE', 'CLOSED', true],
    ['SUSPENDED', 'CLOSED', true],
    ['ACTIVE', 'ACTIVE', true],
    ['CLOSED', 'CLOSED', true],
    ['CLOSED', 'ACTIVE', false],
    ['CLOSED', 'SUSPENDED', false],
  ])('%s → %s allowed: %s', (from, to, allowed) => {
    expect(isStatusChangeAllowed(from, to)).toBe(allowed);
  });

  it('reinstates only a closed program', () => {
    expect(isReinstatementAllowed('CLOSED')).toBe(true);
    expect(isReinstatementAllowed('ACTIVE')).toBe(false);
    expect(isReinstatementAllowed('SUSPENDED')).toBe(false);
  });
});