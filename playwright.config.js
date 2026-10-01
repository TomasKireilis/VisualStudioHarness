import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './test/browser',
  timeout: 90000,
  expect: { timeout: 12000 },
  fullyParallel: false,
  workers: 1,
  use: { headless: true, viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  reporter: 'list'
});
