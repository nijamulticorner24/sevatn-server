import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const exceptionResponse: any =
      exception instanceof HttpException ? exception.getResponse() : null;

    const message =
      typeof exceptionResponse === 'object' && exceptionResponse !== null
        ? exceptionResponse.message || exceptionResponse.error
        : exception instanceof Error
        ? exception.message
        : 'Internal server error';

    // Mask sensitive logs & log appropriately
    if (status === HttpStatus.NOT_FOUND) {
      this.logger.warn(
        `[${request.method}] ${request.url} >> Status: ${status} >> Error: ${JSON.stringify(message)}`,
      );
    } else {
      this.logger.error(
        `[${request.method}] ${request.url} >> Status: ${status} >> Error: ${JSON.stringify(message)}`,
      );
    }

    response.status(status).json({
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      method: request.method,
      error: message,
      success: false,
    });
  }
}
