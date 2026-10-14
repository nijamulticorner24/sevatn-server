import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

@Injectable()
@WebSocketGateway({
  cors: {
    origin: '*',
    credentials: true,
  },
  namespace: '/live',
})
export class EventsGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(EventsGateway.name);

  constructor(private readonly jwtService: JwtService) {}

  afterInit(server: Server) {
    this.logger.log('⚡ WebSocket Live Events Gateway Initialized on namespace /live');
  }

  async handleConnection(client: Socket) {
    try {
      const authHeader =
        client.handshake.auth?.token ||
        client.handshake.headers?.authorization ||
        (client.handshake.query?.token as string);

      let token = authHeader;
      if (token && token.startsWith('Bearer ')) {
        token = token.slice(7);
      }

      if (token) {
        try {
          const payload = this.jwtService.verify(token, {
            secret: process.env.JWT_SECRET || 'ticketassist-dev-super-secret-jwt-key-32chars',
          });

          client.data.user = payload;
          const userId = payload.sub || payload.id;
          const role = payload.role;
          const partnerId = payload.partnerId;

          // Join private rooms
          if (userId) client.join(`user_${userId}`);
          if (partnerId) client.join(`partner_${partnerId}`);
          if (role === 'SUPER_ADMIN') client.join('admin_room');
          if (role === 'PARTNER') client.join('partner_room');
          if (role === 'CENTRE') client.join('centre_room');

          this.logger.log(`🟢 WebSocket Client Connected: ${client.id} (User: ${userId}, Role: ${role})`);
          client.emit('connected', { status: 'authenticated', userId, role });
          return;
        } catch (jwtErr) {
          this.logger.debug(`Anonymous or expired token on socket ${client.id}`);
        }
      }

      // Public / Guest room (e.g. for registration progress or status trackers)
      client.join('public_room');
      this.logger.log(`🟢 WebSocket Guest Connected: ${client.id}`);
      client.emit('connected', { status: 'anonymous' });
    } catch (err: any) {
      this.logger.warn(`Connection error on socket ${client.id}: ${err.message}`);
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`🔴 WebSocket Client Disconnected: ${client.id}`);
  }

  @SubscribeMessage('ping')
  handlePing(@ConnectedSocket() client: Socket) {
    return { event: 'pong', data: { timestamp: new Date().toISOString() } };
  }

  @SubscribeMessage('join_room')
  handleJoinRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { room: string },
  ) {
    if (data?.room) {
      client.join(data.room);
      return { event: 'joined_room', data: { room: data.room } };
    }
  }

  // ==========================================
  // DISPATCH HELPER METHODS
  // ==========================================

  /**
   * Broadcast an event to a specific user
   */
  emitToUser(userId: string, event: string, data: any) {
    if (this.server) {
      this.server.to(`user_${userId}`).emit(event, data);
    }
  }

  /**
   * Broadcast an event to all users under a partner franchise
   */
  emitToPartner(partnerId: string, event: string, data: any) {
    if (this.server) {
      this.server.to(`partner_${partnerId}`).emit(event, data);
      this.server.to('partner_room').emit(event, data);
    }
  }

  /**
   * Broadcast an event to all system administrators
   */
  emitToAdmins(event: string, data: any) {
    if (this.server) {
      this.server.to('admin_room').emit(event, data);
    }
  }

  /**
   * Broadcast an event to all connected clients globally
   */
  emitToAll(event: string, data: any) {
    if (this.server) {
      this.server.emit(event, data);
    }
  }

  /**
   * Specific event: Partner Centre Activated
   */
  notifyCentreActivated(partnerId: string | undefined, payload: {
    invitationId?: string;
    token?: string;
    centreCode: string;
    centreName: string;
    district: string;
    taluk: string;
    timestamp: string;
  }) {
    if (partnerId) {
      this.emitToPartner(partnerId, 'partner:centre_activated', payload);
    }
    this.emitToAdmins('admin:centre_activated', payload);
    this.emitToAll('centre:activated', payload);
  }

  /**
   * Specific event: Booking Status Updated
   */
  notifyBookingUpdated(bookingId: string, userId: string, payload: any) {
    this.emitToUser(userId, 'booking:updated', { bookingId, ...payload });
    this.emitToAdmins('admin:booking_updated', { bookingId, userId, ...payload });
    if (this.server) {
      this.server.to(`booking_${bookingId}`).emit('booking:updated', payload);
    }
  }

  /**
   * Specific event: Worker Machine Fleet Status
   */
  notifyFleetUpdated(machineCode: string, payload: any) {
    this.emitToAdmins('fleet:updated', { machineCode, ...payload });
  }

  /**
   * Specific event: Wallet Balance Changed
   */
  notifyWalletUpdated(userId: string, payload: { availableBalance: number; reservedBalance: number }) {
    this.emitToUser(userId, 'wallet:updated', payload);
  }
}
