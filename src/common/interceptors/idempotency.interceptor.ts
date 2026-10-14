import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  ConflictException,
} from '@nestjs/common';
import { Observable, of } from 'rxjs';
import { tap } from 'rxjs/operators';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private prisma: PrismaService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
    const request = context.switchToHttp().getRequest();
    const idempotencyKey = request.headers['x-idempotency-key'] || request.body?.idempotencyKey;

    if (!idempotencyKey || request.method === 'GET') {
      return next.handle();
    }

    // Check if idempotency record exists
    const existing = await this.prisma.idempotencyRecord.findUnique({
      where: { key: String(idempotencyKey) },
    });

    if (existing) {
      if (new Date() < existing.expiresAt) {
        // Return stored cached response payload directly
        return of(existing.responsePayload);
      }
    }

    return next.handle().pipe(
      tap(async (response) => {
        try {
          const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
          await this.prisma.idempotencyRecord.upsert({
            where: { key: String(idempotencyKey) },
            update: { responsePayload: response, expiresAt },
            create: {
              key: String(idempotencyKey),
              operation: `${request.method} ${request.url}`,
              responsePayload: response,
              expiresAt,
            },
          });
        } catch (err) {
          console.error('Failed to store idempotency record:', err);
        }
      }),
    );
  }
}
