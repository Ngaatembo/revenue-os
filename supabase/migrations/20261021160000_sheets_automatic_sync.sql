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
