import crypto from 'node:crypto';
import path from 'node:path';
import { json, readJson } from './files.js';
import { assessRisk, summaryDelta, riskVersion } from './activity-risk.js';

// Independent of workflow locks so recording never blocks the summary worker.
export class ActivityService {
  constructor() { this.states = new Map(); this.writes = new Map(); this.removing = new Set(); this.modelLeases = new Map(); }
  state(s) {
    if (!this.states.has(s.id)) this.states.set(s.id, { records: [], summaries: [], runs: [], error: null });
    return this.states.get(s.id);
  }
  async load(s) {
    try {
      const state = await readJson(path.join(s.folder, '.harness/activity.json'));
      state.sequence = state.sequence || state.records.length;
      state.records.forEach((record, index) => { record.sequence ??= index + 1; });
      this.states.set(s.id, state);
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  save(s) {
    if (this.removing.has(s.id)) return Promise.resolve();
    const value = structuredClone(this.state(s));
    const next = (this.writes.get(s.id) || Promise.resolve()).catch(() => {}).then(() => json(path.join(s.folder, '.harness/activity.json'), value));
    this.writes.set(s.id, next);
    return next;
  }
  record(s, type, text) {
    const state = this.state(s);
    state.sequence = (state.sequence || 0) + 1;
    state.records.push({ sequence: state.sequence, time: new Date().toISOString(), runId: state.runs.at(-1)?.id, phase: s.phase, type, text: String(text).slice(-16000) });
    state.records = state.records.slice(-500);
  }
  start(s, id) {
    const state = this.state(s);
    for (const run of state.runs) run.active = false;
    state.runs.push({ id, phase: s.phase, active: true, due: 0, final: false });
    state.runs = state.runs.slice(-100);
  }
  stop(s) { for (const run of this.state(s).runs) { if (run.active && !run.pending) run.due = 0; run.active = false; } }
  async automatic(s, time = Date.now()) {
    if (time < (this.modelLeases.get(s.id) || 0)) return;
    const state = this.state(s);
    // Leave an in-flight optional model request alone until its lease expires.
    const run = state.runs.find(r => (r.active || !r.final) && time >= r.due);
    if (!run) return;
    const job = await this.claim(s, time);
    if (!job) return;
    const records = job.records;
    const progress = records.findLast(record => record.type === 'progress');
    const output = records.findLast(record => record.type === 'output');
    const event = records.findLast(record => record.type === 'event');
    let text;
    if (job.final && output) {
      try {
        const reply = JSON.parse(output.text);
        text = reply.message || reply.questions?.join(' ') || (reply.kind === 'requirements_ready' ? 'Requirements are ready for review.' : 'The AI finished this step.');
      } catch { /* An incomplete output falls back to reported progress. */ }
    }
    text ||= job.final ? event?.text || progress?.text : progress?.text || event?.text;
    await this.response(s, { id: job.id, text: text || run.snapshot || 'Waiting for the AI to report progress.', source: 'reported' }, time);
  }
  async claim(s, time = Date.now()) {
    if (this.removing.has(s.id)) return null;
    const state = this.state(s);
    const run = state.runs.find(r => (r.active || !r.final) && time >= r.due);
    if (!run) return null;
    const changes = state.records.filter(r => r.runId === run.id && (r.sequence || 0) > (run.cursor || 0));
    const job = { id: crypto.randomUUID(), runId: run.id, phase: run.phase, final: !run.active, startedAt: time, cursor: state.sequence || 0, risk: changes.length ? assessRisk(changes) : run.lastRisk || assessRisk([]), previousSummary: run.snapshot || state.summaries.findLast(e => e.runId === run.id)?.snapshot || state.summaries.findLast(e => e.runId === run.id)?.text || '' };
    run.pending = job; run.due = time + 60000;
    await this.save(s);
    const records = [];
    let remaining = 24000;
    for (const record of changes.slice(-40).reverse()) {
      if (remaining <= 0) break;
      const text = record.text.slice(-remaining);
      records.unshift({ ...record, text }); remaining -= text.length;
    }
    return { ...job, records, currentStatus: s.status };
  }
  async response(s, input, time = Date.now()) {
    if (this.removing.has(s.id)) return;
    const state = this.state(s), run = state.runs.find(r => r.pending?.id === input.id);
    if (!run) return; // Duplicate or expired lease.
    if (input.error) {
      state.error = String(input.error).slice(0, 1000);
    } else {
      if (typeof input.text !== 'string' || !input.text.trim()) throw new Error('Summary text is required');
      const text = input.text.trim().split(/\s+/u).slice(0, 50).join(' ');
      const previous = run.snapshot || run.pending.previousSummary;
      const delta = summaryDelta(previous, text);
      const risk = run.pending.risk || assessRisk(state.records.filter(r => r.runId === run.id));
      const riskChanged = risk.grade !== (run.riskGrade || 'A');
      if (delta || run.pending.final || riskChanged) {
        state.summaries.push({ time: new Date(time).toISOString(), phase: run.phase, runId: run.id, text: delta || (run.pending.final ? 'Step finished.' : 'Reported risk changed.'), snapshot: text, risk, final: run.pending.final, source: input.source === 'reported' ? 'reported' : 'model' });
      }
      run.snapshot = text;
      run.cursor = run.pending.cursor ?? state.sequence ?? 0;
      run.lastRisk = risk;
      if (delta || run.pending.final || riskChanged) run.riskGrade = risk.grade;
      state.error = null;
      if (run.pending.final) run.final = true;
    }
    run.due = !run.active && !run.final && !input.error ? 0 : Math.max(time, run.pending.startedAt + 30000);
    run.pending = null;
    await this.save(s);
  }
  view(s) {
    const state = this.state(s);
    const active = state.runs.some(r => r.active);
    const latest = state.records.findLast(r => ['progress', 'event'].includes(r.type));
    const summaries = [];
    const previous = new Map();
    for (const entry of state.summaries) {
      const snapshot = entry.snapshot || entry.text;
      const text = entry.snapshot ? entry.text : summaryDelta(previous.get(entry.runId), snapshot);
      previous.set(entry.runId, snapshot);
      if (!text && !entry.final) continue;
      summaries.push({ ...entry, text: text || 'Step finished.', risk: entry.risk?.version === riskVersion ? entry.risk : assessRisk([{ type: 'progress', text: snapshot }]) });
    }
    return { summaries, error: state.error, active, latest, stale: active && (!latest || Date.now() - Date.parse(latest.time) > 90000) };
  }
}
