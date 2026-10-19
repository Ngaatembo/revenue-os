-- One-time OAuth state records. Values are hashes only; the raw browser state is never persisted.
-- Service-role only. Consumption is atomic to prevent callback replay races.
CREATE TABLE IF NOT EXISTS public.provider_oauth_states (
  state_hash text PRIMARY KEY CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  provider text NOT NULL CHECK (provider IN ('google_sheets')),
  organization_id text NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > created_at),
  FOREIGN KEY (organization_id, user_id)
    REFERENCES public.memberships(organization_id, user_id) ON DELETE CASCADE
);

ALTER TABLE public.provider_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_oauth_states FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.provider_oauth_states FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.provider_oauth_states TO service_role;

CREATE INDEX IF NOT EXISTS provider_oauth_states_expiry_idx
  ON public.provider_oauth_states (expires_at);

CREATE OR REPLACE FUNCTION public.consume_provider_oauth_state(p_state_hash text)
RETURNS TABLE (provider text, organization_id text, user_id text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $function$
  UPDATE public.provider_oauth_states AS s
     SET consumed_at = now()
   WHERE s.state_hash = p_state_hash
     AND s.provider = 'google_sheets'
     AND s.consumed_at IS NULL
     AND s.expires_at > now()
  RETURNING s.provider, s.organization_id, s.user_id;
$function$;

REVOKE ALL ON FUNCTION public.consume_provider_oauth_state(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_provider_oauth_state(text) TO service_role;
