# argocdfiles

GitOps definitions for the apps on my clusters, using the Argo CD **app-of-apps** pattern.

```
bootstrap/root.yaml          the one Application you apply by hand; it watches apps/
apps/                        one Argo CD Application per app (commit a file here to deploy something)
  sealed-secrets.yaml        wave -2  Secrets encrypted so they're safe to keep in git
  snapshot-controller.yaml   wave -2  Kubernetes volume snapshot API + controller (used by Longhorn)
  tailscale-operator.yaml    wave -1  puts Services on the tailnet
  longhorn.yaml              wave -1  replicated storage; default StorageClass
  kube-prometheus-stack.yaml wave  0  Prometheus + Grafana (+ node-exporter, kube-state-metrics)
  loki.yaml                  wave  0  log storage (14 days)
  alloy.yaml                 wave  1  ships pod logs and Kubernetes events to Loki
  strat1990.yaml             wave  0  Strat-O-Matic replay (manifests in crawdaddy1/strat1990/deploy)
platform/                    manifests for the cluster add-ons above
```

This repo is **public**. Only *sealed* secrets go in it: they're encrypted with the cluster's key, so they're useless anywhere else.

---

## First-time setup (in order)

### 1. Bootstrap Argo CD

```sh
kubectl apply -n argocd -f bootstrap/root.yaml
```

Sealed Secrets, Longhorn and the Tailscale operator install themselves (do the Longhorn node prep in **Storage** below first). The Tailscale operator waits for its credentials (step 3), and strat1990 waits for its secrets (step 4).

### 2. Install kubeseal on your laptop

```sh
brew install kubeseal          # or the v0.40.0 release tarball from github.com/bitnami/sealed-secrets
kubeseal --fetch-cert > ~/sealed-secrets-cert.pem   # optional: lets you seal without cluster access
```

### 3. Tailscale operator credentials

In the Tailscale admin console:

1. **Access controls**: add these tags:
   ```json
   "tagOwners": {
     "tag:k8s-operator": [],
     "tag:k8s": ["tag:k8s-operator"]
   }
   ```
2. **Settings → Trust credentials → OAuth client**: give it write scope for **Devices/Core**, **Keys/Auth Keys** and **General/Services**, all with tag `tag:k8s-operator`. Copy the client ID and secret.
3. Seal them and commit the result:
   ```sh
   kubectl create secret generic operator-oauth -n tailscale --dry-run=client -o yaml \
     --from-literal=client_id='<CLIENT_ID>' --from-literal=client_secret='<CLIENT_SECRET>' \
   | kubeseal -o yaml > platform/tailscale-operator/operator-oauth-sealed.yaml
   ```
   Then uncomment `operator-oauth-sealed.yaml` in `platform/tailscale-operator/kustomization.yaml`, commit, and push. A machine called `k8s-operator` appears in your tailnet.

### 4. strat1990 secrets

The app's manifests live in the private repo `crawdaddy1/strat1990`, so Argo CD needs read access to it:

```sh
ssh-keygen -t ed25519 -N '' -f strat1990-deploy -C argocd-strat1990
# GitHub → crawdaddy1/strat1990 → Settings → Deploy keys → add strat1990-deploy.pub (read-only)
argocd repo add git@github.com:crawdaddy1/strat1990.git --ssh-private-key-path strat1990-deploy
```

Then change `repoURL` in `apps/strat1990.yaml` to `git@github.com:crawdaddy1/strat1990.git`.

Generate the database passwords sealed, in the strat1990 repo:

```sh
kubectl create secret generic strat1990-db -n strat1990 --dry-run=client -o yaml \
  --from-literal=MYSQL_ROOT_PASSWORD="$(openssl rand -base64 24)" \
  --from-literal=MYSQL_PASSWORD="$(openssl rand -base64 24)" \
| kubeseal -o yaml > deploy/db-secret-sealed.yaml
```

Add `db-secret-sealed.yaml` to `resources:` in `deploy/kustomization.yaml`, then commit and push.

**Back up the sealing key.** If the cluster is rebuilt without it, the sealed files can't be decrypted:

```sh
kubectl -n kube-system get secret -l sealedsecrets.bitnami.com/sealed-secrets-key -o yaml > sealed-secrets-key.yaml
# keep this somewhere safe (password manager), never in git
```

---

## Storage (Longhorn)

Longhorn keeps 3 copies of every volume, one on each worker, so losing a node loses no data. It's the cluster's **default StorageClass**, so app manifests don't need to name one. The dashboard is at **https://longhorn.<tailnet>.ts.net** on the tailnet.

**Before the first sync**, on each of the 3 workers:

```sh
sudo apt-get install -y open-iscsi nfs-common
sudo systemctl enable --now iscsid
```

Then check: `kubectl -n longhorn-system get pods` should be all Running, and `kubectl get storageclass` should show `longhorn (default)`. If another class is also marked default, unmark it:
`kubectl patch storageclass <other> -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"false"}}}'`

Replicas protect against a dead disk or node, not against deleting data by mistake. strat1990 also makes nightly `mysqldump` backups. Longhorn can additionally back up volumes to S3 or NFS (Settings → Backup Target) if you want off-cluster copies.

## Monitoring

- **Grafana** https://grafana.taila044fc.ts.net: the dashboard "Strat-O-Matic '90 A's Replay" is provisioned from
  the strat1990 repo. Use Explore → Loki for ad-hoc log searches like `{namespace="strat1990", app="scoresheet"}`.
- **Prometheus** https://prometheus.taila044fc.ts.net (15 days / 18 GB of metrics)
- Apps are scraped through ServiceMonitors in their own repos; any namespace works.

**One-time: the Grafana admin login** (sealed, so it's safe in this public repo):

```sh
kubectl create secret generic grafana-admin -n monitoring --dry-run=client -o yaml \
  --from-literal=admin-user=admin \
  --from-literal=admin-password="$(/usr/bin/openssl rand -base64 18)" \
| kubeseal -o yaml > platform/monitoring/grafana-admin-sealed.yaml
```

Uncomment it in `platform/monitoring/kustomization.yaml` and commit. To read the password later:
`kubectl -n monitoring get secret grafana-admin -o jsonpath='{.data.admin-password}' | base64 -d`

## Adding another app

Commit `apps/<name>.yaml` pointing at the app's manifests. To put it on the tailnet with a valid
HTTPS certificate (Let's Encrypt via Tailscale; needs **HTTPS Certificates** enabled on the Tailscale
DNS page), give it a Tailscale Ingress:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: <name>
spec:
  ingressClassName: tailscale
  defaultBackend:
    service: { name: <service>, port: { number: 80 } }
  tls:
    - hosts: [<name>]        # becomes https://<name>.<tailnet>.ts.net
```

To deploy to a different cluster later, register the cluster with Argo CD (`argocd cluster add`) and change the `destination.server` of the apps you want there.

## Apps

| App | Source | Namespace | Tailnet URL |
|-----|--------|-----------|-------------|
| sealed-secrets | upstream v0.40.0 | kube-system | — |
| tailscale-operator | pkgs.tailscale.com chart 1.102.2 | tailscale | — |
| snapshot-controller | kubernetes-csi/external-snapshotter v8.7.0 | kube-system | — |
| longhorn | charts.longhorn.io 1.12.0 | longhorn-system | https://longhorn.&lt;tailnet&gt;.ts.net |
| kube-prometheus-stack | prometheus-community chart 93.1.0 | monitoring | https://grafana.taila044fc.ts.net · https://prometheus.taila044fc.ts.net |
| loki | grafana-community chart 21.0.0 | monitoring | (via Grafana) |
| alloy | grafana chart 1.15.0 | monitoring | — |
| strat1990 | crawdaddy1/strat1990 `deploy/` | strat1990 | https://strat-stats.&lt;tailnet&gt;.ts.net · https://strat-sheet.&lt;tailnet&gt;.ts.net |
