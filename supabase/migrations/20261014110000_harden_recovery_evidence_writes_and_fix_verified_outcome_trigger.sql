-- Harden recovery evidence writes and verify outcomes through the database trigger.
ALTER FUNCTION public.persist_invoice_import(text, text, text, text, jsonb, integer) SECURITY DEFINER;
REVOKE ALL ON FUNCTION public.persist_invoice_import(text, text, text, text, jsonb, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.persist_invoice_import(text, text, text, text, jsonb, integer) TO authenticated;

DO $migration$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'data_sources','imports','invoices','opportunities','opportunity_evidence',
    'actions','action_invoice_targets','payment_evidence','outcomes',
    'outcome_payment_evidence','audit_log'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_member_insert', t);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON TABLE public.%I FROM anon, authenticated', t);
  END LOOP;
END;
$migration$;

CREATE OR REPLACE FUNCTION public.guard_outcome_verification()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
DECLARE
  matching_count bigint;
  matching_total numeric;
  opportunity_currency text;
  action_outstanding numeric;
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state
     AND NOT (OLD.state = 'reported' AND NEW.state = 'verified') THEN
    RAISE EXCEPTION 'Invalid outcome state transition';
  END IF;

  IF NEW.state = 'verified' THEN
    IF NEW.method <> 'matched_payment_record' THEN
      RAISE EXCEPTION 'Verified outcomes require matched payment records';
    END IF;

    SELECT count(DISTINCT p.id), COALESCE(sum(p.amount_minor), 0)
      INTO matching_count, matching_total
      FROM public.outcome_payment_evidence link
      JOIN public.payment_evidence p
        ON p.organization_id = link.organization_id AND p.id = link.payment_evidence_id
      JOIN public.action_invoice_targets target
        ON target.organization_id = p.organization_id
       AND target.action_id = NEW.action_id AND target.invoice_id = p.invoice_id
      JOIN public.opportunity_evidence evidence
        ON evidence.organization_id = p.organization_id
       AND evidence.invoice_id = p.invoice_id AND evidence.opportunity_id = NEW.opportunity_id
     WHERE link.organization_id = NEW.organization_id
       AND link.outcome_id = NEW.id
       AND p.currency = NEW.currency
       AND p.received_at >= NEW.measurement_starts_at
       AND p.received_at <= NEW.measurement_ends_at;

    SELECT o.currency INTO opportunity_currency
      FROM public.opportunities o
     WHERE o.organization_id = NEW.organization_id AND o.id = NEW.opportunity_id;

    SELECT COALESCE(sum(target.outstanding_minor_at_proposal), 0)
      INTO action_outstanding
      FROM public.action_invoice_targets target
      JOIN public.invoices i
        ON i.organization_id = target.organization_id AND i.id = target.invoice_id
     WHERE target.organization_id = NEW.organization_id
       AND target.action_id = NEW.action_id
       AND i.currency = NEW.currency
       AND target.outstanding_minor_at_proposal IS NOT NULL;

    IF matching_count = 0 OR matching_total <> NEW.amount_minor
       OR opportunity_currency IS DISTINCT FROM NEW.currency
       OR action_outstanding <= 0 OR NEW.amount_minor > action_outstanding THEN
      RAISE EXCEPTION 'Verified outcome requires matching linked payment evidence within the proposed outstanding balance';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.verify_recovery_outcome(
  p_org_id text, p_action_id text, p_window_days integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_actor text;
  v_action public.actions%ROWTYPE;
  v_outcome_id text;
  v_start timestamptz;
  v_end timestamptz;
  v_currency text;
  v_amount numeric;
  v_outstanding numeric;
  v_count integer;
  v_payment record;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF NOT private.has_org_role(p_org_id, ARRAY['owner','admin','operator']) THEN
    RAISE EXCEPTION 'Workspace permission denied' USING ERRCODE = '42501';
  END IF;
  IF p_window_days IS NULL OR p_window_days < 1 OR p_window_days > 365 THEN
    RAISE EXCEPTION 'Measurement window must be from 1 to 365 days' USING ERRCODE = '22023';
  END IF;

  SELECT u.id INTO v_actor FROM public.users u WHERE u.auth_subject = auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Workspace membership is not initialized' USING ERRCODE = '42501';
  END IF;

  SELECT a.* INTO v_action
    FROM public.actions a
   WHERE a.organization_id = p_org_id AND a.id = p_action_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Action was not found in this workspace' USING ERRCODE = 'P0002';
  END IF;
  IF v_action.status <> 'executed' OR v_action.executed_at IS NULL THEN
    RAISE EXCEPTION 'Only manually executed actions can be checked for payment outcomes' USING ERRCODE = '22023';
  END IF;

  v_start := v_action.executed_at;
  v_end := v_start + (p_window_days || ' days')::interval;

  SELECT i.currency, COALESCE(sum(p.amount_minor), 0), count(p.id)
    INTO v_currency, v_amount, v_count
    FROM public.action_invoice_targets target
    JOIN public.invoices i
      ON i.organization_id = target.organization_id AND i.id = target.invoice_id
    JOIN public.payment_evidence p
      ON p.organization_id = target.organization_id AND p.invoice_id = target.invoice_id
   WHERE target.organization_id = p_org_id AND target.action_id = p_action_id
     AND p.currency = i.currency AND p.received_at >= v_start AND p.received_at <= v_end
   GROUP BY i.currency
   LIMIT 1;

  IF v_count IS NULL OR v_count = 0 THEN
    RETURN pg_catalog.jsonb_build_object('verified', false,
      'reason', 'No matching payment evidence was found in the measurement window.');
  END IF;

  SELECT COALESCE(sum(target.outstanding_minor_at_proposal), 0)
    INTO v_outstanding
    FROM public.action_invoice_targets target
    JOIN public.invoices i
      ON i.organization_id = target.organization_id AND i.id = target.invoice_id
   WHERE target.organization_id = p_org_id AND target.action_id = p_action_id
     AND i.currency = v_currency AND target.outstanding_minor_at_proposal IS NOT NULL;

  IF v_outstanding <= 0 THEN
    RAISE EXCEPTION 'The recovery action has no valid outstanding-balance snapshot' USING ERRCODE = '22023';
  END IF;
  IF v_amount > v_outstanding THEN
    RAISE EXCEPTION 'Matched payment total exceeds the outstanding balance recorded when the reminder was proposed; review duplicate or incorrect payment records' USING ERRCODE = '22023';
  END IF;
  IF v_amount > 9000000000000000 THEN
    RAISE EXCEPTION 'Matched payment total exceeds supported amount range' USING ERRCODE = '22003';
  END IF;

  v_outcome_id := 'verified:' || v_action.id;
  INSERT INTO public.outcomes (
    organization_id, id, action_id, opportunity_id, state, method,
    amount_minor, currency, measurement_starts_at, measurement_ends_at,
    causal_claim, recorded_by, recorded_at
  ) VALUES (
    p_org_id, v_outcome_id, v_action.id, v_action.opportunity_id,
    'reported', 'human_report', v_amount::bigint, v_currency,
    v_start, v_end, 'observed_after_action_not_proven_causal',
    v_actor, pg_catalog.now()
  ) ON CONFLICT (organization_id, id) DO NOTHING;

  DELETE FROM public.outcome_payment_evidence
   WHERE organization_id = p_org_id AND outcome_id = v_outcome_id;

  FOR v_payment IN
    SELECT DISTINCT p.id
      FROM public.action_invoice_targets target
      JOIN public.invoices i
        ON i.organization_id = target.organization_id AND i.id = target.invoice_id
      JOIN public.payment_evidence p
        ON p.organization_id = target.organization_id AND p.invoice_id = target.invoice_id
     WHERE target.organization_id = p_org_id AND target.action_id = p_action_id
       AND p.currency = v_currency AND p.currency = i.currency
       AND p.received_at >= v_start AND p.received_at <= v_end
  LOOP
    INSERT INTO public.outcome_payment_evidence(organization_id, outcome_id, payment_evidence_id)
    VALUES (p_org_id, v_outcome_id, v_payment.id)
    ON CONFLICT DO NOTHING;
  END LOOP;

  UPDATE public.outcomes
     SET state = 'verified', method = 'matched_payment_record',
         amount_minor = v_amount::bigint, currency = v_currency,
         measurement_starts_at = v_start, measurement_ends_at = v_end,
         causal_claim = 'observed_after_action_not_proven_causal',
         recorded_by = v_actor, recorded_at = pg_catalog.now()
   WHERE organization_id = p_org_id AND id = v_outcome_id;

  RETURN pg_catalog.jsonb_build_object(
    'verified', true, 'outcome_id', v_outcome_id, 'action_id', v_action.id,
    'amount_minor', v_amount::bigint, 'currency', v_currency,
    'measurement_starts_at', v_start, 'measurement_ends_at', v_end,
    'causal_claim', 'observed_after_action_not_proven_causal', 'payment_count', v_count
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.verify_recovery_outcome(text, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_recovery_outcome(text, text, integer) TO authenticated;
