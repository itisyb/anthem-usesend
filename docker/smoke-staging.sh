#!/bin/sh
set -eu
: "${IMAGE:?}" "${DIGEST:?}" "${EXPECTED_SHA:?}"
cleanup() {
  docker rm -f anthem-smoke-app anthem-smoke-postgres anthem-smoke-redis >/dev/null 2>&1 || true
  docker network rm anthem-email-smoke >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker network create anthem-email-smoke
docker run -d --name anthem-smoke-postgres --network anthem-email-smoke \
  -e POSTGRES_USER=usesend -e POSTGRES_PASSWORD=smoke-only -e POSTGRES_DB=usesend_test postgres:16
docker run -d --name anthem-smoke-redis --network anthem-email-smoke redis:7
attempt=0
until docker exec anthem-smoke-postgres pg_isready -U usesend -d usesend_test; do
  attempt=$((attempt + 1)); [ "$attempt" -lt 30 ] || exit 1; sleep 2
done
artifact="${IMAGE}@${DIGEST}"
database='postgresql://usesend:smoke-only@anthem-smoke-postgres:5432/usesend_test'
docker pull "$artifact"
docker run --rm --network anthem-email-smoke -e DATABASE_URL="$database" \
  --entrypoint node "$artifact" node_modules/prisma/build/index.js migrate deploy --schema ./apps/web/prisma/schema.prisma
docker run -d --name anthem-smoke-app --network anthem-email-smoke -p 127.0.0.1:3300:3000 \
  -e DATABASE_URL="$database" -e REDIS_URL=redis://anthem-smoke-redis:6379/15 \
  -e NEXTAUTH_URL=http://localhost:3300 -e NEXTAUTH_SECRET=staging-smoke-only \
  -e AWS_ACCESS_KEY_ID=smoke-only -e AWS_SECRET_ACCESS_KEY=smoke-only \
  -e AWS_DEFAULT_REGION=us-east-1 -e HOSTNAME=0.0.0.0 -e RUN_DATABASE_MIGRATIONS=false "$artifact"
attempt=0
until curl -fsS http://127.0.0.1:3300/api/ready > /tmp/anthem-ready.json; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 45 ]; then docker logs --tail 100 anthem-smoke-app; exit 1; fi
  sleep 2
done
node -e 'const value = JSON.parse(require("fs").readFileSync("/tmp/anthem-ready.json", "utf8")); if(value.status !== "ok" || value.commit !== process.env.EXPECTED_SHA) throw new Error("Readiness commit mismatch");'
curl -fsS http://127.0.0.1:3300/api/health
status=$(curl -sS -o /tmp/anthem-callback.json -w '%{http_code}' -X POST -H 'Content-Type: application/json' --data '{}' http://127.0.0.1:3300/api/ses_callback)
[ "$status" = 403 ] || { echo "Unsigned callback was not rejected: $status"; exit 1; }
echo "Staging image startup, migrated readiness, commit identity, liveness and callback rejection passed."
