-- Scheduled (background) evaluation of every workspace, with an observable run log.
-- Requires 20261019200000 (it re-runs the same public.sync_overdue_opportunities logic).
--
-- What this does: once a day the database re-runs overdue-invoice detection for each workspace that has a
-- recovery-rate assumption, so opportunities are closed when paid and new overdue invoices appear even if
-- nobody opens the app. Every run is recorded in public.evaluation_runs.
-- What it does NOT do: send email, push or any message. Alerts and the daily brief are computed from the
-- saved records when a person opens the app.

CREATE TABLE IF NOT EXISTS public.evaluation_runs (
  organization_id text NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  id text NOT NULL,
  trigger_kind text NOT NULL CHECK (trigger_kind IN ('schedule', 'manual')),
  status text NOT NULL CHECK (status IN ('ok', 'skipped', 'failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz NOT NULL DEFAULT now(),
  created_count integer NOT NULL DEFAULT 0,
  refreshed_count integer NOT NULL DEFAULT 0,
  closed_count integer NOT NULL DEFAULT 0,
  open_count integer NOT NULL DEFAULT 0,
  message text CHECK (message IS NULL OR length(message) <= 500),
  PRIMARY KEY (organization_id, id)
);
CREATE INDEX IF NOT EXISTS evaluation_runs_recent_idx ON public.evaluation_runs (organization_id, started_at DESC);

ALTER TABLE public.evaluation_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS evaluation_runs_member_read ON public.evaluation_runs;
CREATE POLICY evaluation_runs_member_read ON public.evaluation_runs
  FOR SELECT TO authenticated USING (private.is_org_member(organization_id));
REVOKE ALL ON public.evaluation_runs FROM anon, authenticated;
GRANT SELECT ON public.evaluation_runs TO authenticated;

DROP TRIGGER IF EXISTS evaluation_runs_immutable ON public.evaluation_runs;
CREATE TRIGGER evaluation_runs_immutable BEFORE UPDATE OR DELETE ON public.evaluation_runs
FOR EACH ROW EXECUTE FUNCTION public.prevent_immutable_record_mutation();

-- Evaluates one workspace as its oldest owner (so the same role and membership checks apply as for a person)
-- and records the outcome. A failure is recorded and never aborts other workspaces.
CREATE OR REPLACE FUNCTION private.run_org_evaluation(p_org_id text, p_trigger text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  v_subject text; v_result jsonb; v_started timestamptz := pg_catalog.clock_timestamp();
BEGIN
  SELECT u.auth_subject INTO v_subject
    FROM public.memberships m JOIN public.users u ON u.id = m.user_id
   WHERE m.organization_id = p_org_id AND m.role = 'owner'
   ORDER BY m.created_at, m.user_id LIMIT 1;
  IF v_subject IS NULL THEN
    INSERT INTO public.evaluation_runs (organization_id, id, trigger_kind, status, started_at, message)
    VALUES (p_org_id, 'run_' || pg_catalog.gen_random_uuid()::text, p_trigger, 'skipped', v_started, 'Workspace has no owner to evaluate as');
    RETURN 'skipped';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.assumptions a WHERE a.organization_id = p_org_id AND a.id = 'recovery-rate') THEN
    INSERT INTO public.evaluation_runs (organization_id, id, trigger_kind, status, started_at, message)
    VALUES (p_org_id, 'run_' || pg_catalog.gen_random_uuid()::text, p_trigger, 'skipped', v_started, 'No recovery-rate assumption is set');
    RETURN 'skipped';
  END IF;
  BEGIN
    PERFORM pg_catalog.set_config('request.jwt.claim.sub', v_subject, true);
    PERFORM pg_catalog.set_config('request.jwt.claims', pg_catalog.jsonb_build_object('sub', v_subject, 'role', 'authenticated')::text, true);
    v_result := public.sync_overdue_opportunities(p_org_id);
    INSERT INTO public.evaluation_runs (organization_id, id, trigger_kind, status, started_at, created_count, refreshed_count, closed_count, open_count)
    VALUES (p_org_id, 'run_' || pg_catalog.gen_random_uuid()::text, p_trigger, 'ok', v_started,
            COALESCE((v_result->>'created')::integer, 0), COALESCE((v_result->>'refreshed')::integer, 0),
            COALESCE((v_result->>'closed')::integer, 0), COALESCE((v_result->>'open')::integer, 0));
    RETURN 'ok';
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public.evaluation_runs (organization_id, id, trigger_kind, status, started_at, message)
    VALUES (p_org_id, 'run_' || pg_catalog.gen_random_uuid()::text, p_trigger, 'failed', v_started, pg_catalog.left(SQLSTATE || ' ' || SQLERRM, 500));
    RETURN 'failed';
  END;
END;
$function$;
REVOKE ALL ON FUNCTION private.run_org_evaluation(text, text) FROM PUBLIC, anon, authenticated;

-- Entry point for the scheduler. Not callable by signed-in users or anonymous visitors.
CREATE OR REPLACE FUNCTION public.run_scheduled_evaluation() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  v_org text; v_outcome text; v_ok integer := 0; v_skipped integer := 0; v_failed integer := 0;
BEGIN
  FOR v_org IN SELECT o.id FROM public.organizations o ORDER BY o.id LOOP
    v_outcome := private.run_org_evaluation(v_org, 'schedule');
    IF v_outcome = 'ok' THEN v_ok := v_ok + 1; ELSIF v_outcome = 'skipped' THEN v_skipped := v_skipped + 1; ELSE v_failed := v_failed + 1; END IF;
  END LOOP;
  RETURN pg_catalog.jsonb_build_object('ok', v_ok, 'skipped', v_skipped, 'failed', v_failed);
END;
$function$;
REVOKE ALL ON FUNCTION public.run_scheduled_evaluation() FROM PUBLIC, anon, authenticated;

-- Schedule it daily at 05:30 UTC when pg_cron is available (hosted Supabase). Skipped, with a notice, where
-- the extension is not installed (for example the disposable test database). Re-running is safe.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_available_extensions WHERE name = 'pg_cron') THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'revenue-os-daily-evaluation';
    PERFORM cron.schedule('revenue-os-daily-evaluation', '30 5 * * *', 'select public.run_scheduled_evaluation()');
  ELSE
    RAISE NOTICE 'pg_cron is not available here; the daily evaluation is not scheduled.';
  END IF;
END
$do$;
