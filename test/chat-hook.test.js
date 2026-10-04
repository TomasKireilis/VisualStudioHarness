import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startServer } from '../src/server.js';
import { json, readJson } from '../src/files.js';

async function fixture(t, options = {}) {
  await fs.mkdir('.local/chat-hook-tests', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.local/chat-hook-tests/run-'));
  const app = await startServer({ root, port: 0, autoOpen: false, createOnStart: false, provision: async () => {}, ...options });
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  const s = await app.workbench.create();
  await app.workbench.locks.get(s.id);
  await app.workbench.brief(s.id, 'Build a team tool');
  const job = await app.workbench.claim(s.id);
  const replyFile = path.join(s.folder, '.harness/responses', `${job.id}.json`);
  const hook = event => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(s.folder, '.harness/chat/question-hook.cjs')], { cwd: s.folder, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code ? reject(new Error(stderr)) : resolve(JSON.parse(stdout)));
    child.stdin.end(JSON.stringify({ session_id: 'test-chat', ...event }));
  });
  await hook({ hook_event_name: 'UserPromptSubmit', prompt: job.prompt });
  return { ...app, s, root, job, replyFile, hook };
}

test('native question fallback writes the normal reply JSON and finishes through the authenticated bridge', async t => {
  const { workbench, url, s, job, replyFile, hook } = await fixture(t);
  const result = await hook({ hook_event_name: 'PreToolUse', tool_name: 'vscode_askQuestions', tool_input: {
    questions: [{ question: 'Which roles can edit?', options: [{ label: 'Managers', description: 'Managers only' }, { label: 'Everyone' }] }, 'Which database?']
  } });
  assert.equal(result.continue, false);
  assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(result.stopReason, /new request/);
  const reply = await readJson(replyFile);
  assert.equal(reply.kind, 'questions');
  assert.equal(reply.jobId, job.id);
  assert.deepEqual(reply.questions, ['Which roles can edit?\n- Managers — Managers only\n- Everyone', 'Which database?']);
  assert.equal(workbench.get(s.id).status, 'agent_working', 'Only the normal bridge advances the workflow');
  const response = await fetch(`${url}/bridge/${s.id}/response`, {
    method: 'POST', headers: { Authorization: `Bearer ${workbench.get(s.id).token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(reply)
  });
  assert.equal(response.status, 200);
  const view = await response.json();
  assert.equal(view.status, 'awaiting_human');
  assert.equal(view.jobs[0].status, 'complete');
  assert.deepEqual(view.questions, reply.questions);
  assert.equal(await workbench.claim(s.id), null);
  await workbench.response(s.id, reply);
  assert.equal(workbench.get(s.id).messages.filter(m => m.role === 'ai').length, 1);
  await workbench.answer(s.id, 'Managers; SQLite');
  const next = await workbench.claim(s.id);
  assert.notEqual(next.id, job.id);
  assert.match(await fs.readFile(path.join(s.folder, '.harness/conversation.json'), 'utf8'), /SQLite/);
  assert.deepEqual(await hook({ hook_event_name: 'PreToolUse', tool_name: 'ask_questions', tool_input: { questions: ['Late question?'] } }), {});
});

test('normal structured replies take precedence over fallback questions', async t => {
  const { hook, job, replyFile } = await fixture(t);
  const original = { jobId: job.id, kind: 'questions', questions: ['Normal structured question?'] };
  await json(replyFile, original);
  assert.deepEqual(await hook({ hook_event_name: 'PreToolUse', tool_name: 'ask_questions', tool_input: { questions: ['Fallback?'] } }), {});
  assert.deepEqual(await readJson(replyFile), original);
});

test('Stop recovers only the current final assistant questions, leaving reasoning out', async t => {
  const { hook, s, job, replyFile } = await fixture(t);
  const transcript = path.join(s.folder, '.harness/transcript.jsonl');
  await fs.writeFile(transcript, [
    { type: 'user.message', data: { content: 'Old prompt' } },
    { type: 'assistant.message', data: { content: 'Old question?' } },
    { type: 'user.message', data: { content: job.prompt } },
    { type: 'assistant.message', data: { content: 'Before I continue:\n1. Which roles?\n2. Which database?\n```js\nconst example = "Ignore this?";\n```', toolRequests: [], reasoningText: 'Private reasoning?' } }
  ].map(entry => JSON.stringify(entry)).join('\n'));
  assert.equal((await hook({ hook_event_name: 'Stop', transcript_path: transcript })).continue, false);
  const reply = await readJson(replyFile);
  assert.deepEqual(reply.questions, ['Which roles?', 'Which database?']);
  assert.doesNotMatch(JSON.stringify(reply), /Old question|Private reasoning|Ignore this/);
  assert.match(reply.message, /Before I continue/);
});

test('unrelated chats, ordinary tools, malformed questions and completion prose leave the main flow alone', async t => {
  const { hook, s, job, replyFile } = await fixture(t);
  for (const event of [
    { hook_event_name: 'PreToolUse', session_id: 'another-chat', tool_name: 'ask_questions', tool_input: { questions: ['Wrong chat?'] } },
    { hook_event_name: 'PreToolUse', tool_name: 'run_in_terminal', tool_input: { questions: ['Embedded data?'] } },
    { hook_event_name: 'PreToolUse', tool_name: 'ask_questions', tool_input: { questions: [{ header: 'Missing question' }, '', null] } }
  ]) assert.deepEqual(await hook(event), {});
  const transcript = path.join(s.folder, '.harness/transcript.jsonl');
  for (const content of ['Work is complete.', 'Implemented validation for the example "Which roles?".']) {
    await fs.writeFile(transcript, [
      { type: 'user.message', data: { content: job.prompt } },
      { type: 'assistant.message', data: { content, reasoningText: 'Reasoning question?' } }
    ].map(entry => JSON.stringify(entry)).join('\n'));
    assert.deepEqual(await hook({ hook_event_name: 'Stop', transcript_path: transcript }), {});
  }
  await fs.writeFile(transcript, '{partial');
  assert.deepEqual(await hook({ hook_event_name: 'Stop', transcript_path: transcript }), {});
  await assert.rejects(fs.access(replyFile), { code: 'ENOENT' });
  // Manually sending another prompt in the same chat must invalidate its binding.
  await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'An unrelated manual request' });
  assert.deepEqual(await hook({ hook_event_name: 'PreToolUse', tool_name: 'vscode_askQuestions', tool_input: { questions: ['Manual chat question?'] } }), {});
  await assert.rejects(fs.access(replyFile), { code: 'ENOENT' });
});

test('server provisions Local hooks and persists its new-chat auto-approval choice', async t => {
  const { workbench, s, root, job } = await fixture(t, { autoApprove: false });
  assert.equal(job.autoApprove, false);
  const config = await readJson(path.join(s.folder, '.github/hooks/ai-workbench.json'));
  assert.deepEqual(Object.keys(config.hooks), ['UserPromptSubmit', 'PreToolUse', 'Stop']);
  assert.equal(config.hooks.PreToolUse[0].command, 'node .harness/chat/question-hook.cjs');
  const { Workbench } = await import('../src/workbench.js');
  const restarted = new Workbench({ root, url: workbench.url, autoOpen: false });
  await restarted.load();
  assert.equal(restarted.get(s.id).autoApprove, false);
  assert.match(job.prompt, /LAST RESORT only/);
  assert.match(job.prompt, /end this request immediately/);
});
