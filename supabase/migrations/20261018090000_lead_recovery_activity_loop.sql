-- Revenue OS: make lead recovery a real, auditable workflow.
-- Every recorded interaction is durable and updates the lead's next action atomically.

CREATE TABLE IF NOT EXISTS public.lead_activities (
  organization_id text NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  id text NOT NULL,
  lead_id text NOT NULL,
  activity_type text NOT NULL CHECK (activity_type IN (
    'follow_up_sent', 'no_response', 'interested', 'meeting_booked', 'not_interested', 'note'
  )),
  summary text NOT NULL CHECK (length(trim(summary)) BETWEEN 3 AND 1000),
  next_follow_up date,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, lead_id)
    REFERENCES public.sales_leads(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, created_by)
    REFERENCES public.memberships(organization_id, user_id) ON DELETE RESTRICT,
  CHECK (activity_type = 'not_interested' OR next_follow_up IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS lead_activities_lead_created_idx
  ON public.lead_activities (organization_id, lead_id, created_at DESC);

ALTER TABLE public.lead_activities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lead_activities_member_read ON public.lead_activities;
CREATE POLICY lead_activities_member_read ON public.lead_activities
  FOR SELECT TO authenticated
  USING (private.is_org_member(organization_id));

REVOKE ALL ON public.lead_activities FROM anon, authenticated;
GRANT SELECT ON public.lead_activities TO authenticated;

CREATE OR REPLACE FUNCTION public.record_lead_activity(
  p_org_id text,
  p_lead_id text,
  p_activity_id text,
  p_activity_type text,
  p_summary text,
  p_next_follow_up date DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_actor text;
  v_current_status text;
  v_new_status text;
  v_next_follow_up date;
  v_activity public.lead_activities%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF NOT private.has_org_role(p_org_id, ARRAY['owner', 'admin', 'operator']) THEN
    RAISE EXCEPTION 'Workspace permission denied' USING ERRCODE = '42501';
  END IF;
  IF p_activity_id IS NULL OR length(trim(p_activity_id)) NOT BETWEEN 1 AND 160 THEN
    RAISE EXCEPTION 'A valid activity id is required' USING ERRCODE = '22023';
  END IF;
  IF p_activity_type NOT IN ('follow_up_sent', 'no_response', 'interested', 'meeting_booked', 'not_interested', 'note') THEN
    RAISE EXCEPTION 'Unsupported lead activity type' USING ERRCODE = '22023';
  END IF;
  IF p_summary IS NULL OR length(trim(p_summary)) NOT BETWEEN 3 AND 1000 THEN
    RAISE EXCEPTION 'Describe the interaction in 3 to 1000 characters' USING ERRCODE = '22023';
  END IF;
  IF p_activity_type <> 'not_interested' AND (p_next_follow_up IS NULL OR p_next_follow_up < CURRENT_DATE) THEN
    RAISE EXCEPTION 'Choose today or a future date for the next follow-up' USING ERRCODE = '22023';
  END IF;

  SELECT u.id INTO v_actor
    FROM public.users u
   WHERE u.auth_subject = auth.uid()
   LIMIT 1;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Workspace membership is not initialized' USING ERRCODE = '42501';
  END IF;

  SELECT l.status INTO v_current_status
    FROM public.sales_leads l
   WHERE l.organization_id = p_org_id AND l.id = p_lead_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lead not found in this workspace' USING ERRCODE = 'P0002';
  END IF;
  IF v_current_status IN ('converted', 'closed') THEN
    RAISE EXCEPTION 'Closed or converted leads cannot receive new recovery activity' USING ERRCODE = '22023';
  END IF;

  v_new_status := CASE p_activity_type
    WHEN 'follow_up_sent' THEN 'contacted'
    WHEN 'no_response' THEN 'contacted'
    WHEN 'interested' THEN 'follow_up'
    WHEN 'meeting_booked' THEN 'follow_up'
    WHEN 'not_interested' THEN 'closed'
    ELSE v_current_status
  END;
  v_next_follow_up := p_next_follow_up;

  INSERT INTO public.lead_activities (
    organization_id, id, lead_id, activity_type, summary, next_follow_up, created_by
  ) VALUES (
    p_org_id, p_activity_id, p_lead_id, p_activity_type, trim(p_summary), v_next_follow_up, v_actor
  )
  RETURNING * INTO v_activity;

  UPDATE public.sales_leads
     SET status = v_new_status,
         next_follow_up = COALESCE(v_next_follow_up, next_follow_up),
         updated_at = pg_catalog.now()
   WHERE organization_id = p_org_id AND id = p_lead_id;

  RETURN pg_catalog.jsonb_build_object(
    'id', v_activity.id,
    'lead_id', v_activity.lead_id,
    'activity_type', v_activity.activity_type,
    'summary', v_activity.summary,
    'next_follow_up', v_activity.next_follow_up,
    'created_by', v_activity.created_by,
    'created_at', v_activity.created_at,
    'lead_status', v_new_status
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.record_lead_activity(text, text, text, text, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_lead_activity(text, text, text, text, text, date) TO authenticated;
