-- Follow-up tracking for customer conversations: mark handled, remind me later, a short note, and "not a customer" sender mutes.
-- Message content is never stored here. The only free text is the owner's own note (max 500 characters).
-- Browsers read these tables (members only) and change them only through the functions below, which check the caller's role.

CREATE TABLE IF NOT EXISTS public.conversation_tracking (
  organization_id text NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider ~ '^[a-z_]{2,40}$'),
  thread_id text NOT NULL CHECK (length(thread_id) BETWEEN 1 AND 200),
  status text NOT NULL CHECK (status IN ('open', 'handled', 'snoozed')),
  handled_at timestamptz,
  remind_at timestamptz,
  note text CHECK (note IS NULL OR length(note) <= 500),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, provider, thread_id),
  CHECK (status <> 'handled' OR handled_at IS NOT NULL),
  CHECK (status <> 'snoozed' OR remind_at IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS public.muted_senders (
  organization_id text NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  address text NOT NULL CHECK (length(address) BETWEEN 3 AND 320 AND address = lower(address) AND address ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, address)
);

ALTER TABLE public.conversation_tracking ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_tracking FORCE ROW LEVEL SECURITY;
ALTER TABLE public.muted_senders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.muted_senders FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS conversation_tracking_member_read ON public.conversation_tracking;
CREATE POLICY conversation_tracking_member_read ON public.conversation_tracking FOR SELECT TO authenticated USING (private.is_org_member(organization_id));
DROP POLICY IF EXISTS muted_senders_member_read ON public.muted_senders;
CREATE POLICY muted_senders_member_read ON public.muted_senders FOR SELECT TO authenticated USING (private.is_org_member(organization_id));
REVOKE ALL ON public.conversation_tracking, public.muted_senders FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.conversation_tracking, public.muted_senders TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.conversation_tracking, public.muted_senders TO service_role;

-- action: handled | snooze | reopen | note. A note may accompany any action; an empty note clears it.
CREATE OR REPLACE FUNCTION public.set_conversation_tracking(
  p_org_id text, p_provider text, p_thread_id text, p_action text, p_remind_at timestamptz DEFAULT NULL, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_actor text;
  v_note text;
  v_row public.conversation_tracking%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000'; END IF;
  IF NOT private.has_org_role(p_org_id, ARRAY['owner', 'admin', 'operator']) THEN
    RAISE EXCEPTION 'Workspace permission denied' USING ERRCODE = '42501';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('handled', 'snooze', 'reopen', 'note') THEN
    RAISE EXCEPTION 'Unsupported action' USING ERRCODE = '22023';
  END IF;
  IF p_action = 'snooze' AND (p_remind_at IS NULL OR p_remind_at <= now() OR p_remind_at > now() + interval '90 days') THEN
    RAISE EXCEPTION 'Choose a reminder time within the next 90 days' USING ERRCODE = '22023';
  END IF;
  v_note := nullif(btrim(coalesce(p_note, '')), '');
  IF v_note IS NOT NULL AND length(v_note) > 500 THEN
    RAISE EXCEPTION 'A note can be at most 500 characters' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.communications c WHERE c.organization_id = p_org_id AND c.provider = p_provider AND c.thread_id = p_thread_id) THEN
    RAISE EXCEPTION 'Conversation not found in this workspace' USING ERRCODE = '22023';
  END IF;
  SELECT u.id INTO v_actor FROM public.users u WHERE u.auth_subject = auth.uid() LIMIT 1;

  INSERT INTO public.conversation_tracking AS t (organization_id, provider, thread_id, status, handled_at, remind_at, note, updated_by, updated_at)
  VALUES (p_org_id, p_provider, p_thread_id,
          CASE p_action WHEN 'handled' THEN 'handled' WHEN 'snooze' THEN 'snoozed' ELSE 'open' END,
          CASE WHEN p_action = 'handled' THEN now() END,
          CASE WHEN p_action = 'snooze' THEN p_remind_at END,
          v_note, v_actor, now())
  ON CONFLICT (organization_id, provider, thread_id) DO UPDATE SET
    status = CASE p_action WHEN 'handled' THEN 'handled' WHEN 'snooze' THEN 'snoozed' WHEN 'reopen' THEN 'open' ELSE t.status END,
    handled_at = CASE p_action WHEN 'handled' THEN now() WHEN 'snooze' THEN NULL WHEN 'reopen' THEN NULL ELSE t.handled_at END,
    remind_at = CASE p_action WHEN 'snooze' THEN p_remind_at WHEN 'handled' THEN NULL WHEN 'reopen' THEN NULL ELSE t.remind_at END,
    note = CASE WHEN p_note IS NOT NULL OR p_action = 'note' THEN v_note ELSE t.note END,
    updated_by = v_actor, updated_at = now()
  RETURNING * INTO v_row;
  RETURN to_jsonb(v_row);
END;
$function$;
REVOKE ALL ON FUNCTION public.set_conversation_tracking(text, text, text, text, timestamptz, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_conversation_tracking(text, text, text, text, timestamptz, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.mute_sender(p_org_id text, p_address text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE v_actor text; v_address text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000'; END IF;
  IF NOT private.has_org_role(p_org_id, ARRAY['owner', 'admin', 'operator']) THEN
    RAISE EXCEPTION 'Workspace permission denied' USING ERRCODE = '42501';
  END IF;
  v_address := lower(btrim(coalesce(p_address, '')));
  IF length(v_address) NOT BETWEEN 3 AND 320 OR v_address !~ '^[^@[:space:]]+@[^@[:space:]]+$' THEN
    RAISE EXCEPTION 'A valid email address is required' USING ERRCODE = '22023';
  END IF;
  SELECT u.id INTO v_actor FROM public.users u WHERE u.auth_subject = auth.uid() LIMIT 1;
  INSERT INTO public.muted_senders (organization_id, address, created_by) VALUES (p_org_id, v_address, v_actor) ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('address', v_address, 'muted', true);
END;
$function$;
REVOKE ALL ON FUNCTION public.mute_sender(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mute_sender(text, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.unmute_sender(p_org_id text, p_address text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE v_address text; v_count integer;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000'; END IF;
  IF NOT private.has_org_role(p_org_id, ARRAY['owner', 'admin', 'operator']) THEN
    RAISE EXCEPTION 'Workspace permission denied' USING ERRCODE = '42501';
  END IF;
  v_address := lower(btrim(coalesce(p_address, '')));
  DELETE FROM public.muted_senders WHERE organization_id = p_org_id AND address = v_address;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN jsonb_build_object('address', v_address, 'muted', false, 'removed', v_count);
END;
$function$;
REVOKE ALL ON FUNCTION public.unmute_sender(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unmute_sender(text, text) TO authenticated, service_role;
