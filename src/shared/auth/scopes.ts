export const Scope = {
  ReservationsWrite: 'reservations:write',
  ProgramsReadAll: 'programs:read:all',
  ProgramsReadOwn: 'programs:read:own',
  BreaksRead: 'breaks:read',
  AuditRead: 'audit:read',
} as const;

export type Scope = (typeof Scope)[keyof typeof Scope];

export const KNOWN_SCOPES: ReadonlySet<string> = new Set(Object.values(Scope));