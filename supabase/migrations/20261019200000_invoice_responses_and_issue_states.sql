-- Invoice recovery loop: customer responses, payment promises, disputes, and issue states.
--
-- Adds, without touching any existing function or policy:
--   1. opportunities.workflow_state / snoozed_until / next_follow_up / promised_* / dismissed_reason.
--      status (open|accepted|dismissed|closed) stays the lifecycle; workflow_state says where an OPEN
--      issue is in the conversation with the customer.
--   2. public.invoice_interactions: append-only record of what the customer said or did.
--   3. public.record_invoice_response(): the ONLY way to write an interaction. It updates the issue
--      state and follow-up date atomically and writes the audit log.
--   4. public.set_opportunity_state(): acknowledge, snooze, unsnooze, dismiss (with reason), reopen.
--
-- Financial safety rules enforced here:
--   * A promise is NOT money. These functions never touch invoices.paid_minor, payment_evidence,
--     outcomes or outcome_payment_evidence. Verified revenue still comes only from matched payment evidence.
--   * A promised amount can never exceed the invoice's recorded outstanding balance.
--   * Dismissing an issue hides it from the attention queue only; the invoice stays unpaid in the data
--     and the sync never reopens a dismissed opportunity on its own.

ALTER TABLE public.opportunities
  ADD COLUMN IF NOT EXISTS workflow_state text NOT NULL DEFAULT 'new',
  ADD COLUMN IF NOT EXISTS snoozed_until timestamptz,
  ADD COLUMN IF NOT EXISTS next_follow_up date,
  ADD COLUMN IF NOT EXISTS promised_amount_minor bigint,
  ADD COLUMN IF NOT EXISTS promised_date date,
  ADD COLUMN IF NOT EXISTS dismissed_reason text,
  ADD COLUMN IF NOT EXISTS state_updated_at timestamptz;

ALTER TABLE public.opportunities DROP CONSTRAINT IF EXISTS opportunities_workflow_state_check;
ALTER TABLE public.opportunities ADD CONSTRAINT opportunities_workflow_state_check
  CHECK (workflow_state IN ('new', 'acknowledged', 'awaiting_response', 'in_conversation', 'promised', 'disputed', 'payment_claimed'));

ALTER TABLE public.opportunities DROP CONSTRAINT IF EXISTS opportunities_promise_check;
ALTER TABLE public.opportunities ADD CONSTRAINT opportunities_promise_check
  CHECK (
    (promised_amount_minor IS NULL AND promised_date IS NULL)
    OR (promised_amount_minor > 0 AND promised_amount_minor <= 9000000000000000 AND promised_date IS NOT NULL)
  );

ALTER TABLE public.opportunities DROP CONSTRAINT IF EXISTS opportunities_dismissed_reason_check;
ALTER TABLE public.opportunities ADD CONSTRAINT opportunities_dismissed_reason_check
  CHECK (dismissed_reason IS NULL OR length(trim(dismissed_reason)) BETWEEN 3 AND 500);

CREATE TABLE IF NOT EXISTS public.invoice_interactions (
  organization_id text NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  id text NOT NULL,
  opportunity_id text NOT NULL,
  invoice_id text NOT NULL,
  action_id text,
  interaction_type text NOT NULL CHECK (interaction_type IN (
    'customer_replied', 'promised_to_pay', 'disputed', 'asked_for_extension', 'no_response', 'paid_claimed', 'note'
  )),
  summary text NOT NULL CHECK (length(trim(summary)) BETWEEN 3 AND 1000),
  promised_amount_minor bigint CHECK (promised_amount_minor IS NULL OR (promised_amount_minor > 0 AND promised_amount_minor <= 9000000000000000)),
  promised_date date,
  next_follow_up date,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, opportunity_id) REFERENCES public.opportunities(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, invoice_id) REFERENCES public.invoices(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, action_id) REFERENCES public.actions(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, created_by) REFERENCES public.memberships(organization_id, user_id) ON DELETE RESTRICT,
  CHECK (
    (interaction_type = 'promised_to_pay' AND promised_amount_minor IS NOT NULL AND promised_date IS NOT NULL)
    OR (interaction_type <> 'promised_to_pay' AND promised_amount_minor IS NULL AND promised_date IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS invoice_interactions_opportunity_idx
  ON public.invoice_interactions (organization_id, opportunity_id, created_at DESC);

ALTER TABLE public.invoice_interactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS invoice_interactions_member_read ON public.invoice_interactions;
CREATE POLICY invoice_interactions_member_read ON public.invoice_interactions
  FOR SELECT TO authenticated
  USING (private.is_org_member(organization_id));

REVOKE ALL ON public.invoice_interactions FROM anon, authenticated;
GRANT SELECT ON public.invoice_interactions TO authenticated;

DROP TRIGGER IF EXISTS invoice_interactions_immutable ON public.invoice_interactions;
CREATE TRIGGER invoice_interactions_immutable
BEFORE UPDATE OR DELETE ON public.invoice_interactions
FOR EACH ROW EXECUTE FUNCTION public.prevent_immutable_record_mutation();

CREATE OR REPLACE FUNCTION public.record_invoice_response(
  p_org_id text,
  p_interaction_id text,
  p_opportunity_id text,
  p_interaction_type text,
  p_summary text,
  p_promised_amount_minor bigint DEFAULT NULL,
  p_promised_date date DEFAULT NULL,
  p_next_follow_up date DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_actor text;
  v_opp public.opportunities%ROWTYPE;
  v_invoice public.invoices%ROWTYPE;
  v_action_id text;
  v_state text;
  v_next date;
  v_existing public.invoice_interactions%ROWTYPE;
  v_row public.invoice_interactions%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000'; END IF;
  IF NOT private.has_org_role(p_org_id, ARRAY['owner', 'admin', 'operator']) THEN
    RAISE EXCEPTION 'Workspace permission denied' USING ERRCODE = '42501';
  END IF;
  IF p_interaction_id IS NULL OR length(trim(p_interaction_id)) NOT BETWEEN 1 AND 160 THEN
    RAISE EXCEPTION 'A valid interaction id is required' USING ERRCODE = '22023';
  END IF;
  IF p_interaction_type IS NULL OR p_interaction_type NOT IN (
    'customer_replied', 'promised_to_pay', 'disputed', 'asked_for_extension', 'no_response', 'paid_claimed', 'note'
  ) THEN
    RAISE EXCEPTION 'Unsupported interaction type' USING ERRCODE = '22023';
  END IF;
  IF p_summary IS NULL OR length(trim(p_summary)) NOT BETWEEN 3 AND 1000 THEN
    RAISE EXCEPTION 'Describe what happened in 3 to 1000 characters' USING ERRCODE = '22023';
  END IF;
  IF p_interaction_type = 'promised_to_pay' THEN
    IF p_promised_amount_minor IS NULL OR p_promised_amount_minor <= 0 OR p_promised_date IS NULL THEN
      RAISE EXCEPTION 'A promise needs a positive amount and a promised date' USING ERRCODE = '22023';
    END IF;
  ELSIF p_promised_amount_minor IS NOT NULL OR p_promised_date IS NOT NULL THEN
    RAISE EXCEPTION 'Only a promise can carry a promised amount or date' USING ERRCODE = '22023';
  END IF;

  SELECT u.id INTO v_actor FROM public.users u WHERE u.auth_subject = auth.uid() LIMIT 1;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Workspace membership is not initialized' USING ERRCODE = '42501'; END IF;

  -- Idempotent retry: the same interaction id returns the saved record instead of recording twice.
  SELECT * INTO v_existing FROM public.invoice_interactions
   WHERE organization_id = p_org_id AND id = p_interaction_id;
  IF FOUND THEN
    IF v_existing.opportunity_id <> p_opportunity_id THEN
      RAISE EXCEPTION 'Interaction id already used for a different issue' USING ERRCODE = '23505';
    END IF;
    RETURN pg_catalog.jsonb_build_object('id', v_existing.id, 'duplicate', true,
      'opportunity_id', v_existing.opportunity_id, 'interaction_type', v_existing.interaction_type);
  END IF;

  SELECT o.* INTO v_opp FROM public.opportunities o
   WHERE o.organization_id = p_org_id AND o.id = p_opportunity_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Issue not found in this workspace' USING ERRCODE = 'P0002'; END IF;
  IF v_opp.status <> 'open' THEN
    RAISE EXCEPTION 'Only open issues can receive customer responses' USING ERRCODE = '22023';
  END IF;

  SELECT i.* INTO v_invoice
    FROM public.opportunity_evidence e
    JOIN public.invoices i ON i.organization_id = e.organization_id AND i.id = e.invoice_id
   WHERE e.organization_id = p_org_id AND e.opportunity_id = p_opportunity_id
   ORDER BY i.id
   LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'This issue has no linked invoice' USING ERRCODE = '22023'; END IF;

  IF p_interaction_type = 'promised_to_pay' THEN
    IF p_promised_amount_minor > (v_invoice.total_minor - v_invoice.paid_minor) THEN
      RAISE EXCEPTION 'The promised amount is more than the recorded outstanding balance' USING ERRCODE = '22023';
    END IF;
    IF p_promised_date < CURRENT_DATE THEN
      RAISE EXCEPTION 'The promised date cannot be in the past' USING ERRCODE = '22023';
    END IF;
  END IF;

  v_next := p_next_follow_up;
  IF p_interaction_type = 'promised_to_pay' THEN
    v_next := COALESCE(v_next, p_promised_date + 1);
  ELSIF p_interaction_type = 'paid_claimed' THEN
    v_next := COALESCE(v_next, CURRENT_DATE + 2);
  ELSIF p_interaction_type <> 'note' AND v_next IS NULL THEN
    RAISE EXCEPTION 'Choose the next follow-up date' USING ERRCODE = '22023';
  END IF;
  IF v_next IS NOT NULL AND v_next < CURRENT_DATE THEN
    RAISE EXCEPTION 'The next follow-up cannot be in the past' USING ERRCODE = '22023';
  END IF;

  -- Link the most recent manually executed reminder, if any, so the response is traceable to the action.
  SELECT a.id INTO v_action_id
    FROM public.actions a
   WHERE a.organization_id = p_org_id AND a.opportunity_id = p_opportunity_id AND a.status = 'executed'
   ORDER BY a.executed_at DESC
   LIMIT 1;

  INSERT INTO public.invoice_interactions (
    organization_id, id, opportunity_id, invoice_id, action_id, interaction_type, summary,
    promised_amount_minor, promised_date, next_follow_up, created_by
  ) VALUES (
    p_org_id, p_interaction_id, p_opportunity_id, v_invoice.id, v_action_id, p_interaction_type, trim(p_summary),
    p_promised_amount_minor, p_promised_date, v_next, v_actor
  ) RETURNING * INTO v_row;

  v_state := CASE p_interaction_type
    WHEN 'no_response' THEN 'awaiting_response'
    WHEN 'customer_replied' THEN 'in_conversation'
    WHEN 'asked_for_extension' THEN 'in_conversation'
    WHEN 'promised_to_pay' THEN 'promised'
    WHEN 'disputed' THEN 'disputed'
    WHEN 'paid_claimed' THEN 'payment_claimed'
    ELSE v_opp.workflow_state
  END;

  UPDATE public.opportunities
     SET workflow_state = v_state,
         next_follow_up = CASE WHEN p_interaction_type = 'note' THEN next_follow_up ELSE v_next END,
         promised_amount_minor = CASE WHEN p_interaction_type = 'promised_to_pay' THEN p_promised_amount_minor
                                      WHEN p_interaction_type IN ('disputed', 'paid_claimed') THEN NULL
                                      ELSE promised_amount_minor END,
         promised_date = CASE WHEN p_interaction_type = 'promised_to_pay' THEN p_promised_date
                              WHEN p_interaction_type IN ('disputed', 'paid_claimed') THEN NULL
                              ELSE promised_date END,
         -- a new response ends any snooze: the owner is actively working this issue again
         snoozed_until = CASE WHEN p_interaction_type = 'note' THEN snoozed_until ELSE NULL END,
         state_updated_at = pg_catalog.now()
   WHERE organization_id = p_org_id AND id = p_opportunity_id;

  INSERT INTO public.audit_log (organization_id, id, actor_user_id, event_type, entity_type, entity_id, details)
  VALUES (
    p_org_id, 'audit_' || pg_catalog.gen_random_uuid()::text, v_actor, 'invoice_response_recorded', 'opportunity', p_opportunity_id,
    pg_catalog.jsonb_build_object(
      'interaction_id', p_interaction_id, 'interaction_type', p_interaction_type, 'invoice_id', v_invoice.id,
      'workflow_state', v_state, 'promised_amount_minor', p_promised_amount_minor,
      'promised_date', p_promised_date, 'next_follow_up', v_next
    )
  );

  RETURN pg_catalog.jsonb_build_object(
    'id', v_row.id, 'duplicate', false, 'opportunity_id', v_row.opportunity_id, 'invoice_id', v_row.invoice_id,
    'action_id', v_row.action_id, 'interaction_type', v_row.interaction_type, 'workflow_state', v_state,
    'next_follow_up', v_next, 'created_at', v_row.created_at
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_opportunity_state(
  p_org_id text,
  p_opportunity_id text,
  p_transition text,
  p_reason text DEFAULT NULL,
  p_snooze_until timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_actor text;
  v_opp public.opportunities%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000'; END IF;
  IF NOT private.has_org_role(p_org_id, ARRAY['owner', 'admin', 'operator']) THEN
    RAISE EXCEPTION 'Workspace permission denied' USING ERRCODE = '42501';
  END IF;
  IF p_transition IS NULL OR p_transition NOT IN ('acknowledge', 'snooze', 'unsnooze', 'dismiss', 'reopen') THEN
    RAISE EXCEPTION 'Unsupported issue transition' USING ERRCODE = '22023';
  END IF;

  SELECT u.id INTO v_actor FROM public.users u WHERE u.auth_subject = auth.uid() LIMIT 1;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Workspace membership is not initialized' USING ERRCODE = '42501'; END IF;

  SELECT o.* INTO v_opp FROM public.opportunities o
   WHERE o.organization_id = p_org_id AND o.id = p_opportunity_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Issue not found in this workspace' USING ERRCODE = 'P0002'; END IF;

  IF p_transition = 'reopen' THEN
    IF v_opp.status <> 'dismissed' THEN RAISE EXCEPTION 'Only a dismissed issue can be reopened' USING ERRCODE = '22023'; END IF;
    UPDATE public.opportunities
       SET status = 'open', dismissed_reason = NULL, snoozed_until = NULL, state_updated_at = pg_catalog.now()
     WHERE organization_id = p_org_id AND id = p_opportunity_id;
  ELSE
    IF v_opp.status <> 'open' THEN
      RAISE EXCEPTION 'Only open issues can change state' USING ERRCODE = '22023';
    END IF;
    IF p_transition = 'acknowledge' THEN
      IF v_opp.workflow_state <> 'new' THEN RAISE EXCEPTION 'This issue is already being worked' USING ERRCODE = '22023'; END IF;
      UPDATE public.opportunities SET workflow_state = 'acknowledged', state_updated_at = pg_catalog.now()
       WHERE organization_id = p_org_id AND id = p_opportunity_id;
    ELSIF p_transition = 'snooze' THEN
      IF p_snooze_until IS NULL OR p_snooze_until <= pg_catalog.now() OR p_snooze_until > pg_catalog.now() + interval '90 days' THEN
        RAISE EXCEPTION 'Choose a snooze end between now and 90 days from now' USING ERRCODE = '22023';
      END IF;
      UPDATE public.opportunities SET snoozed_until = p_snooze_until, state_updated_at = pg_catalog.now()
       WHERE organization_id = p_org_id AND id = p_opportunity_id;
    ELSIF p_transition = 'unsnooze' THEN
      UPDATE public.opportunities SET snoozed_until = NULL, state_updated_at = pg_catalog.now()
       WHERE organization_id = p_org_id AND id = p_opportunity_id;
    ELSE -- dismiss
      IF p_reason IS NULL OR length(trim(p_reason)) NOT BETWEEN 3 AND 500 THEN
        RAISE EXCEPTION 'Give a reason for dismissing this issue (3 to 500 characters)' USING ERRCODE = '22023';
      END IF;
      UPDATE public.opportunities
         SET status = 'dismissed', dismissed_reason = trim(p_reason), snoozed_until = NULL, state_updated_at = pg_catalog.now()
       WHERE organization_id = p_org_id AND id = p_opportunity_id;
    END IF;
  END IF;

  INSERT INTO public.audit_log (organization_id, id, actor_user_id, event_type, entity_type, entity_id, details)
  VALUES (
    p_org_id, 'audit_' || pg_catalog.gen_random_uuid()::text, v_actor, 'opportunity_' || p_transition, 'opportunity', p_opportunity_id,
    pg_catalog.jsonb_build_object('transition', p_transition, 'reason', NULLIF(trim(COALESCE(p_reason, '')), ''), 'snooze_until', p_snooze_until)
  );

  RETURN (
    SELECT pg_catalog.jsonb_build_object('id', o.id, 'status', o.status, 'workflow_state', o.workflow_state,
      'snoozed_until', o.snoozed_until, 'dismissed_reason', o.dismissed_reason)
      FROM public.opportunities o WHERE o.organization_id = p_org_id AND o.id = p_opportunity_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.record_invoice_response(text, text, text, text, text, bigint, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_invoice_response(text, text, text, text, text, bigint, date, date) TO authenticated;
REVOKE ALL ON FUNCTION public.set_opportunity_state(text, text, text, text, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_opportunity_state(text, text, text, text, timestamptz) TO authenticated;
