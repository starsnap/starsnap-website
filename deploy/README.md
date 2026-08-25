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
- A GitHub environment named `production`.

The runner registration token is one-time bootstrap material. Never commit it,
write it into a stack file, or leave it in a long-lived service environment.
Local `deploy/*.token` and `deploy/*.secret` files are ignored as a final guard,
but the preferred flow is to avoid writing the token to disk at all.

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

The GHCR package is currently private, so the deploy job passes its short-lived
job token to Swarm with `--with-registry-auth`. Making this public website image
public is operationally safer for later node rescheduling because no expired
registry credential is then required to pull the same digest.
