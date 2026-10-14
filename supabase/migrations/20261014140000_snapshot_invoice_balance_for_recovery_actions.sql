ALTER TABLE public.action_invoice_targets ADD COLUMN IF NOT EXISTS outstanding_minor_at_proposal bigint;
UPDATE public.action_invoice_targets t
   SET outstanding_minor_at_proposal=o.outstanding_minor
  FROM public.actions a
  JOIN public.opportunities o ON o.organization_id=a.organization_id AND o.id=a.opportunity_id
 WHERE t.organization_id=a.organization_id AND t.action_id=a.id
   AND t.outstanding_minor_at_proposal IS NULL;
DO $constraint$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='action_invoice_targets_outstanding_snapshot_check' AND conrelid='public.action_invoice_targets'::regclass) THEN
    ALTER TABLE public.action_invoice_targets ADD CONSTRAINT action_invoice_targets_outstanding_snapshot_check
      CHECK (outstanding_minor_at_proposal IS NULL OR outstanding_minor_at_proposal BETWEEN 1 AND 9000000000000000);
  END IF;
END;
$constraint$;
CREATE OR REPLACE FUNCTION public.propose_invoice_reminder(p_org_id text,p_invoice_id text,p_message text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_actor text; v_invoice public.invoices%ROWTYPE; v_assumption public.assumptions%ROWTYPE;
  v_outstanding bigint; v_estimate bigint; v_opportunity_id text; v_action public.actions%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='28000'; END IF;
  IF NOT private.has_org_role(p_org_id,ARRAY['owner','admin','operator']) THEN RAISE EXCEPTION 'Workspace permission denied' USING ERRCODE='42501'; END IF;
  IF p_message IS NULL OR length(trim(p_message))<10 OR length(p_message)>4000 THEN RAISE EXCEPTION 'Reminder draft must be between 10 and 4000 characters' USING ERRCODE='22023'; END IF;
  SELECT u.id INTO v_actor FROM public.users u WHERE u.auth_subject=auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Workspace membership is not initialized' USING ERRCODE='42501'; END IF;
  SELECT i.* INTO v_invoice FROM public.invoices i WHERE i.organization_id=p_org_id AND i.id=p_invoice_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice was not found in this workspace' USING ERRCODE='P0002'; END IF;
  IF v_invoice.due_at>=pg_catalog.now() THEN RAISE EXCEPTION 'Only overdue invoices can have a recovery reminder proposed' USING ERRCODE='22023'; END IF;
  v_outstanding:=v_invoice.total_minor-v_invoice.paid_minor;
  IF v_outstanding<=0 THEN RAISE EXCEPTION 'This invoice has no outstanding balance' USING ERRCODE='22023'; END IF;
  SELECT a.* INTO v_assumption FROM public.assumptions a WHERE a.organization_id=p_org_id AND a.id='recovery-rate';
  IF NOT FOUND THEN RAISE EXCEPTION 'Set and save a recovery-rate assumption before proposing actions' USING ERRCODE='22023'; END IF;
  v_estimate:=floor((v_outstanding::numeric*v_assumption.value_bps+5000)/10000)::bigint;
  v_opportunity_id:='overdue_invoice:' || v_invoice.id;
  INSERT INTO public.opportunities AS current_opportunity (organization_id,id,kind,status,currency,outstanding_minor,estimate_low_minor,estimate_high_minor,assumption_id,detected_at)
  VALUES (p_org_id,v_opportunity_id,'overdue_invoice','open',v_invoice.currency,v_outstanding,v_estimate,v_estimate,v_assumption.id,pg_catalog.now())
  ON CONFLICT (organization_id,id) DO UPDATE SET
    status=CASE WHEN current_opportunity.status IN ('dismissed','closed') THEN current_opportunity.status ELSE 'open' END,
    currency=EXCLUDED.currency,outstanding_minor=EXCLUDED.outstanding_minor,estimate_low_minor=EXCLUDED.estimate_low_minor,
    estimate_high_minor=EXCLUDED.estimate_high_minor,assumption_id=EXCLUDED.assumption_id,detected_at=EXCLUDED.detected_at;
  INSERT INTO public.opportunity_evidence (organization_id,opportunity_id,invoice_id) VALUES (p_org_id,v_opportunity_id,v_invoice.id) ON CONFLICT DO NOTHING;
  SELECT a.* INTO v_action FROM public.actions a WHERE a.organization_id=p_org_id AND a.opportunity_id=v_opportunity_id AND a.status IN ('proposed','approved') ORDER BY a.proposed_at DESC LIMIT 1;
  IF FOUND THEN RETURN pg_catalog.jsonb_build_object('duplicate',true,'id',v_action.id,'opportunity_id',v_action.opportunity_id,'status',v_action.status,'message',v_action.message,'proposed_at',v_action.proposed_at,'approved_at',v_action.approved_at,'approved_by',v_action.approved_by,'executed_at',v_action.executed_at,'executed_by',v_action.executed_by,'recipient_customer_id',v_action.recipient_customer_id,'invoice_id',v_invoice.id); END IF;
  INSERT INTO public.actions (organization_id,id,opportunity_id,kind,status,recipient_customer_id,message,execution_mode,proposed_by,proposed_at)
  VALUES (p_org_id,'action_'||pg_catalog.gen_random_uuid()::text,v_opportunity_id,'payment_reminder','proposed',v_invoice.customer_id,trim(p_message),'manual',v_actor,pg_catalog.now()) RETURNING * INTO v_action;
  INSERT INTO public.action_invoice_targets (organization_id,action_id,invoice_id,outstanding_minor_at_proposal) VALUES (p_org_id,v_action.id,v_invoice.id,v_outstanding);
  RETURN pg_catalog.jsonb_build_object('duplicate',false,'id',v_action.id,'opportunity_id',v_action.opportunity_id,'status',v_action.status,'message',v_action.message,'proposed_at',v_action.proposed_at,'approved_at',v_action.approved_at,'approved_by',v_action.approved_by,'executed_at',v_action.executed_at,'executed_by',v_action.executed_by,'recipient_customer_id',v_action.recipient_customer_id,'invoice_id',v_invoice.id);
END;
$function$;
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
  SELECT t.outstanding_minor_at_proposal INTO v_outstanding
    FROM public.action_invoice_targets t
   WHERE t.organization_id=p_org_id AND t.action_id=p_action_id
   LIMIT 1;
  IF v_outstanding IS NULL OR v_outstanding<=0 THEN RAISE EXCEPTION 'The recovery opportunity has no valid outstanding-balance snapshot' USING ERRCODE='22023'; END IF;
  SELECT i.currency,coalesce(sum(p.amount_minor),0),count(p.id)
    INTO v_currency,v_amount,v_count
  FROM public.action_invoice_targets t
  JOIN public.invoices i ON i.organization_id=t.organization_id AND i.id=t.invoice_id
  JOIN public.payment_evidence p ON p.organization_id=t.organization_id AND p.invoice_id=t.invoice_id
  WHERE t.organization_id=p_org_id AND t.action_id=p_action_id AND p.currency=i.currency AND p.received_at>=v_start AND p.received_at<=v_end
  GROUP BY i.currency LIMIT 1;
  IF v_count IS NULL OR v_count=0 THEN RETURN pg_catalog.jsonb_build_object('verified',false,'reason','No matching payment evidence was found in the measurement window.'); END IF;
  IF v_amount>v_outstanding THEN RAISE EXCEPTION 'Matched payment total exceeds the outstanding balance recorded when the reminder was proposed; review duplicate or incorrect payment records' USING ERRCODE='22023'; END IF;
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
