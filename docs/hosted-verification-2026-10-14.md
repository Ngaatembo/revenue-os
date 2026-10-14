# Hosted database verification — 2026-10-14

Method: SQL run against the hosted project through the Supabase connector, as the `authenticated`
role with per-user JWT claims (same RLS, RPC and trigger code paths PostgREST uses). The Auth and
HTTP layers were NOT exercised (the sandbox cannot reach the project API, and no browser test was run).
Data: synthetic only, approved by the project owner. Users `zz-synthetic-{a,b,c}@example.test`,
workspaces named `ZZ-SYNTHETIC-TEST Workspace A/B/C`.

Result: 49 valid checks, all passed (an earlier first batch had 14 invalid checks caused by a test
harness mistake; they were discarded and re-run correctly, plus 17 valid checks in that batch passed).

Covered: invoice import (4 rows, duplicate no-op, invalid row rejected), tenant isolation (reads,
writes, RPCs), action state machine (invalid transitions rejected), payment rules (currency mismatch,
unknown invoice, non-positive amount, duplicate reference), multi-payment verification (20000),
idempotent re-verification, overpayment refusal that does not inflate the outcome, outcome labelled
`observed_after_action_not_proven_causal`, direct writes to evidence tables blocked, membership guard
(admin cannot self-promote or grant owner/admin or remove owner; last owner protected; legit flows work;
viewer cannot import or propose).

Leftover synthetic rows (delete with owner approval): 3 auth users, 3 organizations, 5 memberships,
4 invoices, 2 actions, 1 outcome, 5 payment_evidence rows (plus imports, data_sources, assumptions).

Advisor notes: SECURITY DEFINER RPCs are executable by `authenticated` (intentional; each checks
auth and membership). Leaked-password protection is disabled in Supabase Auth: enable before real users.
