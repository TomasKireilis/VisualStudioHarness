import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Workbench } from './workbench.js';
import { inside } from './files.js';
import { openCode } from './process.js';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.md': 'text/plain', '.log': 'text/plain', '.webm': 'video/webm', '.png': 'image/png', '.zip': 'application/zip' };
function send(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); }
async function body(req) {
  let data = '';
  for await (const chunk of req) { data += chunk; if (Buffer.byteLength(data) > 1024 * 1024) throw new Error('Request exceeds 1 MB'); }
  return data ? JSON.parse(data) : {};
}
function textField(value, name = 'text') {
  if (typeof value !== 'string' || !value.trim() || value.length > 100000) throw new Error(`${name} is required (maximum 100,000 characters)`);
  return value.trim();
}
export async function startServer({ port = 4310, root = 'C:/AIWork', autoOpen = true, createOnStart = true, provision, launch } = {}) {
  const uiToken = crypto.randomBytes(32).toString('hex');
  let workbench;
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' blob:; media-src 'self' blob:; frame-ancestors 'none'");
    try {
      const serverPort = server.address().port;
      const allowed = [`127.0.0.1:${serverPort}`, `localhost:${serverPort}`];
      if (!allowed.includes(req.headers.host)) return send(res, 403, { error: 'Invalid host' });
      if (req.headers.origin && !allowed.map(h => `http://${h}`).includes(req.headers.origin)) return send(res, 403, { error: 'Cross-origin request denied' });
      const url = new URL(req.url, `http://${req.headers.host}`);
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] === 'bridge') {
        const session = workbench.get(parts[1]);
        if (req.headers.authorization !== `Bearer ${session.token}`) return send(res, 401, { error: 'Invalid bridge token' });
        if (req.method === 'POST' && parts[2] === 'progress') { await workbench.progress(session.id, await body(req)); return send(res, 200, { ok: true }); }
        if (req.method === 'POST' && parts[2] === 'summary-claim') return send(res, 200, { job: await workbench.activity.claim(session) });
        if (req.method === 'POST' && parts[2] === 'summary-response') { await workbench.activity.response(session, await body(req)); return send(res, 200, { ok: true }); }
        if (req.method === 'POST' && parts[2] === 'claim') return send(res, 200, { job: await workbench.claim(session.id) });
        if (req.method === 'POST' && parts[2] === 'response') return send(res, 200, await workbench.response(session.id, await body(req)));
        if (req.method === 'POST' && parts[2] === 'error') {
          const input = await body(req); await workbench.jobError(session.id, input.jobId, textField(input.error, 'error'));
          return send(res, 200, { ok: true });
        }
        return send(res, 404, { error: 'Unknown bridge endpoint' });
      }
      if (parts[0] === 'api') {
        if (req.headers['x-workbench-token'] !== uiToken && url.searchParams.get('token') !== uiToken) return send(res, 401, { error: 'Refresh the dashboard to reconnect' });
        if (url.pathname === '/api/sessions' && req.method === 'GET') return send(res, 200, { sessions: [...workbench.sessions.values()].map(s => workbench.public(s)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
        if (url.pathname === '/api/sessions' && req.method === 'POST') return send(res, 201, await workbench.create());
        const id = parts[2];
        const s = workbench.get(id);
        if (req.method === 'DELETE' && parts.length === 3) return send(res, 200, await workbench.remove(id, (await body(req)).confirmId));
        if (req.method === 'GET' && parts.length === 3) return send(res, 200, workbench.public(s));
        if (parts[3] === 'file' && req.method === 'GET') {
          const name = url.searchParams.get('path') || '';
          if (name.includes('\\') || name.split('/').some(part => part === '..' || part === '.')) return send(res, 400, { error: 'Invalid artifact path' });
          if (!(name.startsWith('artifacts/') || ['REQUIREMENTS.md', '.harness/demo/config.json', '.harness/setup.log'].includes(name))) return send(res, 403, { error: 'File is not a review artifact' });
          const file = await inside(s.folder, name);
          if (name.startsWith('artifacts/')) await inside(path.join(s.folder, 'artifacts'), path.relative(path.join(s.folder, 'artifacts'), file));
          const stat = await fs.stat(file);
          if (!stat.isFile()) throw new Error('Not a file');
          const headers = { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Accept-Ranges': 'bytes' };
          const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
          if (req.headers.range && !range) { res.writeHead(416); return res.end(); }
          if (range) {
            const start = Number(range[1]), end = range[2] ? Number(range[2]) : stat.size - 1;
            if (start > end || end >= stat.size) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return res.end(); }
            res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
            createReadStream(file, { start, end }).pipe(res);
          } else { res.writeHead(200, { ...headers, 'Content-Length': stat.size }); createReadStream(file).pipe(res); }
          return;
        }
        if (req.method !== 'POST') return send(res, 404, { error: 'Unknown endpoint' });
        const input = await body(req);
        switch (parts[3]) {
          case 'review-demo': return send(res, 200, await workbench.reviewDemo(id));
          case 'auto-submit': return send(res, 200, await workbench.setAutoSubmit(id, input.enabled));
          case 'rollback': return send(res, 200, await workbench.rollback(id, textField(input.reason, 'reason'), input.stopped === true, input.phase));
          case 'brief': return send(res, 200, await workbench.brief(id, textField(input.text)));
          case 'answer': return send(res, 200, await workbench.answer(id, textField(input.text)));
          case 'approve': return send(res, 200, await workbench.approve(id, textField(input.requirements, 'requirements')));
          case 'retry-job': return send(res, 200, await workbench.retryJob(id));
          case 'setup':
            if (s.demoReady || s.status !== 'error') throw new Error('Setup is not eligible for retry');
            workbench.setup(id).catch(() => {}); return send(res, 202, { ok: true });
          case 'demo':
            if (!['demo_failed', 'complete'].includes(s.status) || !s.uiChanged) throw new Error('Demo is not eligible for retry');
            workbench.demo(id).catch(() => {}); return send(res, 202, { ok: true });
          case 'open': await openCode(s.folder, path.join(project, 'extension')); return send(res, 200, { ok: true });
          default: return send(res, 404, { error: 'Unknown action' });
        }
      }
      if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
      const asset = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!['index.html', 'app.js', 'style.css'].includes(asset)) return send(res, 404, { error: 'Not found' });
      let contents = await fs.readFile(path.join(project, 'public', asset), 'utf8');
      if (asset === 'index.html') contents = contents.replace('__TOKEN__', uiToken);
      res.writeHead(200, { 'Content-Type': mime[path.extname(asset)] }); res.end(contents);
    } catch (error) {
      if (!res.headersSent) send(res, error.status || (error.code === 'ENOENT' ? 404 : 400), { error: error.message });
      else res.destroy();
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}`;
  workbench = new Workbench({ root, url, autoOpen, provision, launch });
  try { await workbench.load(); if (createOnStart) await workbench.create(); }
  catch (error) { server.close(); throw error; }
  let summarizing = false;
  const summaryTimer = setInterval(async () => {
    if (summarizing) return;
    summarizing = true;
    try {
      await Promise.allSettled([...workbench.sessions.values()].map(s => workbench.activity.automatic(s)));
    } finally { summarizing = false; }
  }, 1000);
  summaryTimer.unref();
  server.once('close', () => clearInterval(summaryTimer));
  return { server, workbench, url, uiToken };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startServer({ port: Number(process.env.PORT || 4310), root: process.env.AIWORK_ROOT || 'C:/AIWork', autoOpen: process.env.AIWORK_OPEN_CODE !== 'false', createOnStart: process.env.AIWORK_CREATE_ON_START !== 'false' })
    .then(({ url }) => console.log(`AI Workbench is running at ${url}\nOpen this address to guide your project.`))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
