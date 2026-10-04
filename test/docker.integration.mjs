import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Workbench } from '../src/workbench.js';
import { json, readJson } from '../src/files.js';

await fs.mkdir('.local/docker-smoke', { recursive: true });
const root = await fs.mkdtemp(path.resolve('.local/docker-smoke/run-'));
const workbench = new Workbench({ root, url: 'http://127.0.0.1:4310', autoOpen: false });
const view = await workbench.create();
await workbench.locks.get(view.id);
const session = workbench.get(view.id);
if (!session.demoReady) throw new Error(`Container preparation failed: ${session.error}\nSetup log: ${session.folder}/.harness/setup.log`);
try {
  await fs.writeFile(path.join(session.folder, 'app.mjs'), `import http from 'node:http';
http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<main><button onclick="this.textContent=\\'Clicked\\'">Click me</button></main>'); }).listen(3000, '127.0.0.1');
`);
  await json(path.join(session.folder, 'package.json'), { private: true, scripts: { dev: 'node app.mjs' } });
  await json(path.join(session.folder, '.harness/demo/config.json'), { url: 'http://127.0.0.1:3000',
    start: { command: 'npm', args: ['run', 'dev'] }, minimumDurationMs: 0,
    steps: [{ action: 'goto', path: '/' }, { action: 'click', selector: 'button' },
      { action: 'expect', selector: 'button', text: 'Clicked' }, { action: 'screenshot', name: 'clicked' }] });
  session.phase = 'demo'; session.status = 'demo_pending'; session.uiChanged = true;
  await workbench.demo(session.id);
  assert.equal(session.status, 'complete', session.error);
  const video = session.artifacts.find(file => file.endsWith('/walkthrough.webm'));
  assert.ok(video, 'Recording must be visible in the Windows workspace');
  assert.ok((await fs.stat(path.join(session.folder, video))).size > 0);
  const result = session.artifacts.find(file => file.endsWith('/result.json'));
  assert.equal((await readJson(path.join(session.folder, result))).ok, true);
  console.log('Docker workspace, Chromium, interactive demo and host-visible artifacts passed.');
} finally {
  await workbench.remove(session.id, session.id);
}
