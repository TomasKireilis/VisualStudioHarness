import fs from 'node:fs/promises';
import path from 'node:path';
import { zipDirectory } from './zip.js';

const stage = path.resolve('.local', `vsix-${Date.now()}`);
await fs.mkdir(path.join(stage, 'extension'), { recursive: true });
for (const file of ['package.json', 'extension.cjs', 'README.md']) await fs.copyFile(path.join('extension', file), path.join(stage, 'extension', file));
await fs.writeFile(path.join(stage, '[Content_Types].xml'), `<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="cjs" ContentType="application/javascript"/><Default Extension="md" ContentType="text/markdown"/><Default Extension="vsixmanifest" ContentType="text/xml"/></Types>`);
await fs.writeFile(path.join(stage, 'extension.vsixmanifest'), `<?xml version="1.0" encoding="utf-8"?><PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata><Identity Language="en-US" Id="ai-workbench-bridge" Version="0.1.0" Publisher="local-workbench"/><DisplayName>AI Workbench Bridge</DisplayName><Description xml:space="preserve">Connects the local Windows AI Workbench to VS Code Copilot chat.</Description><Tags>AI,workbench</Tags><Categories>Other</Categories><GalleryFlags>Public</GalleryFlags><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.109.0"/><Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value=""/><Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value=""/></Properties></Metadata><Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/><Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/><Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/></Assets></PackageManifest>`);
await fs.mkdir('dist', { recursive: true });
const destination = path.resolve('dist', `ai-workbench-bridge-0.1.0-${Date.now()}.vsix`);
await zipDirectory(stage, destination);
console.log(`Extension package: ${destination}`);
