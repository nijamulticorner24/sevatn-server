import { Injectable, CanActivate, ExecutionContext, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { Role } from '@prisma/client';
import { ROLES_KEY } from '../decorators';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  handleRequest(err: any, user: any, info: any) {
    if (err || !user) {
      throw err || new UnauthorizedException('Authentication token required or invalid');
    }
    return user;
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }
    const { user } = context.switchToHttp().getRequest();
    if (!user) {
      throw new UnauthorizedException('User not authenticated');
    }
    const hasRole = requiredRoles.some((role) => user.role === role || user.role === Role.SUPER_ADMIN);
    if (!hasRole) {
      throw new ForbiddenException(`User role '${user.role}' is not authorized for this resource`);
    }
    return true;
  }
}

@Injectable()
export class MachineAuthGuard implements CanActivate {
  constructor(private prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = ctxGetRequest(context);
    const authHeader = request.headers['authorization'];
    const machineTokenHeader = request.headers['x-machine-token'];

    let token = machineTokenHeader;
    if (!token && authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    }

    if (!token) {
      throw new UnauthorizedException('Worker machine token missing in x-machine-token or Authorization header');
    }

    const machine = await this.prisma.workerMachine.findUnique({
      where: { machineToken: String(token) },
    });

    if (!machine || !machine.active) {
      throw new UnauthorizedException('Invalid or inactive machine token');
    }

    request.machine = machine;
    return true;
  }
}

function ctxGetRequest(context: ExecutionContext) {
  return context.switchToHttp().getRequest();
}

export * from './service-access.guard';
