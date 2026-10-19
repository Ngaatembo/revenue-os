# Revenue OS brand system

## Brand promise
Revenue OS helps business owners identify, prioritize, execute, and measure revenue opportunities. The product should feel trustworthy, precise, calm, and commercially useful—not like a noisy sales dashboard.

## Logo assets
- `/public/revenue-os-mark.svg` — compact symbol used for app navigation and favicon.
- `/public/revenue-os-logo.svg` — full horizontal logo with tagline.
- Keep the symbol proportions intact. Do not stretch, recolor arbitrarily, add shadows, or place it on low-contrast backgrounds.
- Use the compact symbol for small UI placements; use the full lockup for landing pages, presentations, and product introductions.

## Colour tokens
| Token | Hex | Purpose |
|---|---|---|
| Brand blue | `#1769E0` | Primary actions, links, navigation focus |
| Deep blue | `#1254B5` | Hover and pressed primary actions |
| Growth green | `#15945F` | Verified positive outcomes and success |
| Navy | `#14233B` | Primary text and headings |
| Muted slate | `#637187` | Secondary text |
| Page background | `#F5F8FC` | Main canvas |
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
