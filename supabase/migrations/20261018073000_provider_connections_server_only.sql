-- Provider connection credentials are server-only. The browser must never query this table.
-- Cloudflare Worker uses a server-only Supabase credential after verifying the caller's
-- Supabase session and organization membership. Never expose that credential to the browser.

CREATE TABLE IF NOT EXISTS public.provider_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('google_sheets')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'connected', 'error', 'disconnected')),
  provider_account_email text,
  encrypted_refresh_token text,
  granted_scopes text[] NOT NULL DEFAULT ARRAY[]::text[],
  last_successful_sync_at timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR length(last_error_code) <= 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, provider),
  CHECK (
    (status = 'connected' AND encrypted_refresh_token IS NOT NULL)
    OR status <> 'connected'
  )
);

ALTER TABLE public.provider_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_connections FORCE ROW LEVEL SECURITY;

-- Intentionally define no policies for anon/authenticated users. Connector credentials
-- are accessible only through a server-side role, after application-level membership checks.
REVOKE ALL ON TABLE public.provider_connections FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.provider_connections TO service_role;

CREATE INDEX IF NOT EXISTS provider_connections_org_status_idx
  ON public.provider_connections (organization_id, status);
