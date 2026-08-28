# StarSnap company deployment

The container workflow builds one multi-platform image, publishes its immutable
manifest digest, smoke-tests that exact digest on AMD64 and ARM64, promotes the
verified digest to `latest`, and deploys the digest to Docker Swarm only for an
explicit manual dispatch with `deploy=true`. A push never mutates production.

## GitHub configuration

The deploy job is disabled until all of the following exist:

- An organization self-hosted runner on the ARM64 Swarm manager in the
  `starsnap-production` runner group with the `starsnap-swarm` label. Production
  jobs require both the group and label.
- The runner group's repository access must explicitly include only the StarSnap
  repositories that own a production service. Its workflow allowlist must pin
  the following repository-owned workflows to their protected default branch:
  - `starsnap/starsnap-website/.github/workflows/container.yml@refs/heads/main`
  - `starsnap/starsnap-sns-web/.github/workflows/container.yml@refs/heads/main`
  - `starsnap/starsnap-sns-backend/.github/workflows/container.yml@refs/heads/main`
  - `starsnap/starsnap-admin-web/.github/workflows/container.yml@refs/heads/master`
  - `starsnap/starsnap-admin-server/.github/workflows/container.yml@refs/heads/master`
  - `starsnap/starsnap-log-web/.github/workflows/container.yml@refs/heads/master`
  - `starsnap/starsnap-log-server/.github/workflows/container.yml@refs/heads/master`
  - `starsnap/starsnap-erp-web/.github/workflows/container.yml@refs/heads/main`
- A repository variable named `SWARM_DEPLOY_ENABLED` in each repository. Keep it
  unset until all other controls are verified, then set it to `true` last.
- A `production` environment with `HamTory06` as required reviewer in the public
  Website and SNS Web repositories. GitHub Free does not support configurable
  environments or required reviewers for the private Admin, Log, ERP, and SNS
  Backend repositories; those deployments therefore rely on manual dispatch,
  the exact branch check, the fail-closed repository variable, and the selected
  runner workflow allowlist.

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
restricted to the exact workflows above, never add pull-request or fork triggers
to a deploy job, and protect workflow changes on every listed default branch
before granting additional collaborators write access. Keep the group limited to
the intended ARM64 manager runner. The runner group and `starsnap-swarm` label
together form the GitHub Actions routing boundary. The separate Docker node label
`starsnap.actions-runner=true` is the Swarm placement boundary for both company
services. The deployment preflight requires the current manager to carry that
label and requires it to be the only labeled node in the Swarm.

Application repositories build and deploy only their own service. They share the
single production runner and `/runner-state/starsnap-production-deploy.lock`, but
they do not check out, build, or mutate another application's repository or
Swarm service. This repository owns only the company website and Caddy edge
services.

## Deployment guarantees

- Production uses `ghcr.io/starsnap/starsnap-website@sha256:...`, never a mutable
  tag.
- The deploy script refuses an unexpected repository or malformed digest.
- Swarm updates are serialized and use start-first updates with automatic
  rollback.
- The manager-side deploy script waits for the immutable image and Caddy config,
  `1/1` replicas, a completed update, and exactly one local task container with a
  `healthy` Docker healthcheck for each company service.
- Once the expected Caddy image and config are healthy, the deploy script runs
  the internal route verifier from the healthy ERP task over the shared
  application overlay. Route verification remains inside the rollback boundary.
- Manager-side convergence never curls a LAN address, so it does not depend on
  router hairpin NAT or a manager host-port path.
- On verification failure, the workflow requests a rollback when a previous
  service specification exists.

## Caddy edge service

The same `starsnap-company` stack runs the official Caddy `2.10.2-alpine`
multi-platform image pinned by immutable manifest digest. Caddy and the website
are both constrained to the sole manager carrying
`starsnap.actions-runner=true`. This makes the local website container available
for direct diagnostics and keeps Caddy's certificate volumes on the same node.
Caddy publishes TCP ports 80 and 443; the website keeps its existing port
3000 publication for direct internal diagnostics.

`Caddyfile` provides these routes:

- `http://starsnap.kr/*` is upgraded automatically to HTTPS by Caddy.
- `https://starsnap.kr/*` is reverse-proxied to `website:3000` on the stack
  overlay network.
- `https://api.starsnap.kr/*` is reverse-proxied to the live
  `starsnap-main_api:8080` Swarm service over the external
  `starsnap-main_app-net` overlay; Caddy preserves normal HTTP and WebSocket
  proxying without depending on a manager-host port.
- `https://admin.starsnap.kr/*` serves the Admin web console from
  `starsnap-admin_web:5174`, while `/api/*` is routed to
  `starsnap-admin_server:8082`. Both services share the external application
  overlay with Caddy and expose no WAN-facing host ports. The Admin API must allow
  `WEB_ORIGIN=https://admin.starsnap.kr`, set secure production cookies, and
  expose `GET /api/health` with `{"status":"ok"}` for deployment verification.
- `https://erp.starsnap.kr/*` is reverse-proxied to `starsnap-erp_web:3000`
  over the shared application overlay. Its PostgreSQL and Ollama data use
  manager-local persistent volumes on `192.168.1.103`; the public ERP host
  always returns HTTP 404 for `/api/health` and its subpaths, while the
  deployment verifier checks detailed health directly through service DNS.
- `https://sns.starsnap.kr/*` is reverse-proxied to
  `starsnap-sns_web:3000` over the shared application overlay. Caddy is the only
  public ingress. The web container continues to proxy its
  same-origin `/api/*` and `/ws-chat` requests to the StarSnap backend.
- `https://chat.starsnap.kr/*` is reverse-proxied to the same
  `starsnap-sns_web:3000` service. The shared web build
  selects its message-only shell from the public hostname, while `/api/*` and
  `/ws-chat` continue to reach the same backend, chat rooms, and message store
  used by the SNS surface. The backend `CORS_ORIGIN_PATTERNS` value must include
  both `https://sns.starsnap.kr` and `https://chat.starsnap.kr`. Caddy adds a
  Chat-specific surface header plus frame, MIME-sniffing, and referrer guards;
  verification also requires the shared web build's `social chat` capability
  marker so an older SNS-only image cannot pass the Chat release gate.
- `https://log.starsnap.kr/*` serves `starsnap-log_web:5173`; only
  `/api/dashboard/*` is proxied to `starsnap-log_server:8081`, while all other
  public `/api/*` routes remain hidden with HTTP 404. The Hub database is a
  manager-local persistent volume and dashboard requests retain Cloudflare
  Access origin validation.
- Both HTTP and HTTPS requests for `www.starsnap.kr` are redirected directly to
  the equivalent `https://starsnap.kr` URI.

Automatic HTTPS obtains and renews public certificates without a committed API
token. Caddy's `/data` and `/config` directories use manager-local named volumes
so ACME account material, private keys, and certificates survive service and
stack redeployments. Back up those volumes as sensitive production state; never
copy their contents into the repository.

The deploy script validates the committed Caddyfile with the pinned Caddy image
before changing the stack. It requires the external `starsnap-main_app-net`
overlay and the `starsnap-main_api` service to exist, then creates a
content-addressed Docker Swarm config and verifies both company services through
Swarm state plus their container healthchecks. After the expected Caddy image,
config, update state, and healthcheck converge, it executes
`verify-internal.mjs` inside the sole healthy ERP web container. That verifier
reaches Caddy at service DNS `caddy:80/443` to check the apex HTTPS marker/icon,
HTTP and HTTPS `www`
one-hop redirects with path/query preservation, and the API HTTP redirect plus
HTTPS health response. It also verifies the ERP HTTP redirect and HTTPS page
marker through Caddy, then checks the database-backed `/api/health` response
directly through `starsnap-erp_web` service DNS so detailed health data is never
exposed publicly. It also verifies the SNS and Chat HTTP redirects, HTTPS page
markers, and same-origin API health responses through `starsnap-sns_web`.
Finally, it verifies the Admin HTTP redirect, HTTPS `StarSnap Admin` page marker,
and public `/api/health` 200 response with `{"status":"ok"}` through Caddy,
plus the Log Hub dashboard marker, Access gate, service health, and blocked
public ingestion route.
HTTPS requests set each public hostname as TLS SNI and
retain normal CA and hostname verification; no insecure TLS mode is used.

Because this internal route check is part of Caddy convergence, a failure uses
the existing rollback path. The script compares the complete previous Caddy
service specification before rolling back, restores or removes each service
according to the pre-deployment state, and removes a newly created config when
it is no longer referenced.

After the Swarm deployment succeeds, the `external-verify` job runs on a
GitHub-hosted Ubuntu runner outside the LAN. `verify-external.sh` retries while
DNS and certificate issuance converge and intentionally uses public DNS plus
curl's normal CA and hostname validation—there is no `--resolve` or insecure TLS
mode. It verifies:

- apex HTTP redirects to HTTPS;
- apex HTTPS contains the StarSnap marker and serves a non-empty `/icon.png`;
- HTTP and HTTPS `www` each redirect directly to the apex in one response while
  preserving a test path and query string;
- API HTTP redirects to HTTPS and public `/api/health` returns
  `{"status":"ok"}`.
- ERP HTTP redirects to HTTPS, its public root contains the `StarSnap ERP`
  marker, and its detailed public `/api/health` path remains hidden with 404.
- SNS HTTP redirects to HTTPS, its public root contains the StarSnap title, and
  its same-origin `/api/health` returns `{"status":"ok"}`.
- Chat HTTP redirects to HTTPS, its public root contains the StarSnap title, and
  its same-origin `/api/health` returns `{"status":"ok"}`.
- Admin HTTP redirects to HTTPS, its public root contains the `StarSnap Admin`
  marker, and `/api/health` returns HTTP 200 with `{"status":"ok"}`.

An external verification failure fails the workflow and provides public-path
evidence, but it does not mutate the already converged Swarm deployment.

To rerun only the public checks without rebuilding, publishing, or deploying,
manually dispatch `Build, verify, publish, and deploy container` with the boolean
`verify_only` input set to `true`. The skipped deploy is treated deliberately:
`external-verify` uses an `always()` condition and runs only for this explicit
verify-only request or after a successful normal deployment. Verify-only runs
use a run-specific concurrency group, so they do not wait behind a build or
deployment queued for the same branch.

Before the first deployment, public DNS must point the apex, `www`, `api`, `erp`, `sns`, `chat`, and `admin`
names at the router's public IPv4 address, and the router must forward TCP 80 and
443 to the manager's ports 80 and 443. Keep port 80 reachable because ACME
validation and the required HTTP-to-HTTPS redirects use it. Avoid publishing an
AAAA record unless IPv6 also routes those ports to this Caddy service.

The GHCR package is public. The deploy job uses the workflow-scoped
`GITHUB_TOKEN` for its registry login and forwards that ephemeral authorization
to Swarm during deployment. No long-lived registry credential or Caddy secret is
stored in Git.
