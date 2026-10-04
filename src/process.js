import { spawn } from 'node:child_process';

export function run(executable, args, { cwd, timeout = 300000, onOutput = () => {}, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, windowsHide: true, shell: false });
    let output = '';
    const timer = setTimeout(() => {
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
        killer.on('close', () => { if (child.exitCode === null) child.kill(); });
      } else child.kill('SIGTERM');
      reject(new Error(`${executable} timed out after ${timeout / 1000}s`));
    }, timeout);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {
      output = (output + data.toString()).slice(-200000);
      onOutput(data.toString());
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(`${executable} exited with ${code}\n${output.slice(-6000)}`));
    });
  });
}

// Launch the actual JS entry point instead of shell-interpolating a Windows .cmd file.
export async function npmCli() {
  const { existsSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const candidates = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')];
  const found = candidates.find(p => p && existsSync(p));
  if (!found) throw new Error('npm-cli.js not found. Start the server with npm start.');
  return found;
}

export async function openDashboard(url) {
  const address = new URL(url);
  if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1') throw new Error('Dashboard must use local HTTP');
  if (process.platform === 'win32') await run('rundll32.exe', ['url.dll,FileProtocolHandler', url], { timeout: 15000 });
}

export async function startDockerDesktop() {
  const { existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const executable = process.env.AIWORK_DOCKER_DESKTOP_EXE || [
    join(process.env.ProgramFiles || 'C:/Program Files', 'Docker/Docker/Docker Desktop.exe'),
    join(process.env.LOCALAPPDATA || '', 'Docker/Docker Desktop.exe')
  ].find(file => existsSync(file));
  if (!executable) throw new Error('Docker Desktop executable not found. Set AIWORK_DOCKER_DESKTOP_EXE to Docker Desktop.exe.');
  await new Promise((resolve, reject) => {
    const child = spawn(executable, [], { detached: true, windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

export async function prepareCodeArgs(folder, extensionPath, execution) {
  const { cp } = await import('node:fs/promises');
  const { join, resolve } = await import('node:path');
  const workspace = resolve(folder);
  const args = ['--new-window'];
  if (extensionPath) {
    // VS Code reloads an existing development host for the same extension path,
    // even with --new-window. A workspace-specific copy gives each its own host.
    const bridgePath = join(workspace, '.harness', execution?.backend === 'docker-linux' ? 'bridge-extension-remote' : 'bridge-extension');
    await cp(extensionPath, bridgePath, { recursive: true, force: true });
    args.push(`--extensionDevelopmentPath=${bridgePath}`);
  }
  if (execution?.backend === 'docker-linux') {
    const authority = `attached-container+${Buffer.from(JSON.stringify({ containerName: `/${execution.name}` })).toString('hex')}`;
    // Development hosts discard folders whose authority differs from the launch authority.
    return [...args, '--extensionDevelopmentKind=ui', '--remote', authority, '--folder-uri', `vscode-remote://${authority}${execution.workspacePath}`];
  }
  return [...args, workspace];
}

export async function openCode(folder, extensionPath, execution) {
  const { existsSync } = await import('node:fs');
  const { readFile } = await import('node:fs/promises');
  const { join, dirname, resolve } = await import('node:path');
  const executable = process.env.VSCODE_EXE || [
    join(process.env.LOCALAPPDATA || '', 'Programs/Microsoft VS Code/Code.exe'),
    join(process.env.ProgramFiles || 'C:/Program Files', 'Microsoft VS Code/Code.exe')
  ].find(p => existsSync(p));
  if (!executable) throw new Error('VS Code executable not found. Set VSCODE_EXE to Code.exe.');
  const installDir = dirname(executable);
  let cli = join(installDir, 'resources/app/out/cli.js');
  if (!existsSync(cli)) {
    // New VS Code installations place resources in a versioned subdirectory.
    const launcher = await readFile(join(installDir, 'bin/code.cmd'), 'utf8');
    const match = launcher.match(/"%~dp0([^"\r\n]+cli\.js)"/i);
    if (match) cli = resolve(installDir, 'bin', match[1]);
  }
  if (!existsSync(cli)) throw new Error('VS Code launcher could not be located. Open the workspace manually.');
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  // A server started from an extension host inherits its entry point and IPC
  // settings. The desktop launcher must start with its own environment.
  for (const key of Object.keys(env)) if (key.startsWith('VSCODE_')) delete env[key];
  if (execution?.backend === 'docker-linux') {
    const installed = await run(executable, [cli, '--list-extensions'], { timeout: 30000, env });
    if (!installed.split(/\r?\n/).some(name => name.trim().toLowerCase() === 'ms-vscode-remote.remote-containers')) {
      throw new Error('Install the VS Code Dev Containers extension (ms-vscode-remote.remote-containers), then use Open VS Code in the dashboard.');
    }
  }
  await run(executable, [cli, ...await prepareCodeArgs(folder, extensionPath, execution)], { timeout: 30000, env });
}
