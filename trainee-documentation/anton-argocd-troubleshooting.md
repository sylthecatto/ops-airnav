# ArgoCD Troubleshooting — Ton

**Area:** ArgoCD (GitOps)
**Node:** node20 192.168.10.20 (control-plane; ArgoCD runs in the argocd namespace)
**Status:** Diagnosed and fixed. Fixes below have been **applied.**

---

## 1. Symptom

ArgoCD is not managing the new-app deployment. The new-app Application never reconciles — it sits in **Sync Status = Unknown**, so it cannot self-heal or roll out the correct manifests, and the startup namespace objects are effectively orphaned.

```
$ kubectl -n argocd get applications -o wide
NAME                     SYNC STATUS   HEALTH STATUS   REVISION    PROJECT
app-main                 Synced        Healthy         cb1331f…    default
app-staging               Synced        Progressing     f189867…    default
new-app                  Unknown       Healthy         main        default   <-- broken
sample-app-production    Synced        Healthy         566e814…    default
```

## 2. Investigation (read-only)

```
# on node20 (192.168.10.20)
kubectl -n argocd get applications -o wide
kubectl -n argocd get application new-app -o yaml
kubectl -n argocd get application new-app -o jsonpath='{range .status.conditions[*]}{.type}: {.message}{"\n"}{end}'
ls -la ~/argocd-apps ; for f in ~/argocd-apps/*; do echo "== $f =="; cat "$f"; done
```

**Findings** — the new-app Application `spec.source`:

```
source:
  repoURL: https://github.com/airnav-aeron/devops-training
  targetRevision: main
  path: .              # <-- repo ROOT of an APPLICATION SOURCE repo, not a manifests repo
  directory:
    jsonnet: { tlas: [ { name: "", value: "" } ] }
destination:
  namespace: startup
  server: https://kubernetes.default.svc
```

And the condition that explains the Unknown status:

```
ComparisonError: Failed to load target state: failed to unmarshal manifests for source 1 of 1:
Object 'Kind' is missing in '{"lockfileVersion":3,"metadata":{"annotations":{"argocd.argoproj.io/tracking-id":"new-app:/:startup/"}}, "name":"sample-app","packages":{...bcrypt...express...pg...}}'
```

For contrast, the **healthy** apps (app-main, app-staging, sample-app-production, defined in `~/argocd-apps/*.yaml`) point at `repoURL: github.com/sylthecatto/config-k8s.git` with per-branch `targetRevision` and `path: .` on a repo that contains **only manifests**. new-app is the odd one out — it points at the *application source* repo instead of a manifests repo/path.

## 3. Root cause

**A1 — new-app Application source points at an application-source repo root.**

With `path: .` on `github.com/airnav-aeron/devops-training` (the repo that holds `app.js`, `package.json`, `package-lock.json`, `Dockerfile`, …), ArgoCD's directory source walks every file and tries to parse each as a Kubernetes manifest. It hits **package-lock.json**, which has no `Kind` field, and aborts with a `ComparisonError`. Because it can't load the target state, it can never compute a diff → **Sync = Unknown**, no auto-sync, no self-heal.

**Consequence:** the K8s Deployment/Service in `startup` (which carry the `argocd.argoproj.io/tracking-id: new-app` annotation, so ArgoCD *did* create them once) are now unmanaged. Hans's manifest fixes (K1–K4) will not "stick" via GitOps until this Application is pointed at valid manifests.

## 4. Fixes — APPLIED

**Use a separate config repo**, mirroring the working apps: moved the new-app manifests into `github.com/sylthecatto/config-k8s.git` (its own branch/path) and pointed the Application there, consistent with the original app-main/app-staging/sample-app-production approach.

In the ArgoCD UI:

```
# Decision: removed app-main, app-staging, and sample-app-production, then
# created new-app-staging and new-app-prod from scratch, to avoid conflicts
# caused by namespaces.
```

1. Created **new-app-staging**
   - branch: `staging`
   - target revision: `staging`
   - path: `k8s`
   - namespace: `startup`

2. Created **new-app-prod**
   - branch: `production`
   - target revision: `production`
   - path: `k8s`
   - namespace: `startup-prod`

Two separate namespaces are used so that if one environment goes down, it won't affect the other.

After fixing the source, applied and synced:

```
kubectl -n argocd apply -f <new-app-application>.yaml   # if editing the Application manifest
argocd app sync new-app-staging
argocd app sync new-app-prod
# or let auto-sync reconcile
```

> **Coordinate with Hans:** the manifests ArgoCD points at must already contain his K1–K4 fixes (image `192.168.10.23:5000/new-app:1.0`, liveness `/health`, `PORT=3000`, Service selector `app=new-app`). Otherwise ArgoCD will faithfully sync the *broken* manifests. Best flow: Hans's corrected `deployment.yaml`/`service.yaml` land in the repo/path this Application reads, then you sync.

## 5. Verification

```
kubectl -n argocd get applications -o wide
```

```
[root@node20 ~]# kubectl -n argocd get applications -o wide
NAME              SYNC STATUS   HEALTH STATUS   REVISION                                   PROJECT
new-app-prod      Synced        Healthy         c8e3f149c88865a1c56d791844d927e886616996   default
new-app-staging   Synced        Healthy         30550ca73cd84651e3c41b0eee526cf83208c13f   default

```

Confirmed: both apps are Synced and Healthy — full resolution. The earlier Degraded/Progressing readings (seen right after the initial sync) have cleared now that the image/registry dependencies (Section 6) were in place.

```
kubectl -n argocd get application new-app-staging -o jsonpath='{.status.conditions}'
kubectl -n argocd get application new-app-prod -o jsonpath='{.status.conditions}'
# -> [] (empty) on both = no ComparisonError

kubectl -n argocd describe application new-app-staging
kubectl -n argocd describe application new-app-prod
# -> sync status, health status, and managed resources listed
# (equivalent to `argocd app get`, for setups without the argocd CLI installed —
#  the same info is also visible in the ArgoCD UI's resource tree view)
```

## 6. Dependencies

- Depends on **Hans** for the corrected `deployment.yaml`/`service.yaml` content.
- Depends indirectly on **Ron** (registry up) and **Dave** (image pushed) — otherwise the synced manifests still land on a missing image and the app shows Healthy-but-not-Ready (or Degraded, as currently observed for new-app-prod).
