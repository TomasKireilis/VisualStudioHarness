import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Workbench } from '../src/workbench.js';
import { startServer } from '../src/server.js';
import { inside, readJson } from '../src/files.js';

const tempRoot = path.resolve('.local/tests');
async function fixture(options = {}) {
  await fs.mkdir(tempRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(tempRoot, 'case-'));
  const workbench = new Workbench({ root, url: 'http://127.0.0.1:4310', autoOpen: false, provision: async () => {}, ...options });
  const s = await workbench.create();
  await workbench.locks.get(s.id);
  return { w: workbench, id: s.id, folder: s.folder, root };
}
test('requirements questions, human answers, approval and backend completion persist real changes', async () => {
  const { w, id, folder } = await fixture();
  assert.equal(w.get(id).status, 'awaiting_brief');
  await w.brief(id, 'Build an inventory API');
  let job = await w.claim(id);
  assert.match(job.prompt, /inventory API/);
  await w.response(id, { jobId: job.id, kind: 'questions', questions: ['Who may edit inventory?'] });
  assert.equal(w.get(id).status, 'awaiting_human');
  await w.answer(id, 'Only managers');
  job = await w.claim(id);
  const requirements = '# Inventory API\n\nOnly managers can edit.\n\nAcceptance: reject unauthorized updates.';
  await w.response(id, { jobId: job.id, kind: 'requirements_ready', assessment: { feasible: true, evidence: 'Inspected fixture runtime and source', steps: ['Implement and validate'], technologies: ['Node.js'], codeImpact: ['Add fixture source'] }, requirements });
  assert.equal(await fs.readFile(path.join(folder, 'REQUIREMENTS.md'), 'utf8'), requirements);
  await w.approve(id, requirements);
  job = await w.claim(id);
  await fs.writeFile(path.join(folder, 'api.js'), 'export const canEdit = role => role === "manager";\n');
  const reply = { jobId: job.id, kind: 'development_complete', message: 'Added role check.', uiChanged: false, impact: [{ file: 'api.js', description: 'Manager-only edits' }], tests: ['Validation not run in this test fixture'] };
  await w.response(id, reply);
  assert.equal(w.get(id).status, 'complete');
  const report = await fs.readFile(path.join(folder, 'artifacts/impact.md'), 'utf8');
  assert.match(report, /Manager-only edits/); assert.match(report, /export const canEdit/);
  const count = w.get(id).messages.length;
  await w.response(id, reply);
  assert.equal(w.get(id).messages.length, count, 'Reply delivery is idempotent');
  const restarted = new Workbench({ root: w.root, url: 'http://127.0.0.1:9999' });
  await restarted.load();
  assert.equal(restarted.get(id).status, 'complete');
  assert.equal((await readJson(path.join(folder, '.harness/bridge.json'))).serverUrl, 'http://127.0.0.1:9999');
});
test('jobs claim exactly once; retry invalidates late responses', async () => {
  const { w, id } = await fixture();
  await w.brief(id, 'A dashboard');
  const claims = await Promise.all([w.claim(id), w.claim(id)]);
  assert.equal(claims.filter(Boolean).length, 1);
  const oldJob = claims.find(Boolean);
  await w.retryJob(id);
  await w.response(id, { jobId: oldJob.id, kind: 'questions', questions: ['Stale?'] });
  assert.equal(w.get(id).status, 'waiting_for_agent');
  assert.notEqual((await w.claim(id)).id, oldJob.id);
});
test('invalid transitions and malformed replies do not complete a job', async () => {
  const { w, id } = await fixture();
  await assert.rejects(w.approve(id, '# Premature'), /not ready/);
  await w.brief(id, 'A service');
  const job = await w.claim(id);
  await assert.rejects(w.response(id, { jobId: job.id, kind: 'questions', questions: [] }), /nonempty/);
  await assert.rejects(w.response(id, { jobId: job.id, kind: 'development_complete', uiChanged: false, impact: [], tests: [] }), /Development reply/);
  assert.equal(w.get(id).jobs[0].status, 'dispatched');
});
test('setup errors are visible and retryable', async () => {
  const { w, id } = await fixture({ provision: async () => { throw new Error('Registry unavailable'); } });
  assert.equal(w.get(id).status, 'error'); assert.match(w.get(id).error, /Registry/);
  w.provision = async () => {};
  await w.setup(id);
  assert.equal(w.get(id).demoReady, true);
});
test('UI source changes trigger the demo even if the agent flag is false', async () => {
  const { w, id, folder } = await fixture();
  let demoId;
  w.demo = async id => { demoId = id; };
  await w.brief(id, 'A page');
  let job = await w.claim(id);
  await w.response(id, { jobId: job.id, kind: 'requirements_ready', assessment: { feasible: true, evidence: 'Inspected fixture runtime and source', steps: ['Implement and validate'], technologies: ['Node.js'], codeImpact: ['Add fixture source'] }, requirements: '# Page' });
  await w.approve(id, '# Page'); job = await w.claim(id);
  await fs.writeFile(path.join(folder, 'index.html'), '<h1>Hello</h1>');
  await w.response(id, { jobId: job.id, kind: 'development_complete', uiChanged: false, impact: [], tests: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(w.get(id).uiChanged, true); assert.equal(demoId, id);
});
test('artifact containment rejects directory traversal', async () => {
  const { folder } = await fixture();
  await assert.rejects(inside(folder, '../outside.txt'), /outside/);
});
test('workspace deletion removes only the confirmed workspace and survives restart', async () => {
  const { w, id, folder } = await fixture();
  const other = await w.create(); await w.locks.get(other.id);
  await assert.rejects(w.remove(id, 'wrong-id'), /exact ID/);
  assert.equal((await fs.stat(folder)).isDirectory(), true);
  await w.remove(id, id);
  await assert.rejects(fs.stat(folder), { code: 'ENOENT' });
  assert.throws(() => w.get(id), /not found/);
  assert.equal((await fs.stat(other.folder)).isDirectory(), true);
  const restarted = new Workbench({ root: w.root, url: w.url }); await restarted.load();
  assert.equal(restarted.sessions.has(id), false); assert.equal(restarted.sessions.has(other.id), true);
});
test('workspace deletion rejects active jobs and paths outside its configured root', async () => {
  const { w, id, folder } = await fixture();
  await w.brief(id, 'A tool'); await w.claim(id);
  await assert.rejects(w.remove(id, id), /active work/);
  assert.equal((await fs.stat(folder)).isDirectory(), true);
  const session = w.get(id); session.status = 'awaiting_brief'; session.jobs = [];
  session.folder = path.dirname(w.root);
  await assert.rejects(w.remove(id, id), /outside/);
  session.folder = folder;
});
test('HTTP routes protect bridge tokens, cross-origin requests and private files', async t => {
  await fs.mkdir(tempRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(tempRoot, 'http-'));
  const app = await startServer({ port: 0, root, autoOpen: false, createOnStart: false, provision: async () => {} });
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  let response = await fetch(`${app.url}/api/sessions`);
  assert.equal(response.status, 401);
  const headers = { 'X-Workbench-Token': app.uiToken, 'Content-Type': 'application/json' };
  response = await fetch(`${app.url}/api/sessions`, { method: 'POST', headers, body: '{}' });
  const s = await response.json(); assert.equal(response.status, 201); assert.equal(s.token, undefined);
  await app.workbench.locks.get(s.id);
  response = await fetch(`${app.url}/api/sessions`, { headers: { ...headers, Origin: 'https://example.com' } }); assert.equal(response.status, 403);
  response = await fetch(`${app.url}/bridge/${s.id}/claim`, { method: 'POST' }); assert.equal(response.status, 401);
  response = await fetch(`${app.url}/api/sessions/${s.id}/file?path=.harness/bridge.json`, { headers }); assert.equal(response.status, 403);
  response = await fetch(`${app.url}/api/sessions/${s.id}/file?path=artifacts/../../package.json`, { headers }); assert.equal(response.status, 400);
  response = await fetch(`${app.url}/api/sessions/${s.id}/file?path=artifacts/../.harness/bridge.json`, { headers }); assert.equal(response.status, 400);
  const html = await (await fetch(app.url)).text(); assert.ok(html.includes(app.uiToken));
  response = await fetch(`${app.url}/api/sessions/${s.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmId: s.id }) }); assert.equal(response.status, 401);
  response = await fetch(`${app.url}/api/sessions/${s.id}`, { method: 'DELETE', headers, body: JSON.stringify({ confirmId: s.id }) }); assert.equal(response.status, 200);
  response = await fetch(`${app.url}/api/sessions/${s.id}`, { headers }); assert.equal(response.status, 404);
});

const assessment = { feasible: true, evidence: 'Inspected Node runtime and existing files', steps: ['Implement and test'], technologies: ['Node.js'], codeImpact: ['New API module'] };
async function develop(w, id) {
  await w.brief(id, 'Build an API');
  let job = await w.claim(id);
  await w.response(id, { jobId: job.id, kind: 'requirements_ready', requirements: '# API', assessment });
  await w.approve(id, '# API');
  return w.claim(id);
}
test('requirements cannot advance without feasibility evidence and implementation bullets', async () => {
  const { w, id } = await fixture();
  await w.brief(id, 'Feature'); const job = await w.claim(id);
  for (const value of [undefined, { ...assessment, feasible: false }, { ...assessment, steps: [] }]) {
    await assert.rejects(w.response(id, { jobId: job.id, kind: 'requirements_ready', requirements: '# Feature', assessment: value }), /assessment/);
    assert.equal(w.get(id).status, 'agent_working');
  }
});
test('human and AI rollback preserve source, baseline, feedback and invalidate stale jobs', async () => {
  const { w, id, folder } = await fixture();
  const job = await develop(w, id);
  const baseline = await readJson(path.join(folder, '.harness/baseline.json'));
  await fs.writeFile(path.join(folder, 'api.js'), 'existing work');
  await assert.rejects(w.rollback(id, 'Wrong requirement'), /Stop the active/);
  await w.rollback(id, 'Wrong requirement', true);
  assert.equal(w.get(id).phase, 'requirements');
  await w.response(id, { jobId: job.id, kind: 'questions', questions: ['Stale'] });
  assert.equal(w.get(id).status, 'waiting_for_agent');
  const next = await w.claim(id);
  await w.response(id, { jobId: next.id, kind: 'requirements_ready', requirements: '# Revised API', assessment });
  await w.approve(id, '# Revised API');
  assert.deepEqual(await readJson(path.join(folder, '.harness/baseline.json')), baseline);
  const dev = await w.claim(id);
  await w.response(id, { jobId: dev.id, kind: 'development_complete', uiChanged: false, impact: [], tests: [] });
  await w.reviewDemo(id);
  const review = await w.claim(id);
  assert.equal(review.kind, 'demo_review');
  await w.response(id, { jobId: review.id, kind: 'rollback', message: 'Demo shows missing validation' });
  assert.equal(w.get(id).phase, 'development');
  assert.equal(await fs.readFile(path.join(folder, 'api.js'), 'utf8'), 'existing work');
  assert.equal(w.get(id).rollbacks.at(-1).actor, 'ai');
  assert.ok(w.get(id).artifacts.some(f => f.includes('/reports/')));
  const restarted = new Workbench({ root: w.root, url: w.url }); await restarted.load();
  assert.equal(restarted.get(id).rollbacks.length, 2);
  assert.match(restarted.get(id).messages.at(-1).text, /missing validation/);
});
test('activity summaries use 30 second cadence, enforce 50 words, finish and persist', async () => {
  const { w, id } = await fixture();
  await w.brief(id, 'Feature'); const job = await w.claim(id), s = w.get(id);
  await w.progress(id, { jobId: job.id, text: 'Read api.js; inspecting validation' });
  const first = await w.activity.claim(s, 100000);
  assert.ok(first.records.some(r => r.type === 'progress'));
  assert.equal(await w.activity.claim(s, 100001), null);
  await w.activity.response(s, { id: first.id, text: Array(80).fill('word').join(' ') }, 105000);
  assert.equal(w.activity.view(s).summaries[0].text.split(' ').length, 50);
  assert.equal(await w.activity.claim(s, 129999), null);
  const second = await w.activity.claim(s, 130000);
  await w.response(id, { jobId: job.id, kind: 'questions', questions: ['Which role?'] });
  await w.activity.response(s, { id: second.id, text: 'Checking roles' }, 131000);
  const final = await w.activity.claim(s, 131001); assert.equal(final.final, true);
  await w.activity.response(s, { id: final.id, text: 'Waiting for the user to clarify roles.' }, 132000);
  assert.equal(await w.activity.claim(s, 200000), null);
  const restarted = new Workbench({ root: w.root, url: w.url }); await restarted.load();
  assert.equal(restarted.public(restarted.get(id)).activity.summaries.length, 3);
});
test('summary errors retry and expired replies are ignored without blocking workflow', async () => {
  const { w, id } = await fixture(); await w.brief(id, 'Feature'); await w.claim(id);
  const s = w.get(id), first = await w.activity.claim(s, 100000);
  const retry = await w.activity.claim(s, 160000);
  await w.activity.response(s, { id: first.id, text: 'Expired' }, 160001);
  assert.equal(w.activity.view(s).summaries.length, 0);
  await w.activity.response(s, { id: retry.id, error: 'Model unavailable' }, 160002);
  assert.match(w.activity.view(s).error, /unavailable/);
  assert.equal(s.status, 'agent_working');
  assert.ok(await w.activity.claim(s, 190000));
});
test('automatic submission defaults on and workspace toggle persists', async () => {
  const { w, id } = await fixture(); assert.equal(w.get(id).autoSubmit, true);
  await w.setAutoSubmit(id, false); await w.brief(id, 'Feature');
  assert.equal((await w.claim(id)).autoSubmit, false);
  const restarted = new Workbench({ root: w.root, url: w.url }); await restarted.load();
  assert.equal(restarted.get(id).autoSubmit, false);
});

test('deletion drains summary writes and ignores late summaries without recreating a workspace', async () => {
  const { w, id, folder } = await fixture();
  await w.brief(id, 'Feature'); const job = await w.claim(id), s = w.get(id);
  await w.response(id, { jobId: job.id, kind: 'questions', questions: ['Which role?'] });
  const summary = await w.activity.claim(s);
  await w.remove(id, id);
  await w.activity.response(s, { id: summary.id, text: 'Late summary' });
  await assert.rejects(fs.stat(folder), { code: 'ENOENT' });
});

test('automatic chat stays responsive and setup log exists while provisioning is blocked', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  await fs.mkdir(tempRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(tempRoot, 'slow-setup-'));
  const w = new Workbench({ root, url: 'http://127.0.0.1:4310', autoOpen: false, provision: () => pending });
  const s = await w.create();
  try {
    const changed = await Promise.race([w.setAutoSubmit(s.id, false), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Toggle blocked behind setup')), 1500); timer.unref(); })]);
    assert.equal(changed.autoSubmit, false);
    assert.equal(changed.status, 'setting_up');
    assert.match(await fs.readFile(path.join(s.folder, '.harness/setup.log'), 'utf8'), /Setup is starting/);
  } finally { release(); await w.locks.get(s.id); }
  assert.equal(w.get(s.id).status, 'awaiting_brief');
  assert.equal((await readJson(path.join(s.folder, '.harness/session.json'))).autoSubmit, false);
});


test('summary history keeps entries beyond 300 and survives restart', async () => {
  const { w, id } = await fixture();
  await w.brief(id, 'Feature'); await w.claim(id);
  const s = w.get(id);
  w.activity.state(s).summaries = Array.from({ length: 300 }, (_, i) => ({ text: `Summary ${i}`, phase: 'requirements', time: new Date().toISOString() }));
  const job = await w.activity.claim(s);
  await w.activity.response(s, { id: job.id, text: 'Newest summary' });
  const restarted = new Workbench({ root: w.root, url: w.url }); await restarted.load();
  const history = restarted.public(restarted.get(id)).activity.summaries;
  assert.equal(history.length, 301);
  assert.equal(history[0].text, 'Summary 0');
  assert.equal(history.at(-1).text, 'Newest summary');
});
