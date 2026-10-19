import { isSupabaseConfigured } from './supabaseRest'

const supabaseUrl = ((import.meta.env.VITE_SUPABASE_URL as string | undefined) || 'https://zivgfvcmposnbwqsudas.supabase.co').replace(/\/$/, '')
const publishableKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) || 'sb_publishable_twQnXi5Mwmy5_dWIcay0OQ_8-xjyP3h'

/** Send a passwordless sign-in link. The existing OAuth callback consumes Supabase's token hash. */
export async function sendEmailSignInLink(email: string): Promise<void> {
  if (!isSupabaseConfigured()) throw new Error('Email sign-in is not configured yet. Please try again later.')
  const response = await fetch(`${supabaseUrl}/auth/v1/otp`, {
    method: 'POST',
    headers: { apikey: publishableKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email.trim(), create_user: true, gotrue_meta_security: {}, redirect_to: window.location.origin }),
  })
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null
  if (!response.ok) {
    const message = payload && (payload.msg ?? payload.message ?? payload.error_description ?? payload.error)
    throw new Error(typeof message === 'string' && message.trim() ? message : 'Could not send your sign-in link. Check the email address and try again.')
  }
}
