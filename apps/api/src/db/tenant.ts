import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";

/**
 * Which organisation the current request acts for. One mutable cell per request: the middleware opens it, the auth guard fills it in once
 * the token has been checked, and the pool reads it every time it hands out a connection (see db.module.ts), so Postgres row-level
 * security sees the same organisation the application does. Outside a request (schedulers, listeners) there is no cell and work runs in system mode.
 */
export interface Tenant { orgId?: string }
export const tenantStore = new AsyncLocalStorage<Tenant>();
export const currentTenant = () => tenantStore.getStore();
export function tenantMiddleware(_req: Request, _res: Response, next: NextFunction) { tenantStore.run({}, next); }
/** Run a function as one organisation, outside a request (used by tests and by scripts). */
export const asOrg = <T>(orgId: string, fn: () => T): T => tenantStore.run({ orgId }, fn);
