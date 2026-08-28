import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const root = await mkdtemp(join(tmpdir(), "log-service-cas-"));
const socketPath = join(root, "docker.sock");
const dockerPath = join(root, "docker");
const updaterPath = new URL("./update-log-service-cas.mjs", import.meta.url).pathname;
const restorePath = new URL("./restore-log-service-cas.mjs", import.meta.url).pathname;
const baseline = {
  ID: "service-id",
  Version: { Index: 10 },
  Spec: {
    Name: "starsnap-log_server",
    TaskTemplate: {
      ForceUpdate: 7,
      ContainerSpec: { Image: "starsnap.invalid/previous:sha" },
    },
    EndpointSpec: { Ports: [{ PublishedPort: 8081, TargetPort: 8081 }] },
  },
};
await writeFile(dockerPath, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify([baseline])}'\n`);
await chmod(dockerPath, 0o700);

let responseStatus = 200;
let received = null;
const server = http.createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    received = { method: request.method, url: request.url, body: JSON.parse(body) };
    response.writeHead(responseStatus, { "Content-Type": "application/json" });
    response.end(responseStatus === 200 ? "{}" : '{"message":"update out of sequence"}');
  });
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(socketPath, resolve);
});

let metadataCounter = 0;
const run = (expectedVersion) => new Promise((resolve) => {
  metadataCounter += 1;
  const candidateSpecPath = join(root, `candidate-${metadataCounter}.json`);
  const child = spawn(process.execPath, [
    updaterPath,
    "starsnap-log_server",
    String(expectedVersion),
    "starsnap.invalid/starsnap-platform-local/starsnap-log-server:sha-candidate",
    candidateSpecPath,
  ], {
    env: {
      ...process.env,
      LOG_DOCKER_BIN: dockerPath,
      LOG_DOCKER_SOCKET: socketPath,
      LOG_DOCKER_API_VERSION: "1.52",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("close", (status) => resolve({ status, stdout, stderr, candidateSpecPath }));
});

try {
  const success = await run(10);
  if (success.status !== 0) throw new Error(success.stderr || "CAS success case failed.");
  if (received?.method !== "POST" || received?.url !== "/v1.52/services/service-id/update?version=10") {
    throw new Error("CAS request did not include the expected service ID and version.");
  }
  if (received.body.TaskTemplate.ContainerSpec.Image !== "starsnap.invalid/starsnap-platform-local/starsnap-log-server:sha-candidate") {
    throw new Error("CAS request did not set the candidate image.");
  }
  if (received.body.TaskTemplate.ForceUpdate !== 8 || received.body.EndpointSpec.Ports[0].PublishedPort !== 8081) {
    throw new Error("CAS request did not preserve the service specification.");
  }

  received = null;
  const stale = await run(9);
  if (stale.status === 0 || received !== null) throw new Error("Stale versions must fail before the API request.");

  responseStatus = 400;
  const conflict = await run(10);
  if (conflict.status === 0 || !conflict.stderr.includes("HTTP 400")) {
    throw new Error("Docker API conflicts must fail closed.");
  }
  const conflictMetadataExists = await access(conflict.candidateSpecPath).then(() => true).catch(() => false);
  if (conflictMetadataExists) throw new Error("Definitive CAS rejection must remove candidate metadata.");

  responseStatus = 200;
  const baselineSpecPath = join(root, "baseline.json");
  await writeFile(baselineSpecPath, `${JSON.stringify(baseline.Spec)}\n`, { mode: 0o600 });
  received = null;
  const restore = await new Promise((resolve) => {
    const child = spawn(process.execPath, [
      restorePath,
      "starsnap-log_server",
      "10",
      baselineSpecPath,
    ], {
      env: {
        ...process.env,
        LOG_DOCKER_BIN: dockerPath,
        LOG_DOCKER_SOCKET: socketPath,
        LOG_DOCKER_API_VERSION: "1.52",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stderr }));
  });
  if (restore.status !== 0) throw new Error(restore.stderr || "Versioned restore failed.");
  if (received?.url !== "/v1.52/services/service-id/update?version=10") {
    throw new Error("Restore did not use the expected service version.");
  }
  if (JSON.stringify(received.body) !== JSON.stringify(baseline.Spec)) {
    throw new Error("Restore did not submit the exact baseline specification.");
  }
  console.log("Versioned Log service update tests passed.");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
