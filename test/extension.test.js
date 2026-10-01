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
async function fixture(t, { auto = false, workspaceAuto = true, model, commandsAvailable = true, trusted = true } = {}) {
  await fs.mkdir('.local/extension-tests', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.local/extension-tests/run-'));
  const app = await startServer({ root, port: 0, autoOpen: false, createOnStart: false, provision: async () => {} });
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  const s = await app.workbench.create(); await app.workbench.locks.get(s.id);
  await app.workbench.setAutoSubmit(s.id, workspaceAuto);
  await app.workbench.brief(s.id, 'Build a team tool');
  const calls = [], logs = [], registered = new Map(); let tick;
  let grantTrust;
  const disposable = { dispose() {} };
  const vscode = {
    StatusBarAlignment: { Left: 1 },
    lm: { selectChatModels: async () => model ? [model] : [] },
    LanguageModelChatMessage: { User: text => ({ role: 'user', content: text }) },
    CancellationTokenSource: class { token = {}; cancel() {} dispose() {} },
    workspace: { isTrusted: trusted, workspaceFolders: [{ uri: { fsPath: s.folder } }], getConfiguration: () => ({ get: () => auto }), onDidGrantWorkspaceTrust: fn => { grantTrust = fn; return disposable; }, onDidChangeWorkspaceFolders: () => disposable },
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
    env: { openExternal() {} }, Uri: { parse: value => value }
  };
  const module = { exports: {} };
  vm.runInNewContext(await fs.readFile('extension/extension.cjs', 'utf8'), {
    module, require: name => name === 'vscode' ? vscode : require(name), fetch, URL, AbortSignal, setTimeout, clearTimeout,
    setInterval: fn => { tick = fn; return 1; }, clearInterval() {}
  });
  await module.exports.activate({ subscriptions: [] });
  if (!trusted) return { app, s, calls, logs, tick, vscode, grantTrust };
  await waitUntil(() => logs.some(line => /Prepared|Submitted|commands are unavailable/.test(line)));
  await waitUntil(() => app.workbench.get(s.id).jobs[0].status === 'dispatched');
  // Let the initial poll's finally block release its guard.
  await new Promise(resolve => setTimeout(resolve, 30));
  return { app, s, calls, logs, tick, registered };
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
