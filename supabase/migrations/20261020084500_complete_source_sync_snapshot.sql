-- Atomically finalize a complete Google Sheets snapshot and reconcile membership.
-- Called only by the Worker with service_role after invoice persistence succeeds.
-- Partial snapshots are recorded as completed_with_errors but never reconcile missing rows.

CREATE OR REPLACE FUNCTION public.complete_source_sync_snapshot(
  p_organization_id text,
  p_run_id text,
  p_source_key text,
  p_source_range text,
  p_spreadsheet_id text,
  p_content_digest text,
  p_invoice_ids text[],
  p_accepted_rows integer,
  p_rejected_rows integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_seen integer := 0;
  v_missing integer := 0;
  v_status text;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;

  IF p_organization_id IS NULL OR length(trim(p_organization_id)) = 0
     OR p_run_id IS NULL OR length(trim(p_run_id)) = 0
     OR p_source_key IS NULL OR length(trim(p_source_key)) = 0
     OR p_source_range IS NULL OR length(trim(p_source_range)) NOT BETWEEN 1 AND 200
     OR p_spreadsheet_id IS NULL OR length(trim(p_spreadsheet_id)) NOT BETWEEN 10 AND 200
     OR p_content_digest IS NULL OR p_content_digest !~ '^[a-f0-9]{64}$'
     OR p_invoice_ids IS NULL OR p_accepted_rows IS NULL OR p_accepted_rows < 1
     OR p_rejected_rows IS NULL OR p_rejected_rows < 0
     OR p_accepted_rows > 50000 OR p_rejected_rows > 50000
     OR cardinality(p_invoice_ids) <> p_accepted_rows THEN
    RAISE EXCEPTION 'Invalid snapshot metadata' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (SELECT 1 FROM unnest(p_invoice_ids) AS ids(id) WHERE id IS NULL OR length(trim(id)) = 0)
     OR (SELECT count(DISTINCT id) FROM unnest(p_invoice_ids) AS ids(id)) <> cardinality(p_invoice_ids) THEN
    RAISE EXCEPTION 'Snapshot invoice IDs must be unique and non-empty' USING ERRCODE = '22023';
  END IF;

  -- Serialize finalization for this organization + exact source range.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_organization_id || ':' || p_source_key || ':' || p_source_range, 0
  ));

  IF NOT EXISTS (
    SELECT 1 FROM public.source_sync_runs r
    WHERE r.organization_id = p_organization_id AND r.id = p_run_id
      AND r.source_key = p_source_key AND r.source_range = p_source_range
      AND r.spreadsheet_id = p_spreadsheet_id AND r.status = 'started'
  ) THEN
    RAISE EXCEPTION 'Source sync run not found or already finalized' USING ERRCODE = '22023';
  END IF;

  -- Never reconcile an incomplete/partially rejected snapshot.
  IF p_rejected_rows > 0 THEN
    UPDATE public.source_sync_runs
       SET status = 'completed_with_errors', content_digest = p_content_digest,
           accepted_rows = p_accepted_rows, rejected_rows = p_rejected_rows,
           completed_at = pg_catalog.now()
     WHERE organization_id = p_organization_id AND id = p_run_id;
    RETURN pg_catalog.jsonb_build_object('reconciled', false, 'reason', 'rejected_rows',
      'accepted_rows', p_accepted_rows, 'rejected_rows', p_rejected_rows, 'missing_for_review', 0);
  END IF;

  -- All snapshot IDs must already exist in the same organization.
  IF EXISTS (
    SELECT 1 FROM unnest(p_invoice_ids) AS ids(id)
    WHERE NOT EXISTS (
      SELECT 1 FROM public.invoices i
      WHERE i.organization_id = p_organization_id AND i.id = ids.id AND i.source_id = p_source_key
    )
  ) THEN
    RAISE EXCEPTION 'Snapshot references an invoice not persisted for this source' USING ERRCODE = '23503';
  END IF;

  INSERT INTO public.source_sync_memberships
    (organization_id, source_key, source_range, invoice_id, last_seen_run_id, last_seen_at, review_state, review_note, reviewed_by, reviewed_at)
  SELECT p_organization_id, p_source_key, p_source_range, ids.id, p_run_id, pg_catalog.now(), 'present', NULL, NULL, NULL
  FROM unnest(p_invoice_ids) AS ids(id)
  ON CONFLICT (organization_id, source_key, source_range, invoice_id) DO UPDATE
    SET last_seen_run_id = EXCLUDED.last_seen_run_id,
        last_seen_at = EXCLUDED.last_seen_at,
        review_state = 'present',
        review_note = NULL,
        reviewed_by = NULL,
        reviewed_at = NULL;

  GET DIAGNOSTICS v_seen = ROW_COUNT;

  UPDATE public.source_sync_memberships m
     SET review_state = 'missing_from_source_pending_review',
         review_note = NULL,
         reviewed_by = NULL,
         reviewed_at = NULL
   WHERE m.organization_id = p_organization_id
     AND m.source_key = p_source_key
     AND m.source_range = p_source_range
     AND m.review_state = 'present'
     AND m.last_seen_run_id <> p_run_id
     AND NOT (m.invoice_id = ANY(p_invoice_ids));
  GET DIAGNOSTICS v_missing = ROW_COUNT;

  v_status := 'completed';
  UPDATE public.source_sync_runs
     SET status = v_status, content_digest = p_content_digest,
         accepted_rows = p_accepted_rows, rejected_rows = 0,
         completed_at = pg_catalog.now()
   WHERE organization_id = p_organization_id AND id = p_run_id;

  RETURN pg_catalog.jsonb_build_object('reconciled', true, 'accepted_rows', p_accepted_rows,
    'rejected_rows', 0, 'membership_rows_seen', v_seen, 'missing_for_review', v_missing);
END;
$function$;

REVOKE ALL ON FUNCTION public.complete_source_sync_snapshot(text, text, text, text, text, text, text[], integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_source_sync_snapshot(text, text, text, text, text, text, text[], integer, integer) TO service_role;
