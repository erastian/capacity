import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { isPoolExhausted, isTransient } from '../db/sql-state.js';
import { AppError } from './app-error.js';
import type { Problem } from './errors.types.js';
import { problem, PROBLEM_CONTENT_TYPE } from './problem.js';

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

@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const body = this.toProblem(exception, request);

    if (body.status >= 500) {
      this.logger.error(exception);
    }

    if (exception instanceof AppError) {
      void reply.headers(exception.headers);
    }
    if (isTransient(exception)) {
      void reply.header('retry-after', '1');
    }

    void reply.status(body.status).type(PROBLEM_CONTENT_TYPE).send(body);
  }

  private toProblem(exception: unknown, request: FastifyRequest): Problem {
    const context = { instance: request.url, correlationId: String(request.id) };

    if (exception instanceof AppError) {
      return problem({
        ...context,
        status: exception.status,
        code: exception.code,
        detail: exception.detail,
        extensions: exception.extensions,
      });
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = CODE_BY_STATUS[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'HTTP_ERROR');
      return problem({
        ...context,
        status,
        code,
        detail: status < 500 ? exception.message : undefined,
      });
    }

    if (isPoolExhausted(exception)) {
      return problem({
        ...context,
        status: HttpStatus.SERVICE_UNAVAILABLE,
        code: 'BUSY',
        detail: 'Database is busy, retry later',
      });
    }

    if (isTransient(exception)) {
      return problem({
        ...context,
        status: HttpStatus.SERVICE_UNAVAILABLE,
        code: 'DATABASE_UNAVAILABLE',
        detail: 'Database is temporarily unavailable, retry later',
      });
    }

    return problem({
      ...context,
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
    });
  }
}
