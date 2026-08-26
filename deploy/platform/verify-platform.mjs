import http from "node:http";

const timeoutMs = 10_000;

function request(hostname, port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname, port, path, method: "GET", timeout: timeoutMs, agent: false },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            body: Buffer.concat(chunks),
            status: response.statusCode ?? 0,
          }),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
    req.end();
  });
}

function expectStatus(response, status, label) {
  if (response.status !== status) {
    throw new Error(`${label} returned HTTP ${response.status}`);
  }
}

function expectMarker(response, marker, label) {
  expectStatus(response, 200, label);
  if (!response.body.includes(Buffer.from(marker))) {
    throw new Error(`${label} did not contain ${marker}`);
  }
}

function parseJson(response, label) {
  expectStatus(response, 200, label);
  try {
    return JSON.parse(response.body.toString("utf8"));
  } catch {
    throw new Error(`${label} did not return JSON`);
  }
}

async function main() {
  expectMarker(
    await request("starsnap-sns_web", 3000, "/"),
    "<title>StarSnap</title>",
    "SNS service root",
  );

  expectMarker(
    await request("starsnap-admin_web", 5174, "/"),
    "StarSnap Admin",
    "Admin web service root",
  );
  const adminHealth = parseJson(
    await request("starsnap-admin_server", 8082, "/api/health"),
    "Admin service health",
  );
  if (adminHealth.status !== "ok") {
    throw new Error("Admin service health status was not ok");
  }

  expectMarker(
    await request("starsnap-hub_web", 5173, "/"),
    "StarSnap Log Dashboard",
    "Log Hub web service root",
  );
  const hubHealth = parseJson(
    await request("starsnap-hub_server", 8081, "/actuator/health"),
    "Log Hub service health",
  );
  if (hubHealth.status !== "UP") {
    throw new Error("Log Hub service health status was not UP");
  }

  expectMarker(
    await request("starsnap-erp_web", 3000, "/"),
    "StarSnap ERP",
    "ERP service root",
  );
  const erpHealth = parseJson(
    await request("starsnap-erp_web", 3000, "/api/health"),
    "ERP service health",
  );
  if (erpHealth.ok !== true) {
    throw new Error("ERP service health status was not ok");
  }

  console.log("Target platform service verification passed.");
}

main().catch((error) => {
  console.error(`Target platform service verification failed: ${error.message}`);
  process.exitCode = 1;
});
