-- Business Brain: sourced, auditable business facts and assumptions.
-- Independent of 20261019200000 (invoice responses); either may be applied first.
--
-- Facts the owner states (or imports) are stored with where they came from. Nothing is overwritten:
-- a changed value supersedes the old row, which stays as history. Two active facts with different values
-- for the same key are a visible conflict until the owner resolves it. Facts derived from records
-- (invoice totals, counts) are NOT stored here; they are computed live from the records.

CREATE TABLE IF NOT EXISTS public.brain_facts (
  organization_id text NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  id text NOT NULL CHECK (length(id) BETWEEN 1 AND 160),
  fact_key text NOT NULL CHECK (fact_key ~ '^[a-z][a-z0-9_]{1,60}$'),
  kind text NOT NULL CHECK (kind IN ('user_entered', 'imported', 'assumption', 'estimate')),
  value_text text NOT NULL CHECK (length(value_text) BETWEEN 1 AND 500),
  source_label text NOT NULL CHECK (length(source_label) BETWEEN 1 AND 200),
  source_ref text CHECK (source_ref IS NULL OR length(source_ref) <= 200),
  note text CHECK (note IS NULL OR length(note) <= 500),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'retracted')),
  superseded_by text,
  status_reason text CHECK (status_reason IS NULL OR length(status_reason) <= 500),
  status_changed_at timestamptz,
  status_changed_by text,
  recorded_by text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, recorded_by) REFERENCES public.memberships(organization_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, status_changed_by) REFERENCES public.memberships(organization_id, user_id) ON DELETE RESTRICT,
  CHECK ((status = 'active' AND status_changed_at IS NULL) OR (status <> 'active' AND status_changed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS brain_facts_key_idx ON public.brain_facts (organization_id, fact_key, recorded_at DESC);

-- Only the status columns may change, and only through the RPCs. The value, source and author are permanent.
CREATE OR REPLACE FUNCTION public.guard_brain_fact_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Business Brain history cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.fact_key IS DISTINCT FROM OLD.fact_key OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.value_text IS DISTINCT FROM OLD.value_text OR NEW.source_label IS DISTINCT FROM OLD.source_label
     OR NEW.source_ref IS DISTINCT FROM OLD.source_ref OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at THEN
    RAISE EXCEPTION 'A recorded fact cannot be edited; record a new value instead' USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'active' THEN
    RAISE EXCEPTION 'A superseded or retracted fact is history and cannot change' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS brain_facts_guard ON public.brain_facts;
CREATE TRIGGER brain_facts_guard BEFORE UPDATE OR DELETE ON public.brain_facts
FOR EACH ROW EXECUTE FUNCTION public.guard_brain_fact_mutation();

ALTER TABLE public.brain_facts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS brain_facts_member_read ON public.brain_facts;
CREATE POLICY brain_facts_member_read ON public.brain_facts
  FOR SELECT TO authenticated USING (private.is_org_member(organization_id));
REVOKE ALL ON public.brain_facts FROM anon, authenticated;
GRANT SELECT ON public.brain_facts TO authenticated;

-- Validation shared by the RPC: known keys have numeric ranges the attention rules rely on.
CREATE OR REPLACE FUNCTION private.brain_value_error(p_key text, p_value text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $function$
DECLARE
  v_min integer; v_max integer;
BEGIN
  SELECT r.lo, r.hi INTO v_min, v_max FROM (VALUES
    ('payment_terms_days', 0, 365), ('quote_follow_up_days', 1, 90), ('enquiry_response_hours', 1, 720),
    ('lead_stall_days', 1, 365), ('deposit_percent', 0, 100)
  ) AS r(k, lo, hi) WHERE r.k = p_key;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF p_value !~ '^\d{1,4}$' THEN
    RETURN p_key || ' must be a whole number';
  END IF;
  IF p_value::integer < v_min OR p_value::integer > v_max THEN
    RETURN p_key || ' must be between ' || v_min || ' and ' || v_max;
  END IF;
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION private.brain_value_error(text, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.record_brain_fact(
  p_org_id text, p_fact_id text, p_key text, p_value text, p_kind text,
  p_source_label text, p_source_ref text DEFAULT NULL, p_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  v_actor text; v_value text; v_error text; v_existing public.brain_facts%ROWTYPE;
  v_prev public.brain_facts%ROWTYPE; v_conflict boolean;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000'; END IF;
  IF NOT private.has_org_role(p_org_id, ARRAY['owner', 'admin', 'operator']) THEN
    RAISE EXCEPTION 'Workspace permission denied' USING ERRCODE = '42501';
  END IF;
  IF p_fact_id IS NULL OR length(trim(p_fact_id)) NOT BETWEEN 1 AND 160 THEN
    RAISE EXCEPTION 'A valid fact id is required' USING ERRCODE = '22023';
  END IF;
  IF p_key IS NULL OR p_key !~ '^[a-z][a-z0-9_]{1,60}$' THEN
    RAISE EXCEPTION 'Fact keys are lowercase letters, digits and underscores' USING ERRCODE = '22023';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('user_entered', 'imported', 'assumption', 'estimate') THEN
    RAISE EXCEPTION 'Unsupported fact kind' USING ERRCODE = '22023';
  END IF;
  v_value := trim(COALESCE(p_value, ''));
  IF length(v_value) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'A value of 1 to 500 characters is required' USING ERRCODE = '22023';
  END IF;
  IF p_source_label IS NULL OR length(trim(p_source_label)) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Say where this fact comes from' USING ERRCODE = '22023';
  END IF;
  v_error := private.brain_value_error(p_key, v_value);
  IF v_error IS NOT NULL THEN RAISE EXCEPTION '%', v_error USING ERRCODE = '22023'; END IF;

  SELECT u.id INTO v_actor FROM public.users u WHERE u.auth_subject = auth.uid() LIMIT 1;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Workspace membership is not initialized' USING ERRCODE = '42501'; END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_org_id || ':' || p_key));

  SELECT * INTO v_existing FROM public.brain_facts WHERE organization_id = p_org_id AND id = p_fact_id;
  IF FOUND THEN
    IF v_existing.fact_key <> p_key THEN
      RAISE EXCEPTION 'Fact id already used for a different key' USING ERRCODE = '23505';
    END IF;
    RETURN pg_catalog.jsonb_build_object('id', v_existing.id, 'duplicate', true, 'key', v_existing.fact_key);
  END IF;

  -- The newest value of the same kind replaces the older one (kept as history). Other kinds stay active.
  SELECT * INTO v_prev FROM public.brain_facts
   WHERE organization_id = p_org_id AND fact_key = p_key AND kind = p_kind AND status = 'active'
   ORDER BY recorded_at DESC LIMIT 1;

  INSERT INTO public.brain_facts (organization_id, id, fact_key, kind, value_text, source_label, source_ref, note, recorded_by)
  VALUES (p_org_id, p_fact_id, p_key, p_kind, v_value, trim(p_source_label), NULLIF(trim(COALESCE(p_source_ref, '')), ''),
          NULLIF(trim(COALESCE(p_note, '')), ''), v_actor);

  IF v_prev.id IS NOT NULL THEN
    UPDATE public.brain_facts SET status = 'superseded', superseded_by = p_fact_id,
           status_reason = 'Replaced by a newer value', status_changed_at = now(), status_changed_by = v_actor
     WHERE organization_id = p_org_id AND id = v_prev.id;
  END IF;

  SELECT count(DISTINCT lower(f.value_text)) > 1 INTO v_conflict
    FROM public.brain_facts f WHERE f.organization_id = p_org_id AND f.fact_key = p_key AND f.status = 'active';

  INSERT INTO public.audit_log (organization_id, id, actor_user_id, event_type, entity_type, entity_id, details)
  VALUES (p_org_id, 'audit_' || pg_catalog.gen_random_uuid()::text, v_actor, 'brain_fact_recorded', 'brain_fact', p_fact_id,
    pg_catalog.jsonb_build_object('key', p_key, 'kind', p_kind, 'value', v_value, 'source', trim(p_source_label),
      'replaced_fact_id', v_prev.id, 'replaced_value', v_prev.value_text, 'conflict', COALESCE(v_conflict, false)));

  RETURN pg_catalog.jsonb_build_object('id', p_fact_id, 'duplicate', false, 'key', p_key, 'conflict', COALESCE(v_conflict, false));
END;
$function$;

CREATE OR REPLACE FUNCTION public.retract_brain_fact(p_org_id text, p_fact_id text, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_actor text; v_fact public.brain_facts%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000'; END IF;
  IF NOT private.has_org_role(p_org_id, ARRAY['owner', 'admin', 'operator']) THEN
    RAISE EXCEPTION 'Workspace permission denied' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'Give a reason of 3 to 500 characters' USING ERRCODE = '22023';
  END IF;
  SELECT u.id INTO v_actor FROM public.users u WHERE u.auth_subject = auth.uid() LIMIT 1;
  SELECT * INTO v_fact FROM public.brain_facts WHERE organization_id = p_org_id AND id = p_fact_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Fact not found in this workspace' USING ERRCODE = 'P0002'; END IF;
  IF v_fact.status <> 'active' THEN RAISE EXCEPTION 'Only an active fact can be retracted' USING ERRCODE = '22023'; END IF;
  UPDATE public.brain_facts SET status = 'retracted', status_reason = trim(p_reason), status_changed_at = now(), status_changed_by = v_actor
   WHERE organization_id = p_org_id AND id = p_fact_id;
  INSERT INTO public.audit_log (organization_id, id, actor_user_id, event_type, entity_type, entity_id, details)
  VALUES (p_org_id, 'audit_' || pg_catalog.gen_random_uuid()::text, v_actor, 'brain_fact_retracted', 'brain_fact', p_fact_id,
    pg_catalog.jsonb_build_object('key', v_fact.fact_key, 'value', v_fact.value_text, 'reason', trim(p_reason)));
  RETURN pg_catalog.jsonb_build_object('id', p_fact_id, 'status', 'retracted');
END;
$function$;

CREATE OR REPLACE FUNCTION public.resolve_brain_conflict(p_org_id text, p_key text, p_keep_fact_id text, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_actor text; v_keep public.brain_facts%ROWTYPE; v_distinct integer; v_closed integer;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000'; END IF;
  IF NOT private.has_org_role(p_org_id, ARRAY['owner', 'admin', 'operator']) THEN
    RAISE EXCEPTION 'Workspace permission denied' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'Give a reason of 3 to 500 characters' USING ERRCODE = '22023';
  END IF;
  SELECT u.id INTO v_actor FROM public.users u WHERE u.auth_subject = auth.uid() LIMIT 1;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_org_id || ':' || p_key));
  SELECT * INTO v_keep FROM public.brain_facts
   WHERE organization_id = p_org_id AND id = p_keep_fact_id AND fact_key = p_key FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Fact not found for this key in this workspace' USING ERRCODE = 'P0002'; END IF;
  IF v_keep.status <> 'active' THEN RAISE EXCEPTION 'Keep an active fact' USING ERRCODE = '22023'; END IF;
  SELECT count(DISTINCT lower(f.value_text)) INTO v_distinct FROM public.brain_facts f
   WHERE f.organization_id = p_org_id AND f.fact_key = p_key AND f.status = 'active';
  IF v_distinct < 2 THEN RAISE EXCEPTION 'There is no conflict to resolve for this key' USING ERRCODE = '22023'; END IF;
  UPDATE public.brain_facts SET status = 'superseded', superseded_by = p_keep_fact_id,
         status_reason = 'Conflict resolved: ' || trim(p_reason), status_changed_at = now(), status_changed_by = v_actor
   WHERE organization_id = p_org_id AND fact_key = p_key AND status = 'active' AND id <> p_keep_fact_id;
  GET DIAGNOSTICS v_closed = ROW_COUNT;
  INSERT INTO public.audit_log (organization_id, id, actor_user_id, event_type, entity_type, entity_id, details)
  VALUES (p_org_id, 'audit_' || pg_catalog.gen_random_uuid()::text, v_actor, 'brain_conflict_resolved', 'brain_fact', p_keep_fact_id,
    pg_catalog.jsonb_build_object('key', p_key, 'kept_value', v_keep.value_text, 'closed', v_closed, 'reason', trim(p_reason)));
  RETURN pg_catalog.jsonb_build_object('key', p_key, 'kept', p_keep_fact_id, 'closed', v_closed);
END;
$function$;

REVOKE ALL ON FUNCTION public.record_brain_fact(text, text, text, text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_brain_fact(text, text, text, text, text, text, text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.retract_brain_fact(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.retract_brain_fact(text, text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.resolve_brain_conflict(text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_brain_conflict(text, text, text, text) TO authenticated;

-- The recovery-rate assumption already lives in public.assumptions. Give its changes an audit trail
-- so the Brain can show who changed it, from what, and when.
CREATE OR REPLACE FUNCTION public.audit_assumption_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.value_bps IS NOT DISTINCT FROM OLD.value_bps THEN RETURN NEW; END IF;
  INSERT INTO public.audit_log (organization_id, id, actor_user_id, event_type, entity_type, entity_id, details)
  VALUES (NEW.organization_id, 'audit_' || pg_catalog.gen_random_uuid()::text, NEW.updated_by, 'assumption_changed', 'assumption', NEW.id,
    pg_catalog.jsonb_build_object('key', NEW.assumption_key,
      'old_bps', CASE WHEN TG_OP = 'UPDATE' THEN OLD.value_bps END, 'new_bps', NEW.value_bps));
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.audit_assumption_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS assumptions_audit ON public.assumptions;
CREATE TRIGGER assumptions_audit AFTER INSERT OR UPDATE ON public.assumptions
FOR EACH ROW EXECUTE FUNCTION public.audit_assumption_change();
