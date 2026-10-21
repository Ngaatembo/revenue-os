-- Rollback for 20261021180000_conversation_tracking.sql.
-- WARNING: deletes every handled/snoozed mark, note and muted sender. Conversations themselves (public.communications) are untouched.
DROP FUNCTION IF EXISTS public.unmute_sender(text, text);
DROP FUNCTION IF EXISTS public.mute_sender(text, text);
DROP FUNCTION IF EXISTS public.set_conversation_tracking(text, text, text, text, timestamptz, text);
DROP TABLE IF EXISTS public.muted_senders;
DROP TABLE IF EXISTS public.conversation_tracking;
