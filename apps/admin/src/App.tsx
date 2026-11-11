import { Suspense } from "react";
import { Shell, useVisibleDomains } from "./Shell";
import { SignIn, SsoComplete } from "./pages/SignIn";
import { SsoSettings } from "./pages/SsoSettings";
import { useRoute } from "./router";
import { LensProvider } from "./state/lens";
import { useAuth } from "./state/auth";
import { Empty, Skeleton } from "./ui";

import { Today } from "./pages/Today";
import { Sessions } from "./pages/Sessions";
import { Alerts } from "./pages/Alerts";
import { Orders } from "./pages/Orders";
import { Customers } from "./pages/Customers";
import { Products } from "./pages/Products";
import { Inventory } from "./pages/Inventory";
import { Staff } from "./pages/Staff";
import { Reports } from "./pages/Reports";
import { Locations } from "./pages/Locations";
import { Audit } from "./pages/Audit";
import { Bills } from "./pages/Bills";
import { PurchaseOrders } from "./pages/PurchaseOrders";
import { Suppliers } from "./pages/Suppliers";
import { GiftCards } from "./pages/GiftCards";
import { Pricing } from "./pages/Pricing";
import { Schedule } from "./pages/Schedule";
import { Terminals } from "./pages/Terminals";
import { Commission } from "./pages/Commission";
import { CommissionRules } from "./pages/CommissionRules";
import { ReportAccess } from "./pages/ReportAccess";
import { Inbox } from "./pages/Inbox";
import { Notifications } from "./pages/Notifications";
import { EodSchedules } from "./pages/EodSchedules";
import { Devices } from "./pages/Devices";
import { OnlineOrders } from "./pages/OnlineOrders";
import { Channels } from "./pages/Channels";
import { Campaigns, Flows, Loyalty, Segments } from "./pages/Grow";
import { Timesheets } from "./pages/Timesheets";
import { StockCounts } from "./pages/StockCounts";
import { Accounting } from "./pages/Accounting";
import { Reorder } from "./pages/Reorder";
import { Transfers } from "./pages/Transfers";

const REGISTRY: Record<string, () => React.JSX.Element> = {
  "today/overview": Today, "today/sessions": Sessions, "today/alerts": Alerts, "sell/orders": Orders, "sell/customers": Customers, "sell/gift-cards": GiftCards, "stock/products": Products, "stock/inventory": Inventory,
  "people/staff": Staff, "people/schedule": Schedule, "people/timesheets": Timesheets, "people/terminals": Terminals, "money/reports": Reports, "today/inbox": Inbox, "admin/sso": SsoSettings, "money/accounting": Accounting, "stock/reorder": Reorder, "admin/notifications": Notifications, "admin/end-of-day": EodSchedules, "admin/devices": Devices, "sell/online": OnlineOrders, "sell/channels": Channels, "grow/campaigns": Campaigns, "grow/groups": Segments, "grow/automatic": Flows, "grow/loyalty": Loyalty, "money/report-access": ReportAccess, "money/commission": Commission, "money/commission-rules": CommissionRules, "money/bills": Bills, "money/suppliers": Suppliers, "stock/purchase-orders": PurchaseOrders, "stock/transfers": Transfers, "stock/counts": StockCounts, "stock/pricing": Pricing, "admin/locations": Locations, "admin/audit": Audit,
};

function Routed() {
  const r = useRoute(); const domains = useVisibleDomains();
  const allowed = domains.find((d) => d.key === r.domain)?.pages.some((p) => p.key === r.page);
  const Page = REGISTRY[`${r.domain}/${r.page}`];
  if (!Page || !allowed) return <Empty title="Nothing here" action={<a className="btn" href="#/today/overview">Go to Today</a>}>This page does not exist, or your role does not include it.</Empty>;
  return <Suspense fallback={<Skeleton />}><Page key={`${r.domain}/${r.page}`} /></Suspense>;
}

export function App() {
  const { me, ready } = useAuth();
  if (!ready) return <main className="screen-center"><Skeleton rows={3} /></main>;
  if (!me) return window.location.hash.startsWith("#/sso") ? <SsoComplete /> : <SignIn />;
  return <LensProvider><Shell><Routed /></Shell></LensProvider>;
}
