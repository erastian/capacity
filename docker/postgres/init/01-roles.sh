#!/bin/bash
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v migrator_password="$CAPACITY_MIGRATOR_PASSWORD" \
  -v app_password="$CAPACITY_APP_PASSWORD" \
  -v maintenance_password="$CAPACITY_MAINTENANCE_PASSWORD" <<'SQL'
CREATE ROLE capacity_migrator LOGIN CREATEDB PASSWORD :'migrator_password';
CREATE ROLE capacity_app LOGIN PASSWORD :'app_password';
CREATE ROLE capacity_maintenance LOGIN PASSWORD :'maintenance_password';

CREATE DATABASE capacity OWNER capacity_migrator;
REVOKE CONNECT, TEMPORARY ON DATABASE capacity FROM PUBLIC;
GRANT CONNECT ON DATABASE capacity TO capacity_app, capacity_maintenance;
SQL
