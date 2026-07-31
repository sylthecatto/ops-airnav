
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

### Problem #4 |  A wrong liveness path makes Kubernetes kill the container over and over. 
	The app listens on `process.env.PORT || 3001` → **3001** by default, but your Deployment/Service uses 3000.


### Problem #5  | Port mismatch = probes fail and traffic can't reach the app. 

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

### Problem #6 (K4). Even after pods run, nothing routes to them.

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
	new-app` shows **Sync: Unknown**. That means ArgoCD isn't managing these objects right now.

---
