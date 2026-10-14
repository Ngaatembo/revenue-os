-- Keep tenant-isolation helper functions outside the exposed public API schema.
-- Existing RLS policies retain their function dependencies when functions move.
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;
REVOKE ALL ON SCHEMA private FROM anon;
GRANT USAGE ON SCHEMA private TO authenticated;

ALTER FUNCTION public.is_org_member(text) SET SCHEMA private;
ALTER FUNCTION public.has_org_role(text, text[]) SET SCHEMA private;

REVOKE ALL ON FUNCTION private.is_org_member(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.is_org_member(text) FROM anon;
REVOKE ALL ON FUNCTION private.has_org_role(text, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.has_org_role(text, text[]) FROM anon;
GRANT EXECUTE ON FUNCTION private.is_org_member(text) TO authenticated;
GRANT EXECUTE ON FUNCTION private.has_org_role(text, text[]) TO authenticated;
