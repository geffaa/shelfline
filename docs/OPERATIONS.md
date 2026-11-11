# Operating Shelfline: tenancy, sign-in, backups, speed, dependencies

What M24 added, how to use it, and what it does not claim. Everything here ran against the local stack (Postgres 17 in Docker, Node 22); none of it has run on a hosted deployment.

## One deployment, several organisations

Every table that belongs to an organisation carries `org_id`, and **Postgres itself refuses to show or change another organisation's rows** (row-level security, migration `0031_row_level_security`).

- The running API connects as `shelfline_app`: not a superuser, no `BYPASSRLS`, no `TRUNCATE`, cannot alter a policy or switch role. `DATABASE_URL` (the owner) is for migrations, tests and scripts; `APP_DATABASE_URL` overrides the app's connection (by default it is `DATABASE_URL` with the user swapped for `shelfline_app`).
- Each request names its organisation to the database: the auth guard writes the organisation from the verified token into a per-request cell, and the connection pool (`apps/api/src/db/db.module.ts`) stamps `app.org_id` on every connection it lends out, rewriting it each time so it can never carry over from the previous borrower. The policy is `org_id = app.org_id`. With nothing set, nothing is visible and nothing can be written (fail closed).
- **System mode.** Work that has no signed-in organisation (sign-in itself, webhooks, the public shop, schedulers) runs with `app.system = on`, which the policies allow. That is set by the application, not by anything a caller sends, but it does mean the database stops a *bug in an authenticated request*, not a bug in the unauthenticated entry points. Those are written to filter by organisation explicitly and are covered by tests.
- **What is not covered.** Child tables with no `org_id` of their own (sale lines, purchase-order lines and similar) are protected through their parents only. A future table that forgets RLS fails `isolation.test.ts`, which walks every table with an `org_id` column.
- **Tests.** `apps/api/test/isolation.test.ts`: every org-owned table checked in both directions with data in two organisations (zero leaks), fail-closed with no organisation set, cross-organisation insert/update/delete refused even knowing ids, and the application role unable to change the rules. The whole API suite and all four browser suites also run as `shelfline_app`.

Add an organisation to a running deployment: `ORG_NAME="Other Org Pty" ORG_SLUG=other-org OWNER_EMAIL=boss@other.test OWNER_PASSWORD=… pnpm --filter @shelfline/api seed`. The same email may exist in several organisations; sign-in checks the password against each and, if more than one accepts it, asks which organisation (`choose_org`), or the request can carry `org` (the slug). Nothing is revealed before the password is right. The online shop picks its organisation with `/shop-default?slug=…` when there are several.

Not done: the report portal's email-code sign-in still assumes one organisation per email; there is no in-app screen for creating organisations (command line only); no per-organisation limits or billing.

## Single sign-on (OpenID Connect)

Settings → Admin → Single sign-on (owners). Register an application at your provider with the redirect address the page shows, then enter the issuer, client id and secret and, optionally, the allowed email domains. The secret is stored encrypted and never shown again.

Authorisation-code flow with PKCE, a signed ten-minute `state`, the ID token's signature checked against the provider's published keys with issuer, audience, expiry and a per-login nonce, and a one-time sixty-second ticket (not a token) carried back to the browser. People are matched by email to users who **already exist** and are active; signing in never creates anyone. An unverified email is refused. Passwords keep working beside it.

Tested against a stand-in provider written for the tests (`apps/api/test-support/fake-idp.ts`): 12 API tests including forged, expired and replayed tokens, a wrong audience, issuer or key, a tampered state and a replayed ticket, and one browser test. **Not tried against a real provider** (Okta, Entra, Google, Keycloak): discovery quirks, clock skew and claim names are assumptions (TECH-SPEC V22). No SAML, no SCIM, no "require SSO" switch (passwords cannot yet be disabled), no group-to-role mapping.

## A second attendance terminal

The bridge now takes ISAPI-style JSON pushes (`/hik/events`, bare or multipart `event_log`) next to ZKTeco-style ADMS. The simulator speaks both: `termsim -dialect isapi`. Built from public integration notes, **unverified on a real terminal** (V09b in [HARDWARE-TESTS.md](HARDWARE-TESTS.md)).

## Backups

`pnpm backup:check` (or `DATABASE_URL=… pnpm --filter @shelfline/api backup:check`) dumps the database, restores the dump into a fresh one beside it, and proves the copy is the same: every table's row count and a hash of every row, every sequence value, which tables have row-level security, and which triggers exist (so the append-only ledgers are still append-only). It exits non-zero on any difference and drops the copy. `apps/api/test/backup.test.ts` runs it on a database with real sales. On the demo-sized test database: 98 tables, 456 KB, under a second.

A per-database dump does not contain roles. On a new server create `shelfline_app` first (migration `0031` does, with a development password you must change: `alter role shelfline_app password '…'`). Not done: scheduled dumps, off-site copies, point-in-time recovery (WAL archiving), a restore drill on another machine.

## Speed

`apps/api/test/perf.test.ts` loads a store with 3,000 sales (set `PERF_SALES` for more) through the real sync endpoint and holds each request to a 95th-percentile ceiling. Measured here, then budgeted at 3-10x:

| Request | 3,000 sales | 10,000 sales | Budget |
|---|---|---|---|
| Till pushes 25 sales at once | 189 ms | 189 ms | 600 ms |
| Catalogue search | 3 ms | 3 ms | 40 ms |
| Orders list (50) | 6 ms | 14 ms | 60 ms |
| Today overview | 13 ms | 29 ms | 100 ms |
| Sales report, all time | 7 ms | 15 ms | 80 ms |
| Till catches up (200 changes) | 12 ms | 13 ms | 60 ms |
| Reorder suggestions, whole network | 35 ms | 21 ms | 120 ms |
| One day's journal | 16 ms | 22 ms | 120 ms |

A laptop, Postgres in a container, one store and one process: this says the queries are indexed and there are no per-row loops, not how it behaves under load from many stores. No load test with concurrent tills beyond the soak test (10 tills), no browser performance budget (bundle size, first paint).

## Dependencies

`pnpm audit:supply` (`tools/supply-chain.mjs`) fails on: any known vulnerability in production dependencies; any high or critical one anywhere; a copyleft licence without a permissive alternative; a dependency that is not a registry version range (git, URL, `latest`); a third-party Go module in the bridge. It prints what it tolerates. Today: 188 production packages, none vulnerable; four low/moderate advisories in build tools only (an old `esbuild` inside `drizzle-kit`, `glob`/`minimatch`/`deepmerge` inside `workbox-build`), none of which runs in production; `jszip` is dual-licensed MIT or GPL and used as MIT; the Go bridge uses only the standard library. Not done: signed builds, an SBOM, automated update PRs, a pinned container image digest.
