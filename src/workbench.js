import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { json, readJson, snapshot, changes, impactMarkdown } from './files.js';
import { run, npmCli, openCode } from './process.js';
import { ActivityService } from './activity.js';
import { makePrompt } from './prompts.js';
import { phases, validateReview, validateRefactoring } from './workflow.js';
import { DockerRuntime, containerCache } from './docker.js';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const now = () => new Date().toISOString();
export class Workbench {
  constructor({ root, url, autoOpen = true, autoApprove = true, provision, launch, backend = provision ? 'host' : 'docker-linux', docker = new DockerRuntime(), hostBootTime = Date.now() - os.uptime() * 1000 }) {
    if (!['host', 'docker-linux'].includes(backend)) throw new Error('AIWORK_EXECUTION must be docker-linux or host');
    this.root = path.resolve(root);
    this.url = url;
    this.autoOpen = autoOpen;
    this.autoApprove = autoApprove;
    this.backend = backend;
    this.docker = docker;
    this.hostBootTime = hostBootTime;
    this.restorations = new Map();
    this.provision = provision || this.installDemo.bind(this);
    this.launch = launch || ((folder, extensionPath, session) => openCode(folder, extensionPath, session?.execution));
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
      if (this.restorations.has(id) || this.locks.has(id) || ['setting_up', 'recording', 'demo_pending', 'agent_working'].includes(session.status) || session.jobs.some(j => j.status === 'dispatched')) {
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
        if (session.execution?.backend === 'docker-linux') await this.docker.remove(session);
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
        if (!session.demoReady && !session.brief && ['setting_up', 'error'].includes(session.status)) session.phase = 'preparation';
        if (session.status === 'setting_up') {
          session.interruptedOperation = 'setup'; session.status = 'error'; session.error = 'Setup was interrupted. Restore the workspace to continue.';
        } else if (session.status === 'recording') {
          session.interruptedOperation = 'demo'; session.status = 'demo_failed'; session.error = 'Recording was interrupted. Restore the workspace to record again.';
        }
        const dispatched = session.jobs.find(job => job.status === 'dispatched');
        session.interruptedByShutdown = Boolean(dispatched?.hostBootTime && Math.abs(dispatched.hostBootTime - this.hostBootTime) > 10000);
        session.recovery = null;
        await this.activity.load(session);
        if (session.status !== 'agent_working') this.activity.stop(session);
        this.sessions.set(session.id, session);
        await this.configureBrowser(session);
        await this.configureChat(session);
        if (session.execution?.backend === 'docker-linux') await this.docker.configure(session);
        await this.bridge(session);
        await this.save(session);
      } catch { /* Ignore unrelated or incomplete directories. */ }
    }
  }
  async bridge(session) {
    await json(path.join(session.folder, '.harness/bridge.json'), { serverUrl: this.url, sessionId: session.id, token: session.token, hostFolder: session.folder, executionBackend: session.execution?.backend || 'host' });
  }
  async create() {
    const id = `work-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(4).toString('hex')}`;
    const folder = path.join(this.root, id);
    await fs.mkdir(path.join(folder, '.harness/responses'), { recursive: true });
    await fs.mkdir(path.join(folder, '.harness/progress'), { recursive: true });
    await fs.writeFile(path.join(folder, '.harness/setup.log'), 'Workspace created. Setup is starting.\n');
    await fs.mkdir(path.join(folder, 'artifacts'), { recursive: true });
    await fs.cp(path.join(project, 'templates/demo'), path.join(folder, '.harness/demo'), { recursive: true });
    await fs.mkdir(path.join(folder, '.github'), { recursive: true });
    await fs.writeFile(path.join(folder, '.github/copilot-instructions.md'), 'This workspace is managed by AI Workbench. Follow the current harness prompt and REQUIREMENTS.md. Return structured replies in the specified .harness/responses/<jobId>.json file. Demo tooling is preinstalled in .harness/demo. Never use Copilot CLI. Keep company tool and workspace trust settings intact.\n');
    await fs.writeFile(path.join(folder, '.gitignore'), 'node_modules/\n.harness/\nartifacts/\n.env*\n');
    await fs.writeFile(path.join(folder, 'REQUIREMENTS.md'), '# Requirements\n\nWaiting for the project brief.\n');
    const session = { id, folder, token: crypto.randomBytes(32).toString('hex'), title: 'Untitled workspace', createdAt: now(), phase: 'preparation', status: 'setting_up', autoSubmit: true, autoApprove: this.autoApprove, brief: '', requirements: '', messages: [], jobs: [], events: [], artifacts: [], demoReady: false, error: null, lastHeartbeat: null };
    session.execution = this.backend === 'docker-linux' ? this.docker.spec(session) : { backend: 'host' };
    await this.configureBrowser(session);
    await this.configureChat(session);
    if (session.execution.backend === 'docker-linux') {
      await this.docker.configure(session);
      await fs.appendFile(path.join(folder, '.github/copilot-instructions.md'), 'All dependencies, commands, builds, tests and demos run in the Linux workspace container at /workspace. Use the attached Dev Container terminal. Never execute generated code on the Windows host.\n');
    }
    this.sessions.set(id, session);
    this.event(session, session.execution.backend === 'docker-linux' ? 'Workspace created. Preparing a local Linux Docker container, Playwright and Chromium.' : 'Workspace created. Preparing Playwright and Chromium.');
    await this.bridge(session);
    await this.save(session);
    this.setup(id).catch(() => {});
    return this.public(session);
  }
  async setup(id) {
    return this.exclusive(id, async () => {
      const session = this.get(id);
      if (session.demoReady) throw Object.assign(new Error('Environment preparation is complete and locked'), { status: 409 });
      if (session.phase !== 'preparation') throw new Error('Environment preparation is not the active step');
      session.status = 'setting_up'; session.error = null;
      await this.save(session);
      try {
        await this.provision(session);
        session.demoReady = true; session.preparedAt = now(); session.phase = 'requirements'; session.status = 'awaiting_brief';
        this.event(session, 'Playwright and Chromium are ready. Add your project brief.');
        if (this.autoOpen) {
          try { await this.launch(session.folder, path.join(project, 'extension'), session); session.openedAt = now(); this.event(session, 'Requested a VS Code window. Waiting for the workspace bridge to connect.'); }
          catch (error) { this.event(session, error.message, 'warning'); }
        }
      } catch (error) { session.status = 'error'; session.error = error.message; this.event(session, 'Environment setup failed. See the setup log and retry.', 'error'); }
      await this.save(session);
    });
  }
  async configureChat(session) {
    const dir = path.join(session.folder, '.harness/chat');
    await fs.mkdir(dir, { recursive: true });
    await fs.copyFile(path.join(project, 'templates/chat/question-hook.cjs'), path.join(dir, 'question-hook.cjs'));
    const command = { type: 'command', command: 'node .harness/chat/question-hook.cjs', cwd: '.', timeout: 10 };
    await json(path.join(session.folder, '.github/hooks/ai-workbench.json'), {
      hooks: { UserPromptSubmit: [command], PreToolUse: [command], Stop: [command] }
    });
  }
  async configureBrowser(session) {
    const dir = path.join(session.folder, '.harness/demo');
    let runtime;
    try { runtime = await readJson(path.join(dir, 'runtime.json')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (session.execution?.backend === 'docker-linux') {
      runtime = { browsersPath: containerCache, backend: 'docker-linux' };
      await json(path.join(dir, 'runtime.json'), runtime);
    } else if (!runtime) {
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
    for (const platform of session.execution?.backend === 'docker-linux' ? ['linux'] : ['windows', 'linux', 'osx']) {
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
      if (session.execution?.backend === 'docker-linux') {
        onOutput('Preparing this workspace in a local Linux Docker container.\n');
        await this.docker.startDesktop();
        await this.docker.provision(session, onOutput);
        return;
      }
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
      onOutput(`Verifying cached Chromium and video recording in ${runtime.browsersPath}.\n`);
      try {
        await run(process.execPath, [path.join(cwd, 'check.mjs')], { cwd, onOutput, timeout: 30000, env });
        onOutput('Cached browser and recording tools work; skipping the browser installer.\n');
      } catch {
        onOutput('Cached browser verification failed. Installing Chromium (up to five minutes).\n');
        try {
          await run(process.execPath, [path.join(cwd, 'node_modules/@playwright/test/cli.js'), 'install', 'chromium'], { cwd, onOutput, timeout: 300000, env });
        } catch (error) { throw new Error(`Chromium installation failed: ${error.message}. Check the installation log and browser download access.`); }
        onOutput('Verifying Chromium can launch, render a page and record video.\n');
        await run(process.execPath, [path.join(cwd, 'check.mjs')], { cwd, onOutput, timeout: 30000, env });
      }
      onOutput('Playwright and Chromium are ready.\n');
    } catch (error) {
      onOutput(`Setup failed: ${error.message}\n`);
      throw error;
    } finally { await writes; }
  }
  async queue(session, kind, resumeFrom) {
    const job = { id: crypto.randomUUID(), kind, status: 'queued', createdAt: now(), ...(resumeFrom ? { resumeFrom } : {}) };
    job.prompt = makePrompt(session, job);
    session.jobs.push(job);
    this.activity.record(session, 'prompt', job.prompt);
    session.status = 'waiting_for_agent';
    session.error = null;
    this.event(session, `Queued ${kind.replaceAll('_', ' ')} for VS Code Copilot.`);
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
      if (s.recovery?.status === 'restoring') return null;
      if (s.recovery?.status === 'waiting_bridge') {
        s.recovery = null;
        this.event(s, 'VS Code bridge reconnected. Workspace restored.');
        await this.save(s);
      }
      const active = s.jobs.find(j => j.status === 'dispatched');
      if (active) return null; // Never automatically resend a possibly submitted prompt.
      const job = s.jobs.find(j => j.status === 'queued');
      if (!job) return null;
      await this.ensureContainer(s);
      job.status = 'dispatched'; job.dispatchedAt = now();
      job.hostBootTime = this.hostBootTime;
      s.interruptedByShutdown = false;
      s.status = 'agent_working';
      this.activity.start(s, job.id);
      this.activity.record(s, 'input', job.prompt);
      this.event(s, 'Prompt handed to the VS Code extension. Waiting for a structured reply.');
      await this.save(s);
      return { ...job, autoSubmit: s.autoSubmit !== false, autoApprove: s.autoApprove === true };
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
  async retryJob(id, { reopen = this.autoOpen } = {}) {
    const result = await this.exclusive(id, async () => {
      const s = this.get(id), job = s.jobs.find(j => j.status === 'dispatched');
      if (!job) throw new Error('No dispatched job to retry');
      job.status = 'cancelled';
      this.activity.stop(s);
      this.event(s, 'Human requested a new attempt. Replies to the old job will be ignored.');
      s.interruptedByShutdown = false;
      await this.queue(s, job.kind, job.id);
      return this.public(s);
    });
    if (reopen) void this.restore(id).catch(() => {});
    return result;
  }
  async response(id, reply) {
    return this.exclusive(id, async () => {
      const s = this.get(id), job = s.jobs.find(j => j.id === reply.jobId);
      if (!job) throw new Error('Unknown job ID');
      if (job.status === 'complete' || job.status === 'cancelled') return this.public(s);
      if (job.status !== 'dispatched') throw new Error('Job has not been dispatched');
      if (!['questions', 'requirements_ready', 'development_complete', 'rollback', 'demo_review_complete', 'pr_review_complete', 'refactoring_complete'].includes(reply.kind)) throw new Error('Invalid reply kind');
      if (reply.message !== undefined && typeof reply.message !== 'string') throw new Error('message must be a string');
      if (reply.kind === 'questions' && (!Array.isArray(reply.questions) || !reply.questions.length || reply.questions.some(q => typeof q !== 'string' || !q.trim()))) throw new Error('Reply requires nonempty questions');
      if (reply.kind === 'requirements_ready' && (job.kind !== 'requirements' || typeof reply.requirements !== 'string' || !reply.requirements.trim())) throw new Error('Invalid requirements reply');
      if (reply.kind === 'development_complete' && (job.kind !== 'development' || typeof reply.uiChanged !== 'boolean' || !Array.isArray(reply.impact) || reply.impact.some(i => !i || typeof i.file !== 'string' || typeof i.description !== 'string') || !Array.isArray(reply.tests) || reply.tests.some(t => typeof t !== 'string'))) throw new Error('Development reply requires uiChanged, impact[], tests[]');
      if (reply.kind === 'requirements_ready') validateAssessment(reply.assessment);
      if (reply.kind === 'rollback' && (!['development', 'demo'].includes(s.phase) || typeof reply.message !== 'string' || !reply.message.trim())) throw new Error('Rollback requires a development job and a reason');
      if (reply.kind === 'demo_review_complete' && job.kind !== 'demo_review') throw new Error('Invalid demo review reply');
      if (reply.kind === 'pr_review_complete') {
        if (job.kind !== 'pr_review') throw new Error('Invalid PR review reply');
        validateReview(reply);
      }
      if (reply.kind === 'refactoring_complete') {
        if (job.kind !== 'refactoring') throw new Error('Invalid refactoring reply');
        validateRefactoring(reply);
      }
      this.activity.record(s, 'output', JSON.stringify(reply));
      this.activity.stop(s);
      if (reply.kind === 'rollback') {
        job.status = 'complete'; job.completedAt = now();
        await this.reopen(s, reply.message, 'ai');
        return this.public(s);
      }
      let nextJob;
      if (reply.kind === 'pr_review_complete') {
        s.reviews ||= [];
        s.reviews.push({ jobId: job.id, time: now(), findings: reply.findings, checks: reply.checks, tests: reply.tests });
        s.reviewFindings = reply.findings;
        s.phase = reply.findings.length ? 'refactoring' : 'handoff';
        s.status = reply.findings.length ? 'waiting_for_agent' : 'handoff_pending';
        nextJob = reply.findings.length ? 'refactoring' : null;
        this.event(s, reply.findings.length ? `PR review found ${reply.findings.length} issue(s). Refactoring next.` : 'PR review passed. Ready for the future Git push and human PR step.');
      } else if (reply.kind === 'refactoring_complete') {
        await this.recordImpact(s, job, reply);
        s.refactorings ||= [];
        s.refactorings.push({ jobId: job.id, time: now(), addressedFindings: reply.addressedFindings, tests: reply.tests });
        s.phase = 'pr_review';
        nextJob = 'pr_review';
        this.event(s, 'Refactoring finished. Running a fresh PR review.');
      } else if (reply.kind === 'demo_review_complete') {
        s.status = s.demoOutcome || 'complete';
        this.event(s, reply.message || 'AI demo review finished.');
      } else if (reply.kind === 'development_complete') {
        const diff = await this.recordImpact(s, job, reply);
        // A visible-file change also triggers recording when an agent forgets its flag.
        s.uiChanged = reply.uiChanged || diff.some(d => /\.(html|css|scss|jsx|tsx|vue|svelte)$/i.test(d.file));
        s.phase = 'demo'; s.status = s.uiChanged ? 'demo_pending' : 'complete';
        s.resultApprovedAt = null;
        s.reviewFindings = [];
        this.event(s, s.uiChanged ? 'Development finished. Recording the UI walkthrough.' : 'Development finished. Backend impact report is ready for your approval.');
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
      job.status = 'complete'; job.completedAt = now(); s.error = null; s.interruptedByShutdown = false;
      s.messages.push({ role: 'ai', phase: job.kind === 'demo_review' ? 'demo' : job.kind, text: reply.message || (reply.kind === 'requirements_ready' ? 'Requirements are ready for review.' : 'Work completed.'), questions: reply.questions || [], time: now() });
      if (nextJob) await this.queue(s, nextJob);
      else await this.save(s);
      if (s.status === 'demo_pending' && !this.restorations.has(id)) setImmediate(() => this.demo(id).catch(() => {}));
      return this.public(s);
    });
  }
  async recordImpact(s, job, reply) {
    const before = await readJson(path.join(s.folder, '.harness/baseline.json'));
    const diff = changes(before, await snapshot(s.folder));
    const reportDir = `artifacts/reports/${job.id}`;
    await fs.mkdir(path.join(s.folder, reportDir), { recursive: true });
    await fs.writeFile(path.join(s.folder, 'artifacts/impact.md'), impactMarkdown(reply, diff));
    await json(path.join(s.folder, 'artifacts/changes.json'), diff);
    for (const name of ['impact.md', 'changes.json']) await fs.copyFile(path.join(s.folder, 'artifacts', name), path.join(s.folder, reportDir, name));
    s.artifacts = [...new Set([...s.artifacts, 'artifacts/impact.md', 'artifacts/changes.json', `${reportDir}/impact.md`, `${reportDir}/changes.json`])];
    return diff;
  }
  async startReview(id) {
    return this.exclusive(id, async () => {
      const s = this.get(id);
      if (s.phase !== 'demo' || s.status !== 'complete') throw new Error('Finish the demo before starting PR review');
      s.resultApprovedAt = now();
      s.phase = 'pr_review';
      this.event(s, 'You approved the result. Starting PR review.');
      await this.queue(s, 'pr_review');
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
    s.phase = target || phases[phases.indexOf(from) - 1];
    s.resultApprovedAt = null;
    s.questions = []; s.error = null;
    s.messages.push({ role: actor === 'human' ? 'human' : 'ai', phase: s.phase, text: `Return from ${from} to ${s.phase}: ${reason}`, time: now() });
    s.rollbacks ||= [];
    s.rollbacks.push({ from, to: s.phase, reason, actor, time: now(), artifacts: [...s.artifacts] });
    this.activity.stop(s);
    this.event(s, `Returned to ${s.phase}: ${reason}`);
    await this.queue(s, s.phase === 'demo' ? 'demo_review' : s.phase);
  }
  async rollback(id, reason, stopped = false, target) {
    return this.exclusive(id, async () => {
      const s = this.get(id);
      if (!phases.includes(s.phase) || ['preparation', 'requirements'].includes(s.phase)) throw new Error('There is no previous step');
      if (target === 'preparation') throw new Error('Environment preparation is complete and locked');
      if (target && !(phases.indexOf(target) > 0 && phases.indexOf(target) < phases.indexOf(s.phase))) throw new Error('Choose an earlier step');
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
        const onOutput = text => this.activity.record(s, 'tool', text);
        if (s.execution?.backend === 'docker-linux') {
          await this.ensureContainer(s);
          await this.docker.exec(s, 'node', ['.harness/demo/record.mjs'], { timeout: 180000, onOutput });
        } else {
          await run(process.execPath, [path.join(s.folder, '.harness/demo/record.mjs')], { cwd: s.folder, env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: runtime.browsersPath }, timeout: 180000, onOutput });
        }
        s.status = 'complete'; s.resultApprovedAt = null; this.event(s, 'Video, screenshots and browser trace captured. Review and approve the result to start PR review.');
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
  async ensureContainer(session) {
    if (session.execution?.backend !== 'docker-linux') return;
    try {
      const state = await this.docker.ensure(session);
      // Recreated containers need their demo dependencies restored too.
      await this.docker.exec(session, 'node', ['/opt/aiwork/prepare.mjs'], { timeout: 120000 });
      if (state?.created && session.demoReady) {
        try {
          await fs.access(path.join(session.folder, 'package.json'));
          let command = 'install';
          try { await fs.access(path.join(session.folder, 'package-lock.json')); command = 'ci'; } catch {}
          this.event(session, 'Restoring project dependencies in the recreated container.');
          await this.docker.exec(session, 'npm', [command, '--no-audit', '--no-fund'], { timeout: 120000 });
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (session.containerError) { session.containerError = null; session.error = null; await this.save(session); }
    } catch (error) {
      session.containerError = error.message; session.error = `Workspace container unavailable: ${error.message}`;
      await this.save(session);
      throw error;
    }
  }
  async open(id) {
    return this.exclusive(id, async () => {
      const session = this.get(id);
      await this.ensureContainer(session);
      await this.launch(session.folder, path.join(project, 'extension'), session);
      session.openedAt = now();
      await this.save(session);
    });
  }
  async resume() {
    if (!this.autoOpen) return;
    await Promise.allSettled([...this.sessions.values()].filter(s => s.openedAt || s.interruptedOperation ||
      s.jobs.some(job => ['queued', 'dispatched'].includes(job.status)) || s.status === 'demo_pending')
      .map(s => this.restore(s.id)));
  }
  restore(id, { retry = false, stopped = false } = {}) {
    if (this.restorations.has(id)) return this.restorations.get(id);
    const restoring = this.restoreWorkspace(id, { retry, stopped }).finally(() => this.restorations.delete(id));
    this.restorations.set(id, restoring);
    return restoring;
  }
  async restoreWorkspace(id, { retry, stopped }) {
    const s = this.get(id);
    let launchedBySetup = false;
    try {
      await this.exclusive(id, async () => {
        s.recovery = { status: 'restoring', message: 'Restoring the workspace environment…' };
        this.event(s, 'Restoring the saved workspace, container and VS Code bridge.');
        await this.save(s);
      });
      // A completed reply might have been written just before power was lost.
      const active = s.jobs.find(job => job.status === 'dispatched');
      if (active) {
        try {
          const reply = await readJson(path.join(s.folder, '.harness/responses', `${active.id}.json`));
          await this.response(id, reply);
        } catch (error) {
          if (error.code !== 'ENOENT') this.event(s, `Saved reply could not be recovered: ${error.message}`, 'warning');
        }
      }
      const pending = s.jobs.find(job => job.status === 'dispatched');
      if (pending && (s.interruptedByShutdown || retry)) {
        if (!s.interruptedByShutdown && !stopped) throw new Error('Stop the previous Copilot request before restarting it. Then retry the interrupted request.');
        await this.retryJob(id, { reopen: false });
      }
      if (s.execution?.backend === 'docker-linux') await this.docker.startDesktop();
      if (!s.demoReady && s.phase === 'preparation') {
        const before = s.openedAt;
        await this.setup(id);
        if (!s.demoReady) throw new Error(s.error || 'Environment setup failed');
        launchedBySetup = s.openedAt !== before;
        s.interruptedOperation = null;
      }
      await this.exclusive(id, async () => {
        await this.configureBrowser(s);
        await this.configureChat(s);
        await this.bridge(s);
        if (s.execution?.backend === 'docker-linux') await this.docker.configure(s);
        await this.ensureContainer(s);
        if (!this.public(s).connected) {
          if (!launchedBySetup) {
            await this.launch(s.folder, path.join(project, 'extension'), s);
            s.openedAt = now();
          }
          s.recovery = { status: 'waiting_bridge', message: 'VS Code reopened. Waiting for its workspace bridge to connect.' };
        } else s.recovery = null;
        s.error = null;
        this.event(s, s.jobs.some(job => job.status === 'dispatched') ? 'Environment restored. The previous request is retained; retry it after stopping the old chat if it cannot continue.' : 'Environment restored. VS Code will pick up the saved request.');
        await this.save(s);
      });
      if (s.interruptedOperation === 'demo' || s.status === 'demo_pending') {
        s.interruptedOperation = null;
        if (s.status === 'demo_failed') s.status = 'demo_pending';
        await this.demo(id);
      }
      return this.public(s);
    } catch (error) {
      s.recovery = { status: 'failed', message: error.message };
      this.event(s, `Workspace restore failed: ${error.message}`, 'error');
      await this.save(s);
      throw error;
    }
  }
}

export function validateAssessment(value) {
  if (!value || value.feasible !== true || typeof value.evidence !== 'string' || !value.evidence.trim() || ['steps', 'technologies', 'codeImpact'].some(key => !Array.isArray(value[key]) || !value[key].length || value[key].some(item => typeof item !== 'string' || !item.trim()))) {
    throw new Error('Requirements need a verified feasible assessment: evidence, steps[], technologies[], codeImpact[]');
  }
}
