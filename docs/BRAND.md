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
| Page background | `#F4F7FC` | Main canvas |
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
