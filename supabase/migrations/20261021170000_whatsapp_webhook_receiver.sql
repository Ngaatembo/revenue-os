-- Storage for inbound WhatsApp Business Platform webhook messages. Dormant until the Worker has WHATSAPP_* settings.
-- A phone_number_id belongs to exactly one workspace and is registered by the platform operator (service role), never
-- by a workspace member: a member must not be able to claim another tenant's number.

ALTER TABLE public.communications DROP CONSTRAINT IF EXISTS communications_provider_check;
ALTER TABLE public.communications ADD CONSTRAINT communications_provider_check CHECK (provider IN ('gmail', 'whatsapp'));

CREATE TABLE IF NOT EXISTS public.whatsapp_numbers (
  phone_number_id text PRIMARY KEY CHECK (phone_number_id ~ '^[0-9]{5,32}$'),
  organization_id text NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  display_phone_number text CHECK (display_phone_number IS NULL OR length(display_phone_number) <= 40),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS whatsapp_numbers_org_idx ON public.whatsapp_numbers (organization_id);
ALTER TABLE public.whatsapp_numbers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_numbers FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_numbers FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_numbers TO service_role;
COMMENT ON TABLE public.whatsapp_numbers IS 'Operator-registered mapping from a WhatsApp phone_number_id to its workspace. Service role only.';
