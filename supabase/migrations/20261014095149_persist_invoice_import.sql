-- Persist invoice CSV imports atomically and allow scoped updates to the current invoice snapshot.
-- All writes execute as the signed-in caller and remain subject to the existing RLS policies.

DROP POLICY IF EXISTS invoices_member_update ON public.invoices;
CREATE POLICY invoices_member_update ON public.invoices
  FOR UPDATE TO authenticated
  USING (private.has_org_role(organization_id, ARRAY['owner', 'admin', 'operator']))
  WITH CHECK (private.has_org_role(organization_id, ARRAY['owner', 'admin', 'operator']));

DROP POLICY IF EXISTS assumptions_member_update ON public.assumptions;
CREATE POLICY assumptions_member_update ON public.assumptions
  FOR UPDATE TO authenticated
  USING (private.has_org_role(organization_id, ARRAY['owner', 'admin', 'operator']))
  WITH CHECK (private.has_org_role(organization_id, ARRAY['owner', 'admin', 'operator']));

CREATE OR REPLACE FUNCTION public.persist_invoice_import(
  org_id text,
  source_id text,
  source_name text,
  content_hash text,
  rows jsonb,
  rejected_rows integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $function$
DECLARE
  actor_id text;
  import_id text;
  total_rows integer;
  accepted_rows integer;
  import_status text;
  row_data jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  IF NOT private.has_org_role(org_id, ARRAY['owner', 'admin', 'operator']) THEN
    RAISE EXCEPTION 'Workspace permission denied' USING ERRCODE = '42501';
  END IF;

  IF source_id IS NULL OR length(trim(source_id)) NOT BETWEEN 1 AND 240
     OR source_name IS NULL OR length(trim(source_name)) NOT BETWEEN 1 AND 240 THEN
    RAISE EXCEPTION 'A valid source identifier and file name are required' USING ERRCODE = '22023';
  END IF;
  IF content_hash IS NULL OR content_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'A SHA-256 content hash is required' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(rows) IS DISTINCT FROM 'array' OR jsonb_array_length(rows) > 50000 THEN
    RAISE EXCEPTION 'Invoice rows must be an array with at most 50000 records' USING ERRCODE = '22023';
  END IF;
  IF rejected_rows IS NULL OR rejected_rows < 0 OR rejected_rows > 50000 THEN
    RAISE EXCEPTION 'Rejected row count is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT u.id INTO actor_id
    FROM public.users AS u
   WHERE u.auth_subject = auth.uid()
   LIMIT 1;
  IF actor_id IS NULL THEN
    RAISE EXCEPTION 'Workspace membership is not initialized' USING ERRCODE = '42501';
  END IF;

  accepted_rows := jsonb_array_length(rows);
  total_rows := accepted_rows + rejected_rows;
  import_status := CASE WHEN rejected_rows > 0 THEN 'completed_with_errors' ELSE 'completed' END;

  INSERT INTO public.data_sources (organization_id, id, name, kind, created_by)
  VALUES (org_id, source_id, left(trim(source_name), 240), 'csv_import', actor_id)
  ON CONFLICT (organization_id, id) DO NOTHING;

  import_id := 'import_' || pg_catalog.gen_random_uuid()::text;
  INSERT INTO public.imports (
    organization_id, id, source_id, status, content_hash,
    total_rows, accepted_rows, rejected_rows, created_by
  )
  VALUES (
    org_id, import_id, source_id, import_status, content_hash,
    total_rows, accepted_rows, rejected_rows, actor_id
  )
  ON CONFLICT (organization_id, source_id, content_hash) DO NOTHING;

  IF NOT FOUND THEN
    SELECT i.id INTO import_id
      FROM public.imports AS i
     WHERE i.organization_id = org_id
       AND i.source_id = persist_invoice_import.source_id
       AND i.content_hash = persist_invoice_import.content_hash
     LIMIT 1;
    RETURN pg_catalog.jsonb_build_object(
      'duplicate', true,
      'import_id', import_id,
      'accepted_rows', 0,
      'rejected_rows', rejected_rows
    );
  END IF;

  FOR row_data IN SELECT value FROM pg_catalog.jsonb_array_elements(rows)
  LOOP
    INSERT INTO public.invoices (
      organization_id, id, source_id, import_id, external_record_id,
      customer_id, customer_name, invoice_number, currency,
      total_minor, paid_minor, issued_at, due_at, imported_at
    )
    VALUES (
      org_id,
      row_data ->> 'id',
      source_id,
      import_id,
      row_data ->> 'invoiceNumber',
      row_data ->> 'customerId',
      row_data ->> 'customerName',
      row_data ->> 'invoiceNumber',
      row_data ->> 'currency',
      (row_data ->> 'totalMinor')::bigint,
      (row_data ->> 'paidMinor')::bigint,
      (row_data ->> 'issuedAt')::timestamptz,
      (row_data ->> 'dueAt')::timestamptz,
      (row_data ->> 'importedAt')::timestamptz
    )
    ON CONFLICT (organization_id, source_id, external_record_id) DO UPDATE SET
      import_id = EXCLUDED.import_id,
      customer_id = EXCLUDED.customer_id,
      customer_name = EXCLUDED.customer_name,
      invoice_number = EXCLUDED.invoice_number,
      currency = EXCLUDED.currency,
      total_minor = EXCLUDED.total_minor,
      paid_minor = EXCLUDED.paid_minor,
      issued_at = EXCLUDED.issued_at,
      due_at = EXCLUDED.due_at,
      imported_at = EXCLUDED.imported_at;
  END LOOP;

  RETURN pg_catalog.jsonb_build_object(
    'duplicate', false,
    'import_id', import_id,
    'accepted_rows', accepted_rows,
    'rejected_rows', rejected_rows
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.persist_invoice_import(text, text, text, text, jsonb, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.persist_invoice_import(text, text, text, text, jsonb, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.persist_invoice_import(text, text, text, text, jsonb, integer) TO authenticated;
