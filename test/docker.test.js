import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DockerRuntime } from '../src/docker.js';
import { Workbench } from '../src/workbench.js';
import { readJson, json } from '../src/files.js';
import { prepareCodeArgs } from '../src/process.js';

const temp = path.resolve('.local/docker-tests');
async function engine(options = {}) {
  await fs.mkdir(temp, { recursive: true });
  const root = await fs.mkdtemp(path.join(temp, 'case-'));
  const calls = [], containers = new Map();
  let image = false;
  const execute = async (executable, args, runOptions = {}) => {
    calls.push({ executable, args, options: runOptions });
    const operation = args[0];
    if (operation === 'context') return JSON.stringify(options.endpoint || 'npipe:////./pipe/dockerDesktopLinuxEngine');
    if (operation === 'info') {
      if (options.unavailable) throw new Error('Docker daemon is unavailable');
      return options.os || 'linux';
    }
    if (operation === 'image') return image ? 'sha256:fixture' : '';
    if (operation === 'build') { image = true; runOptions.onOutput?.('Image built.\n'); return ''; }
    if (operation === 'desktop' && options.desktopStartSupported) { options.unavailable = false; return ''; }
    if (operation === 'container') {
      const name = args[args.indexOf('--filter') + 1].slice(7, -1);
      return containers.has(name) ? 'fixture-id' : '';
    }
    if (operation === 'inspect') return JSON.stringify([containers.get(args[1])]);
    if (operation === 'start') { containers.get(args[1]).State.Running = true; return ''; }
    if (operation === 'run') {
      const name = args[args.indexOf('--name') + 1];
      const labels = Object.fromEntries(args.flatMap((arg, i) => arg === '--label' ? [args[i + 1].split('=')] : []));
      const mount = args[args.indexOf('--mount') + 1];
      containers.set(name, { Config: { Labels: labels }, State: { Running: true },
        Mounts: [{ Type: 'bind', Source: mount.slice('type=bind,source='.length, mount.indexOf(',target=')), Destination: '/workspace', RW: true }] });
      return 'fixture-id';
    }
    if (operation === 'exec') {
      const command = JSON.parse(Buffer.from(args.at(-1), 'base64').toString());
      if (options.failBrowser && command.args.includes('.harness/demo/check.mjs')) throw new Error('Chromium cannot launch');
      if (command.args.includes('.harness/demo/record.mjs')) {
        const name = args[args.indexOf('--workdir') + 2];
        const folder = containers.get(name).Mounts[0].Source;
        await fs.mkdir(path.join(folder, 'artifacts/demo-fixture'), { recursive: true });
        await json(path.join(folder, 'artifacts/demo-fixture/result.json'), { ok: true });
      }
      return 'Container command complete';
    }
    if (operation === 'rm') { containers.delete(args.at(-1)); return ''; }
    throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
  };
  const docker = new DockerRuntime({ execute });
  const workbench = new Workbench({ root, url: 'http://127.0.0.1:4310', autoOpen: false, docker });
  return { docker, workbench, root, calls, containers, options };
}
async function create(fixture) {
  const session = await fixture.workbench.create();
  await fixture.workbench.locks.get(session.id);
  return fixture.workbench.get(session.id);
}

test('each new workspace gets its own Linux container and shares one image build', async () => {
  const f = await engine();
  const [first, second] = await Promise.all([create(f), create(f)]);
  assert.equal(first.status, 'awaiting_brief');
  assert.equal(second.status, 'awaiting_brief');
  assert.notEqual(first.execution.name, second.execution.name);
  assert.equal(f.calls.filter(c => c.args[0] === 'build').length, 1);
  for (const session of [first, second]) {
    assert.equal(session.execution.backend, 'docker-linux');
    assert.deepEqual(await readJson(path.join(session.folder, '.harness/demo/runtime.json')), { browsersPath: '/ms-playwright', backend: 'docker-linux' });
    assert.equal((await readJson(path.join(session.folder, '.harness/bridge.json'))).hostFolder, session.folder);
    const run = f.calls.find(c => c.args[0] === 'run' && c.args.includes(session.execution.name));
    assert.ok(run.args.includes(`type=bind,source=${session.folder},target=/workspace`));
    assert.ok(run.args.includes('type=volume,target=/workspace/node_modules'));
    assert.ok(run.args.includes('type=volume,target=/workspace/.harness/demo/node_modules'));
    assert.equal(run.options.env, undefined, 'Host credentials and proxy environment are not forwarded wholesale');
  }
});

test('Docker unavailable, wrong engine and browser failures stay in retryable preparation', async () => {
  for (const options of [{ unavailable: true }, { os: 'windows' }, { failBrowser: true }, { endpoint: 'ssh://remote.example' }]) {
    const f = await engine(options);
    const s = await create(f);
    assert.equal(s.status, 'error'); assert.equal(s.demoReady, false);
    assert.equal(s.phase, 'preparation');
    assert.match(await fs.readFile(path.join(s.folder, '.harness/setup.log'), 'utf8'), /Setup failed/);
    options.unavailable = false; options.os = 'linux'; options.failBrowser = false; options.endpoint = 'npipe:////./pipe/dockerDesktopLinuxEngine';
    await f.workbench.setup(s.id);
    assert.equal(s.status, 'awaiting_brief');
  }
});

test('restart preserves backend; a stopped container starts before a queued job is dispatched', async () => {
  const f = await engine(); const s = await create(f);
  f.containers.get(s.execution.name).State.Running = false;
  const restarted = new Workbench({ root: f.root, url: f.workbench.url, autoOpen: false, backend: 'host', docker: f.docker });
  await restarted.load();
  assert.equal(restarted.get(s.id).execution.backend, 'docker-linux');
  await restarted.brief(s.id, 'Build a Linux API');
  const job = await restarted.claim(s.id);
  assert.match(job.prompt, /Linux Docker container/);
  assert.ok(f.calls.some(c => c.args[0] === 'start' && c.args[1] === s.execution.name));
  await assert.rejects(restarted.setup(s.id), /complete and locked/);
});

test('recording runs via Docker and captures artifacts through the bind mount', async () => {
  const f = await engine(); const s = await create(f);
  s.phase = 'demo'; s.uiChanged = true; s.status = 'demo_pending';
  await f.workbench.demo(s.id);
  assert.equal(s.status, 'complete');
  assert.ok(s.artifacts.includes('artifacts/demo-fixture/result.json'));
  const recording = f.calls.find(c => c.args[0] === 'exec' && JSON.parse(Buffer.from(c.args.at(-1), 'base64')).args.includes('.harness/demo/record.mjs'));
  assert.equal(recording.options.timeout, 200000);
});

test('deletion checks ownership and mount before removing only the selected container and volumes', async () => {
  const f = await engine(); const first = await create(f), second = await create(f);
  const info = f.containers.get(first.execution.name);
  const source = info.Mounts[0].Source;
  info.Mounts[0].Source = path.join(f.root, 'unrelated');
  await assert.rejects(f.workbench.remove(first.id, first.id), /ownership or workspace mount/);
  assert.ok(await fs.stat(first.folder));
  info.Mounts[0].Source = source;
  await f.workbench.remove(first.id, first.id);
  assert.deepEqual(f.calls.find(c => c.args[0] === 'rm').args, ['rm', '--force', '--volumes', first.execution.name]);
  assert.ok(f.containers.has(second.execution.name));
  await assert.rejects(fs.stat(first.folder), { code: 'ENOENT' });
});

test('VS Code launch targets the existing Linux container and uses a workspace-specific host bridge', async () => {
  const f = await engine(); const s = await create(f);
  const args = await prepareCodeArgs(s.folder, path.resolve('extension'), s.execution);
  assert.ok(args.includes('--new-window'));
  const uri = new URL(args.at(-1));
  assert.equal(uri.pathname, '/workspace');
  assert.equal(args[args.indexOf('--remote') + 1], uri.hostname, 'Development-host connection authority must match the container folder authority');
  assert.ok(args.includes('--extensionDevelopmentKind=ui'), 'Bridge must stay on the Windows UI side');
  const details = JSON.parse(Buffer.from(uri.hostname.split('+')[1], 'hex').toString());
  assert.equal(details.containerName, `/${s.execution.name}`);
  assert.ok(args.includes(`--extensionDevelopmentPath=${path.join(s.folder, '.harness/bridge-extension-remote')}`));
});

test('restore starts Docker Desktop, restarts the saved container and opens VS Code without replacing the queued job', async () => {
  const f = await engine({ desktopStartSupported: true });
  f.docker.platform = 'win32';
  const s = await create(f);
  await f.workbench.brief(s.id, 'Resume a Linux app');
  const jobId = s.jobs[0].id;
  f.options.unavailable = true;
  f.containers.get(s.execution.name).State.Running = false;
  let launched = 0;
  f.workbench.launch = async (folder, extension, session) => { launched++; assert.equal(session.execution.name, s.execution.name); assert.equal(folder, s.folder); };
  await f.workbench.restore(s.id);
  assert.equal(launched, 1);
  assert.ok(f.calls.some(call => call.args.join(' ') === 'desktop start --timeout 60'));
  assert.ok(f.calls.some(call => call.args[0] === 'start' && call.args[1] === s.execution.name));
  assert.equal((await f.workbench.claim(s.id)).id, jobId);
  assert.equal(f.containers.size, 1);
});

test('a recreated container restores project dependencies while a stopped existing one preserves them', async () => {
  const f = await engine();
  const s = await create(f);
  await fs.writeFile(path.join(s.folder, 'package.json'), '{"name":"existing-app"}');
  await fs.writeFile(path.join(s.folder, 'package-lock.json'), '{}');
  f.containers.delete(s.execution.name);
  await f.workbench.ensureContainer(s);
  const installs = () => f.calls.filter(call => call.args[0] === 'exec' && JSON.parse(Buffer.from(call.args.at(-1), 'base64')).executable === 'npm');
  assert.deepEqual(JSON.parse(Buffer.from(installs()[0].args.at(-1), 'base64')).args, ['ci', '--no-audit', '--no-fund']);
  f.containers.get(s.execution.name).State.Running = false;
  await f.workbench.ensureContainer(s);
  assert.equal(installs().length, 1);
});

test('older Docker Desktop versions fall back to the desktop executable and concurrent restores share startup', async () => {
  let running = false, launches = 0;
  const docker = new DockerRuntime({ platform: 'win32', launchDesktop: async () => { launches++; running = true; }, execute: async (executable, args) => {
    if (args[0] === 'context') return '"npipe:////./pipe/docker_engine"';
    if (args[0] === 'info') { if (!running) throw new Error('Engine stopped'); return 'linux'; }
    if (args[0] === 'desktop') throw new Error('unknown flag: --timeout');
    throw new Error('Unexpected command');
  } });
  await Promise.all([docker.startDesktop(), docker.startDesktop()]);
  assert.equal(launches, 1);
  await docker.startDesktop();
  assert.equal(launches, 1);
});
