import { businessDate, isTimeZone } from './clock.js';

describe('businessDate', () => {
  it('uses the business time zone, not UTC', () => {
    const lateUtc = new Date('2026-06-30T23:30:00Z');
    expect(businessDate(lateUtc, 'UTC')).toBe('2026-06-30');
    expect(businessDate(lateUtc, 'Europe/London')).toBe('2026-07-01');
  });

  it('handles winter time in London', () => {
    expect(businessDate(new Date('2026-12-31T23:30:00Z'), 'Europe/London')).toBe(
      '2026-12-31',
    );
  });

  it('validates time zones', () => {
    expect(isTimeZone('Europe/London')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
  });
});