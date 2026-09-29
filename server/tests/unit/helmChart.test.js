/**
 * STORY-054 — the Helm chart, rendered and read.
 *
 * Acceptance: the system handles more load by adding copies of the API, spreads
 * requests across them, replaces a copy that dies, and lets people reach only
 * what their role needs. Those were proven on a live cluster (k3s under Colima);
 * the output is in the README. This file keeps what that run found from coming
 * back, without needing a cluster: it renders the chart and reads the result.
 *
 * Three of these assertions exist because the first live install failed on
 * them — the audit key unreadable by the app's user, a user name Kubernetes
 * could not verify as non-root, and an upgrade refused once the autoscaler had
 * scaled. A review of the templates had passed all three.
 *
 * Needs `helm` on the PATH; skipped, and says so, without it.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { parseAllDocuments } from 'yaml';

const CHART = fileURLToPath(new URL('../../../deploy/helm/author-launch-engine', import.meta.url));
const SECRETS = ['secrets.appDbPassword=a', 'secrets.ownerDbPassword=b', 'secrets.jwtSecret=c', 'secrets.auditKey=d'];
const hasHelm = spawnSync('helm', ['version', '--short']).status === 0;
const skip = hasHelm ? false : 'helm is not installed';

const render = (...sets) => parseAllDocuments(
  execFileSync('helm', ['template', 'ale', CHART, ...[...SECRETS, ...sets].flatMap((s) => ['--set', s])], { encoding: 'utf8' }),
).map((d) => d.toJS()).filter(Boolean);
const find = (docs, kind, name) => docs.find((d) => d.kind === kind && d.metadata.name === name);

describe('STORY-054: the Helm chart', { skip }, () => {
  it('refuses to render without its secrets, rather than inventing them', () => {
    const r = spawnSync('helm', ['template', 'ale', CHART], { encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /secret/i);
  });

  it('scales the API on CPU between a floor of two and a ceiling, and leaves the count to the autoscaler', () => {
    const docs = render();
    const hpa = find(docs, 'HorizontalPodAutoscaler', 'ale-api');
    assert.ok(hpa.spec.minReplicas >= 2, 'one copy is not load balancing');
    assert.ok(hpa.spec.maxReplicas > hpa.spec.minReplicas);
    // Found live: with replicas set here as well, the next upgrade after a
    // scale-up fails on a field conflict with the autoscaler.
    assert.equal(find(docs, 'Deployment', 'ale-api').spec.replicas, undefined);
    const fixed = find(render('api.autoscaling.enabled=false', 'api.replicas=4'), 'Deployment', 'ale-api');
    assert.equal(fixed.spec.replicas, 4);
  });

  it('keeps serving while pods are replaced: no rollout or eviction takes the last copy', () => {
    const docs = render();
    assert.equal(find(docs, 'Deployment', 'ale-api').spec.strategy.rollingUpdate.maxUnavailable, 0);
    assert.equal(find(docs, 'PodDisruptionBudget', 'ale-api').spec.minAvailable, 1);
    const probes = find(docs, 'Deployment', 'ale-api').spec.template.spec.containers[0];
    assert.equal(probes.readinessProbe.httpGet.path, '/api/ready');
    assert.equal(probes.livenessProbe.httpGet.path, '/api/health');
  });

  it('runs the app as a numeric non-root user who can read the mounted audit key', () => {
    const docs = render();
    for (const name of ['ale-api', 'ale-worker']) {
      const pod = find(docs, 'Deployment', name).spec.template.spec;
      assert.equal(pod.securityContext.runAsNonRoot, true, name);
      assert.equal(pod.securityContext.runAsUser, 10001, `${name}: a user name cannot be verified as non-root`);
      assert.equal(pod.securityContext.fsGroup, 10001, `${name}: without it the key is root's and unreadable`);
      const key = pod.volumes.find((v) => v.secret);
      assert.ok(key && (key.secret.defaultMode & 0o040), `${name}: key readable by the group`);
      assert.equal(key.secret.defaultMode & 0o007, 0, `${name}: and by no one else`);
    }
  });

  it('gives no pod a Kubernetes API token', () => {
    const docs = render();
    for (const sa of docs.filter((d) => d.kind === 'ServiceAccount')) {
      assert.equal(sa.automountServiceAccountToken, false, sa.metadata.name);
    }
  });

  it('roles: viewers read, operators restart and scale, only secret admins touch the one secret', () => {
    const docs = render('rbac.viewers={v}', 'rbac.operators={o}', 'rbac.secretAdmins={s}');
    const verbsOn = (role, resource) => find(docs, 'Role', role).rules
      .filter((r) => r.resources.includes(resource)).flatMap((r) => r.verbs);
    assert.ok(!verbsOn('ale-viewer', 'secrets').length);
    assert.ok(!verbsOn('ale-viewer', 'pods').includes('delete'));
    assert.ok(!verbsOn('ale-operator', 'secrets').length);
    assert.ok(verbsOn('ale-operator', 'pods').includes('delete'));
    const secretRule = find(docs, 'Role', 'ale-secrets-admin').rules[0];
    assert.deepEqual(secretRule.resourceNames, ['ale-secrets'], 'one secret, not every secret in the namespace');
    // Empty lists bind nobody.
    assert.equal(render().filter((d) => d.kind === 'RoleBinding').length, 0);
  });

  it('STORY-055/056: off by default; when on, only the app and Grafana reach the index', () => {
    assert.equal(find(render(), 'StatefulSet', 'ale-search'), undefined);
    const docs = render('search.enabled=true', 'dashboards.enabled=true', 'secrets.grafanaAdminPassword=g');
    const np = find(docs, 'NetworkPolicy', 'ale-search');
    assert.deepEqual(np.spec.ingress[0].from.map((f) => f.podSelector.matchLabels['ale-role']).sort(), ['app', 'dashboards']);
    const env = find(docs, 'Deployment', 'ale-worker').spec.template.spec.containers[0].env;
    assert.equal(env.find((e) => e.name === 'ELASTICSEARCH_URL').value, 'http://ale-search:9200', 'the worker fills the index');
  });

  it('STORY-056: Grafana needs its password, allows no anonymous viewers, and keeps customisations on a volume', () => {
    const r = spawnSync('helm', ['template', 'ale', CHART, ...[...SECRETS, 'dashboards.enabled=true'].flatMap((x) => ['--set', x])], { encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /grafanaAdminPassword/);
    const docs = render('search.enabled=true', 'dashboards.enabled=true', 'secrets.grafanaAdminPassword=g');
    const pod = find(docs, 'Deployment', 'ale-grafana').spec.template.spec;
    assert.equal(pod.containers[0].env.find((e) => e.name === 'GF_AUTH_ANONYMOUS_ENABLED').value, 'false');
    assert.ok(pod.volumes.find((v) => v.name === 'data').persistentVolumeClaim, 'a saved change must outlive the pod');
    const dashboards = find(docs, 'ConfigMap', 'ale-grafana-dashboards').data;
    assert.equal(JSON.parse(dashboards['trust.json']).uid, 'ale-trust');
    assert.match(dashboards['provider.yaml'], /allowUiUpdates: true/);
  });

  it('only the app reaches the database', () => {
    const np = find(render(), 'NetworkPolicy', 'ale-database');
    assert.deepEqual(np.spec.ingress[0].from, [{ podSelector: { matchLabels: { 'ale-role': 'app' } } }]);
  });
});
