/**
 * STORY-034 acceptance tests — what can be proved without Docker.
 *
 *   "Docker containerization with trust controls" → containerised for
 *       consistent deployment, and secure with vulnerability scanning.
 *
 * Docker is not installed on the machine this was written on and never has
 * been (STORY-015 said so). So the images have never been built and Clair has
 * never scanned one; the CI job that would do both is written and has never
 * run. What *can* be checked from here is checked here, and it found two real
 * defects in files that had been "reviewed, not run" for nineteen stories:
 *
 *   docker-compose.yml defined **one** service. The top-level `volumes:` block
 *     sat between `postgres` and `migrate`, so YAML read migrate, api, worker
 *     and client as volumes. `docker compose up` could only start a database.
 *
 *   The stack would have refused its own UI. STORY-031 made the API enforce
 *     HTTPS in production and nginx never forwarded X-Forwarded-Proto, so every
 *     browser call through nginx looked like plain http.
 *
 * And one gap: no .dockerignore, so every COPY sent host node_modules, build
 * output and any .env into the image.
 *
 * The dependency scan is the one vulnerability scan that runs here, and it is
 * in CI as a gate (`npm run scan:deps`).
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const compose = YAML.parse(read('docker-compose.yml'));
const DOCKERFILES = ['server/Dockerfile', 'server/Dockerfile.worker', 'client/Dockerfile'];

/** Instructions of a Dockerfile, continuation lines joined, comments dropped. */
const instructions = (text) =>
  text
    .replace(/\\\n/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

/** The last stage — the image that ships. */
const finalStage = (lines) => lines.slice(lines.map((l) => l.startsWith('FROM ')).lastIndexOf(true));

describe('Scenario: the stack is defined the way Compose will read it', () => {
  it('declares every service, not one', () => {
    assert.deepEqual(Object.keys(compose.services).sort(), ['api', 'client', 'migrate', 'postgres', 'worker']);
    assert.deepEqual(Object.keys(compose.volumes), ['ale-pgdata'], 'a service is being read as a volume');
  });

  it('every built service points at a Dockerfile that exists', () => {
    for (const [name, svc] of Object.entries(compose.services)) {
      if (!svc.build) continue;
      assert.ok(existsSync(join(root, svc.build.context, svc.build.dockerfile)), `${name}: no ${svc.build.dockerfile}`);
    }
  });

  it('the UI can reach the API: nginx proxies to a service that exists, on the port it listens on', () => {
    const nginx = read('client/nginx.conf');
    const [, host, port] = nginx.match(/proxy_pass http:\/\/([\w-]+):(\d+)\//);
    assert.ok(compose.services[host], `nginx proxies to "${host}", which is not a service`);
    assert.equal(port, '4000');
    assert.match(read('server/Dockerfile'), /EXPOSE 4000/);
  });

  it('nginx tells the API which scheme the client used — or the API refuses the UI', () => {
    // STORY-031's HTTPS enforcement reads X-Forwarded-Proto. Without this
    // header every call through nginx looked like plain http.
    assert.match(read('client/nginx.conf'), /proxy_set_header X-Forwarded-Proto \$client_proto;/);
  });

  it('the app and worker use the restricted database login; only migrate is the owner', () => {
    // STORY-033, carried into the containers.
    for (const name of ['api', 'worker']) {
      assert.match(compose.services[name].environment.DATABASE_URL, /^postgres:\/\/ale_app_login:/, name);
    }
    assert.ok(compose.services.migrate.environment.MIGRATION_DATABASE_URL);
    assert.equal(compose.services.migrate.environment.DATABASE_URL, undefined);
  });

  it('starts in the right order: database, then migrations, then the app', () => {
    assert.equal(compose.services.migrate.depends_on.postgres.condition, 'service_healthy');
    for (const name of ['api', 'worker']) {
      assert.equal(compose.services[name].depends_on.migrate.condition, 'service_completed_successfully');
    }
  });
});

describe('Scenario: the images are built to be scanned and trusted', () => {
  for (const file of DOCKERFILES) {
    const lines = instructions(read(file));

    it(`${file}: every base image is pinned by digest`, () => {
      // A tag names whatever was pushed last. A scan of one build says nothing
      // about the next unless the base cannot move under it.
      const froms = lines.filter((l) => l.startsWith('FROM '));
      assert.ok(froms.length > 0);
      for (const from of froms) assert.match(from, /@sha256:[0-9a-f]{64}/, from);
    });

    it(`${file}: the shipped image does not run as root`, () => {
      const last = finalStage(lines);
      const fromNonRootBase = /nginx-unprivileged/.test(last[0]);
      assert.ok(fromNonRootBase || last.some((l) => /^USER (?!root|0\b)/.test(l)), `${file} runs as root`);
    });

    it(`${file}: the entrypoint is exec form, so SIGTERM reaches the process`, () => {
      const cmd = lines.filter((l) => l.startsWith('CMD '));
      for (const c of cmd) assert.match(c, /^CMD \[/, c);
    });

    it(`${file}: no secret is baked into the image`, () => {
      for (const l of lines.filter((x) => /^(ENV|ARG) /.test(x))) {
        assert.doesNotMatch(l, /(SECRET|PASSWORD|API_KEY|TOKEN)\s*[= ]\s*\S/i, l);
      }
      assert.ok(!lines.some((l) => /^ADD https?:/.test(l)), 'ADD from a URL is an unverified download');
    });
  }

  it('the API image checks its own liveness', () => {
    assert.ok(instructions(read('server/Dockerfile')).some((l) => l.startsWith('HEALTHCHECK')));
  });

  it('.dockerignore keeps host modules, build output, secrets and history out of every layer', () => {
    const ignore = read('.dockerignore').split('\n').map((l) => l.trim());
    for (const pattern of ['**/node_modules', '**/.env', '.git', '**/dist']) {
      assert.ok(ignore.includes(pattern), `.dockerignore does not exclude ${pattern}`);
    }
  });
});

describe('Scenario: vulnerability scanning gates the build', () => {
  const ci = YAML.parse(read('.github/workflows/ci.yml'));

  it('the dependency scan runs before the tests and fails on moderate or worse', () => {
    const steps = ci.jobs.test.steps.map((s) => s.run ?? '');
    const scan = steps.findIndex((s) => s.includes('npm audit --omit=dev --audit-level=moderate'));
    const tests = steps.findIndex((s) => s.includes('npm test'));
    assert.ok(scan >= 0, 'no dependency scan in CI');
    assert.ok(scan < tests);
  });

  it('every image is scanned by Clair, pinned, and the scan can fail', () => {
    const scans = ci.jobs.images.steps.filter((s) => String(s.uses ?? '').startsWith('quay/clair-action'));
    assert.equal(scans.length, 3, 'one scan per image');
    for (const s of scans) {
      assert.match(s.uses, /@v\d+\.\d+\.\d+$/, 'pinned to a release, not @main');
      // The action's default is '0': report and pass. A scan that cannot fail
      // the build is a report nobody reads.
      assert.equal(String(s.with['return-code']), '1');
    }
  });
});
