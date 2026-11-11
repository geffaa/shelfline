# Shelfline: a multi-location retail platform, built to be checked

**What it is.** A point-of-sale and back-office platform for a retailer with several stores and a distribution centre, written as a portfolio project with a synthetic organisation (Kestrel Run Co., running shoes, Australia). An offline-first iPad till, a back office, a limited report portal for outsiders, an online store, a Shopify channel, and a small Go program that sits on the store network next to the attendance terminals and receipt printers.

**The brief I gave myself.** Stores lose their connection and keep trading, so the till must sell, take cash, refund and print without a server. Money, stock and cash must reconcile to the cent after any amount of outage, retry and duplicate delivery. And a head office with many stores needs permissions, purchasing, people, reporting and an accounting export that an accountant would accept.

## Decisions that shaped it

**One ledger per concern, append-only.** Stock is a table of movements that a trigger refuses to update or delete; balances are a projection that a check endpoint proves equals the sum. Cash, gift cards, store credit and loyalty points work the same way. "What is the balance?" is always a sum, so there is no balance to drift.

**The till is a replica, not a screen.** It sells from local prices, taxes and stock and queues commands with gapless per-device sequence numbers. The server never rejects a physical fact (a sale that happened): it accepts it and flags it for a person: negative stock, a price that changed, a late sale, an unapproved discount, a skewed clock. Only invalid input is refused.

**Sync that cannot skip.** A plain sequence cursor can miss rows that commit out of order; the pull cursor is bounded by the oldest in-flight transaction. A soak test runs ten tills and about five thousand commands through a network that loses requests, loses answers and duplicates calls, then wipes the tables and replays the same commands in a different order to prove the ledger comes out identical.

**Pure functions for the money.** Tax, price books, promotions, commission, journals and reorder suggestions are pure modules with property tests. Pricing runs identically on the till and the server and is checked against golden vectors from an independent Python implementation.

**Postgres is the only moving part.** No queue server, no cache: LISTEN/NOTIFY for live updates, an outbox for background work, advisory locks where two people must not do the same thing at once. Fewer parts to run and to explain.

**Hardening is checked, not asserted (M24).** Row-level security makes the database itself refuse to show one organisation another's rows, and a test walks every table in both directions with data in two organisations. A backup is only a backup once it has been restored: `pnpm backup:check` restores into a fresh database and compares a hash of every row. Performance has budgets in the test suite. Dependencies are audited by script. See [OPERATIONS.md](OPERATIONS.md).

## What the tests found

The milestone notes list real bugs that property, mutation and soak tests caught: refunds filtered out of commission, a business date computed in UTC, a time-of-day flake on a daylight-saving boundary, an idempotency key that two simultaneous requests both passed, a login that picked an arbitrary account when the same email existed in two organisations. Each is fixed with a test that fails without the fix.

## What I did not verify, and say so

Everything in the world outside the repository is labelled unverified in [HARDWARE-TESTS.md](HARDWARE-TESTS.md): no real iPad or Safari run, no real receipt printer, cash drawer, card terminal or fingerprint terminal (two terminal dialects are built against simulators), no real Shopify store, Xero organisation or single-sign-on provider (each built against a stand-in written from the vendor's documentation). Each row says what to try on real hardware and what would prove the claim wrong.

## By the numbers

About a thousand automated tests across the workspace (money, pricing, sync, UI, API against a real Postgres, 20 Go tests) plus end-to-end browser suites for the till, admin, portal and storefront; 34 migrations; 24 milestones, each with a written status, decisions and limits.

Standalone: Shelfline shares no code with any other project of mine.
