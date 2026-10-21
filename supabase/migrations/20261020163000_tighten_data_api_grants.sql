revoke all on all tables in schema public from anon;
revoke truncate, references, trigger on all tables in schema public from authenticated;
revoke truncate, references, trigger on all tables in schema public from service_role;
revoke all on all sequences in schema public from anon;
