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
    import("node:fs").then(({ readFileSync }) => readFileSync(
      "/run/secrets/neis-api-key", "utf8",
    ).trim()),
    import("node:fs").then(({ readFileSync }) => readFileSync(
      process.env.STARSNAP_WORKER_SECRETS_FILE || "/app/dist/server/.dev.vars", "utf8",
    )),
  ]).then(([health, eatSecret, neisSecret, workerSecrets]) => {
    if (!health.response.ok || health.body?.ok !== true) throw new Error("ERP health failed");
    if (String(health.body.schemaVersion) !== process.argv[1]) {
      throw new Error(`Expected schema ${process.argv[1]}, got ${health.body.schemaVersion}`);
    }
    if (eatSecret.length < 32) throw new Error("eAT secret file is invalid");
    if (neisSecret.length < 16) throw new Error("NEIS secret file is invalid");
    if (workerSecrets.split(/\r?\n/).some(line => line.startsWith("NEIS_API_KEY="))) {
      throw new Error("NEIS secret must not be exposed to the Worker binding");
    }
    console.log(`ERP health verified: schemaVersion=${health.body.schemaVersion} EatSecretReadable=true NeisSecretReadable=true NeisWorkerIsolation=true`);
  }).catch((error) => {
    console.error(`ERP health verification failed: ${error.message}`);
    process.exit(1);
  });
' "$expected_schema_version"

docker exec "$web_container" node -e '
  const { readFileSync } = require("node:fs");
  const token = readFileSync("/run/secrets/embedding-worker-token", "utf8").trim();
  if (token.length < 32) throw new Error("Internal verification token is invalid");
  const url = new URL("http://127.0.0.1:3000/api/internal/neis/health");
  (async () => {
    let response;
    let body;
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            host: "erp.starsnap.kr",
          },
          signal: AbortSignal.timeout(10_000),
        });
        body = await response.json().catch(() => ({}));
        if (response.ok) break;
        const status = response.status;
        lastError = new Error(`HTTP ${status}: ${body.message ?? "unknown"}`);
        if (![502, 503, 504].includes(status)) break;
      } catch (error) {
        lastError = error;
      }
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 1_000));
    }
    if (!response?.ok) throw lastError ?? new Error("NEIS Worker health request failed");
    if (body?.ok !== true || body?.source !== "NEIS" || !Number.isSafeInteger(body?.total)) {
      throw new Error("NEIS Worker health response is invalid");
    }
    console.log(`Authenticated NEIS Worker lookup verified: total=${body.total}`);
  })().catch((error) => {
    console.error(`Authenticated NEIS Worker lookup failed: ${error.message}`);
    process.exit(1);
  });
'

bidder_context="$(docker exec "$postgres_container" \
  psql --username mealops --dbname mealops --tuples-only --no-align --field-separator '|' \
  --command "
    SELECT t.code, u.id
    FROM tenants t
    JOIN tenant_memberships tm ON tm.tenant_id = t.id
    JOIN erp_users u ON u.id = tm.user_id
    WHERE t.code = 'ORG-8025A70B4CF24D018F67'
      AND t.organization_type = 'BIDDER'
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

neis_bid_context="$(docker exec "$postgres_container" \
  psql --username mealops --dbname mealops --tuples-only --no-align --field-separator '|' \
  --command "
    SELECT bid.id,
           bid.contract_start::date::text,
           LEAST(bid.contract_end::date, bid.contract_start::date + 6)::text
    FROM school_bids bid
    JOIN tenants bidder
      ON bidder.id = bid.bidder_tenant_id
     AND bidder.code = '$tenant_code'
     AND bidder.organization_type = 'BIDDER'
     AND bidder.status = 'ACTIVE'
    JOIN schools school
      ON school.id = bid.school_id
     AND school.source = 'NEIS_SCHOOL_INFO'
     AND school.active = TRUE
     AND school.mapping_status = 'MAPPED'
    WHERE bid.status IN ('AWARDED', 'ACTIVE')
    ORDER BY bid.contract_start DESC, bid.id
    LIMIT 1
  ")"

docker exec "$web_container" node -e '
  const url = new URL("http://127.0.0.1:3000/api/erp/neis/meals");
  url.searchParams.set("tenant", process.argv[1]);
  url.searchParams.set("schoolBidId", "missing-smoke-bid");
  url.searchParams.set("fromDate", "2026-01-01");
  url.searchParams.set("toDate", "2026-01-02");
  fetch(url, {
    headers: {
      host: "erp.starsnap.kr",
      origin: "https://erp.starsnap.kr",
      "x-forwarded-host": "erp.starsnap.kr",
      "x-forwarded-proto": "https",
      cookie: `__Host-starsnap_session=${process.argv[2]}`,
    },
  }).then(async response => {
    const contentType = response.headers.get("content-type") || "";
    const body = await response.json().catch(() => ({}));
    const expectedMessage = "조회 가능한 계약 학교를 찾을 수 없습니다. 학교 입찰 정보를 확인해 주세요.";
    if (response.status !== 404 || !contentType.includes("application/json") || body.message !== expectedMessage) {
      throw new Error(`Expected protected NEIS route 404, got ${response.status}: ${body.message ?? "unknown"}`);
    }
    console.log("Authenticated NEIS ERP route protection verified.");
  }).catch(error => {
    console.error(`Authenticated NEIS ERP route protection failed: ${error.message}`);
    process.exit(1);
  });
' "$tenant_code" "$session_token"

if [[ -n "$neis_bid_context" ]]; then
  IFS='|' read -r neis_school_bid_id neis_from_date neis_to_date <<<"$neis_bid_context"
  readonly neis_school_bid_id neis_from_date neis_to_date
  [[ "$neis_school_bid_id" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$ ]]
  [[ "$neis_from_date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]
  [[ "$neis_to_date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]

  neis_route_payload="$(docker exec "$web_container" node -e '
  process.stdout.write(JSON.stringify({
    tenant: process.argv[1],
    token: process.argv[2],
    schoolBidId: process.argv[3],
    fromDate: process.argv[4],
    toDate: process.argv[5],
  }));
  ' "$tenant_code" "$session_token" "$neis_school_bid_id" "$neis_from_date" "$neis_to_date")"

  neis_route_result="$(printf '%s' "$neis_route_payload" | docker exec --interactive "$web_container" node -e '
  process.stdin.setEncoding("utf8");
  let input = "";
  process.stdin.on("data", chunk => input += chunk);
  process.stdin.on("end", async () => {
    try {
      const smoke = JSON.parse(input);
      const url = new URL("http://127.0.0.1:3000/api/erp/neis/meals");
      url.searchParams.set("tenant", smoke.tenant);
      url.searchParams.set("schoolBidId", smoke.schoolBidId);
      url.searchParams.set("fromDate", smoke.fromDate);
      url.searchParams.set("toDate", smoke.toDate);
      const headers = {
        host: "erp.starsnap.kr",
        origin: "https://erp.starsnap.kr",
        "x-forwarded-host": "erp.starsnap.kr",
        "x-forwarded-proto": "https",
        cookie: `__Host-starsnap_session=${smoke.token}`,
      };
      let response;
      let body;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        response = await fetch(url, { headers });
        body = await response.json().catch(() => ({}));
        if (response.ok) break;
        if (![502, 503, 504].includes(response.status) || attempt === 3) {
          throw new Error(`HTTP ${response.status}: ${body.message ?? "unknown error"}`);
        }
        await new Promise(resolve => setTimeout(resolve, attempt * 1_000));
      }
      if (body?.source !== "NEIS") throw new Error(`Expected NEIS source, got ${body?.source}`);
      if (body?.school?.bidId !== smoke.schoolBidId) throw new Error("NEIS school bid does not match request");
      if (body?.fromDate !== smoke.fromDate || body?.toDate !== smoke.toDate) {
        throw new Error("NEIS response range does not match request");
      }
      if (!Number.isSafeInteger(body?.total) || !Array.isArray(body?.items)) {
        throw new Error("NEIS response shape is invalid");
      }
      console.log(JSON.stringify({
        source: body.source,
        total: body.total,
        itemCount: body.items.length,
        schoolMatched: true,
      }));
    } catch (error) {
      console.error(`Authenticated NEIS ERP route smoke failed: ${error.message}`);
      process.exit(1);
    }
  });
  ')"
  echo "$neis_route_result"
else
  echo 'Authenticated NEIS meal data smoke skipped: no active mapped bidder contract exists.'
fi

start_date='2026-07-29'
end_date='2026-08-27'
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
    WHERE normalized_filters ->> 'useOrganizationName' = '교육청'
      AND normalized_filters ->> 'demandOrganizationName' = ''
      AND normalized_filters ->> 'bidName' = ''
      AND start_date = '$start_date'::date
      AND end_date = '$end_date'::date
      AND page = $smoke_page
      AND page_size = 20
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
      url.searchParams.set("useOrganizationName", "교육청");
      url.searchParams.set("page", String(smoke.page));
      url.searchParams.set("pageSize", "20");
      const headers = {
        host: "erp.starsnap.kr",
        origin: "https://erp.starsnap.kr",
        "x-forwarded-host": "erp.starsnap.kr",
        "x-forwarded-proto": "https",
        cookie: `__Host-starsnap_session=${smoke.token}`,
      };
      async function lookup({ endpoint = url, requestHeaders = headers, retryTransient = false } = {}) {
        const maximumAttempts = retryTransient ? 3 : 1;
        for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
          const response = await fetch(endpoint, { headers: requestHeaders });
          const body = await response.json().catch(() => ({}));
          if (response.ok) return body;
          const transient = [502, 503, 504].includes(response.status);
          if (!transient || attempt === maximumAttempts) {
            throw new Error(`HTTP ${response.status}: ${body.message ?? "unknown error"}`);
          }
          await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
        }
        throw new Error("eAT lookup retry loop exited unexpectedly");
      }
      const first = await lookup({ retryTransient: true });
      const second = await lookup();
      const publicUrl = new URL(`${url.pathname}${url.search}`, "https://erp.starsnap.kr");
      if (publicUrl.origin !== "https://erp.starsnap.kr") {
        throw new Error(`Unexpected public ERP origin: ${publicUrl.origin}`);
      }
      const publicResult = await lookup({
        endpoint: publicUrl,
        requestHeaders: { cookie: `__Host-starsnap_session=${smoke.token}` },
        retryTransient: true,
      });
      if (first.source !== "EAT") throw new Error(`Expected EAT source, got ${first.source}`);
      if (second.source !== "CACHE") throw new Error(`Expected CACHE source, got ${second.source}`);
      if (publicResult.source !== "CACHE") {
        throw new Error(`Expected public CACHE source, got ${publicResult.source}`);
      }
      if (first.cachedAt !== second.cachedAt || first.total !== second.total) {
        throw new Error("Cached response does not match the upstream response");
      }
      const expectedItemCount = Math.min(20, first.total);
      if (!Array.isArray(first.items) || first.items.length !== expectedItemCount) {
        throw new Error(`Expected ${expectedItemCount} live eAT announcements, got ${first.items?.length ?? "invalid"}`);
      }
      if (first.page !== 1 || first.pageSize !== 20 || first.total < 1) {
        throw new Error(`Unexpected eAT pagination: page=${first.page} pageSize=${first.pageSize} total=${first.total}`);
      }
      if (JSON.stringify(first.items) !== JSON.stringify(second.items)) {
        throw new Error("Cached eAT announcement content differs from the upstream response");
      }
      if (JSON.stringify(second) !== JSON.stringify(publicResult)) {
        throw new Error("Public ERP response differs from the verified container response");
      }
      const specCount = first.items.reduce(
        (count, item) => count + (Array.isArray(item.specs) ? item.specs.length : 0),
        0,
      );
      if (specCount < 1) throw new Error("The live eAT announcement contained no item specifications");
      console.log(JSON.stringify({
        firstSource: first.source,
        secondSource: second.source,
        publicSource: publicResult.source,
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
item_count="$(printf '%s' "$smoke_result" | docker exec --interactive "$web_container" node -e '
  process.stdin.setEncoding("utf8");
  let value = "";
  process.stdin.on("data", chunk => value += chunk);
  process.stdin.on("end", () => {
    const parsed = JSON.parse(value);
    if (!Number.isSafeInteger(parsed.itemCount) || parsed.itemCount < 1) process.exit(1);
    process.stdout.write(String(parsed.itemCount));
  });
')"
readonly spec_count item_count

cache_counts="$(docker exec "$postgres_container" \
  psql --username mealops --dbname mealops --tuples-only --no-align \
  --command "
    WITH matched AS (
      SELECT query_hash
      FROM eat_bid_query_cache
      WHERE normalized_filters ->> 'useOrganizationName' = '교육청'
        AND normalized_filters ->> 'demandOrganizationName' = ''
        AND normalized_filters ->> 'bidName' = ''
        AND start_date = '$start_date'::date
        AND end_date = '$end_date'::date
        AND page = $smoke_page
        AND page_size = 20
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
test "$announcement_rows" = "$item_count"
test "$specification_rows" = "$spec_count"
echo 'Authenticated eAT upstream-to-DB-cache verification passed.'
