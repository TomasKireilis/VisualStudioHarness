import fs from 'node:fs/promises';
// Apply the saved cache before loading Playwright: it resolves paths at import time.
try {
  const runtime = JSON.parse(await fs.readFile(new URL('./runtime.json', import.meta.url), 'utf8'));
  if (typeof runtime.browsersPath === 'string') process.env.PLAYWRIGHT_BROWSERS_PATH = runtime.browsersPath;
} catch (error) { if (error.code !== 'ENOENT') throw error; }
export const { chromium } = await import('@playwright/test');
