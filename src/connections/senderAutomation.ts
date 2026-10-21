/**
 * Decides whether mail looks machine-generated (product notifications, newsletters, system mail) rather than a person writing.
 * Precision matters more than recall here: a real customer wrongly hidden is lost money, so these rules only match patterns
 * that people do not use for their own addresses. Ambiguous names (team@, hello@, info@, support@, sales@) are never matched.
 */
const LOCAL_TOKENS = new Set([
  'noreply', 'no-reply', 'no_reply', 'donotreply', 'do-not-reply', 'do_not_reply', 'notification', 'notifications', 'notify', 'notifier',
  'mailer', 'mailer-daemon', 'postmaster', 'bounce', 'bounces', 'newsletter', 'newsletters', 'alert', 'alerts', 'updates', 'digest', 'marketing', 'campaign', 'campaigns', 'automated',
])
/** Sub-domains that senders use for bulk or transactional mail: hi@mailing.windsor.ai, notify@updates.notion.com. */
const SUBDOMAIN_TOKENS = new Set([
  'mailing', 'email', 'em', 'e', 'mg', 'send', 'sender', 'mailer', 'news', 'newsletter', 'updates', 'update', 'notify', 'notifications', 'notification', 'marketing', 'campaign', 'campaigns', 'bounce', 'bounces',
])
/** The original connector pattern, kept so nothing it caught is lost (matches the token anywhere in the address, e.g. foo-no-reply@). */
const LEGACY_SENDER = /(^|[._-])(no-?reply|do-?not-?reply|donotreply|notifications?|mailer-daemon|postmaster|bounce[s]?|newsletter|alerts?)([._-]|@)/i
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu'])

export function looksAutomatedAddress(address: string | null | undefined): boolean {
  if (!address) return false
  const at = address.lastIndexOf('@')
  if (at < 1) return false
  if (LEGACY_SENDER.test(address)) return true
  const local = address.slice(0, at).toLowerCase().split('+')[0]!
  const labels = address.slice(at + 1).toLowerCase().split('.').filter(Boolean)
  if (LOCAL_TOKENS.has(local) || local.split(/[._-]/).some((token) => LOCAL_TOKENS.has(token))) return true
  // Whole-name patterns such as "do-not-reply" and "mailer-daemon" are caught above; compare the joined form too.
  if (LOCAL_TOKENS.has(local.replace(/[._]/g, '-'))) return true
  // Registrable domain is the last two labels, or three for co.zw / com.au style endings.
  const registrable = labels.length >= 3 && labels[labels.length - 1]!.length === 2 && SECOND_LEVEL.has(labels[labels.length - 2]!) ? 3 : 2
  return labels.slice(0, Math.max(0, labels.length - registrable)).some((label) => SUBDOMAIN_TOKENS.has(label))
}

export interface ThreadFacts {
  thread_id: string
  counterpart_address: string | null
  subject: string | null
  last_outbound_at: string | null
}

/**
 * The same sender repeating an identical subject, with no reply from the owner in any of those threads or ever to that address,
 * is system mail even when its address looks ordinary (team@base44.com sending "Your monthly credits are running low" three times).
 * A single message is never flagged by this rule: that could be a real first enquiry.
 */
export function repeatedSystemMail(threads: ThreadFacts[]): Set<string> {
  const written = new Set(threads.filter((t) => t.last_outbound_at && t.counterpart_address).map((t) => t.counterpart_address as string))
  const groups = new Map<string, string[]>()
  for (const thread of threads) {
    const subject = (thread.subject ?? '').trim().toLowerCase()
    if (!thread.counterpart_address || !subject || written.has(thread.counterpart_address)) continue
    const key = `${thread.counterpart_address}\n${subject}`
    groups.set(key, [...(groups.get(key) ?? []), thread.thread_id])
  }
  const flagged = new Set<string>()
  for (const ids of groups.values()) if (ids.length >= 2) for (const id of ids) flagged.add(id)
  return flagged
}
