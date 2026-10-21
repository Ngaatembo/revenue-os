-- Rollback for 20261021150000_connections_sync_and_communications.sql.
-- WARNING: drops public.communications. Every synchronized email record is deleted. Run only if the release is abandoned.
-- Gmail connections and any in-flight Gmail OAuth states are removed because the old schema cannot represent them.
-- Run 20261021160000's rollback first. Run inside a transaction (psql -1).
DROP VIEW IF EXISTS public.conversation_threads;
DROP TABLE IF EXISTS public.communications;
DROP FUNCTION IF EXISTS public.list_connection_status(text);
DROP FUNCTION IF EXISTS public.claim_connection_sync(text, text, boolean);

DELETE FROM public.provider_oauth_states WHERE provider <> 'google_sheets';
DELETE FROM public.provider_connections WHERE provider <> 'google_sheets';
UPDATE public.provider_connections SET status = 'error' WHERE status IN ('syncing', 'needs_attention');

DROP INDEX IF EXISTS public.provider_connections_due_idx;
ALTER TABLE public.provider_connections
  DROP CONSTRAINT IF EXISTS provider_connections_provider_check,
  DROP CONSTRAINT IF EXISTS provider_connections_status_check,
  DROP CONSTRAINT IF EXISTS provider_connections_error_len,
  DROP CONSTRAINT IF EXISTS provider_connections_token_required,
  DROP COLUMN IF EXISTS sync_stage, DROP COLUMN IF EXISTS sync_started_at, DROP COLUMN IF EXISTS sync_cursor,
  DROP COLUMN IF EXISTS next_sync_at, DROP COLUMN IF EXISTS consecutive_failures, DROP COLUMN IF EXISTS records_synced,
  DROP COLUMN IF EXISTS initial_sync_completed_at;
ALTER TABLE public.provider_connections
  ADD CONSTRAINT provider_connections_check CHECK (((status = 'connected' AND encrypted_refresh_token IS NOT NULL) OR status <> 'connected')),
  ADD CONSTRAINT provider_connections_last_error_code_check CHECK (last_error_code IS NULL OR length(last_error_code) <= 80),
  ADD CONSTRAINT provider_connections_provider_check CHECK (provider = 'google_sheets'),
  ADD CONSTRAINT provider_connections_status_check CHECK (status = ANY (ARRAY['pending', 'connected', 'error', 'disconnected']));

ALTER TABLE public.provider_oauth_states DROP CONSTRAINT IF EXISTS provider_oauth_states_provider_check;
ALTER TABLE public.provider_oauth_states ADD CONSTRAINT provider_oauth_states_provider_check CHECK (provider IN ('google_sheets'));

CREATE OR REPLACE FUNCTION public.consume_provider_oauth_state(p_state_hash text)
RETURNS TABLE (provider text, organization_id text, user_id text)
LANGUAGE sql SECURITY DEFINER SET search_path = ''
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
