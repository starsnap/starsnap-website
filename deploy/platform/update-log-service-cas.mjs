import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { isAbsolute } from "node:path";

const [serviceName, expectedVersionText, image, candidateSpecPath] = process.argv.slice(2);
if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/.test(serviceName ?? "")) {
  throw new Error("Service name is invalid.");
}
if (!/^\d+$/.test(expectedVersionText ?? "")) {
  throw new Error("Expected service version is invalid.");
}
if (!/^starsnap\.invalid\/[a-zA-Z0-9/_.:-]+$/.test(image ?? "")) {
  throw new Error("Manager-local image reference is invalid.");
}
if (!isAbsolute(candidateSpecPath ?? "")) throw new Error("Candidate spec path must be absolute.");

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
if (!service?.ID || !service?.Spec || service?.Version?.Index !== expectedVersion) {
  throw new Error("Service changed before the compare-and-swap update.");
}

const spec = structuredClone(service.Spec);
const taskTemplate = spec.TaskTemplate;
const containerSpec = taskTemplate?.ContainerSpec;
if (!taskTemplate || !containerSpec) throw new Error("Service task specification is incomplete.");
containerSpec.Image = image;
taskTemplate.ForceUpdate = Number(taskTemplate.ForceUpdate ?? 0) + 1;

const serializedSpec = JSON.stringify(spec);
writeFileSync(candidateSpecPath, `${serializedSpec}\n`, { encoding: "utf8", mode: 0o600 });
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
    let responseBody = "";
    result.setEncoding("utf8");
    result.on("data", (chunk) => { responseBody += chunk; });
    result.on("end", () => resolve({ status: result.statusCode ?? 0, body: responseBody }));
  });
  request.setTimeout(30_000, () => request.destroy(new Error("Docker API update timed out.")));
  request.on("error", reject);
  request.end(body);
});

if (response.status < 200 || response.status >= 300) {
  rmSync(candidateSpecPath, { force: true });
  throw new Error(`Docker rejected the versioned service update with HTTP ${response.status}.`);
}
console.log(`Versioned service update accepted: service=${serviceName} version=${expectedVersion}`);
