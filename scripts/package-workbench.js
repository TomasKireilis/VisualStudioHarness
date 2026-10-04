import fs from 'node:fs/promises';
import path from 'node:path';
import { zipDirectory } from './zip.js';

const stage = path.resolve('.local', `bundle-${Date.now()}`);
await fs.mkdir(stage, { recursive: true });
// An allowlist keeps workspaces, dependencies, logs and local credentials out of the bundle.
for (const file of ['README.md', 'Start-Workbench.ps1', 'package.json', 'package-lock.json', '.dockerignore', '.gitignore', 'playwright.config.js']) {
  await fs.copyFile(file, path.join(stage, file));
}
for (const dir of ['src', 'public', 'extension', 'docker', 'templates', 'scripts', 'test']) {
  await fs.cp(dir, path.join(stage, dir), { recursive: true, filter: source => !source.split(path.sep).includes('node_modules') });
}
await fs.mkdir('dist', { recursive: true });
const destination = path.resolve('dist', 'ai-workbench-docker.zip');
await zipDirectory(stage, destination);
console.log(`Workbench bundle: ${destination}`);
