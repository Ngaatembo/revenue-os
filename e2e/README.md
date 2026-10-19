# End-to-end workflow test (real browser, real database)

`node e2e/workflow.mjs` builds the app, applies **every migration** to a throwaway local Postgres database,
starts a real PostgREST in front of it, serves the built app, and drives the actual screens in Chromium.

What is real: the React app, all SQL migrations, row-level security, the RPCs, PostgREST.
What is a stand-in: Supabase Auth only. Sign-in is replaced by locally signed JWTs (the same claims Supabase
issues) placed in browser storage. Google sign-in, email confirmation and token refresh are NOT covered.

It does not talk to the hosted Supabase project and never needs credentials.

Needs: local Postgres (`PGHOST/PGUSER/PGPASSWORD`), the PostgREST binary (`POSTGREST_BIN`, default `/tmp/pgrst/postgrest`,
v12 static build from github.com/PostgREST/postgrest/releases), and Playwright with Chromium.
