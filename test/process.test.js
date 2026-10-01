import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareCodeArgs } from '../src/process.js';

test('new workspaces use distinct development hosts and the correct folder', async () => {
  await fs.mkdir('.local/process-tests', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.local/process-tests/run-'));
  const extension = path.resolve('extension');
  const firstFolder = path.join(root, 'first workspace');
  const secondFolder = path.join(root, 'second workspace');
  const first = await prepareCodeArgs(firstFolder, extension);
  const second = await prepareCodeArgs(secondFolder, extension);
  assert.ok(first.includes('--new-window'));
  assert.ok(second.includes('--new-window'));
  assert.equal(first.at(-1), firstFolder);
  assert.equal(second.at(-1), secondFolder);
  const bridgePath = args => args.find(arg => arg.startsWith('--extensionDevelopmentPath=')).split('=').slice(1).join('=');
  assert.notEqual(bridgePath(first), bridgePath(second));
  for (const args of [first, second]) {
    const copied = bridgePath(args);
    assert.equal(path.dirname(path.dirname(copied)), args.at(-1));
    assert.equal(await fs.readFile(path.join(copied, 'extension.cjs'), 'utf8'), await fs.readFile(path.join(extension, 'extension.cjs'), 'utf8'));
    assert.equal(JSON.parse(await fs.readFile(path.join(copied, 'package.json'), 'utf8')).name, 'ai-workbench-bridge');
  }
  // Opening an existing workspace updates its bridge without taking another host's identity.
  await fs.writeFile(path.join(bridgePath(first), 'extension.cjs'), 'outdated bridge');
  const reopened = await prepareCodeArgs(firstFolder, extension);
  assert.equal(bridgePath(reopened), bridgePath(first));
  assert.equal(await fs.readFile(path.join(bridgePath(reopened), 'extension.cjs'), 'utf8'), await fs.readFile(path.join(extension, 'extension.cjs'), 'utf8'));
});
