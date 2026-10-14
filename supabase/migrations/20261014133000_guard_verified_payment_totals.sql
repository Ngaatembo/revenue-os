CREATE OR REPLACE FUNCTION public.verify_recovery_outcome(p_org_id text,p_action_id text,p_window_days integer DEFAULT 30)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_actor text; v_action public.actions%ROWTYPE; v_outcome_id text; v_start timestamptz; v_end timestamptz;
  v_currency text; v_amount numeric; v_outstanding numeric; v_count integer; v_payment record;
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
  SELECT i.currency,coalesce(sum(p.amount_minor),0),count(p.id),max(i.total_minor-i.paid_minor)
    INTO v_currency,v_amount,v_count,v_outstanding
  FROM public.action_invoice_targets t
  JOIN public.invoices i ON i.organization_id=t.organization_id AND i.id=t.invoice_id
  JOIN public.payment_evidence p ON p.organization_id=t.organization_id AND p.invoice_id=t.invoice_id
  WHERE t.organization_id=p_org_id AND t.action_id=p_action_id AND p.currency=i.currency AND p.received_at>=v_start AND p.received_at<=v_end
  GROUP BY i.currency LIMIT 1;
  IF v_count IS NULL OR v_count=0 THEN RETURN pg_catalog.jsonb_build_object('verified',false,'reason','No matching payment evidence was found in the measurement window.'); END IF;
  IF v_amount>coalesce(v_outstanding,0) THEN RAISE EXCEPTION 'Matched payment total exceeds the imported outstanding balance; review invoice and payment records' USING ERRCODE='22023'; END IF;
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
