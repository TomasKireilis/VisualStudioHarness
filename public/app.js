const $ = selector => document.querySelector(selector);
const token = $('meta[name="workbench-token"]').content;
let sessions = [], selected = localStorage.getItem('workbench.selected'), signature = '', busy = false;
const viewedPhases = new Map();
const phases = ['requirements', 'development', 'demo'];
const working = s => ['setting_up', 'waiting_for_agent', 'agent_working', 'demo_pending', 'recording'].includes(s.status);
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const labels = { setting_up: 'Preparing environment', awaiting_brief: 'Ready for your idea', waiting_for_agent: 'Waiting for VS Code', agent_working: 'With the AI', awaiting_human: 'Your input needed', requirements_ready: 'Ready for review', bridge_error: 'Bridge needs attention', error: 'Setup needs attention', demo_pending: 'Preparing demo', recording: 'Recording demo', demo_failed: 'Demo needs attention', complete: 'Complete' };
const guidance = { requirements: 'Describe the outcome you want. The AI will ask about anything that needs more detail. Review the requirements before development starts.', development: 'Follow progress in VS Code. If the AI needs a decision, its questions will appear here. Your approved requirements stay in the project folder.', demo: 'UI changes get a recorded walkthrough. The change report includes affected files, before and after code, and the checks reported by your AI.' };
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; setTimeout(() => $('#toast').hidden = true, 9000); }
async function api(url, data, method) {
  const response = await fetch(url, { method: method || (data === undefined ? 'GET' : 'POST'), headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': token }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(url.endsWith('/rollback') ? 200000 : 15000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}
const current = () => sessions.find(s => s.id === selected);
async function deleteWorkspace(id) {
  if (busy) return;
  const workspace = sessions.find(s => s.id === id);
  if (!workspace || !confirm(`Permanently delete "${workspace.title}"?\n\n${workspace.folder}\n\nThis removes all project files, conversations, and recordings. This cannot be undone.`)) return;
  busy = true;
  try {
    await api(`/api/sessions/${id}`, { confirmId: id }, 'DELETE');
    if (selected === id) { selected = undefined; localStorage.removeItem('workbench.selected'); signature = ''; }
    await refresh();
    toast('Workspace deleted.');
  } catch (error) { toast(error.message); }
  finally { busy = false; }
}
const fileUrl = (s, file) => `/api/sessions/${s.id}/file?path=${encodeURIComponent(file)}&token=${token}`;
async function action(name, data = {}) {
  if (busy) return;
  busy = true;
  const controls = [...document.querySelectorAll('button')]; controls.forEach(b => b.disabled = true);
  const toggle = $('#auto-submit');
  if (name === 'auto-submit') toggle.textContent = 'Saving chat setting…';
  try { await api(`/api/sessions/${selected}/${name}`, data); if (['rollback', 'approve', 'answer', 'brief'].includes(name)) viewedPhases.delete(selected); signature = ''; await refresh(); }
  catch (error) { toast(error.message); }
  finally { busy = false; controls.forEach(b => b.disabled = false); render(); }
}
function conversation(s) {
  const messages = s.messages.filter(m => {
    const job = s.jobs.findLast(j => j.createdAt <= m.time);
    return (m.phase || (job?.kind === 'demo_review' ? 'demo' : job?.kind) || 'requirements') === s.phase;
  });
  return messages.length ? `<div class="conversation">${messages.map(m => `<div class="message ${m.role === 'human' ? 'human' : ''}"><strong>${m.role === 'human' ? 'You' : 'Your AI'}</strong>${esc(m.text)}${m.questions?.length ? `<ol>${m.questions.map(q => `<li>${esc(q)}</li>`).join('')}</ol>` : ''}</div>`).join('')}</div>` : '';
}
function errorBox(s) { return s.error ? `<div class="error-box" role="alert">${esc(s.error)}</div>` : ''; }
function content(s, viewedPhase = s.phase) {
  if (viewedPhase !== s.phase) {
    const previous = phases.indexOf(viewedPhase) < phases.indexOf(s.phase);
    return `<p class="browse-note">${previous ? 'Viewing previous work.' : 'This step has not started yet.'} ${esc(labels[s.status])} in ${esc(s.phase)}. Browsing does not interrupt the active step.</p>${conversation({ ...s, phase: viewedPhase })}${viewedPhase === 'requirements' && s.requirements ? `${assessment(s)}<h3>Approved requirements</h3><pre class="report">${esc(s.requirements)}</pre>` : ''}`;
  }

  if (s.status === 'awaiting_brief') return `<p>What would you like to create? A rough idea is a great start.<br>Your AI will help turn it into clear, buildable requirements.</p><form id="brief-form"><label for="brief">Describe your project</label><textarea id="brief" required maxlength="100000" placeholder="I want to build an internal tool that helps our team…"></textarea><div class="form-bottom"><span class="hint">Include who it’s for and what it should do.</span><button class="primary" type="submit">Start the conversation <span>↗</span></button></div></form><div class="suggestions"><button data-example="A team dashboard to track projects, owners, and upcoming deadlines.">A team dashboard</button><button data-example="An internal tool for employees to request equipment and managers to approve it.">An internal tool</button><button data-example="A backend API for managing inventory, with validation, authentication, and an audit trail.">A backend service</button></div><div class="brief-note"><span>✧</span><p>No perfect prompts needed. Your AI will ask follow-up questions,<br>then save a requirements document for you to approve.</p></div>`;
  if (s.status === 'setting_up' || s.status === 'error') return `<div class="empty-state"><div class="empty-icon">⌘</div><h3>${s.status === 'error' ? 'Let’s get the environment ready' : 'Making room for your next idea'}</h3><p>A fresh project folder is ready. We’re preparing Playwright and Chromium for video recording. The installation log shows progress and any errors.</p></div>${errorBox(s)}<div class="actions">${s.status === 'error' ? '<button class="primary" data-action="setup">Retry environment setup</button>' : ''}<a class="secondary" target="_blank" href="${fileUrl(s, '.harness/setup.log')}">View installation log ↗</a></div>`;
  if (s.status === 'requirements_ready') return `${conversation(s)}${assessment(s)}<p>Review the requirements below. You can edit them before starting development.</p><label for="requirements">REQUIREMENTS.md</label><textarea id="requirements">${esc(s.requirements)}</textarea><div class="actions"><button class="primary" id="approve">Approve & start development ↗</button></div><details><summary>Ask for a revision</summary>${answerForm('Describe what should change…')}</details>`;
  if (s.status === 'awaiting_human') return `${conversation(s)}<p>Your AI needs a little direction before continuing.</p>${questionForm(s.questions || [])}`;
  if (s.phase === 'demo' && !['waiting_for_agent', 'agent_working', 'bridge_error'].includes(s.status)) return `<div class="empty-state"><div class="empty-icon">${working(s) ? '<span class="spinner" aria-label="Working"></span>' : s.status === 'complete' ? '✓' : '▷'}</div><h3>${s.status === 'complete' ? 'Your work is ready to review' : s.status === 'demo_failed' ? 'The walkthrough needs attention' : 'Capturing your solution in action'}</h3><p>${s.uiChanged ? 'Review the recorded UI walkthrough and the source change report.' : 'Your backend change report includes impact notes, captured code changes and reported validation.'}</p></div>${errorBox(s)}${conversation(s)}${['complete', 'demo_failed'].includes(s.status) ? '<div class="actions"><button class="secondary" data-action="review-demo">Ask AI to review demo</button></div>' : ''}${s.artifacts.filter(f => f.endsWith('/walkthrough.webm')).slice(-1).map(f => `<video controls preload="metadata" src="${fileUrl(s, f)}" aria-label="Recorded application walkthrough"></video>`).join('')}<div class="artifacts">${s.artifacts.map(f => `<a class="artifact" href="${fileUrl(s, f)}" target="_blank" rel="noopener">${esc(f.replace('artifacts/', ''))}<span>↗</span></a>`).join('')}</div>${s.artifacts.includes('artifacts/impact.md') ? '<details><summary>Read the change report</summary><pre class="report" id="report">Loading report…</pre></details>' : ''}${['complete', 'demo_failed'].includes(s.status) && s.uiChanged ? '<div class="actions"><button class="secondary" data-action="demo">Record demo again</button></div>' : ''}`;
  return `${conversation(s)}<div class="empty-state"><div class="empty-icon">${working(s) ? '<span class="spinner" aria-label="Working"></span>' : '✧'}</div><h3>${s.status === 'waiting_for_agent' ? 'Ready to connect with your AI' : s.status === 'bridge_error' ? 'The chat bridge needs attention' : 'Your AI has the next step'}</h3><p>${s.status === 'waiting_for_agent' ? 'Open this workspace in VS Code, trust the folder and sign in to Copilot. The bridge will pick up the request.' : 'Follow the work in VS Code. If automatic submission is off, press Send in the prepared Copilot chat. Questions and results will arrive here.'}</p></div>${errorBox(s)}<div class="actions"><button class="secondary" data-action="open">Open VS Code ↗</button>${s.jobs.some(j => j.status === 'dispatched') ? '<button class="secondary" id="retry-job">Retry interrupted request</button>' : ''}</div><details><summary>View the current prompt</summary><pre class="report">${esc(s.jobs.at(-1)?.prompt || '')}</pre></details>`;
}
function assessment(s) {
  const a = s.assessment;
  if (!a) return '';
  return `<div class="assessment"><h3>Feasibility and implementation</h3><p>${esc(a.evidence)}</p>${[['steps', 'Implementation steps'], ['technologies', 'Technologies'], ['codeImpact', 'Existing code impact']].map(([key, label]) => `<strong>${label}</strong><ul>${(a[key] || []).map(item => `<li>${esc(item)}</li>`).join('')}</ul>`).join('')}</div>`;
}
function questionForm(questions) {
  if (!questions.length) return answerForm('What would you like the AI to know?');
  return `<form id="question-form"><p>Answer each question below, then send all answers together.</p>${questions.map((question, i) => `<div class="question-answer"><label for="question-answer-${i}">${i + 1}. ${esc(question)}</label><textarea id="question-answer-${i}" data-answer-index="${i}" required maxlength="100000" placeholder="Your answer…"></textarea></div>`).join('')}<div class="form-bottom"><span class="hint">Each answer will be sent with its question.</span><button class="primary">Send & continue ↗</button></div></form>`;
}
function answerForm(placeholder) { return `<form id="answer-form"><label for="answer">Your response</label><textarea id="answer" required maxlength="100000" placeholder="${placeholder}"></textarea><div class="form-bottom"><span class="hint">Saved with the conversation in your workspace.</span><button class="primary">Send & continue ↗</button></div></form>`; }
function render() {
  const s = current();
  $('#workspace-count').textContent = sessions.length;
  $('#workspaces').innerHTML = sessions.map(item => `<div class="workspace-row ${item.id === selected ? 'active' : ''}"><button class="workspace ${item.id === selected ? 'active' : ''}" data-id="${item.id}" title="${esc(item.title)}">▱ &nbsp;${esc(item.title)}<small>${labels[item.status] || item.status}</small></button><button class="delete-workspace" data-delete="${item.id}" aria-label="Delete workspace ${esc(item.title)}" title="Delete workspace">×</button></div>`).join('');
  $('#open-code').disabled = !s;
  $('#auto-submit').disabled = !s;
  if (!s) {
    $('#current-activity').textContent = ''; $('#summaries').innerHTML = ''; $('#summary-status').textContent = ''; $('#rollback-controls').innerHTML = '';
    signature = ''; $('#breadcrumb').textContent = 'Getting started'; $('#panel-title').textContent = 'Your workspaces';
    $('#folder-name').textContent = 'No workspace selected'; $('#folder-path').textContent = 'Create a workspace to begin';
    $('#bridge-status').textContent = '—'; $('#playwright-status').textContent = '—'; $('#activity').innerHTML = '';
    $('#status').textContent = 'Ready'; $('#status').className = 'pill'; $('#phase-label').textContent = 'GET STARTED';
    document.querySelectorAll('.step').forEach(step => { step.className = 'step'; step.querySelector('.step-mark').textContent = ''; step.setAttribute('aria-current', 'false'); });
    $('#workspace-content').innerHTML = '<div class="empty-state"><h3>Create your first workspace</h3><p>Choose New workspace to get started.</p></div>'; return;
  }
  const viewedPhase = viewedPhases.get(s.id) || s.phase;
  $('#auto-submit').textContent = `Automatic chat: ${s.autoSubmit !== false ? 'On' : 'Off'}`;
  $('#auto-submit').setAttribute('aria-pressed', String(s.autoSubmit !== false));
  $('#auto-submit').onclick = () => action('auto-submit', { enabled: s.autoSubmit === false });
  $('#current-activity').textContent = s.activity?.latest?.text ? `Latest activity: ${s.activity.latest.text.slice(0, 500)}` : '';
  const history = s.activity?.summaries || [];
  $('#summary-status').textContent = s.activity?.error ? `Summary unavailable: ${s.activity.error}` : `${labels[s.status] || s.status}. ${history.length ? 'Previous summaries are kept below. New summaries arrive during work.' : 'In VS Code, run “AI Workbench: Enable Activity Summaries” to start live summaries.'}`;
  const historyHtml = history.slice().reverse().map(e => `<li><strong>${esc(e.phase)}${e.final ? ' · finished' : ''}</strong><br>${esc(e.text)}<time>${new Date(e.time).toLocaleString()}</time></li>`).join('');
  if ($('#summaries').innerHTML !== historyHtml) $('#summaries').innerHTML = historyHtml;
  $('#breadcrumb').textContent = s.title;
  $('#folder-name').textContent = s.id;
  $('#folder-path').textContent = s.folder;
  $('#bridge-status').textContent = s.connected ? '● Connected' : '○ Not connected';
  $('#playwright-status').textContent = s.demoReady ? '✓ Ready' : s.status === 'error' ? 'Setup failed' : 'Preparing';
  $('#guidance-text').textContent = guidance[viewedPhase];
  $('#status').textContent = labels[s.status] || s.status;
  $('#status').className = `pill ${/error|failed/.test(s.status) ? 'error' : ''}`;
  document.querySelectorAll('.step').forEach(step => {
    const i = phases.indexOf(step.dataset.phase), active = phases.indexOf(s.phase);
    step.className = `step ${step.dataset.phase === viewedPhase ? 'active' : ''} ${i < active ? 'done' : ''}`;
    step.querySelector('.step-mark').innerHTML = i === active && working(s) ? '<span class="spinner" aria-label="Working"></span>' : i === active && s.status === 'awaiting_human' ? '?' : i < active || s.status === 'complete' && i === active ? '✓' : '';
    step.setAttribute('aria-current', i === active ? 'step' : 'false');
    step.setAttribute('aria-pressed', String(step.dataset.phase === viewedPhase));
  });
  $('#phase-label').textContent = `STEP 0${phases.indexOf(viewedPhase) + 1} / ${viewedPhase.toUpperCase()}`;
  $('#panel-title').textContent = viewedPhase === 'requirements' ? s.status === 'awaiting_brief' ? 'Start with your idea' : 'Shape the requirements' : viewedPhase === 'development' ? 'Building your solution' : 'The result, made visible';
  $('#activity').innerHTML = s.events.slice(-6).reverse().map(e => `<li>${esc(e.text)}<time>${new Date(e.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></li>`).join('');
  $('#updated').textContent = 'Connected to local server';
  const nextSignature = JSON.stringify([s.id, s.phase, viewedPhase, s.status, s.questions, s.messages, s.requirements, s.error, s.artifacts, s.jobs.map(j => j.status)]);
  if (signature === nextSignature) return;
  signature = nextSignature;
  const returnPhase = phases.indexOf(viewedPhase) < phases.indexOf(s.phase) ? viewedPhase : phases[phases.indexOf(s.phase) - 1];
  $('#rollback-controls').innerHTML = ['development', 'demo'].includes(s.phase) ? `<details><summary>Return to previous step</summary><form id="rollback-form"><p>Reopen ${returnPhase} with your feedback. Current files and review history are kept.${s.status === 'recording' ? ' The return will wait for recording to finish.' : ''}</p><label for="rollback-reason">Bug or question to resolve</label><textarea id="rollback-reason" required maxlength="100000"></textarea>${s.jobs.some(j => j.status === 'dispatched') ? '<label><input id="agent-stopped" type="checkbox" required> I stopped the active Copilot request in VS Code</label>' : ''}<button class="secondary">Return & continue</button></form></details>` : '';
  $('#rollback-form')?.addEventListener('submit', e => { e.preventDefault(); action('rollback', { phase: returnPhase, reason: $('#rollback-reason').value, stopped: $('#agent-stopped')?.checked || false }); });
  $('#workspace-content').innerHTML = content(s, viewedPhase);
  if ($('#report')) fetch(fileUrl(s, 'artifacts/impact.md')).then(r => r.text()).then(text => { if ($('#report') && selected === s.id) $('#report').textContent = text; }).catch(() => {});
  $('#brief-form')?.addEventListener('submit', e => { e.preventDefault(); action('brief', { text: $('#brief').value }); });
  $('#question-form')?.addEventListener('submit', e => {
    e.preventDefault();
    const answers = [...e.currentTarget.querySelectorAll('[data-answer-index]')];
    const blank = answers.find(field => !field.value.trim());
    if (blank) { blank.focus(); toast('Please answer each question before continuing.'); return; }
    const text = answers.map((field, i) => `Question ${i + 1}: ${s.questions[i]}\nAnswer: ${field.value.trim()}`).join('\n\n');
    if (text.length > 100000) { toast('Please shorten your answers; the combined response exceeds 100,000 characters.'); return; }
    action('answer', { text });
  });
  $('#answer-form')?.addEventListener('submit', e => { e.preventDefault(); action('answer', { text: $('#answer').value }); });
  $('#approve')?.addEventListener('click', () => action('approve', { requirements: $('#requirements').value }));
  $('#retry-job')?.addEventListener('click', () => { if (confirm('Stop the old Copilot request first. Send a new attempt?')) action('retry-job'); });
}
async function refresh() { try { sessions = (await api('/api/sessions')).sessions; if (!sessions.some(s => s.id === selected)) selected = sessions[0]?.id; render(); } catch (error) { $('#updated').textContent = 'Server unavailable · reconnecting'; } }
document.addEventListener('click', e => {
  const step = e.target.closest('[data-phase]');
  if (step && current()) { viewedPhases.set(selected, step.dataset.phase); render(); return; }
  const deletion = e.target.closest('[data-delete]'); if (deletion) { deleteWorkspace(deletion.dataset.delete); return; }
  const workspace = e.target.closest('[data-id]');
  if (workspace) { selected = workspace.dataset.id; localStorage.setItem('workbench.selected', selected); signature = ''; render(); }
  const button = e.target.closest('[data-action]'); if (button) action(button.dataset.action);
  const example = e.target.closest('[data-example]'); if (example && $('#brief')) { $('#brief').value = example.dataset.example; $('#brief').focus(); }
});
$('#open-code').addEventListener('click', () => selected && action('open'));
$('#new-project').addEventListener('click', async () => {
  if (busy) return; busy = true; $('#new-project').disabled = true;
  try { const result = await api('/api/sessions', {}); selected = result.id; localStorage.setItem('workbench.selected', selected); signature = ''; await refresh(); }
  catch (error) { toast(error.message); }
  finally { busy = false; $('#new-project').disabled = false; }
});
await refresh(); setInterval(refresh, 2000);
