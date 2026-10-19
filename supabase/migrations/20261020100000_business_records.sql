-- Business records: quotations, promised deposits, tasks, action owners, and a payment review queue.
-- Requires the earlier prepared migrations only for audit helpers already in the base schema;
-- it does not depend on 20261019200000 / 20261019210000, but 20261019220000 (scheduler) is redefined here.
--
-- Principles (same as the rest of the product):
--  * Writes go through RPCs that check role and workspace; tables are read-only to the browser (RLS).
--  * History is append-only. Statuses change; the events that caused them never do.
--  * A promise, a quotation or an owner's say-so is never revenue. Only imported payment evidence is verified.
--  * Imports never lose a valid record and never apply a payment twice.

-- ---------------------------------------------------------------------------------------------
-- Helpers (not callable by browsers)
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.require_actor(p_org_id text, p_roles text[]) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_actor text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000'; END IF;
  IF NOT private.has_org_role(p_org_id, p_roles) THEN RAISE EXCEPTION 'Workspace permission denied' USING ERRCODE = '42501'; END IF;
  SELECT u.id INTO v_actor FROM public.users u WHERE u.auth_subject = auth.uid() LIMIT 1;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Workspace membership is not initialized' USING ERRCODE = '42501'; END IF;
  RETURN v_actor;
END;
$function$;
REVOKE ALL ON FUNCTION private.require_actor(text, text[]) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.audit(p_org_id text, p_actor text, p_event text, p_entity_type text, p_entity_id text, p_details jsonb) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $function$
  INSERT INTO public.audit_log (organization_id, id, actor_user_id, event_type, entity_type, entity_id, details)
  VALUES (p_org_id, 'audit_' || pg_catalog.gen_random_uuid()::text, p_actor, p_event, p_entity_type, p_entity_id, p_details);
$function$;
REVOKE ALL ON FUNCTION private.audit(text, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.check_member(p_org_id text, p_user_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  IF p_user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.organization_id = p_org_id AND m.user_id = p_user_id) THEN
    RAISE EXCEPTION 'The chosen owner is not a member of this workspace' USING ERRCODE = '22023';
  END IF;
END;
$function$;
REVOKE ALL ON FUNCTION private.check_member(text, text) FROM PUBLIC, anon, authenticated;

-- Members of the caller's workspace (so owners can be chosen by name). Members only.
CREATE OR REPLACE FUNCTION public.list_workspace_members(p_org_id text) RETURNS TABLE (user_id text, email text, role text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000'; END IF;
  IF NOT private.is_org_member(p_org_id) THEN RAISE EXCEPTION 'Workspace permission denied' USING ERRCODE = '42501'; END IF;
  RETURN QUERY SELECT m.user_id, u.email, m.role FROM public.memberships m JOIN public.users u ON u.id = m.user_id
    WHERE m.organization_id = p_org_id ORDER BY u.email NULLS LAST, m.user_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.list_workspace_members(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_workspace_members(text) TO authenticated;

-- ---------------------------------------------------------------------------------------------
-- Quotations
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.quotations (
  organization_id text NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  id text NOT NULL CHECK (length(id) BETWEEN 1 AND 160),
  reference text NOT NULL CHECK (length(trim(reference)) BETWEEN 1 AND 80),
  customer_name text NOT NULL CHECK (length(trim(customer_name)) BETWEEN 1 AND 160),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 9000000000000000),
  sent_on date NOT NULL,
  valid_until date,
  status text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'accepted', 'declined', 'withdrawn')),
  follow_up_date date,
  last_contact_on date,
  owner_id text,
  notes text CHECK (notes IS NULL OR length(notes) <= 1000),
  closed_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, owner_id) REFERENCES public.memberships(organization_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, created_by) REFERENCES public.memberships(organization_id, user_id) ON DELETE RESTRICT,
  CHECK (valid_until IS NULL OR valid_until >= sent_on),
  CHECK (status <> 'sent' OR follow_up_date IS NOT NULL),
  CHECK ((status = 'sent' AND closed_at IS NULL) OR (status <> 'sent' AND closed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS quotations_open_idx ON public.quotations (organization_id, status, follow_up_date);

CREATE TABLE IF NOT EXISTS public.quotation_events (
  organization_id text NOT NULL,
  id text NOT NULL CHECK (length(id) BETWEEN 1 AND 160),
  quotation_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('created', 'follow_up_sent', 'customer_replied', 'rescheduled', 'accepted', 'declined', 'withdrawn', 'reopened', 'assigned', 'note')),
  summary text NOT NULL CHECK (length(trim(summary)) BETWEEN 1 AND 1000),
  follow_up_date date,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, quotation_id) REFERENCES public.quotations(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, created_by) REFERENCES public.memberships(organization_id, user_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS quotation_events_idx ON public.quotation_events (organization_id, quotation_id, created_at DESC);

-- ---------------------------------------------------------------------------------------------
-- Deposits (money a customer has PROMISED; verified only by imported payment evidence)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.deposits (
  organization_id text NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  id text NOT NULL CHECK (length(id) BETWEEN 1 AND 160),
  quotation_id text,
  customer_name text NOT NULL CHECK (length(trim(customer_name)) BETWEEN 1 AND 160),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 9000000000000000),
  promised_date date NOT NULL,
  -- promised: customer said they would pay; received_unverified: owner says it arrived, no imported evidence;
  -- received_verified: imported payment evidence covers the amount; cancelled: no longer expected.
  status text NOT NULL DEFAULT 'promised' CHECK (status IN ('promised', 'received_unverified', 'received_verified', 'cancelled')),
  owner_confirmed_minor bigint CHECK (owner_confirmed_minor IS NULL OR (owner_confirmed_minor > 0 AND owner_confirmed_minor <= 9000000000000000)),
  owner_confirmed_on date,
  note text CHECK (note IS NULL OR length(note) <= 1000),
  owner_id text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, quotation_id) REFERENCES public.quotations(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, owner_id) REFERENCES public.memberships(organization_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, created_by) REFERENCES public.memberships(organization_id, user_id) ON DELETE RESTRICT,
  CHECK ((status = 'received_unverified') = (owner_confirmed_minor IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS deposits_open_idx ON public.deposits (organization_id, status, promised_date);

CREATE TABLE IF NOT EXISTS public.deposit_events (
  organization_id text NOT NULL,
  id text NOT NULL CHECK (length(id) BETWEEN 1 AND 160),
  deposit_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('created', 'rescheduled', 'cancelled', 'reopened', 'confirmed_by_owner', 'payment_linked', 'note')),
  detail text NOT NULL CHECK (length(trim(detail)) BETWEEN 1 AND 1000),
  promised_date date,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, deposit_id) REFERENCES public.deposits(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, created_by) REFERENCES public.memberships(organization_id, user_id) ON DELETE RESTRICT
);

-- ---------------------------------------------------------------------------------------------
-- Payment review queue: payments that could not be matched safely. Nothing is dropped.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.payment_review_items (
  organization_id text NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  id text NOT NULL,
  source_id text NOT NULL,
  external_record_id text NOT NULL CHECK (length(external_record_id) BETWEEN 1 AND 240),
  invoice_number_raw text NOT NULL CHECK (length(invoice_number_raw) <= 240),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 9000000000000000),
  received_at timestamptz NOT NULL,
  reason text NOT NULL CHECK (reason IN ('invoice_not_found', 'invoice_ambiguous')),
  candidate_invoice_ids text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'dismissed')),
  resolution text CHECK (resolution IS NULL OR resolution IN ('to_invoice', 'to_deposit', 'dismissed', 'auto_matched')),
  resolved_invoice_id text,
  resolved_deposit_id text,
  resolution_note text CHECK (resolution_note IS NULL OR length(resolution_note) <= 500),
  resolved_by text,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, source_id, external_record_id),
  FOREIGN KEY (organization_id, source_id) REFERENCES public.data_sources(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, resolved_by) REFERENCES public.memberships(organization_id, user_id) ON DELETE RESTRICT,
  CHECK ((status = 'pending' AND resolution IS NULL AND resolved_at IS NULL)
      OR (status <> 'pending' AND resolution IS NOT NULL AND resolved_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS payment_review_pending_idx ON public.payment_review_items (organization_id, status, received_at);

-- Verified payments received against a deposit (resolved from the review queue). Immutable.
CREATE TABLE IF NOT EXISTS public.deposit_payments (
  organization_id text NOT NULL,
  id text NOT NULL,
  deposit_id text NOT NULL,
  review_item_id text NOT NULL,
  source_id text NOT NULL,
  external_record_id text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  received_at timestamptz NOT NULL,
  recorded_by text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, source_id, external_record_id),
  FOREIGN KEY (organization_id, deposit_id) REFERENCES public.deposits(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, review_item_id) REFERENCES public.payment_review_items(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, recorded_by) REFERENCES public.memberships(organization_id, user_id) ON DELETE RESTRICT
);

-- ---------------------------------------------------------------------------------------------
-- Tasks and action owners
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tasks (
  organization_id text NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  id text NOT NULL CHECK (length(id) BETWEEN 1 AND 160),
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 3 AND 200),
  detail text CHECK (detail IS NULL OR length(detail) <= 1000),
  due_date date NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  owner_id text,
  related_type text CHECK (related_type IS NULL OR related_type IN ('opportunity', 'quotation', 'deposit', 'lead', 'action', 'payment_review')),
  related_id text CHECK (related_id IS NULL OR length(related_id) <= 160),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, owner_id) REFERENCES public.memberships(organization_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, created_by) REFERENCES public.memberships(organization_id, user_id) ON DELETE RESTRICT,
  CHECK ((related_type IS NULL) = (related_id IS NULL)),
  CHECK ((status = 'open' AND closed_at IS NULL) OR (status <> 'open' AND closed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS tasks_open_idx ON public.tasks (organization_id, status, due_date);

CREATE TABLE IF NOT EXISTS public.task_events (
  organization_id text NOT NULL,
  id text NOT NULL CHECK (length(id) BETWEEN 1 AND 160),
  task_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('created', 'assigned', 'rescheduled', 'completed', 'cancelled', 'reopened', 'note')),
  detail text NOT NULL CHECK (length(trim(detail)) BETWEEN 1 AND 1000),
  due_date date,
  owner_id text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, task_id) REFERENCES public.tasks(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, created_by) REFERENCES public.memberships(organization_id, user_id) ON DELETE RESTRICT
);

-- Who is responsible for a recovery action (reminder). No row, or a null owner, means "unowned".
CREATE TABLE IF NOT EXISTS public.action_owners (
  organization_id text NOT NULL,
  action_id text NOT NULL,
  owner_id text,
  assigned_by text NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, action_id),
  FOREIGN KEY (organization_id, action_id) REFERENCES public.actions(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, owner_id) REFERENCES public.memberships(organization_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, assigned_by) REFERENCES public.memberships(organization_id, user_id) ON DELETE RESTRICT
);

-- ---------------------------------------------------------------------------------------------
-- Row level security: members read, nobody writes directly. History tables are immutable.
-- ---------------------------------------------------------------------------------------------
DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['quotations', 'quotation_events', 'deposits', 'deposit_events', 'payment_review_items', 'deposit_payments', 'tasks', 'task_events', 'action_owners'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_member_read', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (private.is_org_member(organization_id))', t || '_member_read', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['quotation_events', 'deposit_events', 'deposit_payments', 'task_events'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_immutable', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.prevent_immutable_record_mutation()', t || '_immutable', t);
  END LOOP;
END
$rls$;

-- Review items: the payment facts never change; only the resolution fields, once, from pending.
CREATE OR REPLACE FUNCTION public.guard_payment_review_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Payment review history cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.source_id IS DISTINCT FROM OLD.source_id
     OR NEW.external_record_id IS DISTINCT FROM OLD.external_record_id OR NEW.invoice_number_raw IS DISTINCT FROM OLD.invoice_number_raw
     OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor OR NEW.received_at IS DISTINCT FROM OLD.received_at
     OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.candidate_invoice_ids IS DISTINCT FROM OLD.candidate_invoice_ids OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'A recorded payment cannot be edited' USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'pending' THEN RAISE EXCEPTION 'A resolved payment review cannot change' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS payment_review_guard ON public.payment_review_items;
CREATE TRIGGER payment_review_guard BEFORE UPDATE OR DELETE ON public.payment_review_items
FOR EACH ROW EXECUTE FUNCTION public.guard_payment_review_mutation();

-- Status columns of quotations/deposits/tasks change through RPCs only; identity and money never change.
CREATE OR REPLACE FUNCTION public.guard_record_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '% records cannot be deleted', TG_TABLE_NAME USING ERRCODE = '55000'; END IF;
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Identity of a % record cannot change', TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  IF TG_TABLE_NAME IN ('quotations', 'deposits') THEN
    IF NEW.currency IS DISTINCT FROM OLD.currency OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor THEN
      RAISE EXCEPTION 'The amount and currency of a % record cannot change', TG_TABLE_NAME USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
DO $g$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['quotations', 'deposits', 'tasks'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_identity_guard', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.guard_record_identity()', t || '_identity_guard', t);
  END LOOP;
END
$g$;

-- ---------------------------------------------------------------------------------------------
-- Quotation RPCs
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_quotation(
  p_org_id text, p_id text, p_reference text, p_customer_name text, p_currency text, p_amount_minor bigint,
  p_sent_on date, p_valid_until date, p_follow_up_date date, p_owner_id text DEFAULT NULL, p_notes text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_actor text; v_existing public.quotations%ROWTYPE;
BEGIN
  v_actor := private.require_actor(p_org_id, ARRAY['owner', 'admin', 'operator']);
  IF p_id IS NULL OR length(trim(p_id)) NOT BETWEEN 1 AND 160 THEN RAISE EXCEPTION 'A valid quotation id is required' USING ERRCODE = '22023'; END IF;
  IF p_reference IS NULL OR length(trim(p_reference)) NOT BETWEEN 1 AND 80 THEN RAISE EXCEPTION 'A quotation reference of 1 to 80 characters is required' USING ERRCODE = '22023'; END IF;
  IF p_customer_name IS NULL OR length(trim(p_customer_name)) NOT BETWEEN 1 AND 160 THEN RAISE EXCEPTION 'A customer name is required' USING ERRCODE = '22023'; END IF;
  IF p_currency IS NULL OR p_currency !~ '^[A-Z]{3}$' THEN RAISE EXCEPTION 'Currency must be a three-letter code' USING ERRCODE = '22023'; END IF;
  IF p_amount_minor IS NULL OR p_amount_minor <= 0 OR p_amount_minor > 9000000000000000 THEN RAISE EXCEPTION 'The quotation amount must be positive' USING ERRCODE = '22023'; END IF;
  IF p_sent_on IS NULL OR p_sent_on > CURRENT_DATE THEN RAISE EXCEPTION 'The sent date cannot be in the future' USING ERRCODE = '22023'; END IF;
  IF p_valid_until IS NOT NULL AND p_valid_until < p_sent_on THEN RAISE EXCEPTION 'The quotation cannot expire before it was sent' USING ERRCODE = '22023'; END IF;
  IF p_follow_up_date IS NULL OR p_follow_up_date < p_sent_on THEN RAISE EXCEPTION 'Choose a follow-up date on or after the sent date' USING ERRCODE = '22023'; END IF;
  PERFORM private.check_member(p_org_id, p_owner_id);

  SELECT * INTO v_existing FROM public.quotations WHERE organization_id = p_org_id AND id = p_id;
  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object('id', v_existing.id, 'duplicate', true, 'status', v_existing.status);
  END IF;
  INSERT INTO public.quotations (organization_id, id, reference, customer_name, currency, amount_minor, sent_on, valid_until, follow_up_date, owner_id, notes, created_by)
  VALUES (p_org_id, p_id, trim(p_reference), trim(p_customer_name), p_currency, p_amount_minor, p_sent_on, p_valid_until, p_follow_up_date, p_owner_id, NULLIF(trim(COALESCE(p_notes, '')), ''), v_actor);
  INSERT INTO public.quotation_events (organization_id, id, quotation_id, event_type, summary, follow_up_date, created_by)
  VALUES (p_org_id, p_id || ':created', p_id, 'created', 'Quotation recorded as sent', p_follow_up_date, v_actor);
  PERFORM private.audit(p_org_id, v_actor, 'quotation_created', 'quotation', p_id,
    pg_catalog.jsonb_build_object('reference', trim(p_reference), 'amount_minor', p_amount_minor, 'currency', p_currency, 'follow_up_date', p_follow_up_date));
  RETURN pg_catalog.jsonb_build_object('id', p_id, 'duplicate', false, 'status', 'sent');
END;
$function$;

CREATE OR REPLACE FUNCTION public.record_quotation_event(
  p_org_id text, p_event_id text, p_quotation_id text, p_type text, p_summary text, p_next_follow_up date DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_actor text; v_q public.quotations%ROWTYPE; v_ev public.quotation_events%ROWTYPE; v_status text; v_follow date; v_contact date;
BEGIN
  v_actor := private.require_actor(p_org_id, ARRAY['owner', 'admin', 'operator']);
  IF p_event_id IS NULL OR length(trim(p_event_id)) NOT BETWEEN 1 AND 160 THEN RAISE EXCEPTION 'A valid event id is required' USING ERRCODE = '22023'; END IF;
  IF p_type IS NULL OR p_type NOT IN ('follow_up_sent', 'customer_replied', 'rescheduled', 'accepted', 'declined', 'withdrawn', 'reopened', 'note') THEN
    RAISE EXCEPTION 'Unsupported quotation event' USING ERRCODE = '22023';
  END IF;
  IF p_summary IS NULL OR length(trim(p_summary)) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'Describe what happened in 3 to 1000 characters' USING ERRCODE = '22023'; END IF;

  SELECT * INTO v_ev FROM public.quotation_events WHERE organization_id = p_org_id AND id = p_event_id;
  IF FOUND THEN
    IF v_ev.quotation_id <> p_quotation_id THEN RAISE EXCEPTION 'Event id already used for a different quotation' USING ERRCODE = '23505'; END IF;
    RETURN pg_catalog.jsonb_build_object('id', v_ev.id, 'duplicate', true);
  END IF;
  SELECT * INTO v_q FROM public.quotations WHERE organization_id = p_org_id AND id = p_quotation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quotation not found in this workspace' USING ERRCODE = 'P0002'; END IF;

  v_status := v_q.status; v_follow := v_q.follow_up_date; v_contact := v_q.last_contact_on;
  IF v_q.status <> 'sent' AND p_type NOT IN ('reopened', 'note') THEN
    RAISE EXCEPTION 'This quotation is closed; reopen it first' USING ERRCODE = '22023';
  END IF;
  IF v_q.status = 'sent' AND p_type = 'reopened' THEN RAISE EXCEPTION 'This quotation is already open' USING ERRCODE = '22023'; END IF;

  IF p_type IN ('follow_up_sent', 'customer_replied', 'rescheduled', 'reopened') THEN
    IF p_next_follow_up IS NULL OR p_next_follow_up < CURRENT_DATE THEN RAISE EXCEPTION 'Choose the next follow-up date (today or later)' USING ERRCODE = '22023'; END IF;
    v_follow := p_next_follow_up;
  END IF;
  IF p_type IN ('follow_up_sent', 'customer_replied') THEN v_contact := CURRENT_DATE; END IF;
  IF p_type = 'reopened' THEN v_status := 'sent'; END IF;
  IF p_type IN ('accepted', 'declined', 'withdrawn') THEN v_status := p_type; v_follow := NULL; END IF;

  INSERT INTO public.quotation_events (organization_id, id, quotation_id, event_type, summary, follow_up_date, created_by)
  VALUES (p_org_id, p_event_id, p_quotation_id, p_type, trim(p_summary), p_next_follow_up, v_actor);
  UPDATE public.quotations SET status = v_status, follow_up_date = v_follow, last_contact_on = v_contact,
         closed_at = CASE WHEN v_status = 'sent' THEN NULL WHEN v_q.status = 'sent' THEN pg_catalog.now() ELSE v_q.closed_at END
   WHERE organization_id = p_org_id AND id = p_quotation_id;
  PERFORM private.audit(p_org_id, v_actor, 'quotation_' || p_type, 'quotation', p_quotation_id,
    pg_catalog.jsonb_build_object('status', v_status, 'follow_up_date', v_follow, 'summary', trim(p_summary)));
  RETURN pg_catalog.jsonb_build_object('id', p_event_id, 'duplicate', false, 'status', v_status, 'follow_up_date', v_follow);
END;
$function$;

CREATE OR REPLACE FUNCTION public.assign_quotation(p_org_id text, p_event_id text, p_quotation_id text, p_owner_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_actor text; v_q public.quotations%ROWTYPE;
BEGIN
  v_actor := private.require_actor(p_org_id, ARRAY['owner', 'admin', 'operator']);
  PERFORM private.check_member(p_org_id, p_owner_id);
  IF EXISTS (SELECT 1 FROM public.quotation_events WHERE organization_id = p_org_id AND id = p_event_id) THEN
    RETURN pg_catalog.jsonb_build_object('id', p_event_id, 'duplicate', true);
  END IF;
  SELECT * INTO v_q FROM public.quotations WHERE organization_id = p_org_id AND id = p_quotation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quotation not found in this workspace' USING ERRCODE = 'P0002'; END IF;
  UPDATE public.quotations SET owner_id = p_owner_id WHERE organization_id = p_org_id AND id = p_quotation_id;
  INSERT INTO public.quotation_events (organization_id, id, quotation_id, event_type, summary, created_by)
  VALUES (p_org_id, p_event_id, p_quotation_id, 'assigned', CASE WHEN p_owner_id IS NULL THEN 'Owner removed' ELSE 'Owner assigned' END, v_actor);
  PERFORM private.audit(p_org_id, v_actor, 'quotation_assigned', 'quotation', p_quotation_id, pg_catalog.jsonb_build_object('owner_id', p_owner_id, 'previous_owner_id', v_q.owner_id));
  RETURN pg_catalog.jsonb_build_object('id', p_event_id, 'duplicate', false, 'owner_id', p_owner_id);
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- Deposit RPCs
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_deposit(
  p_org_id text, p_id text, p_quotation_id text, p_customer_name text, p_currency text, p_amount_minor bigint, p_promised_date date, p_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_actor text; v_q public.quotations%ROWTYPE; v_existing public.deposits%ROWTYPE; v_customer text := NULLIF(trim(COALESCE(p_customer_name, '')), ''); v_currency text := p_currency;
BEGIN
  v_actor := private.require_actor(p_org_id, ARRAY['owner', 'admin', 'operator']);
  IF p_id IS NULL OR length(trim(p_id)) NOT BETWEEN 1 AND 160 THEN RAISE EXCEPTION 'A valid deposit id is required' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_existing FROM public.deposits WHERE organization_id = p_org_id AND id = p_id;
  IF FOUND THEN RETURN pg_catalog.jsonb_build_object('id', p_id, 'duplicate', true, 'status', v_existing.status); END IF;
  IF p_quotation_id IS NOT NULL THEN
    SELECT * INTO v_q FROM public.quotations WHERE organization_id = p_org_id AND id = p_quotation_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Quotation not found in this workspace' USING ERRCODE = 'P0002'; END IF;
    IF v_q.status IN ('declined', 'withdrawn') THEN RAISE EXCEPTION 'A deposit cannot be promised against a declined or withdrawn quotation' USING ERRCODE = '22023'; END IF;
    v_customer := COALESCE(v_customer, v_q.customer_name);
    v_currency := COALESCE(v_currency, v_q.currency);
    IF v_currency <> v_q.currency THEN RAISE EXCEPTION 'The deposit currency must match the quotation currency' USING ERRCODE = '22023'; END IF;
    IF p_amount_minor > v_q.amount_minor THEN RAISE EXCEPTION 'A deposit cannot exceed the quotation amount' USING ERRCODE = '22023'; END IF;
  END IF;
  IF v_customer IS NULL OR length(v_customer) > 160 THEN RAISE EXCEPTION 'A customer name is required' USING ERRCODE = '22023'; END IF;
  IF v_currency IS NULL OR v_currency !~ '^[A-Z]{3}$' THEN RAISE EXCEPTION 'Currency must be a three-letter code' USING ERRCODE = '22023'; END IF;
  IF p_amount_minor IS NULL OR p_amount_minor <= 0 OR p_amount_minor > 9000000000000000 THEN RAISE EXCEPTION 'The deposit amount must be positive' USING ERRCODE = '22023'; END IF;
  IF p_promised_date IS NULL OR p_promised_date < CURRENT_DATE THEN RAISE EXCEPTION 'The promised date cannot be in the past' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.deposits (organization_id, id, quotation_id, customer_name, currency, amount_minor, promised_date, note, created_by)
  VALUES (p_org_id, p_id, p_quotation_id, v_customer, v_currency, p_amount_minor, p_promised_date, NULLIF(trim(COALESCE(p_note, '')), ''), v_actor);
  INSERT INTO public.deposit_events (organization_id, id, deposit_id, event_type, detail, promised_date, created_by)
  VALUES (p_org_id, p_id || ':created', p_id, 'created', 'Deposit promised by the customer (a promise, not money received)', p_promised_date, v_actor);
  PERFORM private.audit(p_org_id, v_actor, 'deposit_created', 'deposit', p_id,
    pg_catalog.jsonb_build_object('amount_minor', p_amount_minor, 'currency', v_currency, 'promised_date', p_promised_date, 'quotation_id', p_quotation_id));
  RETURN pg_catalog.jsonb_build_object('id', p_id, 'duplicate', false, 'status', 'promised');
END;
$function$;

-- action: reschedule | cancel | reopen | confirm_received | note
CREATE OR REPLACE FUNCTION public.update_deposit(
  p_org_id text, p_event_id text, p_deposit_id text, p_action text, p_note text, p_promised_date date DEFAULT NULL,
  p_received_minor bigint DEFAULT NULL, p_received_on date DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_actor text; v_d public.deposits%ROWTYPE; v_status text; v_date date; v_conf bigint; v_conf_on date; v_type text;
BEGIN
  v_actor := private.require_actor(p_org_id, ARRAY['owner', 'admin', 'operator']);
  IF p_action IS NULL OR p_action NOT IN ('reschedule', 'cancel', 'reopen', 'confirm_received', 'note') THEN RAISE EXCEPTION 'Unsupported deposit action' USING ERRCODE = '22023'; END IF;
  IF p_note IS NULL OR length(trim(p_note)) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'Add a note of 3 to 1000 characters' USING ERRCODE = '22023'; END IF;
  IF EXISTS (SELECT 1 FROM public.deposit_events WHERE organization_id = p_org_id AND id = p_event_id) THEN
    RETURN pg_catalog.jsonb_build_object('id', p_event_id, 'duplicate', true);
  END IF;
  SELECT * INTO v_d FROM public.deposits WHERE organization_id = p_org_id AND id = p_deposit_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Deposit not found in this workspace' USING ERRCODE = 'P0002'; END IF;
  v_status := v_d.status; v_date := v_d.promised_date; v_conf := v_d.owner_confirmed_minor; v_conf_on := v_d.owner_confirmed_on;

  IF p_action = 'reschedule' THEN
    IF v_d.status <> 'promised' THEN RAISE EXCEPTION 'Only a promised deposit can be rescheduled' USING ERRCODE = '22023'; END IF;
    IF p_promised_date IS NULL OR p_promised_date < CURRENT_DATE THEN RAISE EXCEPTION 'Choose a new promised date (today or later)' USING ERRCODE = '22023'; END IF;
    v_date := p_promised_date; v_type := 'rescheduled';
  ELSIF p_action = 'cancel' THEN
    IF v_d.status NOT IN ('promised', 'received_unverified') THEN RAISE EXCEPTION 'This deposit cannot be cancelled' USING ERRCODE = '22023'; END IF;
    v_status := 'cancelled'; v_conf := NULL; v_conf_on := NULL; v_type := 'cancelled';
  ELSIF p_action = 'reopen' THEN
    IF v_d.status NOT IN ('cancelled', 'received_unverified') THEN RAISE EXCEPTION 'Only a cancelled or unverified deposit can be reopened' USING ERRCODE = '22023'; END IF;
    IF p_promised_date IS NULL OR p_promised_date < CURRENT_DATE THEN RAISE EXCEPTION 'Choose a new promised date (today or later)' USING ERRCODE = '22023'; END IF;
    v_status := 'promised'; v_date := p_promised_date; v_conf := NULL; v_conf_on := NULL; v_type := 'reopened';
  ELSIF p_action = 'confirm_received' THEN
    IF v_d.status <> 'promised' THEN RAISE EXCEPTION 'Only a promised deposit can be confirmed' USING ERRCODE = '22023'; END IF;
    IF p_received_minor IS NULL OR p_received_minor <= 0 OR p_received_minor > v_d.amount_minor THEN RAISE EXCEPTION 'The received amount must be positive and not above the promised deposit' USING ERRCODE = '22023'; END IF;
    IF p_received_on IS NULL OR p_received_on > CURRENT_DATE THEN RAISE EXCEPTION 'The received date cannot be in the future' USING ERRCODE = '22023'; END IF;
    v_status := 'received_unverified'; v_conf := p_received_minor; v_conf_on := p_received_on; v_type := 'confirmed_by_owner';
  ELSE
    v_type := 'note';
  END IF;

  INSERT INTO public.deposit_events (organization_id, id, deposit_id, event_type, detail, promised_date, created_by)
  VALUES (p_org_id, p_event_id, p_deposit_id, v_type, trim(p_note), v_date, v_actor);
  UPDATE public.deposits SET status = v_status, promised_date = v_date, owner_confirmed_minor = v_conf, owner_confirmed_on = v_conf_on
   WHERE organization_id = p_org_id AND id = p_deposit_id;
  PERFORM private.audit(p_org_id, v_actor, 'deposit_' || v_type, 'deposit', p_deposit_id,
    pg_catalog.jsonb_build_object('status', v_status, 'promised_date', v_date, 'owner_confirmed_minor', v_conf, 'note', trim(p_note)));
  RETURN pg_catalog.jsonb_build_object('id', p_event_id, 'duplicate', false, 'status', v_status, 'promised_date', v_date);
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- Task RPCs
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_task(
  p_org_id text, p_id text, p_title text, p_detail text, p_due_date date, p_owner_id text DEFAULT NULL,
  p_related_type text DEFAULT NULL, p_related_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_actor text; v_found boolean;
BEGIN
  v_actor := private.require_actor(p_org_id, ARRAY['owner', 'admin', 'operator']);
  IF p_id IS NULL OR length(trim(p_id)) NOT BETWEEN 1 AND 160 THEN RAISE EXCEPTION 'A valid task id is required' USING ERRCODE = '22023'; END IF;
  IF EXISTS (SELECT 1 FROM public.tasks WHERE organization_id = p_org_id AND id = p_id) THEN
    RETURN pg_catalog.jsonb_build_object('id', p_id, 'duplicate', true);
  END IF;
  IF p_title IS NULL OR length(trim(p_title)) NOT BETWEEN 3 AND 200 THEN RAISE EXCEPTION 'A task title of 3 to 200 characters is required' USING ERRCODE = '22023'; END IF;
  IF p_due_date IS NULL OR p_due_date < CURRENT_DATE THEN RAISE EXCEPTION 'The due date cannot be in the past' USING ERRCODE = '22023'; END IF;
  PERFORM private.check_member(p_org_id, p_owner_id);
  IF (p_related_type IS NULL) <> (p_related_id IS NULL) THEN RAISE EXCEPTION 'Give both the related record type and id, or neither' USING ERRCODE = '22023'; END IF;
  IF p_related_type IS NOT NULL THEN
    v_found := CASE p_related_type
      WHEN 'opportunity' THEN EXISTS (SELECT 1 FROM public.opportunities x WHERE x.organization_id = p_org_id AND x.id = p_related_id)
      WHEN 'quotation' THEN EXISTS (SELECT 1 FROM public.quotations x WHERE x.organization_id = p_org_id AND x.id = p_related_id)
      WHEN 'deposit' THEN EXISTS (SELECT 1 FROM public.deposits x WHERE x.organization_id = p_org_id AND x.id = p_related_id)
      WHEN 'lead' THEN EXISTS (SELECT 1 FROM public.sales_leads x WHERE x.organization_id = p_org_id AND x.id = p_related_id)
      WHEN 'action' THEN EXISTS (SELECT 1 FROM public.actions x WHERE x.organization_id = p_org_id AND x.id = p_related_id)
      WHEN 'payment_review' THEN EXISTS (SELECT 1 FROM public.payment_review_items x WHERE x.organization_id = p_org_id AND x.id = p_related_id)
      ELSE false END;
    IF NOT v_found THEN RAISE EXCEPTION 'The related record was not found in this workspace' USING ERRCODE = 'P0002'; END IF;
  END IF;
  INSERT INTO public.tasks (organization_id, id, title, detail, due_date, owner_id, related_type, related_id, created_by)
  VALUES (p_org_id, p_id, trim(p_title), NULLIF(trim(COALESCE(p_detail, '')), ''), p_due_date, p_owner_id, p_related_type, p_related_id, v_actor);
  INSERT INTO public.task_events (organization_id, id, task_id, event_type, detail, due_date, owner_id, created_by)
  VALUES (p_org_id, p_id || ':created', p_id, 'created', 'Task created', p_due_date, p_owner_id, v_actor);
  PERFORM private.audit(p_org_id, v_actor, 'task_created', 'task', p_id,
    pg_catalog.jsonb_build_object('title', trim(p_title), 'due_date', p_due_date, 'owner_id', p_owner_id, 'related_type', p_related_type, 'related_id', p_related_id));
  RETURN pg_catalog.jsonb_build_object('id', p_id, 'duplicate', false, 'status', 'open');
END;
$function$;

-- action: assign | reschedule | complete | cancel | reopen | note
CREATE OR REPLACE FUNCTION public.update_task(
  p_org_id text, p_event_id text, p_task_id text, p_action text, p_note text DEFAULT NULL, p_due_date date DEFAULT NULL, p_owner_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_actor text; v_t public.tasks%ROWTYPE; v_status text; v_due date; v_owner text; v_type text; v_detail text := NULLIF(trim(COALESCE(p_note, '')), '');
BEGIN
  v_actor := private.require_actor(p_org_id, ARRAY['owner', 'admin', 'operator']);
  IF p_action IS NULL OR p_action NOT IN ('assign', 'reschedule', 'complete', 'cancel', 'reopen', 'note') THEN RAISE EXCEPTION 'Unsupported task action' USING ERRCODE = '22023'; END IF;
  IF EXISTS (SELECT 1 FROM public.task_events WHERE organization_id = p_org_id AND id = p_event_id) THEN
    RETURN pg_catalog.jsonb_build_object('id', p_event_id, 'duplicate', true);
  END IF;
  SELECT * INTO v_t FROM public.tasks WHERE organization_id = p_org_id AND id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Task not found in this workspace' USING ERRCODE = 'P0002'; END IF;
  v_status := v_t.status; v_due := v_t.due_date; v_owner := v_t.owner_id;
  IF v_detail IS NOT NULL AND length(v_detail) > 1000 THEN RAISE EXCEPTION 'Keep the note under 1000 characters' USING ERRCODE = '22023'; END IF;

  IF p_action = 'assign' THEN
    IF v_t.status <> 'open' THEN RAISE EXCEPTION 'Only an open task can be assigned' USING ERRCODE = '22023'; END IF;
    PERFORM private.check_member(p_org_id, p_owner_id);
    v_owner := p_owner_id; v_type := 'assigned'; v_detail := COALESCE(v_detail, CASE WHEN p_owner_id IS NULL THEN 'Owner removed' ELSE 'Owner assigned' END);
  ELSIF p_action = 'reschedule' THEN
    IF v_t.status <> 'open' THEN RAISE EXCEPTION 'Only an open task can be rescheduled' USING ERRCODE = '22023'; END IF;
    IF p_due_date IS NULL OR p_due_date < CURRENT_DATE THEN RAISE EXCEPTION 'Choose a new due date (today or later)' USING ERRCODE = '22023'; END IF;
    IF v_detail IS NULL OR length(v_detail) < 3 THEN RAISE EXCEPTION 'Say why the task is being moved' USING ERRCODE = '22023'; END IF;
    v_due := p_due_date; v_type := 'rescheduled';
  ELSIF p_action = 'complete' THEN
    IF v_t.status <> 'open' THEN RAISE EXCEPTION 'Only an open task can be completed' USING ERRCODE = '22023'; END IF;
    v_status := 'done'; v_type := 'completed'; v_detail := COALESCE(v_detail, 'Marked done');
  ELSIF p_action = 'cancel' THEN
    IF v_t.status <> 'open' THEN RAISE EXCEPTION 'Only an open task can be cancelled' USING ERRCODE = '22023'; END IF;
    IF v_detail IS NULL OR length(v_detail) < 3 THEN RAISE EXCEPTION 'Say why the task is cancelled' USING ERRCODE = '22023'; END IF;
    v_status := 'cancelled'; v_type := 'cancelled';
  ELSIF p_action = 'reopen' THEN
    IF v_t.status = 'open' THEN RAISE EXCEPTION 'This task is already open' USING ERRCODE = '22023'; END IF;
    IF p_due_date IS NULL OR p_due_date < CURRENT_DATE THEN RAISE EXCEPTION 'Choose a new due date (today or later)' USING ERRCODE = '22023'; END IF;
    IF v_detail IS NULL OR length(v_detail) < 3 THEN RAISE EXCEPTION 'Say why the task is being reopened' USING ERRCODE = '22023'; END IF;
    v_status := 'open'; v_due := p_due_date; v_type := 'reopened';
  ELSE
    IF v_detail IS NULL OR length(v_detail) < 3 THEN RAISE EXCEPTION 'Write a note of at least 3 characters' USING ERRCODE = '22023'; END IF;
    v_type := 'note';
  END IF;

  INSERT INTO public.task_events (organization_id, id, task_id, event_type, detail, due_date, owner_id, created_by)
  VALUES (p_org_id, p_event_id, p_task_id, v_type, v_detail, v_due, v_owner, v_actor);
  UPDATE public.tasks SET status = v_status, due_date = v_due, owner_id = v_owner,
         closed_at = CASE WHEN v_status = 'open' THEN NULL WHEN v_t.status = 'open' THEN pg_catalog.now() ELSE v_t.closed_at END
   WHERE organization_id = p_org_id AND id = p_task_id;
  PERFORM private.audit(p_org_id, v_actor, 'task_' || v_type, 'task', p_task_id,
    pg_catalog.jsonb_build_object('status', v_status, 'due_date', v_due, 'owner_id', v_owner, 'detail', v_detail));
  RETURN pg_catalog.jsonb_build_object('id', p_event_id, 'duplicate', false, 'status', v_status, 'due_date', v_due, 'owner_id', v_owner);
END;
$function$;

CREATE OR REPLACE FUNCTION public.assign_action_owner(p_org_id text, p_action_id text, p_owner_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_actor text; v_prev text;
BEGIN
  v_actor := private.require_actor(p_org_id, ARRAY['owner', 'admin', 'operator']);
  PERFORM private.check_member(p_org_id, p_owner_id);
  IF NOT EXISTS (SELECT 1 FROM public.actions a WHERE a.organization_id = p_org_id AND a.id = p_action_id) THEN
    RAISE EXCEPTION 'Action not found in this workspace' USING ERRCODE = 'P0002';
  END IF;
  SELECT o.owner_id INTO v_prev FROM public.action_owners o WHERE o.organization_id = p_org_id AND o.action_id = p_action_id;
  INSERT INTO public.action_owners (organization_id, action_id, owner_id, assigned_by) VALUES (p_org_id, p_action_id, p_owner_id, v_actor)
  ON CONFLICT (organization_id, action_id) DO UPDATE SET owner_id = EXCLUDED.owner_id, assigned_by = EXCLUDED.assigned_by, assigned_at = pg_catalog.now();
  PERFORM private.audit(p_org_id, v_actor, 'action_owner_assigned', 'action', p_action_id, pg_catalog.jsonb_build_object('owner_id', p_owner_id, 'previous_owner_id', v_prev));
  RETURN pg_catalog.jsonb_build_object('action_id', p_action_id, 'owner_id', p_owner_id);
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- Payments: keep every valid record, queue the ones that cannot be matched safely.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.match_invoice(p_org_id text, p_invoice_number text, p_currency text, OUT o_count integer, OUT o_ids text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $function$
  SELECT count(*)::integer, COALESCE(array_agg(i.id ORDER BY i.id), '{}'::text[])
    FROM public.invoices i
   WHERE i.organization_id = p_org_id AND i.invoice_number = trim(p_invoice_number) AND i.currency = p_currency;
$function$;
REVOKE ALL ON FUNCTION private.match_invoice(text, text, text) FROM PUBLIC, anon, authenticated;

-- Applies a matched payment exactly once. Returns true when a new evidence row was written.
CREATE OR REPLACE FUNCTION private.apply_payment(p_org_id text, p_invoice_id text, p_source_id text, p_external text, p_amount bigint, p_currency text, p_received timestamptz, p_mark boolean DEFAULT true) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_inserted boolean;
BEGIN
  INSERT INTO public.payment_evidence (organization_id, id, invoice_id, source_id, external_record_id, amount_minor, currency, received_at, imported_at)
  VALUES (p_org_id, 'payment_' || pg_catalog.gen_random_uuid()::text, p_invoice_id, p_source_id, p_external, p_amount, p_currency, p_received, pg_catalog.now())
  ON CONFLICT (organization_id, source_id, external_record_id) DO NOTHING;
  v_inserted := FOUND;
  -- A payment that now has evidence can no longer be waiting in the review queue.
  IF p_mark THEN
    UPDATE public.payment_review_items SET status = 'resolved', resolution = 'auto_matched', resolved_invoice_id = p_invoice_id, resolved_at = pg_catalog.now()
     WHERE organization_id = p_org_id AND source_id = p_source_id AND external_record_id = p_external AND status = 'pending';
  END IF;
  RETURN v_inserted;
END;
$function$;
REVOKE ALL ON FUNCTION private.apply_payment(text, text, text, text, bigint, text, timestamptz, boolean) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.persist_payment_import(
  p_org_id text, p_source_id text, p_source_name text, p_content_hash text, p_rows jsonb, p_rejected_rows integer DEFAULT 0
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_actor text; v_import_id text; v_row jsonb; v_match record; v_accepted integer := 0; v_review integer := 0; v_total integer;
  v_amount bigint; v_currency text; v_received_at timestamptz; v_reference text; v_number text; v_queued boolean;
BEGIN
  v_actor := private.require_actor(p_org_id, ARRAY['owner', 'admin', 'operator']);
  IF p_source_id IS NULL OR length(trim(p_source_id)) NOT BETWEEN 1 AND 240 OR p_source_name IS NULL OR length(trim(p_source_name)) NOT BETWEEN 1 AND 160 THEN RAISE EXCEPTION 'A valid payment source ID and file name are required' USING ERRCODE = '22023'; END IF;
  IF p_content_hash IS NULL OR p_content_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'A SHA-256 content hash is required' USING ERRCODE = '22023'; END IF;
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows) > 50000 THEN RAISE EXCEPTION 'Payment rows must be an array of at most 50000 records' USING ERRCODE = '22023'; END IF;
  IF p_rejected_rows IS NULL OR p_rejected_rows < 0 OR p_rejected_rows > 50000 THEN RAISE EXCEPTION 'Rejected row count is invalid' USING ERRCODE = '22023'; END IF;

  INSERT INTO public.data_sources (organization_id, id, name, kind, created_by) VALUES (p_org_id, p_source_id, left(trim(p_source_name), 160), 'payment_export', v_actor) ON CONFLICT (organization_id, id) DO NOTHING;
  v_total := jsonb_array_length(p_rows) + p_rejected_rows;
  v_import_id := 'payment_import_' || pg_catalog.gen_random_uuid()::text;
  INSERT INTO public.imports (organization_id, id, source_id, status, content_hash, total_rows, accepted_rows, rejected_rows, created_by)
  VALUES (p_org_id, v_import_id, p_source_id, CASE WHEN p_rejected_rows > 0 THEN 'completed_with_errors' ELSE 'completed' END, p_content_hash, v_total, jsonb_array_length(p_rows), p_rejected_rows, v_actor)
  ON CONFLICT (organization_id, source_id, content_hash) DO NOTHING;
  IF NOT FOUND THEN
    SELECT i.id INTO v_import_id FROM public.imports i WHERE i.organization_id = p_org_id AND i.source_id = p_source_id AND i.content_hash = p_content_hash LIMIT 1;
    RETURN pg_catalog.jsonb_build_object('duplicate', true, 'import_id', v_import_id, 'accepted_rows', 0, 'review_rows', 0, 'rejected_rows', p_rejected_rows);
  END IF;

  FOR v_row IN SELECT value FROM pg_catalog.jsonb_array_elements(p_rows) LOOP
    v_reference := trim(coalesce(v_row->>'externalRecordId', ''));
    v_currency := upper(trim(coalesce(v_row->>'currency', '')));
    v_number := trim(coalesce(v_row->>'invoiceNumber', ''));
    IF length(v_reference) = 0 OR length(v_reference) > 240 OR v_currency !~ '^[A-Z]{3}$' THEN RAISE EXCEPTION 'Payment reference or currency is invalid' USING ERRCODE = '22023'; END IF;
    IF coalesce(v_row->>'amountMinor', '') !~ '^[0-9]+$' THEN RAISE EXCEPTION 'Payment amount must be positive integer minor units' USING ERRCODE = '22023'; END IF;
    v_amount := (v_row->>'amountMinor')::bigint;
    IF v_amount <= 0 OR v_amount > 9000000000000000 THEN RAISE EXCEPTION 'Payment amount is outside the supported range' USING ERRCODE = '22023'; END IF;
    v_received_at := (v_row->>'receivedAt')::timestamptz;
    SELECT * INTO v_match FROM private.match_invoice(p_org_id, v_number, v_currency);

    IF v_match.o_count = 1 THEN
      IF private.apply_payment(p_org_id, v_match.o_ids[1], p_source_id, v_reference, v_amount, v_currency, v_received_at) THEN v_accepted := v_accepted + 1; END IF;
    ELSE
      -- Not found or ambiguous: keep the payment for a person to place. Never dropped, never guessed.
      INSERT INTO public.payment_review_items (organization_id, id, source_id, external_record_id, invoice_number_raw, currency, amount_minor, received_at, reason, candidate_invoice_ids)
      SELECT p_org_id, 'review_' || pg_catalog.gen_random_uuid()::text, p_source_id, v_reference, left(v_number, 240), v_currency, v_amount, v_received_at,
             CASE WHEN v_match.o_count = 0 THEN 'invoice_not_found' ELSE 'invoice_ambiguous' END, v_match.o_ids
       WHERE NOT EXISTS (SELECT 1 FROM public.payment_evidence pe WHERE pe.organization_id = p_org_id AND pe.source_id = p_source_id AND pe.external_record_id = v_reference)
      ON CONFLICT (organization_id, source_id, external_record_id) DO NOTHING;
      v_queued := FOUND;
      IF v_queued THEN v_review := v_review + 1; END IF;
    END IF;
  END LOOP;
  PERFORM private.audit(p_org_id, v_actor, 'payment_import', 'import', v_import_id,
    pg_catalog.jsonb_build_object('accepted_rows', v_accepted, 'review_rows', v_review, 'rejected_rows', p_rejected_rows));
  RETURN pg_catalog.jsonb_build_object('duplicate', false, 'import_id', v_import_id, 'accepted_rows', v_accepted, 'review_rows', v_review, 'rejected_rows', p_rejected_rows);
END;
$function$;

-- Re-checks pending payments against the current invoices. Safe to repeat. Only exact, single matches are applied.
CREATE OR REPLACE FUNCTION private.rematch_payment_review(p_org_id text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_item public.payment_review_items%ROWTYPE; v_match record; v_done integer := 0;
BEGIN
  FOR v_item IN SELECT * FROM public.payment_review_items WHERE organization_id = p_org_id AND status = 'pending' ORDER BY created_at, id FOR UPDATE LOOP
    SELECT * INTO v_match FROM private.match_invoice(p_org_id, v_item.invoice_number_raw, v_item.currency);
    IF v_match.o_count = 1 THEN
      PERFORM private.apply_payment(p_org_id, v_match.o_ids[1], v_item.source_id, v_item.external_record_id, v_item.amount_minor, v_item.currency, v_item.received_at);
      v_done := v_done + 1;
    END IF;
  END LOOP;
  RETURN v_done;
END;
$function$;
REVOKE ALL ON FUNCTION private.rematch_payment_review(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.rematch_payment_review(p_org_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_actor text; v_done integer;
BEGIN
  v_actor := private.require_actor(p_org_id, ARRAY['owner', 'admin', 'operator']);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('rematch_payment_review:' || p_org_id, 0));
  v_done := private.rematch_payment_review(p_org_id);
  IF v_done > 0 THEN PERFORM private.audit(p_org_id, v_actor, 'payment_review_rematched', 'payment_review', 'batch', pg_catalog.jsonb_build_object('matched', v_done)); END IF;
  RETURN pg_catalog.jsonb_build_object('matched', v_done, 'still_pending', (SELECT count(*) FROM public.payment_review_items WHERE organization_id = p_org_id AND status = 'pending'));
END;
$function$;

-- action: to_invoice | to_deposit | dismiss
CREATE OR REPLACE FUNCTION public.resolve_payment_review(p_org_id text, p_item_id text, p_action text, p_target_id text DEFAULT NULL, p_note text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  v_actor text; v_item public.payment_review_items%ROWTYPE; v_inv public.invoices%ROWTYPE; v_dep public.deposits%ROWTYPE;
  v_note text := NULLIF(trim(COALESCE(p_note, '')), ''); v_sum bigint;
BEGIN
  v_actor := private.require_actor(p_org_id, ARRAY['owner', 'admin', 'operator']);
  IF p_action IS NULL OR p_action NOT IN ('to_invoice', 'to_deposit', 'dismiss') THEN RAISE EXCEPTION 'Unsupported review action' USING ERRCODE = '22023'; END IF;
  IF v_note IS NOT NULL AND length(v_note) > 500 THEN RAISE EXCEPTION 'Keep the note under 500 characters' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_item FROM public.payment_review_items WHERE organization_id = p_org_id AND id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found in this workspace' USING ERRCODE = 'P0002'; END IF;
  IF v_item.status <> 'pending' THEN RETURN pg_catalog.jsonb_build_object('id', p_item_id, 'duplicate', true, 'status', v_item.status); END IF;

  IF p_action = 'dismiss' THEN
    IF v_note IS NULL OR length(v_note) < 3 THEN RAISE EXCEPTION 'Say why this payment is being set aside' USING ERRCODE = '22023'; END IF;
    UPDATE public.payment_review_items SET status = 'dismissed', resolution = 'dismissed', resolution_note = v_note, resolved_by = v_actor, resolved_at = pg_catalog.now()
     WHERE organization_id = p_org_id AND id = p_item_id;
  ELSIF p_action = 'to_invoice' THEN
    SELECT * INTO v_inv FROM public.invoices WHERE organization_id = p_org_id AND id = p_target_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found in this workspace' USING ERRCODE = 'P0002'; END IF;
    IF v_inv.currency <> v_item.currency THEN RAISE EXCEPTION 'The payment currency does not match the invoice currency' USING ERRCODE = '22023'; END IF;
    IF NOT private.apply_payment(p_org_id, v_inv.id, v_item.source_id, v_item.external_record_id, v_item.amount_minor, v_item.currency, v_item.received_at, false) THEN
      RAISE EXCEPTION 'This payment is already recorded' USING ERRCODE = '23505';
    END IF;
    UPDATE public.payment_review_items SET status = 'resolved', resolution = 'to_invoice', resolved_invoice_id = v_inv.id, resolution_note = v_note, resolved_by = v_actor, resolved_at = pg_catalog.now()
     WHERE organization_id = p_org_id AND id = p_item_id;
  ELSE
    SELECT * INTO v_dep FROM public.deposits WHERE organization_id = p_org_id AND id = p_target_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Deposit not found in this workspace' USING ERRCODE = 'P0002'; END IF;
    IF v_dep.currency <> v_item.currency THEN RAISE EXCEPTION 'The payment currency does not match the deposit currency' USING ERRCODE = '22023'; END IF;
    IF v_dep.status = 'cancelled' THEN RAISE EXCEPTION 'This deposit is cancelled' USING ERRCODE = '22023'; END IF;
    IF v_dep.status = 'received_verified' THEN RAISE EXCEPTION 'This deposit is already fully verified' USING ERRCODE = '22023'; END IF;
    INSERT INTO public.deposit_payments (organization_id, id, deposit_id, review_item_id, source_id, external_record_id, amount_minor, currency, received_at, recorded_by)
    VALUES (p_org_id, 'depay_' || pg_catalog.gen_random_uuid()::text, v_dep.id, v_item.id, v_item.source_id, v_item.external_record_id, v_item.amount_minor, v_item.currency, v_item.received_at, v_actor);
    SELECT COALESCE(sum(amount_minor), 0) INTO v_sum FROM public.deposit_payments WHERE organization_id = p_org_id AND deposit_id = v_dep.id;
    UPDATE public.deposits SET status = CASE WHEN v_sum >= v_dep.amount_minor THEN 'received_verified' ELSE v_dep.status END,
           owner_confirmed_minor = CASE WHEN v_sum >= v_dep.amount_minor THEN NULL ELSE v_dep.owner_confirmed_minor END,
           owner_confirmed_on = CASE WHEN v_sum >= v_dep.amount_minor THEN NULL ELSE v_dep.owner_confirmed_on END
     WHERE organization_id = p_org_id AND id = v_dep.id;
    INSERT INTO public.deposit_events (organization_id, id, deposit_id, event_type, detail, created_by)
    VALUES (p_org_id, 'depev_' || pg_catalog.gen_random_uuid()::text, v_dep.id, 'payment_linked', 'Imported payment evidence linked to this deposit', v_actor);
    UPDATE public.payment_review_items SET status = 'resolved', resolution = 'to_deposit', resolved_deposit_id = v_dep.id, resolution_note = v_note, resolved_by = v_actor, resolved_at = pg_catalog.now()
     WHERE organization_id = p_org_id AND id = p_item_id;
  END IF;
  PERFORM private.audit(p_org_id, v_actor, 'payment_review_' || p_action, 'payment_review', p_item_id,
    pg_catalog.jsonb_build_object('amount_minor', v_item.amount_minor, 'currency', v_item.currency, 'target', p_target_id, 'note', v_note));
  RETURN pg_catalog.jsonb_build_object('id', p_item_id, 'duplicate', false, 'status', CASE WHEN p_action = 'dismiss' THEN 'dismissed' ELSE 'resolved' END);
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- Scheduler: also re-match waiting payments (still safe to repeat; still sends nothing).
-- ---------------------------------------------------------------------------------------------
ALTER TABLE IF EXISTS public.evaluation_runs ADD COLUMN IF NOT EXISTS matched_payments integer NOT NULL DEFAULT 0;

DO $sched$
BEGIN
  IF to_regprocedure('private.run_org_evaluation(text,text)') IS NOT NULL THEN
    CREATE OR REPLACE FUNCTION private.run_org_evaluation(p_org_id text, p_trigger text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $f$
    DECLARE
      v_subject text; v_result jsonb; v_started timestamptz := pg_catalog.clock_timestamp(); v_matched integer := 0;
    BEGIN
      SELECT u.auth_subject INTO v_subject
        FROM public.memberships m JOIN public.users u ON u.id = m.user_id
       WHERE m.organization_id = p_org_id AND m.role = 'owner'
       ORDER BY m.created_at, m.user_id LIMIT 1;
      IF v_subject IS NULL THEN
        INSERT INTO public.evaluation_runs (organization_id, id, trigger_kind, status, started_at, message)
        VALUES (p_org_id, 'run_' || pg_catalog.gen_random_uuid()::text, p_trigger, 'skipped', v_started, 'Workspace has no owner to evaluate as');
        RETURN 'skipped';
      END IF;
      BEGIN
        PERFORM pg_catalog.set_config('request.jwt.claim.sub', v_subject, true);
        PERFORM pg_catalog.set_config('request.jwt.claims', pg_catalog.jsonb_build_object('sub', v_subject, 'role', 'authenticated')::text, true);
        PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('rematch_payment_review:' || p_org_id, 0));
        v_matched := private.rematch_payment_review(p_org_id);
        IF NOT EXISTS (SELECT 1 FROM public.assumptions a WHERE a.organization_id = p_org_id AND a.id = 'recovery-rate') THEN
          INSERT INTO public.evaluation_runs (organization_id, id, trigger_kind, status, started_at, matched_payments, message)
          VALUES (p_org_id, 'run_' || pg_catalog.gen_random_uuid()::text, p_trigger, 'skipped', v_started, v_matched, 'No recovery-rate assumption is set');
          RETURN 'skipped';
        END IF;
        v_result := public.sync_overdue_opportunities(p_org_id);
        INSERT INTO public.evaluation_runs (organization_id, id, trigger_kind, status, started_at, created_count, refreshed_count, closed_count, open_count, matched_payments)
        VALUES (p_org_id, 'run_' || pg_catalog.gen_random_uuid()::text, p_trigger, 'ok', v_started,
                COALESCE((v_result->>'created')::integer, 0), COALESCE((v_result->>'refreshed')::integer, 0),
                COALESCE((v_result->>'closed')::integer, 0), COALESCE((v_result->>'open')::integer, 0), v_matched);
        RETURN 'ok';
      EXCEPTION WHEN OTHERS THEN
        INSERT INTO public.evaluation_runs (organization_id, id, trigger_kind, status, started_at, message)
        VALUES (p_org_id, 'run_' || pg_catalog.gen_random_uuid()::text, p_trigger, 'failed', v_started, pg_catalog.left(SQLSTATE || ' ' || SQLERRM, 500));
        RETURN 'failed';
      END;
    END;
    $f$;
    REVOKE ALL ON FUNCTION private.run_org_evaluation(text, text) FROM PUBLIC, anon, authenticated;
  END IF;
END
$sched$;

-- Grants for the RPCs
DO $grants$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.create_quotation(text,text,text,text,text,bigint,date,date,date,text,text)',
    'public.record_quotation_event(text,text,text,text,text,date)',
    'public.assign_quotation(text,text,text,text)',
    'public.create_deposit(text,text,text,text,text,bigint,date,text)',
    'public.update_deposit(text,text,text,text,text,date,bigint,date)',
    'public.create_task(text,text,text,text,date,text,text,text)',
    'public.update_task(text,text,text,text,text,date,text)',
    'public.assign_action_owner(text,text,text)',
    'public.rematch_payment_review(text)',
    'public.resolve_payment_review(text,text,text,text,text)',
    'public.persist_payment_import(text,text,text,text,jsonb,integer)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
END
$grants$;
