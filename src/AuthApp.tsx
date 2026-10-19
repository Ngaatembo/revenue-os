import { useEffect, useState, type FormEvent } from 'react'
import RevenueWorkspace from './App'
import {
  bootstrapOrganization,
  clearStoredSession,
  isSupabaseConfigured,
  readStoredSession,
  signIn,
  signInWithGoogle,
  consumeOAuthCallback,
  signOut,
  signUp,
  type RevenueOrganization,
  type SupabaseSession,
} from './lib/supabaseRest'
import './auth.css'

export default function AuthApp() {
  const [session, setSession] = useState<SupabaseSession | null>(null)
  const [organization, setOrganization] = useState<RevenueOrganization | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fullName, setFullName] = useState('')
  const [organizationName, setOrganizationName] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  async function enterWorkspace(activeSession: SupabaseSession, requestedName: string) {
    const workspace = await bootstrapOrganization(activeSession, requestedName || 'My Revenue OS workspace')
    setSession(activeSession)
    setOrganization(workspace)
    setOrganizationName(workspace.name)
  }

  useEffect(() => {
    let cancelled = false
    async function restore() {
      try {
        // Handle Google returning from Supabase before falling back to an existing session.
        const oauthSession = await consumeOAuthCallback()
        const saved = oauthSession ?? readStoredSession()
        if (!saved) return
        const workspace = await bootstrapOrganization(saved, 'My Revenue OS workspace')
        if (!cancelled) {
          setSession(saved)
          setOrganization(workspace)
          setOrganizationName(workspace.name)
        }
      } catch (cause) {
        clearStoredSession()
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'Could not complete sign-in. Please try again.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void restore()
    return () => { cancelled = true }
  }, [])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    setMessage('')
    try {
      if (mode === 'signup') {
        const result = await signUp(email, password, fullName)
        if (result.confirmationRequired || !result.session) {
          setMode('signin')
          setMessage('Account created. Check your email for the confirmation link, then sign in here.')
          return
        }
        await enterWorkspace(result.session, organizationName)
        return
      }
      const activeSession = await signIn(email, password)
      await enterWorkspace(activeSession, organizationName)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  async function handleSignOut() {
    try { if (session) await signOut(session) } catch { clearStoredSession() }
    setSession(null)
    setOrganization(null)
    setPassword('')
    setMessage('')
    setError('')
  }

  if (loading) return <main className="auth-page"><div className="auth-card"><div className="auth-brand"><img src="/revenue-os-mark.svg" alt="" /><span>Revenue<span> OS</span></span></div><h1>Opening your workspace</h1><p>Checking your Revenue OS session securely.</p></div></main>

  if (!isSupabaseConfigured()) return <main className="auth-page"><div className="auth-card"><div className="auth-brand"><img src="/revenue-os-mark.svg" alt="" /><span>Revenue<span> OS</span></span></div><p className="auth-eyebrow">REVENUE OPERATIONS</p><h1>Connect your workspace</h1><p>Supabase is ready, but the frontend still needs its public project URL and publishable key at build time.</p><div className="auth-setup"><strong>Required environment variables</strong><code>VITE_SUPABASE_URL</code><code>VITE_SUPABASE_ANON_KEY</code><small>Use the project's publishable/anon key only. Never add a service-role key to frontend variables.</small></div><a href="https://supabase.com/dashboard/project/zivgfvcmposnbwqsudas/settings/api" target="_blank" rel="noreferrer">Open Revenue OS API settings ↗</a></div></main>

  if (session && organization) return <RevenueWorkspace session={session} organization={organization} onSignOut={() => void handleSignOut()} />

  return <main className="auth-page">
    <section className="auth-card">
      <div className="auth-brand"><img src="/revenue-os-mark.svg" alt="" /><span>Revenue<span> OS</span></span></div>
      <p className="auth-eyebrow">REVENUE OPERATIONS</p>
      <h1>{mode === 'signin' ? 'Welcome back' : 'Create your workspace'}</h1>
      <p className="auth-intro">Find overdue money, prioritize follow-ups, and track the outcomes that matter.</p>
      <div className="auth-mode" role="tablist" aria-label="Account access">
        <button type="button" role="tab" aria-selected={mode === 'signin'} className={mode === 'signin' ? 'active' : ''} onClick={() => { setMode('signin'); setMessage(''); setError('') }}>Sign in</button>
        <button type="button" role="tab" aria-selected={mode === 'signup'} className={mode === 'signup' ? 'active' : ''} onClick={() => { setMode('signup'); setMessage(''); setError('') }}>Create account</button>
      </div>
      <button
        className="auth-google"
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          setError('')
          setMessage('')
          try {
            signInWithGoogle()
          } catch (cause) {
            setBusy(false)
            setError(cause instanceof Error ? cause.message : 'Google sign-in could not start. Please try again.')
          }
        }}
      >
        <svg aria-hidden="true" viewBox="0 0 48 48" className="auth-google-icon">
          <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5Z"/>
          <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.74 7.18l7.66 5.95c4.48-4.14 7.12-10.24 7.12-17.6Z"/>
          <path fill="#FBBC05" d="M10.53 28.59A14.4 14.4 0 0 1 9.75 24c0-1.59.27-3.13.76-4.59l-7.98-6.19A23.9 23.9 0 0 0 0 24c0 3.87.93 7.52 2.56 10.78l7.97-6.19Z"/>
          <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.9-5.85l-7.66-5.95c-2.13 1.43-4.86 2.28-8.24 2.28-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48Z"/>
        </svg>
        Continue with Google
      </button>
      <div className="auth-divider" aria-hidden="true"><span>or continue with email</span></div>
      <form className="auth-form" onSubmit={(event) => void handleSubmit(event)}>
        {mode === 'signup' && <label>Full name<input autoComplete="name" value={fullName} onChange={(event) => setFullName(event.target.value)} required maxLength={120} /></label>}
        <label>Email address<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required maxLength={254} /></label>
        <label>Password<input type="password" autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} value={password} onChange={(event) => setPassword(event.target.value)} required minLength={8} maxLength={128} /></label>
        <label>Business / workspace name<input autoComplete="organization" value={organizationName} onChange={(event) => setOrganizationName(event.target.value)} required maxLength={160} placeholder="e.g. WebAura" /></label>
        {error && <p className="auth-message error" role="alert">{error}</p>}
        {message && <p className="auth-message success" role="status">{message}</p>}
        <button className="auth-submit" type="submit" disabled={busy}>{busy ? 'Please wait…' : mode === 'signin' ? 'Sign in to Revenue OS' : 'Create account'}</button>
      </form>
      <p className="auth-footnote">Your business records are scoped to your workspace. Do not upload client financial data until you have confirmed access and account security.</p>
    </section>
  </main>
}
