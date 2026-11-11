import { Module, type DynamicModule } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuditService } from "./audit/audit.service";
import { AuthController } from "./auth/auth.controller";
import { SsoController } from "./sso/sso.controller";
import { SsoService } from "./sso/sso.service";
import { AuthService } from "./auth/auth.service";
import { AuthzService } from "./auth/authz.service";
import { AuthGuard } from "./auth/guard";
import { TokenService } from "./auth/tokens";
import { CatalogController } from "./catalog/catalog.controller";
import { CatalogService } from "./catalog/catalog.service";
import { InventoryController } from "./inventory/inventory.controller";
import { InventoryService } from "./inventory/inventory.service";
import { LedgerService } from "./inventory/ledger.service";
import { BillsService } from "./purchasing/bills.service";
import { PurchasingController } from "./purchasing/purchasing.controller";
import { PurchasingService } from "./purchasing/purchasing.service";
import { CountsService } from "./stockops/counts.service";
import { StockOpsController } from "./stockops/stockops.controller";
import { TransfersService } from "./stockops/transfers.service";
import { PricingController } from "./pricing/pricing.controller";
import { PricingService } from "./pricing/pricing.service";
import { GiftController } from "./gift/gift.controller";
import { GiftService } from "./gift/gift.service";
import { WorkforceController } from "./workforce/workforce.controller";
import { WorkforceService } from "./workforce/workforce.service";
import { TerminalsController } from "./terminals/terminals.controller";
import { TerminalsService } from "./terminals/terminals.service";
import { CommissionController } from "./commission/commission.controller";
import { CommissionService } from "./commission/commission.service";
import { AccessController, DevController, PortalController } from "./access/access.controller";
import { GrantsService } from "./access/grants.service";
import { MailService } from "./access/mail.service";
import { PortalService } from "./access/portal.service";
import { ReportRunner } from "./access/runner.service";
import { NotificationsController } from "./notifications/notifications.controller";
import { NotificationsService } from "./notifications/notifications.service";
import { EodController } from "./eod/eod.controller";
import { EodService } from "./eod/eod.service";
import { PrintingController } from "./printing/printing.controller";
import { PrintingService } from "./printing/printing.service";
import { CardsController } from "./payments/cards.controller";
import { CardsService } from "./payments/cards.service";
import { OnlineController } from "./online/online.controller";
import { OnlineService } from "./online/online.service";
import { ChannelsController } from "./channels/channels.controller";
import { ChannelsService } from "./channels/channels.service";
import { LoyaltyService } from "./marketing/loyalty.service";
import { MarketingController } from "./marketing/marketing.controller";
import { MarketingService } from "./marketing/marketing.service";
import { AccountingController } from "./accounting/accounting.controller";
import { AccountingService } from "./accounting/accounting.service";
import { ReplenishmentController } from "./replenishment/replenishment.controller";
import { ReplenishmentService } from "./replenishment/replenishment.service";
import { CommandRegistry } from "./sync/commands";
import { CustomersService } from "./reporting/customers.service";
import { EventsService } from "./reporting/events.service";
import { ExceptionsService } from "./reporting/exceptions.service";
import { OrdersService } from "./reporting/orders.service";
import { OverviewService } from "./reporting/overview.service";
import { ReportingController } from "./reporting/reporting.controller";
import { ReportsService } from "./reporting/reports.service";
import { SessionsController } from "./cash/sessions.controller";
import { SessionsService } from "./cash/sessions.service";
import { CashCommands } from "./sync/cash.commands";
import { SellingCommands } from "./sync/selling.commands";
import { SyncController } from "./sync/sync.controller";
import { SyncService } from "./sync/sync.service";
import { CONFIG, type Config } from "./config";
import { DbModule } from "./db/db.module";
import { OrgController } from "./org/org.controller";
import { OrgService } from "./org/org.service";
import { UserController } from "./org/user.controller";
import { UserService } from "./org/user.service";

@Module({})
export class AppModule {
  static register(config: Config): DynamicModule {
    return {
      module: AppModule, imports: [DbModule], global: true,
      controllers: [AuthController, SsoController, OrgController, UserController, CatalogController, InventoryController, SyncController, SessionsController, ReportingController, PurchasingController, StockOpsController, PricingController, GiftController, WorkforceController, TerminalsController, CommissionController, AccessController, PortalController, DevController, NotificationsController, EodController, PrintingController, CardsController, OnlineController, ChannelsController, MarketingController, AccountingController, ReplenishmentController],
      providers: [{ provide: CONFIG, useValue: config }, SsoService, TokenService, AuditService, AuthzService, AuthService, OrgService, UserService, CatalogService, LedgerService, InventoryService, BillsService, PurchasingService, TransfersService, CountsService, PricingService, GiftService, WorkforceService, TerminalsService, CommissionService, MailService, ReportRunner, GrantsService, PortalService, NotificationsService, EodService, PrintingService, CardsService, OnlineService, ChannelsService, LoyaltyService, MarketingService, AccountingService, ReplenishmentService, CommandRegistry, SellingCommands, CashCommands, SyncService, SessionsService, OverviewService, OrdersService, CustomersService, ReportsService, ExceptionsService, EventsService, { provide: APP_GUARD, useClass: AuthGuard }],
      exports: [CONFIG, LedgerService, CommandRegistry],
    };
  }
}
