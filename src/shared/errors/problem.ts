export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  instance: string;
  correlationId: string;
  [extension: string]: unknown;
}

export interface ProblemInput {
  status: number;
  code: string;
  detail?: string;
  extensions?: Record<string, unknown>;
  instance: string;
  correlationId: string;
}

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