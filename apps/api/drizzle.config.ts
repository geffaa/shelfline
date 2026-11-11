import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "postgresql", schema: "./src/db/schema.ts", out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://shelfline:shelfline@localhost:54340/shelfline" },
  schemaFilter: ["shelfline"],
});
