-- Connections foundation: provider-neutral sync state, Gmail provider, and normalised customer communications.
-- Tokens remain server-only (provider_connections has no client grants). Browsers read sync state
-- only through list_connection_status(), which never returns credentials.

-- 1. Allow more providers and richer sync states on provider_connections / provider_oauth_states.
-- Only the table-level constraints this release replaces are dropped (by name: the four that exist in production plus the
-- four this migration creates, so re-applying is safe). Column-level checks added below are never touched.
ALTER TABLE public.provider_connections
  DROP CONSTRAINT IF EXISTS provider_connections_check,
  DROP CONSTRAINT IF EXISTS provider_connections_last_error_code_check,
  DROP CONSTRAINT IF EXISTS provider_connections_provider_check,
  DROP CONSTRAINT IF EXISTS provider_connections_status_check,
  DROP CONSTRAINT IF EXISTS provider_connections_error_len,
  DROP CONSTRAINT IF EXISTS provider_connections_token_required;
ALTER TABLE public.provider_oauth_states DROP CONSTRAINT IF EXISTS provider_oauth_states_provider_check;

ALTER TABLE public.provider_connections
  ADD CONSTRAINT provider_connections_provider_check CHECK (provider IN ('google_sheets', 'gmail')),
  ADD CONSTRAINT provider_connections_status_check CHECK (status IN ('pending', 'connected', 'syncing', 'needs_attention', 'error', 'disconnected')),
  ADD CONSTRAINT provider_connections_error_len CHECK (last_error_code IS NULL OR length(last_error_code) <= 80),
  ADD CONSTRAINT provider_connections_token_required CHECK (
    status NOT IN ('connected', 'syncing', 'needs_attention') OR encrypted_refresh_token IS NOT NULL);

ALTER TABLE public.provider_connections
  ADD COLUMN IF NOT EXISTS sync_stage text CHECK (sync_stage IS NULL OR sync_stage IN
    ('connecting', 'fetching', 'processing', 'insights', 'complete', 'waiting_rate_limit', 'failed')),
  ADD COLUMN IF NOT EXISTS sync_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS sync_cursor text CHECK (sync_cursor IS NULL OR length(sync_cursor) <= 4000),
  ADD COLUMN IF NOT EXISTS next_sync_at timestamptz,
  ADD COLUMN IF NOT EXISTS consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  ADD COLUMN IF NOT EXISTS records_synced bigint NOT NULL DEFAULT 0 CHECK (records_synced >= 0),
  ADD COLUMN IF NOT EXISTS initial_sync_completed_at timestamptz;

ALTER TABLE public.provider_oauth_states
  ADD CONSTRAINT provider_oauth_states_provider_check CHECK (provider IN ('google_sheets', 'gmail'));

CREATE INDEX IF NOT EXISTS provider_connections_due_idx
  ON public.provider_connections (next_sync_at) WHERE status IN ('connected', 'needs_attention', 'syncing');

-- The state row now carries whichever provider started the flow; the caller verifies it.
CREATE OR REPLACE FUNCTION public.consume_provider_oauth_state(p_state_hash text)
RETURNS TABLE (provider text, organization_id text, user_id text)
LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $function$
  UPDATE public.provider_oauth_states AS s
     SET consumed_at = now()
   WHERE s.state_hash = p_state_hash
     AND s.consumed_at IS NULL
     AND s.expires_at > now()
  RETURNING s.provider, s.organization_id, s.user_id;
$function$;
REVOKE ALL ON FUNCTION public.consume_provider_oauth_state(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_provider_oauth_state(text) TO service_role;

-- 2. Claim a due connection for syncing. Atomic, so two workers never sync the same connection.
CREATE OR REPLACE FUNCTION public.claim_connection_sync(p_organization_id text, p_provider text, p_force boolean DEFAULT false)
RETURNS TABLE (status text, sync_cursor text, encrypted_refresh_token text, provider_account_email text,
               consecutive_failures integer, initial_sync_completed_at timestamptz, records_synced bigint)
LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $function$
  UPDATE public.provider_connections AS c
     SET status = 'syncing', sync_started_at = now(), sync_stage = 'connecting', updated_at = now()
   WHERE c.organization_id = p_organization_id AND c.provider = p_provider
     AND c.status IN ('connected', 'needs_attention', 'syncing')
     AND c.encrypted_refresh_token IS NOT NULL
     AND (c.sync_started_at IS NULL OR c.sync_started_at < now() - interval '10 minutes' OR c.status <> 'syncing')
     -- "Sync now" may skip the normal schedule but never a provider-requested rate-limit pause.
     AND ((p_force AND c.sync_stage IS DISTINCT FROM 'waiting_rate_limit') OR c.next_sync_at IS NULL OR c.next_sync_at <= now())
  RETURNING c.status, c.sync_cursor, c.encrypted_refresh_token, c.provider_account_email,
            c.consecutive_failures, c.initial_sync_completed_at, c.records_synced;
$function$;
REVOKE ALL ON FUNCTION public.claim_connection_sync(text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_connection_sync(text, text, boolean) TO service_role;

-- 3. Browser-safe connection status for any workspace member. No credentials.
CREATE OR REPLACE FUNCTION public.list_connection_status(p_organization_id text)
RETURNS TABLE (provider text, status text, provider_account_email text, sync_stage text, sync_started_at timestamptz,
               last_successful_sync_at timestamptz, initial_sync_completed_at timestamptz, next_sync_at timestamptz,
               last_error_code text, consecutive_failures integer, records_synced bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000'; END IF;
  IF NOT private.is_org_member(p_organization_id) THEN RAISE EXCEPTION 'Workspace permission denied' USING ERRCODE = '42501'; END IF;
  RETURN QUERY
  SELECT c.provider, c.status, c.provider_account_email, c.sync_stage, c.sync_started_at, c.last_successful_sync_at,
         c.initial_sync_completed_at, c.next_sync_at, c.last_error_code, c.consecutive_failures, c.records_synced
    FROM public.provider_connections c WHERE c.organization_id = p_organization_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.list_connection_status(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_connection_status(text) TO authenticated, service_role;

-- 4. Normalised customer communications. Metadata only: no message bodies are stored.
CREATE TABLE IF NOT EXISTS public.communications (
  organization_id text NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('gmail')),
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
  thread_id text NOT NULL CHECK (length(thread_id) BETWEEN 1 AND 200),
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  counterpart_address text CHECK (counterpart_address IS NULL OR length(counterpart_address) <= 320),
  counterpart_name text CHECK (counterpart_name IS NULL OR length(counterpart_name) <= 200),
  subject text CHECK (subject IS NULL OR length(subject) <= 300),
  snippet text CHECK (snippet IS NULL OR length(snippet) <= 200),
  occurred_at timestamptz NOT NULL,
  is_automated boolean NOT NULL DEFAULT false,
  source_account text CHECK (source_account IS NULL OR length(source_account) <= 320),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, provider, external_id)
);
CREATE INDEX IF NOT EXISTS communications_thread_idx ON public.communications (organization_id, thread_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS communications_recent_idx ON public.communications (organization_id, occurred_at DESC);

ALTER TABLE public.communications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.communications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS communications_member_read ON public.communications;
CREATE POLICY communications_member_read ON public.communications FOR SELECT TO authenticated
  USING (private.is_org_member(organization_id));
REVOKE ALL ON public.communications FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.communications TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.communications TO service_role;

-- 5. One row per conversation: what we observed (last message, who sent it) and nothing inferred.
-- Inference ("waiting on you") is derived by the app from these facts and is labelled as such.
CREATE OR REPLACE VIEW public.conversation_threads WITH (security_invoker = true) AS
SELECT c.organization_id, c.provider, c.thread_id, c.source_account,
       count(*)::integer AS message_count,
       max(c.occurred_at) AS last_message_at,
       (array_agg(c.direction ORDER BY c.occurred_at DESC))[1] AS last_direction,
       max(c.occurred_at) FILTER (WHERE c.direction = 'inbound') AS last_inbound_at,
       max(c.occurred_at) FILTER (WHERE c.direction = 'outbound') AS last_outbound_at,
       (array_agg(c.counterpart_address ORDER BY c.occurred_at DESC))[1] AS counterpart_address,
       (array_agg(c.counterpart_name ORDER BY c.occurred_at DESC) FILTER (WHERE c.counterpart_name IS NOT NULL))[1] AS counterpart_name,
       (array_agg(c.subject ORDER BY c.occurred_at DESC) FILTER (WHERE c.subject IS NOT NULL))[1] AS subject,
       (array_agg(c.snippet ORDER BY c.occurred_at DESC) FILTER (WHERE c.snippet IS NOT NULL))[1] AS last_snippet,
       bool_and(c.is_automated) AS all_automated
  FROM public.communications c
 GROUP BY c.organization_id, c.provider, c.thread_id, c.source_account;
REVOKE ALL ON public.conversation_threads FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.conversation_threads TO authenticated, service_role;
