// Last-resort question recovery for VS Code's Local Copilot Agent hooks.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const harness = path.resolve(__dirname, '..');
const notice = 'AI Workbench saved your questions to the response JSON. This request is finished. Answer in the dashboard; a new request will continue with the answers. Do not wait for answers in this chat or continue editing.';

function nativeQuestions(input) {
  if (!Array.isArray(input?.questions)) return [];
  return input.questions.map(item => {
    if (typeof item === 'string') return item.trim();
    if (!item || typeof item.question !== 'string' || !item.question.trim()) return '';
    const options = Array.isArray(item.options) ? item.options.map(option => {
      if (typeof option === 'string') return option;
      return typeof option?.label === 'string' ? `${option.label}${option.description ? ` — ${option.description}` : ''}` : '';
    }).filter(Boolean) : [];
    return [item.question.trim(), ...options.map(option => `- ${option}`)].join('\n');
  }).filter(Boolean);
}

async function chatQuestions(transcriptPath, prompt) {
  if (typeof transcriptPath !== 'string') return {};
  const stat = await fs.stat(transcriptPath);
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return {};
  // Only inspect public assistant content in the current turn, never reasoning.
  const entries = (await fs.readFile(transcriptPath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  const userIndex = entries.findLastIndex(entry => entry.type === 'user.message');
  if (userIndex < 0 || entries[userIndex].data?.content !== prompt) return {};
  const message = entries.slice(userIndex + 1).findLast(entry => entry.type === 'assistant.message');
  if (typeof message?.data?.content !== 'string' || message.data.toolRequests?.length) return {};
  const text = message.data.content.replace(/```[\s\S]*?```/g, '').trim();
  // Recover explicit questions only; ordinary completion text stays in chat.
  const questions = text.split('\n').map(line => line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, '').trim())
    .filter(line => /\?\s*[*_]*$/.test(line) && !/^>/.test(line));
  return { questions, message: text }; // Preserve context and choices beside the questions.
}

async function handle(event) {
  if (typeof event.session_id !== 'string' || !event.session_id) return {};
  const session = JSON.parse(await fs.readFile(path.join(harness, 'session.json'), 'utf8'));
  const bindingDir = path.join(harness, 'chat-sessions');
  const bindingFile = path.join(bindingDir, `${crypto.createHash('sha256').update(event.session_id).digest('hex')}.json`);
  if (event.hook_event_name === 'UserPromptSubmit') {
    const job = session.jobs.find(job => job.status === 'dispatched' && job.prompt === event.prompt);
    if (!job) { await fs.rm(bindingFile, { force: true }); return {}; }
    await fs.mkdir(bindingDir, { recursive: true });
    await fs.writeFile(bindingFile, JSON.stringify({ jobId: job.id }));
    return {};
  }
  if (!['PreToolUse', 'Stop'].includes(event.hook_event_name)) return {};
  const binding = JSON.parse(await fs.readFile(bindingFile, 'utf8'));
  const job = session.jobs.find(job => job.id === binding.jobId && job.status === 'dispatched');
  if (!job || !/^[a-f0-9-]+$/i.test(job.id)) return {};
  const replyFile = path.join(harness, 'responses', `${job.id}.json`);
  try { await fs.access(replyFile); return {}; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let questions, message = 'The AI needs your input to continue.';
  if (event.hook_event_name === 'PreToolUse') {
    if (!/^(?:vscode_)?ask_?questions$/i.test(event.tool_name || '')) return {};
    questions = nativeQuestions(event.tool_input);
  } else {
    ({ questions, message } = await chatQuestions(event.transcript_path, job.prompt));
  }
  if (!questions?.length) return {};
  const reply = { jobId: job.id, kind: 'questions', message, questions };
  if (Buffer.byteLength(JSON.stringify(reply)) > 1024 * 1024) throw new Error('Questions exceed the response size limit');
  // Exclusive creation preserves the agent's normal reply if it wins the race.
  try { await fs.writeFile(replyFile, JSON.stringify(reply, null, 2), { flag: 'wx' }); }
  catch (error) { if (error.code === 'EEXIST') return {}; throw error; }
  return {
    continue: false, stopReason: notice, systemMessage: notice,
    ...(event.hook_event_name === 'PreToolUse' ? { hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: notice, additionalContext: notice
    } } : {})
  };
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 1024 * 1024) throw new Error('Hook input exceeds 1 MB');
  }
  try { process.stdout.write(JSON.stringify(await handle(JSON.parse(input)))); }
  catch (error) {
    if (error.code !== 'ENOENT') process.stderr.write(`AI Workbench question recovery: ${error.message}\n`);
    process.stdout.write('{}'); // A recovery failure must not disrupt normal work.
  }
}
main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
