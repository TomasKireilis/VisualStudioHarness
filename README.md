# Windows AI Workbench

A local, guided workflow that creates a fresh Windows workspace, opens VS Code, gathers requirements through Copilot Agent chat, coordinates development, and captures review artifacts.

## Run

Requires Windows, Node.js 22+, npm, VS Code 1.109+, and company-approved GitHub Copilot chat access. Initial environment setup needs access to your npm registry and Playwright's browser download host (or an existing approved browser cache).

```powershell
npm install
npm start
```

Open **http://127.0.0.1:4310**. Every server start creates a new `C:\AIWork\work-<date>-<random>` folder; existing workspaces remain accessible. The server reuses matching installed Playwright packages when available, otherwise installs them from npm. It checks the Chromium cache before downloading a missing browser, then opens VS Code. The installation log is available immediately and updates during setup. The automatic-chat toggle remains usable while setup runs. The dashboard shows preparation failures and allows a retry.

The default launch uses VS Code's `--extensionDevelopmentPath` so the included bridge works without a separate installation. Each workspace gets its own bridge copy under `.harness/bridge-extension`, so creating a workspace opens a separate Extension Development Host window with the new folder instead of reloading an older workspace. These windows use your regular VS Code profile and installed extensions. Trust the folder and sign in to Copilot if prompted. Your organization's extension restrictions still apply.

For a normal installed extension, run `npm run extension:package`, then use **Extensions → Install from VSIX** in VS Code and select the file in `dist`. You can open the workspace normally with that extension installed.

## Workflow

1. **Requirements.** Enter the project brief in the dashboard. The extension opens a new local Copilot Agent chat and prepares the prompt. Prompts are automatically submitted by default. Use the dashboard **Automatic chat: On/Off** button to control future requests per workspace; Off prepares the prompt for manual Send. The VS Code `aiWorkbench.autoSubmit` setting (default `true`) can disable automatic submission globally. Respond to follow-up questions in the dashboard. Answers are persisted to `.harness/conversation.json` and requirements to `REQUIREMENTS.md`.
2. **Development.** Review/edit the requirements and choose **Approve & start development**. Copilot builds in the same workspace and reports changes, questions, and tests through a structured JSON response. Existing VS Code tool approvals remain intact.
3. **Demo.** The server compares source files with the pre-development baseline and writes `artifacts/impact.md` plus `changes.json`. UI changes trigger Playwright recording automatically. Backend-only work finishes with the report. The dashboard displays the latest walkthrough, the AI summary, and failure information. Supporting screenshots, traces, logs and versioned reports remain in the workspace for AI review and troubleshooting. A failed demo can be rerun after correcting the app or demo configuration.

“Call the human” currently means a visible question in the dashboard plus a VS Code notification. Voice calls, messaging integrations and deployment are outside this version.

Use the **×** beside a workspace in the sidebar to delete it. The confirmation shows the exact folder; accepting permanently removes its files, conversation and recordings. Deletion is blocked while setup, an agent request or recording is active. Other workspaces remain untouched.

If VS Code opens in **Restricted Mode**, use **Manage Workspace Trust** to trust the generated workspace. The bridge displays this blocker and reconnects automatically when trust is granted; it does not change your trust settings.

## Revisions and feasibility

Click a step to browse its conversation without changing the running workflow. A spinner stays on the working step. Each conversation stays in its own step. The AI activity panel stays visible at the right on desktop and at the bottom on narrow screens.

Use **Return to previous step** to reopen development from demo review, or requirements from development. When viewing an earlier step, submitting this form reopens that step. Enter the bug or question to resolve. Current code, conversation, videos and versioned impact reports are retained; this is a workflow rollback, not a source-file restore. Returning during recording waits for the recorder to finish. Stop an active Copilot request before confirming a return; its late replies are ignored. Revised requirements require approval again. The original development baseline is preserved across revisions.

**Ask AI to review demo** asks Copilot to inspect the captured artifacts. It can return `kind="rollback"` with an explanation to reopen development. During development it can similarly reopen requirements. Reviewing a video depends on available tools; the agent must state what it actually inspected.

Requirements prompts require persistent follow-up on unresolved decisions, inspection of existing code, feasibility checks with reported evidence, and short bullet points covering implementation steps, technologies and existing-code impact. The server rejects ready replies missing the structured `assessment` (`feasible: true`, `evidence`, nonempty `steps`, `technologies`, `codeImpact`). These are agent-reported checks, not an independent proof of feasibility.

## Live AI activity history

Activity history starts automatically when an agent request is dispatched or recording begins. The server checks every 30 seconds, saves only changed progress (up to 50 words), and records completion or questions. Repeated sentences and unchanged notes are omitted; old repeated history is also compacted for display. Each entry shows an estimated risk grade based on reported actions: A reading/no risk reported, B writing or GET, C other endpoint calls, D scope/context or environment changes, E hacking/security bypass, F destruction/data theft. Examples of higher risk actions include privilege escalation, disabling security, stealing credentials, exporting private data and destroying backups. Grades do not independently audit tool calls. A warning appears after 90 seconds without reported progress. History survives restarts, and the dashboard reconnects automatically when its token expires.

The activity service collects prompts, human input, agent progress notes, structured outputs and recorder events in `.harness/activity.json`. Agents write `.harness/progress/<jobId>.json` with reported file reads/findings, concise decisions, tool outcomes and current actions; the bridge forwards these automatically. The default history uses those reported notes and completion messages, without an additional model call. It cannot read private reasoning or the full Copilot transcript, and its detail depends on the agent writing progress notes. Raw activity retains the latest 500 entries; completed summaries are retained across steps and reloads.

Optionally, **AI Workbench: Enable Activity Summaries** in VS Code selects a separate Copilot model to rewrite activity into summaries through the Language Model API. This enhancement requires model consent and availability and applies to the current VS Code window. Automatic history continues without it. Model requests have a lease; automatic history resumes after a stalled request expires.

## How the chat bridge works

The extension uses `workbench.action.chat.newLocalChat` and `workbench.action.chat.open` with a local Agent prompt. The explicit local-session command avoids inheriting a previously selected cloud/background agent. These workbench commands are **not a stable public extension API**. The extension checks their availability and surfaces failures, but compatibility must be checked against your managed VS Code version.

The public Chat Participant API only provides a participant's own conversation, so this implementation does not attempt to read Copilot's rendered transcript. Instead, every prompt asks Copilot to write `.harness/responses/<jobId>.json`. The extension forwards that file over authenticated loopback HTTP. This gives the dashboard a machine-readable response without Copilot CLI or direct model APIs. A chat-only reply will leave the job waiting; the current prompt is visible in the dashboard for diagnosis.

Jobs are claimed once, responses are validated and idempotent, and stale replies to retried jobs are ignored. A server/extension interruption does not silently resend a potentially active prompt. Stop the old chat request before using **Retry interrupted request**. This avoids concurrent agents editing the same files. Files, jobs, and conversations survive server restarts. Keep the server on the same port, or run **AI Workbench: Connect Workspace** after changing it.

The harness is not a sandbox for generated code. Copilot and configured demo start commands execute with your Windows account's permissions, under the existing VS Code approvals. The bridge never changes those settings. Do not use it to bypass your organization's restrictions.

## Configuration

```powershell
$env:AIWORK_ROOT = 'C:\AIWork'       # Workspace root
$env:PORT = '4310'                 # Loopback dashboard port
$env:AIWORK_OPEN_CODE = 'false'     # Optional: launch VS Code yourself
$env:AIWORK_CREATE_ON_START = 'false' # Optional: resume without making a new folder
$env:VSCODE_EXE = 'C:\path\to\Code.exe' # Optional: nonstandard VS Code location
npm start
```

`npm` registry/proxy settings and `PLAYWRIGHT_BROWSERS_PATH` are inherited. The server binds only to `127.0.0.1`; bridge requests require a per-workspace token, dashboard mutations require a browser token, and foreign origins/hosts are rejected. Tokens in `.harness` are local credentials and should not be shared. Workspaces ignore `.harness`, artifacts, dependencies and `.env*` in Git.

Browser setup now verifies a real Chromium launch and page render. Its cache path is saved in `.harness/demo/runtime.json` and applied by the recorder and new VS Code terminals. To verify from any terminal, run `node .harness/demo/check.mjs` in the generated workspace. Existing terminals may need reopening to pick up workspace environment settings; the check command works without that.

## Demo configuration

Playwright and the recording runner are prepared under `.harness/demo`. Copilot only needs to configure `.harness/demo/config.json` for the solution it builds:

```json
{
  "url": "http://127.0.0.1:3000",
  "start": { "command": "npm", "args": ["run", "dev", "--", "--port", "3000"] },
  "steps": [
    { "action": "goto", "path": "/" },
    { "action": "fill", "selector": "input[name=title]", "value": "Example project" },
    { "action": "click", "selector": "button[type=submit]" },
    { "action": "expect", "selector": "main", "text": "Example project" },
    { "action": "screenshot", "name": "project-created" }
  ]
}
```

Use `"start": null` for an already-running app. Start commands use an executable plus an argument array, never a shell command string. The runner waits for the local app, records a 1440×900 WebM, captures a trace, and stops the app process tree afterward. UI detection combines the agent's `uiChanged` flag with common UI file extensions. Other UI technologies depend on the agent setting the flag; this first recorder targets browser UIs.

Reports contain agent-authored explanations and test outcomes, explicitly labeled as reported, plus server-captured source snapshots. They exclude generated folders, binary files, `.env*`, and files over 1 MB. Per-file before/after code excerpts are limited to 12,000 characters in Markdown; `changes.json` contains the complete captured text. Reports can include source code and should be handled accordingly.

## Validation

```powershell
npm test                 # Real filesystem/state machine and HTTP boundary checks
npm run setup            # Download test Chromium
npm run test:ui          # Dashboard interaction, mobile layout, actual demo video
npm run extension:package
```

Automated tests use a stubbed Copilot response at the bridge boundary; they do not claim to validate a signed-in corporate Copilot session. Verify that live integration on your managed machine: submit a brief, send the prepared chat prompt, confirm its response file appears, approve the requirements, and review the output.

References: [VS Code Chat Participant API](https://code.visualstudio.com/api/extension-guides/ai/chat), [VS Code chat commands source](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/browser/actions/chatActions.ts), [Playwright videos](https://playwright.dev/docs/videos).
