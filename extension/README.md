# AI Workbench Bridge

Open a workspace containing `.harness/bridge.json`. The extension connects to the local Workbench server, opens a new Copilot Agent chat and inserts the queued prompt. Automatic submission is on by default. Toggle **Automatic chat** in the dashboard to prepare future prompts for manual Send. The **AI Workbench: Auto Submit** user setting can also disable automatic submission globally.

The coding agent writes a structured reply to `.harness/responses/<jobId>.json`. The extension forwards it to the dashboard. There is no Copilot CLI, chat database access, or UI scraping. Run **AI Workbench: Enable Activity Summaries** to select a Copilot model through the VS Code Language Model API and enable a separate summarizer. It summarizes explicit progress records every 30 seconds during work, with at most 50 words per entry. Model consent and availability apply. No private reasoning is collected.

VS Code workspace trust, Copilot sign-in, model access, and tool approvals remain in effect. The chat-opening commands are VS Code workbench commands rather than a stable public extension API and may change between versions. Connection errors appear in Output → AI Workbench and the dashboard. Use **AI Workbench: Send Pending Prompt** to explicitly submit a prepared request.
