import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { startServer } from '../../src/server.js';
import { json } from '../../src/files.js';
import { run } from '../../src/process.js';
import { assessRisk } from '../../src/activity-risk.js';

let app, root;
test.beforeAll(async () => {
  await fs.mkdir('.local/browser-tests', { recursive: true });
  root = await fs.mkdtemp(path.resolve('.local/browser-tests/run-'));
  app = await startServer({ port: 0, root, autoOpen: false, createOnStart: false, provision: async s => {
    // Reuse the pinned test dependencies; no registry requests in browser tests.
    await fs.cp(path.resolve('node_modules'), path.join(s.folder, '.harness/demo/node_modules'), { recursive: true });
  } });
});
test.afterAll(async () => { await new Promise(resolve => app.server.close(resolve)); });

test('restore workspace reopens VS Code and retains the pending phase and request', async ({ page }) => {
  const workspace = await app.workbench.create();
  await app.workbench.locks.get(workspace.id);
  await app.workbench.brief(workspace.id, 'Recover this saved workspace');
  const session = app.workbench.get(workspace.id);
  const jobId = session.jobs[0].id;
  const launch = app.workbench.launch;
  const launched = [];
  app.workbench.launch = async folder => { launched.push(folder); };
  try {
    await page.goto(app.url);
    await page.locator(`.workspace[data-id="${workspace.id}"]`).click();
    await page.getByRole('button', { name: 'Restore workspace' }).click();
    await expect(page.locator('.restore-workspace')).toContainText('VS Code reopened');
    expect(launched).toEqual([workspace.folder]);
    expect(session.phase).toBe('requirements');
    expect(session.jobs).toHaveLength(1);
    expect(session.jobs[0].id).toBe(jobId);
    expect(session.jobs[0].status).toBe('queued');
  } finally {
    await app.workbench.restorations.get(workspace.id);
    app.workbench.launch = launch;
  }
});

test('requirements separate business and technical information and approve below the editor', async ({ page }) => {
  const workspace = await app.workbench.create();
  await app.workbench.locks.get(workspace.id);
  await app.workbench.brief(workspace.id, 'A greeting page');
  const job = await app.workbench.claim(workspace.id);
  await app.workbench.response(workspace.id, { jobId: job.id, kind: 'requirements_ready', requirements: '# Greeting page\n\n## Goal\nShow a greeting.\n\n## Acceptance criteria\nTyping hello shows hello.\n\n## Implementation Plan\nCreate index.html.\n\n## Technologies\nHTML and JavaScript.', assessment: { feasible: true, evidence: 'Browser check passed.', steps: ['Build the page'], technologies: ['HTML'], codeImpact: ['New page'] } });
  await page.goto(app.url);
  await page.locator(`[data-id="${workspace.id}"]`).click();
  await expect(page.getByRole('heading', { name: 'Business requirements' })).toBeVisible();
  const editor = page.getByLabel('REQUIREMENTS.md', { exact: true });
  await expect(editor).toHaveValue(/Typing hello/);
  await expect(editor).not.toHaveValue(/index.html/);
  expect((await editor.boundingBox()).height).toBeGreaterThanOrEqual(500);
  const approval = page.getByRole('button', { name: 'Approve & start development' });
  const box = await editor.boundingBox();
  expect((await approval.boundingBox()).y).toBeGreaterThanOrEqual(box.y + box.height);
  await page.getByText('Technical details', { exact: true }).click();
  await expect(page.getByLabel('Technical requirements')).toHaveValue(/index.html/);
  await editor.fill('# Business requirements\n\nShow a friendly greeting.');
  await approval.click();
  await expect(page.getByRole('heading', { name: 'Building your solution' })).toBeVisible();
  expect(app.workbench.get(workspace.id).requirements).toContain('Show a friendly greeting.');
  expect(app.workbench.get(workspace.id).requirements).toContain('Create index.html.');
  await page.locator('[data-phase="requirements"]').click();
  await expect(page.getByRole('heading', { name: 'Business requirements' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve & start development' })).toHaveCount(0);
});

test('preparation has its own stage, retries failures and locks on completion', async ({ page }) => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const provision = app.workbench.provision;
  app.workbench.provision = async () => { await pending; throw new Error('Browser setup interrupted'); };
  let workspace;
  try {
    await page.goto(app.url);
    await page.getByRole('button', { name: 'New workspace' }).click();
    await expect(page.locator('#phase-label')).toHaveText('STEP 01 / PREPARATION');
    await expect(page.locator('[data-phase="preparation"] .spinner')).toBeVisible();
    workspace = [...app.workbench.sessions.values()].at(-1);
    await expect(page.locator('[data-phase="requirements"]')).toBeDisabled();
    await expect(page.getByLabel('Describe your project')).toHaveCount(0);
    release();
    await expect(page.getByRole('button', { name: 'Retry environment setup' })).toBeVisible();
    app.workbench.provision = async () => {};
    await page.getByRole('button', { name: 'Retry environment setup' }).click();
    await expect(page.getByLabel('Describe your project')).toBeVisible();
    await expect(page.locator('#phase-label')).toHaveText('STEP 02 / REQUIREMENTS');
    await expect(page.locator('[data-phase="preparation"]')).toContainText('🔒');
    await page.reload();
    await page.locator('[data-phase="preparation"]').click();
    await expect(page.getByRole('heading', { name: 'Environment ready · locked' })).toBeVisible();
    const response = await page.request.post(`${app.url}/api/sessions/${workspace.id}/setup`, { headers: { 'X-Workbench-Token': app.uiToken }, data: {} });
    expect(response.ok()).toBe(false);
    expect(workspace.phase).toBe('requirements');
  } finally {
    release();
    if (workspace) await app.workbench.locks.get(workspace.id);
    app.workbench.provision = provision;
  }
});
test('guided requirements, development, real Playwright video and artifact review', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url);
  await page.getByRole('button', { name: 'New workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Start with your idea' })).toBeVisible();
  await expect(page.getByLabel('Describe your project')).toBeVisible();
  await page.screenshot({ path: '.local/dashboard-desktop.png', fullPage: true });
  const s = [...app.workbench.sessions.values()].at(-1);
  await expect(page.locator('[data-phase="preparation"]')).toContainText('🔒');
  await page.locator('[data-phase="preparation"]').click();
  await expect(page.getByRole('heading', { name: 'Environment ready · locked' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry environment setup' })).toHaveCount(0);
  await expect(page.locator('#rollback-controls')).toBeEmpty();
  await page.locator('[data-phase="requirements"]').click();
  await expect(page.getByRole('button', { name: 'Automatic chat: On' })).toBeVisible();
  await page.getByRole('button', { name: 'Automatic chat: On' }).click();
  await expect(page.getByRole('button', { name: 'Automatic chat: Off' })).toBeVisible();
  expect(s.autoSubmit).toBe(false);
  await page.getByRole('button', { name: 'Automatic chat: Off' }).click();
  const terminalEnv = { ...process.env }; delete terminalEnv.PLAYWRIGHT_BROWSERS_PATH;
  const browserCheck = await run(process.execPath, [path.join(s.folder, '.harness/demo/check.mjs')], { cwd: s.folder, env: terminalEnv, timeout: 30000 });
  expect(JSON.parse(browserCheck.split(/\r?\n/).find(line => line.startsWith('{"ok":'))).ok).toBe(true);
  await page.getByLabel('Describe your project').fill('Build a project tracker for our team');
  await page.getByRole('button', { name: 'Start the conversation' }).click();
  let job = await app.workbench.claim(s.id);
  await app.workbench.response(s.id, { jobId: job.id, kind: 'questions', message: 'A couple of decisions first.', questions: ['What fields should a project have?', 'Who can create a project?'] });
  await expect(page.getByLabel('1. What fields should a project have?')).toBeVisible();
  await page.getByLabel('1. What fields should a project have?').fill('A title and status.');
  await page.getByRole('button', { name: 'Send & continue' }).click();
  expect(s.status).toBe('awaiting_human');
  await page.waitForTimeout(2200);
  await expect(page.getByLabel('1. What fields should a project have?')).toHaveValue('A title and status.');
  await page.getByLabel('2. Who can create a project?').fill('Everyone on the team.');
  await page.getByRole('button', { name: 'Send & continue' }).click();
  await expect(page.locator('#status')).toHaveText('Waiting for VS Code');
  expect(s.messages.at(-1).text).toBe('Question 1: What fields should a project have?\nAnswer: A title and status.\n\nQuestion 2: Who can create a project?\nAnswer: Everyone on the team.');
  job = await app.workbench.claim(s.id);
  await app.workbench.response(s.id, { jobId: job.id, kind: 'requirements_ready', assessment: { feasible: true, evidence: 'Inspected fixture runtime and source', steps: ['Implement and validate'], technologies: ['Node.js'], codeImpact: ['Add fixture source'] }, requirements: '# Project tracker\n\nCreate projects with a title and status.\n\nAcceptance: team members can add a project and see it on the page.' });
  await expect(page.getByLabel('REQUIREMENTS.md')).toBeVisible();
  await page.getByLabel('REQUIREMENTS.md').fill('# Project tracker\n\nAll team members can create projects. Include title, status and owner.');
  await page.getByRole('button', { name: 'Approve & start development' }).click();
  await expect(page.getByRole('heading', { name: 'Building your solution' })).toBeVisible();
  job = await app.workbench.claim(s.id);
  assertJob(job);
  await expect(page.locator('#workspace-content')).not.toContainText('A couple of decisions first.');
  await page.locator('[data-phase="requirements"]').click();
  await expect(page.locator('#workspace-content')).toContainText('A couple of decisions first.');
  await expect(page.locator('[data-phase="development"] .spinner')).toBeVisible();
  await page.waitForTimeout(2200);
  expect(s.phase).toBe('development');
  expect(job.status).toBe('dispatched');
  await expect(page.locator('.activity-panel')).toBeVisible();
  await page.locator('[data-phase="development"]').click();

  await app.workbench.progress(s.id, { jobId: job.id, text: 'Building project creation and checking validation.' });
  app.workbench.activity.state(s).runs.at(-1).due = 0;
  await expect(page.locator('#summaries')).toContainText('Building project creation');
  await app.workbench.progress(s.id, { jobId: job.id, text: 'Checking the finished project form.' });
  app.workbench.activity.state(s).runs.at(-1).due = 0;
  await expect(page.locator('#summaries')).toContainText('Checking the finished');
  await expect(page.locator('#summaries')).toContainText('Building project creation');
  await expect(page.locator('#summaries .risk-grade').first()).toContainText('Risk A');
  await page.reload();
  await expect(page.locator('#summaries')).toContainText('Building project creation');

  const portServer = net.createServer(); await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
  const port = portServer.address().port; await new Promise(resolve => portServer.close(resolve));
  const html = `<!doctype html><html><head><title>Project tracker</title></head><body style="font:20px Segoe UI;padding:50px;background:#f5f8ee"><h1>Project tracker</h1><main><label>Title <input name="title"></label><button onclick="document.querySelector('section').textContent=document.querySelector('input').value">Add project</button><section></section></main></body></html>`;
  await fs.writeFile(path.join(s.folder, 'app.cjs'), `const http = require('node:http'); http.createServer((req, res) => { res.setHeader('Content-Type','text/html'); res.end(${JSON.stringify(html)}); }).listen(${port}, '127.0.0.1');`);
  // Separate UI source also exercises automatic UI-change detection.
  await fs.writeFile(path.join(s.folder, 'style.css'), 'body { color: #305c40; }');
  await json(path.join(s.folder, '.harness/demo/config.json'), {
    url: `http://127.0.0.1:${port}`, start: { command: process.execPath, args: ['app.cjs'] },
    steps: [{ action: 'goto', path: '/' }, { action: 'fill', selector: 'input[name=title]', value: 'Launch plan' }, { action: 'click', selector: 'button' }, { action: 'expect', selector: 'section', text: 'Launch plan' }, { action: 'screenshot', name: 'created-project' }]
  });
  await app.workbench.response(s.id, { jobId: job.id, kind: 'development_complete', message: 'Project creation implemented.', uiChanged: false, impact: [{ file: 'app.cjs', description: 'Local project tracker demo' }], tests: ['Browser demo will validate project creation.'] });
  await expect.poll(() => s.status, { timeout: 60000 }).toBe('complete');
  expect(s.phase).toBe('demo');
  expect(await app.workbench.claim(s.id)).toBeNull();
  await expect(page.locator('#status')).toHaveText('Ready for your approval');
  await expect(page.locator('#workspace-content')).not.toContainText('A couple of decisions first.');
  await page.locator('[data-phase="development"]').click();
  await expect(page.locator('#workspace-content')).toContainText('Project creation implemented.');
  expect(s.phase).toBe('demo');
  await page.locator('[data-phase="demo"]').click();
  const video = page.locator('video'); await expect(video).toBeVisible();
  await expect.poll(() => video.evaluate(el => el.readyState)).toBeGreaterThan(0);
  const videoFile = s.artifacts.find(f => f.endsWith('walkthrough.webm'));
  expect((await fs.stat(path.join(s.folder, videoFile))).size).toBeGreaterThan(1000);
  await expect(page.getByRole('heading', { name: 'AI summary', exact: true })).toBeVisible();
  await expect(page.locator('#workspace-content')).toContainText('Project creation implemented.');
  await expect(page.locator('.artifact')).toHaveCount(0);
  await expect(page.getByText('Read the change report', { exact: true })).toHaveCount(0);
  expect((await fs.readFile(path.join(s.folder, 'artifacts/impact.md'), 'utf8'))).toContain('Local project tracker demo');
  await page.getByRole('button', { name: 'Approve result & start PR review' }).click();
  await expect(page.getByRole('heading', { name: 'Checking features and code quality' })).toBeVisible();
  expect(s.resultApprovedAt).toBeTruthy();
  const checks = Object.fromEntries(['features', 'readability', 'formatting', 'tests', 'architecture'].map(key => [key, { passed: true, evidence: `Checked ${key}` }]));
  job = await app.workbench.claim(s.id);
  expect(job.kind).toBe('pr_review');
  await app.workbench.response(s.id, { jobId: job.id, kind: 'pr_review_complete', message: 'One issue needs fixing.', findings: ['Reject empty project titles in app.cjs'], checks, tests: ['Fixture review checks passed'] });
  await expect(page.locator('[data-phase="refactoring"] .spinner')).toBeVisible();
  await page.locator('[data-phase="refactoring"]').click();
  await expect(page.locator('#workspace-content')).toContainText('Reject empty project titles');
  job = await app.workbench.claim(s.id);
  expect(job.kind).toBe('refactoring');
  await app.workbench.response(s.id, { jobId: job.id, kind: 'refactoring_complete', message: 'Cleaned up validation.', addressedFindings: ['Empty titles now rejected'], uiChanged: false, impact: [], tests: ['Fixture validation passed'] });
  await expect(page.locator('[data-phase="pr_review"] .spinner')).toBeVisible();
  await page.locator('[data-phase="pr_review"]').click();
  await expect(page.locator('#workspace-content')).toContainText('PR review 1');
  job = await app.workbench.claim(s.id);
  await app.workbench.response(s.id, { jobId: job.id, kind: 'pr_review_complete', message: 'All checks passed.', findings: [], checks, tests: ['Fixture checks passed'] });
  await expect(page.locator('#status')).toHaveText('Ready for human PR');
  await page.locator('[data-phase="handoff"]').click();
  await expect(page.locator('#workspace-content')).toContainText('Git push and human PR will be added here later.');
  expect(await app.workbench.claim(s.id)).toBeNull();
  await page.screenshot({ path: '.local/dashboard-complete.png', fullPage: true });
  const range = await fetch(`${app.url}/api/sessions/${s.id}/file?path=${encodeURIComponent(videoFile)}`, { headers: { 'X-Workbench-Token': app.uiToken, Range: 'bytes=0-99' } });
  expect(range.status).toBe(206); expect((await range.arrayBuffer()).byteLength).toBe(100);
  await page.locator('[data-phase="development"]').click();
  await page.getByText('Return to previous step', { exact: true }).click();
  await page.getByLabel('Bug or question to resolve').fill('Empty titles should be rejected');
  await page.getByRole('button', { name: 'Return & continue' }).click();
  await expect(page.getByRole('heading', { name: 'Building your solution' })).toBeVisible();
  expect(s.rollbacks.at(-1).reason).toBe('Empty titles should be rejected');
  expect(errors).toEqual([]);
});
function assertJob(job) { expect(job.kind).toBe('development'); }

test('recorder sends focused repeated keyboard inputs and keeps a readable recording', async () => {
  const workspace = await app.workbench.create(); await app.workbench.locks.get(workspace.id);
  const html = `<!doctype html><canvas tabindex="0"></canvas><p id="state">Ready</p><script>
    let count = 0, releases = 0, previous = 0;
    const canvas = document.querySelector('canvas');
    canvas.addEventListener('keydown', event => {
      if (event.code !== 'Space' || !event.isTrusted || (previous && performance.now() - previous < 80)) return;
      previous = performance.now(); count++;
      canvas.getContext('2d').fillRect(count * 20, 20, 10, 10);
    });
    canvas.addEventListener('keyup', event => {
      if (event.code === 'Space' && event.isTrusted) releases++;
      document.querySelector('#state').textContent = 'Flaps: ' + count + ', releases: ' + releases;
    });
  </script>`;
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const dir = path.join(workspace.folder, '.harness/demo');
    const config = { url: `http://127.0.0.1:${server.address().port}`, start: null, steps: [
      { action: 'goto' }, { action: 'screenshot', name: 'ready' },
      { action: 'click', selector: 'canvas', position: { x: 10, y: 10 } },
      { action: 'press', selector: 'canvas', key: 'Space', repeat: 4, intervalMs: 120 },
      { action: 'expect', selector: '#state', text: 'Flaps: 4, releases: 4' },
      { action: 'screenshot', name: 'playing' }
    ] };
    await json(path.join(dir, 'config.json'), config);
    // A retry upgrades the recorder in an existing workspace without replacing its steps.
    await fs.writeFile(path.join(dir, 'record.mjs'), 'throw new Error("old recorder");');
    await app.workbench.configureBrowser(workspace);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'))).toEqual(config);
    const output = await run(process.execPath, [path.join(dir, 'record.mjs')], { cwd: workspace.folder, timeout: 45000 });
    const result = JSON.parse(output.split(/\r?\n/).find(line => line.startsWith('{"ok":')));
    expect(result.ok).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(15000);
    expect(result.steps).toEqual(config.steps);
    for (const name of ['ready.png', 'playing.png', 'walkthrough.webm', 'trace.zip']) expect((await fs.stat(path.join(result.output, name))).size).toBeGreaterThan(0);
    config.steps = [{ action: 'goto' }, { action: 'press', key: 'Space', repeat: 0 }];
    await json(path.join(dir, 'config.json'), config);
    await expect(run(process.execPath, [path.join(dir, 'record.mjs')], { cwd: workspace.folder, timeout: 30000 })).rejects.toThrow(/press.repeat/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('dashboard renews expired tokens and preserves the form draft', async ({ page }) => {
  await page.route(`${app.url}/`, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace(app.uiToken, 'expired-token') });
    await page.unroute(`${app.url}/`);
  });
  await page.goto(app.url);
  await page.getByRole('button', { name: 'New workspace' }).click();
  await expect(page.getByRole('button', { name: 'New workspace' })).toBeEnabled();
  await page.getByLabel('Describe your project').fill('Retain this draft after reconnecting');
  let rejected = false;
  await page.route(`${app.url}/api/sessions`, async route => {
    if (!rejected && route.request().method() === 'GET') {
      rejected = true;
      await route.fulfill({ status: 401, json: { error: 'Refresh the dashboard to reconnect' } });
    } else await route.continue();
  });
  await expect.poll(() => rejected).toBe(true);
  await expect(page.getByLabel('Describe your project')).toHaveValue('Retain this draft after reconnecting');
  await expect(page.locator('#updated')).not.toContainText('Server unavailable');
});

test('risk C through F display the reported trigger safely in activity history', async ({ page }) => {
  const workspace = await app.workbench.create(); await app.workbench.locks.get(workspace.id);
  const evidence = ['POST /items/<script>alert(1)</script> returned 201', 'Installed a global dependency', 'Performed privilege escalation', 'Deleted backups'];
  app.workbench.activity.state(workspace).summaries = evidence.map((text, index) => ({
    runId: `risk-${index}`, phase: 'development', time: new Date().toISOString(),
    text: 'Checked reported activity.', risk: assessRisk([{ type: 'tool', text }])
  }));
  await page.goto(app.url);
  await page.locator(`[data-id="${workspace.id}"]`).click();
  for (const [index, grade] of ['C', 'D', 'E', 'F'].entries()) {
    const entry = page.locator('#summaries li').filter({ has: page.locator(`.risk-${grade}`) });
    await expect(entry.locator('.risk-detections')).toContainText(evidence[index]);
    await expect(entry.locator('.risk-detections')).toContainText('Detected in reported activity');
  }
  await expect(page.locator('#summaries script')).toHaveCount(0);
});
test('mobile layout remains usable and form drafts survive polling', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(app.url);
  await page.getByRole('button', { name: 'New workspace' }).click();
  await expect(page.getByRole('button', { name: 'New workspace' })).toBeEnabled();
  await page.getByLabel('Describe your project').fill('Keep my draft while the dashboard refreshes');
  await page.waitForTimeout(2500);
  await expect(page.getByLabel('Describe your project')).toHaveValue('Keep my draft while the dashboard refreshes');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/dashboard-mobile.png', fullPage: true });
});
test('workspace deletion confirms, cancels, removes the folder and clears the final selection', async ({ page }) => {
  const disposable = await app.workbench.create(); await app.workbench.locks.get(disposable.id);
  await page.goto(app.url);
  const deletion = page.locator(`[data-delete="${disposable.id}"]`);
  page.once('dialog', async dialog => { expect(dialog.message()).toContain(disposable.folder); await dialog.dismiss(); });
  await deletion.click();
  expect((await fs.stat(disposable.folder)).isDirectory()).toBe(true);
  page.once('dialog', dialog => dialog.accept());
  await deletion.click();
  await expect(deletion).toHaveCount(0);
  await expect.poll(async () => { try { await fs.stat(disposable.folder); return true; } catch { return false; } }).toBe(false);
  // These are isolated test workspaces, never user projects.
  for (const s of [...app.workbench.sessions.values()]) await app.workbench.remove(s.id, s.id);
  await expect(page.getByRole('heading', { name: 'Create your first workspace' })).toBeVisible();
  await expect(page.locator('#folder-name')).toHaveText('No workspace selected');
  await expect(page.getByRole('button', { name: 'Open VS Code' })).toBeDisabled();
});
