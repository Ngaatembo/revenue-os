import { db } from '../googleSheetsHandlers.ts'

export interface WhatsAppEnv {
  WHATSAPP_APP_SECRET?: string
  WHATSAPP_VERIFY_TOKEN?: string
  SUPABASE_URL?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
}
type Json = Record<string, unknown>
export interface WhatsAppMessageRow {
  provider: 'whatsapp'; external_id: string; thread_id: string; direction: 'inbound'; counterpart_address: string; counterpart_name: string | null
  subject: string | null; snippet: string | null; occurred_at: string; is_automated: false; source_account: string
}
export interface ParsedWebhook { phoneNumberId: string; displayNumber: string | null; rows: WhatsAppMessageRow[] }

const enc = new TextEncoder()
function hex(buffer: ArrayBuffer) { return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('') }

/** Constant-time comparison of two equal-purpose hex strings. */
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Meta signs the RAW request body with the app secret (HMAC-SHA256). Never verify against re-serialized JSON. */
export async function verifySignature(rawBody: string, header: string | null, appSecret: string): Promise<boolean> {
  const match = header?.match(/^sha256=([a-f0-9]{64})$/i)
  if (!match) return false
  const key = await crypto.subtle.importKey('raw', enc.encode(appSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const expected = hex(await crypto.subtle.sign('HMAC', key, enc.encode(rawBody)))
  return safeEqual(expected, match[1]!.toLowerCase())
}

/** Pull inbound customer messages out of Meta's payload. Status updates and unsupported shapes are ignored. */
export function parseWebhook(payload: unknown): ParsedWebhook[] {
  const out: ParsedWebhook[] = []
  const root = payload as Json | null
  if (!root || root.object !== 'whatsapp_business_account' || !Array.isArray(root.entry)) return out
  for (const entry of root.entry as Json[]) {
    for (const change of (Array.isArray(entry.changes) ? entry.changes : []) as Json[]) {
      if (change.field !== 'messages') continue
      const value = change.value as Json | undefined
      const metadata = value?.metadata as Json | undefined
      const phoneNumberId = typeof metadata?.phone_number_id === 'string' ? metadata.phone_number_id : ''
      if (!/^[0-9]{5,32}$/.test(phoneNumberId) || !Array.isArray(value?.messages)) continue
      const displayNumber = typeof metadata?.display_phone_number === 'string' ? metadata.display_phone_number.slice(0, 40) : null
      const names = new Map<string, string>()
      for (const contact of (Array.isArray(value?.contacts) ? value!.contacts : []) as Json[]) {
        const name = (contact.profile as Json | undefined)?.name
        if (typeof contact.wa_id === 'string' && typeof name === 'string') names.set(contact.wa_id, name.slice(0, 200))
      }
      const rows: WhatsAppMessageRow[] = []
      for (const message of value!.messages as Json[]) {
        const id = typeof message.id === 'string' ? message.id : ''
        const from = typeof message.from === 'string' ? message.from : ''
        const seconds = Number(message.timestamp)
        if (!id || id.length > 200 || !/^[0-9]{5,20}$/.test(from) || !Number.isFinite(seconds) || seconds <= 0) continue
        const type = typeof message.type === 'string' ? message.type.replace(/[^a-z_]/g, '').slice(0, 30) : 'unknown'
        const body = type === 'text' ? (message.text as Json | undefined)?.body : undefined
        rows.push({
          provider: 'whatsapp', external_id: id, thread_id: from, direction: 'inbound', counterpart_address: from, counterpart_name: names.get(from) ?? null,
          subject: type === 'text' ? null : `[${type || 'message'}]`, snippet: typeof body === 'string' && body.trim() ? body.trim().slice(0, 200) : null,
          occurred_at: new Date(seconds * 1000).toISOString(), is_automated: false, source_account: displayNumber ?? phoneNumberId,
        })
      }
      if (rows.length) out.push({ phoneNumberId, displayNumber, rows })
    }
  }
  return out
}

const reply = (status: number, body: unknown = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json', 'cache-control': 'no-store' } })

/**
 * Meta webhook endpoint. Disabled (404) unless both WHATSAPP_APP_SECRET and WHATSAPP_VERIFY_TOKEN are configured.
 * GET answers Meta's subscription handshake; POST accepts only correctly signed payloads.
 */
export async function handleWhatsAppWebhook(request: Request, env: WhatsAppEnv): Promise<Response> {
  if (!env.WHATSAPP_APP_SECRET?.trim() || !env.WHATSAPP_VERIFY_TOKEN?.trim()) return reply(404, { error: 'not_enabled' })
  if (request.method === 'GET') {
    const q = new URL(request.url).searchParams
    const ok = q.get('hub.mode') === 'subscribe' && q.get('hub.verify_token') === env.WHATSAPP_VERIFY_TOKEN
    return ok ? reply(200, q.get('hub.challenge')?.slice(0, 200) ?? '') : reply(403, { error: 'verification_failed' })
  }
  if (request.method !== 'POST') return reply(405, { error: 'method_not_allowed' })
  const raw = await request.text()
  if (raw.length > 1_000_000) return reply(413, { error: 'too_large' })
  if (!await verifySignature(raw, request.headers.get('x-hub-signature-256'), env.WHATSAPP_APP_SECRET)) return reply(401, { error: 'invalid_signature' })
  let payload: unknown
  try { payload = JSON.parse(raw) } catch { return reply(400, { error: 'invalid_json' }) }
  let stored = 0, ignoredUnknownNumber = 0
  try {
    for (const batch of parseWebhook(payload)) {
      const owner = await db(env, `whatsapp_numbers?select=organization_id&phone_number_id=eq.${encodeURIComponent(batch.phoneNumberId)}&limit=1`) as Array<{ organization_id: string }>
      if (!owner[0]) { ignoredUnknownNumber += batch.rows.length; continue } // acknowledge so Meta does not retry; nothing is stored
      await db(env, 'communications?on_conflict=organization_id,provider,external_id', {
        method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
        body: JSON.stringify(batch.rows.map((row) => ({ ...row, organization_id: owner[0]!.organization_id }))),
      })
      stored += batch.rows.length
    }
  } catch {
    return reply(500, { error: 'storage_failed' }) // Meta retries non-2xx deliveries; idempotent storage makes the retry safe
  }
  return reply(200, { received: stored, ignored_unknown_number: ignoredUnknownNumber })
}
