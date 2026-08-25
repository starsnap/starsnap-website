# StarSnap company deployment

The container workflow builds one multi-platform image, publishes its immutable
manifest digest, smoke-tests that exact digest on AMD64 and ARM64, promotes the
verified digest to `latest`, and then deploys the digest to Docker Swarm.

## GitHub configuration

The deploy job is disabled until all of the following exist:

- An organization self-hosted runner on the ARM64 Swarm manager in the
  `starsnap-production` runner group with the `starsnap-swarm` label.
- The runner group must allow this public repository and must restrict workflow
  access to `starsnap/starsnap-website/.github/workflows/container.yml@refs/heads/main`.
- A repository variable named `STARSNAP_HEALTH_URL` whose value is the published
  site root, such as `http://192.168.1.103:3000/`.
- A repository variable named `STARSNAP_PROXY_HEALTH_URL` whose value is the
  Swarm manager's internal HTTP origin on port 80, such as
  `http://192.168.1.103/`. The deploy script sends explicit `starsnap.kr` and
  `www.starsnap.kr` Host headers to this origin, so it does not depend on router
  hairpin NAT or public DNS during rollout verification.
- A repository variable named `SWARM_DEPLOY_ENABLED` set to `true`.
- A GitHub environment named `production` that permits only `main` and follows
  the organization's chosen reviewer and administrator-bypass policy.

The runner registration token is one-time bootstrap material. Never commit it,
write it into a stack file, or leave it in a long-lived service environment.
Local `deploy/*.token` and `deploy/*.secret` files are ignored as a final guard,
but the preferred flow is to avoid writing the token to disk at all.

The runner itself is defined by:

- `github-runner-entrypoint.sh`: validates the manager socket, drops from the
  bootstrap user to UID 1001 with the socket GID, persists only runner identity
  state, and refuses incomplete state.
- `github-runner-stack.bootstrap.yml`: attaches the one-time registration token
  secret only for the first registration.
- `github-runner-stack.yml`: steady-state service with no registration secret.

Create the versioned Swarm config `starsnap_runner_entrypoint_v3` from the
entrypoint file, add `starsnap.actions-runner=true` only to the intended ARM64
manager, and deploy the bootstrap stack once as `starsnap-actions-runner`.
After the runner is online, immediately replace the stack with the steady-state
file, verify the replacement task and GitHub runner are healthy, verify that the
service has no attached secret, and delete
`starsnap_runner_registration_token_bootstrap`.
Keep `SWARM_DEPLOY_ENABLED` unset throughout bootstrap and secret cleanup. Set it
to `true` only after the steady-state service and empty secret attachment are
verified.

The runner image is pinned to the ARM64 manifest digest for official GitHub
Actions Runner `2.336.0`. Updates are intentional changes: verify the new ARM64
digest before replacing it, since the runner is configured with automatic
updates disabled.

The deploy runner has Swarm-manager-level authority. Keep its runner group
restricted to the exact workflow above, never add pull-request or fork triggers
to the deploy job, and protect workflow changes on `main` before granting
additional collaborators write access.

## Deployment guarantees

- Production uses `ghcr.io/starsnap/starsnap-website@sha256:...`, never a mutable
  tag.
- The deploy script refuses an unexpected repository or malformed digest.
- Swarm updates are serialized and use start-first updates with automatic
  rollback.
- The workflow waits for `1/1` replicas, a completed update, a StarSnap response,
  and a reachable `/icon.png` before reporting success.
- On verification failure, the workflow requests a rollback when a previous
  service specification exists.

## Caddy edge service

The same `starsnap-company` stack runs the official Caddy `2.10.2-alpine`
multi-platform image pinned by immutable manifest digest. Caddy is constrained
to the manager carrying `starsnap.actions-runner=true`, which keeps its local
certificate volumes on the same node, and publishes TCP ports 80 and 443. The
website keeps its existing port 3000 publication for direct internal
diagnostics.

`Caddyfile` provides these routes:

- `http://starsnap.kr/*` is upgraded automatically to HTTPS by Caddy.
- `https://starsnap.kr/*` is reverse-proxied to `website:3000` on the stack
  overlay network.
- `https://api.starsnap.kr/*` is reverse-proxied to the live StarSnap API on
  `192.168.1.103:8080`; Caddy preserves normal HTTP and WebSocket proxying.
- Both HTTP and HTTPS requests for `www.starsnap.kr` are redirected directly to
  the equivalent `https://starsnap.kr` URI.

Automatic HTTPS obtains and renews public certificates without a committed API
token. Caddy's `/data` and `/config` directories use manager-local named volumes
so ACME account material, private keys, and certificates survive service and
stack redeployments. Back up those volumes as sensitive production state; never
copy their contents into the repository.

The deploy script validates the committed Caddyfile with the pinned Caddy image
before changing the stack. It then creates a content-addressed Docker Swarm
config, verifies both services at `1/1`, and checks the apex HTTPS upgrade plus
the one-hop `www` redirect over the internal port-80 origin. It also connects to
the manager with `curl --resolve` while retaining the public host name for SNI
and certificate validation, then verifies the apex content, icon, and HTTPS
`www` redirect. It also checks `https://api.starsnap.kr/api/health` for the live
API `{"status":"ok"}` response. On a failed update, it compares the complete
previous Caddy service specification before rolling back, restores or removes
each service according to the pre-deployment state, and removes a newly created
config when it is no longer referenced.

Before the first deployment, public DNS must point the apex, `www`, and `api`
names at the router's public IPv4 address, and the router must forward TCP 80 and
443 to the manager's ports 80 and 443. Keep port 80 reachable because ACME
validation and the required HTTP-to-HTTPS redirects use it. Avoid publishing an
AAAA record unless IPv6 also routes those ports to this Caddy service.

The GHCR package is public. The deploy job uses the workflow-scoped
`GITHUB_TOKEN` for its registry login and forwards that ephemeral authorization
to Swarm during deployment. No long-lived registry credential or Caddy secret is
stored in Git.
