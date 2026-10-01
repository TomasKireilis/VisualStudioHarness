import { chromium } from './browser.mjs';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setContent('<title>Workbench browser check</title>');
  if (await page.title() !== 'Workbench browser check') throw new Error('Browser page check failed');
  console.log(JSON.stringify({ ok: true, version: browser.version(), executable: chromium.executablePath(), browsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH }));
} finally { await browser.close(); }
