CREATE OR REPLACE FUNCTION public.propose_invoice_reminder(
  p_org_id text,
  p_invoice_id text,
  p_message text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_actor text;
  v_invoice public.invoices%ROWTYPE;
  v_assumption public.assumptions%ROWTYPE;
  v_outstanding bigint;
  v_estimate bigint;
  v_opportunity_id text;
  v_action public.actions%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000'; END IF;
  IF NOT private.has_org_role(p_org_id, ARRAY['owner','admin','operator']) THEN
    RAISE EXCEPTION 'Workspace permission denied' USING ERRCODE = '42501';
  END IF;
  IF p_message IS NULL OR length(trim(p_message)) < 10 OR length(p_message) > 4000 THEN
    RAISE EXCEPTION 'Reminder draft must be between 10 and 4000 characters' USING ERRCODE = '22023';
  END IF;
  SELECT u.id INTO v_actor FROM public.users u WHERE u.auth_subject = auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Workspace membership is not initialized' USING ERRCODE = '42501'; END IF;
  SELECT i.* INTO v_invoice FROM public.invoices i WHERE i.organization_id=p_org_id AND i.id=p_invoice_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice was not found in this workspace' USING ERRCODE = 'P0002'; END IF;
  IF v_invoice.due_at >= pg_catalog.now() THEN RAISE EXCEPTION 'Only overdue invoices can have a recovery reminder proposed' USING ERRCODE = '22023'; END IF;
  v_outstanding := v_invoice.total_minor - v_invoice.paid_minor;
  IF v_outstanding <= 0 THEN RAISE EXCEPTION 'This invoice has no outstanding balance' USING ERRCODE = '22023'; END IF;
  SELECT a.* INTO v_assumption FROM public.assumptions a WHERE a.organization_id=p_org_id AND a.id='recovery-rate';
  IF NOT FOUND THEN RAISE EXCEPTION 'Set and save a recovery-rate assumption before proposing actions' USING ERRCODE = '22023'; END IF;
  v_estimate := ((v_outstanding::numeric * v_assumption.value_bps + 5000) / 10000)::bigint;
  v_opportunity_id := 'overdue_invoice:' || v_invoice.id;

  INSERT INTO public.opportunities AS current_opportunity (
    organization_id,id,kind,status,currency,outstanding_minor,estimate_low_minor,estimate_high_minor,assumption_id,detected_at
  ) VALUES (
    p_org_id,v_opportunity_id,'overdue_invoice','open',v_invoice.currency,v_outstanding,v_estimate,v_estimate,v_assumption.id,pg_catalog.now()
  )
  ON CONFLICT (organization_id,id) DO UPDATE SET
    status = CASE WHEN current_opportunity.status IN ('dismissed','closed') THEN current_opportunity.status ELSE 'open' END,
    currency = EXCLUDED.currency,
    outstanding_minor = EXCLUDED.outstanding_minor,
    estimate_low_minor = EXCLUDED.estimate_low_minor,
    estimate_high_minor = EXCLUDED.estimate_high_minor,
    assumption_id = EXCLUDED.assumption_id,
    detected_at = EXCLUDED.detected_at;

  INSERT INTO public.opportunity_evidence (organization_id,opportunity_id,invoice_id)
  VALUES (p_org_id,v_opportunity_id,v_invoice.id) ON CONFLICT DO NOTHING;

  SELECT a.* INTO v_action FROM public.actions a
   WHERE a.organization_id=p_org_id AND a.opportunity_id=v_opportunity_id AND a.status IN ('proposed','approved')
   ORDER BY a.proposed_at DESC LIMIT 1;
  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object('duplicate',true,'id',v_action.id,'opportunity_id',v_action.opportunity_id,
      'status',v_action.status,'message',v_action.message,'proposed_at',v_action.proposed_at,'approved_at',v_action.approved_at,
      'approved_by',v_action.approved_by,'executed_at',v_action.executed_at,'executed_by',v_action.executed_by,
      'recipient_customer_id',v_action.recipient_customer_id,'invoice_id',v_invoice.id);
  END IF;

  INSERT INTO public.actions (organization_id,id,opportunity_id,kind,status,recipient_customer_id,message,execution_mode,proposed_by,proposed_at)
  VALUES (p_org_id,'action_' || pg_catalog.gen_random_uuid()::text,v_opportunity_id,'payment_reminder','proposed',
    v_invoice.customer_id,trim(p_message),'manual',v_actor,pg_catalog.now())
  RETURNING * INTO v_action;
  INSERT INTO public.action_invoice_targets (organization_id,action_id,invoice_id) VALUES (p_org_id,v_action.id,v_invoice.id);
  RETURN pg_catalog.jsonb_build_object('duplicate',false,'id',v_action.id,'opportunity_id',v_action.opportunity_id,
    'status',v_action.status,'message',v_action.message,'proposed_at',v_action.proposed_at,'approved_at',v_action.approved_at,
    'approved_by',v_action.approved_by,'executed_at',v_action.executed_at,'executed_by',v_action.executed_by,
    'recipient_customer_id',v_action.recipient_customer_id,'invoice_id',v_invoice.id);
END;
$function$;
