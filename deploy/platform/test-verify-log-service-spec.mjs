import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import process from "node:process";

const verifier = "deploy/platform/verify-log-service-spec.mjs";
const serverCommand = 'export SPRING_DATASOURCE_PASSWORD="$(< /run/secrets/hub-db-password)"; export HUB_SERVER_LOG_SECRET="$(< /run/secrets/hub-ingest-secret)"; export CLOUDFLARE_ACCESS_TEAM_DOMAIN="$(< /run/secrets/cloudflare-access-team-domain)"; export CLOUDFLARE_ACCESS_AUDIENCE="$(< /run/secrets/cloudflare-access-audience)"; exec java -jar /app/starsnap-log.jar';
const baseEnv = {
  ...process.env,
  EXPECTED_APP_NETWORK_ID: "app-network-id",
  EXPECTED_DATABASE_NETWORK_ID: "database-network-id",
  EXPECTED_IMAGE_MATCH: "true",
  EXPECTED_PUBLISH_PORT: "false",
  EXPECTED_SERVER_COMMAND: serverCommand,
  HUB_DB_PASSWORD_SECRET_NAME: "hub-db-v1",
  HUB_INGEST_SECRET_NAME: "hub-ingest-v1",
  CLOUDFLARE_ACCESS_TEAM_DOMAIN_SECRET_NAME: "cf-team-v1",
  CLOUDFLARE_ACCESS_AUDIENCE_SECRET_NAME: "cf-audience-v1",
};

function serviceFixture(kind) {
  const server = kind === "server";
  const image = `registry.example/log-${kind}:current`;
  const name = `starsnap-log_${kind}`;
  const aliases = [`starsnap-log-${kind}`, `starsnap-hub_${kind}`];
  const healthCommand = server
    ? "bash -ec 'exec 3<>/dev/tcp/127.0.0.1/8081'"
    : "node -e \"fetch('http://127.0.0.1:5173/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"";
  const container = {
    Image: image,
    Healthcheck: {
      Test: ["CMD-SHELL", healthCommand],
      Interval: 10_000_000_000,
      Timeout: 5_000_000_000,
      StartPeriod: server ? 180_000_000_000 : 15_000_000_000,
      Retries: server ? 8 : 5,
    },
    StopGracePeriod: server ? 30_000_000_000 : 20_000_000_000,
  };
  if (server) {
    container.Command = ["/bin/bash"];
    container.Args = ["-ec", serverCommand];
    container.Env = [
      "SPRING_DATASOURCE_URL=jdbc:postgresql://postgres:5432/starsnap_hub",
      "SPRING_DATASOURCE_USERNAME=starsnap",
    ];
    container.Secrets = [
      ["hub-db-v1", "hub-db-password"],
      ["hub-ingest-v1", "hub-ingest-secret"],
      ["cf-team-v1", "cloudflare-access-team-domain"],
      ["cf-audience-v1", "cloudflare-access-audience"],
    ].map(([SecretName, Name]) => ({
      SecretName,
      File: { Name, UID: "1000", GID: "1000", Mode: 256 },
    }));
  }
  return {
    Spec: {
      Name: name,
      TaskTemplate: {
        ContainerSpec: container,
        Placement: {
          Constraints: [
            "node.role == manager",
            "node.labels.starsnap.actions-runner == true",
          ],
        },
        Networks: server
          ? [
              { Target: "app-network-id", Aliases: aliases },
              { Target: "database-network-id" },
            ]
          : [{ Target: "app-network-id", Aliases: aliases }],
        RestartPolicy: {
          Condition: "on-failure",
          Delay: 5_000_000_000,
          MaxAttempts: server ? 8 : 5,
          Window: server ? 180_000_000_000 : 120_000_000_000,
        },
        Resources: {
          Reservations: {
            NanoCPUs: server ? 100_000_000 : 50_000_000,
            MemoryBytes: server ? 268_435_456 : 33_554_432,
          },
          Limits: {
            NanoCPUs: server ? 1_000_000_000 : 500_000_000,
            MemoryBytes: server ? 1_073_741_824 : 268_435_456,
          },
        },
      },
      UpdateConfig: {
        Parallelism: 1,
        Order: server ? "stop-first" : "start-first",
        FailureAction: "rollback",
        Monitor: server ? 240_000_000_000 : 60_000_000_000,
      },
      RollbackConfig: {
        Parallelism: 1,
        Order: "stop-first",
        Monitor: server ? 240_000_000_000 : 60_000_000_000,
      },
      EndpointSpec: { Ports: [] },
    },
    Endpoint: { Ports: [] },
    expected: { name, image, aliases },
  };
}

function verify(kind, fixture) {
  return spawnSync(process.execPath, [verifier], {
    encoding: "utf8",
    input: JSON.stringify(fixture),
    env: {
      ...baseEnv,
      EXPECTED_KIND: kind,
      EXPECTED_SERVICE: fixture.expected.name,
      EXPECTED_IMAGE: fixture.expected.image,
      EXPECTED_ALIASES: fixture.expected.aliases.join(","),
    },
  });
}

const server = serviceFixture("server");
const web = serviceFixture("web");
assert.equal(verify("server", server).status, 0);
assert.equal(verify("web", web).status, 0);

server.Spec.TaskTemplate.Networks[0].Aliases = [];
const drifted = verify("server", server);
assert.notEqual(drifted.status, 0);
assert.match(drifted.stderr, /network attachments and aliases/);

console.log("Log service specification verifier tests passed.");
