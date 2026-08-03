
## 0. SSH

Note: Must connect to the GL-BE9300-200 (or 5G) Wi-Fi Network

The cluster lives on the `10.x` network, which is reached by first hopping through the application server located at 192.168.8.199

```bash
# 1) SSH to the app / jump server
ssh root@192.168.8.199          # password: root

# 2) From there, hop to the control-plane node
ssh root@192.168.10.20          # password: root   (this node runs k3s + ArgoCD)
```


---
## Troubleshooting

### Step 1 : View the existing pods in the new namespace

```bash
kubectl get pods -n startup
```

Output:

```
NAME                       READY   STATUS             RESTARTS   AGE
new-app-6b8c89d547-2x2gw   0/1     ImagePullBackOff   0          19h
new-app-6b8c89d547-jg24n   0/1     ImagePullBackOff   0          19h
```

`READY 0/1` = the container isn't running. 
`ImagePullBackOff` = Kubernetes tried
to **download the container image and failed**, and is now waiting before trying again. 


---

### Step 2 :  Kubectl describe to see why it can't pull the image

```bash
kubectl describe pod -n startup new-app-6b8c89d547-2x2gw
```

In the Events Section it says this:

```
Events:
  Type    Reason   Age                   From     Message
  ----    ------   ----                  ----     -------
  Normal  BackOff  91s (x5374 over 20h)  kubelet  Back-off pulling image "localhost:5050/new-app:1.0"
```

- `localhost` — This pod runs on a **worker node** (node21 or node22), so
  `localhost` means *that worker*, not your registry.
- `:5050` — double check port if registry lives here

```
[root@node20 ~]# kubectl get deploy new-app -n startup -o wide
NAME      READY   UP-TO-DATE   AVAILABLE   AGE   CONTAINERS   IMAGES                       SELECTOR
new-app   0/2     2            0           20h   new-app      localhost:5050/new-app:1.0   app=new-app
```


---

### Step 3 : How does this cluster pull images

k3s uses a **registry mirror** file. Check it on the workers where the pods actually run:

```bash
cat /etc/rancher/k3s/registries.yaml
```

Output:

```yaml
mirrors:
  "192.168.10.23:5000":
    endpoint:
      - "http://192.168.10.23:5000"
```

The cluster only knows how to redirect pulls for **`192.168.10.23:5000`**. That is
the real registry address.

| Where                 | Says                 |
| --------------------- | -------------------- |
| Your Deployment image | `localhost:5050/...` |
| The registry mirror   | `192.168.10.23:5000` |

### PROBLEM 1 | Non-matching hosts, localhost and 192.168.10.23, and wrong port (5050 & 5000)


---

### Step 4 : Check whether the image even exists / registry is alive

Even with the right address, the pull needs (a) the registry running and (b) the image present.

```bash
curl -s http://192.168.10.23:5000/v2/_catalog
```


### PROBLEM 2 | FIX (On Ron's End)
	Registry Container is DOWN. Ron (who is assigned to Docker) must bring the registry container back up.

After the fix:

[root@node20 ~]# curl -s http://192.168.10.23:5000/v2/_catalo< -s http://192.168.10.23:5000/v2/_catalog                   
{"repositories":["devops-training-web","my-test-alpine","sample-app"]}

### PROBLEM 3 | FIX (On Dave and Ron's End)
	new-app is not present, which means the image was never built/pushed to the registry. Dave must fix his Jenkins File, Ron must fix the Dockerfile.


---

### Step 5 :  Look *past* the pull: will the container actually run?

`ImagePullBackOff` hides the next problems. Peek at the app source to predict what happens after the image pulls.

```bash
# on 192.168.8.199
cat /var/www/new-app/app.js | grep -nE "app.get\('/|PORT|listen"
```

```
[root@Source ~]# cat /var/www/new-app/app.js | grep -nE "app.get\('/|PORT|listen"
16:app.get('/health', (req, res) => {
21:app.get('/api/info', (req, res) => {
31:app.get('/api/tasks', (req, res) => {
56:const PORT = process.env.PORT || 3001;
57:app.listen(PORT, () => {
58:  console.log(`Task Manager app running on port ${PORT}`);
[root@Source ~]#
```

NOTES:
- The health endpoint is **`/health`** — but Deployment's `livenessProbe` uses **`/healthz`**.

### Problem #4 | Liveness probe path mismatch
	The app only serves `/health`, but the Deployment's `livenessProbe` calls `/healthz`. A wrong liveness path makes Kubernetes kill the container over and over, even after a successful pull.

### Problem #5 | Port mismatch
	The app listens on `process.env.PORT || 3001` → **3001** by default, but the Deployment/Service used 3000. Probes fail and traffic can't reach the app.

---

### Step 6 : Check the Service (does traffic have anywhere to go?)

```bash
kubectl get svc -n startup new-app-svc -o wide
kubectl get endpoints -n startup new-app-svc
```

Output:

```
[root@node20 ~]# kubectl get svc -n startup new-app-svc -o wide
NAME          TYPE       CLUSTER-IP      EXTERNAL-IP   PORT(S)        AGE   SELECTOR
new-app-svc   NodePort   10.43.225.171   <none>        80:30091/TCP   21h   app=task-manager
[root@node20 ~]# kubectl get endpoints -n startup new-app-svc
NAME          ENDPOINTS   AGE
new-app-svc   <none>      21h
```

NOTES:
The pods are labeled `app=new-app`

```
[root@node20 ~]# kubectl get pods -n startup --show-labels
NAME                       READY   STATUS             RESTARTS   AGE   LABELS
new-app-6b8c89d547-2x2gw   0/1     ImagePullBackOff   0          21h   app=new-app,pod-template-hash=6b8c89d547
new-app-6b8c89d547-jg24n   0/1     ImagePullBackOff   0          21h   app=new-app,pod-template-hash=6b8c89d547
```

The Service is looking for `app=task-manager`, which matches **nothing** → **ENDPOINTS: `<none>`**.

### Problem #6 | Even after pods run, nothing routes to them.

---

### OPTIONAL Step  : Check the resource limits

```bash
kubectl get deploy new-app -n startup -o jsonpath='{.spec.template.spec.containers[0].resources}{"\n"}'
```

```
[root@node20 ~]# kubectl get deploy new-app -n startup -o jsonpath='{.spec.template.spec.containers[0].resources}{"\n"}'
{"limits":{"cpu":"100m","memory":"20Mi"},"requests":{"cpu":"100m","memory":"20Mi"}}
```

---

### Step 7 |  GitOps Section

```bash
kubectl get applications -n argocd
```

### PROBLEM 7 | FIX (On Ton's End)
	`new-app` shows **Sync: Unknown**. That means ArgoCD isn't managing these objects right now.

---

## Applying the Fixes (Problems 1, 4, 5, 6)

Corrected `k8s/deployment.yaml` and `k8s/service.yaml` were committed to the `ops-airnav` repo:

```yaml
# deployment.yaml (relevant fields)
image: 192.168.10.23:5000/new-app:1.0   # Problem 1: real registry host + port + tag
ports:
- containerPort: 3001                    # Problem 5: match app's real port
env:
- name: PORT
  value: "3001"
livenessProbe:
  httpGet:
    path: /health                        # Problem 4: was /healthz
    port: 3001
readinessProbe:
  httpGet:
    path: /health
    port: 3001
```

```yaml
# service.yaml (relevant fields)
selector:
  app: new-app          # Problem 6: was app: task-manager
ports:
- targetPort: 3001       # matches the standardized app port
  nodePort: 30091
```

These were pushed to git and ArgoCD (Ton's end, Problem 7) was pointed at the manifests and synced.

Verification once pods started pulling correctly:
```bash
kubectl get pods -n startup
kubectl get endpoints -n startup new-app-svc
curl http://<node-ip>:30091/health
```

---

### Step 8 : ArgoCD synced, but pods are still failing — describe again

Even with the image address fixed, `describe pod` showed a **new, different** error — not the same as Problem 1:

```
Failed to pull image "192.168.10.23:5000/new-app:1.0":
failed to resolve reference "192.168.10.23:5000/new-app:1.0": failed to do request:
Head "https://192.168.10.23:5000/v2/new-app/manifests/1.0": http: server gave HTTP response to HTTPS client
```

containerd is trying **HTTPS** against a registry that only speaks **HTTP**. Checked the generated containerd config (not `registries.yaml` itself, but the file k3s actually builds from it) on every node:

```bash
cat /var/lib/rancher/k3s/agent/etc/containerd/certs.d/192.168.10.23:5000/hosts.toml
```

```toml
# File generated by k3s. DO NOT EDIT.
server = "https://192.168.10.23:5000/v2"     # <- always defaults to https, regardless of mirror endpoint scheme
capabilities = ["pull", "resolve", "push"]

[host]
[host."http://192.168.10.23:5000/v2"]
  capabilities = ["pull", "resolve"]
```

Even though the mirror `endpoint` correctly says `http://`, k3s's generator still defaults the top-level `server` fallback to `https://` — and containerd uses `server` for manifest-resolution HEAD requests, which is exactly the call that was failing.

### PROBLEM 8 | containerd defaults to HTTPS for the registry, but the registry only serves HTTP
	Fix: on **all three nodes** (node20, node21, node22), edit the real source file, not the generated one:

```bash
cat > /etc/rancher/k3s/registries.yaml <<'EOF'
mirrors:
  "192.168.10.23:5000":
    endpoint:
      - "http://192.168.10.23:5000"
configs:
  "192.168.10.23:5000":
    tls:
      insecure_skip_verify: true
EOF
systemctl restart k3s          # node20 (control-plane) only
systemctl restart k3s-agent    # node21 and node22
```

Verification — the generated file should now show `skip_verify = true`:
```bash
cat /var/lib/rancher/k3s/agent/etc/containerd/certs.d/192.168.10.23:5000/hosts.toml
```

---

### Step 9 : Pull error changes again — now it's an honest "not found"

After Problem 8's fix, the pull error changed from a TLS/protocol error to:

```
Failed to pull image "192.168.10.23:5000/new-app:1.0": rpc error: code = NotFound
desc = failed to pull and unpack image "192.168.10.23:5000/new-app:1.0":
failed to resolve reference "192.168.10.23:5000/new-app:1.0": 192.168.10.23:5000/new-app:1.0: not found
```

This confirmed the transport-layer bug (Problem 8) was genuinely fixed — containerd is now successfully talking to the registry and getting a real answer. The remaining issue is a **tag mismatch**: checked what tags actually exist —

```bash
curl -s http://192.168.10.23:5000/v2/new-app/tags/list
```
```
{"name":"new-app","tags":["staging-f8c8aed","staging-994f1e7","staging-0f13c3c","staging-06e3b74","staging-27e51a5"]}
```

### PROBLEM 9 | The Deployment asks for tag `:1.0`, but Dave's Jenkins pipeline only ever pushed `staging-<git-sha>` tags. `:1.0` was never published.
	Temporary unblock: point the Deployment at a tag that actually exists —
	```bash
	kubectl set image deployment/new-app -n startup new-app=192.168.10.23:5000/new-app:staging-f8c8aed
	```
	Real fix (still open, needs Dave): publish a stable `:1.0`/`:latest` tag from CI for `production` builds, since commit-sha tags shift on every push.

Verification:
```bash
kubectl get pods -n startup
kubectl get endpoints -n startup new-app-svc
curl http://<node-ip>:30091/health        # {"status":"healthy"}
curl http://<node-ip>:30091/api/info
```

---

### Step 10 : Recreating the ArgoCD apps for `staging`/`production` branches — a new conflict appears

After restructuring the repo into `staging` and `production` branches (each with its own `k8s/` manifests) and creating separate ArgoCD Applications for each, both apps showed `OutOfSync` and flapping health, with an explicit warning:

```bash
kubectl get application new-app -n argocd -o yaml
```
```
conditions:
- type: SharedResourceWarning
  message: Deployment/new-app is part of applications argocd/new-app and new-app-prod
- type: SharedResourceWarning
  message: Service/new-app-svc is part of applications argocd/new-app and new-app-prod
```

### PROBLEM 10 | Two ArgoCD Applications (staging-tracking and production-tracking) both managing the same Deployment/Service, because both branches' manifests hard-coded `namespace: startup`
	Both apps had `automated: true` + `selfHeal: true`, so each kept re-applying its own version whenever the other synced — an active reconciliation fight (`autoHealAttemptsCount: 7` by the time it was caught).

	Fix: separate the destination namespaces at the **manifest** level (the Application's destination-namespace field alone isn't enough — the in-file `metadata.namespace` wins for placement). On the `production` branch:
	```yaml
	# deployment.yaml and service.yaml
	metadata:
	  namespace: startup-prod    # was: startup
	```
	```yaml
	# service.yaml
	nodePort: 30092    # was: 30091 — NodePorts are cluster-wide, not per-namespace, so it must differ from staging's
	```
	`staging` branch was left targeting `namespace: startup` / `nodePort: 30091`, unchanged.

---

### Step 11 : Production app stuck on "Missing" health after the namespace split

```bash
kubectl get applications -n argocd
```
```
NAME              SYNC STATUS   HEALTH STATUS
new-app-prod      OutOfSync     Missing
new-app-staging   Synced        Healthy
```

```bash
kubectl get application new-app-prod -n argocd -o yaml
```
```
message: 'one or more objects failed to apply, reason: namespaces "startup-prod" not found. Retrying attempt #4 at 3:35AM.'
```

### PROBLEM 11 | The `startup-prod` namespace referenced in Problem 10's fix didn't exist yet, and the Application wasn't configured to create it
	Fix:
	```bash
	kubectl create namespace startup-prod
	```
	And to prevent this recurring, enabled auto-namespace-creation on the Application:
	```bash
	kubectl patch application new-app-prod -n argocd --type merge \
	  -p '{"spec":{"syncPolicy":{"syncOptions":["CreateNamespace=true"]}}}'
	```
	Note: once the namespace exists and the app syncs, it will still hit **Problem 9** again (production branch's manifest still references tag `:1.0`, which still doesn't exist) — that part remains an open item pending Dave publishing a stable tag.
