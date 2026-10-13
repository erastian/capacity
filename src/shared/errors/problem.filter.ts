import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from './app-error.js';

const CODE_BY_STATUS: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'BAD_REQUEST',
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHENTICATED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.METHOD_NOT_ALLOWED]: 'METHOD_NOT_ALLOWED',
  [HttpStatus.NOT_ACCEPTABLE]: 'NOT_ACCEPTABLE',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'PAYLOAD_TOO_LARGE',
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: 'UNSUPPORTED_MEDIA_TYPE',
  [HttpStatus.TOO_MANY_REQUESTS]: 'TOO_MANY_REQUESTS',
};

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

@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const problem = this.toProblem(exception, request);

    if (problem.status >= 500) {
      this.logger.error(exception);
    }

    if (exception instanceof AppError) {
      void reply.headers(exception.headers);
    }

    void reply
      .status(problem.status)
      .type('application/problem+json')
      .send(problem);
  }

  private toProblem(exception: unknown, request: FastifyRequest): Problem {
    const base = {
      instance: request.url,
      correlationId: String(request.id),
    };

    if (exception instanceof AppError) {
      return {
        ...exception.extensions,
        type: `urn:capacity:problem:${exception.code}`,
        title: exception.code,
        status: exception.status,
        code: exception.code,
        ...(exception.detail ? { detail: exception.detail } : {}),
        ...base,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code =
        CODE_BY_STATUS[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'HTTP_ERROR');
      return {
        type: `urn:capacity:problem:${code}`,
        title: code,
        status,
        code,
        ...(status < 500 ? { detail: exception.message } : {}),
        ...base,
      };
    }

    return {
      type: 'urn:capacity:problem:INTERNAL_ERROR',
      title: 'INTERNAL_ERROR',
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      ...base,
    };
  }
}