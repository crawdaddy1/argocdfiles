# argocdfiles

GitOps definitions for the apps on my clusters, using the Argo CD **app-of-apps** pattern.

```
bootstrap/root.yaml   the one Application applied by hand; it watches apps/
apps/*.yaml           one Argo CD Application per app (commit a file here to deploy something)
```

## One-time setup on a cluster

```sh
kubectl apply -n argocd -f bootstrap/root.yaml
```

Everything under `apps/` then syncs automatically.

## Private source repos

This repo is public. If an app's manifests live in a private repo, Argo CD needs read access to it.
Add a **read-only deploy key** to that repo (GitHub → repo → Settings → Deploy keys) and register it with Argo CD:

```sh
ssh-keygen -t ed25519 -N '' -f strat1990-deploy -C argocd-strat1990
# paste strat1990-deploy.pub into GitHub as a read-only deploy key, then:
argocd repo add git@github.com:crawdaddy1/strat1990.git --ssh-private-key-path strat1990-deploy
```

When you use SSH, change that app's `repoURL` to the `git@github.com:...` form.
Secrets never go in this repo.

## Apps

| App | Source | Namespace | URL (tailnet) |
|-----|--------|-----------|---------------|
| strat1990 | crawdaddy1/strat1990 `deploy/` | strat1990 | http://strat-stats · http://strat-sheet |
