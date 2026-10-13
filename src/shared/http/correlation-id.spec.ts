import { resolveCorrelationId } from './correlation-id.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('resolveCorrelationId', () => {
  it('takes a valid X-Correlation-Id', () => {
    expect(resolveCorrelationId({ 'x-correlation-id': 'abc-123' })).toBe(
      'abc-123',
    );
  });

  it('prefers X-Correlation-Id over traceparent', () => {
    expect(
      resolveCorrelationId({
        'x-correlation-id': 'abc',
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      }),
    ).toBe('abc');
  });

  it('takes the trace id from a valid traceparent', () => {
    expect(
      resolveCorrelationId({
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      }),
    ).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
  });

  it.each([
    ['header injection', { 'x-correlation-id': 'a\nb' }],
    ['too long', { 'x-correlation-id': 'a'.repeat(129) }],
    ['zero trace id', { traceparent: `00-${'0'.repeat(32)}-00f067aa0ba902b7-01` }],
    ['malformed traceparent', { traceparent: 'garbage' }],
    ['nothing', {}],
  ])('generates a UUID for %s', (_, headers) => {
    expect(resolveCorrelationId(headers)).toMatch(UUID);
  });
});