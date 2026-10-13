import type { Problem, ProblemInput } from './errors.types.js';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export function problem(input: ProblemInput): Problem {
  return {
    ...input.extensions,
    type: `urn:capacity:problem:${input.code}`,
    title: input.code,
    status: input.status,
    code: input.code,
    ...(input.detail ? { detail: input.detail } : {}),
    instance: input.instance,
    correlationId: input.correlationId,
  };
}