import fs from 'node:fs/promises';
const destination = '/workspace/.harness/demo/node_modules';
let installed = false;
try {
  const info = JSON.parse(await fs.readFile(`${destination}/@playwright/test/package.json`, 'utf8'));
  installed = info.version === '1.58.2';
} catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!installed) await fs.cp('/opt/aiwork/demo/node_modules', destination, { recursive: true });
console.log('Prepared pinned Playwright dependencies on container storage.');
