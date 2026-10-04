import { spawn } from 'node:child_process';
const { executable, args, timeout } = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
if (typeof executable !== 'string' || !executable || !Array.isArray(args) || args.some(x => typeof x !== 'string')
  || !Number.isFinite(timeout) || timeout < 1 || timeout > 1800000) throw new Error('Invalid container command');
const child = spawn(executable, args, { shell: false, detached: true, stdio: 'inherit' });
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  console.error(`Container command timed out after ${timeout / 1000}s`);
  try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}, timeout);
child.on('error', error => { clearTimeout(timer); console.error(error.message); process.exitCode = 1; });
child.on('close', code => { clearTimeout(timer); process.exitCode = timedOut ? 124 : code ?? 1; });
