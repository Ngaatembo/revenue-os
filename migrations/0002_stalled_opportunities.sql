-- Durable storage for the stalled-prospect/quotation validation workflow.
-- All reads and writes must be scoped to an organization resolved from an authenticated
-- membership on the Worker. Never accept organization_id as an authority from the browser.

CREATE TABLE stalled_opportunities (
  organization_id TEXT NOT NULL,
  id TEXT NOT NULL,
  prospect_label TEXT NOT NULL CHECK (length(trim(prospect_label)) BETWEEN 1 AND 100),
  stage TEXT NOT NULL CHECK (stage IN (
    'Enquiry',
    'Quote sent',
    'Awaiting decision',
    'Deposit pending',
    'Won',
    'Lost'
  )),
  next_step TEXT CHECK (next_step IS NULL OR length(next_step) <= 180),
  due_date TEXT CHECK (
    due_date IS NULL OR (
      length(due_date) = 10
      AND due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND date(due_date) IS NOT NULL
      AND date(due_date) = due_date
    )
  ),
  quoted_value_minor INTEGER CHECK (
    quoted_value_minor IS NULL OR (
      typeof(quoted_value_minor) = 'integer'
      AND quoted_value_minor >= 0
      AND quoted_value_minor <= 9000000000000000
    )
  ),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (
    length(currency) = 3 AND currency GLOB '[A-Z][A-Z][A-Z]'
  ),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, created_by)
    REFERENCES memberships(organization_id, user_id) ON DELETE RESTRICT
);

CREATE INDEX stalled_opportunities_review_idx
  ON stalled_opportunities(organization_id, due_date, stage, updated_at);
