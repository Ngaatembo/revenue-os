-- Persist payment exports and verify outcomes only against imported payment evidence.
CREATE OR REPLACE FUNCTION public.persist_payment_import(
  p_org_id text, p_source_id text, p_source_name text, p_content_hash text, p_rows jsonb, p_rejected_rows integer DEFAULT 0
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_actor text; v_import_id text; v_row jsonb; v_invoice_id text; v_invoice_count integer;
  v_accepted integer := 0; v_total integer; v_amount bigint; v_currency text;
  v_received_at timestamptz; v_reference text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='28000'; END IF;
  IF NOT private.has_org_role(p_org_id, ARRAY['owner','admin','operator']) THEN RAISE EXCEPTION 'Workspace permission denied' USING ERRCODE='42501'; END IF;
  IF p_source_id IS NULL OR length(trim(p_source_id)) NOT BETWEEN 1 AND 240 OR p_source_name IS NULL OR length(trim(p_source_name)) NOT BETWEEN 1 AND 160 THEN RAISE EXCEPTION 'A valid payment source ID and file name are required' USING ERRCODE='22023'; END IF;
  IF p_content_hash IS NULL OR p_content_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'A SHA-256 content hash is required' USING ERRCODE='22023'; END IF;
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows)>50000 THEN RAISE EXCEPTION 'Payment rows must be an array of at most 50000 records' USING ERRCODE='22023'; END IF;
  IF p_rejected_rows IS NULL OR p_rejected_rows<0 OR p_rejected_rows>50000 THEN RAISE EXCEPTION 'Rejected row count is invalid' USING ERRCODE='22023'; END IF;
  SELECT u.id INTO v_actor FROM public.users u WHERE u.auth_subject=auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Workspace membership is not initialized' USING ERRCODE='42501'; END IF;
  INSERT INTO public.data_sources (organization_id,id,name,kind,created_by) VALUES (p_org_id,p_source_id,left(trim(p_source_name),160),'payment_export',v_actor) ON CONFLICT (organization_id,id) DO NOTHING;
  v_total := jsonb_array_length(p_rows)+p_rejected_rows;
  v_import_id := 'payment_import_' || pg_catalog.gen_random_uuid()::text;
  INSERT INTO public.imports (organization_id,id,source_id,status,content_hash,total_rows,accepted_rows,rejected_rows,created_by)
  VALUES (p_org_id,v_import_id,p_source_id,CASE WHEN p_rejected_rows>0 THEN 'completed_with_errors' ELSE 'completed' END,p_content_hash,v_total,jsonb_array_length(p_rows),p_rejected_rows,v_actor)
  ON CONFLICT (organization_id,source_id,content_hash) DO NOTHING;
  IF NOT FOUND THEN
    SELECT i.id INTO v_import_id FROM public.imports i WHERE i.organization_id=p_org_id AND i.source_id=p_source_id AND i.content_hash=p_content_hash LIMIT 1;
    RETURN pg_catalog.jsonb_build_object('duplicate',true,'import_id',v_import_id,'accepted_rows',0,'rejected_rows',p_rejected_rows);
  END IF;
  FOR v_row IN SELECT value FROM pg_catalog.jsonb_array_elements(p_rows) LOOP
    v_reference := trim(coalesce(v_row->>'externalRecordId',''));
    v_currency := upper(trim(coalesce(v_row->>'currency','')));
    IF length(v_reference)=0 OR length(v_reference)>240 OR v_currency !~ '^[A-Z]{3}$' THEN RAISE EXCEPTION 'Payment reference or currency is invalid' USING ERRCODE='22023'; END IF;
    IF coalesce(v_row->>'amountMinor','') !~ '^[0-9]+$' THEN RAISE EXCEPTION 'Payment amount must be positive integer minor units' USING ERRCODE='22023'; END IF;
    v_amount := (v_row->>'amountMinor')::bigint;
    IF v_amount<=0 OR v_amount>9000000000000000 THEN RAISE EXCEPTION 'Payment amount is outside the supported range' USING ERRCODE='22023'; END IF;
    v_received_at := (v_row->>'receivedAt')::timestamptz;
    SELECT count(*),min(i.id) INTO v_invoice_count,v_invoice_id FROM public.invoices i
    WHERE i.organization_id=p_org_id AND i.invoice_number=trim(v_row->>'invoiceNumber') AND i.currency=v_currency;
    IF v_invoice_count=0 THEN RAISE EXCEPTION 'Invoice % was not found for currency %',v_row->>'invoiceNumber',v_currency USING ERRCODE='22023'; END IF;
    IF v_invoice_count>1 THEN RAISE EXCEPTION 'Invoice number % is ambiguous; make invoice numbers unique before importing payments',v_row->>'invoiceNumber' USING ERRCODE='22023'; END IF;
    INSERT INTO public.payment_evidence (organization_id,id,invoice_id,source_id,external_record_id,amount_minor,currency,received_at,imported_at)
    VALUES (p_org_id,'payment_' || pg_catalog.gen_random_uuid()::text,v_invoice_id,p_source_id,v_reference,v_amount,v_currency,v_received_at,pg_catalog.now())
    ON CONFLICT (organization_id,source_id,external_record_id) DO NOTHING;
    IF FOUND THEN v_accepted := v_accepted+1; END IF;
  END LOOP;
  RETURN pg_catalog.jsonb_build_object('duplicate',false,'import_id',v_import_id,'accepted_rows',v_accepted,'rejected_rows',p_rejected_rows);
END;
$function$;

CREATE OR REPLACE FUNCTION public.verify_recovery_outcome(p_org_id text,p_action_id text,p_window_days integer DEFAULT 30)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_actor text; v_action public.actions%ROWTYPE; v_outcome_id text; v_start timestamptz; v_end timestamptz;
  v_currency text; v_amount numeric; v_count integer; v_payment record;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='28000'; END IF;
  IF NOT private.has_org_role(p_org_id, ARRAY['owner','admin','operator']) THEN RAISE EXCEPTION 'Workspace permission denied' USING ERRCODE='42501'; END IF;
  IF p_window_days IS NULL OR p_window_days<1 OR p_window_days>365 THEN RAISE EXCEPTION 'Measurement window must be from 1 to 365 days' USING ERRCODE='22023'; END IF;
  SELECT u.id INTO v_actor FROM public.users u WHERE u.auth_subject=auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Workspace membership is not initialized' USING ERRCODE='42501'; END IF;
  SELECT a.* INTO v_action FROM public.actions a WHERE a.organization_id=p_org_id AND a.id=p_action_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Action was not found in this workspace' USING ERRCODE='P0002'; END IF;
  IF v_action.status<>'executed' OR v_action.executed_at IS NULL THEN RAISE EXCEPTION 'Only manually executed actions can be checked for payment outcomes' USING ERRCODE='22023'; END IF;
  v_start:=v_action.executed_at; v_end:=v_start+(p_window_days || ' days')::interval;
  SELECT i.currency,coalesce(sum(p.amount_minor),0),count(p.id) INTO v_currency,v_amount,v_count
  FROM public.action_invoice_targets t
  JOIN public.invoices i ON i.organization_id=t.organization_id AND i.id=t.invoice_id
  JOIN public.payment_evidence p ON p.organization_id=t.organization_id AND p.invoice_id=t.invoice_id
  WHERE t.organization_id=p_org_id AND t.action_id=p_action_id AND p.currency=i.currency AND p.received_at>=v_start AND p.received_at<=v_end
  GROUP BY i.currency LIMIT 1;
  IF v_count IS NULL OR v_count=0 THEN RETURN pg_catalog.jsonb_build_object('verified',false,'reason','No matching payment evidence was found in the measurement window.'); END IF;
  IF v_amount>9000000000000000 THEN RAISE EXCEPTION 'Matched payment total exceeds supported amount range' USING ERRCODE='22003'; END IF;
  v_outcome_id:='verified:' || v_action.id;
  INSERT INTO public.outcomes (organization_id,id,action_id,opportunity_id,state,method,amount_minor,currency,measurement_starts_at,measurement_ends_at,causal_claim,recorded_by,recorded_at)
  VALUES (p_org_id,v_outcome_id,v_action.id,v_action.opportunity_id,'verified','matched_payment_record',v_amount::bigint,v_currency,v_start,v_end,'observed_after_action_not_proven_causal',v_actor,pg_catalog.now())
  ON CONFLICT (organization_id,id) DO UPDATE SET amount_minor=EXCLUDED.amount_minor,currency=EXCLUDED.currency,
    measurement_starts_at=EXCLUDED.measurement_starts_at,measurement_ends_at=EXCLUDED.measurement_ends_at,recorded_by=EXCLUDED.recorded_by,recorded_at=EXCLUDED.recorded_at;
  FOR v_payment IN SELECT DISTINCT p.id FROM public.action_invoice_targets t
    JOIN public.payment_evidence p ON p.organization_id=t.organization_id AND p.invoice_id=t.invoice_id
    WHERE t.organization_id=p_org_id AND t.action_id=p_action_id AND p.currency=v_currency AND p.received_at>=v_start AND p.received_at<=v_end
  LOOP
    INSERT INTO public.outcome_payment_evidence (organization_id,outcome_id,payment_evidence_id) VALUES (p_org_id,v_outcome_id,v_payment.id) ON CONFLICT DO NOTHING;
  END LOOP;
  RETURN pg_catalog.jsonb_build_object('verified',true,'outcome_id',v_outcome_id,'action_id',v_action.id,'amount_minor',v_amount::bigint,'currency',v_currency,'measurement_starts_at',v_start,'measurement_ends_at',v_end,'causal_claim','observed_after_action_not_proven_causal','payment_count',v_count);
END;
$function$;

REVOKE ALL ON FUNCTION public.persist_payment_import(text,text,text,text,jsonb,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.persist_payment_import(text,text,text,text,jsonb,integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.persist_payment_import(text,text,text,text,jsonb,integer) TO authenticated;
REVOKE ALL ON FUNCTION public.verify_recovery_outcome(text,text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.verify_recovery_outcome(text,text,integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.verify_recovery_outcome(text,text,integer) TO authenticated;
