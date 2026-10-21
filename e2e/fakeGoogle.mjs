// A small, in-process stand-in for Google's OAuth, userinfo and Gmail endpoints. It is NOT Google:
// results from it prove our code handles the documented response shapes, not that Google accepts our app.
const DAY = 86_400_000
export const OWNER = 'owner@shop.test'

export function buildMailbox(now = Date.now()) {
  const messages = []
  let n = 0
  const add = (o) => { n += 1; messages.push({ id: `m${n}`, threadId: o.thread, labelIds: o.labels, snippet: o.snippet ?? '', internalDate: String(o.at), payload: { headers: [
    { name: 'From', value: o.from }, { name: 'To', value: o.to }, { name: 'Subject', value: o.subject }, ...(o.headers ?? [])] } }) }
  for (let i = 0; i < 200; i += 1) add({ thread: `news-${i}`, labels: ['INBOX'], at: now - (10 + (i % 60)) * DAY, from: `Deals <deals${i}@promo.test>`, to: OWNER, subject: `Weekly deals ${i}`, headers: [{ name: 'List-Unsubscribe', value: '<mailto:u@promo.test>' }] })
  add({ thread: 'wait-1', labels: ['INBOX'], at: now - 4 * DAY, from: 'Tendai Moyo <tendai@buyer.test>', to: OWNER, subject: 'Quote request: 20 bags of cement', snippet: 'Hi, can you send a quote for 20 bags of cement delivered to Harare?' })
  add({ thread: 'wait-2', labels: ['INBOX'], at: now - 3 * DAY, from: 'Chipo Dube <chipo@buyer.test>', to: OWNER, subject: 'Delivery to Bulawayo?', snippet: 'Do you deliver to Bulawayo and what is the cost?' })
  add({ thread: 'replied', labels: ['INBOX'], at: now - 6 * DAY, from: 'Farai <farai@buyer.test>', to: OWNER, subject: 'Invoice 114', snippet: 'Please resend the invoice' })
  add({ thread: 'replied', labels: ['SENT'], at: now - 5 * DAY, from: OWNER, to: 'Farai <farai@buyer.test>', subject: 'Re: Invoice 114', snippet: 'Attached again' })
  add({ thread: 'quiet', labels: ['INBOX'], at: now - 12 * DAY, from: 'Rudo <rudo@buyer.test>', to: OWNER, subject: 'Pricing for 5 tonnes', snippet: 'What is your best price for 5 tonnes?' })
  add({ thread: 'quiet', labels: ['SENT'], at: now - 9 * DAY, from: OWNER, to: 'Rudo <rudo@buyer.test>', subject: 'Re: Pricing for 5 tonnes', snippet: 'Our price is 120 per tonne' })
  add({ thread: 'recent', labels: ['INBOX'], at: now - 2 * 3600_000, from: 'Kuda <kuda@buyer.test>', to: OWNER, subject: 'Question this morning', snippet: 'Quick question' })
  return messages
}

export function createFakeGoogle() {
  const state = {
    messages: buildMailbox(), history: [], historyId: 5000, revoked: false, revokeCalls: 0, tokenGrants: 0, refreshCalls: 0,
    rateLimitedGets: 0, // number of upcoming message fetches that return a rate-limit error
    scopeGranted: 'https://www.googleapis.com/auth/gmail.readonly openid email', requests: [],
  }
  const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
  async function handle(request) {
    const url = new URL(request.url)
    state.requests.push(`${request.method} ${url.host}${url.pathname}`)
    if (url.host === 'oauth2.googleapis.com' && url.pathname === '/token') {
      const form = new URLSearchParams(await request.text())
      if (form.get('grant_type') === 'authorization_code') { state.tokenGrants += 1; return json({ access_token: 'at-1', refresh_token: 'rt-secret-value', scope: state.scopeGranted, expires_in: 3600 }) }
      state.refreshCalls += 1
      if (state.revoked || form.get('refresh_token') !== 'rt-secret-value') return json({ error: 'invalid_grant' }, 400)
      return json({ access_token: 'at-2', expires_in: 3600 })
    }
    if (url.host === 'oauth2.googleapis.com' && url.pathname === '/revoke') { state.revokeCalls += 1; return json({}) }
    if (url.pathname === '/oauth2/v2/userinfo') return json({ email: OWNER })
    if (url.host === 'gmail.googleapis.com') {
      if (request.headers.get('authorization') !== 'Bearer at-2' && request.headers.get('authorization') !== 'Bearer at-1') return json({ error: { status: 'UNAUTHENTICATED' } }, 401)
      const path = url.pathname.replace('/gmail/v1/users/me/', '')
      if (path === 'profile') return json({ emailAddress: OWNER, historyId: String(state.historyId) })
      if (path === 'messages') {
        const size = Number(url.searchParams.get('maxResults') ?? 100), start = Number(url.searchParams.get('pageToken') ?? 0)
        const ordered = [...state.messages].sort((a, b) => Number(b.internalDate) - Number(a.internalDate))
        return json({ messages: ordered.slice(start, start + size).map((m) => ({ id: m.id })), ...(start + size < ordered.length ? { nextPageToken: String(start + size) } : {}) })
      }
      if (path.startsWith('messages/')) {
        if (state.rateLimitedGets > 0) { state.rateLimitedGets -= 1; return json({ error: { errors: [{ reason: 'userRateLimitExceeded' }] } }, 403, { 'retry-after': '90' }) }
        const m = state.messages.find((x) => x.id === decodeURIComponent(path.slice(9)))
        return m ? json(m) : json({}, 404)
      }
      if (path === 'history') { const from = Number(url.searchParams.get('startHistoryId')); return json({ history: state.history.filter((h) => h.at > from).map((h) => ({ messagesAdded: h.ids.map((id) => ({ message: { id } })) })), historyId: String(state.historyId) }) }
    }
    return json({ error: 'not_found' }, 404)
  }
  /** Add a new inbound message the way Gmail would report it: in the mailbox and in history. */
  state.deliver = (o) => { const id = `m${state.messages.length + 1}`; state.messages.push({ id, threadId: o.thread, labelIds: ['INBOX'], snippet: o.snippet ?? '', internalDate: String(o.at ?? Date.now()),
    payload: { headers: [{ name: 'From', value: o.from }, { name: 'To', value: OWNER }, { name: 'Subject', value: o.subject }] } }); state.historyId += 1; state.history.push({ at: state.historyId, ids: [id] }); return id }
  return { state, handle }
}
export const GOOGLE_HOSTS = new Set(['oauth2.googleapis.com', 'accounts.google.com', 'www.googleapis.com', 'gmail.googleapis.com'])
