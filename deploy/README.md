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
- A repository variable named `SWARM_DEPLOY_ENABLED` set to `true`.
- A GitHub environment named `production` that requires an independent reviewer,
  prevents self-review, permits only `main`, and does not allow administrators to
  bypass its protection rules.

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

The GHCR package is public. The deploy job deliberately performs no registry
login and does not propagate registry credentials into the Swarm service
specification, so later rescheduling can pull the immutable digest anonymously.
