-- Revenue OS: secure organization bootstrap and persisted sales leads.
-- Additive migration. No existing records or policies are removed.

CREATE TABLE IF NOT EXISTS public.sales_leads (
    organization_id text NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
    id text NOT NULL,
    contact_name text NOT NULL CHECK (length(trim(contact_name)) BETWEEN 1 AND 120),
    business_name text NOT NULL CHECK (length(trim(business_name)) BETWEEN 1 AND 160),
    contact_details text,
    source text NOT NULL DEFAULT 'WhatsApp'
      CHECK (source IN ('WhatsApp', 'Phone call', 'Referral', 'Website', 'Email', 'Social media', 'Other')),
    estimated_value_minor bigint CHECK (estimated_value_minor IS NULL OR estimated_value_minor >= 0),
    currency text,
    next_follow_up date NOT NULL,
    notes text CHECK (notes IS NULL OR length(notes) <= 1000),
    status text NOT NULL DEFAULT 'new'
      CHECK (status IN ('new', 'follow_up', 'contacted', 'converted', 'closed')),
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, id),
    FOREIGN KEY (organization_id, created_by)
      REFERENCES public.memberships(organization_id, user_id) ON DELETE RESTRICT,
    CHECK (
      (estimated_value_minor IS NULL AND currency IS NULL)
      OR (estimated_value_minor IS NOT NULL AND currency ~ '^[A-Z]{3}$')
    )
);

CREATE INDEX IF NOT EXISTS sales_leads_org_follow_up_idx
  ON public.sales_leads (organization_id, next_follow_up)
  WHERE status NOT IN ('converted', 'closed');

ALTER TABLE public.sales_leads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sales_leads_member_read ON public.sales_leads;
CREATE POLICY sales_leads_member_read ON public.sales_leads
  FOR SELECT TO authenticated
  USING (private.is_org_member(organization_id));

DROP POLICY IF EXISTS sales_leads_member_insert ON public.sales_leads;
CREATE POLICY sales_leads_member_insert ON public.sales_leads
  FOR INSERT TO authenticated
  WITH CHECK (private.has_org_role(organization_id, ARRAY['owner', 'admin', 'operator']));

DROP POLICY IF EXISTS sales_leads_member_update ON public.sales_leads;
CREATE POLICY sales_leads_member_update ON public.sales_leads
  FOR UPDATE TO authenticated
  USING (private.has_org_role(organization_id, ARRAY['owner', 'admin', 'operator']))
  WITH CHECK (private.has_org_role(organization_id, ARRAY['owner', 'admin', 'operator']));

DROP POLICY IF EXISTS sales_leads_admin_delete ON public.sales_leads;
CREATE POLICY sales_leads_admin_delete ON public.sales_leads
  FOR DELETE TO authenticated
  USING (private.has_org_role(organization_id, ARRAY['owner', 'admin']));

-- Bootstrap exactly one organization for a newly authenticated user.
-- The user cannot nominate an auth subject or grant themselves membership elsewhere.
CREATE OR REPLACE FUNCTION public.bootstrap_revenue_os_organization(org_name text)
RETURNS TABLE (organization_id text, organization_name text, user_id text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  current_auth_id uuid := auth.uid();
  resolved_user_id text;
  resolved_org_id text;
  resolved_org_name text;
  clean_org_name text := left(trim(coalesce(org_name, '')), 160);
BEGIN
  IF current_auth_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  IF length(clean_org_name) < 1 THEN
    RAISE EXCEPTION 'Organization name is required' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.users (id, auth_subject, email, display_name)
  VALUES (
    current_auth_id::text,
    current_auth_id,
    auth.jwt() ->> 'email',
    coalesce(auth.jwt() -> 'user_metadata' ->> 'full_name', auth.jwt() ->> 'email')
  )
  ON CONFLICT (auth_subject) DO UPDATE
    SET email = EXCLUDED.email,
        display_name = coalesce(public.users.display_name, EXCLUDED.display_name)
  RETURNING id INTO resolved_user_id;

  SELECT m.organization_id, o.name
    INTO resolved_org_id, resolved_org_name
    FROM public.memberships AS m
    JOIN public.organizations AS o ON o.id = m.organization_id
   WHERE m.user_id = resolved_user_id
   ORDER BY m.created_at
   LIMIT 1;

  IF resolved_org_id IS NOT NULL THEN
    RETURN QUERY SELECT resolved_org_id, resolved_org_name, resolved_user_id;
    RETURN;
  END IF;

  resolved_org_id := 'org_' || pg_catalog.gen_random_uuid()::text;

  INSERT INTO public.organizations (id, name)
  VALUES (resolved_org_id, clean_org_name);

  INSERT INTO public.memberships (organization_id, user_id, role)
  VALUES (resolved_org_id, resolved_user_id, 'owner');

  RETURN QUERY SELECT resolved_org_id, clean_org_name, resolved_user_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.bootstrap_revenue_os_organization(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bootstrap_revenue_os_organization(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.bootstrap_revenue_os_organization(text) TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sales_leads TO authenticated;
