import { SetMetadata } from '@nestjs/common';

export const REQUIRE_SERVICE_KEY = 'require_service';
export const RequireService = (serviceCode: string) => SetMetadata(REQUIRE_SERVICE_KEY, serviceCode);
