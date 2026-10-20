-- Persist the selected Google Sheets source per workspace so sync setup survives sessions.
CREATE TABLE IF NOT EXISTS public.provider_source_selections (
  organization_id text NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider text NOT NULL,
  source_id text NOT NULL,
  source_name text NOT NULL,
  source_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, provider)
);

ALTER TABLE public.provider_source_selections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.provider_source_selections FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.provider_source_selections TO service_role;

COMMENT ON TABLE public.provider_source_selections IS
  'Server-managed selected source configuration for integrations; accessed only through authenticated Worker routes.';
