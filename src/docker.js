import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { run, startDockerDesktop } from './process.js';
import { json } from './files.js';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const containerRoot = '/workspace';
export const containerCache = '/ms-playwright';
const label = 'aiwork.workspace', ownerLabel = 'aiwork.owner';
function mountMatches(source, folder) {
  const normalize = value => value.replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
  const expected = normalize(path.resolve(folder));
  const actual = normalize(source || '');
  if (actual === expected) return true;
  const windows = expected.match(/^([a-z]):\/(.*)$/);
  return Boolean(windows && ['/run/desktop/mnt/host', '/host_mnt', '/mnt'].some(prefix => actual === `${prefix}/${windows[1]}/${windows[2]}`));
}

export class DockerRuntime {
  constructor({ execute = run, executable = process.env.AIWORK_DOCKER_EXE || 'docker',
    image = process.env.AIWORK_DOCKER_IMAGE || 'aiwork-linux:node22-playwright1.58.2', platform = process.platform, launchDesktop = startDockerDesktop } = {}) {
    this.execute = execute; this.executable = executable; this.image = image; this.builds = new Map();
    this.platform = platform;
    this.launchDesktop = launchDesktop;
  }
  async startDesktop() {
    if (this.desktopStart) return this.desktopStart;
    this.desktopStart = (async () => {
      try { await this.checkLocal(); return; }
      catch (error) {
        if (this.platform !== 'win32' || /local Docker engine is required|not using Linux containers/.test(error.message)) throw error;
      }
      try {
        try { await this.command(['desktop', 'start', '--timeout', '60'], { timeout: 65000 }); }
        catch (error) {
          if (!/unknown (flag|command)|not a docker command/i.test(error.message)) throw error;
          // Older Docker Desktop installations do not provide the Desktop CLI.
          await this.launchDesktop();
          const deadline = Date.now() + 60000;
          while (true) {
            try { await this.checkLocal(); break; }
            catch (error) { if (Date.now() >= deadline || /local Docker engine is required|not using Linux containers/.test(error.message)) throw error; }
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }
        await this.checkLocal();
      } catch (error) {
        throw new Error(`Docker Desktop could not be started: ${error.message}. Start Docker Desktop in Linux containers mode, then restore the workspace again.`);
      }
    })().finally(() => { this.desktopStart = null; });
    return this.desktopStart;
  }
  spec(session) {
    if (!/^work-\d{4}-\d{2}-\d{2}-[a-f0-9]{8}$/.test(session.id)) throw new Error('Invalid container workspace ID');
    return { backend: 'docker-linux', name: `aiwork-${session.id}`, image: session.execution?.image || this.image,
      workspacePath: containerRoot, browsersPath: containerCache };
  }
  owner(session) { return crypto.createHash('sha256').update(path.resolve(session.folder)).digest('hex'); }
  command(args, options) { return this.execute(this.executable, args, options); }
  async checkLocal(onOutput = () => {}) {
    const endpoint = process.env.DOCKER_HOST || JSON.parse(await this.command(['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'], { timeout: 15000 }));
    if (typeof endpoint !== 'string' || !/^(npipe|unix):\/\//.test(endpoint)) throw new Error('A local Docker engine is required. Remote Docker contexts are not supported.');
    const os = (await this.command(['info', '--format', '{{.OSType}}'], { timeout: 30000 })).trim();
    if (os !== 'linux') throw new Error('Docker is not using Linux containers. Switch Docker Desktop to Linux containers and retry setup.');
    onOutput('Connected to the local Linux Docker engine.\n');
  }
  async ensureImage(image, onOutput) {
    if (!this.builds.has(image)) {
      const building = (async () => {
        const images = await this.command(['image', 'ls', '--quiet', image], { timeout: 30000 });
        if (images.trim()) return;
        onOutput(`Building ${image}. The first image download can take several minutes.\n`);
        await this.command(['build', '--tag', image, '--file', path.join(project, 'docker/Dockerfile'), project], { timeout: 1800000, onOutput });
      })().finally(() => { this.builds.delete(image); });
      this.builds.set(image, building);
    }
    await this.builds.get(image);
  }
  async inspect(session) {
    const spec = this.spec(session);
    const found = await this.command(['container', 'ls', '--all', '--filter', `name=^/${spec.name}$`, '--format', '{{.ID}}'], { timeout: 30000 });
    if (!found.trim()) return null;
    const info = JSON.parse(await this.command(['inspect', spec.name], { timeout: 30000 }))[0];
    const mount = info?.Mounts?.find(m => m.Type === 'bind' && m.Destination === containerRoot);
    // Docker Desktop translates Windows mount sources to Linux VM paths.
    // The ownership label includes the exact host workspace path.
    if (info?.Config?.Labels?.[label] !== session.id || info.Config.Labels[ownerLabel] !== this.owner(session) || !mount || !mount.RW || !mountMatches(mount.Source, session.folder)) {
      throw new Error(`Refusing to use or remove ${spec.name}: container ownership or workspace mount does not match.`);
    }
    return info;
  }
  async ensure(session, onOutput = () => {}) {
    await this.checkLocal(onOutput);
    const spec = this.spec(session);
    const existing = await this.inspect(session);
    if (existing) {
      if (!existing.State.Running) await this.command(['start', spec.name], { timeout: 60000, onOutput });
      return { created: false };
    }
    await this.ensureImage(spec.image, onOutput);
    if (session.folder.includes(',')) throw new Error('Docker workspace paths cannot contain commas. Choose a different AIWORK_ROOT.');
    await this.command(['run', '--detach', '--init', '--shm-size', '1g', '--name', spec.name,
      '--label', `${label}=${session.id}`, '--label', `${ownerLabel}=${this.owner(session)}`,
      '--mount', `type=bind,source=${session.folder},target=${containerRoot}`,
      '--mount', 'type=volume,target=/workspace/node_modules',
      '--mount', 'type=volume,target=/workspace/.harness/demo/node_modules',
      '--workdir', containerRoot, spec.image], { timeout: 120000, onOutput });
    return { created: true };
  }
  async configure(session) {
    const spec = this.spec(session);
    await json(path.join(session.folder, '.harness/container.json'), { ...spec, executable: this.executable });
    await fs.cp(path.join(project, 'templates/container'), path.join(session.folder, '.harness/container'), { recursive: true });
  }
  async exec(session, executable, args, { timeout = 180000, onOutput = () => {}, cwd = containerRoot } = {}) {
    const spec = this.spec(session);
    const payload = Buffer.from(JSON.stringify({ executable, args, timeout })).toString('base64');
    return this.command(['exec', '--workdir', cwd, spec.name, 'node', '/opt/aiwork/exec.mjs', payload], { timeout: timeout + 20000, onOutput });
  }
  async provision(session, onOutput) {
    await this.ensure(session, onOutput);
    await this.configure(session);
    await this.exec(session, 'node', ['/opt/aiwork/prepare.mjs'], { timeout: 120000, onOutput });
    await this.exec(session, 'node', ['.harness/demo/check.mjs'], { timeout: 30000, onOutput });
    onOutput('Linux container, Playwright, Chromium and video recording are ready.\n');
  }
  async remove(session) {
    await this.checkLocal();
    if (await this.inspect(session)) await this.command(['rm', '--force', '--volumes', this.spec(session).name], { timeout: 60000 });
  }
}
