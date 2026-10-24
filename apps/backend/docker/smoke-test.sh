#!/usr/bin/env bash
# Boots the image as in production (uid 1000, read-only root filesystem, no capability)
# next to Postgres, RabbitMQ and a stub OIDC issuer, then checks it serves and stops cleanly.
#
#   apps/backend/docker/smoke-test.sh twake-space-backend:dev
set -euo pipefail

IMAGE="${1:?usage: $0 <image>}"
RUN="twake-space-backend-smoke-$$"
WORK="$(mktemp -d)"
cleanup() {
  docker rm -f "$RUN-backend" "$RUN-oidc" "$RUN-rabbitmq" "$RUN-postgres" >/dev/null 2>&1 || true
  docker network rm "$RUN" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT
DRIZZLE="$(cd "$(dirname "$0")/../drizzle" && pwd)"

docker network create "$RUN" >/dev/null

docker run -d --name "$RUN-postgres" --network "$RUN" --network-alias postgres \
  -e POSTGRES_USER=twake_space -e POSTGRES_PASSWORD=twake_space -e POSTGRES_DB=twake_space \
  postgres:18 >/dev/null

docker run -d --name "$RUN-rabbitmq" --network "$RUN" --network-alias rabbitmq \
  rabbitmq:4.1-management >/dev/null

# The backend only accepts an https issuer: a self-signed one it is told to trust.
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=oidc -addext subjectAltName=DNS:oidc \
  -keyout "$WORK/key.pem" -out "$WORK/cert.pem" 2>/dev/null
chmod 644 "$WORK/key.pem" "$WORK/cert.pem"
cat >"$WORK/oidc.mjs" <<'EOF'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:https'
const issuer = 'https://oidc/'
const metadata = {
  issuer,
  jwks_uri: `${issuer}jwks`,
  token_endpoint: `${issuer}token`,
  introspection_endpoint: `${issuer}introspect`,
  userinfo_endpoint: `${issuer}userinfo`
}
createServer(
  { key: readFileSync('/work/key.pem'), cert: readFileSync('/work/cert.pem') },
  (request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.url === '/.well-known/openid-configuration') return response.end(JSON.stringify(metadata))
    if (request.url === '/introspect') return response.end('{"active":false}')
    if (request.url === '/jwks') return response.end('{"keys":[]}')
    response.statusCode = 404
    response.end('{}')
  }
).listen(443)
EOF
docker run -d --name "$RUN-oidc" --network "$RUN" --network-alias oidc \
  -v "$WORK:/work:ro" node:24-slim node /work/oidc.mjs >/dev/null

for _ in $(seq 1 60); do
  docker exec "$RUN-rabbitmq" rabbitmqadmin --non-interactive show overview >/dev/null 2>&1 && break
  sleep 2
done
for exchange in space b2b admin-panel; do
  docker exec "$RUN-rabbitmq" rabbitmqadmin --non-interactive declare exchange \
    --name "$exchange" --type topic --durable true >/dev/null
done
for _ in $(seq 1 30); do
  docker exec "$RUN-postgres" pg_isready -U twake_space >/dev/null 2>&1 && break
  sleep 1
done

docker run -d --name "$RUN-backend" --network "$RUN" \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  -v "$WORK/cert.pem:/certs/oidc.pem:ro" -e NODE_EXTRA_CA_CERTS=/certs/oidc.pem \
  -p 127.0.0.1::8080 -p 127.0.0.1::9464 \
  -e AMQP_URL=amqp://guest:guest@rabbitmq:5672 \
  -e DATABASE_URL=postgres://twake_space:twake_space@postgres:5432/twake_space \
  -e LDAP_REST_URL=http://ldap-rest:8081 -e LDAP_REST_SERVICE_ID=twake-space \
  -e LDAP_REST_SECRET=smoke-test-secret-that-is-long-enough \
  -e OIDC_ISSUER=https://oidc/ -e OIDC_CLIENT_SECRET=smoke-test \
  "$IMAGE" >/dev/null
API="http://$(docker port "$RUN-backend" 8080/tcp | head -1)"
METRICS="http://$(docker port "$RUN-backend" 9464/tcp | head -1)"

failures=0
expect() {
  # shellcheck disable=SC2053 # $3 is a glob pattern
  if [[ "$2" == $3 ]]; then
    echo "ok   $1"
  else
    echo "FAIL $1: got '$2'"
    failures=$((failures + 1))
  fi
}
status() { curl -s -o /dev/null -w '%{http_code}' "$@" || true; }

for _ in $(seq 1 60); do
  [[ "$(status "$API/health/ready")" == 200 ]] && break
  sleep 1
done

expect 'ready once started' "$(status "$API/health/ready")" '200'
expect 'alive with its RabbitMQ consumer' "$(status "$API/health/live")" '200'
queues="$(docker exec "$RUN-rabbitmq" rabbitmqctl list_queues -q name arguments 2>&1 || true)"
bindings="$(docker exec "$RUN-rabbitmq" rabbitmqctl list_bindings -q source_name destination_name routing_key 2>&1 || true)"
expect 'declared the platform queue every replica consumes' \
  "$(grep $'^twake-space\\.platform\t' <<<"$queues" | grep -vc x-single-active-consumer || true)" '1'
expect 'bound every activity event to the activity queue' \
  "$(grep -cxF $'activity\ttwake-space.activity\t#' <<<"$bindings" || true)" '1'
expect 'kept them off the platform queue' \
  "$(grep -cxF $'activity\ttwake-space.platform\t#' <<<"$bindings" || true)" '0'
expect 'runs as uid 1000' "$(docker exec "$RUN-backend" stat -c %u /proc/1)" '1000'
expect 'applied every migration shipped' \
  "$(docker exec "$RUN-postgres" psql -U twake_space -tAc 'select count(*) from drizzle.__drizzle_migrations' 2>&1)" \
  "$(find "$DRIZZLE" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
expect 'API refuses a request without a token' "$(status "$API/spaces")" '401'
expect 'metrics served' "$(curl -fsS "$METRICS/metrics" 2>&1 || true)" '*twake_space_parked_events 0*'

docker kill -s TERM "$RUN-backend" >/dev/null
code="$(timeout 40 docker wait "$RUN-backend" || echo timeout)"
expect 'stops on SIGTERM with code 0' "$code" '0'

if ((failures > 0)); then
  echo "$failures check(s) failed; backend logs:"
  docker logs "$RUN-backend" 2>&1 | tail -40
  exit 1
fi
echo "all checks passed"
