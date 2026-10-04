import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { startServer } from '../src/server.js';
import { json } from '../src/files.js';

const require = createRequire(import.meta.url);
async function waitUntil(check) {
  for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Extension did not reach expected state');
}
async function fixture(t, { auto = false, workspaceAuto = true, autoApprove = true, approvalError, model, commandsAvailable = true, trusted = true, remote = false, containerOnly = false } = {}) {
  await fs.mkdir('.local/extension-tests', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.local/extension-tests/run-'));
  const app = await startServer({ root, port: 0, autoOpen: false, autoApprove, createOnStart: false, provision: async () => {} });
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  const s = await app.workbench.create(); await app.workbench.locks.get(s.id);
  if (remote || containerOnly) {
    const session = app.workbench.get(s.id);
    session.execution = { backend: 'docker-linux' };
    await app.workbench.bridge(session);
    // Container lifecycle is covered separately; this test isolates the host UI bridge.
    app.workbench.ensureContainer = async () => {};
  }
  await app.workbench.setAutoSubmit(s.id, workspaceAuto);
  await app.workbench.brief(s.id, 'Build a team tool');
  const calls = [], logs = [], settings = [], registered = new Map(); let tick;
  let grantTrust;
  const disposable = { dispose() {} };
  const vscode = {
    StatusBarAlignment: { Left: 1 },
    ConfigurationTarget: { Workspace: 2 },
    lm: { selectChatModels: async () => model ? [model] : [] },
    LanguageModelChatMessage: { User: text => ({ role: 'user', content: text }) },
    CancellationTokenSource: class { token = {}; cancel() {} dispose() {} },
    workspace: { isTrusted: trusted, workspaceFolders: [{ uri: { fsPath: remote ? '/workspace' : s.folder, scheme: remote ? 'vscode-remote' : 'file' } }],
      fs: { readFile: async () => new Uint8Array(await fs.readFile(path.join(s.folder, '.harness/bridge.json'))) },
      getConfiguration: section => ({ get: () => auto, update: async (key, value, target) => {
        settings.push({ section, key, value, target, chatsOpened: calls.length });
        if (approvalError) throw new Error(approvalError);
      } }), onDidGrantWorkspaceTrust: fn => { grantTrust = fn; return disposable; }, onDidChangeWorkspaceFolders: () => disposable },
    window: {
      createOutputChannel: () => ({ ...disposable, appendLine: text => logs.push(text) }),
      createStatusBarItem: () => ({ ...disposable, show() {} }),
      showQuickPick: async options => options[0],
      showInformationMessage: async () => undefined, showErrorMessage: async () => undefined
    },
    commands: {
      getCommands: async () => commandsAvailable ? ['workbench.action.chat.newLocalChat', 'workbench.action.chat.open'] : [],
      executeCommand: async (...args) => { calls.push(args); },
      registerCommand: (name, fn) => { registered.set(name, fn); return disposable; }
    },
    env: { openExternal() {} }, Uri: { parse: value => value, joinPath: (uri, ...parts) => ({ ...uri, path: parts.join('/') }) }
  };
  const module = { exports: {} };
  vm.runInNewContext(await fs.readFile('extension/extension.cjs', 'utf8'), {
    module, require: name => name === 'vscode' ? vscode : require(name), fetch, URL, AbortSignal, setTimeout, clearTimeout,
    setInterval: fn => { tick = fn; return 1; }, clearInterval() {}
  });
  await module.exports.activate({ subscriptions: [] });
  if (!trusted || (containerOnly && !remote)) return { app, s, calls, logs, tick, vscode, grantTrust };
  await waitUntil(() => logs.some(line => /Prepared|Submitted|commands are unavailable/.test(line)) || app.workbench.get(s.id).status === 'bridge_error');
  await waitUntil(() => app.workbench.get(s.id).jobs[0].status === 'dispatched');
  // Let the initial poll's finally block release its guard.
  await new Promise(resolve => setTimeout(resolve, 30));
  return { app, s, calls, logs, settings, tick, registered };
}
test('extension prepares a new local agent chat and forwards response files', async t => {
  const { app, s, calls, tick } = await fixture(t);
  assert.equal(calls[0][0], 'workbench.action.chat.newLocalChat');
  assert.equal(calls[1][0], 'workbench.action.chat.open');
  assert.equal(calls[1][1].mode, 'agent'); assert.equal(calls[1][1].isPartialQuery, true);
  const job = app.workbench.get(s.id).jobs[0];
  await json(path.join(s.folder, '.harness/responses', `${job.id}.json`), { jobId: job.id, kind: 'questions', questions: ['Which roles should use this tool?'] });
  await tick();
  assert.equal(app.workbench.get(s.id).status, 'awaiting_human');
  await tick();
  assert.equal(app.workbench.get(s.id).messages.filter(m => m.role === 'ai').length, 1);
});

test('host UI bridge reads remote configuration and forwards container response and progress files', async t => {
  const { app, s, calls, tick } = await fixture(t, { remote: true });
  const job = app.workbench.get(s.id).jobs[0];
  assert.equal(calls[1][0], 'workbench.action.chat.open');
  assert.match(await fs.readFile(path.join(s.folder, '.harness/pending-prompt.md'), 'utf8'), /Linux Docker container/);
  await json(path.join(s.folder, '.harness/progress', `${job.id}.json`), { jobId: job.id, text: 'Ran checks in the container' });
  await json(path.join(s.folder, '.harness/responses', `${job.id}.json`), { jobId: job.id, kind: 'questions', questions: ['Which API?'] });
  await tick();
  assert.equal(app.workbench.get(s.id).status, 'awaiting_human');
  assert.ok(app.workbench.activity.state(app.workbench.get(s.id)).records.some(r => r.text.includes('Ran checks in the container')));
});

test('a Windows folder window cannot dispatch container jobs before attachment', async t => {
  const { app, s, calls, logs, tick } = await fixture(t, { containerOnly: true });
  await tick();
  assert.equal(calls.length, 0);
  assert.equal(app.workbench.get(s.id).jobs[0].status, 'queued');
  assert.ok(logs.some(line => line.includes('attach to its container')));
});
test('extension connects after trust is granted without a window reload', async t => {
  const { app, s, calls, logs, tick, vscode, grantTrust } = await fixture(t, { trusted: false });
  assert.equal(calls.length, 0);
  assert.equal(app.workbench.get(s.id).jobs[0].status, 'queued');
  assert.ok(logs.some(line => line.includes('trust is required')));
  vscode.workspace.isTrusted = true;
  grantTrust();
  await waitUntil(() => calls.length === 2);
  assert.equal(app.workbench.get(s.id).jobs[0].status, 'dispatched');
  await tick();
});
test('automatic submission sends the prompt without waiting for manual input', async t => {
  const { calls } = await fixture(t, { auto: true });
  assert.equal(calls[1][1].isPartialQuery, false);
});

test('server enables tool auto-approval before each new chat, independently of submission', async t => {
  const { settings, app, s, tick, calls } = await fixture(t);
  assert.deepEqual(settings[0], { section: 'chat', key: 'permissions.default', value: 'autoApprove', target: 2, chatsOpened: 0 });
  const job = app.workbench.get(s.id).jobs[0];
  await json(path.join(s.folder, '.harness/responses', `${job.id}.json`), { jobId: job.id, kind: 'questions', questions: ['Which roles?'] });
  await tick();
  await app.workbench.answer(s.id, 'Managers');
  await tick();
  assert.equal(settings[1].value, 'autoApprove');
  assert.equal(settings[1].chatsOpened, 2);
  assert.equal(calls[3][1].isPartialQuery, true);
});

test('server can disable auto-approval and configuration failures prevent submission', async t => {
  const manual = await fixture(t, { autoApprove: false, auto: true });
  assert.equal(manual.settings[0].value, 'default');
  assert.equal(manual.calls[1][1].isPartialQuery, false);
  const failed = await fixture(t, { approvalError: 'Permission setting unavailable' });
  assert.equal(failed.calls.length, 0);
  assert.equal(failed.app.workbench.get(failed.s.id).status, 'bridge_error');
});
test('missing local-chat command produces an actionable bridge error', async t => {
  const { app, s, calls } = await fixture(t, { commandsAvailable: false });
  assert.equal(calls.length, 0);
  assert.equal(app.workbench.get(s.id).status, 'bridge_error');
  assert.match(app.workbench.get(s.id).error, /1.109/);
});

test('dashboard toggle off prepares a prompt even with automatic extension setting on', async t => {
  const { calls } = await fixture(t, { auto: true, workspaceAuto: false });
  assert.equal(calls[1][1].isPartialQuery, true);
});

test('separate summary model receives progress and delivers capped history without opening another chat', async t => {
  const prompts = [];
  const model = { id: 'test-summary', name: 'Summary test', sendRequest: async messages => {
    prompts.push(messages);
    return { text: (async function* () { yield Array(70).fill('progress').join(' '); })() };
  } };
  const { app, s, calls, registered, tick } = await fixture(t, { auto: true, model });
  const job = app.workbench.get(s.id).jobs[0];
  await json(path.join(s.folder, '.harness/progress', `${job.id}.json`), { jobId: job.id, text: 'Read source and identified validation changes' });
  await tick();
  await registered.get('aiWorkbench.enableSummaries')();
  await waitUntil(() => app.workbench.public(app.workbench.get(s.id)).activity.summaries.length === 1);
  assert.equal(calls.length, 2);
  assert.match(prompts[0][1].content, /identified validation/);
  assert.equal(app.workbench.public(app.workbench.get(s.id)).activity.summaries[0].text.split(' ').length, 50);
});
