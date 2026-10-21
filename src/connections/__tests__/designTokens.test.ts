import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'

const root = new URL('../../../', import.meta.url)
const read = (path: string) => readFileSync(new URL(path, root), 'utf8')
const design = read('src/design.css')

/** First :root block, and the dark-mode block, as { token: value }. */
function tokens(block: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of block.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim()
  return out
}
const light = tokens(design.slice(design.indexOf(':root {'), design.indexOf('@media (prefers-color-scheme: dark)')))
const darkStart = design.indexOf('@media (prefers-color-scheme: dark)')
const dark = tokens(design.slice(darkStart, design.indexOf('\n}\n', design.indexOf(':root {', darkStart))))


const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}
const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05) }

test('brand tokens are the colours sampled from the approved logo', () => {
  assert.equal(light['--brand-navy'], '#01143b'); assert.equal(light['--brand-blue'], '#0064ea'); assert.equal(light['--action'], '#0064ea')
  assert.equal(light['--action-hover'], '#0053c4'); assert.equal(light['--page'], '#f4f7fc'); assert.equal(light['--sidebar'], '#f9fbff')
})
test('the sidebar is light (not the dark-green drift) and green is reserved for verified success', () => {
  assert.ok(lum(light['--sidebar']!) > 0.9, 'sidebar must be a light surface')
  assert.equal(light['--teal'], light['--action'], 'legacy accent alias follows the blue action colour')
  assert.equal(light['--verified'], '#0f7a35')
})
test('text and action colours meet WCAG AA contrast in light and dark themes', () => {
  assert.ok(contrast('#ffffff', light['--action']!) >= 4.5, 'white on action blue')
  assert.ok(contrast(light['--ink']!, light['--page']!) >= 7, 'body ink on page')
  assert.ok(contrast(light['--muted']!, light['--surface']!) >= 4.5, 'muted on surface')
  assert.ok(contrast(light['--verified']!, light['--surface']!) >= 4.5, 'verified green text on surface')
  assert.ok(contrast(dark['--action']!, dark['--surface']!) >= 4.5, 'dark: action on surface')
  assert.ok(contrast(dark['--ink']!, dark['--page']!) >= 7, 'dark: ink on page')
  assert.ok(contrast(dark['--muted']!, dark['--surface']!) >= 4.5, 'dark: muted on surface')
})
test('a dark theme exists (system preference) and no later :root block re-declares the light tokens over it', () => {
  assert.ok(dark['--page'] && dark['--action'] && dark['--ink'])
  const lastDarkBlockEnd = design.indexOf('\n}\n', design.indexOf(':root {', darkStart)) + 3
  const afterDark = design.slice(lastDarkBlockEnd)
  assert.ok(!/:root\s*\{[^}]*--(page|action|ink|surface)\s*:/.test(afterDark), 'a later :root re-declares colour tokens and would defeat dark mode')
  assert.equal([...design.matchAll(/--action:\s*#0064ea/g)].length, 1, 'light tokens are declared exactly once')
})
test('the drifted dark-green palette is gone from every stylesheet', () => {
  const legacy = ['#183b32', '#172c26', '#245b46', '#194a38', '#2d7c63', '#24754e', '#b8c9be', '#b7d5b7', '#f7f5ef', '#fffefa', '#f6f5ef']
  for (const file of readdirSync(new URL('src/', root)).filter((name) => name.endsWith('.css'))) {
    const css = read(`src/${file}`).toLowerCase()
    for (const colour of legacy) assert.ok(!css.includes(colour), `${file} still contains ${colour}`)
  }
})
test('green appears in stylesheets only inside success / verified rules', () => {
  const isGreen = (hex: string) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)); return g > r + 12 && g > b + 12 }
  for (const file of readdirSync(new URL('src/', root)).filter((name) => name.endsWith('.css'))) {
    for (const rule of read(`src/${file}`).split('}')) {
      const [selector, body = ''] = rule.split('{')
      // Token declarations (--name: value) define the palette itself; only real property uses are checked.
      const uses = body.split(';').filter((declaration) => !declaration.trim().startsWith('--')).join(';')
      for (const m of uses.matchAll(/#([0-9a-fA-F]{6})\b/g)) {
        if (isGreen(`#${m[1]!.toLowerCase()}`)) assert.match(selector!, /success|verified|ready|connected|complete|paid|ok\b|positive|resolved|confirm|good/i, `${file}: green ${m[0]} outside a success rule: ${selector!.trim().slice(0, 80)}`)
      }
    }
  }
})
test('the approved logo assets are present, real transparent PNGs, and referenced instead of the redrawn vector marks', () => {
  for (const name of ['revenue-os-logo.png', 'revenue-os-mark.png', 'favicon.png', 'apple-touch-icon.png', 'icon-512.png']) {
    assert.ok(existsSync(new URL(`public/${name}`, root)), `${name} missing`)
    const png = readFileSync(new URL(`public/${name}`, root))
    assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG')
  }
  const logo = readFileSync(new URL('public/revenue-os-logo.png', root))
  assert.equal(logo[25], 6, 'full logo is RGBA (transparent background)'); assert.ok(logo.length < 300_000, 'logo stays light enough for the sign-in page')
  assert.equal(existsSync(new URL('public/revenue-os-mark.svg', root)), false, 'the redrawn SVG mark must not return')
  const html = read('index.html'); assert.match(html, /favicon\.png/); assert.match(html, /theme-color" content="#0064ea"/)
  assert.match(read('src/App.tsx'), /revenue-os-mark\.png/); assert.match(read('src/AuthApp.tsx'), /revenue-os-logo\.png/)
})
test('the arrow-style START HERE card is not part of the Overview', () => {
  assert.doesNotMatch(read('src/App.tsx'), /owner-next-step/); assert.doesNotMatch(design, /\.owner-next-step/)
})
test('CSV upload is a labelled fallback below the primary connections, not a connection card', () => {
  const page = read('src/connections/ConnectionsPage.tsx')
  assert.match(page, /No account to connect\?/); assert.match(page, /manual fallback/)
  assert.ok(page.indexOf('connection-source-grid') < page.indexOf('fallback-import'), 'fallback comes after the primary sources')
})
test('no label claims a connector is working, planned-as-working, or "in app" unless it is', () => {
  const app = read('src/App.tsx'); const catalog = read('src/connections/catalog.ts')
  assert.doesNotMatch(app, /connector in app|Email · planned|Connect email · planned/)
  assert.match(catalog, /external_approval_required/)
})
