-- Unified provider-neutral business signal store.
-- Signals are append-only evidence observations; retries are idempotent per
-- organization + source + idempotency key. Provider adapters must validate
-- tenant membership and normalize records before inserting.
BEGIN;

CREATE TABLE public.business_signals (
    organization_id text NOT NULL
        REFERENCES public.organizations(id) ON DELETE RESTRICT,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    source_id text NOT NULL CHECK (length(trim(source_id)) BETWEEN 1 AND 256),
    provider text NOT NULL CHECK (length(trim(provider)) BETWEEN 1 AND 64),
    signal_type text NOT NULL CHECK (signal_type IN (
        'inbound_enquiry',
        'outbound_reply',
        'quotation_sent',
        'payment_promise',
        'invoice_overdue',
        'payment_evidence_observed',
        'follow_up_due',
        'source_sync_failure'
    )),
    idempotency_key text NOT NULL CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 512),
    occurred_at timestamptz NOT NULL,
    observed_at timestamptz NOT NULL,
    customer_match jsonb NOT NULL CHECK (jsonb_typeof(customer_match) = 'object'),
    evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
    confidence numeric(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    review_state text NOT NULL CHECK (review_state IN ('ready', 'needs_review')),
    summary text NOT NULL CHECK (length(trim(summary)) BETWEEN 1 AND 1000),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, id),
    CONSTRAINT business_signals_source_idempotency_unique
        UNIQUE (organization_id, source_id, idempotency_key),
    CONSTRAINT business_signals_customer_review_guard CHECK (
        review_state <> 'ready' OR customer_match->>'status' = 'matched'
    ),
    CONSTRAINT business_signals_evidence_identity CHECK (
        length(trim(COALESCE(evidence->>'externalRecordId', ''))) > 0
    )
);

CREATE INDEX business_signals_org_occurred_idx
    ON public.business_signals (organization_id, occurred_at DESC);
CREATE INDEX business_signals_org_type_review_idx
    ON public.business_signals (organization_id, signal_type, review_state, occurred_at DESC);

ALTER TABLE public.business_signals ENABLE ROW LEVEL SECURITY;

CREATE POLICY business_signals_member_read
    ON public.business_signals FOR SELECT TO authenticated
    USING (private.is_org_member(organization_id));

CREATE POLICY business_signals_member_insert
    ON public.business_signals FOR INSERT TO authenticated
    WITH CHECK (private.has_org_role(organization_id, ARRAY['owner', 'admin', 'operator']));

-- Observations are immutable: corrections should arrive as a new event or be
-- handled through a separately audited review workflow, never silent mutation.
CREATE TRIGGER business_signals_immutable
    BEFORE UPDATE OR DELETE ON public.business_signals
    FOR EACH ROW EXECUTE FUNCTION public.prevent_immutable_record_mutation();

COMMIT;
