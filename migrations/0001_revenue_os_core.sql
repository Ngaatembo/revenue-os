-- Core Revenue OS model. All money is stored as integer minor units.
-- Every business record is organization-scoped; cross-record FKs preserve that scope.

CREATE TABLE organizations (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  created_at TEXT NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  auth_subject TEXT NOT NULL UNIQUE,
  email TEXT,
  display_name TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE memberships (
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'analyst', 'operator', 'viewer')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, user_id),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
);

CREATE TABLE data_sources (
  organization_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  kind TEXT NOT NULL CHECK (kind IN ('csv_import', 'accounting', 'payment_export', 'manual')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, created_by) REFERENCES memberships(organization_id, user_id) ON DELETE RESTRICT
);

CREATE TABLE imports (
  organization_id TEXT NOT NULL,
  id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'completed_with_errors', 'failed')),
  content_hash TEXT NOT NULL CHECK (length(content_hash) BETWEEN 1 AND 256),
  total_rows INTEGER NOT NULL CHECK (typeof(total_rows) = 'integer' AND total_rows >= 0),
  accepted_rows INTEGER NOT NULL CHECK (typeof(accepted_rows) = 'integer' AND accepted_rows >= 0),
  rejected_rows INTEGER NOT NULL CHECK (typeof(rejected_rows) = 'integer' AND rejected_rows >= 0),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, source_id, content_hash),
  CHECK (accepted_rows + rejected_rows <= total_rows),
  FOREIGN KEY (organization_id, source_id) REFERENCES data_sources(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, created_by) REFERENCES memberships(organization_id, user_id) ON DELETE RESTRICT
);

CREATE TABLE invoices (
  organization_id TEXT NOT NULL,
  id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  import_id TEXT NOT NULL,
  external_record_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  invoice_number TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency GLOB '[A-Z][A-Z][A-Z]'),
  total_minor INTEGER NOT NULL CHECK (typeof(total_minor) = 'integer' AND total_minor > 0 AND total_minor <= 9000000000000000),
  paid_minor INTEGER NOT NULL CHECK (typeof(paid_minor) = 'integer' AND paid_minor >= 0 AND paid_minor <= total_minor),
  issued_at TEXT NOT NULL,
  due_at TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, source_id, external_record_id),
  FOREIGN KEY (organization_id, source_id) REFERENCES data_sources(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, import_id) REFERENCES imports(organization_id, id) ON DELETE RESTRICT
);

CREATE TABLE assumptions (
  organization_id TEXT NOT NULL,
  id TEXT NOT NULL,
  assumption_key TEXT NOT NULL CHECK (assumption_key IN ('recovery_rate')),
  value_bps INTEGER NOT NULL CHECK (typeof(value_bps) = 'integer' AND value_bps BETWEEN 0 AND 10000),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, updated_by) REFERENCES memberships(organization_id, user_id) ON DELETE RESTRICT
);

CREATE TABLE opportunities (
  organization_id TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('overdue_invoice')),
  status TEXT NOT NULL CHECK (status IN ('open', 'accepted', 'dismissed', 'closed')),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency GLOB '[A-Z][A-Z][A-Z]'),
  outstanding_minor INTEGER NOT NULL CHECK (typeof(outstanding_minor) = 'integer' AND outstanding_minor > 0 AND outstanding_minor <= 9000000000000000),
  estimate_low_minor INTEGER NOT NULL CHECK (typeof(estimate_low_minor) = 'integer' AND estimate_low_minor >= 0 AND estimate_low_minor <= 9000000000000000),
  estimate_high_minor INTEGER NOT NULL CHECK (typeof(estimate_high_minor) = 'integer' AND estimate_high_minor >= estimate_low_minor AND estimate_high_minor <= 9000000000000000),
  assumption_id TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, assumption_id) REFERENCES assumptions(organization_id, id) ON DELETE RESTRICT
);

CREATE TABLE opportunity_evidence (
  organization_id TEXT NOT NULL,
  opportunity_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  PRIMARY KEY (organization_id, opportunity_id, invoice_id),
  FOREIGN KEY (organization_id, opportunity_id) REFERENCES opportunities(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, invoice_id) REFERENCES invoices(organization_id, id) ON DELETE RESTRICT
);

CREATE TABLE actions (
  organization_id TEXT NOT NULL,
  id TEXT NOT NULL,
  opportunity_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('payment_reminder')),
  status TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'executed', 'failed', 'cancelled')),
  recipient_customer_id TEXT NOT NULL,
  message TEXT NOT NULL,
  execution_mode TEXT NOT NULL CHECK (execution_mode = 'manual'),
  proposed_by TEXT NOT NULL,
  proposed_at TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT,
  executed_by TEXT,
  executed_at TEXT,
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, opportunity_id) REFERENCES opportunities(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, proposed_by) REFERENCES memberships(organization_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, approved_by) REFERENCES memberships(organization_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, executed_by) REFERENCES memberships(organization_id, user_id) ON DELETE RESTRICT,
  CHECK ((status IN ('approved', 'executed', 'failed') AND approved_by IS NOT NULL AND approved_at IS NOT NULL) OR status IN ('proposed', 'cancelled')),
  CHECK ((status = 'executed' AND executed_by IS NOT NULL AND executed_at IS NOT NULL) OR status <> 'executed')
);

CREATE TABLE action_invoice_targets (
  organization_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  PRIMARY KEY (organization_id, action_id, invoice_id),
  FOREIGN KEY (organization_id, action_id) REFERENCES actions(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, invoice_id) REFERENCES invoices(organization_id, id) ON DELETE RESTRICT
);

CREATE TABLE payment_evidence (
  organization_id TEXT NOT NULL,
  id TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  external_record_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (typeof(amount_minor) = 'integer' AND amount_minor > 0 AND amount_minor <= 9000000000000000),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency GLOB '[A-Z][A-Z][A-Z]'),
  received_at TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, source_id, external_record_id),
  FOREIGN KEY (organization_id, invoice_id) REFERENCES invoices(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, source_id) REFERENCES data_sources(organization_id, id) ON DELETE RESTRICT
);

CREATE TABLE outcomes (
  organization_id TEXT NOT NULL,
  id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  opportunity_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reported', 'verified')),
  method TEXT NOT NULL CHECK (method IN ('human_report', 'matched_payment_record')),
  amount_minor INTEGER NOT NULL CHECK (typeof(amount_minor) = 'integer' AND amount_minor > 0 AND amount_minor <= 9000000000000000),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency GLOB '[A-Z][A-Z][A-Z]'),
  measurement_starts_at TEXT NOT NULL,
  measurement_ends_at TEXT NOT NULL,
  causal_claim TEXT NOT NULL CHECK (causal_claim = 'observed_after_action_not_proven_causal'),
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, action_id) REFERENCES actions(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, opportunity_id) REFERENCES opportunities(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, recorded_by) REFERENCES memberships(organization_id, user_id) ON DELETE RESTRICT,
  CHECK ((state = 'reported' AND method = 'human_report') OR (state = 'verified' AND method = 'matched_payment_record')),
  CHECK (measurement_ends_at >= measurement_starts_at)
);

CREATE TABLE outcome_payment_evidence (
  organization_id TEXT NOT NULL,
  outcome_id TEXT NOT NULL,
  payment_evidence_id TEXT NOT NULL,
  PRIMARY KEY (organization_id, outcome_id, payment_evidence_id),
  FOREIGN KEY (organization_id, outcome_id) REFERENCES outcomes(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, payment_evidence_id) REFERENCES payment_evidence(organization_id, id) ON DELETE RESTRICT
);

CREATE TABLE audit_log (
  organization_id TEXT NOT NULL,
  id TEXT NOT NULL,
  actor_user_id TEXT,
  event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 120),
  entity_type TEXT NOT NULL CHECK (length(entity_type) BETWEEN 1 AND 120),
  entity_id TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT
);

CREATE INDEX memberships_user_idx ON memberships(user_id, organization_id);
CREATE INDEX invoices_due_idx ON invoices(organization_id, due_at, currency);
CREATE INDEX invoices_customer_idx ON invoices(organization_id, customer_id, invoice_number);
CREATE INDEX opportunities_status_idx ON opportunities(organization_id, status, detected_at);
CREATE INDEX actions_opportunity_idx ON actions(organization_id, opportunity_id, proposed_at);
CREATE INDEX payments_invoice_time_idx ON payment_evidence(organization_id, invoice_id, received_at);
CREATE INDEX outcomes_action_idx ON outcomes(organization_id, action_id, recorded_at);
CREATE INDEX audit_entity_idx ON audit_log(organization_id, entity_type, entity_id, created_at);

CREATE TRIGGER actions_status_transition_guard
BEFORE UPDATE OF status ON actions
WHEN NOT (
  (OLD.status = 'proposed' AND NEW.status IN ('approved', 'cancelled')) OR
  (OLD.status = 'approved' AND NEW.status IN ('executed', 'failed', 'cancelled'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid action status transition');
END;

CREATE TRIGGER actions_must_start_proposed
BEFORE INSERT ON actions
WHEN NEW.status <> 'proposed' OR NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL OR
     NEW.executed_by IS NOT NULL OR NEW.executed_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'actions must start proposed and unapproved');
END;

CREATE TRIGGER outcomes_action_opportunity_guard
BEFORE INSERT ON outcomes
WHEN NOT EXISTS (
  SELECT 1 FROM actions action
  WHERE action.organization_id = NEW.organization_id
    AND action.id = NEW.action_id
    AND action.opportunity_id = NEW.opportunity_id
    AND action.status = 'executed'
    AND action.executed_at = NEW.measurement_starts_at
)
BEGIN
  SELECT RAISE(ABORT, 'outcome requires an executed action on the same opportunity');
END;

CREATE TRIGGER outcomes_must_start_reported
BEFORE INSERT ON outcomes
WHEN NEW.state <> 'reported' OR NEW.method <> 'human_report'
BEGIN
  SELECT RAISE(ABORT, 'outcomes must start as reported human observations');
END;

CREATE TRIGGER outcomes_state_transition_guard
BEFORE UPDATE OF state ON outcomes
WHEN NOT (OLD.state = 'reported' AND NEW.state = 'verified')
BEGIN
  SELECT RAISE(ABORT, 'invalid outcome state transition');
END;

CREATE TRIGGER outcomes_verified_requires_matching_payment_evidence
BEFORE UPDATE OF state ON outcomes
WHEN NEW.state = 'verified' AND (
  NEW.method <> 'matched_payment_record' OR
  NOT EXISTS (
    SELECT 1
    FROM outcome_payment_evidence link
    JOIN payment_evidence payment
      ON payment.organization_id = link.organization_id
     AND payment.id = link.payment_evidence_id
    JOIN opportunity_evidence source_invoice
      ON source_invoice.organization_id = payment.organization_id
     AND source_invoice.invoice_id = payment.invoice_id
    WHERE link.organization_id = NEW.organization_id
      AND link.outcome_id = NEW.id
      AND source_invoice.opportunity_id = NEW.opportunity_id
      AND payment.currency = NEW.currency
      AND payment.received_at >= NEW.measurement_starts_at
      AND payment.received_at <= NEW.measurement_ends_at
  ) OR
  COALESCE((
    SELECT SUM(payment.amount_minor)
    FROM outcome_payment_evidence link
    JOIN payment_evidence payment
      ON payment.organization_id = link.organization_id
     AND payment.id = link.payment_evidence_id
    JOIN opportunity_evidence source_invoice
      ON source_invoice.organization_id = payment.organization_id
     AND source_invoice.invoice_id = payment.invoice_id
    WHERE link.organization_id = NEW.organization_id
      AND link.outcome_id = NEW.id
      AND source_invoice.opportunity_id = NEW.opportunity_id
      AND payment.currency = NEW.currency
      AND payment.received_at >= NEW.measurement_starts_at
      AND payment.received_at <= NEW.measurement_ends_at
  ), 0) <> NEW.amount_minor
  OR NOT EXISTS (
    SELECT 1 FROM opportunities opportunity
    WHERE opportunity.organization_id = NEW.organization_id
      AND opportunity.id = NEW.opportunity_id
      AND opportunity.currency = NEW.currency
      AND NEW.amount_minor <= opportunity.outstanding_minor
  )
)
BEGIN
  SELECT RAISE(ABORT, 'verified outcome requires matching linked payment evidence');
END;

CREATE TRIGGER opportunity_evidence_currency_guard
BEFORE INSERT ON opportunity_evidence
WHEN NOT EXISTS (
  SELECT 1
  FROM opportunities opportunity
  JOIN invoices invoice
    ON invoice.organization_id = opportunity.organization_id
   AND invoice.id = NEW.invoice_id
  WHERE opportunity.organization_id = NEW.organization_id
    AND opportunity.id = NEW.opportunity_id
    AND invoice.currency = opportunity.currency
)
BEGIN
  SELECT RAISE(ABORT, 'opportunity and invoice currencies must match');
END;

CREATE TRIGGER payment_evidence_currency_guard
BEFORE INSERT ON payment_evidence
WHEN NOT EXISTS (
  SELECT 1 FROM invoices invoice
  WHERE invoice.organization_id = NEW.organization_id
    AND invoice.id = NEW.invoice_id
    AND invoice.currency = NEW.currency
)
BEGIN
  SELECT RAISE(ABORT, 'payment evidence currency must match invoice currency');
END;

CREATE TRIGGER audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit log is append-only');
END;

CREATE TRIGGER audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit log is append-only');
END;

CREATE TRIGGER payment_evidence_no_update
BEFORE UPDATE ON payment_evidence
BEGIN
  SELECT RAISE(ABORT, 'payment evidence is immutable');
END;

CREATE TRIGGER payment_evidence_no_delete
BEFORE DELETE ON payment_evidence
BEGIN
  SELECT RAISE(ABORT, 'payment evidence is immutable');
END;
