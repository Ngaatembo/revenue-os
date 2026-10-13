CREATE POLICY stalled_opportunities_member_update
ON public.stalled_opportunities
FOR UPDATE
TO authenticated
USING (
  public.has_org_role(
    organization_id,
    ARRAY['owner', 'admin', 'operator']::text[]
  )
)
WITH CHECK (
  public.has_org_role(
    organization_id,
    ARRAY['owner', 'admin', 'operator']::text[]
  )
);

CREATE POLICY stalled_opportunities_admin_delete
ON public.stalled_opportunities
FOR DELETE
TO authenticated
USING (
  public.has_org_role(
    organization_id,
    ARRAY['owner', 'admin']::text[]
  )
);