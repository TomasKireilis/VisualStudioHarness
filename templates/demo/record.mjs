import { chromium } from './browser.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const config = JSON.parse(await fs.readFile(path.join(here, 'config.json'), 'utf8'));
const local = value => {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Demo URLs must use localhost');
  return url;
};
const base = local(config.url);
const output = path.join(root, 'artifacts', `demo-${Date.now()}`);
await fs.mkdir(output, { recursive: true });
let app, browser, context, video;
let result = { ok: false, steps: [], output };
const log = await fs.open(path.join(output, 'app.log'), 'w');
try {
  if (config.start) {
    let command = config.start.command;
    let args = config.start.args || [];
    // npm.cmd cannot be spawned directly on Windows without a shell.
    if (command === 'npm') {
      const npm = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
      command = process.execPath;
      args = [npm, ...args];
    }
    if (typeof command !== 'string' || !Array.isArray(args) || args.some(x => typeof x !== 'string')) throw new Error('Invalid app start command');
    app = spawn(command, args, { cwd: root, shell: false, windowsHide: true, stdio: ['ignore', log.fd, log.fd] });
    let spawnError;
    app.on('error', error => { spawnError = error; });
    const deadline = Date.now() + 60000;
    let ready = false;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (app.exitCode !== null) throw new Error('App exited before demo; see app.log');
      try { const response = await fetch(base, { signal: AbortSignal.timeout(1500) }); ready = response.ok; } catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!ready) throw new Error('App did not become ready within 60 seconds');
  }
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: output, size: { width: 1440, height: 900 } } });
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  video = page.video();
  if (!Array.isArray(config.steps) || !config.steps.length) throw new Error('Demo requires at least one step');
  for (const step of config.steps) {
    switch (step.action) {
      case 'goto': await page.goto(local(new URL(step.path || '/', base).href).href, { waitUntil: 'domcontentloaded' }); break;
      case 'click': await page.locator(step.selector).click(); break;
      case 'fill': await page.locator(step.selector).fill(step.value); break;
      case 'expect': {
        const locator = page.locator(step.selector);
        await locator.waitFor({ state: 'visible' });
        if (step.text && !(await locator.innerText()).includes(step.text)) throw new Error(`Expected text missing: ${step.text}`);
        break;
      }
      case 'screenshot': await page.screenshot({ path: path.join(output, `${String(step.name || 'screen').replace(/[^a-z0-9_-]/gi, '_')}.png`), fullPage: true }); break;
      case 'wait': await page.waitForTimeout(Math.min(Math.max(Number(step.milliseconds) || 0, 0), 10000)); break;
      default: throw new Error(`Unknown demo action: ${step.action}`);
    }
    result.steps.push(step);
    await page.waitForTimeout(350);
  }
  result.ok = true;
} catch (error) {
  result.error = error.message;
  process.exitCode = 1;
} finally {
  if (context) {
    await context.tracing.stop({ path: path.join(output, 'trace.zip') }).catch(() => {});
    await context.close();
    if (video) { await video.saveAs(path.join(output, 'walkthrough.webm')); await video.delete(); }
  }
  await browser?.close();
  if (app?.pid) {
    if (process.platform === 'win32') {
      const killed = await new Promise(resolve => {
        const killer = spawn('taskkill', ['/PID', String(app.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        const timer = setTimeout(() => { killer.kill(); resolve(false); }, 10000);
        killer.on('close', code => { clearTimeout(timer); resolve(code === 0); });
        killer.on('error', () => { clearTimeout(timer); resolve(false); });
      });
      if (!killed && app.exitCode === null) {
        app.kill();
        result.cleanupWarning = 'Windows denied process-tree cleanup. The direct app process was stopped; check for child processes.';
      }
    } else app.kill('SIGTERM');
    app.unref();
  }
  await log.close();
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
