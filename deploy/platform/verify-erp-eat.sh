#!/usr/bin/env bash

set -Eeuo pipefail
set +x

readonly web_service='starsnap-erp_web'
readonly postgres_service='starsnap-erp_postgres'
readonly expected_schema_version='15'

single_running_container() {
  local service="$1" container_ids
  container_ids="$(docker ps \
    --filter "label=com.docker.swarm.service.name=$service" \
    --filter status=running \
    --format '{{.ID}}')"
  test "$(awk 'NF {count++} END {print count + 0}' <<<"$container_ids")" -eq 1
  awk 'NF {print; exit}' <<<"$container_ids"
}

web_container="$(single_running_container "$web_service")"
postgres_container="$(single_running_container "$postgres_service")"
readonly web_container postgres_container

docker exec "$web_container" node -e '
  Promise.all([
    fetch("http://127.0.0.1:3000/api/health", { headers: { host: "erp.starsnap.kr" } })
      .then(async (response) => ({ response, body: await response.json() })),
    import("node:fs").then(({ readFileSync }) => readFileSync(
      "/run/secrets/eat-api-service-key", "utf8",
    ).trim()),
  ]).then(([health, secret]) => {
    if (!health.response.ok || health.body?.ok !== true) throw new Error("ERP health failed");
    if (String(health.body.schemaVersion) !== process.argv[1]) {
      throw new Error(`Expected schema ${process.argv[1]}, got ${health.body.schemaVersion}`);
    }
    if (secret.length < 32) throw new Error("eAT secret file is invalid");
    console.log(`ERP health verified: schemaVersion=${health.body.schemaVersion} EatSecretReadable=true`);
  }).catch((error) => {
    console.error(`ERP health verification failed: ${error.message}`);
    process.exit(1);
  });
' "$expected_schema_version"

bidder_context="$(docker exec "$postgres_container" \
  psql --username mealops --dbname mealops --tuples-only --no-align --field-separator '|' \
  --command "
    SELECT t.code, u.id
    FROM tenants t
    JOIN tenant_memberships tm ON tm.tenant_id = t.id
    JOIN erp_users u ON u.id = tm.user_id
    WHERE t.organization_type = 'BIDDER'
      AND t.status = 'ACTIVE'
      AND u.status = 'ACTIVE'
    ORDER BY t.code, u.id
    LIMIT 1
  ")"
IFS='|' read -r tenant_code user_id <<<"$bidder_context"
readonly tenant_code user_id
[[ "$tenant_code" =~ ^[A-Z0-9][A-Z0-9-]{2,31}$ ]]
[[ "$user_id" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$ ]]

session_token="$(docker exec "$web_container" node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
session_hash="$(printf '%s' "$session_token" | docker exec --interactive "$web_container" node -e 'process.stdin.setEncoding("utf8"); let value=""; process.stdin.on("data", chunk => value += chunk); process.stdin.on("end", () => process.stdout.write(require("node:crypto").createHash("sha256").update(value).digest("hex")));')"
readonly session_token session_hash
[[ "$session_hash" =~ ^[0-9a-f]{64}$ ]]

cleanup_session() {
  docker exec "$postgres_container" \
    psql --username mealops --dbname mealops --no-psqlrc --quiet \
    --command "DELETE FROM auth_sessions WHERE token_hash = '$session_hash'" \
    >/dev/null 2>&1 || true
}
trap cleanup_session EXIT

docker exec "$postgres_container" \
  psql --username mealops --dbname mealops --no-psqlrc --quiet --set ON_ERROR_STOP=1 \
  --command "
    INSERT INTO auth_sessions (token_hash, user_id, expires_at)
    VALUES ('$session_hash', '$user_id', clock_timestamp() + interval '10 minutes')
  " >/dev/null

end_date="$(date -u +%Y-%m-%d)"
start_date="$(date -u -d '89 days ago' +%Y-%m-%d)"
smoke_page=1
readonly start_date end_date smoke_page

# Expire only this deterministic smoke-query cache entry so the first request
# proves a real upstream refresh and the second proves the DB cache path. Keep
# the stale row and its children available as a fallback if eAT is unavailable.
docker exec "$postgres_container" \
  psql --username mealops --dbname mealops --no-psqlrc --quiet --set ON_ERROR_STOP=1 \
  --command "
    UPDATE eat_bid_query_cache
    SET expires_at = fetched_at + interval '1 microsecond'
    WHERE normalized_filters ->> 'useOrganizationName' = '서울특별시교육청'
      AND normalized_filters ->> 'demandOrganizationName' = ''
      AND normalized_filters ->> 'bidName' = ''
      AND start_date = '$start_date'::date
      AND end_date = '$end_date'::date
      AND page = $smoke_page
      AND page_size = 1
  " >/dev/null

smoke_payload="$(docker exec "$web_container" node -e '
  process.stdout.write(JSON.stringify({
    tenant: process.argv[1],
    token: process.argv[2],
    startDate: process.argv[3],
    endDate: process.argv[4],
    page: Number(process.argv[5]),
  }));
' "$tenant_code" "$session_token" "$start_date" "$end_date" "$smoke_page")"

smoke_result="$(printf '%s' "$smoke_payload" | docker exec --interactive "$web_container" node -e '
  process.stdin.setEncoding("utf8");
  let input = "";
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", async () => {
    try {
      const smoke = JSON.parse(input);
      const url = new URL("http://127.0.0.1:3000/api/erp/eat/bids");
      url.searchParams.set("tenant", smoke.tenant);
      url.searchParams.set("announcementStartDate", smoke.startDate);
      url.searchParams.set("announcementEndDate", smoke.endDate);
      url.searchParams.set("useOrganizationName", "서울특별시교육청");
      url.searchParams.set("page", String(smoke.page));
      url.searchParams.set("pageSize", "1");
      const headers = {
        host: "erp.starsnap.kr",
        origin: "https://erp.starsnap.kr",
        "x-forwarded-host": "erp.starsnap.kr",
        "x-forwarded-proto": "https",
        cookie: `__Host-starsnap_session=${smoke.token}`,
      };
      async function lookup() {
        const response = await fetch(url, { headers });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${body.message ?? "unknown error"}`);
        }
        return body;
      }
      const first = await lookup();
      const second = await lookup();
      if (first.source !== "EAT") throw new Error(`Expected EAT source, got ${first.source}`);
      if (second.source !== "CACHE") throw new Error(`Expected CACHE source, got ${second.source}`);
      if (first.cachedAt !== second.cachedAt || first.total !== second.total) {
        throw new Error("Cached response does not match the upstream response");
      }
      if (!Array.isArray(first.items) || first.items.length !== 1) {
        throw new Error(`Expected one live eAT announcement, got ${first.items?.length ?? "invalid"}`);
      }
      if (JSON.stringify(first.items) !== JSON.stringify(second.items)) {
        throw new Error("Cached eAT announcement content differs from the upstream response");
      }
      const specCount = first.items.reduce(
        (count, item) => count + (Array.isArray(item.specs) ? item.specs.length : 0),
        0,
      );
      if (specCount < 1) throw new Error("The live eAT announcement contained no item specifications");
      console.log(JSON.stringify({
        firstSource: first.source,
        secondSource: second.source,
        total: first.total,
        itemCount: first.items.length,
        specCount,
        cachedAt: first.cachedAt,
      }));
    } catch (error) {
      console.error(`Authenticated eAT smoke failed: ${error.message}`);
      process.exit(1);
    }
  });
' )"
echo "$smoke_result"
spec_count="$(printf '%s' "$smoke_result" | docker exec --interactive "$web_container" node -e '
  process.stdin.setEncoding("utf8");
  let value = "";
  process.stdin.on("data", (chunk) => { value += chunk; });
  process.stdin.on("end", () => {
    const parsed = JSON.parse(value);
    if (!Number.isSafeInteger(parsed.specCount) || parsed.specCount < 1) process.exit(1);
    process.stdout.write(String(parsed.specCount));
  });
')"
readonly spec_count

cache_counts="$(docker exec "$postgres_container" \
  psql --username mealops --dbname mealops --tuples-only --no-align \
  --command "
    WITH matched AS (
      SELECT query_hash
      FROM eat_bid_query_cache
      WHERE normalized_filters ->> 'useOrganizationName' = '서울특별시교육청'
        AND normalized_filters ->> 'demandOrganizationName' = ''
        AND normalized_filters ->> 'bidName' = ''
        AND start_date = '$start_date'::date
        AND end_date = '$end_date'::date
        AND page = $smoke_page
        AND page_size = 1
        AND expires_at > fetched_at
    )
    SELECT
      (SELECT count(*) FROM matched),
      (SELECT count(*) FROM eat_bid_announcements WHERE query_hash IN (SELECT query_hash FROM matched)),
      (SELECT count(*) FROM eat_bid_item_specs WHERE query_hash IN (SELECT query_hash FROM matched))
  ")"
readonly cache_counts
IFS='|' read -r cache_rows announcement_rows specification_rows <<<"$cache_counts"
test "$cache_rows" = '1'
test "$announcement_rows" = '1'
test "$specification_rows" = "$spec_count"
echo 'Authenticated eAT upstream-to-DB-cache verification passed.'
