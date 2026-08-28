import process from "node:process";

function fail(message) {
  console.error(`Log service specification mismatch: ${message}`);
  process.exit(1);
}

function equal(actual, expected, label) {
  if (actual !== expected) {
    fail(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function equalSet(actual, expected, label) {
  equal(JSON.stringify(sorted(actual)), JSON.stringify(sorted(expected)), label);
}

function duration(value) {
  return Number(value ?? 0);
}

const input = await new Promise((resolve, reject) => {
  let body = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    body += chunk;
  });
  process.stdin.on("end", () => resolve(body));
  process.stdin.on("error", reject);
});

let service;
try {
  const parsed = JSON.parse(input);
  service = Array.isArray(parsed) ? parsed[0] : parsed;
} catch (error) {
  fail(`service inspect JSON could not be parsed: ${error.message}`);
}

const kind = process.env.EXPECTED_KIND;
const spec = service?.Spec;
const task = spec?.TaskTemplate;
const container = task?.ContainerSpec;
if (!spec || !task || !container) fail("missing service task specification");
if (kind !== "server" && kind !== "web") fail(`unsupported service kind ${kind}`);

equal(spec.Name, process.env.EXPECTED_SERVICE, "service name");
if (process.env.EXPECTED_IMAGE_MATCH === "true") {
  equal(container.Image, process.env.EXPECTED_IMAGE, "image");
} else if (!container.Image) {
  fail("image is empty");
}

const constraints = task.Placement?.Constraints ?? [];
equalSet(
  constraints,
  ["node.role == manager", "node.labels.starsnap.actions-runner == true"],
  "placement constraints",
);

const expectedNetworks = kind === "server"
  ? [
      [process.env.EXPECTED_APP_NETWORK_ID, process.env.EXPECTED_LEGACY_ALIAS],
      [process.env.EXPECTED_DATABASE_NETWORK_ID, ""],
    ]
  : [[process.env.EXPECTED_APP_NETWORK_ID, process.env.EXPECTED_LEGACY_ALIAS]];
const actualNetworks = (task.Networks ?? []).map((network) => [
  network.Target,
  sorted(network.Aliases ?? []).join(","),
]);
equal(
  JSON.stringify(actualNetworks.sort()),
  JSON.stringify(expectedNetworks.sort()),
  "network attachments and aliases",
);

const health = container.Healthcheck;
const expectedHealthCommand = kind === "server"
  ? "bash -ec 'exec 3<>/dev/tcp/127.0.0.1/8081'"
  : "node -e \"fetch('http://127.0.0.1:5173/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"";
equal(JSON.stringify(health?.Test), JSON.stringify(["CMD-SHELL", expectedHealthCommand]), "health command");
equal(duration(health?.Interval), 10_000_000_000, "health interval");
equal(duration(health?.Timeout), 5_000_000_000, "health timeout");
equal(duration(health?.StartPeriod), kind === "server" ? 180_000_000_000 : 15_000_000_000, "health start period");
equal(Number(health?.Retries), kind === "server" ? 8 : 5, "health retries");
equal(duration(container.StopGracePeriod), kind === "server" ? 30_000_000_000 : 20_000_000_000, "stop grace period");

const restart = task.RestartPolicy;
equal(restart?.Condition, "on-failure", "restart condition");
equal(duration(restart?.Delay), 5_000_000_000, "restart delay");
equal(Number(restart?.MaxAttempts), kind === "server" ? 8 : 5, "restart max attempts");
equal(duration(restart?.Window), kind === "server" ? 180_000_000_000 : 120_000_000_000, "restart window");

const update = spec.UpdateConfig;
equal(Number(update?.Parallelism), 1, "update parallelism");
equal(update?.Order, kind === "server" ? "stop-first" : "start-first", "update order");
equal(update?.FailureAction, "rollback", "update failure action");
equal(duration(update?.Monitor), kind === "server" ? 240_000_000_000 : 60_000_000_000, "update monitor");

const rollback = spec.RollbackConfig;
equal(Number(rollback?.Parallelism), 1, "rollback parallelism");
equal(rollback?.Order, "stop-first", "rollback order");
equal(duration(rollback?.Monitor), kind === "server" ? 240_000_000_000 : 60_000_000_000, "rollback monitor");

const resources = task.Resources;
equal(Number(resources?.Reservations?.NanoCPUs), kind === "server" ? 100_000_000 : 50_000_000, "reserved CPU");
equal(Number(resources?.Reservations?.MemoryBytes), kind === "server" ? 268_435_456 : 33_554_432, "reserved memory");
equal(Number(resources?.Limits?.NanoCPUs), kind === "server" ? 1_000_000_000 : 500_000_000, "CPU limit");
equal(Number(resources?.Limits?.MemoryBytes), kind === "server" ? 1_073_741_824 : 268_435_456, "memory limit");

const actualPorts = (service.Endpoint?.Ports ?? spec.EndpointSpec?.Ports ?? []).map((port) => ({
  Protocol: port.Protocol,
  PublishMode: port.PublishMode,
  PublishedPort: Number(port.PublishedPort),
  TargetPort: Number(port.TargetPort),
}));
const expectedPorts = kind === "server" && process.env.EXPECTED_PUBLISH_PORT === "true"
  ? [{ Protocol: "tcp", PublishMode: "host", PublishedPort: 8081, TargetPort: 8081 }]
  : [];
equal(JSON.stringify(actualPorts), JSON.stringify(expectedPorts), "published ports");

if (kind === "server") {
  equal(JSON.stringify(container.Command), JSON.stringify(["/bin/bash"]), "entrypoint");
  equal(JSON.stringify(container.Args), JSON.stringify(["-ec", process.env.EXPECTED_SERVER_COMMAND]), "server command");
  equalSet(
    container.Env ?? [],
    [
      "SPRING_DATASOURCE_URL=jdbc:postgresql://postgres:5432/starsnap_hub",
      "SPRING_DATASOURCE_USERNAME=starsnap",
    ],
    "environment",
  );
  const actualSecrets = (container.Secrets ?? []).map((secret) => [
    secret.SecretName,
    secret.File?.Name,
    String(secret.File?.UID),
    String(secret.File?.GID),
    Number(secret.File?.Mode),
  ].join("|"));
  const expectedSecrets = [
    [process.env.HUB_DB_PASSWORD_SECRET_NAME, "hub-db-password", "1000", "1000", 256],
    [process.env.HUB_INGEST_SECRET_NAME, "hub-ingest-secret", "1000", "1000", 256],
    [process.env.CLOUDFLARE_ACCESS_TEAM_DOMAIN_SECRET_NAME, "cloudflare-access-team-domain", "1000", "1000", 256],
    [process.env.CLOUDFLARE_ACCESS_AUDIENCE_SECRET_NAME, "cloudflare-access-audience", "1000", "1000", 256],
  ].map((secret) => secret.join("|"));
  equalSet(actualSecrets, expectedSecrets, "secret mounts");
} else {
  equal((container.Command ?? []).length, 0, "web entrypoint");
  equal((container.Args ?? []).length, 0, "web arguments");
  equal((container.Env ?? []).length, 0, "web environment");
  equal((container.Secrets ?? []).length, 0, "web secrets");
}
