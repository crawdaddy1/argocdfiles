'use strict';
// Weekly cluster hygiene report. Read-only: talks to the Kubernetes API with this pod's service account.
// Each finding is one JSON log line (Loki: {namespace="monitoring", container="hygiene"} | json), followed by
// a summary line and a human-readable table at the end.
const fs = require('fs');
const https = require('https');

const SA = '/var/run/secrets/kubernetes.io/serviceaccount';
const API = process.env.API_URL || 'https://kubernetes.default.svc';
const TOKEN = process.env.API_TOKEN || (fs.existsSync(SA + '/token') ? fs.readFileSync(SA + '/token', 'utf8') : '');
const CA = fs.existsSync(SA + '/ca.crt') ? fs.readFileSync(SA + '/ca.crt') : undefined;
const RESTART_THRESHOLD = Number(process.env.RESTART_THRESHOLD || 5);
const RESTART_WINDOW_DAYS = Number(process.env.RESTART_WINDOW_DAYS || 7);

function get(path) {
  return new Promise((resolve) => {
    const u = new URL(path, API);
    const mod = u.protocol === 'http:' ? require('http') : https;
    const req = mod.get(u, { ca: CA, headers: TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {} }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode === 404) return resolve({ items: [], missing: true });   // CRD not installed
        if (res.statusCode >= 300) return resolve({ items: [], error: res.statusCode + ' ' + path });
        try { resolve(JSON.parse(body)); } catch (e) { resolve({ items: [], error: 'bad JSON from ' + path }); }
      });
    });
    req.on('error', (e) => resolve({ items: [], error: e.message + ' ' + path }));
  });
}

const findings = [];
const errors = [];
function add(check, severity, item, detail) {
  const f = { hygiene: 'finding', check, severity, item, detail };
  findings.push(f);
  console.log(JSON.stringify(f));
}
const nsName = (o) => (o.metadata.namespace ? o.metadata.namespace + '/' : '') + o.metadata.name;

async function main() {
  const L = async (p) => { const r = await get(p); if (r.error) errors.push(r.error); return r; };
  const [pods, svcs, pvcs, pvs, nodes, nss, ings, ingClasses, jobs, deps, stss, dss, vwh, mwh, apps, lhVols] = await Promise.all([
    L('/api/v1/pods'), L('/api/v1/services'), L('/api/v1/persistentvolumeclaims'), L('/api/v1/persistentvolumes'),
    L('/api/v1/nodes'), L('/api/v1/namespaces'), L('/apis/networking.k8s.io/v1/ingresses'),
    L('/apis/networking.k8s.io/v1/ingressclasses'), L('/apis/batch/v1/jobs'), L('/apis/apps/v1/deployments'),
    L('/apis/apps/v1/statefulsets'), L('/apis/apps/v1/daemonsets'),
    L('/apis/admissionregistration.k8s.io/v1/validatingwebhookconfigurations'),
    L('/apis/admissionregistration.k8s.io/v1/mutatingwebhookconfigurations'),
    L('/apis/argoproj.io/v1alpha1/applications'), L('/apis/longhorn.io/v1beta2/volumes'),
  ]);

  // --- Nodes: not ready, cordoned, mismatched kubelet versions
  const kubelets = new Set();
  for (const n of nodes.items) {
    kubelets.add(n.status.nodeInfo.kubeletVersion);
    const ready = (n.status.conditions || []).find((c) => c.type === 'Ready');
    if (!ready || ready.status !== 'True') add('node_not_ready', 'problem', n.metadata.name, ready ? ready.reason : 'no Ready condition');
    if (n.spec.unschedulable) add('node_cordoned', 'problem', n.metadata.name, 'SchedulingDisabled; uncordon if maintenance is over');
  }
  if (kubelets.size > 1) add('kubelet_version_skew', 'drift', 'nodes', [...kubelets].join(', '));

  // --- Pods: not running, crash looping, many restarts, image pull problems
  for (const p of pods.items) {
    const phase = p.status.phase;
    const cs = (p.status.containerStatuses || []).concat(p.status.initContainerStatuses || []);
    for (const c of cs) {
      const w = c.state && c.state.waiting;
      if (w && /CrashLoopBackOff|ImagePullBackOff|ErrImagePull|CreateContainerConfigError|InvalidImageName/.test(w.reason || '')) {
        add('container_waiting', 'problem', nsName(p) + ':' + c.name, w.reason + (w.message ? ' - ' + w.message.slice(0, 160) : ''));
      }
      // Only flag restarts that happened in the last RESTART_WINDOW_DAYS; old ones (node reboots) are history.
      const last = c.lastState && c.lastState.terminated;
      const recent = last && last.finishedAt && (Date.now() - Date.parse(last.finishedAt)) < RESTART_WINDOW_DAYS * 86400e3;
      if (c.restartCount > RESTART_THRESHOLD && recent) {
        add('container_restarts', 'problem', nsName(p) + ':' + c.name, c.restartCount + ' restarts total; last stopped ' + last.finishedAt +
          ' (' + (last.reason || 'exit') + ' code ' + last.exitCode + ')');
      }
    }
    if (phase === 'Failed' || phase === 'Unknown') add('pod_failed', 'unused', nsName(p), phase + (p.status.reason ? ' (' + p.status.reason + ')' : '') + '; delete it');
    if (phase === 'Pending') {
      const sched = (p.status.conditions || []).find((c) => c.type === 'PodScheduled' && c.status === 'False');
      const age = (Date.now() - Date.parse(p.metadata.creationTimestamp)) / 60000;
      if (age > 15) add('pod_pending', 'problem', nsName(p), sched ? sched.message.slice(0, 160) : 'Pending ' + Math.round(age) + ' min');
    }
  }

  // --- Jobs that failed and never succeeded
  for (const j of jobs.items) {
    if ((j.status.failed || 0) > 0 && !(j.status.succeeded > 0) && !j.status.active) add('job_failed', 'problem', nsName(j), j.status.failed + ' failed attempt(s)');
  }

  // --- Services: load balancers that never got an address, NodePorts open on every node
  const svcKeys = new Set(svcs.items.map((s) => s.metadata.namespace + '/' + s.metadata.name));
  for (const s of svcs.items) {
    if (s.spec.type === 'LoadBalancer' && !(s.status.loadBalancer && (s.status.loadBalancer.ingress || []).length) && !s.spec.loadBalancerClass) {
      add('lb_pending', 'unused', nsName(s), 'LoadBalancer with no address (no LB IP pool); remove or switch to ClusterIP');
    }
    if (s.spec.type === 'NodePort' || s.spec.type === 'LoadBalancer') {
      const ports = (s.spec.ports || []).map((p) => p.nodePort).filter(Boolean);
      if (ports.length && !s.spec.loadBalancerClass) add('nodeport_open', 'review', nsName(s), 'NodePort(s) ' + ports.join(', ') + ' open on every node');
    }
  }

  // --- Webhooks pointing at Services that no longer exist (these block create/update of the kinds they watch)
  for (const cfg of vwh.items.concat(mwh.items)) {
    for (const w of cfg.webhooks || []) {
      const ref = w.clientConfig && w.clientConfig.service;
      if (ref && !svcKeys.has(ref.namespace + '/' + ref.name)) {
        add('webhook_dangling', 'problem', cfg.metadata.name, 'webhook ' + w.name + ' points at missing service ' + ref.namespace + '/' + ref.name);
      }
    }
  }

  // --- Ingress classes nothing uses / ingresses using a missing class
  const classNames = new Set(ingClasses.items.map((c) => c.metadata.name));
  const usedClasses = new Set(ings.items.map((i) => i.spec.ingressClassName).filter(Boolean));
  for (const c of classNames) if (!usedClasses.has(c)) add('ingressclass_unused', 'unused', c, 'no Ingress uses this class');
  for (const i of ings.items) {
    if (i.spec.ingressClassName && !classNames.has(i.spec.ingressClassName)) add('ingress_missing_class', 'problem', nsName(i), 'class ' + i.spec.ingressClassName + ' does not exist');
    const lb = i.status && i.status.loadBalancer && i.status.loadBalancer.ingress;
    if (!lb || !lb.length) add('ingress_no_address', 'problem', nsName(i), 'no address assigned');
  }

  // --- Storage: unbound claims, released/orphaned volumes, unhealthy Longhorn volumes
  for (const c of pvcs.items) if (c.status.phase !== 'Bound') add('pvc_unbound', 'problem', nsName(c), c.status.phase);
  const pvcInUse = new Set();
  for (const p of pods.items) for (const v of p.spec.volumes || []) if (v.persistentVolumeClaim) pvcInUse.add(p.metadata.namespace + '/' + v.persistentVolumeClaim.claimName);
  for (const c of pvcs.items) {
    if (c.status.phase === 'Bound' && !pvcInUse.has(nsName(c))) {
      const owner = (c.metadata.ownerReferences || []).length ? '' : '';
      add('pvc_not_mounted', 'review', nsName(c), (c.status.capacity && c.status.capacity.storage || '') + ' bound but no pod mounts it' + owner);
    }
  }
  for (const v of pvs.items) if (['Released', 'Available', 'Failed'].includes(v.status.phase)) add('pv_orphaned', 'unused', v.metadata.name, v.status.phase + ' ' + (v.spec.capacity && v.spec.capacity.storage || '') + (v.spec.claimRef ? ' (was ' + v.spec.claimRef.namespace + '/' + v.spec.claimRef.name + ')' : ''));
  if (!lhVols.missing) {
    for (const v of lhVols.items) {
      const st = v.status || {};
      const pvc = st.kubernetesStatus && st.kubernetesStatus.pvcName;
      if (st.robustness && !['healthy', 'unknown'].includes(st.robustness)) add('longhorn_volume_unhealthy', 'problem', v.metadata.name, st.robustness + (pvc ? ' (' + pvc + ')' : ''));
      if (!pvc && st.state === 'detached') add('longhorn_volume_orphaned', 'unused', v.metadata.name, 'detached and not bound to any PVC');
    }
  }

  // --- Argo CD apps not Synced/Healthy, and workloads Argo CD doesn't manage
  for (const a of apps.items) {
    const sync = a.status && a.status.sync && a.status.sync.status;
    const health = a.status && a.status.health && a.status.health.status;
    if (sync !== 'Synced' || health !== 'Healthy') add('argocd_app_unhealthy', 'problem', a.metadata.name, (sync || '?') + ' / ' + (health || '?'));
  }
  const SYSTEM_NS = new Set(['kube-system', 'kube-public', 'kube-node-lease']);
  const tracked = (o) => {
    const a = o.metadata.annotations || {};
    const l = o.metadata.labels || {};
    return a['argocd.argoproj.io/tracking-id'] || l['app.kubernetes.io/instance'] || l['argocd.argoproj.io/instance'] ||
      // created by an operator that Argo CD manages (Tailscale proxies, Longhorn CSI driver, ...)
      l['tailscale.com/managed'] || Object.keys(l).some((k) => k.endsWith('/managed-by'));
  };
  const owned = (o) => (o.metadata.ownerReferences || []).length > 0;
  const withKind = (list, kind) => list.items.map((o) => Object.assign({ kind }, o));
  for (const w of withKind(deps, 'Deployment').concat(withKind(stss, 'StatefulSet'), withKind(dss, 'DaemonSet'))) {
    if (SYSTEM_NS.has(w.metadata.namespace) || owned(w) || w.metadata.namespace === 'argocd') continue;
    if (!tracked(w)) add('workload_unmanaged', 'review', w.kind + ' ' + nsName(w), 'not managed by Argo CD (manual install?)');
  }

  // --- Namespaces with nothing running in them
  const nsWithPods = new Set(pods.items.map((p) => p.metadata.namespace));
  for (const n of nss.items) {
    const name = n.metadata.name;
    if (!SYSTEM_NS.has(name) && name !== 'default' && !nsWithPods.has(name)) add('namespace_empty', 'unused', name, 'no pods');
  }

  // --- Images pinned to :latest or untagged (drift risk)
  const imgs = new Set();
  for (const p of pods.items) for (const c of (p.spec.containers || []).concat(p.spec.initContainers || [])) imgs.add(c.image);
  for (const i of imgs) {
    const name = i.split('@')[0];
    if (!i.includes('@') && (name.endsWith(':latest') || !/:[^/]+$/.test(name))) add('image_unpinned', 'drift', i, 'pin a version tag');
  }

  // --- Summary
  const by = {};
  for (const f of findings) by[f.severity] = (by[f.severity] || 0) + 1;
  console.log(JSON.stringify({ hygiene: 'summary', total: findings.length, by_severity: by, api_errors: errors, images: imgs.size, nodes: nodes.items.length, pods: pods.items.length }));
  console.log('\n==== Cluster hygiene report ' + new Date().toISOString() + ' ====');
  if (!findings.length) console.log('No findings. Cluster is clean.');
  const order = { problem: 0, unused: 1, drift: 2, review: 3 };
  for (const f of findings.sort((a, b) => order[a.severity] - order[b.severity])) console.log(`[${f.severity.toUpperCase()}] ${f.check}: ${f.item} - ${f.detail}`);
  if (errors.length) console.log('API errors (check RBAC): ' + errors.join('; '));
}
main().catch((e) => { console.log(JSON.stringify({ hygiene: 'error', message: e.message })); process.exit(1); });
