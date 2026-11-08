# argocdfiles

GitOps definitions for the apps on my clusters, using the Argo CD **app-of-apps** pattern.

```
bootstrap/root.yaml          the one Application you apply by hand; it watches apps/
apps/                        one Argo CD Application per app (commit a file here to deploy something)
  sealed-secrets.yaml        wave -2  Secrets encrypted so they're safe to keep in git
  tailscale-operator.yaml    wave -1  puts Services on the tailnet
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

Sealed Secrets and the Tailscale operator install themselves. The Tailscale operator waits for its credentials (step 3), and strat1990 waits for its secrets (step 4).

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

## Storage

The manifests leave `storageClassName` unset, so they use the cluster's default class. Check what you have:

```sh
kubectl get storageclass
```

- **kops on AWS/GCP/etc.:** kops installs the cloud CSI driver and a default class (for example `kops-csi-1-21` on gp3), so you don't need anything else.
- **No default class (bare metal):** install [Longhorn](https://longhorn.io). It replicates volumes across your 3 workers and does snapshots and backups. It's another file in `apps/`.

## Adding another app

Commit `apps/<name>.yaml` pointing at the app's manifests. To expose it on the tailnet, add these annotations to its Service:

```yaml
annotations:
  tailscale.com/expose: "true"
  tailscale.com/hostname: <name>
```

To deploy to a different cluster later, register the cluster with Argo CD (`argocd cluster add`) and change the `destination.server` of the apps you want there.

## Apps

| App | Source | Namespace | Tailnet URL |
|-----|--------|-----------|-------------|
| sealed-secrets | upstream v0.40.0 | kube-system | — |
| tailscale-operator | pkgs.tailscale.com chart 1.102.2 | tailscale | — |
| strat1990 | crawdaddy1/strat1990 `deploy/` | strat1990 | http://strat-stats · http://strat-sheet |
