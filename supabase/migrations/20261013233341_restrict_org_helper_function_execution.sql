-- Restrict organization helper functions to trusted authenticated callers.
-- These helpers are used by RLS policies; authenticated execution is required
-- for those policies to evaluate, while anonymous/public execution is denied.
REVOKE ALL ON FUNCTION public.is_org_member(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_org_member(text) FROM anon;
REVOKE ALL ON FUNCTION public.has_org_role(text, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.has_org_role(text, text[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.is_org_member(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_org_role(text, text[]) TO authenticated;
