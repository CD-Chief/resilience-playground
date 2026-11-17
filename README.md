# resilience-playground

A fault-injection and self-healing lab on Kubernetes. You press a button, something real breaks in the cluster, and you watch Kubernetes repair it: a crashed container is restarted, an unhealthy pod is taken out of the load balancer, a broken release is aborted and rolled back.

The point is the recovery, not the breakage. Every fault maps to a specific mechanism that heals it, and the page shows which one did and how long it took.

**Status:** stage 1, a local MVP that runs on your own machine with k3d. A public deployment comes later (see [Roadmap](#roadmap)).

## What you can break

| Fault | What happens | What heals it | Typical recovery |
| --- | --- | --- | --- |
| Crash a pod | One pod's process exits | The kubelet restarts the container; the other two pods keep serving | about 6s |
| Fail readiness | One pod's readiness probe fails for 45s | The pod is removed from the Service endpoints and rejoins when the probe passes again | about 46s |
| Bad deploy | A broken image is released as a canary | The canary never becomes ready, so it gets no traffic; Argo Rollouts aborts the release at its 30s progress deadline | about 37s |

A load generator sends 10 requests a second at the app the whole time, so you can see what each fault costs real traffic. Failing readiness and the bad deploy cost nothing. A crash usually costs a handful of requests, the ones sent to the dead pod before Kubernetes notices it has gone.

## Run it locally

You need:

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (running)
- [k3d](https://k3d.io/) 5.x
- [kubectl](https://kubernetes.io/docs/tasks/tools/)

Node.js is only needed if you want to run the tests or work on the UI.

Windows (PowerShell):

```powershell
.\scripts\up.ps1
```

macOS, Linux or Git Bash:

```bash
scripts/up.sh
```

The first run takes a few minutes. It creates a k3d cluster called `resilience-playground`, builds the five images, installs Argo Rollouts and deploys everything. When it finishes, open:

```
http://localhost:8080
```

To stop and delete the cluster:

```powershell
.\scripts\down.ps1      # or: scripts/down.sh
```

Useful to know:

- **Another port:** `.\scripts\up.ps1 -Port 9000` or `PORT=9000 scripts/up.sh`. The port is fixed when the cluster is created, so run the down script first if you want to change it.
- **After changing code:** run the up script again. It rebuilds the images and restarts the workloads on the existing cluster.
- **Your other clusters are safe:** every `kubectl` call in the scripts names the `k3d-resilience-playground` context explicitly.

## Things to try

1. Press **Crash a pod**. One tile turns red, its restart count goes up, and it is back within seconds.
2. Press **Fail readiness**. The pod stays running but turns amber and shows "Out of the Service". Nothing restarts; traffic simply goes elsewhere for 45 seconds.
3. Press **Bad deploy**. A fourth tile appears, marked *canary*, and never becomes ready. After 30 seconds Argo Rollouts gives up on it and removes it. The three original pods serve everything throughout.
4. Watch the cost in requests while you do it:

   ```bash
   kubectl --context k3d-resilience-playground -n sandbox logs deployment/loadgen -f
   ```

Each fault has a cooldown shared by everyone looking at the page, and the same fault cannot run twice at once.

## How it works

```
browser ──> Traefik ingress ──┬──> web         static React UI
                              └──> controller  fault API + live event stream
                                      │
                 ┌────────────────────┼─────────────────────┐
                 │ watches pods, events, endpoint slices and │
                 │ the Rollout; patches the Rollout's image  │
                 ▼                                           ▼
          Kubernetes API                        target pods' admin port
                                                (crash / fail readiness)

namespace sandbox:   target (Argo Rollout, 3 replicas)  <── loadgen (10 req/s)
namespace platform:  controller, web
```

| Component | Where | What it does |
| --- | --- | --- |
| `apps/target` | `sandbox` | The app that gets broken. Serves `/healthz`, `/readyz`, `/startupz` and `/api/work` on port 8080, and takes fault toggles on an internal admin port, 9090. |
| `apps/loadgen` | `sandbox` | Calls the target Service at a steady 10 requests a second and logs successes and failures every second. |
| `apps/controller` | `platform` | The only thing allowed to change the sandbox. Offers a fixed list of faults, enforces cooldowns, watches the cluster, follows each incident from injection to recovery, and streams it all to browsers over Server-Sent Events. |
| `apps/web` | `platform` | The page: pod grid, fault buttons, incident timeline and event log. |

### Incidents

Every fault opens an incident with four timestamps:

- **Injected:** the controller caused the fault.
- **Detected:** Kubernetes noticed (a probe failed, a container exited).
- **Mitigated:** users were protected (the pod left the Service, the container was restarted, the release was aborted).
- **Recovered:** everything is back to normal.

The time from injected to recovered is shown as the recovery time. Incidents are held in memory; the last 20 are kept until the controller restarts.

### Controller API

| Request | Purpose |
| --- | --- |
| `POST /api/faults/crash-pod` | Crash one random healthy pod |
| `POST /api/faults/fail-readiness` | Make one random healthy pod fail readiness for 45s |
| `POST /api/faults/bad-deploy` | Release the broken image as a canary |
| `GET /api/stream` | Live state and event log (Server-Sent Events) |
| `GET /api/state` | The current state, once, as JSON |

A fault request answers `202` when it starts, `409` if that fault is still recovering or the cluster is not healthy enough, and `429` with a `Retry-After` header during its cooldown.

## Guard rails

The page lets strangers break things, so what they can break is kept narrow:

- **A fixed list of faults.** The API accepts three named actions and reads no other input.
- **RBAC limited to one namespace.** The controller's ServiceAccount has a `Role` in `sandbox` only: read pods, events, endpoint slices and Rollouts, and patch the one Rollout named `target`. It has no rights anywhere else in the cluster.
- **Network policies.** Sandbox pods are denied all traffic by default. The target's admin port accepts connections from the controller only, and the load generator can reach nothing but the target.
- **Resource quota.** The sandbox namespace is capped on pods, CPU and memory.
- **Never fewer than two serving pods.** Pod faults are refused if they would leave fewer than two pods taking traffic.
- **Nothing internal is exposed.** The ingress routes to the UI and the controller API only.
- **The Rollout is never left broken.** After a bad deploy the controller sets the image back, including when the controller itself was restarted in the middle of one.

## Development

Each app is a standalone TypeScript package with its own `package.json`.

```bash
cd apps/controller    # or apps/target, apps/loadgen
npm install
npm test
```

To work on the UI with hot reload against a running cluster:

```bash
kubectl --context k3d-resilience-playground -n platform port-forward svc/controller 8081:80
cd apps/web && npm install && npm run dev
```

The dev server forwards `/api` to `localhost:8081`.

### Repo layout

```
apps/
  target/        HTTP service with probes and fault toggles
  loadgen/       steady synthetic traffic
  controller/    fault API, cluster watches, incidents, event stream
  web/           React UI
k8s/
  base/          namespaces, RBAC, quota, network policies
  sandbox/       target Rollout and Service, loadgen
  platform/      controller, web, ingress
scripts/         up and down, for PowerShell and bash
```

## Troubleshooting

- **`k3d` is not recognised:** open a new terminal after installing it, so the updated `PATH` is picked up.
- **Port 8080 is already in use:** run the down script, then the up script with another port.
- **A pod sits in `ImagePullBackOff`:** the images only exist locally and are copied into the cluster by the up script. Run it again.
- **The same pod restarts more slowly each time:** Kubernetes backs off repeated restarts of one container (10s, 20s, 40s and so on). It resets after the pod has run cleanly for ten minutes.

## Roadmap

1. **Local MVP on k3d** (this stage)
2. **Observability:** Prometheus, live graphs of request rate, success rate and latency, and canary analysis based on real error rates
3. **Production cluster:** k3s on a VPS, provisioned with Terraform and Ansible, with TLS
4. **Delivery:** images built in GitHub Actions, deployed by Argo CD
5. **Hardening and extras:** per-IP rate limits, bot protection, a dependency-loss scenario with a circuit breaker
