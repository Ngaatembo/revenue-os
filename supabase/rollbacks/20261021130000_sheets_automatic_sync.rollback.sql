-- Rollback for 20261021130000_sheets_automatic_sync.sql. Loses no business data: both objects are functions.
DROP FUNCTION IF EXISTS public.refresh_org_after_sync(text);
DROP FUNCTION IF EXISTS public.persist_invoice_import_system(text, text, text, text, jsonb, integer);
