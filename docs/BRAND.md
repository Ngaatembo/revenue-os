# Revenue OS brand system

## Brand promise
Revenue OS helps business owners identify, prioritize, execute, and measure revenue opportunities. The product should feel trustworthy, precise, calm, and commercially useful—not like a noisy sales dashboard.

## Logo assets
- `/public/revenue-os-logo.png` — the approved full logo (blue R with growth bars and rising arrow, "Revenue OS" wordmark, tagline "Turn Opportunities Into Revenue"), transparent background, derived from the owner-supplied artwork.
- `/public/revenue-os-mark.png` — the R mark alone for navigation and compact placements; `/public/favicon.png`, `/public/apple-touch-icon.png`, `/public/icon-512.png` are white-tile renderings of it.
- Use the logo as supplied: do not redraw, recolour, add arrows or glyphs, or replace it with a tile. On dark surfaces place the full logo on a white plate (the wordmark is navy).
- Keep the symbol proportions intact. Do not stretch, recolor arbitrarily, add shadows, or place it on low-contrast backgrounds.
- Use the compact symbol for small UI placements; use the full lockup for landing pages, presentations, and product introductions.

## Colour tokens
| Token | Hex | Purpose |
|---|---|---|
| Brand blue | `#0064EA` | Primary actions, links, navigation focus (the "OS" blue of the logo) |
| Deep blue | `#0053C4` | Hover and pressed primary actions |
| Azure | `#0B8DE2` | Focus rings and light accents (the logo's highlight blue) |
| Navy | `#01143B` | Headings and the wordmark; body ink is `#0B1B3A` |
| Growth green | `#128A3D` text / `#23D44F` bars | **Verified** outcomes only (the logo's bars); never decoration or navigation |
| Muted slate | `#55657F` | Secondary text |
| Page background | `#EEF3FA` | Main canvas |
| Surface | `#FFFFFF` | Cards and input surfaces |
| Border | `#DCE4EF` | Dividers and outlines |

Dark mode tokens are defined in `src/design.css`. Use CSS variables rather than hard-coding brand colours inside new components.

## Interface principles
1. Make overdue amounts and next actions clear at a glance.
2. Blue means action or navigation; green means verified success, not an estimate.
3. Keep estimates visually distinct from observed or verified revenue.
4. Preserve a calm, ledger-like layout; use amber and red sparingly for ageing and risk.
5. Maintain readable text, visible keyboard focus, and touch targets of at least 44px for primary controls.
6. Support small mobile screens and system dark mode.

## Typography
Use the existing Inter/system sans-serif stack for interface text. Use the existing ledger-style serif treatment for large financial figures only.

## Release checks
- `npm run build`
- `npm run test:domain`
- `npm run lint`
- CI database migration, tenant-isolation, and journey tests
- Review light and dark themes at desktop and mobile widths
- Confirm production deployment separately from successful CI

## Overview and controls (interior pass)
- Overview order: "Needs you today" band (max 5 ranked rows, Observed/Inferred label, one tap to the list), source strip, summary figures, "Owed to you", then conversations split into "Waiting for your reply" and "Gone quiet".
- Input and select borders use `--control-border` (#8FA3BF light), because the decorative `--line` hairline is under 3:1.
- Green stays fill/icon only; azure is never body text.

## Overview v2 (design pass)
- One place per invoice: the needs-you band is the only list of overdue invoices on Overview; waiting conversations collapse into one summary row that scrolls to the conversations list.
- Each needs-you row has one primary 48px button (Draft reminder / Review draft / Open) and a 48px menu (Snooze 7 days, Record a response or dismiss).
- Money: one hero amount per currency, a labelled aging list (colour dot plus text), verified and estimated shown as separate lines and never summed. Zero is "None", unknown is a sentence.
- Depth from tone: page #EEF3FA, white cards with an `--edge` hairline, `--shadow-1` for cards, `--shadow-2` for the hero only; dark mode lifts by tone, not shadow. No blur, grain or gradients.
- Text: 14px minimum for anything actionable; control borders `#7C8DA8` (3:1).
