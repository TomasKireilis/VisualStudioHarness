import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export async function json(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2));
  await fs.rename(temp, file);
}

export async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }

export async function inside(root, relative) {
  const target = path.resolve(root, relative);
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Path is outside workspace');
  const realRoot = await fs.realpath(root);
  const realTarget = await fs.realpath(target);
  const realRel = path.relative(realRoot, realTarget);
  if (realRel.startsWith('..') || path.isAbsolute(realRel)) throw new Error('Linked path is outside workspace');
  return realTarget;
}

const excluded = new Set(['node_modules', '.git', '.harness', 'artifacts', 'dist', 'build', 'coverage', '.next']);
export async function snapshot(root) {
  const result = {};
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (excluded.has(entry.name) || entry.name.startsWith('.env') || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const stat = await fs.stat(full);
        if (stat.size > 1024 * 1024) continue;
        const buffer = await fs.readFile(full);
        if (buffer.includes(0)) continue;
        result[path.relative(root, full).replaceAll('\\', '/')] = buffer.toString('utf8');
      }
    }
  }
  await walk(root);
  return result;
}

export function changes(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
    .filter(file => before[file] !== after[file])
    .map(file => ({ file, type: !(file in before) ? 'added' : !(file in after) ? 'deleted' : 'modified', before: before[file] ?? '', after: after[file] ?? '' }));
}

export function impactMarkdown(reply, diff) {
  const sections = ['# Change report', '', reply.message || '', '', '## Impact', ...(reply.impact || []).map(i => `- ${i.file}: ${i.description}`), '', '## Validation reported by the coding agent', ...(reply.tests || []).map(t => `- ${t}`), '', '## Captured file changes', 'Source snapshots exclude generated folders, .env files, binary files, and files larger than 1 MB.'];
  for (const change of diff) {
    sections.push('', `### ${change.file} (${change.type})`, '', 'Before:', '``````text', change.before.slice(0, 12000) || '(absent)', '``````', 'After:', '``````text', change.after.slice(0, 12000) || '(absent)', '``````');
  }
  return sections.join('\n');
}
