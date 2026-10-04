// Run from the host: node .harness/container/run.mjs npm test
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
const config = JSON.parse(await fs.readFile(new URL('../container.json', import.meta.url), 'utf8'));
const [executable, ...args] = process.argv.slice(2);
if (!executable) throw new Error('Usage: node .harness/container/run.mjs <executable> [arguments...]');
const payload = Buffer.from(JSON.stringify({ executable, args, timeout: 300000 })).toString('base64');
const child = spawn(config.executable, ['exec', '--workdir', config.workspacePath, config.name, 'node', '/opt/aiwork/exec.mjs', payload], { shell: false, windowsHide: true, stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('close', code => { process.exitCode = code ?? 1; });
