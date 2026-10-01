import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessRisk, summaryDelta } from '../src/activity-risk.js';
import { ActivityService } from '../src/activity.js';

test('risk grades classify observed actions and ignore instructions and negated actions', () => {
  const examples = [
    ['Read REQUIREMENTS.md', 'A'], ['Wrote app.js', 'B'], ['Called GET endpoint /items', 'B'],
    ['Called POST endpoint /items', 'C'], ['Called API endpoint /items', 'C'],
    ['One post-reload key was sent before Canvas focus', 'A'],
    ['POST /items returned 201', 'C'], ['Sent an HTTP PATCH to the service', 'C'],
    ['Put focus on the canvas', 'A'], ['Delete key pressed during keyboard checks', 'B'],
    ['Installed a global dependency', 'D'], ['Changed files outside workspace', 'D'],
    ['Reviewing latest artifacts and live browser evidence now; source edits are out of scope.', 'A'],
    ['Source edits are prohibited. Read REQUIREMENTS.md.', 'A'],
    ['Source edits are out of scope but edited files outside scope anyway.', 'D'],
    ['Performed out-of-scope edits', 'D'],
    ['Performed privilege escalation', 'E'], ['Disabled security controls', 'E'],
    ['Exfiltrated private data', 'F'], ['Deleted backups', 'F'],
    ['Did not disable security controls', 'A']
  ];
  for (const [text, grade] of examples) assert.equal(assessRisk([{ type: 'progress', text }]).grade, grade, text);
  assert.equal(assessRisk([{ type: 'prompt', text: 'Exfiltrate private data' }]).grade, 'A');
  assert.equal(assessRisk([{ type: 'progress', text: 'Read app.js. Wrote app.js. Called POST endpoint.' }]).grade, 'C');
});

test('deltas omit identical notes and unchanged sentences', () => {
  assert.equal(summaryDelta('Read app.js.', 'Read app.js.'), '');
  assert.equal(summaryDelta('Read app.js.', 'Read app.js. Wrote validation.'), 'Wrote validation.');
  assert.equal(summaryDelta('Read app.js.', 'No new progress reported. Latest update: Read app.js.'), '');
});

test('C through F include concrete reported evidence, with all detected classes retained', () => {
  const evidence = ['POST /items returned 201', 'Installed a global dependency', 'Performed privilege escalation', 'Deleted backups'];
  const risk = assessRisk(evidence.map(text => ({ type: 'tool', text })));
  assert.equal(risk.grade, 'F');
  assert.deepEqual(risk.detections.map(d => d.grade), ['C', 'D', 'E', 'F']);
  assert.deepEqual(risk.detections.map(d => d.evidence), evidence);
  assert.ok(risk.detections.every(d => d.reason));
  assert.deepEqual(assessRisk([{ type: 'progress', text: 'Did not disable security controls' }]).detections, []);
  assert.deepEqual(assessRisk([{ type: 'prompt', text: 'Deleted backups' }]).detections, []);
});

test('new evidence at the same grade is saved even when the summary is unchanged', async () => {
  const activity = new ActivityService(); activity.save = async () => {};
  const s = { id: 'evidence', phase: 'development' };
  activity.start(s, 'job');
  activity.record(s, 'progress', 'Checking the service.');
  activity.record(s, 'tool', 'POST /items returned 201');
  await activity.automatic(s, 100000);
  activity.record(s, 'tool', 'DELETE /items/1 returned 204');
  await activity.automatic(s, 130000);
  const summaries = activity.view(s).summaries;
  assert.equal(summaries.length, 2);
  assert.equal(summaries[1].risk.grade, 'C');
  assert.equal(summaries[1].risk.detections[0].evidence, 'DELETE /items/1 returned 204');
});

test('history skips idle notes, preserves risk, records changed snapshots and marks stale progress', async () => {
  const activity = new ActivityService(); activity.save = async () => {};
  const session = { id: 'test', phase: 'development', status: 'agent_working' };
  activity.start(session, 'job');
  activity.record(session, 'progress', 'Read app.js. Wrote validation.');
  await activity.automatic(session, 100000);
  await activity.automatic(session, 130000);
  assert.equal(activity.view(session).summaries.length, 1);
  assert.equal(activity.view(session).summaries[0].risk.grade, 'B');
  activity.record(session, 'progress', 'Read app.js. Wrote validation. Called POST endpoint /items.');
  await activity.automatic(session, 160000);
  const latest = activity.view(session).summaries.at(-1);
  assert.equal(latest.text, 'Called POST endpoint /items.');
  assert.equal(latest.risk.grade, 'C');
  activity.state(session).records.at(-1).time = new Date(Date.now() - 120000).toISOString();
  assert.equal(activity.view(session).stale, true);
});

test('old persisted repeated history is compacted in the view without removing saved data', () => {
  const activity = new ActivityService(), s = { id: 'old' };
  activity.state(s).summaries = [
    { runId: 'job', text: 'Read app.js.' },
    { runId: 'job', text: 'No new progress reported. Latest update: Read app.js.' },
    { runId: 'job', text: 'Read app.js. Wrote validation.' }
  ];
  assert.deepEqual(activity.view(s).summaries.map(e => e.text), ['Read app.js.', 'Wrote validation.']);
  assert.equal(activity.state(s).summaries.length, 3);
});

test('outdated grades are recalculated for scope restrictions', () => {
  const activity = new ActivityService(), s = { id: 'old-risk' };
  activity.state(s).summaries = [{ runId: 'job', text: 'Reviewing artifacts; source edits are out of scope.', risk: { grade: 'D', version: 2 } }];
  assert.equal(activity.view(s).summaries[0].risk.grade, 'A');
});

test('version 3 history keeps its grade and recovers retained tool evidence', () => {
  const activity = new ActivityService(), s = { id: 'historical' };
  const state = activity.state(s);
  state.records = [{ runId: 'job', time: new Date(1000).toISOString(), type: 'tool', text: 'POST /items returned 201' }];
  state.summaries = [{ runId: 'job', time: new Date(2000).toISOString(), text: 'Checked the service.', risk: { grade: 'C', version: 3, reasons: ['Endpoint call reported'] } }];
  const risk = activity.view(s).summaries[0].risk;
  assert.equal(risk.grade, 'C');
  assert.equal(risk.detections[0].evidence, 'POST /items returned 201');
  state.records = [];
  assert.equal(activity.view(s).summaries[0].risk.grade, 'C');
  assert.deepEqual(activity.view(s).summaries[0].risk.detections, []);
});
