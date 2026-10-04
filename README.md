# Windows AI Workbench

A local, guided workflow that creates a fresh Linux Docker container for each workspace on Windows, opens VS Code in that container, gathers requirements through Copilot Agent chat, coordinates development, and captures review artifacts.

## Run

For the bundled local setup, unzip `dist/ai-workbench-docker.zip` and run:

```powershell
.\Start-Workbench.ps1
```

The launcher starts the server on Windows and opens the local dashboard. No `npm install` step is needed on the host for Docker mode. It keeps workspace data under `.local/workspaces` beside the extracted bundle unless `AIWORK_ROOT` is set. Keep its terminal open; Ctrl+C stops the dashboard server. Install Docker Desktop with Linux containers mode and VS Code's Dev Containers extension before launching. Recovery starts Docker Desktop if it is stopped. Use **Open VS Code** to connect to the workspace container, browse all files, chat with Copilot and run commands in its terminal. VS Code's desktop window is local; its workspace server and execution tools run inside Docker. Source files are shared with the host for persistence and dashboard artifact access.

To create the ZIP from this repository, run `npm run bundle:package`. It contains the launcher, dashboard, server, bridge, Docker build files and tests, without generated workspaces or local credentials.

Requires Windows, Node.js 22+ and npm for the dashboard, Docker Desktop running **Linux containers**, VS Code 1.109+ with the **Dev Containers** extension (`ms-vscode-remote.remote-containers`), and company-approved GitHub Copilot chat access. The first image build needs access to Docker Hub, Debian package mirrors, your npm registry and Playwright's browser download host. VS Code may also download its container server and prompt you to enable Copilot in the remote window.

```powershell
npm install
npm start
```

Open **http://127.0.0.1:4310**. The first server start creates a workspace; later starts load and restore existing workspaces. **New workspace** creates another `C:\AIWork\work-<date>-<random>` folder and its own `aiwork-work-<date>-<random>` Linux container (the launcher uses `.local/workspaces` instead). The folder is mounted at `/workspace`; source files, conversations, logs and artifacts stay accessible on Windows. Project and demo `node_modules` use separate Docker volumes, so Linux dependencies stay on Linux storage.

The first workspace builds the shared image from `docker/Dockerfile`: Node.js 22, npm, Git, pinned Playwright 1.58.2, Chromium and its system dependencies. Later workspaces reuse the image. Each workspace verifies a real Chromium launch, page render and video recording inside its container before setup succeeds. VS Code then attaches directly to that same container. The installation log is available immediately and updates during setup. The automatic-chat toggle remains usable while setup runs. Docker or browser failures stay in preparation and allow a retry; generated commands do not fall back to host execution.

The default launch uses VS Code's `--extensionDevelopmentPath` so the included bridge works without a separate installation. Each Docker workspace gets its own bridge copy under `.harness/bridge-extension-remote` and a separate Extension Development Host window attached to `/workspace` in its container. The launcher explicitly sets the matching remote authority and keeps the bridge on the Windows UI side, using the shared folder and the host's loopback dashboard; terminal tools, builds, tests, application processes and recording run inside Linux. The dashboard continues to bind only to `127.0.0.1`, without exposing a host service to the container or LAN. Trust the folder and sign in to Copilot if prompted. Your organization's extension restrictions still apply. A host-only window will not claim jobs for a Docker workspace; use **Open VS Code** in the dashboard to attach.

Containers survive dashboard restarts. **Open VS Code**, dispatching a queued job, and demo recording restart a stopped workspace container when needed. Existing workspaces created by the previous version keep their host runtime; create a new workspace to use Docker. Closing VS Code or stopping the dashboard leaves containers available. You can stop an idle one with `docker stop <container-name>`; the harness starts it again when needed. Use VS Code's **Ports** panel to forward application ports for manual previews; demo URLs refer to localhost inside the container.

On the first connection, Dev Containers displays **“Attaching to a container may execute arbitrary code.”** Click **Got It** in the new VS Code window to acknowledge it for your local workspace container. Docker setup does not continue until this dialog is answered. Workspace trust and Copilot sign-in may follow. The harness leaves these VS Code confirmations under your control.

For a normal installed extension, run `npm run extension:package`, then use **Extensions → Install from VSIX** in VS Code and select the file in `dist`. You can open the workspace normally with that extension installed.

## Workflow

1. **Prepare environment.** Setup runs in its own step before requirements. Successful preparation advances automatically and locks setup permanently for that workspace, including after restarts. You can view the completed step and its installation log, but cannot rerun it or return to it through rollback. Failed or interrupted preparation can be retried.
2. **Requirements.** Enter the project brief in the dashboard. The extension opens a new local Copilot Agent chat and prepares the prompt. Prompts are automatically submitted by default. Use the dashboard **Automatic chat: On/Off** button to control future requests per workspace; Off prepares the prompt for manual Send. The VS Code `aiWorkbench.autoSubmit` setting (default `true`) can disable automatic submission globally. Respond to follow-up questions in the dashboard. Answers are persisted to `.harness/conversation.json` and requirements to `REQUIREMENTS.md`.
3. **Development.** Review/edit the business requirements in the expanded editor and choose **Approve & start development** directly below it. Technical requirements and feasibility evidence are in a separate expandable section; both sections are saved together. Completed requirements remain available for review, with technical details separate from the business scope. Copilot builds in the same workspace and reports changes, questions, and tests through a structured JSON response. Newly generated workspaces default to automatic tool approval for each new chat, controlled by the server. Requirements and result approval still happen in the dashboard.
4. **Demo.** The server compares source files with the pre-development baseline and writes `artifacts/impact.md` plus `changes.json`. UI changes trigger Playwright recording automatically. Backend-only work produces the report. Both UI and backend results stay in **See the result** until you choose **Approve result & start PR review**. Recording and optional AI demo review never approve the result for you. The dashboard displays the latest walkthrough, the AI summary, and failure information. Supporting screenshots, traces, logs and versioned reports remain in the workspace for AI review and troubleshooting. A failed demo must be corrected and rerun before proceeding.
5. **PR review.** After you approve the result, Copilot reviews all approved features, clean and human readable code, consistent formatting, passing tests and onion architecture. It inspects the code and artifacts and runs applicable tests, build, lint and formatting checks. Each check requires a reported pass/fail result and evidence; failed or unverified checks require actionable findings. Review history stays visible in this step. Existing completed demos can use **Approve result & start PR review** in the demo step.
6. **Refactor & clean up.** When review finds issues, Copilot fixes them, cleans up naming and responsibilities, applies onion structure with dependencies pointing inward, and validates the changes. Change reports and fixes are retained. A fresh PR review runs automatically after every refactoring pass; the loop continues until there are no findings and every check passes. Human questions and interrupted-request retries work in both steps. These checks are AI-reported evidence, not an independent guarantee. The demo remains viewable, labeled as captured before review/refactoring; later UI changes need fresh validation by the agent.
7. **Git push & human PR.** An empty placeholder reached after a clean PR review. Git push and external PR creation are not implemented or executed.

“Call the human” currently means a visible question in the dashboard plus a VS Code notification. Voice calls, messaging integrations and deployment are outside this version.

Use the **×** beside a workspace in the sidebar to delete it. The confirmation shows the exact folder; accepting removes its container, its anonymous dependency volumes, files, conversation and recordings. Ownership and the workspace mount are checked before Docker cleanup. Docker must be available to delete a container workspace safely. Deletion is blocked while setup, an agent request or recording is active. Other workspaces and the shared image remain available.

If VS Code opens in **Restricted Mode**, use **Manage Workspace Trust** to trust the generated workspace. The bridge displays this blocker and reconnects automatically when trust is granted; it does not change your trust settings.

## Revisions and feasibility

After shutting down the PC, run `Start-Workbench.ps1` again from the same folder. The server loads saved workspaces, starts Docker Desktop when needed, restarts their containers, refreshes the bridge configuration and reopens previously opened VS Code workspaces and those with pending requests. It does not create another workspace on each restart. The dashboard remains available while recovery runs and shows recovery failures with a **Restore workspace** button. The launcher must be run again; this does not install Windows sign-in startup tasks.

The server first imports any response JSON already written before shutdown. Jobs dispatched by this version record the host boot time; a detected PC restart resumes unfinished work with a new job in the same phase, pointing the agent to existing source, requirements, conversation and previous progress. Old replies are ignored. Restarting only the server, or loading older jobs without boot information, retains a possibly running chat request. If that request cannot continue, stop it or confirm it ended during shutdown, then choose **Retry interrupted request** or **Restore workspace**. Retry now restores the environment and reopens VS Code as well as queuing a continuation. Workspace trust and Copilot sign-in may still require your input.

Interrupted setup and demo recording can resume through restoration. Existing containers keep their dependency volumes. If a container must be recreated, demo tooling and project npm dependencies are restored from the saved package files. Runtime processes and an in-progress model turn cannot survive power loss; the agent continues from saved project state. Set `AIWORK_OPEN_CODE=false` to disable automatic opening on server start and use **Restore workspace** manually. Set `AIWORK_CREATE_ON_START=true` if you explicitly want an additional workspace on every start.

Click a step to browse its conversation without changing the running workflow. A spinner stays on the working step. Each conversation stays in its own step. The AI activity panel stays visible at the right on desktop and at the bottom on narrow screens.

Use **Return to previous step** to reopen development from demo review, or requirements from development. When viewing an earlier step, submitting this form reopens that step. Enter the bug or question to resolve. Current code, conversation, videos and versioned impact reports are retained; this is a workflow rollback, not a source-file restore. Returning during recording waits for the recorder to finish. Stop an active Copilot request before confirming a return; its late replies are ignored. Revised requirements require approval again. The original development baseline is preserved across revisions.

**Ask AI to review demo** asks Copilot to inspect the captured artifacts. It can return `kind="rollback"` with an explanation to reopen development. During development it can similarly reopen requirements. Reviewing a video depends on available tools; the agent must state what it actually inspected.

Requirements prompts require persistent follow-up on unresolved decisions, inspection of existing code, feasibility checks with reported evidence, and short bullet points covering implementation steps, technologies and existing-code impact. The server rejects ready replies missing the structured `assessment` (`feasible: true`, `evidence`, nonempty `steps`, `technologies`, `codeImpact`). These are agent-reported checks, not an independent proof of feasibility.

## Live AI activity history

Activity history starts automatically when an agent request is dispatched or recording begins. The server checks every 30 seconds, saves only changed progress (up to 50 words), and records completion or questions. Repeated sentences and unchanged notes are omitted; old repeated history is also compacted for display. Each entry shows an estimated risk grade based on reported actions: A reading/no risk reported, B writing or GET, C other endpoint calls, D scope/context or environment changes, E hacking/security bypass, F destruction/data theft. For C–F, the entry also displays the detected category and the reported text that triggered it, including lower detected classes when several occur. New evidence is saved even when the summary and grade stay the same. Examples of higher risk actions include privilege escalation, disabling security, stealing credentials, exporting private data and destroying backups. Grades do not independently audit tool calls. A warning appears after 90 seconds without reported progress. History survives restarts, and the dashboard reconnects automatically when its token expires.

The activity service collects prompts, human input, agent progress notes, structured outputs and recorder events in `.harness/activity.json`. Agents write `.harness/progress/<jobId>.json` with reported file reads/findings, concise decisions, tool outcomes and current actions; the bridge forwards these automatically. The default history uses those reported notes and completion messages, without an additional model call. It cannot read private reasoning or the full Copilot transcript, and its detail depends on the agent writing progress notes. Raw activity retains the latest 500 entries; completed summaries are retained across steps and reloads.

Optionally, **AI Workbench: Enable Activity Summaries** in VS Code selects a separate Copilot model to rewrite activity into summaries through the Language Model API. This enhancement requires model consent and availability and applies to the current VS Code window. Automatic history continues without it. Model requests have a lease; automatic history resumes after a stalled request expires.

## How the chat bridge works

The extension uses `workbench.action.chat.newLocalChat` and `workbench.action.chat.open` with a local Agent prompt. The explicit local-session command avoids inheriting a previously selected cloud/background agent. These workbench commands are **not a stable public extension API**. The extension checks their availability and surfaces failures, but compatibility must be checked against your managed VS Code version.

Every prompt asks Copilot to write `.harness/responses/<jobId>.json`. The extension forwards that file over authenticated loopback HTTP. This remains the main flow, including human questions. The prompt tells the agent to write `kind="questions"` with `questions[]` as its last action and end the request. Dashboard answers are saved to the conversation and sent in a new request.

As a last resort, generated workspaces include Local agent hooks in `.github/hooks/ai-workbench.json`. If the agent invokes the native question tool without writing its reply, the hook saves the questions and choices to the same response JSON and stops the agent. If a turn ends with chat-only questions, the Stop hook recovers explicit question lines from the final public assistant message in Copilot's hook-provided transcript. The existing bridge and server then complete the job and populate the dashboard normally. Existing response files take precedence; unrelated chats and stale requests are ignored. The fallback never writes directly to the dashboard.

Question recovery requires a current VS Code version supporting [Local agent hooks](https://code.visualstudio.com/docs/agent-customization/hooks), workspace trust and `chat.useHooks`. Chat-only recovery recognizes Copilot's current transcript format, which is not a stable API; unavailable or unrecognized transcripts leave the normal flow unchanged. It does not inspect reasoning text or scrape the chat UI. Non-question chat-only completions still require the structured reply to advance the workflow.

For new workspaces, the server sends `autoApprove=true` with every claimed job. Before creating the local chat, the bridge sets workspace `chat.permissions.default="autoApprove"`, the [Allow all permission level](https://code.visualstudio.com/docs/agents/run/approvals). This applies to new chats in that generated workspace. Set `AIWORK_AUTO_APPROVE=false` before starting the server to create workspaces with manual tool permissions. The choice persists per workspace across restarts. Existing workspaces without this choice retain manual permissions. Automatic submission remains a separate toggle. Organization policies, workspace trust and Copilot sign-in still apply.

Jobs are claimed once, responses are validated and idempotent, and stale replies to retried jobs are ignored. A server-only interruption does not silently resend a potentially active prompt. A detected PC restart can resume a job automatically because the previous process ended. For older or uncertain requests, stop the old chat request before using **Retry interrupted request**. Files, jobs, and conversations survive server restarts. Restoration refreshes the bridge URL if the server port changes; the dashboard reconnects on reload.

In the default Docker mode, generated code and configured demo start commands execute in the Linux workspace container. Its writable bind mount includes the workspace, so container processes can change those host files. The Docker socket, host profile and host credentials are not mounted. Tool permission defaults for new chats come from the server's persisted workspace choice. Legacy host workspaces and the optional host mode execute with your Windows account's permissions.

## Configuration

```powershell
$env:AIWORK_ROOT = 'C:\AIWork'       # Workspace root
$env:PORT = '4310'                 # Loopback dashboard port
$env:AIWORK_OPEN_CODE = 'false'     # Optional: launch VS Code yourself
$env:AIWORK_CREATE_ON_START = 'false' # Optional: resume without making a new folder
$env:AIWORK_AUTO_APPROVE = 'false' # Optional: manual tool approval in new workspaces
$env:VSCODE_EXE = 'C:\path\to\Code.exe' # Optional: nonstandard VS Code location
$env:AIWORK_DOCKER_EXE = 'C:\path\to\docker.exe' # Optional: nonstandard Docker CLI
$env:AIWORK_DOCKER_IMAGE = 'aiwork-linux:node22-playwright1.58.2' # Optional: image tag
# $env:AIWORK_EXECUTION = 'host'    # Optional: previous host runtime for new workspaces
npm start
```

Docker uses your current local Docker context; remote SSH/TCP contexts are rejected because the bind mount must refer to this machine. Configure registry access and build proxies in Docker Desktop. Host npm credentials, proxy environment variables and browser caches are not automatically copied into containers; configure approved container access as needed. `PLAYWRIGHT_BROWSERS_PATH` is `/ms-playwright` inside the image. The optional host mode retains inherited npm/proxy settings and browser cache behavior. Bridge requests require a per-workspace token, dashboard mutations require a browser token, and foreign origins/hosts are rejected. Tokens in `.harness` are local credentials and should not be shared. Workspaces ignore `.harness`, artifacts, dependencies and `.env*` in Git.

The browser cache path is saved in `.harness/demo/runtime.json` and applied by the recorder and new VS Code terminals. In the attached container terminal, run `node .harness/demo/check.mjs` from `/workspace` to verify it. From a Windows terminal in the generated folder, use `node .harness/container/run.mjs node .harness/demo/check.mjs`; this wrapper runs the command in the same container. For example, `node .harness/container/run.mjs npm test` runs project tests there. Commands have an internal timeout that stops their process group. To rebuild the shared image after changing tooling, run `docker build -t aiwork-linux:node22-playwright1.58.2 -f docker/Dockerfile .` in this repository and create a new workspace. Existing containers keep their original image.

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

Use `"start": null` for an app already running inside the workspace container. Start commands use a Linux executable plus an argument array, never a shell command string. Windows executables such as `.exe` or `.cmd` require the optional host runtime. The runner waits for the container-local app, records a 1440×900 WebM, captures a trace, and stops the app process tree afterward. UI detection combines the agent's `uiChanged` flag with common UI file extensions. Other UI technologies depend on the agent setting the flag; this first recorder targets browser UIs.

Recordings last at least 15 seconds by default. Set `minimumDurationMs` in the config to override this (0–60000). This adds viewing time; gameplay requires configured inputs. The AI is instructed to demonstrate the core interaction and capture its result, rather than only record the ready screen.

For keyboard games, use `press` to send browser keyboard events, including repeated inputs during play:

```json
{
  "action": "press",
  "key": "Space",
  "repeat": 30,
  "intervalMs": 450
}
```

An optional `selector` focuses an element before pressing. Without one, input goes to the page. `repeat` defaults to 1 (maximum 300); `intervalMs` defaults to 250. A sequence can span at most 60 seconds. Tune the timing to the game's physics, capture screenshots before and after gameplay, and assert visible results with `expect` where available. Canvas clicks support `position: { "x": 100, "y": 200 }` relative to the selected element. Recording uses a separate automated browser; AI inputs in another browser are not included in the video. Existing workspaces receive the updated recorder on server restart or demo retry, retaining their configuration; revise old demo steps to include inputs.

Reports contain agent-authored explanations and test outcomes, explicitly labeled as reported, plus server-captured source snapshots. They exclude generated folders, binary files, `.env*`, and files over 1 MB. Per-file before/after code excerpts are limited to 12,000 characters in Markdown; `changes.json` contains the complete captured text. Reports can include source code and should be handled accordingly.

## Validation

```powershell
npm test                 # Filesystem, workflow, HTTP, Docker lifecycle and bridge checks
npm run test:docker      # Live container, Chromium and recording smoke test (Docker required)
npm run setup            # Download test Chromium
npm run test:ui          # Dashboard interaction, mobile layout, actual demo video
npm run extension:package
```

Unit tests stub Docker at the process boundary and Copilot at the bridge boundary. `test:docker` builds/reuses the real image, prepares a fresh container, records a small interactive application, checks the host-visible artifacts, then removes its temporary workspace and container. These tests do not validate a signed-in corporate Copilot session. Verify that live integration on your managed machine: submit a brief, confirm VS Code is attached to the workspace container, send the prepared chat prompt, confirm its response file appears, approve the requirements, and review the output.

References: [VS Code Chat Participant API](https://code.visualstudio.com/api/extension-guides/ai/chat), [VS Code chat commands source](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/browser/actions/chatActions.ts), [Playwright videos](https://playwright.dev/docs/videos).
