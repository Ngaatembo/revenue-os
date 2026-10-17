-- Server-side, idempotent detection of overdue-invoice opportunities.
--
-- Until now opportunities were computed in the browser and only written to the database as a
-- side effect of drafting a reminder. This migration adds:
--   1. opportunities.detection_rule / detection_reason: why the opportunity exists, stored with it.
--   2. public.sync_overdue_opportunities(p_org_id): upserts one opportunity per overdue, unpaid
--      invoice in the caller's workspace, links the source invoice as evidence, and closes
--      open opportunities whose invoice is now fully paid or no longer overdue.
--
-- Rules (single source of truth, mirrored by src/domain/overdueInvoices.ts):
--   * create/refresh: invoice due at least 1 day ago AND total_minor > paid_minor.
--   * estimate = outstanding * recovery_rate_bps, rounded half-up (same as propose_invoice_reminder).
--   * estimates are NEVER money collected; verified revenue only comes from public.outcomes.
--   * an opportunity that already has an action keeps its recorded outstanding/estimate snapshot,
--     because verify_recovery_outcome uses opportunities.outstanding_minor as the proposal-time cap.
--   * dismissed/closed opportunities are never reopened; running the sync twice changes nothing.
-- Runs as the caller (role + membership checked) and does not weaken any RLS policy.

ALTER TABLE public.opportunities
  ADD COLUMN IF NOT EXISTS detection_rule text,
  ADD COLUMN IF NOT EXISTS detection_reason text;

CREATE OR REPLACE FUNCTION public.sync_overdue_opportunities(p_org_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_assumption public.assumptions%ROWTYPE;
  v_created integer := 0;
  v_refreshed integer := 0;
  v_closed integer := 0;
  v_open integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000'; END IF;
  IF NOT private.has_org_role(p_org_id, ARRAY['owner','admin','operator']) THEN
    RAISE EXCEPTION 'Workspace permission denied' USING ERRCODE = '42501';
  END IF;

  SELECT a.* INTO v_assumption
    FROM public.assumptions a
   WHERE a.organization_id = p_org_id AND a.id = 'recovery-rate';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Set and save a recovery-rate assumption before detecting opportunities' USING ERRCODE = '22023';
  END IF;

  -- Serialize concurrent syncs for one workspace so repeated processing cannot race.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('sync_overdue_opportunities:' || p_org_id, 0));

  WITH candidates AS (
    SELECT i.id AS invoice_id,
           i.currency,
           (i.total_minor - i.paid_minor) AS outstanding,
           pg_catalog.floor((((i.total_minor - i.paid_minor)::numeric * v_assumption.value_bps) + 5000) / 10000)::bigint AS estimate,
           pg_catalog.format(
             'Invoice %s was due on %s and is %s day(s) past due. %s %s of %s %s is unpaid.',
             pg_catalog.regexp_replace(i.invoice_number, '[[:cntrl:]]+', ' ', 'g'),
             pg_catalog.to_char(i.due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
             pg_catalog.floor(pg_catalog.date_part('epoch', pg_catalog.now() - i.due_at) / 86400)::integer,
             i.currency,
             pg_catalog.to_char((i.total_minor - i.paid_minor) / 100.0, 'FM999999999999990.00'),
             i.currency,
             pg_catalog.to_char(i.total_minor / 100.0, 'FM999999999999990.00')
           ) AS reason
      FROM public.invoices i
     WHERE i.organization_id = p_org_id
       AND i.total_minor > i.paid_minor
       AND i.due_at <= pg_catalog.now() - interval '1 day'
  ), upserted AS (
    INSERT INTO public.opportunities AS o (
      organization_id, id, kind, status, currency, outstanding_minor,
      estimate_low_minor, estimate_high_minor, assumption_id, detected_at,
      detection_rule, detection_reason
    )
    SELECT p_org_id, 'overdue_invoice:' || c.invoice_id, 'overdue_invoice', 'open', c.currency, c.outstanding,
           c.estimate, c.estimate, v_assumption.id, pg_catalog.now(),
           'overdue_invoice_v1', c.reason
      FROM candidates c
    ON CONFLICT (organization_id, id) DO UPDATE SET
      -- amounts and reason are frozen once any action exists (proposal-time snapshot)
      currency = CASE WHEN EXISTS (SELECT 1 FROM public.actions x WHERE x.organization_id = o.organization_id AND x.opportunity_id = o.id)
                      THEN o.currency ELSE EXCLUDED.currency END,
      outstanding_minor = CASE WHEN EXISTS (SELECT 1 FROM public.actions x WHERE x.organization_id = o.organization_id AND x.opportunity_id = o.id)
                               THEN o.outstanding_minor ELSE EXCLUDED.outstanding_minor END,
      estimate_low_minor = CASE WHEN EXISTS (SELECT 1 FROM public.actions x WHERE x.organization_id = o.organization_id AND x.opportunity_id = o.id)
                                THEN o.estimate_low_minor ELSE EXCLUDED.estimate_low_minor END,
      estimate_high_minor = CASE WHEN EXISTS (SELECT 1 FROM public.actions x WHERE x.organization_id = o.organization_id AND x.opportunity_id = o.id)
                                 THEN o.estimate_high_minor ELSE EXCLUDED.estimate_high_minor END,
      assumption_id = CASE WHEN EXISTS (SELECT 1 FROM public.actions x WHERE x.organization_id = o.organization_id AND x.opportunity_id = o.id)
                           THEN o.assumption_id ELSE EXCLUDED.assumption_id END,
      detection_reason = CASE WHEN EXISTS (SELECT 1 FROM public.actions x WHERE x.organization_id = o.organization_id AND x.opportunity_id = o.id)
                              THEN COALESCE(o.detection_reason, EXCLUDED.detection_reason) ELSE EXCLUDED.detection_reason END,
      detection_rule = COALESCE(o.detection_rule, EXCLUDED.detection_rule)
      -- status and detected_at are deliberately untouched: no reopening, first detection time kept
    RETURNING (xmax = 0) AS inserted
  )
  SELECT COALESCE(pg_catalog.count(*) FILTER (WHERE inserted), 0),
         COALESCE(pg_catalog.count(*) FILTER (WHERE NOT inserted), 0)
    INTO v_created, v_refreshed
    FROM upserted;

  INSERT INTO public.opportunity_evidence (organization_id, opportunity_id, invoice_id)
  SELECT p_org_id, 'overdue_invoice:' || i.id, i.id
    FROM public.invoices i
   WHERE i.organization_id = p_org_id
     AND i.total_minor > i.paid_minor
     AND i.due_at <= pg_catalog.now() - interval '1 day'
  ON CONFLICT DO NOTHING;

  -- Close (never delete) open opportunities whose invoice is now paid in full or not overdue.
  WITH closing AS (
    UPDATE public.opportunities o
       SET status = 'closed'
     WHERE o.organization_id = p_org_id
       AND o.kind = 'overdue_invoice'
       AND o.status = 'open'
       AND NOT EXISTS (
         SELECT 1
           FROM public.opportunity_evidence e
           JOIN public.invoices i ON i.organization_id = e.organization_id AND i.id = e.invoice_id
          WHERE e.organization_id = o.organization_id
            AND e.opportunity_id = o.id
            AND i.total_minor > i.paid_minor
            AND i.due_at < pg_catalog.now()
       )
    RETURNING 1
  )
  SELECT pg_catalog.count(*) INTO v_closed FROM closing;

  SELECT pg_catalog.count(*) INTO v_open
    FROM public.opportunities o
   WHERE o.organization_id = p_org_id AND o.kind = 'overdue_invoice' AND o.status = 'open';

  RETURN pg_catalog.jsonb_build_object(
    'created', v_created, 'refreshed', v_refreshed, 'closed', v_closed, 'open', v_open,
    'recovery_rate_bps', v_assumption.value_bps
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.sync_overdue_opportunities(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_overdue_opportunities(text) TO authenticated;
