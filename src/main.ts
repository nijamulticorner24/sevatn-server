import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe, Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { getValidatedJwtSecret } from './common/security/jwt-config';
import { json, urlencoded } from 'express';

async function bootstrap() {
  const logger = new Logger('SevaTN-API');

  // 1. Fail closed on startup if JWT_SECRET is missing, too short, or an insecure placeholder
  try {
    getValidatedJwtSecret();
    logger.log('🔐 Cryptographic JWT Secret validated (HMAC-SHA256 policy compliant)');
  } catch (err: any) {
    logger.error(`Startup Validation Failed: ${err.message}`);
    process.exit(1);
  }

  const app = await NestFactory.create(AppModule);

  // 2. Dynamic Payload Body Limit:
  // Standard routes: 1MB maximum to defend against Event Loop exhaustion & buffer DoS
  // Designated media upload routes (receipts, screenshots, QR codes): 25MB maximum
  app.use((req: any, res: any, next: any) => {
    const isUploadRoute =
      req.path.startsWith('/wallet/topup') ||
      req.path.startsWith('/admin') ||
      req.path.startsWith('/partner/payouts') ||
      req.path.startsWith('/workers');
    const limit = isUploadRoute ? '25mb' : '1mb';

    json({ limit })(req, res, (err: any) => {
      if (err) return next(err);
      urlencoded({ extended: true, limit })(req, res, next);
    });
  });

  // 3. Global Exception Filter with sanitized logging
  app.useGlobalFilters(new AllExceptionsFilter());

  // 4. Global Validation Pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );

  // 5. Environment-Driven CORS Configuration
  const rawOrigins =
    process.env.CORS_ORIGIN ||
    process.env.ALLOWED_ORIGINS ||
    process.env.FRONTEND_URL ||
    'http://localhost:3000,http://127.0.0.1:3000';

  const allowedOrigins = rawOrigins
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  logger.log(`🔒 Initialized CORS allowlist: ${allowedOrigins.join(', ')}`);

  app.enableCors({
    origin: (requestOrigin, callback) => {
      // Allow non-browser requests (e.g. mobile apps, local Playwright workers, server-to-server) without origin
      if (!requestOrigin) {
        return callback(null, true);
      }

      const normalizedOrigin = requestOrigin.replace(/\/+$/, '');

      // Check explicit allowlist
      if (allowedOrigins.includes(normalizedOrigin)) {
        return callback(null, true);
      }

      // Allow local development and tunneling services (devtunnels, ngrok, loca.lt) in non-production
      if (
        process.env.NODE_ENV !== 'production' &&
        (normalizedOrigin.startsWith('http://localhost:') ||
          normalizedOrigin.startsWith('http://127.0.0.1:') ||
          normalizedOrigin.includes('devtunnels.ms') ||
          normalizedOrigin.includes('ngrok') ||
          normalizedOrigin.includes('loca.lt'))
      ) {
        return callback(null, true);
      }

      logger.warn(`[CORS_BLOCKED] Request origin '${requestOrigin}' rejected by SevaTN CORS policy`);
      callback(new Error(`CORS Error: Origin '${requestOrigin}' is not permitted by SevaTN CORS policy.`));
    },
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });

  // 6. Swagger Documentation (available in dev/staging or when explicitly enabled)
  if (process.env.NODE_ENV !== 'production' || process.env.SWAGGER_ENABLED === 'true') {
    const config = new DocumentBuilder()
      .setTitle('SevaTN & TicketAssist Backend API')
      .setDescription('Production-Ready Centre Management, Assisted Booking & Citizen e-Governance Platform API')
      .setVersion('1.0.0')
      .addBearerAuth()
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);
  }

  const port = process.env.PORT || 4000;
  await app.listen(port);
  logger.log(`🚀 SevaTN API server running at: http://localhost:${port}`);
  logger.log(`📚 Documentation available at: http://localhost:${port}/api/docs`);
}

bootstrap();
