import { chromium } from './browser.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-browser-check-'));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ recordVideo: { dir } });
  const page = await context.newPage();
  await page.setContent('<title>Workbench browser check</title>');
  if (await page.title() !== 'Workbench browser check') throw new Error('Browser page check failed');
  await page.screenshot();
  // Video frames arrive asynchronously from the browser compositor.
  await page.waitForTimeout(250);
  const video = page.video();
  await context.close();
  if (!(await fs.stat(await video.path())).size) throw new Error('Browser video check failed');
  console.log(JSON.stringify({ ok: true, version: browser.version(), executable: chromium.executablePath(), browsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH }));
} finally {
  try { await browser?.close(); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
}
