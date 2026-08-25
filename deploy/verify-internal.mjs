import http from "node:http";
import https from "node:https";

const requestTimeoutMs = 10_000;
const redirectUri = "/__starsnap_internal_verify__/path?source=swarm&value=1";

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
  expectMarker(
    await request(http, { hostname: "127.0.0.1", port: 3000, path: "/" }),
    "StarSnap",
    "website root",
  );
  expectNonEmpty(
    await request(http, { hostname: "127.0.0.1", port: 3000, path: "/icon.png" }),
    "website icon",
  );

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
    hostname: "192.168.1.2",
    port: 3001,
    path: "/api/health",
  });
  expectSuccess(erpHealth, "ERP LAN health");
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

  console.log("Internal route verification passed.");
}

main().catch((error) => {
  console.error(`Internal route verification failed: ${error.message}`);
  process.exitCode = 1;
});
