import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";

const [serviceName, expectedVersionText, specPath] = process.argv.slice(2);
if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/.test(serviceName ?? "")) {
  throw new Error("Service name is invalid.");
}
if (!/^\d+$/.test(expectedVersionText ?? "")) {
  throw new Error("Expected service version is invalid.");
}

const dockerBinary = process.env.LOG_DOCKER_BIN || "docker";
const socketPath = process.env.LOG_DOCKER_SOCKET || "/var/run/docker.sock";
const apiVersion = process.env.LOG_DOCKER_API_VERSION || execFileSync(
  dockerBinary,
  ["version", "--format", "{{.Server.APIVersion}}"],
  { encoding: "utf8" },
).trim();
if (!/^\d+\.\d+$/.test(apiVersion)) throw new Error("Docker API version is invalid.");

const inspected = JSON.parse(execFileSync(
  dockerBinary,
  ["service", "inspect", serviceName],
  { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
));
const service = Array.isArray(inspected) ? inspected[0] : inspected;
const expectedVersion = Number(expectedVersionText);
if (!service?.ID || service?.Version?.Index !== expectedVersion) {
  throw new Error("Service changed before the compare-and-swap restore.");
}

const serializedSpec = readFileSync(specPath, "utf8").trim();
const spec = JSON.parse(serializedSpec);
if (spec?.Name !== serviceName || !spec?.TaskTemplate?.ContainerSpec) {
  throw new Error("Baseline service specification is invalid.");
}
const body = Buffer.from(serializedSpec);
const response = await new Promise((resolve, reject) => {
  const request = http.request({
    socketPath,
    path: `/v${apiVersion}/services/${encodeURIComponent(service.ID)}/update?version=${expectedVersion}`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": body.length,
    },
  }, (result) => {
    result.resume();
    result.on("end", () => resolve(result.statusCode ?? 0));
  });
  request.setTimeout(30_000, () => request.destroy(new Error("Docker API restore timed out.")));
  request.on("error", reject);
  request.end(body);
});

if (response < 200 || response >= 300) {
  throw new Error(`Docker rejected the versioned service restore with HTTP ${response}.`);
}
console.log(`Versioned service restore accepted: service=${serviceName} version=${expectedVersion}`);
