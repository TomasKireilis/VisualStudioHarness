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

export async function openCode(folder, extensionPath) {
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
  await run(executable, [cli, '--new-window', ...(extensionPath ? [`--extensionDevelopmentPath=${extensionPath}`] : []), folder], { timeout: 30000, env });
}
