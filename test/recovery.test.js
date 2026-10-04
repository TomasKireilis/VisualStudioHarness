import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Workbench } from '../src/workbench.js';
import { startServer } from '../src/server.js';
import { json, readJson } from '../src/files.js';

async function fixture() {
  await fs.mkdir('.local/recovery-tests', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.local/recovery-tests/run-'));
  const launches = [];
  const launch = async (...args) => { launches.push(args); };
  const w = new Workbench({ root, url: 'http://127.0.0.1:4310', autoOpen: false, hostBootTime: 100000, provision: async () => {}, launch });
  const s = await w.create();
  await w.locks.get(s.id);
  await w.brief(s.id, 'Continue the existing project');
  return { w, s: w.get(s.id), root, launch, launches };
}

test('server startup restores the queued workspace and opens its bridge instead of creating another workspace', async t => {
  const { w, s, root, launch, launches } = await fixture();
  const pendingId = s.jobs[0].id;
  const app = await startServer({ root, port: 0, autoOpen: true, provision: async () => {}, launch });
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  await app.restoration;
  assert.equal(app.workbench.sessions.size, 1);
  assert.equal(launches.length, 1);
  assert.equal(launches[0][0], s.folder);
  assert.equal(app.workbench.get(s.id).recovery.status, 'waiting_bridge');
  assert.equal((await readJson(path.join(s.folder, '.harness/bridge.json'))).serverUrl, app.url);
  assert.equal((await app.workbench.claim(s.id)).id, pendingId);
  assert.equal(app.workbench.get(s.id).recovery, null);
  assert.equal((await readJson(path.join(s.folder, '.harness/session.json'))).jobs[0].status, 'dispatched');
  assert.equal(w.get(s.id).jobs.length, 1);
});

test('a PC restart resumes the same phase from saved files with one new job and rejects late replies', async () => {
  const { w, s, root, launch, launches } = await fixture();
  const old = await w.claim(s.id);
  await fs.writeFile(path.join(s.folder, 'existing-source.js'), 'export const implemented = true;');
  await json(path.join(s.folder, '.harness/progress', `${old.id}.json`), { jobId: old.id, text: 'Implemented the feature; validation remains.' });
  const restarted = new Workbench({ root, url: w.url, autoOpen: false, hostBootTime: 200000, provision: async () => {}, launch });
  await restarted.load();
  assert.equal(restarted.get(s.id).interruptedByShutdown, true);
  await restarted.restore(s.id);
  assert.equal(launches.length, 1);
  const next = await restarted.claim(s.id);
  assert.equal(next.kind, old.kind);
  assert.equal(next.resumeFrom, old.id);
  assert.match(next.prompt, /Preserve the existing project/);
  assert.equal(await fs.readFile(path.join(s.folder, 'existing-source.js'), 'utf8'), 'export const implemented = true;');
  await restarted.response(s.id, { jobId: old.id, kind: 'questions', questions: ['Old request?'] });
  assert.equal(restarted.get(s.id).status, 'agent_working');
  assert.equal(restarted.get(s.id).jobs.length, 2);
});

test('a server-only restart reconnects without duplicating a possibly running Copilot request', async () => {
  const { w, s, root, launch } = await fixture();
  const old = await w.claim(s.id);
  const restarted = new Workbench({ root, url: w.url, autoOpen: false, hostBootTime: 100000, provision: async () => {}, launch });
  await restarted.load();
  await restarted.restore(s.id);
  assert.equal(restarted.get(s.id).jobs.length, 1);
  assert.equal(await restarted.claim(s.id), null);
  await assert.rejects(restarted.restore(s.id, { retry: true }), /Stop the previous Copilot request/);
  assert.equal(restarted.get(s.id).jobs[0].id, old.id);
  await restarted.restore(s.id, { retry: true, stopped: true });
  assert.equal(restarted.get(s.id).jobs[0].status, 'cancelled');
  assert.equal((await restarted.claim(s.id)).resumeFrom, old.id);
});

test('recovery imports a completed response written before shutdown instead of repeating the job', async () => {
  const { w, s, root, launch } = await fixture();
  const old = await w.claim(s.id);
  await json(path.join(s.folder, '.harness/responses', `${old.id}.json`), { jobId: old.id, kind: 'questions', questions: ['Which database?'] });
  const restarted = new Workbench({ root, url: w.url, autoOpen: false, hostBootTime: 200000, provision: async () => {}, launch });
  await restarted.load();
  await restarted.restore(s.id);
  assert.equal(restarted.get(s.id).status, 'awaiting_human');
  assert.deepEqual(restarted.get(s.id).questions, ['Which database?']);
  assert.equal(restarted.get(s.id).jobs.length, 1);
  assert.equal(restarted.get(s.id).interruptedByShutdown, false);
  assert.equal(await restarted.claim(s.id), null);
});

test('a saved development completion defers its demo until environment restoration finishes', async () => {
  const { w, s, root, launch } = await fixture();
  const requirementsJob = await w.claim(s.id);
  await w.response(s.id, { jobId: requirementsJob.id, kind: 'requirements_ready', requirements: '# Existing UI', assessment: {
    feasible: true, evidence: 'Inspected source', steps: ['Implement UI'], technologies: ['HTML'], codeImpact: ['Existing UI']
  } });
  await w.approve(s.id, '# Existing UI');
  const developmentJob = await w.claim(s.id);
  await json(path.join(s.folder, '.harness/responses', `${developmentJob.id}.json`), {
    jobId: developmentJob.id, kind: 'development_complete', uiChanged: true, impact: [], tests: ['Browser check passed']
  });
  const restarted = new Workbench({ root, url: w.url, autoOpen: false, hostBootTime: 200000, provision: async () => {}, launch });
  await restarted.load();
  let demos = 0;
  restarted.demo = async id => {
    demos++;
    assert.ok(restarted.get(id).openedAt, 'VS Code and its environment have been restored before recording');
    restarted.get(id).status = 'complete';
  };
  await restarted.restore(s.id);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(demos, 1);
  assert.equal(restarted.get(s.id).phase, 'demo');
});

test('restore failures keep the pending job and repeated restore requests share one operation', async () => {
  const { w, s, launches } = await fixture();
  const pendingId = s.jobs[0].id;
  w.launch = async () => { throw new Error('VS Code unavailable'); };
  await assert.rejects(w.restore(s.id), /VS Code unavailable/);
  assert.equal(s.recovery.status, 'failed');
  assert.equal(s.jobs[0].id, pendingId);
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  w.launch = async () => { launches.push(s.id); await wait; };
  const first = w.restore(s.id);
  const second = w.restore(s.id);
  assert.equal(first, second);
  await w.locks.get(s.id);
  assert.equal(await w.claim(s.id), null, 'Do not dispatch while recovery is rebuilding the environment');
  release();
  await first;
  assert.equal(launches.length, 0, 'A bridge that reconnects during recovery does not need another VS Code window');
  assert.equal((await w.claim(s.id)).id, pendingId);
});

test('retry interrupted request restores the environment as well as queuing its continuation', async () => {
  const { w, s, launches } = await fixture();
  const old = await w.claim(s.id);
  s.lastHeartbeat = null; // The VS Code process is gone in this recovery scenario.
  await w.retryJob(s.id, { reopen: true });
  await w.restorations.get(s.id);
  assert.equal(launches.length, 1);
  assert.equal((await w.claim(s.id)).resumeFrom, old.id);
});

test('an interrupted setup can be restored, and an interrupted recording re-enters demo recovery', async () => {
  const { w, s, root, launch } = await fixture();
  s.jobs = []; s.phase = 'demo'; s.status = 'recording'; s.uiChanged = true;
  await w.save(s);
  const restarted = new Workbench({ root, url: w.url, autoOpen: false, provision: async () => {}, launch });
  await restarted.load();
  assert.equal(restarted.get(s.id).status, 'demo_failed');
  let recordings = 0;
  restarted.demo = async id => { recordings++; assert.equal(restarted.get(id).status, 'demo_pending'); };
  await restarted.restore(s.id);
  assert.equal(recordings, 1);
  const session = restarted.get(s.id);
  session.phase = 'preparation'; session.status = 'error'; session.demoReady = false; session.interruptedOperation = 'setup';
  await restarted.restore(s.id);
  assert.equal(session.demoReady, true);
  assert.equal(session.phase, 'requirements');
  assert.equal(session.interruptedOperation, null);
});
