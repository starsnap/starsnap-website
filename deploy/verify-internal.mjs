import http from "node:http";
import https from "node:https";

const requestTimeoutMs = 10_000;
const redirectUri = "/__starsnap_internal_verify__/path?source=swarm&value=1";
const securityProbeCases = [
  ["starsnap.kr", "/.env"],
  ["api.starsnap.kr", "/nested/.ENV.local"],
  ["erp.starsnap.kr", "/%2Eenv"],
  ["sns.starsnap.kr", "/nested/.git/config"],
  ["chat.starsnap.kr", "/.git%2Fconfig"],
  ["bible.starsnap.kr", "/nested/.env.production"],
  ["bible.starsnap.kr", "/api/bible/.env"],
  ["admin.starsnap.kr", "/WP-LOGIN.PHP"],
  ["log.starsnap.kr", "/nested/PHPMyAdmin/"],
];

function request(client, options) {
  return new Promise((resolve, reject) => {
    const req = client.request(
      {
        method: "GET",
        agent: false,
        timeout: requestTimeoutMs,
        ...options,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            body: Buffer.concat(chunks),
            headers: response.headers,
            status: response.statusCode ?? 0,
          });
        });
      },
    );

    req.on("timeout", () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
    req.end();
  });
}

function expectSuccess(response, label) {
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${label} returned HTTP ${response.status}`);
  }
}

function expectStatus(response, status, label) {
  if (response.status !== status) {
    throw new Error(`${label} returned HTTP ${response.status}`);
  }
}

function expectMarker(response, marker, label) {
  expectSuccess(response, label);
  if (!response.body.includes(Buffer.from(marker))) {
    throw new Error(`${label} did not contain ${marker}`);
  }
}

function expectHeader(response, name, value, label) {
  const actual = response.headers[name.toLowerCase()];
  if (actual !== value) {
    throw new Error(`${label} returned ${name}=${actual ?? ""}`);
  }
}

function expectNonEmpty(response, label) {
  expectSuccess(response, label);
  if (response.body.length === 0) {
    throw new Error(`${label} returned an empty body`);
  }
}

function expectRedirect(response, status, location, label) {
  if (response.status !== status || response.headers.location !== location) {
    throw new Error(
      `${label} returned status=${response.status} location=${response.headers.location ?? ""}`,
    );
  }
}

function caddyHttp(host, path) {
  return request(http, {
    hostname: "caddy",
    port: 80,
    path,
    headers: { host },
  });
}

function caddyHttps(host, path) {
  return request(https, {
    hostname: "caddy",
    port: 443,
    path,
    headers: { host },
    servername: host,
    rejectUnauthorized: true,
  });
}

async function main() {
  expectRedirect(
    await caddyHttp("starsnap.kr", redirectUri),
    308,
    `https://starsnap.kr${redirectUri}`,
    "apex HTTP redirect",
  );
  expectMarker(
    await caddyHttps("starsnap.kr", "/"),
    "StarSnap",
    "apex HTTPS root",
  );
  expectNonEmpty(await caddyHttps("starsnap.kr", "/icon.png"), "apex HTTPS icon");

  expectRedirect(
    await caddyHttp("www.starsnap.kr", redirectUri),
    301,
    `https://starsnap.kr${redirectUri}`,
    "www HTTP redirect",
  );
  expectRedirect(
    await caddyHttps("www.starsnap.kr", redirectUri),
    301,
    `https://starsnap.kr${redirectUri}`,
    "www HTTPS redirect",
  );

  expectRedirect(
    await caddyHttp("api.starsnap.kr", "/api/health"),
    308,
    "https://api.starsnap.kr/api/health",
    "API HTTP redirect",
  );
  const apiHealth = await caddyHttps("api.starsnap.kr", "/api/health");
  expectSuccess(apiHealth, "API HTTPS health");
  let apiPayload;
  try {
    apiPayload = JSON.parse(apiHealth.body.toString("utf8"));
  } catch {
    throw new Error("API HTTPS health did not return JSON");
  }
  if (apiPayload.status !== "ok") {
    throw new Error("API HTTPS health status was not ok");
  }

  expectRedirect(
    await caddyHttp("erp.starsnap.kr", "/api/health"),
    308,
    "https://erp.starsnap.kr/api/health",
    "ERP HTTP redirect",
  );
  expectMarker(
    await caddyHttps("erp.starsnap.kr", "/"),
    "StarSnap ERP",
    "ERP HTTPS root",
  );
  expectStatus(
    await caddyHttps("erp.starsnap.kr", "/api/health"),
    404,
    "ERP public health",
  );
  expectStatus(
    await caddyHttps("erp.starsnap.kr", "/api/health/"),
    404,
    "ERP public trailing-slash health",
  );
  const erpHealth = await request(http, {
    hostname: "starsnap-erp_web",
    port: 3000,
    path: "/api/health",
    headers: { host: "erp.starsnap.kr" },
  });
  expectSuccess(erpHealth, "ERP service health");
  let erpPayload;
  try {
    erpPayload = JSON.parse(erpHealth.body.toString("utf8"));
  } catch {
    throw new Error("ERP LAN health did not return JSON");
  }
  if (erpPayload.ok !== true) {
    throw new Error("ERP LAN health status was not ok");
  }

  expectRedirect(
    await caddyHttp("sns.starsnap.kr", "/api/health"),
    308,
    "https://sns.starsnap.kr/api/health",
    "SNS HTTP redirect",
  );
  expectMarker(
    await caddyHttps("sns.starsnap.kr", "/"),
    "<title>StarSnap</title>",
    "SNS HTTPS root",
  );
  const snsHealth = await caddyHttps("sns.starsnap.kr", "/api/health");
  expectSuccess(snsHealth, "SNS HTTPS health");
  let snsPayload;
  try {
    snsPayload = JSON.parse(snsHealth.body.toString("utf8"));
  } catch {
    throw new Error("SNS HTTPS health did not return JSON");
  }
  if (snsPayload.status !== "ok") {
    throw new Error("SNS HTTPS health status was not ok");
  }

  expectRedirect(
    await caddyHttp("chat.starsnap.kr", "/api/health"),
    308,
    "https://chat.starsnap.kr/api/health",
    "Chat HTTP redirect",
  );
  const chatRoot = await caddyHttps("chat.starsnap.kr", "/");
  expectMarker(
    chatRoot,
    'name="starsnap-app-surfaces" content="social chat bible"',
    "Chat HTTPS root",
  );
  expectHeader(chatRoot, "x-starsnap-app-surface", "chat", "Chat HTTPS root");
  expectHeader(chatRoot, "x-frame-options", "DENY", "Chat HTTPS root");
  expectHeader(chatRoot, "x-content-type-options", "nosniff", "Chat HTTPS root");
  expectHeader(
    chatRoot,
    "referrer-policy",
    "strict-origin-when-cross-origin",
    "Chat HTTPS root",
  );
  const chatHealth = await caddyHttps("chat.starsnap.kr", "/api/health");
  expectSuccess(chatHealth, "Chat HTTPS health");
  let chatPayload;
  try {
    chatPayload = JSON.parse(chatHealth.body.toString("utf8"));
  } catch {
    throw new Error("Chat HTTPS health did not return JSON");
  }
  if (chatPayload.status !== "ok") {
    throw new Error("Chat HTTPS health status was not ok");
  }

  expectRedirect(
    await caddyHttp("bible.starsnap.kr", "/api/health"),
    308,
    "https://bible.starsnap.kr/api/health",
    "Bible HTTP redirect",
  );
  const bibleRoot = await caddyHttps("bible.starsnap.kr", "/");
  expectMarker(
    bibleRoot,
    'name="starsnap-app-surfaces" content="social chat bible"',
    "Bible HTTPS root",
  );
  expectHeader(bibleRoot, "x-starsnap-app-surface", "bible", "Bible HTTPS root");
  expectHeader(bibleRoot, "x-frame-options", "DENY", "Bible HTTPS root");
  expectHeader(bibleRoot, "x-content-type-options", "nosniff", "Bible HTTPS root");
  expectHeader(
    bibleRoot,
    "referrer-policy",
    "strict-origin-when-cross-origin",
    "Bible HTTPS root",
  );
  const bibleHealth = await caddyHttps("bible.starsnap.kr", "/api/health");
  expectSuccess(bibleHealth, "Bible HTTPS health");
  let biblePayload;
  try {
    biblePayload = JSON.parse(bibleHealth.body.toString("utf8"));
  } catch {
    throw new Error("Bible HTTPS health did not return JSON");
  }
  if (biblePayload.status !== "UP" || biblePayload.service !== "starsnap-bible-server") {
    throw new Error("Bible HTTPS health response was not ready");
  }

  expectRedirect(
    await caddyHttp("admin.starsnap.kr", "/api/health"),
    308,
    "https://admin.starsnap.kr/api/health",
    "Admin HTTP redirect",
  );
  expectMarker(
    await caddyHttps("admin.starsnap.kr", "/"),
    "StarSnap Admin",
    "Admin HTTPS root",
  );
  const adminHealth = await caddyHttps("admin.starsnap.kr", "/api/health");
  expectStatus(adminHealth, 200, "Admin HTTPS health");
  let adminPayload;
  try {
    adminPayload = JSON.parse(adminHealth.body.toString("utf8"));
  } catch {
    throw new Error("Admin HTTPS health did not return JSON");
  }
  if (adminPayload.status !== "ok") {
    throw new Error("Admin HTTPS health status was not ok");
  }

  expectRedirect(
    await caddyHttp("log.starsnap.kr", "/"),
    308,
    "https://log.starsnap.kr/",
    "Log Hub HTTP redirect",
  );
  expectMarker(
    await caddyHttps("log.starsnap.kr", "/"),
    "StarSnap Log Dashboard",
    "Log Hub HTTPS root",
  );
  const logServicesPath =
    "/api/dashboard/services?startAt=2026-01-01T00%3A00%3A00Z&endAt=2100-01-01T00%3A00%3A00Z";
  expectStatus(
    await caddyHttps("log.starsnap.kr", logServicesPath),
    401,
    "Log Hub dashboard Access gate",
  );
  const logHealth = await request(http, {
    hostname: "starsnap-log_server",
    port: 8081,
    path: "/actuator/health",
    headers: { host: "log.starsnap.kr" },
  });
  expectStatus(logHealth, 200, "Log Hub service health");
  let logHealthPayload;
  try {
    logHealthPayload = JSON.parse(logHealth.body.toString("utf8"));
  } catch {
    throw new Error("Log Hub service health did not return JSON");
  }
  if (logHealthPayload.status !== "UP") {
    throw new Error("Log Hub service health status was not UP");
  }
  expectStatus(
    await caddyHttps("log.starsnap.kr", "/api/server-logs"),
    404,
    "Log Hub public server-log ingestion",
  );

  for (const [host, path] of securityProbeCases) {
    const securityProbeResponse = await caddyHttps(host, path);
    expectStatus(
      securityProbeResponse,
      404,
      `security probe guard ${host}${path}`,
    );
    expectHeader(
      securityProbeResponse,
      "x-starsnap-edge-guard",
      "scanner-probe",
      `security probe guard ${host}${path}`,
    );
  }

  console.log("Internal route verification passed.");
}

main().catch((error) => {
  console.error(`Internal route verification failed: ${error.message}`);
  process.exitCode = 1;
});
