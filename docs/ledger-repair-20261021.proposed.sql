-- PROPOSED ledger repair for the hosted project zivgfvcmposnbwqsudas. NOT EXECUTED. Needs the owner's explicit approval.
--
-- What it does: records three already-applied migrations in supabase_migrations.schema_migrations so the ledger matches the
-- schema. It runs no schema change. It does NOT record 20261021170000 (WhatsApp): that migration is intentionally not applied.
--
-- Evidence it is safe (read-only comparison, 2026-10-21): every table, column, index, policy, RLS flag, grant and function
-- these three files define exists live. Column lists and table/function grants hash identically to a scratch database built
-- from the repo files. Function bodies are identical once whitespace is normalised (the live copies carry extra indentation
-- from being pasted into the SQL editor). See docs/ledger-reconciliation-2026-10-21.md.
--
-- Risks: (1) the recorded `statements` are the repo files, not the exact text that was run (whitespace differs); (2) if a
-- later edit to a file changes its meaning, the ledger will not show that; (3) `supabase db push` will treat these versions as
-- applied. The block aborts, changing nothing, if any version is already recorded or any expected object is missing.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version IN ('20261021150000','20261021160000','20261021180000')) THEN
    RAISE EXCEPTION 'ledger already contains one of these versions; nothing changed';
  END IF;
  IF to_regclass('public.communications') IS NULL OR to_regclass('public.conversation_tracking') IS NULL OR to_regclass('public.muted_senders') IS NULL
     OR to_regclass('public.conversation_threads') IS NULL THEN
    RAISE EXCEPTION 'expected tables/views are missing; nothing changed';
  END IF;
  IF to_regclass('public.whatsapp_numbers') IS NOT NULL THEN
    RAISE EXCEPTION 'whatsapp_numbers exists, so 20261021170000 may have been applied; review before recording anything';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('consume_provider_oauth_state','claim_connection_sync','list_connection_status','persist_invoice_import_system','refresh_org_after_sync','set_conversation_tracking','mute_sender','unmute_sender')) <> 8 THEN
    RAISE EXCEPTION 'expected functions are missing; nothing changed';
  END IF;
END $$;

INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
VALUES ('20261021150000', 'connections_sync_and_communications', ARRAY[$ledger$
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
$ledger$]);

INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
VALUES ('20261021160000', 'sheets_automatic_sync', ARRAY[$ledger$
-- Service-side entry points that let the background sync runner import a spreadsheet and refresh
-- opportunities without a browser session. Both are service_role only.

-- Runs the existing, unchanged persist_invoice_import() as the workspace owner (the same attribution
-- model private.run_org_evaluation() already uses for the scheduled check). All validation, role checks,
-- content-hash de-duplication and upsert rules of the original function apply.
CREATE OR REPLACE FUNCTION public.persist_invoice_import_system(
  p_org_id text, p_source_id text, p_source_name text, p_content_hash text, p_rows jsonb, p_rejected_rows integer DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE v_subject text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  SELECT u.auth_subject INTO v_subject
    FROM public.memberships m JOIN public.users u ON u.id = m.user_id
   WHERE m.organization_id = p_org_id AND m.role = 'owner'
   ORDER BY m.created_at, m.user_id LIMIT 1;
  IF v_subject IS NULL THEN
    RAISE EXCEPTION 'Workspace has no owner to import as' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', v_subject, true);
  PERFORM pg_catalog.set_config('request.jwt.claims', pg_catalog.jsonb_build_object('sub', v_subject, 'role', 'authenticated')::text, true);
  RETURN public.persist_invoice_import(p_org_id, p_source_id, p_source_name, p_content_hash, p_rows, p_rejected_rows);
END;
$function$;
REVOKE ALL ON FUNCTION public.persist_invoice_import_system(text, text, text, text, jsonb, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.persist_invoice_import_system(text, text, text, text, jsonb, integer) TO service_role;

-- After new source data arrives, re-run the same workspace evaluation the daily job runs
-- (payment re-matching + overdue opportunity refresh) so Overview reflects the data without waiting for 05:30 UTC.
CREATE OR REPLACE FUNCTION public.refresh_org_after_sync(p_org_id text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  RETURN private.run_org_evaluation(p_org_id, 'schedule');
END;
$function$;
REVOKE ALL ON FUNCTION public.refresh_org_after_sync(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_org_after_sync(text) TO service_role;
$ledger$]);

INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
VALUES ('20261021180000', 'conversation_tracking', ARRAY[$ledger$
-- Follow-up tracking for customer conversations: mark handled, remind me later, a short note, and "not a customer" sender mutes.
-- Message content is never stored here. The only free text is the owner's own note (max 500 characters).
-- Browsers read these tables (members only) and change them only through the functions below, which check the caller's role.

CREATE TABLE IF NOT EXISTS public.conversation_tracking (
  organization_id text NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider ~ '^[a-z_]{2,40}$'),
  thread_id text NOT NULL CHECK (length(thread_id) BETWEEN 1 AND 200),
  status text NOT NULL CHECK (status IN ('open', 'handled', 'snoozed')),
  handled_at timestamptz,
  remind_at timestamptz,
  note text CHECK (note IS NULL OR length(note) <= 500),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, provider, thread_id),
  CHECK (status <> 'handled' OR handled_at IS NOT NULL),
  CHECK (status <> 'snoozed' OR remind_at IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS public.muted_senders (
  organization_id text NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  address text NOT NULL CHECK (length(address) BETWEEN 3 AND 320 AND address = lower(address) AND address ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, address)
);

ALTER TABLE public.conversation_tracking ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_tracking FORCE ROW LEVEL SECURITY;
ALTER TABLE public.muted_senders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.muted_senders FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS conversation_tracking_member_read ON public.conversation_tracking;
CREATE POLICY conversation_tracking_member_read ON public.conversation_tracking FOR SELECT TO authenticated USING (private.is_org_member(organization_id));
DROP POLICY IF EXISTS muted_senders_member_read ON public.muted_senders;
CREATE POLICY muted_senders_member_read ON public.muted_senders FOR SELECT TO authenticated USING (private.is_org_member(organization_id));
REVOKE ALL ON public.conversation_tracking, public.muted_senders FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.conversation_tracking, public.muted_senders TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.conversation_tracking, public.muted_senders TO service_role;

-- action: handled | snooze | reopen | note. A note may accompany any action; an empty note clears it.
CREATE OR REPLACE FUNCTION public.set_conversation_tracking(
  p_org_id text, p_provider text, p_thread_id text, p_action text, p_remind_at timestamptz DEFAULT NULL, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_actor text;
  v_note text;
  v_row public.conversation_tracking%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000'; END IF;
  IF NOT private.has_org_role(p_org_id, ARRAY['owner', 'admin', 'operator']) THEN
    RAISE EXCEPTION 'Workspace permission denied' USING ERRCODE = '42501';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('handled', 'snooze', 'reopen', 'note') THEN
    RAISE EXCEPTION 'Unsupported action' USING ERRCODE = '22023';
  END IF;
  IF p_action = 'snooze' AND (p_remind_at IS NULL OR p_remind_at <= now() OR p_remind_at > now() + interval '90 days') THEN
    RAISE EXCEPTION 'Choose a reminder time within the next 90 days' USING ERRCODE = '22023';
  END IF;
  v_note := nullif(btrim(coalesce(p_note, '')), '');
  IF v_note IS NOT NULL AND length(v_note) > 500 THEN
    RAISE EXCEPTION 'A note can be at most 500 characters' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.communications c WHERE c.organization_id = p_org_id AND c.provider = p_provider AND c.thread_id = p_thread_id) THEN
    RAISE EXCEPTION 'Conversation not found in this workspace' USING ERRCODE = '22023';
  END IF;
  SELECT u.id INTO v_actor FROM public.users u WHERE u.auth_subject = auth.uid() LIMIT 1;

  INSERT INTO public.conversation_tracking AS t (organization_id, provider, thread_id, status, handled_at, remind_at, note, updated_by, updated_at)
  VALUES (p_org_id, p_provider, p_thread_id,
          CASE p_action WHEN 'handled' THEN 'handled' WHEN 'snooze' THEN 'snoozed' ELSE 'open' END,
          CASE WHEN p_action = 'handled' THEN now() END,
          CASE WHEN p_action = 'snooze' THEN p_remind_at END,
          v_note, v_actor, now())
  ON CONFLICT (organization_id, provider, thread_id) DO UPDATE SET
    status = CASE p_action WHEN 'handled' THEN 'handled' WHEN 'snooze' THEN 'snoozed' WHEN 'reopen' THEN 'open' ELSE t.status END,
    handled_at = CASE p_action WHEN 'handled' THEN now() WHEN 'snooze' THEN NULL WHEN 'reopen' THEN NULL ELSE t.handled_at END,
    remind_at = CASE p_action WHEN 'snooze' THEN p_remind_at WHEN 'handled' THEN NULL WHEN 'reopen' THEN NULL ELSE t.remind_at END,
    note = CASE WHEN p_note IS NOT NULL OR p_action = 'note' THEN v_note ELSE t.note END,
    updated_by = v_actor, updated_at = now()
  RETURNING * INTO v_row;
  RETURN to_jsonb(v_row);
END;
$function$;
REVOKE ALL ON FUNCTION public.set_conversation_tracking(text, text, text, text, timestamptz, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_conversation_tracking(text, text, text, text, timestamptz, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.mute_sender(p_org_id text, p_address text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE v_actor text; v_address text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000'; END IF;
  IF NOT private.has_org_role(p_org_id, ARRAY['owner', 'admin', 'operator']) THEN
    RAISE EXCEPTION 'Workspace permission denied' USING ERRCODE = '42501';
  END IF;
  v_address := lower(btrim(coalesce(p_address, '')));
  IF length(v_address) NOT BETWEEN 3 AND 320 OR v_address !~ '^[^@[:space:]]+@[^@[:space:]]+$' THEN
    RAISE EXCEPTION 'A valid email address is required' USING ERRCODE = '22023';
  END IF;
  SELECT u.id INTO v_actor FROM public.users u WHERE u.auth_subject = auth.uid() LIMIT 1;
  INSERT INTO public.muted_senders (organization_id, address, created_by) VALUES (p_org_id, v_address, v_actor) ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('address', v_address, 'muted', true);
END;
$function$;
REVOKE ALL ON FUNCTION public.mute_sender(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mute_sender(text, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.unmute_sender(p_org_id text, p_address text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE v_address text; v_count integer;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000'; END IF;
  IF NOT private.has_org_role(p_org_id, ARRAY['owner', 'admin', 'operator']) THEN
    RAISE EXCEPTION 'Workspace permission denied' USING ERRCODE = '42501';
  END IF;
  v_address := lower(btrim(coalesce(p_address, '')));
  DELETE FROM public.muted_senders WHERE organization_id = p_org_id AND address = v_address;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN jsonb_build_object('address', v_address, 'muted', false, 'removed', v_count);
END;
$function$;
REVOKE ALL ON FUNCTION public.unmute_sender(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unmute_sender(text, text) TO authenticated, service_role;
$ledger$]);

-- Verify before COMMIT: should list exactly these three versions and nothing else from 20261021.
SELECT version, name FROM supabase_migrations.schema_migrations WHERE version >= '20261021' ORDER BY version;

COMMIT;
