
-- Revenue OS core schema
-- PostgreSQL / Supabase
-- Money is stored as integer minor units.
-- All business records are scoped to an organization.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =========================================================
-- 1. Identity and organizations
-- =========================================================

CREATE TABLE public.organizations (
    id text PRIMARY KEY,
    name text NOT NULL
        CHECK (length(trim(name)) BETWEEN 1 AND 160),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.users (
    id text PRIMARY KEY,
    auth_subject uuid NOT NULL UNIQUE
        REFERENCES auth.users(id) ON DELETE RESTRICT,
    email text,
    display_name text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.memberships (
    organization_id text NOT NULL
        REFERENCES public.organizations(id) ON DELETE RESTRICT,
    user_id text NOT NULL
        REFERENCES public.users(id) ON DELETE RESTRICT,
    role text NOT NULL
        CHECK (role IN ('owner', 'admin', 'analyst', 'operator', 'viewer')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, user_id)
);

CREATE INDEX memberships_user_idx
    ON public.memberships(user_id, organization_id);

-- =========================================================
-- 2. Data sources and imports
-- =========================================================

CREATE TABLE public.data_sources (
    organization_id text NOT NULL
        REFERENCES public.organizations(id) ON DELETE RESTRICT,
    id text NOT NULL,
    name text NOT NULL
        CHECK (length(trim(name)) BETWEEN 1 AND 160),
    kind text NOT NULL
        CHECK (kind IN ('csv_import', 'accounting', 'payment_export', 'manual')),
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, id),
    FOREIGN KEY (organization_id, created_by)
        REFERENCES public.memberships(organization_id, user_id)
        ON DELETE RESTRICT
);

CREATE TABLE public.imports (
    organization_id text NOT NULL,
    id text NOT NULL,
    source_id text NOT NULL,
    status text NOT NULL
        CHECK (status IN ('processing', 'completed', 'completed_with_errors', 'failed')),
    content_hash text NOT NULL
        CHECK (length(content_hash) BETWEEN 1 AND 256),
    total_rows integer NOT NULL CHECK (total_rows >= 0),
    accepted_rows integer NOT NULL CHECK (accepted_rows >= 0),
    rejected_rows integer NOT NULL CHECK (rejected_rows >= 0),
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, id),
    UNIQUE (organization_id, source_id, content_hash),
    CHECK (accepted_rows + rejected_rows <= total_rows),
    FOREIGN KEY (organization_id, source_id)
        REFERENCES public.data_sources(organization_id, id)
        ON DELETE RESTRICT,
    FOREIGN KEY (organization_id, created_by)
        REFERENCES public.memberships(organization_id, user_id)
        ON DELETE RESTRICT
);

-- =========================================================
-- 3. Invoices and assumptions
-- =========================================================

CREATE TABLE public.invoices (
    organization_id text NOT NULL,
    id text NOT NULL,
    source_id text NOT NULL,
    import_id text NOT NULL,
    external_record_id text NOT NULL,
    customer_id text NOT NULL,
    customer_name text NOT NULL,
    invoice_number text NOT NULL,
    currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    total_minor bigint NOT NULL CHECK (total_minor > 0 AND total_minor <= 9000000000000000),
    paid_minor bigint NOT NULL CHECK (paid_minor >= 0 AND paid_minor <= total_minor),
    issued_at timestamptz NOT NULL,
    due_at timestamptz NOT NULL,
    imported_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, id),
    UNIQUE (organization_id, source_id, external_record_id),
    FOREIGN KEY (organization_id, source_id) REFERENCES public.data_sources(organization_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (organization_id, import_id) REFERENCES public.imports(organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX invoices_due_idx ON public.invoices(organization_id, due_at, currency);
CREATE INDEX invoices_customer_idx ON public.invoices(organization_id, customer_id, invoice_number);

CREATE TABLE public.assumptions (
    organization_id text NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
    id text NOT NULL,
    assumption_key text NOT NULL CHECK (assumption_key IN ('recovery_rate')),
    value_bps integer NOT NULL CHECK (value_bps BETWEEN 0 AND 10000),
    updated_by text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, id),
    FOREIGN KEY (organization_id, updated_by) REFERENCES public.memberships(organization_id, user_id) ON DELETE RESTRICT
);

-- =========================================================
-- 4. Opportunities and supporting evidence
-- =========================================================
CREATE TABLE public.opportunities (
    organization_id text NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
    id text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('overdue_invoice')),
    status text NOT NULL CHECK (status IN ('open', 'accepted', 'dismissed', 'closed')),
    currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    outstanding_minor bigint NOT NULL CHECK (outstanding_minor > 0 AND outstanding_minor <= 9000000000000000),
    estimate_low_minor bigint NOT NULL CHECK (estimate_low_minor >= 0 AND estimate_low_minor <= 9000000000000000),
    estimate_high_minor bigint NOT NULL CHECK (estimate_high_minor >= estimate_low_minor AND estimate_high_minor <= 9000000000000000),
    assumption_id text NOT NULL,
    detected_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, id),
    FOREIGN KEY (organization_id, assumption_id) REFERENCES public.assumptions(organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX opportunities_status_idx ON public.opportunities(organization_id, status, detected_at);

CREATE TABLE public.opportunity_evidence (
    organization_id text NOT NULL,
    opportunity_id text NOT NULL,
    invoice_id text NOT NULL,
    PRIMARY KEY (organization_id, opportunity_id, invoice_id),
    FOREIGN KEY (organization_id, opportunity_id) REFERENCES public.opportunities(organization_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (organization_id, invoice_id) REFERENCES public.invoices(organization_id, id) ON DELETE RESTRICT
);

-- =========================================================
-- 5. Human-approved actions
-- =========================================================
CREATE TABLE public.actions (
    organization_id text NOT NULL,
    id text NOT NULL,
    opportunity_id text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('payment_reminder')),
    status text NOT NULL CHECK (status IN ('proposed', 'approved', 'executed', 'failed', 'cancelled')),
    recipient_customer_id text NOT NULL,
    message text NOT NULL,
    execution_mode text NOT NULL CHECK (execution_mode = 'manual'),
    proposed_by text NOT NULL,
    proposed_at timestamptz NOT NULL DEFAULT now(),
    approved_by text,
    approved_at timestamptz,
    executed_by text,
    executed_at timestamptz,
    PRIMARY KEY (organization_id, id),
    FOREIGN KEY (organization_id, opportunity_id) REFERENCES public.opportunities(organization_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (organization_id, proposed_by) REFERENCES public.memberships(organization_id, user_id) ON DELETE RESTRICT,
    FOREIGN KEY (organization_id, approved_by) REFERENCES public.memberships(organization_id, user_id) ON DELETE RESTRICT,
    FOREIGN KEY (organization_id, executed_by) REFERENCES public.memberships(organization_id, user_id) ON DELETE RESTRICT,
    CHECK ((status IN ('approved', 'executed', 'failed') AND approved_by IS NOT NULL AND approved_at IS NOT NULL) OR status IN ('proposed', 'cancelled')),
    CHECK ((status = 'executed' AND executed_by IS NOT NULL AND executed_at IS NOT NULL) OR status <> 'executed')
);
CREATE INDEX actions_opportunity_idx ON public.actions(organization_id, opportunity_id, proposed_at);

CREATE TABLE public.action_invoice_targets (
    organization_id text NOT NULL,
    action_id text NOT NULL,
    invoice_id text NOT NULL,
    PRIMARY KEY (organization_id, action_id, invoice_id),
    FOREIGN KEY (organization_id, action_id) REFERENCES public.actions(organization_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (organization_id, invoice_id) REFERENCES public.invoices(organization_id, id) ON DELETE RESTRICT
);

-- =========================================================
-- 6. Payment evidence and outcomes
-- =========================================================
CREATE TABLE public.payment_evidence (
    organization_id text NOT NULL,
    id text NOT NULL,
    invoice_id text NOT NULL,
    source_id text NOT NULL,
    external_record_id text NOT NULL,
    amount_minor bigint NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 9000000000000000),
    currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    received_at timestamptz NOT NULL,
    imported_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, id),
    UNIQUE (organization_id, source_id, external_record_id),
    FOREIGN KEY (organization_id, invoice_id) REFERENCES public.invoices(organization_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (organization_id, source_id) REFERENCES public.data_sources(organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX payments_invoice_time_idx ON public.payment_evidence(organization_id, invoice_id, received_at);

CREATE TABLE public.outcomes (
    organization_id text NOT NULL,
    id text NOT NULL,
    action_id text NOT NULL,
    opportunity_id text NOT NULL,
    state text NOT NULL CHECK (state IN ('reported', 'verified')),
    method text NOT NULL CHECK (method IN ('human_report', 'matched_payment_record')),
    amount_minor bigint NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 9000000000000000),
    currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    measurement_starts_at timestamptz NOT NULL,
    measurement_ends_at timestamptz NOT NULL,
    causal_claim text NOT NULL CHECK (causal_claim = 'observed_after_action_not_proven_causal'),
    recorded_by text NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, id),
    FOREIGN KEY (organization_id, action_id) REFERENCES public.actions(organization_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (organization_id, opportunity_id) REFERENCES public.opportunities(organization_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (organization_id, recorded_by) REFERENCES public.memberships(organization_id, user_id) ON DELETE RESTRICT,
    CHECK ((state = 'reported' AND method = 'human_report') OR (state = 'verified' AND method = 'matched_payment_record')),
    CHECK (measurement_ends_at >= measurement_starts_at)
);
CREATE INDEX outcomes_action_idx ON public.outcomes(organization_id, action_id, recorded_at);

CREATE TABLE public.outcome_payment_evidence (
    organization_id text NOT NULL,
    outcome_id text NOT NULL,
    payment_evidence_id text NOT NULL,
    PRIMARY KEY (organization_id, outcome_id, payment_evidence_id),
    FOREIGN KEY (organization_id, outcome_id) REFERENCES public.outcomes(organization_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (organization_id, payment_evidence_id) REFERENCES public.payment_evidence(organization_id, id) ON DELETE RESTRICT
);

-- =========================================================
-- 7. Stalled follow-ups MVP
-- =========================================================
CREATE TABLE public.stalled_opportunities (
    organization_id text NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
    id text NOT NULL,
    prospect_label text NOT NULL CHECK (length(trim(prospect_label)) BETWEEN 1 AND 200),
    stage text NOT NULL CHECK (stage IN ('lead', 'contacted', 'quoted', 'negotiation', 'won', 'lost')),
    next_step text,
    due_date date,
    quoted_value_minor bigint CHECK (quoted_value_minor IS NULL OR quoted_value_minor >= 0),
    currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, id),
    FOREIGN KEY (organization_id, created_by) REFERENCES public.memberships(organization_id, user_id) ON DELETE RESTRICT,
    CHECK ((quoted_value_minor IS NULL AND currency IS NULL) OR (quoted_value_minor IS NOT NULL AND currency IS NOT NULL))
);

-- =========================================================
-- 8. Append-only audit log
-- =========================================================
CREATE TABLE public.audit_log (
    organization_id text NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
    id text NOT NULL,
    actor_user_id text,
    event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 120),
    entity_type text NOT NULL CHECK (length(entity_type) BETWEEN 1 AND 120),
    entity_id text NOT NULL,
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, id),
    FOREIGN KEY (organization_id, actor_user_id) REFERENCES public.memberships(organization_id, user_id) ON DELETE RESTRICT
);
CREATE INDEX audit_entity_idx ON public.audit_log(organization_id, entity_type, entity_id, created_at);

-- =========================================================
-- 9. Integrity triggers
-- =========================================================
CREATE FUNCTION public.guard_action_status_transition() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'proposed' OR NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL OR NEW.executed_by IS NOT NULL OR NEW.executed_at IS NOT NULL THEN RAISE EXCEPTION 'Actions must start proposed and unapproved'; END IF;
    ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
        IF NOT ((OLD.status = 'proposed' AND NEW.status IN ('approved', 'cancelled')) OR (OLD.status = 'approved' AND NEW.status IN ('executed', 'failed', 'cancelled'))) THEN RAISE EXCEPTION 'Invalid action status transition'; END IF;
    END IF;
    RETURN NEW;
END; $$;
CREATE TRIGGER actions_status_guard BEFORE INSERT OR UPDATE OF status ON public.actions FOR EACH ROW EXECUTE FUNCTION public.guard_action_status_transition();

CREATE FUNCTION public.guard_outcome_insert() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE action_row record;
BEGIN
    IF NEW.state <> 'reported' OR NEW.method <> 'human_report' THEN RAISE EXCEPTION 'Outcomes must start as reported human observations'; END IF;
    SELECT a.opportunity_id, a.status, a.executed_at INTO action_row FROM public.actions AS a WHERE a.organization_id = NEW.organization_id AND a.id = NEW.action_id;
    IF NOT FOUND OR action_row.opportunity_id <> NEW.opportunity_id OR action_row.status <> 'executed' OR action_row.executed_at <> NEW.measurement_starts_at THEN RAISE EXCEPTION 'Outcome requires an executed action on the same opportunity'; END IF;
    RETURN NEW;
END; $$;
CREATE TRIGGER outcomes_insert_guard BEFORE INSERT ON public.outcomes FOR EACH ROW EXECUTE FUNCTION public.guard_outcome_insert();

CREATE FUNCTION public.guard_outcome_verification() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE matching_count bigint; matching_total bigint; opportunity_currency text; opportunity_outstanding bigint;
BEGIN
    IF NEW.state IS DISTINCT FROM OLD.state AND NOT (OLD.state = 'reported' AND NEW.state = 'verified') THEN RAISE EXCEPTION 'Invalid outcome state transition'; END IF;
    IF NEW.state = 'verified' AND OLD.state <> 'verified' THEN
        IF NEW.method <> 'matched_payment_record' THEN RAISE EXCEPTION 'Verified outcomes require matched payment records'; END IF;
        SELECT count(*), COALESCE(sum(p.amount_minor), 0) INTO matching_count, matching_total FROM public.outcome_payment_evidence AS link JOIN public.payment_evidence AS p ON p.organization_id = link.organization_id AND p.id = link.payment_evidence_id JOIN public.opportunity_evidence AS oe ON oe.organization_id = p.organization_id AND oe.invoice_id = p.invoice_id WHERE link.organization_id = NEW.organization_id AND link.outcome_id = NEW.id AND oe.opportunity_id = NEW.opportunity_id AND p.currency = NEW.currency AND p.received_at >= NEW.measurement_starts_at AND p.received_at <= NEW.measurement_ends_at;
        SELECT o.currency, o.outstanding_minor INTO opportunity_currency, opportunity_outstanding FROM public.opportunities AS o WHERE o.organization_id = NEW.organization_id AND o.id = NEW.opportunity_id;
        IF matching_count = 0 OR matching_total <> NEW.amount_minor OR opportunity_currency IS DISTINCT FROM NEW.currency OR NEW.amount_minor > opportunity_outstanding THEN RAISE EXCEPTION 'Verified outcome requires matching linked payment evidence'; END IF;
    END IF;
    RETURN NEW;
END; $$;
CREATE TRIGGER outcomes_verification_guard BEFORE UPDATE OF state ON public.outcomes FOR EACH ROW EXECUTE FUNCTION public.guard_outcome_verification();

CREATE FUNCTION public.guard_opportunity_invoice_currency() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.opportunities AS o JOIN public.invoices AS i ON i.organization_id = o.organization_id WHERE o.organization_id = NEW.organization_id AND o.id = NEW.opportunity_id AND i.id = NEW.invoice_id AND i.currency = o.currency) THEN RAISE EXCEPTION 'Opportunity and invoice currencies must match'; END IF;
    RETURN NEW;
END; $$;
CREATE TRIGGER opportunity_evidence_currency_guard BEFORE INSERT OR UPDATE ON public.opportunity_evidence FOR EACH ROW EXECUTE FUNCTION public.guard_opportunity_invoice_currency();

CREATE FUNCTION public.guard_payment_currency() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.invoices AS i WHERE i.organization_id = NEW.organization_id AND i.id = NEW.invoice_id AND i.currency = NEW.currency) THEN RAISE EXCEPTION 'Payment evidence currency must match invoice currency'; END IF;
    RETURN NEW;
END; $$;
CREATE TRIGGER payment_evidence_currency_guard BEFORE INSERT OR UPDATE ON public.payment_evidence FOR EACH ROW EXECUTE FUNCTION public.guard_payment_currency();

CREATE FUNCTION public.prevent_immutable_record_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN RAISE EXCEPTION '% is immutable', TG_TABLE_NAME; END; $$;
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON public.audit_log FOR EACH ROW EXECUTE FUNCTION public.prevent_immutable_record_mutation();
CREATE TRIGGER payment_evidence_immutable BEFORE UPDATE OR DELETE ON public.payment_evidence FOR EACH ROW EXECUTE FUNCTION public.prevent_immutable_record_mutation();

-- =========================================================
-- 10. Tenant-isolation helper functions
-- =========================================================
CREATE FUNCTION public.is_org_member(target_org_id text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT EXISTS (SELECT 1 FROM public.memberships AS m JOIN public.users AS u ON u.id = m.user_id WHERE m.organization_id = target_org_id AND u.auth_subject = (SELECT auth.uid())); $$;
CREATE FUNCTION public.has_org_role(target_org_id text, allowed_roles text[]) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT EXISTS (SELECT 1 FROM public.memberships AS m JOIN public.users AS u ON u.id = m.user_id WHERE m.organization_id = target_org_id AND u.auth_subject = (SELECT auth.uid()) AND m.role = ANY(allowed_roles)); $$;
REVOKE ALL ON FUNCTION public.is_org_member(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.has_org_role(text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_org_member(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_org_role(text, text[]) TO authenticated;

-- =========================================================
-- 11. Row-level security
-- =========================================================
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY organizations_member_read ON public.organizations FOR SELECT TO authenticated USING (public.is_org_member(id));
CREATE POLICY organizations_admin_update ON public.organizations FOR UPDATE TO authenticated USING (public.has_org_role(id, ARRAY['owner', 'admin'])) WITH CHECK (public.has_org_role(id, ARRAY['owner', 'admin']));
CREATE POLICY users_read_self ON public.users FOR SELECT TO authenticated USING (auth_subject = (SELECT auth.uid()));
CREATE POLICY users_update_self ON public.users FOR UPDATE TO authenticated USING (auth_subject = (SELECT auth.uid())) WITH CHECK (auth_subject = (SELECT auth.uid()));
CREATE POLICY memberships_member_read ON public.memberships FOR SELECT TO authenticated USING (public.is_org_member(organization_id));
CREATE POLICY memberships_admin_insert ON public.memberships FOR INSERT TO authenticated WITH CHECK (public.has_org_role(organization_id, ARRAY['owner', 'admin']));
CREATE POLICY memberships_admin_update ON public.memberships FOR UPDATE TO authenticated USING (public.has_org_role(organization_id, ARRAY['owner', 'admin'])) WITH CHECK (public.has_org_role(organization_id, ARRAY['owner', 'admin']));
CREATE POLICY memberships_admin_delete ON public.memberships FOR DELETE TO authenticated USING (public.has_org_role(organization_id, ARRAY['owner', 'admin']));
DO $$ DECLARE table_name text; tenant_tables text[] := ARRAY['data_sources','imports','invoices','assumptions','opportunities','opportunity_evidence','actions','action_invoice_targets','payment_evidence','outcomes','outcome_payment_evidence','audit_log','stalled_opportunities']; BEGIN FOREACH table_name IN ARRAY tenant_tables LOOP EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name); EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.is_org_member(organization_id))', table_name || '_member_read', table_name); EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (public.has_org_role(organization_id, ARRAY[''owner'', ''admin'', ''operator'']))', table_name || '_member_insert', table_name); END LOOP; END; $$;
COMMIT;
