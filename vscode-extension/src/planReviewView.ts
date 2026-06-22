import * as path from "node:path";
import * as fs from "node:fs";
import * as vscode from "vscode";
import { PlanChoice, PlanReviewStatePayload, LoopState } from "./types";
import { StateStore } from "./stateStore";
import { LoopClient } from "./loopClient";

export class PlanReviewViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private selectedSessionId: string | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: StateStore,
    private readonly client: LoopClient
  ) {
    this.store.onChange(() => this.refresh());
  }

  selectSession(sessionId: string | null): void {
    this.selectedSessionId = sessionId;
    this.refresh();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      (msg: any) => this.handleMessage(msg),
      undefined,
      this.context.subscriptions
    );

    this.refresh();
  }

  private async refresh(): Promise<void> {
    if (!this.view) return;
    await this.pushState();
  }

  private async pushState(): Promise<void> {
    if (!this.view) return;

    if (!this.selectedSessionId) {
      const registry = await this.store.readRegistry();
      if (registry.sessionMetas.length > 0) {
        const running = registry.sessionMetas.find((m) => m.status === "RUNNING");
        const paused = registry.sessionMetas.find((m) => m.status === "PAUSED");
        this.selectedSessionId = running?.sessionId ?? paused?.sessionId ?? registry.sessionMetas[0].sessionId;
      }
    }

    if (!this.selectedSessionId) {
      this.postMessage({ command: "stateUpdate", payload: this.emptyPayload() });
      return;
    }

    const sessionId = this.selectedSessionId;

    let choices: PlanChoice[] | null = null;
    let planMd: string | null = null;
    let state: LoopState | null = null;

    try {
      const bundle = await this.store.readBundle(sessionId);
      state = bundle.state;
    } catch { /* ignore */ }

    if (state) {
      if (state.awaitingPlanApproval) {
        choices = await this.store.readPlanChoices(sessionId);
      }
      planMd = await this.store.readPlanMd(sessionId);
    }

    const payload: PlanReviewStatePayload = {
      sessionId,
      awaitingPlanApproval: state?.awaitingPlanApproval ?? false,
      planApproved: state?.planApproved ?? false,
      choices,
      planMd,
      isPaused: state?.status === "PAUSED",
      phase: state?.phase ?? null,
    };

    this.postMessage({ command: "stateUpdate", payload });
  }

  private emptyPayload(): PlanReviewStatePayload {
    return { sessionId: "", awaitingPlanApproval: false, planApproved: false, choices: null, planMd: null, isPaused: false, phase: null };
  }

  private postMessage(msg: unknown): void {
    if (this.view) {
      this.view.webview.postMessage(msg).then(
        () => {},
        (err) => console.error("[PlanReviewView] postMessage failed:", err)
      );
    }
  }

  private async handleMessage(msg: any): Promise<void> {
    switch (msg.command) {
      case "requestPlanReviewState":
        await this.pushState();
        break;
      case "selectPlanChoice": {
        const sessionId = msg.sessionId;
        if (!sessionId) return;
        const choicesPath = await this.store.getPlanChoicesPath(sessionId);
        try {
          const raw = await fs.promises.readFile(choicesPath, "utf8");
          const choices: PlanChoice[] = JSON.parse(raw);
          const choice = choices.find((c: PlanChoice) => c.id === msg.choiceId);
          if (choice) {
            const planPath = await this.store.getPlanMdPath(sessionId);
            await fs.promises.writeFile(planPath, choice.body, "utf8");
            vscode.window.showInformationMessage(`Plan option "${choice.title}" selected. Markdown plan written.`);
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`Failed to select plan option: ${errMsg}`);
        }
        await this.pushState();
        break;
      }
      case "revisePlan": {
        const sessionId = msg.sessionId;
        if (!sessionId || !msg.message) return;
        await this.pushState();
        vscode.window.showInformationMessage(`Revising plan for ${sessionId}...`);
        const result = await this.client.revisePlan(sessionId, msg.message);
        if (result.exitCode === 0) {
          vscode.window.showInformationMessage(`Plan revised for ${sessionId}.`);
        } else {
          vscode.window.showWarningMessage(`Plan revision completed with exit code ${result.exitCode}.`);
        }
        await this.pushState();
        break;
      }
      case "approvePlan": {
        const sessionId = msg.sessionId;
        if (!sessionId) return;
        const sessionDir = await this.store.getSessionDir(sessionId);
        const statePath = path.join(sessionDir, "loop_state.json");
        try {
          const raw = await fs.promises.readFile(statePath, "utf8");
          const state: LoopState = JSON.parse(raw);
          state.planApproved = true;
          state.awaitingPlanApproval = false;
          state.status = "RUNNING";
          await fs.promises.writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
          vscode.window.showInformationMessage(`Plan approved for ${sessionId}. Resuming session...`);
          await this.client.resumeSession(sessionId);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`Failed to approve plan: ${errMsg}`);
        }
        await this.pushState();
        break;
      }
      case "resumeSession": {
        const sessionId = msg.sessionId;
        if (!sessionId) return;
        await this.client.resumeSession(sessionId);
        vscode.window.showInformationMessage(`Resumed session ${sessionId}`);
        break;
      }
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <style nonce="${nonce}">
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: var(--vscode-font-family, -apple-system, sans-serif); font-size: 12px; color: var(--vscode-foreground); padding: 8px; }
    h3 { font-size: 1em; margin-bottom: 8px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; }
    .choice-card {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 8px;
      margin-bottom: 8px;
      cursor: pointer;
    }
    .choice-card:hover { background: var(--vscode-list-hoverBackground); }
    .choice-card.selected { border-color: var(--vscode-focusBorder); }
    .choice-title { font-weight: 600; margin-bottom: 4px; }
    .choice-preview { font-size: 11px; color: var(--vscode-descriptionForeground); max-height: 80px; overflow: hidden; }
    .plan-preview {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 8px;
      margin-bottom: 8px;
      max-height: 300px;
      overflow-y: auto;
      white-space: pre-wrap;
      font-size: 11px;
      background: var(--vscode-editor-background);
    }
    .chat-area {
      border-top: 1px solid var(--vscode-panel-border);
      padding-top: 8px;
      margin-top: auto;
    }
    .chat-area textarea {
      width: 100%;
      min-height: 48px;
      resize: vertical;
      font-family: inherit;
      font-size: 12px;
      padding: 6px;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 4px;
    }
    .chat-area textarea:disabled { opacity: 0.5; }
    .btn-row { display: flex; gap: 4px; margin-top: 6px; flex-wrap: wrap; }
    button {
      font-family: inherit;
      font-size: 11px;
      padding: 4px 10px;
      border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border-radius: 3px;
      cursor: pointer;
    }
    button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: var(--vscode-button-border, var(--vscode-button-background));
    }
    button.primary:hover { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: 0.4; cursor: default; }
    .empty { color: var(--vscode-descriptionForeground); font-style: italic; padding: 12px 0; text-align: center; }
    .spinner { display: inline-block; width: 10px; height: 10px; border: 2px solid var(--vscode-descriptionForeground); border-top-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite; margin-right: 4px; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div id="root">
    <div class="empty">Loading plan review...</div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let state = ${JSON.stringify({ sessionId: null, awaitingPlanApproval: false, planApproved: false, choices: null, planMd: null, isPaused: false, phase: null })};
    let reviseBusy = false;

    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg.command === "stateUpdate") {
        state = msg.payload;
        render();
      }
    });

    function escapeHtml(str) {
      if (!str) return "";
      return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    function render() {
      const root = document.getElementById("root");
      if (!state.sessionId) {
        root.innerHTML = '<div class="empty">Select a session to review plans.</div>';
        return;
      }

      const hasChoices = state.choices && state.choices.length > 0;
      const hasPlan = state.planMd && state.planMd.trim().length > 0;

      if (state.awaitingPlanApproval && !hasPlan && hasChoices) {
        renderChoosing(root);
      } else if (state.awaitingPlanApproval && hasPlan) {
        renderReviewing(root);
      } else if (state.isPaused && hasPlan) {
        renderPausedReview(root);
      } else {
        root.innerHTML = '<div class="empty">No plan review pending for this session.</div>';
      }
    }

    function renderChoosing(root) {
      const choicesHtml = (state.choices || []).map(function(c) {
        return '<div class="choice-card" onclick="selectChoice(' + c.id + ')"><div class="choice-title">' + escapeHtml(c.title) + '</div><div class="choice-preview">' + escapeHtml(c.body.slice(0, 200)) + '</div></div>';
      }).join("");
      root.innerHTML = '<h3>Plan Options</h3>' + choicesHtml;
    }

    function selectChoice(choiceId) {
      vscode.postMessage({ command: "selectPlanChoice", sessionId: state.sessionId, choiceId: choiceId });
    }

    function renderReviewing(root) {
      root.innerHTML =
        '<h3>Plan Review</h3>' +
        '<div class="plan-preview">' + escapeHtml(state.planMd || "") + '</div>' +
        '<div class="chat-area"><textarea id="chat-input" placeholder="Request plan changes... (Ctrl+Enter to send)"></textarea>' +
        '<div class="btn-row">' +
          '<button id="btn-revise" ' + (reviseBusy ? 'disabled' : '') + '>' + (reviseBusy ? '<span class="spinner"></span> Revising...' : 'Revise Plan') + '</button>' +
          '<button class="primary" id="btn-approve" ' + (reviseBusy ? 'disabled' : '') + '>Approve & Start</button>' +
          '<button id="btn-back-choices" ' + (reviseBusy ? 'disabled' : '') + '>Back to Choices</button>' +
        '</div></div>';
      bindChat();
    }

    function renderPausedReview(root) {
      root.innerHTML =
        '<h3>Session Paused \u2014 Plan Review</h3>' +
        '<div class="plan-preview">' + escapeHtml(state.planMd || "") + '</div>' +
        '<div class="chat-area"><textarea id="chat-input" placeholder="Request plan changes... (Ctrl+Enter to send)"></textarea>' +
        '<div class="btn-row">' +
          '<button id="btn-revise" ' + (reviseBusy ? 'disabled' : '') + '>' + (reviseBusy ? '<span class="spinner"></span> Revising...' : 'Revise Plan') + '</button>' +
          '<button class="primary" id="btn-resume" ' + (reviseBusy ? 'disabled' : '') + '>Resume</button>' +
        '</div></div>';
      bindChat();
    }

    function bindChat() {
      const textarea = document.getElementById("chat-input");
      const btnRevise = document.getElementById("btn-revise");
      const btnApprove = document.getElementById("btn-approve");
      const btnResume = document.getElementById("btn-resume");
      const btnBack = document.getElementById("btn-back-choices");

      function sendRevise() {
        if (!textarea || reviseBusy) return;
        const msg = textarea.value.trim();
        if (!msg) return;
        reviseBusy = true;
        render();
        vscode.postMessage({ command: "revisePlan", sessionId: state.sessionId, message: msg });
        textarea.value = "";
      }

      if (textarea) {
        textarea.onkeydown = function(e) {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            sendRevise();
          }
        };
      }
      if (btnRevise) btnRevise.onclick = sendRevise;
      if (btnApprove) btnApprove.onclick = function() {
        vscode.postMessage({ command: "approvePlan", sessionId: state.sessionId });
      };
      if (btnResume) btnResume.onclick = function() {
        vscode.postMessage({ command: "resumeSession", sessionId: state.sessionId });
      };
      if (btnBack) btnBack.onclick = function() {
        vscode.postMessage({ command: "selectPlanChoice", sessionId: state.sessionId, choiceId: -1 });
      };
    }

    vscode.postMessage({ command: "requestPlanReviewState" });
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const crypto = require("node:crypto");
  return crypto.randomBytes(16).toString("base64");
}
