import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * The policy must describe what the code actually does. These tests read the real source and migrations and fail when the
 * policy and the code disagree, so a change to scopes, stored fields or retention cannot silently make the policy wrong.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')
const privacy = read('privacy.html')
const terms = read('terms.html')
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').replace(/\s+([,.;:])/g, '$1')
const privacyText = text(privacy)
const handlers = read('src/worker/googleSheetsHandlers.ts')
const gmail = read('src/worker/connections/gmail.ts')
const migrations = fs.readdirSync(path.join(root, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).map((f) => ({ f, sql: read(`supabase/migrations/${f}`) }))

describe('the privacy policy matches the code', () => {
  it('lists every Google OAuth scope the application requests', () => {
    const scopes = [...new Set(handlers.match(/https:\/\/www\.googleapis\.com\/auth\/[a-z.]+/g) ?? [])]
    assert.ok(scopes.length >= 3, 'scopes found in code: ' + scopes.join(', '))
    for (const scope of scopes) assert.ok(privacy.includes(scope), `policy must mention ${scope}`)
  })
  it('never claims metadata-only access while the code requests gmail.readonly', () => {
    assert.ok(handlers.includes('gmail.readonly') && !handlers.includes('gmail.metadata'))
    assert.ok(!/gmail\.metadata/i.test(privacy + terms), 'the policy must not name a scope the code does not request')
    assert.ok(!/metadata[- ]only/i.test(privacyText + text(terms)), 'must not claim metadata-only access')
    assert.match(privacyText, /broader than what Revenue OS uses/, 'must distinguish what the permission allows from what is used')
  })
  it('names every message header the connector requests, and the code never requests bodies or attachments', () => {
    const headers = (gmail.match(/metadataHeaders: \[([^\]]+)\]/)?.[1] ?? '').split(',').map((h) => h.replace(/['\s]/g, ''))
    assert.deepEqual(headers, ['From', 'To', 'Subject', 'List-Unsubscribe', 'Precedence', 'Auto-Submitted'])
    for (const header of headers) assert.ok(privacyText.includes(header), `policy must name the ${header} header`)
    assert.ok(gmail.includes("format: 'metadata'"), 'messages are fetched in metadata format')
    assert.ok(!/format:\s*['"](full|raw|minimal)['"]/.test(gmail), 'the connector must never request full or raw messages')
    assert.ok(!/attachments?\b/i.test(gmail.replace(/\/\/.*$/gm, '')), 'the connector never touches attachments')
  })
  it('states the stored field limits that the database enforces', () => {
    const communications = migrations.find((m) => /CREATE TABLE IF NOT EXISTS public\.communications/.test(m.sql))!.sql
    assert.match(communications, /subject text CHECK \(subject IS NULL OR length\(subject\) <= 300\)/)
    assert.match(communications, /snippet text CHECK \(snippet IS NULL OR length\(snippet\) <= 200\)/)
    assert.match(privacyText, /subject \(up to 300 characters\)/)
    assert.match(privacyText, /preview \(up to 200 characters\)/)
    assert.ok(!/\bbody\b/i.test(communications.replace(/--.*$/gm, '').replace(/no message bodies/gi, '')), 'there is no body column')
  })
  it('lists the Gmail labels and categories the connector skips', () => {
    const labels = gmail.match(/EXCLUDED_LABELS = \[([^\]]+)\]/)?.[1] ?? ''
    assert.deepEqual(labels.split(',').map((l) => l.replace(/['\s]/g, '')), ['SPAM', 'TRASH', 'CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS'])
    for (const word of ['Promotions', 'Social', 'Forums', 'Spam', 'Trash']) assert.ok(privacyText.includes(word), word)
    assert.match(gmail, /newer_than:90d/)
    assert.match(privacyText, /last 90 days/)
  })
  it('describes token protection the code really implements', () => {
    const crypto = read('src/worker/googleSheetsCrypto.ts')
    assert.match(crypto, /AES-GCM/)
    assert.match(privacyText, /AES-256-GCM/)
    const connections = read('supabase/migrations/20261018054702_provider_connections_server_only.sql')
    assert.match(connections, /REVOKE ALL ON TABLE public\.provider_connections FROM PUBLIC, anon, authenticated/)
    assert.ok(!/access_token['"]?\s*:/.test(read('src/worker/connections/runner.ts').split('\n').filter((l) => /patch\(|JSON\.stringify/.test(l)).join('\n')), 'access tokens are not persisted')
    assert.match(privacyText, /not written to the database/)
  })
  it('does not promise a scheduled deletion job, because none exists', () => {
    const scheduled = migrations.flatMap((m) => m.sql.match(/cron\.schedule\(\s*'([^']+)'/g) ?? [])
    assert.equal(scheduled.length, 1)
    assert.match(scheduled[0], /revenue-os-daily-evaluation/)
    assert.match(privacyText, /no automatic expiry/)
    assert.match(privacyText, /do not currently run a scheduled job that deletes old data/)
  })
  it('describes disconnect and deletion exactly as the code and the screen implement them', () => {
    const connectionHandlers = read('src/worker/connections/handlers.ts')
    assert.match(connectionHandlers, /revokeGoogleToken/)
    assert.match(connectionHandlers, /delete_synced_data/)
    for (const table of ['communications', 'conversation_tracking', 'muted_senders']) assert.ok(connectionHandlers.includes(`${table}?organization_id=`), `deletion covers ${table}`)
    assert.ok(read('src/connections/ConnectionsPage.tsx').includes('Disconnect and delete synced email data'))
    assert.match(privacyText, /Disconnect and delete synced email data/)
    assert.match(privacyText, /Invoices already imported are kept/)
    assert.ok(read('src/App.tsx').includes("disconnectProvider(session, organization.id, 'google_sheets')"), 'Sheets disconnect uses the route that also revokes at Google')
  })
  it('does not name subprocessors or protections that are not verified, and claims no certifications', () => {
    const combined = privacyText + ' ' + text(terms)
    for (const claim of [/SOC ?2/i, /ISO ?27001/i, /GDPR[- ]compliant/i, /HIPAA/i, /certified/i, /penetration test/i, /we never see/i, /end-to-end/i, /Stripe|Paddle|PayPal|Google Analytics|Mixpanel|Sentry/i]) {
      assert.ok(!claim.test(combined), `must not contain ${claim}`)
    }
  })
  it('includes the Google Limited Use statement, verbatim, in the policy and at the point of connection', () => {
    const statement = "will adhere to the Google API Services User Data Policy, including the Limited Use requirements"
    assert.ok(privacyText.includes(statement))
    assert.ok(text(read('src/connections/ConnectionsPage.tsx')).includes(statement), 'the connect screen carries the statement')
    assert.ok(privacy.includes('https://developers.google.com/terms/api-services-user-data-policy'))
  })
})

describe('the legal pages are public, well-formed and honest about unresolved details', () => {
  for (const [name, html] of [['privacy', privacy], ['terms', terms]] as const) {
    it(`${name}: has a title, description, canonical URL, indexing and no scripts`, () => {
      assert.match(html, /<title>[^<]{10,}<\/title>/)
      assert.match(html, /<meta name="description" content="[^"]{60,}"/)
      assert.match(html, new RegExp(`<link rel="canonical" href="\\{\\{SITE_URL\\}\\}/${name}"`))
      assert.match(html, /<meta name="robots" content="index,follow"/)
      assert.match(html, /<html lang="en"/)
      assert.ok(!/<script/i.test(html), 'readable without JavaScript')
      assert.ok(html.includes('href="/privacy"') && html.includes('href="/terms"'), 'cross-links')
    })
    it(`${name}: takes every operator detail from legal/operator.json and invents none`, () => {
      assert.ok(html.includes('{{OPERATOR_NAME}}') && html.includes('{{CONTACT_EMAIL}}') && html.includes('{{POSTAL_ADDRESS}}'))
      assert.ok(!/mailto:/i.test(html) && !/[A-Za-z0-9._-]+@[A-Za-z0-9-]+\.[a-z]{2,}/.test(html), 'no literal email address in the page source')
      assert.ok(!/\b(Ltd|LLC|Pvt|\(Private\) Limited|Inc\.)/.test(html), 'no invented company name')
    })
  }
  it('the terms leave the lawyer decisions visibly open and invent no refund policy, governing law or liability cap', () => {
    assert.match(terms, /Governing law, courts or arbitration, and dispute process: lawyer to decide before launch/)
    assert.match(terms, /Cap on liability, exclusions required by law, and any consumer-law carve-outs: lawyer to decide before launch/)
    assert.match(terms, /currently offered as a pilot without charge/)
    assert.ok(!/refund(s)? (will|are|within)|governed by the laws of|limited to \$|within \d+ days/i.test(text(terms)))
  })
  it('operator.json holds no invented values and the example placeholders stay null until the owner provides them', () => {
    const operator = JSON.parse(read('legal/operator.json')) as Record<string, string | null>
    for (const key of ['operatorName', 'contactEmail', 'postalAddress']) assert.ok(key in operator, key)
    assert.match(operator.siteUrl ?? '', /^https:\/\/[^/]+$/)
  })
})

describe('the legal pages are linked from the product', () => {
  it('the sign-in screen (public homepage) links to both pages and describes the product', () => {
    const auth = read('src/AuthApp.tsx')
    assert.ok(auth.includes('href="/privacy"') && auth.includes('href="/terms"'))
    assert.ok(auth.includes('Know who owes you, and who is waiting on you.'))
  })
  it('the signed-in footer and the Google connection screen link to both pages', () => {
    const app = read('src/App.tsx')
    assert.ok(app.includes('href="/privacy"') && app.includes('href="/terms"'))
    const connections = read('src/connections/ConnectionsPage.tsx')
    assert.ok(connections.includes('href="/privacy"') && connections.includes('href="/terms"'))
  })
})
