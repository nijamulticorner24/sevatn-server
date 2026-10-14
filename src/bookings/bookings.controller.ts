import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { BookingsService } from './bookings.service';
import { JwtAuthGuard } from '../common/guards';
import { CurrentUser } from '../common/decorators';
import { CreateBookingDto, ResolveHumanActionDto } from './dto/booking.dto';
import { BookingStatus } from '@prisma/client';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';
import { ServiceAccessGuard } from '../common/guards/service-access.guard';
import { RequireService } from '../common/decorators/require-service.decorator';

@Controller('bookings')
@UseGuards(JwtAuthGuard)
@UseInterceptors(IdempotencyInterceptor)
export class BookingsController {
  constructor(private readonly bookingsService: BookingsService) {}

  @Post()
  @UseGuards(ServiceAccessGuard)
  @RequireService('TICKET_ASSIST')
  async createBooking(@CurrentUser() user: any, @Body() dto: CreateBookingDto) {
    return this.bookingsService.createBooking(user.id, dto);
  }

  @Get()
  async getBookings(
    @CurrentUser() user: any,
    @Query('status') status?: BookingStatus,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.bookingsService.getBookings(user, {
      status,
      page: page ? parseInt(page) : undefined,
      limit: limit ? parseInt(limit) : undefined,
      search,
    });
  }

  @Get('config')
  async getBookingConfig() {
    return this.bookingsService.getBookingConfig();
  }

  @Get(':id')
  async getBookingById(@Param('id') id: string, @CurrentUser() user: any) {
    return this.bookingsService.getBookingById(id, user);
  }

  @Post(':id/cancel')
  async cancelBooking(@Param('id') id: string, @CurrentUser() user: any) {
    return this.bookingsService.cancelBooking(id, user);
  }

  @Post(':id/resolve-human')
  async resolveHumanAction(
    @Param('id') id: string,
    @Body() dto: ResolveHumanActionDto,
    @CurrentUser() user: any,
  ) {
    return this.bookingsService.resolveHumanAction(id, dto, user);
  }
}
