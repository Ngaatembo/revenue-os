-- Rollback for 20261021170000. Deletes stored WhatsApp messages (provider = 'whatsapp').
DROP TABLE IF EXISTS public.whatsapp_numbers;
DELETE FROM public.communications WHERE provider = 'whatsapp';
ALTER TABLE public.communications DROP CONSTRAINT IF EXISTS communications_provider_check;
ALTER TABLE public.communications ADD CONSTRAINT communications_provider_check CHECK (provider IN ('gmail'));
