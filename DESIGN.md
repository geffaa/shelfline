# Shelfline design system v1: "shelf-edge"

Written from the finished mockups in `mockups/` (pos-sell, admin-session, admin-stock, components). Mode: Operate. Quality floor: `~/.claude/skills/breakdown/anti-slop.md`. Stylesheet: `mockups/shelfline-ds.css`; generator: `tools/build_mockups.py`.

## Direction and reasons
Retail is lit, fast and physical: bright shop light, a customer waiting, a tag in one hand. So the product is **light** (decided from the use scene, not the category), with a graphite ink and one loud accent borrowed from the shelf-edge sale sticker: **volt yellow-green**. Volt marks the one action or the current place (active domain, Pay, selection) and is always paired with dark ink for contrast. Status colours (green, amber, red, blue) carry state only and always come with an icon or word.

Different from earlier products: Roster teal/Source Sans, Relay dark rail/violet, Sukha indigo bar/Manrope, Simpul copper/IBM Plex, Lulur rosewood/serif, Jaga dark jade, Weft pine/ink bar/Albert Sans. Shelfline is the only one with a yellow-green accent, a variable-width grotesque, and **locations as the navigator**.

## Signature moves
1. **Dot-leader sheet.** Close sheets, Z-reports, totals and receipts set a label, a dotted leader and a monospaced figure on one line, with a heavy rule above the total. It encodes "this amount belongs to this label" and sums visibly. Used only for money summaries, never as decoration.
2. **Location rail with live state.** The left rail lists locations (not modules) with an open/closed dot, local time zone and a warning count (for example "1 offline"). Choosing one scopes every screen.

## Tokens
| Token | Value | Use |
|---|---|---|
| ground / surface / surface-2 | #ECEFF2 / #FFFFFF / #F5F7F9 | page, panels, table header |
| line / line-strong | #D8DDE4 / #AEB6C2 | dividers, control borders |
| ink / ink-2 / ink-3 | #14171C / #434B58 / #5B6472 | text (ink-3 is the weakest, AA on ground) |
| volt / volt-hover / volt-soft / volt-text | #C9E73A / #B9D82A / #F1F8CC / #415208 | primary action, current place, selection |
| ok / warn / danger / info | #1A7443 / #9A4300 / #B3261E / #1B5FB5 | status text and icons (soft backgrounds: ok #E1F3E8, warn #FCEED8, danger #FBE5E3, info #E3EEFB) |
| bar | #14171C | POS side bar only (device chrome) |
Dark theme tokens exist in CSS (`data-theme="dark"`) for dim venues; not used in mockups.

## Type
**Archivo** (variable weight and width) for UI: 12.5 / 13 / 14 body / 16 / 20 / 28 page title (width 108%); POS figures use width 112%. **Azeret Mono** for money, SKUs, times and ledger numbers, tabular. No uppercase eyebrows. Measure under 80 characters.

## Space, radius, depth
Scale 4 / 8 / 12 / 16 / 24 / 32 / 48. Radius 6 (controls) / 10 (panels) / 14. Shadows only on floating elements (listbox, calendar). Panels are bordered, not shadowed.

## Layout and navigation (from IA, final phase)
Admin: 56px white top bar with brand, six domain tabs (Today, Sell, Stock, People, Money, Grow; active = volt pill), search, alerts, settings. Left **location rail** 248px (icons only under 1180px; hidden under 760px where a location chip and a bottom tab bar replace it). Section strip under the page title. Main content max-width fluid, 32px gutters. POS: 92px graphite bar (Sell, Orders, Cash, Stock, Shift, Sync with queue badge), search and results centre, 392px cart on the right; under 860px the bar moves to the bottom and the cart stacks under results.

## Components
All custom with ARIA: select/combobox + listbox, date picker dialog (grid, selected and today states), checkbox, radio, switch, segmented control, quantity stepper (44px targets), PIN keypad (64px keys), file drop zone, chips (word plus colour), callouts (warn/danger/info), tables with right-aligned monospaced figures, timeline. Icons: Lucide via kit.py, 1.75 stroke. Focus ring 3px blue with offset. Selection colour volt. Reduced motion respected.

## Patterns
- Offline is a persistent banner plus a header pill with the queue count; network-only tenders show a lock, not a hidden button.
- Anything flagged by sync (negative stock, price mismatch, over-refund) shows as a chip on the row and a callout at the top.
- Write buttons name the location they act on ("Adjust stock at Fremantle").
- Cost and margin columns disappear for roles without access; the screen says so.

## Audit (2026-11-04)
Screenshots at 1440 (admin), 1180 (POS) and 390 (all) in `.impeccable/review/`. No horizontal page scroll at any size (tables scroll inside their panel on phones). `impeccable detect` on `mockups/`: no findings. Not checked: real iPad Safari rendering, dark theme, and keyboard walk-through of the components page.
