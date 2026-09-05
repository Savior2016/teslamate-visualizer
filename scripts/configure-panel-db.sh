#!/bin/sh
# Runs only in the one-shot database maintenance container, not the web app.
set -eu
: "${PANEL_DATABASE_PASSWORD:?Set PANEL_DATABASE_PASSWORD}"
for attempt in $(seq 1 90); do
  if [ "$(psql -Atqc "SELECT to_regclass('public.cars') IS NOT NULL AND to_regclass('private.tokens') IS NOT NULL" 2>/dev/null)" = t ]; then
    break
  fi
  [ "$attempt" -lt 90 ] || { echo "TeslaMate schema not ready" >&2; exit 1; }
  sleep 2
done
psql -v ON_ERROR_STOP=1 <<'SQL'
\getenv panel_password PANEL_DATABASE_PASSWORD
SELECT 'CREATE ROLE teslahome_panel LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname='teslahome_panel') \gexec
ALTER ROLE teslahome_panel NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'panel_password';
CREATE TABLE IF NOT EXISTS public.panel_manual (
 kind text NOT NULL, key text NOT NULL, payload jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(kind,key)
);
GRANT CONNECT ON DATABASE teslamate TO teslahome_panel;
GRANT USAGE ON SCHEMA public, private TO teslahome_panel;
GRANT SELECT ON ALL TABLES IN SCHEMA public, private TO teslahome_panel;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public, private TO teslahome_panel;
GRANT INSERT, UPDATE, DELETE ON public.panel_manual TO teslahome_panel;
ALTER DEFAULT PRIVILEGES IN SCHEMA public, private GRANT SELECT ON TABLES TO teslahome_panel;
ALTER DEFAULT PRIVILEGES IN SCHEMA public, private GRANT SELECT ON SEQUENCES TO teslahome_panel;
SQL
