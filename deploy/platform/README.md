# StarSnap application migration to 192.168.1.103

This directory moves the five public application surfaces away from the
developer desktop at `192.168.1.2` and into the Docker Swarm managed by
`192.168.1.103` (`master.hamtory.com`). It deliberately separates staging,
data restore, service activation, and the final Caddy cutover.

## Target topology

```text
Internet
  -> router TCP 80/443
  -> 192.168.1.103 starsnap-company_caddy
       -> starsnap-sns_web                  sns + chat
       -> starsnap-admin_web/server         admin
       -> starsnap-hub_web/server           log
       -> starsnap-erp_web                  erp
       -> starsnap-main_api                 existing SNS API

192.168.1.103 manager-local persistent state
  -> starsnap-hub-postgres-data-v1
  -> starsnap-erp-postgres-data-v1
  -> starsnap-erp-ollama-models-v1 (retained for rollback)

192.168.1.6 mac-mini.hamtory.com
  -> native macOS Ollama :11434 (ERP embedding target after switch)
```

All Caddy upstreams use `starsnap-main_app-net` service DNS. No application
route in `deploy/Caddyfile` depends on `192.168.1.2` after cutover. The Hub
server publishes port 8081 in host mode on the manager only so a temporarily
retained desktop worker can submit logs over the LAN; the router must not
forward that port.

The InsightFace AI worker remains on the desktop for now because it requires
the desktop NVIDIA GPU and the target ARM64 manager has no verified compatible
GPU. This does not host any of the five websites: the existing Swarm API calls
the GPU worker over the private LAN. Removing that final desktop dependency
requires a compatible server GPU or a replacement inference service.

## Safety boundaries

- Custom application images must be ARM64-capable `@sha256:` references.
- SNS Web, Admin Web, and Admin Server images are rebuilt from the exact static
  assets/JAR in the currently running desktop containers. This prevents later
  uncommitted source work from being bundled into the infrastructure move. The
  only SNS artifact change is replacing its API upstream with
  `starsnap-main_api:8080` on the shared overlay.
- Application credentials are versioned external Docker secrets; values never
  appear in a stack file or workflow input.
- Hub and ERP volumes are external and pinned to the labeled manager so stack
  removal cannot delete the database data.
- `stage` runs only the two empty target databases. Public Caddy routes remain
  on the desktop and all target application replicas stay at zero.
- `activate` is rejected unless the encrypted snapshot restore marker exists.
- The final Caddy deployment retains its existing automatic rollback and route
  verification boundary.
- Source desktop containers and volumes are stopped only for the final
  write-quiesced snapshot; they are not removed and remain the rollback copy.
- The Mac Ollama listener must remain LAN-only, allow the manager at
  `192.168.1.103`, and resolve as `mac-mini.hamtory.com` from the live ERP web
  task. Do not forward port 11434 from the router.

## Prepared phases

1. Run `build-platform-images.ps1 -Mode Validate` locally while desktop
   containers `web`, `starsnap-admin-web`, and `starsnap-admin-server` are
   running. It captures their immutable application artifacts into a temporary
   provenance directory and builds ARM64 runtimes. For publishing, authenticate
   to GHCR and rerun with `-Mode Push`, the required confirmation, and
   `-PublishGitHubVariables` only after production approval.
2. After production approval, run `publish-desktop-platform-secrets.ps1` with
   confirmation `PUBLISH-PLATFORM-SECRETS`. It transmits only the existing AWS,
   Cloudflare Access, and SMTP pairs to GitHub's `production` environment and
   never prints their values. Dispatch `provision`; main-DB and Hub-ingest
   values are copied directly from the existing Swarm API specification, while
   new ERP/Hub DB passwords, Admin JWT, and internal tokens are generated on the
   server. They never transit GitHub or the desktop.
3. Dispatch `preflight`, then `stage`. This validates the manager, overlay,
   existing SNS API/database, secrets, ARM64 images, and starts only the target
   PostgreSQL services.
4. At the approved cutover window, stop the desktop ERP writers and Hub/Admin
   services, then run `prepare-desktop-transfer.ps1` with
   `-PublishGitHubSecrets -Confirmation FINAL-DESKTOP-WRITES-QUIESCED`. The
   script refuses to continue while the ERP web/embedding worker, Admin server,
   or Hub server is still running. It creates PostgreSQL custom-format dumps,
   packages and AES-256 encrypts them, removes the plaintext generated copies,
   and serves only the encrypted archive from `192.168.1.2:48081` with a
   one-time bearer token. The router must not forward port 48081.
5. Dispatch `provision` again to create the two transient transfer secrets,
   then dispatch `restore`. The manager downloads the encrypted archive over
   the LAN, verifies its trusted SHA-256, decrypts it through a Swarm secret,
   restores both databases, verifies the manifest plus both dump hashes, requires
   the restored representative row counts to exactly match the source snapshot,
   and creates a content-addressed restore marker.
6. Dispatch `activate` with confirmation `ACTIVATE-192.168.1.103`. All target
   services must converge and pass direct service-DNS checks while public Caddy
   still points to the desktop.
7. After direct service verification, dispatch `cleanup-transfer` with
   confirmation `PURGE-RESTORED-TRANSFER-COPY`. It removes the server-side
   plaintext transfer volume and the two transient Swarm transfer secrets, but
   preserves the restored Hub/ERP databases and content-addressed marker.
8. Run `switch-desktop-ai-log.ps1 -Mode Switch` with confirmation
   `SWITCH-DESKTOP-AI-LOG`. It recreates only the desktop GPU AI container with
   the same image, GPU request, and InsightFace cache, changing its access-log
   destination to the target Hub. Its state file enables an explicit restore.
9. Keep the new Caddy routes out of the preparation commit. Dispatch
   `switch-log` with confirmation `SWITCH-MAIN-API-LOG` to update the
   existing SNS API log destination to `http://starsnap-hub_server:8081`, then
   merge the separate Caddy cutover commit and require internal plus external
   checks for SNS, Chat, ERP, Admin, and Log.
10. While the manager-local Ollama service is still healthy, dispatch
   `switch-ollama` with confirmation `SWITCH-OLLAMA-192.168.1.6`. It first
   probes `http://mac-mini.hamtory.com:11434` from the actual ERP web container,
   requiring the exact pinned model digest, response model, 1024 dimensions,
   finite values, and a unit-length embedding. It then updates only the ERP web
   endpoint, waits for convergence, repeats the semantic probe, scales the two
   internal Ollama services to zero, and probes again. A failed step restores
   the previous endpoint and replica counts; rerunning an already completed
   switch performs a semantic check without another update.
11. Dispatch `verify-ollama` to run a non-persistent semantic probe through the
   live ERP web task. It verifies the configured Ollama service, pinned
   `bge-m3:567m-fp16` digest, and one 1024-dimension embedding without printing
   the vector or changing Swarm, volume, or database configuration.
12. Keep the stopped desktop application containers and volumes through the
   observation window. Stop the temporary relay, remove its generated snapshot
   only after public verification, and delete the transient GitHub/Swarm
   transfer secrets.

The expected write-quiesced window is approximately 10–20 minutes; the staged
native ARM64 service startup will provide a tighter value before Caddy moves. SNS and Chat can remain
available until the final Caddy switch because their moved web container is
stateless. ERP, Admin, and Log receive the maintenance window because their
database-backed state must not split between hosts.

## Rollback

Before Caddy changes, rollback is simply `stop-target` with confirmation
`STOP-TARGET-KEEP-DATA`; the public sites still use the desktop. After Caddy
changes, restore the previous Caddy service specification, restart the exact
desktop containers that were stopped for quiescence, and point SNS API log
delivery back to its previous value. Do not delete either target or source
volumes during rollback. Reconcile any writes accepted after cutover before a
later retry. The Ollama switch script automatically restores the internal
Ollama replicas and ERP web endpoint when a pre-cutover rollback marker exists;
if that verification also fails, it preserves the marker for manual recovery.

## Local validation

```bash
bash deploy/platform/validate-platform.sh --ci
bash deploy/platform/test-switch-ollama.sh
bash deploy/test-deploy-swarm.sh
bash deploy/test-verify-external.sh
```

The workflow also runs `actionlint`, shell syntax checks, JavaScript syntax
checks, all four `docker stack config` renders, and the existing Caddy rollback
simulation before any production dispatch is available.
