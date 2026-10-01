import crypto from 'node:crypto';
import path from 'node:path';
import { json, readJson } from './files.js';

// Independent of workflow locks so recording never blocks the summary worker.
export class ActivityService {
  constructor() { this.states = new Map(); this.writes = new Map(); this.removing = new Set(); }
  state(s) {
    if (!this.states.has(s.id)) this.states.set(s.id, { records: [], summaries: [], runs: [], error: null });
    return this.states.get(s.id);
  }
  async load(s) {
    try { this.states.set(s.id, await readJson(path.join(s.folder, '.harness/activity.json'))); }
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
    state.records.push({ time: new Date().toISOString(), runId: state.runs.at(-1)?.id, phase: s.phase, type, text: String(text).slice(-16000) });
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
    const state = this.state(s);
    // Leave an in-flight optional model request alone until its lease expires.
    const run = state.runs.find(r => (r.active || !r.final) && time >= r.due);
    if (!run) return;
    const previous = state.summaries.findLast(entry => entry.runId === run.id);
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
    const latest = job.final ? records.at(-1) : progress || event;
    if (!job.final && previous && latest && latest.time <= previous.time) text = `No new progress reported. Latest update: ${text}`;
    await this.response(s, { id: job.id, text: text || 'Waiting for the AI to report progress.', source: 'reported' }, time);
  }
  async claim(s, time = Date.now()) {
    if (this.removing.has(s.id)) return null;
    const state = this.state(s);
    const run = state.runs.find(r => (r.active || !r.final) && time >= r.due);
    if (!run) return null;
    const job = { id: crypto.randomUUID(), runId: run.id, phase: run.phase, final: !run.active, startedAt: time };
    run.pending = job; run.due = time + 60000;
    await this.save(s);
    const records = [];
    let remaining = 24000;
    for (const record of state.records.filter(r => r.runId === run.id).slice(-40).reverse()) {
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
      state.summaries.push({ time: new Date(time).toISOString(), phase: run.phase, runId: run.id, text, final: run.pending.final, source: input.source === 'reported' ? 'reported' : 'model' });
      state.error = null;
      if (run.pending.final) run.final = true;
    }
    run.due = !run.active && !run.final && !input.error ? 0 : Math.max(time, run.pending.startedAt + 30000);
    run.pending = null;
    await this.save(s);
  }
  view(s) {
    const state = this.state(s);
    return { summaries: state.summaries, error: state.error, active: state.runs.some(r => r.active), latest: state.records.findLast(r => ['progress', 'event'].includes(r.type)) };
  }
}
