import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { json, readJson, snapshot, changes, impactMarkdown } from './files.js';
import { run, npmCli, openCode } from './process.js';
import { ActivityService } from './activity.js';
import { makePrompt } from './prompts.js';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const now = () => new Date().toISOString();
export class Workbench {
  constructor({ root, url, autoOpen = true, provision, launch = openCode }) {
    this.root = path.resolve(root);
    this.url = url;
    this.autoOpen = autoOpen;
    this.provision = provision || this.installDemo.bind(this);
    this.launch = launch;
    this.sessions = new Map();
    this.locks = new Map();
    this.saves = new Map();
    this.activity = new ActivityService();
  }
  async exclusive(id, action) {
    const previous = this.locks.get(id) || Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    this.locks.set(id, next);
    try { return await next; } finally { if (this.locks.get(id) === next) this.locks.delete(id); }
  }
  get(id) {
    const session = this.sessions.get(id);
    if (!session) throw Object.assign(new Error('Workspace not found'), { status: 404 });
    return session;
  }
  async remove(id, confirmation) {
    const check = session => {
      if (confirmation !== session.id) throw new Error('Workspace deletion requires its exact ID');
      if (this.locks.has(id) || ['setting_up', 'recording', 'demo_pending', 'agent_working'].includes(session.status) || session.jobs.some(j => j.status === 'dispatched')) {
        throw Object.assign(new Error('This workspace has active work. Finish the running request before deleting it.'), { status: 409 });
      }
    };
    check(this.get(id));
    return this.exclusive(id, async () => {
      const session = this.get(id);
      const target = path.resolve(session.folder);
      if (!/^work-\d{4}-\d{2}-\d{2}-[a-f0-9]{8}$/.test(id) || path.dirname(target) !== this.root || path.basename(target) !== id) throw new Error('Refusing to delete outside the workspace root');
      const stat = await fs.lstat(target);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Refusing to delete a linked workspace');
      const realRoot = await fs.realpath(this.root), realTarget = await fs.realpath(target);
      if (path.dirname(realTarget) !== realRoot) throw new Error('Resolved workspace is outside its root');
      this.activity.removing.add(id);
      try {
        await this.saves.get(id);
        await this.activity.writes.get(id);
        await fs.rm(target, { recursive: true, maxRetries: 2, retryDelay: 200 });
      } catch (error) { this.activity.removing.delete(id); throw error; }
      this.activity.writes.delete(id);
      this.sessions.delete(id);
      this.activity.states.delete(id);
      this.activity.modelLeases.delete(id);
      return { deleted: id };
    });
  }
  public(session) {
    const { token, ...view } = session;
    return { ...view, activity: this.activity.view(session), connected: Boolean(session.lastHeartbeat && Date.now() - Date.parse(session.lastHeartbeat) < 15000) };
  }
  async save(session) {
    const next = (this.saves.get(session.id) || Promise.resolve()).catch(() => {}).then(async () => {
      session.updatedAt = now();
      await this.activity.save(session);
      await json(path.join(session.folder, '.harness/session.json'), session);
      await json(path.join(session.folder, '.harness/conversation.json'), session.messages);
    });
    this.saves.set(session.id, next);
    try { await next; } finally { if (this.saves.get(session.id) === next) this.saves.delete(session.id); }
  }
  event(session, text, level = 'info') {
    this.activity.record(session, 'event', text);
    session.events.push({ time: now(), text, level });
    session.events = session.events.slice(-150);
  }
  async load() {
    await fs.mkdir(this.root, { recursive: true });
    for (const entry of await fs.readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('work-')) continue;
      try {
        const session = await readJson(path.join(this.root, entry.name, '.harness/session.json'));
        if (session.id !== entry.name) continue;
        session.folder = path.join(this.root, entry.name);
        session.lastHeartbeat = null;
        if (['setting_up', 'recording'].includes(session.status)) {
          session.status = 'error'; session.error = 'Server stopped during an operation. Retry setup or demo.';
        }
        await this.activity.load(session);
        if (session.status !== 'agent_working') this.activity.stop(session);
        this.sessions.set(session.id, session);
        await this.configureBrowser(session);
        await this.bridge(session);
        await this.activity.save(session);
      } catch { /* Ignore unrelated or incomplete directories. */ }
    }
  }
  async bridge(session) {
    await json(path.join(session.folder, '.harness/bridge.json'), { serverUrl: this.url, sessionId: session.id, token: session.token });
  }
  async create() {
    const id = `work-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(4).toString('hex')}`;
    const folder = path.join(this.root, id);
    await fs.mkdir(path.join(folder, '.harness/responses'), { recursive: true });
    await fs.mkdir(path.join(folder, '.harness/progress'), { recursive: true });
    await fs.writeFile(path.join(folder, '.harness/setup.log'), 'Workspace created. Setup is starting.\n');
    await fs.mkdir(path.join(folder, 'artifacts'), { recursive: true });
    await fs.cp(path.join(project, 'templates/demo'), path.join(folder, '.harness/demo'), { recursive: true });
    await this.configureBrowser({ folder });
    await fs.mkdir(path.join(folder, '.github'), { recursive: true });
    await fs.writeFile(path.join(folder, '.github/copilot-instructions.md'), 'This workspace is managed by AI Workbench. Follow the current harness prompt and REQUIREMENTS.md. Return structured replies in the specified .harness/responses/<jobId>.json file. Demo tooling is preinstalled in .harness/demo. Never use Copilot CLI. Keep company tool and workspace trust settings intact.\n');
    await fs.writeFile(path.join(folder, '.gitignore'), 'node_modules/\n.harness/\nartifacts/\n.env*\n');
    await fs.writeFile(path.join(folder, 'REQUIREMENTS.md'), '# Requirements\n\nWaiting for the project brief.\n');
    const session = { id, folder, token: crypto.randomBytes(32).toString('hex'), title: 'Untitled workspace', createdAt: now(), phase: 'requirements', status: 'setting_up', autoSubmit: true, brief: '', requirements: '', messages: [], jobs: [], events: [], artifacts: [], demoReady: false, error: null, lastHeartbeat: null };
    this.sessions.set(id, session);
    this.event(session, 'Workspace created. Preparing Playwright and Chromium.');
    await this.bridge(session);
    await this.save(session);
    this.setup(id).catch(() => {});
    return this.public(session);
  }
  async setup(id) {
    return this.exclusive(id, async () => {
      const session = this.get(id);
      session.status = 'setting_up'; session.error = null;
      await this.save(session);
      try {
        await this.provision(session);
        session.demoReady = true; session.status = 'awaiting_brief';
        this.event(session, 'Playwright and Chromium are ready. Add your project brief.');
        if (this.autoOpen) {
          try { await this.launch(session.folder, path.join(project, 'extension')); this.event(session, 'Requested a VS Code window. Waiting for the workspace bridge to connect.'); }
          catch (error) { this.event(session, error.message, 'warning'); }
        }
      } catch (error) { session.status = 'error'; session.error = error.message; this.event(session, 'Environment setup failed. See the setup log and retry.', 'error'); }
      await this.save(session);
    });
  }
  async configureBrowser(session) {
    const dir = path.join(session.folder, '.harness/demo');
    let runtime;
    try { runtime = await readJson(path.join(dir, 'runtime.json')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!runtime) {
      const defaultCache = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local'), 'ms-playwright')
        : process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Caches/ms-playwright')
        : path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'ms-playwright');
      const configured = process.env.PLAYWRIGHT_BROWSERS_PATH || defaultCache;
      runtime = { browsersPath: configured === '0' ? '0' : path.resolve(configured) };
      await json(path.join(dir, 'runtime.json'), runtime);
    }
    for (const file of ['browser.mjs', 'check.mjs', 'record.mjs']) await fs.copyFile(path.join(project, 'templates/demo', file), path.join(dir, file));
    const settingsFile = path.join(session.folder, '.vscode/settings.json');
    let settings;
    try { settings = await readJson(settingsFile); }
    catch (error) { if (error.code === 'ENOENT') settings = {}; else return runtime; } // Preserve user-authored JSONC.
    for (const platform of ['windows', 'linux', 'osx']) {
      const key = `terminal.integrated.env.${platform}`;
      settings[key] = { ...settings[key], PLAYWRIGHT_BROWSERS_PATH: runtime.browsersPath };
    }
    await json(settingsFile, settings);
    return runtime;
  }
  async installDemo(session) {
    const cwd = path.join(session.folder, '.harness/demo');
    const runtime = await this.configureBrowser(session);
    const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: runtime.browsersPath };
    const logFile = path.join(session.folder, '.harness/setup.log');
    let log = 'Preparing demo tools.\n', writes = Promise.resolve();
    await fs.writeFile(logFile, log);
    const onOutput = chunk => {
      log = (log + chunk).slice(-100000);
      const contents = log;
      writes = writes.then(() => fs.writeFile(logFile, contents));
      // The awaited chain below reports write failures without unhandled rejections.
      writes.catch(() => {});
    };
    try {
      const expected = (await readJson(path.join(cwd, 'package.json'))).devDependencies['@playwright/test'];
      const packages = ['@playwright/test', 'playwright', 'playwright-core'];
      const available = await Promise.all(packages.map(async name => {
        try { return (await readJson(path.join(project, 'node_modules', name, 'package.json'))).version === expected; }
        catch { return false; }
      }));
      if (available.every(Boolean)) {
        onOutput(`Reusing installed Playwright ${expected}; no npm download needed.\n`);
        for (const name of packages) {
          await fs.cp(path.join(project, 'node_modules', name), path.join(cwd, 'node_modules', name), { recursive: true });
        }
      } else {
        onOutput('Installing Playwright from npm (up to two minutes).\n');
        await run(process.execPath, [await npmCli(), 'install', '--prefer-offline', '--no-audit', '--no-fund', '--fetch-retries=0', '--fetch-timeout=30000'], { cwd, onOutput, timeout: 120000 });
      }
      onOutput('Checking Chromium browser cache; downloading only if missing.\n');
      await run(process.execPath, [path.join(cwd, 'node_modules/@playwright/test/cli.js'), 'install', 'chromium'], { cwd, onOutput, timeout: 120000, env });
      onOutput('Verifying Chromium can launch and render a page.\n');
      await run(process.execPath, [path.join(cwd, 'check.mjs')], { cwd, onOutput, timeout: 30000, env });
      onOutput('Playwright and Chromium are ready.\n');
    } catch (error) {
      onOutput(`Setup failed: ${error.message}\n`);
      throw error;
    } finally { await writes; }
  }
  async queue(session, kind) {
    const job = { id: crypto.randomUUID(), kind, status: 'queued', createdAt: now() };
    job.prompt = makePrompt(session, job);
    session.jobs.push(job);
    this.activity.record(session, 'prompt', job.prompt);
    session.status = 'waiting_for_agent';
    session.error = null;
    this.event(session, `Queued ${kind === 'requirements' ? 'requirements discussion' : kind === 'demo_review' ? 'demo review' : 'development'} for VS Code Copilot.`);
    await this.save(session);
    return job;
  }
  async brief(id, text) {
    return this.exclusive(id, async () => {
      const s = this.get(id);
      if (s.status !== 'awaiting_brief') throw new Error('Workspace is not ready for a brief');
      s.brief = text; s.title = text.split('\n')[0].slice(0, 65);
      s.messages.push({ role: 'human', phase: s.phase, text, time: now() });
      this.activity.record(s, 'human', text);
      await fs.writeFile(path.join(s.folder, 'REQUIREMENTS.md'), `# Project brief\n\n${text}\n`);
      await this.queue(s, 'requirements');
      return this.public(s);
    });
  }
  async answer(id, text) {
    return this.exclusive(id, async () => {
      const s = this.get(id);
      if (!['awaiting_human', 'requirements_ready'].includes(s.status)) throw new Error('No human input is pending');
      s.messages.push({ role: 'human', phase: s.phase, text, time: now() });
      this.activity.record(s, 'human', text);
      await this.queue(s, s.phase === 'demo' ? 'demo_review' : s.phase);
      return this.public(s);
    });
  }
  async approve(id, requirements) {
    return this.exclusive(id, async () => {
      const s = this.get(id);
      if (s.status !== 'requirements_ready') throw new Error('Requirements are not ready for approval');
      validateAssessment(s.assessment);
      s.requirements = requirements || s.requirements;
      await fs.writeFile(path.join(s.folder, 'REQUIREMENTS.md'), s.requirements);
      try { await fs.access(path.join(s.folder, '.harness/baseline.json')); }
      catch { await json(path.join(s.folder, '.harness/baseline.json'), await snapshot(s.folder)); }
      s.phase = 'development';
      this.event(s, 'Requirements approved. Development started.');
      await this.queue(s, 'development');
      return this.public(s);
    });
  }
  async claim(id) {
    if (this.get(id).status === 'recording') { this.get(id).lastHeartbeat = now(); return null; }
    return this.exclusive(id, async () => {
      const s = this.get(id);
      s.lastHeartbeat = now();
      const active = s.jobs.find(j => j.status === 'dispatched');
      if (active) return null; // Never automatically resend a possibly submitted prompt.
      const job = s.jobs.find(j => j.status === 'queued');
      if (!job) return null;
      job.status = 'dispatched'; job.dispatchedAt = now();
      s.status = 'agent_working';
      this.activity.start(s, job.id);
      this.activity.record(s, 'input', job.prompt);
      this.event(s, 'Prompt handed to the VS Code extension. Waiting for a structured reply.');
      await this.save(s);
      return { ...job, autoSubmit: s.autoSubmit !== false };
    });
  }
  async setAutoSubmit(id, value) {
    if (typeof value !== 'boolean') throw new Error('autoSubmit must be boolean');
    const s = this.get(id);
    if (this.activity.removing.has(id)) throw new Error('Workspace is being deleted');
    s.autoSubmit = value;
    await this.save(s);
    return this.public(s);
  }
  async jobError(id, jobId, error) {
    return this.exclusive(id, async () => {
      const s = this.get(id), job = s.jobs.find(j => j.id === jobId && j.status === 'dispatched');
      if (!job) return;
      s.error = error; s.status = 'bridge_error';
      this.activity.stop(s);
      this.event(s, error, 'error');
      await this.save(s);
    });
  }
  async retryJob(id) {
    return this.exclusive(id, async () => {
      const s = this.get(id), job = s.jobs.find(j => j.status === 'dispatched');
      if (!job) throw new Error('No dispatched job to retry');
      job.status = 'cancelled';
      this.activity.stop(s);
      this.event(s, 'Human requested a new attempt. Replies to the old job will be ignored.');
      await this.queue(s, job.kind);
      return this.public(s);
    });
  }
  async response(id, reply) {
    return this.exclusive(id, async () => {
      const s = this.get(id), job = s.jobs.find(j => j.id === reply.jobId);
      if (!job) throw new Error('Unknown job ID');
      if (job.status === 'complete' || job.status === 'cancelled') return this.public(s);
      if (job.status !== 'dispatched') throw new Error('Job has not been dispatched');
      if (!['questions', 'requirements_ready', 'development_complete', 'rollback', 'demo_review_complete'].includes(reply.kind)) throw new Error('Invalid reply kind');
      if (reply.message !== undefined && typeof reply.message !== 'string') throw new Error('message must be a string');
      if (reply.kind === 'questions' && (!Array.isArray(reply.questions) || !reply.questions.length || reply.questions.some(q => typeof q !== 'string' || !q.trim()))) throw new Error('Reply requires nonempty questions');
      if (reply.kind === 'requirements_ready' && (job.kind !== 'requirements' || typeof reply.requirements !== 'string' || !reply.requirements.trim())) throw new Error('Invalid requirements reply');
      if (reply.kind === 'development_complete' && (job.kind !== 'development' || typeof reply.uiChanged !== 'boolean' || !Array.isArray(reply.impact) || reply.impact.some(i => !i || typeof i.file !== 'string' || typeof i.description !== 'string') || !Array.isArray(reply.tests) || reply.tests.some(t => typeof t !== 'string'))) throw new Error('Development reply requires uiChanged, impact[], tests[]');
      if (reply.kind === 'requirements_ready') validateAssessment(reply.assessment);
      if (reply.kind === 'rollback' && (!['development', 'demo'].includes(s.phase) || typeof reply.message !== 'string' || !reply.message.trim())) throw new Error('Rollback requires a development job and a reason');
      if (reply.kind === 'demo_review_complete' && job.kind !== 'demo_review') throw new Error('Invalid demo review reply');
      this.activity.record(s, 'output', JSON.stringify(reply));
      this.activity.stop(s);
      if (reply.kind === 'rollback') {
        job.status = 'complete'; job.completedAt = now();
        await this.reopen(s, reply.message, 'ai');
        return this.public(s);
      }
      if (reply.kind === 'demo_review_complete') {
        s.status = s.demoOutcome || 'complete';
        this.event(s, reply.message || 'AI demo review finished.');
      } else if (reply.kind === 'development_complete') {
        const before = await readJson(path.join(s.folder, '.harness/baseline.json'));
        const diff = changes(before, await snapshot(s.folder));
        await fs.writeFile(path.join(s.folder, 'artifacts/impact.md'), impactMarkdown(reply, diff));
        await json(path.join(s.folder, 'artifacts/changes.json'), diff);
        const reportDir = `artifacts/reports/${job.id}`;
        await fs.mkdir(path.join(s.folder, reportDir), { recursive: true });
        await fs.copyFile(path.join(s.folder, 'artifacts/impact.md'), path.join(s.folder, reportDir, 'impact.md'));
        await fs.copyFile(path.join(s.folder, 'artifacts/changes.json'), path.join(s.folder, reportDir, 'changes.json'));
        s.artifacts = [...new Set([...s.artifacts, 'artifacts/impact.md', 'artifacts/changes.json', `${reportDir}/impact.md`, `${reportDir}/changes.json`])];
        // A visible-file change also triggers recording when an agent forgets its flag.
        s.uiChanged = reply.uiChanged || diff.some(d => /\.(html|css|scss|jsx|tsx|vue|svelte)$/i.test(d.file));
        s.phase = 'demo'; s.status = s.uiChanged ? 'demo_pending' : 'complete';
        this.event(s, s.uiChanged ? 'Development finished. Recording the UI walkthrough.' : 'Development finished. Backend impact report is ready.');
      } else if (reply.kind === 'questions') {
        s.status = 'awaiting_human';
        s.questions = reply.questions;
        this.event(s, 'The AI needs your input. Answer the questions to continue.');
      } else {
        s.assessment = reply.assessment;
        s.requirements = reply.requirements; s.status = 'requirements_ready'; s.questions = [];
        await fs.writeFile(path.join(s.folder, 'REQUIREMENTS.md'), reply.requirements);
        this.event(s, 'Requirements are ready to review and approve.');
      }
      job.status = 'complete'; job.completedAt = now(); s.error = null;
      s.messages.push({ role: 'ai', phase: job.kind === 'demo_review' ? 'demo' : job.kind, text: reply.message || (reply.kind === 'requirements_ready' ? 'Requirements are ready for review.' : 'Work completed.'), questions: reply.questions || [], time: now() });
      await this.save(s);
      if (s.status === 'demo_pending') setImmediate(() => this.demo(id).catch(() => {}));
      return this.public(s);
    });
  }
  async reviewDemo(id) {
    return this.exclusive(id, async () => {
      const s = this.get(id);
      if (s.phase !== 'demo' || !['demo_failed', 'complete'].includes(s.status)) throw new Error('Finish the demo before requesting review');
      s.demoOutcome = s.status;
      await this.queue(s, 'demo_review');
      return this.public(s);
    });
  }
  async progress(id, input) {
    const s = this.get(id);
    if (!s.jobs.some(j => j.id === input.jobId && j.status === 'dispatched')) return;
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 16000) throw new Error('Invalid progress note');
    const state = this.activity.state(s);
    if (state.records.some(r => r.runId === input.jobId && r.type === 'progress' && r.text === input.text)) return;
    this.activity.record(s, 'progress', input.text);
    await this.activity.save(s);
  }
  async reopen(s, reason, actor, target) {
    const from = s.phase;
    s.phase = target || (from === 'demo' ? 'development' : 'requirements');
    s.questions = []; s.error = null;
    s.messages.push({ role: actor === 'human' ? 'human' : 'ai', phase: s.phase, text: `Return from ${from} to ${s.phase}: ${reason}`, time: now() });
    s.rollbacks ||= [];
    s.rollbacks.push({ from, to: s.phase, reason, actor, time: now(), artifacts: [...s.artifacts] });
    this.activity.stop(s);
    this.event(s, `Returned to ${s.phase}: ${reason}`);
    await this.queue(s, s.phase);
  }
  async rollback(id, reason, stopped = false, target) {
    return this.exclusive(id, async () => {
      const s = this.get(id);
      if (!['development', 'demo'].includes(s.phase)) throw new Error('There is no previous step');
      if (target && !(['requirements', 'development', 'demo'].indexOf(target) >= 0 && ['requirements', 'development', 'demo'].indexOf(target) < ['requirements', 'development', 'demo'].indexOf(s.phase))) throw new Error('Choose an earlier step');
      if (s.jobs.some(j => j.status === 'dispatched') && !stopped) throw Object.assign(new Error('Stop the active Copilot request and confirm it is stopped first'), { status: 409 });
      if (typeof reason !== 'string' || !reason.trim()) throw new Error('Describe the bug or question before returning');
      for (const job of s.jobs) if (['queued', 'dispatched'].includes(job.status)) job.status = 'cancelled';
      await this.reopen(s, reason.trim(), 'human', target);
      return this.public(s);
    });
  }
  async demo(id) {
    return this.exclusive(id, async () => {
      const s = this.get(id);
      if (s.phase !== 'demo' || !s.uiChanged || !['demo_pending', 'demo_failed', 'complete'].includes(s.status)) throw new Error('No UI demo is ready to run');
      s.status = 'recording'; s.error = null;
      this.activity.start(s, crypto.randomUUID());
      this.activity.record(s, 'event', 'Recording browser walkthrough.');
      await this.save(s);
      try {
        const runtime = await this.configureBrowser(s);
        await run(process.execPath, [path.join(s.folder, '.harness/demo/record.mjs')], { cwd: s.folder, env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: runtime.browsersPath }, timeout: 180000, onOutput: text => this.activity.record(s, 'tool', text) });
        s.status = 'complete'; this.event(s, 'Video, screenshots and browser trace captured.');
      } catch (error) { s.status = 'demo_failed'; s.error = error.message; this.event(s, 'Demo failed. Review the app URL, start command and steps, then retry.', 'error'); }
      const artifacts = [];
      async function walk(dir) {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) await walk(full);
          else if (entry.isFile()) artifacts.push(path.relative(s.folder, full).replaceAll('\\', '/'));
        }
      }
      await walk(path.join(s.folder, 'artifacts')); s.artifacts = artifacts;
      this.activity.stop(s);
      await this.save(s);
      return this.public(s);
    });
  }
}

export function validateAssessment(value) {
  if (!value || value.feasible !== true || typeof value.evidence !== 'string' || !value.evidence.trim() || ['steps', 'technologies', 'codeImpact'].some(key => !Array.isArray(value[key]) || !value[key].length || value[key].some(item => typeof item !== 'string' || !item.trim()))) {
    throw new Error('Requirements need a verified feasible assessment: evidence, steps[], technologies[], codeImpact[]');
  }
}
