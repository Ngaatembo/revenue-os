-- Stage 1: durable Google Sheets snapshot/run tracking.
-- Additive groundwork only. Sync behavior is wired in a later, separately tested change.
-- Snapshot records are server-managed; browser roles cannot read or write this metadata.

BEGIN;

CREATE TABLE public.source_sync_runs (
  organization_id text NOT NULL
    REFERENCES public.organizations(id) ON DELETE RESTRICT,
  id text NOT NULL,
  source_key text NOT NULL CHECK (length(trim(source_key)) BETWEEN 1 AND 240),
  provider text NOT NULL CHECK (provider IN ('google_sheets')),
  spreadsheet_id text NOT NULL CHECK (length(trim(spreadsheet_id)) BETWEEN 1 AND 240),
  source_range text NOT NULL CHECK (length(trim(source_range)) BETWEEN 1 AND 200),
  status text NOT NULL CHECK (status IN ('started', 'completed', 'completed_with_errors', 'failed')),
  content_digest text CHECK (content_digest IS NULL OR content_digest ~ '^[a-f0-9]{64}$'),
  accepted_rows integer NOT NULL DEFAULT 0 CHECK (accepted_rows BETWEEN 0 AND 50000),
  rejected_rows integer NOT NULL DEFAULT 0 CHECK (rejected_rows BETWEEN 0 AND 50000),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  error_code text CHECK (error_code IS NULL OR length(error_code) <= 80),
  PRIMARY KEY (organization_id, id),
  CHECK (
    (status = 'started' AND completed_at IS NULL)
    OR (status <> 'started' AND completed_at IS NOT NULL)
  ),
  CHECK (status <> 'completed' OR rejected_rows = 0),
  CHECK (status <> 'completed_with_errors' OR rejected_rows > 0)
);

CREATE INDEX source_sync_runs_scope_recent_idx
  ON public.source_sync_runs (organization_id, source_key, source_range, started_at DESC);

CREATE TABLE public.source_sync_memberships (
  organization_id text NOT NULL,
  source_key text NOT NULL CHECK (length(trim(source_key)) BETWEEN 1 AND 240),
  source_range text NOT NULL CHECK (length(trim(source_range)) BETWEEN 1 AND 200),
  invoice_id text NOT NULL,
  last_seen_run_id text NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  review_state text NOT NULL DEFAULT 'present'
    CHECK (review_state IN ('present', 'missing_from_source_pending_review', 'resolved')),
  review_note text CHECK (review_note IS NULL OR length(review_note) <= 500),
  reviewed_by text,
  reviewed_at timestamptz,
  PRIMARY KEY (organization_id, source_key, source_range, invoice_id),
  FOREIGN KEY (organization_id, invoice_id)
    REFERENCES public.invoices (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, last_seen_run_id)
    REFERENCES public.source_sync_runs (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, reviewed_by)
    REFERENCES public.memberships (organization_id, user_id) ON DELETE RESTRICT,
  CHECK (
    (review_state = 'resolved' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
    OR review_state <> 'resolved'
  )
);

CREATE INDEX source_sync_memberships_review_idx
  ON public.source_sync_memberships (organization_id, review_state, last_seen_at DESC);

ALTER TABLE public.source_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.source_sync_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.source_sync_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.source_sync_memberships FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.source_sync_runs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.source_sync_memberships FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.source_sync_runs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.source_sync_memberships TO service_role;

COMMIT;
