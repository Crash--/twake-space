#!/usr/bin/env bash
#
# Starts a long lived Twake Space stack for manual or agent driven exploratory QA: the frontend
# and backend built from the working tree, ldap-rest on its OpenLDAP, Postgres, RabbitMQ and a
# mock SSO. It runs under its own compose project and port, next to the dev stack, and stays up
# until stop.sh.
#
#   docker login harbor.linagora.com   # for the ldap-rest image
#   scripts/qa-environment/build.sh    # once, and whenever the code under test changes
#   scripts/qa-environment/start.sh
#
# Accounts, signed in by a button of the mock SSO, no password:
#   acme (acme.twake.local): alice (admin), bob, carol and dave (members)
#   globex (globex.twake.local): erin (admin)
#
# Group of acme: Designers (carol, dave)
#
# Spaces:
#   "Roadmap":       alice admin, bob editor, carol viewer, Designers editor
#   "Design Sprint": bob admin, alice editor, dave viewer
#   "Handover":      carol admin, alice viewer
#   "Globex team":   erin admin
#
# The other apps (chat, drive, mail, calendar, tasks) are not part of the stack: their space
# tabs stay unset or waiting for the app.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/qa-environment/compose.sh
. "$SCRIPT_DIR/compose.sh"

APP_URL="http://localhost:$QA_APP_PORT"

SPACES_KNOWN="$(cat <<'JS'
const { default: postgres } = await import('postgres')
const sql = postgres(process.env.DATABASE_URL)
const expected = Number(process.argv[1])
let known = 0
for (let tries = 0; tries < 60; tries++) {
  ;[{ known }] = await sql`select count(*)::int as known from spaces`
  if (known >= expected) break
  await new Promise(resolve => setTimeout(resolve, 1000))
}
await sql.end()
process.stdout.write(String(known))
JS
)"

echo "==> Generating the configuration in $GENERATED_DIR"
mkdir -p "$GENERATED_DIR/certs"
if ! openssl x509 -checkend 86400 -noout -in "$GENERATED_DIR/certs/oidc.crt" 2>/dev/null; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj /CN=oidc \
    -addext 'subjectAltName=DNS:oidc,DNS:localhost' \
    -addext 'basicConstraints=critical,CA:TRUE' \
    -keyout "$GENERATED_DIR/certs/oidc.key" -out "$GENERATED_DIR/certs/oidc.crt" 2>/dev/null
  chmod 644 "$GENERATED_DIR/certs/oidc.key"
  # A running stack keeps the old certificate in memory, recreate who reads it
  compose rm --stop --force oidc backend
fi
[ -f "$GENERATED_DIR/people.json" ] || echo '{}' >"$GENERATED_DIR/people.json"

echo "==> Starting the stack as compose project '$QA_PROJECT'"
if ! compose up -d --wait --no-build; then
  echo "The stack did not start. Built the images? scripts/qa-environment/build.sh" >&2
  echo "Logs: docker compose -p $QA_PROJECT logs" >&2
  exit 1
fi

echo "==> Seeding the directory"
seed="$(compose exec -T backend node --input-type=module - <"$SCRIPT_DIR/seed.mjs")"
expected="$(head -n 1 <<<"$seed")"
tail -n +2 <<<"$seed" >"$GENERATED_DIR/people.json"

known="$(compose exec -T backend node --input-type=module -e "$SPACES_KNOWN" "$expected")"
if [ "$known" -lt "$expected" ]; then
  echo "The backend knows $known of the $expected seeded spaces, see: docker compose -p $QA_PROJECT logs backend ldap-rest" >&2
  exit 1
fi

cat <<INFO

==> The QA environment is up

  App: $APP_URL  (mock SSO: a "Sign in as <uid>" button per account)

Accounts: alice, bob, carol, dave (acme), erin (globex), see the top of this script

From a container (e.g. Playwright), join the network '${QA_PROJECT}_default' and use:
  --host-resolver-rules="MAP localhost:$QA_APP_PORT frontend:8080"
  --ignore-certificate-errors   (the mock SSO, https://oidc:8443, is self-signed)

Stop it with: scripts/qa-environment/stop.sh
INFO
