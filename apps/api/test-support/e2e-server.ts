/**
 * Starts the API on a throw-away database for browser end-to-end tests (apps/pos/e2e).
 * Drops and recreates `shelfline_e2e`, migrates it, seeds the organisation and an owner, then listens on E2E_PORT (default 8201).
 */
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.setup";
import { loadConfig } from "../src/config";
import { runMigrations } from "../src/db/migrate";
import * as schema from "../src/db/schema";
import { seedOrg } from "../src/seed";

const admin = process.env.E2E_ADMIN_URL ?? "postgres://shelfline:shelfline@localhost:54340/postgres";
const url = process.env.E2E_DATABASE_URL ?? "postgres://shelfline:shelfline@localhost:54340/shelfline_e2e";
const a = new pg.Client({ connectionString: admin }); await a.connect();
await a.query("drop database if exists shelfline_e2e with (force)"); await a.query("create database shelfline_e2e"); await a.end();
await runMigrations(url);
const pool = new pg.Pool({ connectionString: url, max: 2 });
await seedOrg(drizzle(pool, { schema }), { orgName: "Kestrel Run Co.", currency: "AUD", timezone: "Australia/Melbourne", ownerEmail: "owner@e2e.test", ownerPassword: "e2e-owner-password-123" });
await pool.end();

const config = loadConfig({ ...process.env, DATABASE_URL: url, JWT_SECRET: "e2e-secret-e2e-secret-e2e-secret-123456", DEV_MAILBOX: "1", SHOPIFY_API_BASE: "http://127.0.0.1:19481", ENCRYPTION_KEY: "22".repeat(32), PORT: process.env.E2E_PORT ?? "8201", PUBLIC_API_URL: `http://localhost:${process.env.E2E_PORT ?? "8201"}`, ADMIN_URL: process.env.E2E_ADMIN_URL ?? "http://localhost:8220" });
const app = await NestFactory.create(AppModule.register(config), { logger: ["error", "warn"] });
configureApp(app, { CORS_ORIGINS: "http://localhost:8210,http://127.0.0.1:8210,http://localhost:8220,http://127.0.0.1:8220,http://localhost:8230,http://127.0.0.1:8230,http://localhost:8250,http://127.0.0.1:8250" });
await app.listen(config.port, "127.0.0.1");
console.log(`e2e api ready on :${config.port}`);
