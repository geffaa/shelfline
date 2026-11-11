export const PERMISSIONS = [
  "location:read", "location:write", "register:write",
  "user:read", "user:manage", "role:read",
  "device:manage", "audit:read",
  "catalog:read", "catalog:write",
  "inventory:read", "inventory:write", "cost:read",
  "sale:approve_discount", "cash:read", "cash:approve", "sale:read", "customer:read", "customer:write", "report:read",
  "purchase:read", "purchase:write", "bill:read", "bill:write", "bill:approve", "pricing:read", "pricing:write", "giftcard:read", "giftcard:write", "roster:read", "roster:write", "timesheet:read", "timesheet:approve", "commission:read", "commission:write", "commission:lock", "report:grant", "notification:manage", "eod:manage", "channel:manage", "marketing:manage", "accounting:manage", "sso:manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const SYSTEM_ROLES: Record<string, { name: string; permissions: Permission[] }> = {
  owner: { name: "Owner", permissions: [...PERMISSIONS] },
  hq_manager: { name: "HQ manager", permissions: ["notification:manage", "eod:manage", "channel:manage", "marketing:manage", "roster:read", "roster:write", "timesheet:read", "timesheet:approve", "giftcard:read", "giftcard:write", "pricing:read", "pricing:write", "purchase:read", "purchase:write", "bill:read", "location:read", "user:read", "role:read", "catalog:read", "catalog:write", "inventory:read", "inventory:write", "cost:read", "sale:approve_discount", "cash:read", "cash:approve", "sale:read", "customer:read", "customer:write", "report:read"] },
  store_manager: { name: "Store manager", permissions: ["roster:read", "roster:write", "timesheet:read", "timesheet:approve", "giftcard:read", "giftcard:write", "location:read", "user:read", "catalog:read", "inventory:read", "inventory:write", "sale:approve_discount", "cash:read", "cash:approve", "sale:read", "customer:read", "customer:write", "report:read"] },
  purchaser: { name: "Purchaser", permissions: ["pricing:read", "purchase:read", "purchase:write", "bill:read", "location:read", "catalog:read", "inventory:read", "inventory:write", "cost:read"] },
  finance: { name: "Finance", permissions: ["accounting:manage", "eod:manage", "commission:read", "commission:write", "timesheet:read", "giftcard:read", "pricing:read", "bill:read", "bill:write", "bill:approve", "purchase:read", "location:read", "catalog:read", "inventory:read", "cost:read", "cash:read", "sale:read", "customer:read", "report:read"] },
  roster: { name: "Roster / HR", permissions: ["roster:read", "roster:write", "timesheet:read", "timesheet:approve", "location:read", "user:read"] },
  cashier: { name: "Cashier", permissions: ["location:read", "catalog:read", "inventory:read"] },
};
