import { Module } from '@nestjs/common';
import { initDb } from './db/database';
import { UsersService } from './services/users.service';
import { SmsService } from './services/sms.service';
import { TicketService } from './services/ticket.service';
import { AuditService } from './services/audit.service';
import { RateLimitService } from './services/rate-limit.service';
import { FederationService } from './services/federation.service';
import { OidcService } from './oidc/oidc.service';
import { AuthController } from './controllers/auth.controller';
import { AccountController } from './controllers/account.controller';
import { AdminController } from './controllers/admin.controller';
import { MockFederationController } from './controllers/mock-federation.controller';

@Module({
  imports: [],
  controllers: [AuthController, AccountController, AdminController, MockFederationController],
  providers: [
    {
      provide: 'DATABASE_INIT',
      useFactory: () => initDb(),
    },
    UsersService,
    SmsService,
    TicketService,
    AuditService,
    RateLimitService,
    FederationService,
    OidcService,
  ],
})
export class AppModule {}
