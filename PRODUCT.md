# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack
Delegated (user: "pilih arsitektur terbaik, bukan berdasarkan pasar"). Chosen 2026-11-04: TypeScript monorepo; NestJS modular monolith + PostgreSQL (outbox and scheduled jobs in Postgres, no Redis/BullMQ in P1-P2); POS as a Vite + React PWA with a local database (Dexie, later Capacitor + SQLite); admin and portal as Vite + React SPAs; Next.js only for the P3 storefront; a small Go daemon for the device bridge. Reasons and critique of the original proposal are in docs/TECH-SPEC.md section 2.

## Users
Staff and owners of a small-to-mid multi-location retailer (demo: Kestrel Run Co., fictional running-shoe chain, four stores and a warehouse). Cashiers at an iPad register (busy, bright shop, one hand often full); store managers who review cash, approve variances and timesheets; HQ managers and purchasers who run catalogue, stock, purchase orders and transfers; the owner who decides who may see which reports and how commission is paid; external accountants and area managers who get a limited report portal; a store technician who installs the device bridge.

## Product Purpose
One system for selling, stock and cash across locations, built for the day the Wi-Fi drops. It joins what a retailer usually stitches from Shopify or Lightspeed, a separate attendance app, commission spreadsheets and emailed end-of-day reports: iPad POS with registers, float and cash movements; multi-location stock as a ledger; purchasing, transfers, counts, price books, gift cards and store credit; scheduling, timesheets and fingerprint attendance tied to the POS; per-cashier commission; per-user, per-location, per-date-range report permissions; notifications; and automated end-of-day reports. Success for the portfolio: the offline sync and the stock and cash ledgers are provably consistent, and a prospective client sees every surface working with synthetic data.

## Positioning
A neighbouring POS cannot truthfully claim all of: sales stay correct offline with every anomaly surfaced as a visible exception; every stock figure traces to a ledger line that sums to the balance; report access is scoped by user, location, date range and column, enforced on the server; attendance comes from a fingerprint terminal on the store network with biometric templates never leaving the terminal.

## Operating Context
Four surfaces: iPad POS (landscape, shop floor, offline-first PWA), back-office admin (desktop, location-first navigation), limited report portal (any browser, external users), device bridge (small always-on daemon on the store LAN with a local status page). Stores span time zones (demo: Melbourne with daylight saving, Perth without). Hardware that matters: iPad, receipt printer and cash drawer, barcode scanner, network fingerprint attendance terminal, card reader. Every hardware or third-party claim is flagged for verification in docs/TECH-SPEC.md section 10.

## Capabilities and Constraints
Phases by dependency, not time: P1 selling core (F1-F13), P2 store operations (F14-F28), P3 growth and scale (F29-F35); see docs/FEATURE-MAP.md. Constraints: money as integer minor units; stock changes only by appending ledger movements; the server never rejects a physical fact (stock may go negative, flagged); biometric templates are never stored by Shelfline; no payroll; no restaurant POS. Undecided: which real hardware is available for testing (decide before M14); email/WhatsApp providers.

## Brand Commitments
Name: Shelfline (renamed from "Gerai" on 2026-11-04 for a global audience; the name refers to the shelf edge where price and stock meet). UI language English; documents Indonesian. Distinct design system per product (user decision 2026-10-31); no native form controls (all projects).

## Evidence on Hand
No customers, no real store data, no real hardware yet. Competitor feature facts come from Lightspeed support pages, Xero listings and Shopify pages (see docs/FEATURE-MAP.md). Everything in mockups and the demo is synthetic and labelled. Do not invent testimonials, benchmarks or hardware test results.

## Product Principles
1. The sale has already happened: accept it, flag it, never lose it.
2. Every number traces to events; summaries are derived, never edited.
3. The location is always in view; permission boundaries are visible in the interface.
4. Work that may be offline says so plainly and shows what is waiting.
5. Hardware claims are tested on real devices or labelled as unverified.

## Accessibility & Inclusion
WCAG 2.2 AA; POS touch targets at least 48 px; custom form controls with ARIA roles and keyboard support; status never by colour alone; reduced motion respected.
