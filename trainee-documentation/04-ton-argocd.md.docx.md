# ArgoCD Troubleshooting — Ton

**Area:** ArgoCD (GitOps) **Node:** node20 `192.168.10.20` (control-plane; ArgoCD runs in the `argocd` namespace) **Status:** Diagnosed read-only. Fixes below are **not yet applied.**

---

## 1\. Symptom

ArgoCD is not managing the `new-app` deployment. The `new-app` Application never reconciles — it sits in **Sync Status \= Unknown**, so it cannot self-heal or roll out the correct manifests, and the `startup` namespace objects are effectively orphaned.

$ kubectl \-n argocd get applications \-o wide

NAME                    SYNC STATUS   HEALTH STATUS   REVISION   PROJECT

app-main                Synced        Healthy         cb1331f…   default

app-staging             Synced        Progressing     f189867…   default

new-app                 Unknown       Healthy         main       default    \<-- broken

sample-app-production   Synced        Healthy         566e814…   default

## 2\. Investigation (read-only)

\# on node20 (192.168.10.20)

kubectl \-n argocd get applications \-o wide

kubectl \-n argocd get application new-app \-o yaml

kubectl \-n argocd get application new-app \-o jsonpath='{range .status.conditions\[\*\]}{.type}: {.message}{"\\n"}{end}'

ls \-la \~/argocd-apps ; for f in \~/argocd-apps/\*; do echo "== $f \=="; cat "$f"; done

Findings — the `new-app` Application `spec.source`:

source:

  repoURL: https://github.com/airnav-aeron/devops-training

  targetRevision: main

  path: .                      \# \<-- repo ROOT of an APPLICATION SOURCE repo

  directory:

    jsonnet: { tlas: \[ { name: "", value: "" } \] }

destination:

  namespace: startup

  server: https://kubernetes.default.svc

And the condition that explains the `Unknown` status:

ComparisonError: Failed to load target state: failed to unmarshal manifests for source 1 of 1:

  Object 'Kind' is missing in

  '{"lockfileVersion":3,"metadata":{"annotations":{"argocd.argoproj.io/tracking-id":"new-app:/:startup/"}},

    "name":"sample-app","packages":{...bcrypt...express...pg...}}'

For contrast, the **healthy** apps (`app-main`, `app-staging`, `app-production`, defined in `~/argocd-apps/*.yaml`) point at `repoURL: github.com/sylthecatto/config-k8s.git` with per-branch `targetRevision` and `path: .` on a repo that contains **only manifests**. `new-app` is the odd one out — it points at the *application source* repo instead of a manifests repo/path.

## 3\. Root cause

**A1 — `new-app` Application source points at an application-source repo root.** With `path: .` on `github.com/airnav-aeron/devops-training` (the repo that holds `app.js`, `package.json`, `package-lock.json`, `Dockerfile`, …), ArgoCD's `directory` source walks every file and tries to parse each as a Kubernetes manifest. It hits **`package-lock.json`**, which has no `Kind` field, and aborts with a `ComparisonError`. Because it can't load the target state, it can never compute a diff → **Sync \= Unknown**, no auto-sync, no self-heal.

Consequence: the K8s `Deployment`/`Service` in `startup` (which carry the `argocd.argoproj.io/tracking-id: new-app` annotation, so ArgoCD *did* create them once) are now unmanaged. Hans's manifest fixes (K1–K4) will not "stick" via GitOps until this Application is pointed at valid manifests.

## 4\. Fixes — NOT YET APPLIED

Pick **one** of these approaches:

**Option A (recommended) — point at a manifests-only path.** Put the Kubernetes manifests in a dedicated subdirectory of the repo (e.g. `k8s/` containing only `deployment.yaml` \+ `service.yaml`) and change the Application source:

source:

  repoURL: https://github.com/airnav-aeron/devops-training

  targetRevision: main

  path: k8s          \# was "."

**Option B — restrict which files ArgoCD reads** (if the yaml must stay at repo root):

source:

  repoURL: https://github.com/airnav-aeron/devops-training

  targetRevision: main

  path: .

  directory:

    include: '\*.yaml'   \# stops package-lock.json / package.json being parsed as manifests

    recurse: false

**Option C (cleanest GitOps) — use a separate config repo**, mirroring the working apps: move the `new-app` manifests into `github.com/sylthecatto/config-k8s.git` (its own branch/path) and point the Application there, consistent with `app-main`/`app-staging`/`app-production`.

After fixing the source, apply and sync:

kubectl \-n argocd apply \-f \<new-app-application\>.yaml   \# if you edit the Application manifest

argocd app sync new-app                                  \# or let auto-sync reconcile

> **Coordinate with Hans:** the manifests ArgoCD points at must already contain his K1–K4 fixes (image `192.168.10.23:5000/new-app:1.0`, liveness `/health`, `PORT=3000`, Service selector `app=new-app`). Otherwise ArgoCD will faithfully sync the *broken* manifests. Best flow: Hans's corrected `deployment.yaml`/`service.yaml` land in the repo/path this Application reads, then you sync.

## 5\. Verification

kubectl \-n argocd get application new-app \-o wide

\#   \-\> SYNC STATUS: Synced, HEALTH: Healthy   (no ComparisonError)

kubectl \-n argocd get application new-app \-o jsonpath='{.status.conditions}'   \# \-\> \[\] (empty)

argocd app get new-app                          \# resources listed and Synced

## 6\. Dependencies

- Depends on **Hans** for the corrected `deployment.yaml`/`service.yaml` content.  
- Depends indirectly on **Ron** (registry up) and **Dave** (image pushed) — otherwise the synced manifests still land on a missing image and the app shows Healthy-but-not-Ready.

