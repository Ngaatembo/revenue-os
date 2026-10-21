#!/usr/bin/env node
// Scans the built browser bundle (dist/) for server-only secrets. Public values (Supabase URL, publishable anon key) are expected.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')
if (!fs.existsSync(dist)) { console.error('dist/ not found: run `npm run build` first.'); process.exit(2) }
const files = []
const walk = (dir) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) walk(full); else if (/\.(js|css|html|json|map|txt)$/.test(entry.name)) files.push(full) } }
walk(dist)
const forbidden = [
  [/GOOGLE_CLIENT_SECRET/, 'GOOGLE_CLIENT_SECRET name'], [/GOOGLE_TOKEN_ENCRYPTION_KEY/, 'token encryption key name'], [/SUPABASE_SERVICE_ROLE_KEY/, 'Supabase service key environment variable name'],
  [/WHATSAPP_APP_SECRET|WHATSAPP_VERIFY_TOKEN/, 'WhatsApp secret name'], [/sb_secret_[A-Za-z0-9_-]{10,}/, 'Supabase secret key'], [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key block'],
  [/GOCSPX-[A-Za-z0-9_-]{10,}/, 'Google client secret value'], [/\b[0-9a-f]{64}\b/, '64-hex string (looks like an encryption key)'],
]
const findings = []
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8')
  for (const [pattern, label] of forbidden) if (pattern.test(text)) findings.push(`${path.relative(dist, file)}: ${label}`)
  for (const token of text.match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g) ?? []) {
    try { const role = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).role; if (role && role !== 'anon') findings.push(`${path.relative(dist, file)}: JWT with role "${role}"`) } catch { /* not a JWT */ }
  }
}
if (findings.length) { console.error('Secrets or sensitive values found in the browser bundle:'); for (const f of [...new Set(findings)]) console.error(' - ' + f); process.exit(1) }
console.log(`Bundle scan: ${files.length} files, no server-only secrets found.`)
