import * as path from "node:path";
import * as fs from "node:fs";
import * as vscode from "vscode";
import { PlanChoice, PlanReviewStatePayload, PlanReviewSessionInfo, LoopState } from "./types";
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

    const registry = await this.store.readRegistry();
    const sessionMetas = registry.sessionMetas;

    const sessions: PlanReviewSessionInfo[] = [];
    const stateCache = new Map<string, LoopState | null>();
    for (const m of sessionMetas) {
      let st: LoopState | null = null;
      try {
        const bundle = await this.store.readBundle(m.sessionId);
        st = bundle.state;
      } catch { /* ignore */ }
      stateCache.set(m.sessionId, st);
      sessions.push({
        sessionId: m.sessionId,
        status: m.status,
        goal: m.goal,
        phase: st?.phase ?? null,
        awaitingPlanApproval: st?.awaitingPlanApproval ?? false,
      });
    }

    const needsAttention = (sid: string): boolean => {
      const st = stateCache.get(sid);
      if (!st) return false;
      return st.awaitingPlanApproval || st.phase === "INTERRUPT";
    };

    const isValid = (sid: string | null): boolean =>
      !!sid && sessionMetas.some((m) => m.sessionId === sid);

    if (sessions.length === 0) {
      this.selectedSessionId = null;
      this.postMessage({ command: "stateUpdate", payload: this.emptyPayload(sessions) });
      return;
    }

    if (!isValid(this.selectedSessionId)) {
      this.selectedSessionId = null;
    }

    const currentNeedsAttention = this.selectedSessionId && needsAttention(this.selectedSessionId);
    if (!currentNeedsAttention) {
      const attention = sessions.find((s) => needsAttention(s.sessionId));
      if (attention) {
        this.selectedSessionId = attention.sessionId;
      } else if (!this.selectedSessionId) {
        const paused = sessions.find((s) => s.status === "PAUSED");
        const running = sessions.find((s) => s.status === "RUNNING");
        this.selectedSessionId = paused?.sessionId ?? running?.sessionId ?? sessions[0].sessionId;
      }
    }

    const sessionId = this.selectedSessionId;
    if (!sessionId) {
      this.postMessage({ command: "stateUpdate", payload: this.emptyPayload(sessions) });
      return;
    }
    const state = stateCache.get(sessionId) ?? null;

    let choices: PlanChoice[] | null = null;
    let planMd: string | null = null;

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
      interruptBriefing: state?.interruptBriefing ?? null,
      sessions,
    };

    this.postMessage({ command: "stateUpdate", payload });
  }

  private emptyPayload(sessions: PlanReviewSessionInfo[] = []): PlanReviewStatePayload {
    return { sessionId: "", awaitingPlanApproval: false, planApproved: false, choices: null, planMd: null, isPaused: false, phase: null, interruptBriefing: null, sessions };
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
      case "selectSession": {
        this.selectedSessionId = msg.sessionId ?? null;
        await this.pushState();
        break;
      }
      case "selectPlanChoice": {
        const sessionId = msg.sessionId;
        if (!sessionId) return;
        if (msg.choiceId === -1) {
          try {
            const planPath = await this.store.getPlanMdPath(sessionId);
            await fs.promises.unlink(planPath);
          } catch { /* plan.md may not exist */ }
          await this.pushState();
          break;
        }
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
        await this.pushState();
        break;
      }
      case "interruptSession": {
        const sessionId = msg.sessionId;
        if (!sessionId || !msg.message) return;
        const sessionDir = await this.store.getSessionDir(sessionId);
        const cfg = await this.store.getPathsConfig();
        const interruptPath = path.join(sessionDir, cfg.sessionFileNames.interruptMessage);
        try {
          await fs.promises.writeFile(interruptPath, msg.message, "utf8");
          vscode.window.showInformationMessage(`Message sent to ${sessionId}. Resuming...`);
          await this.client.resumeSession(sessionId);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`Failed to send interrupt message: ${errMsg}`);
        }
        await this.pushState();
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
    .session-bar { margin-bottom: 8px; }
    .session-bar select {
      width: 100%;
      font-family: inherit;
      font-size: 11px;
      padding: 3px 6px;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 3px;
    }
    .badge { display: inline-block; font-size: 9px; padding: 1px 5px; border-radius: 8px; margin-left: 4px; vertical-align: middle; }
    .badge.attention { background: var(--vscode-statusBarItemErrorBackground, #c33); color: var(--vscode-statusBarItemErrorForeground, #fff); }
    .badge.paused { background: var(--vscode-statusBarItemWarningBackground, #a80); color: var(--vscode-statusBarItemWarningForeground, #fff); }
    .badge.running { background: var(--vscode-statusBarItemProminentBackground, #06c); color: var(--vscode-statusBarItemProminentForeground, #fff); }
    .interrupt-briefing {
      border: 1px solid var(--vscode-inputValidation-warningBorder, #a80);
      border-radius: 4px;
      padding: 8px;
      margin-bottom: 8px;
      max-height: 300px;
      overflow-y: auto;
      white-space: pre-wrap;
      font-size: 11px;
      background: var(--vscode-inputValidation-warningBackground, rgba(170,136,0,0.1));
    }
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
    let state = ${JSON.stringify({ sessionId: null, awaitingPlanApproval: false, planApproved: false, choices: null, planMd: null, isPaused: false, phase: null, interruptBriefing: null, sessions: [] })};
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

    function sessionLabel(s) {
      const id = s.sessionId.length > 12 ? s.sessionId.slice(0, 12) + "…" : s.sessionId;
      let badge = "";
      const attention = s.awaitingPlanApproval || s.phase === "INTERRUPT";
      if (attention) badge = '<span class="badge attention">!</span>';
      else if (s.status === "PAUSED") badge = '<span class="badge paused">II</span>';
      else if (s.status === "RUNNING") badge = '<span class="badge running">▶</span>';
      const goal = s.goal ? s.goal.slice(0, 40) : "";
      return escapeHtml(id) + badge + " " + escapeHtml(goal);
    }

    function renderSessionSelector() {
      const sessions = state.sessions || [];
      if (sessions.length === 0) return "";
      const opts = sessions.map(function(s) {
        const sel = s.sessionId === state.sessionId ? " selected" : "";
        return '<option value="' + escapeHtml(s.sessionId) + '"' + sel + '>' + sessionLabel(s) + '</option>';
      }).join("");
      return '<div class="session-bar"><select id="session-select">' + opts + '</select></div>';
    }

    function render() {
      const root = document.getElementById("root");
      const selector = renderSessionSelector();

      if (!state.sessionId) {
        root.innerHTML = selector + '<div class="empty">Select a session to review plans.</div>';
        bindSessionSelector();
        return;
      }

      const hasChoices = state.choices && state.choices.length > 0;
      const hasPlan = state.planMd && state.planMd.trim().length > 0;
      const isInterrupt = state.phase === "INTERRUPT" && state.interruptBriefing;

      let content;
      if (isInterrupt) {
        content = renderInterrupt();
      } else if (state.awaitingPlanApproval && !hasPlan && hasChoices) {
        content = renderChoosing();
      } else if (state.awaitingPlanApproval && hasPlan) {
        content = renderReviewing();
      } else if (state.isPaused && hasPlan) {
        content = renderPausedReview();
      } else {
        content = '<div class="empty">No plan review pending for this session.</div>';
      }

      root.innerHTML = selector + content;
      bindSessionSelector();

      if (isInterrupt) {
        bindInterrupt();
      } else if (state.awaitingPlanApproval || (state.isPaused && hasPlan)) {
        bindChat();
      }
    }

    function bindSessionSelector() {
      const sel = document.getElementById("session-select");
      if (sel) {
        sel.onchange = function() {
          vscode.postMessage({ command: "selectSession", sessionId: sel.value });
        };
      }
    }

    function renderChoosing() {
      const choicesHtml = (state.choices || []).map(function(c) {
        return '<div class="choice-card" data-choice-id="' + c.id + '"><div class="choice-title">' + escapeHtml(c.title) + '</div><div class="choice-preview">' + escapeHtml(c.body.slice(0, 200)) + '</div></div>';
      }).join("");
      return '<h3>Plan Options</h3>' + choicesHtml;
    }

    function selectChoice(choiceId) {
      vscode.postMessage({ command: "selectPlanChoice", sessionId: state.sessionId, choiceId: choiceId });
    }

    function renderInterrupt() {
      return '<h3>\u26a0 Interrupt \u2014 Action Required</h3>' +
        '<div class="interrupt-briefing">' + escapeHtml(state.interruptBriefing || "") + '</div>' +
        '<div class="chat-area"><textarea id="chat-input" placeholder="Send a message to the interrupter before resuming... (Ctrl+Enter to send)"></textarea>' +
        '<div class="btn-row">' +
          '<button id="btn-revise" ' + (reviseBusy ? 'disabled' : '') + '>' + (reviseBusy ? '<span class="spinner"></span> Sending...' : 'Send Message') + '</button>' +
          '<button class="primary" id="btn-resume" ' + (reviseBusy ? 'disabled' : '') + '>Resume</button>' +
        '</div></div>';
    }

    function bindInterrupt() {
      const textarea = document.getElementById("chat-input");
      const btnRevise = document.getElementById("btn-revise");
      const btnResume = document.getElementById("btn-resume");

      function sendMessage() {
        if (!textarea || reviseBusy) return;
        const msg = textarea.value.trim();
        if (!msg) return;
        reviseBusy = true;
        render();
        vscode.postMessage({ command: "interruptSession", sessionId: state.sessionId, message: msg });
        textarea.value = "";
      }

      if (textarea) {
        textarea.onkeydown = function(e) {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            sendMessage();
          }
        };
      }
      if (btnRevise) btnRevise.onclick = sendMessage;
      if (btnResume) btnResume.onclick = function() {
        vscode.postMessage({ command: "resumeSession", sessionId: state.sessionId });
      };
    }

    function renderReviewing() {
      return '<h3>Plan Review</h3>' +
        '<div class="plan-preview">' + escapeHtml(state.planMd || "") + '</div>' +
        '<div class="chat-area"><textarea id="chat-input" placeholder="Request plan changes... (Ctrl+Enter to send)"></textarea>' +
        '<div class="btn-row">' +
          '<button id="btn-revise" ' + (reviseBusy ? 'disabled' : '') + '>' + (reviseBusy ? '<span class="spinner"></span> Revising...' : 'Revise Plan') + '</button>' +
          '<button class="primary" id="btn-approve" ' + (reviseBusy ? 'disabled' : '') + '>Approve & Start</button>' +
          '<button id="btn-back-choices" ' + (reviseBusy ? 'disabled' : '') + '>Back to Choices</button>' +
        '</div></div>';
    }

    function renderPausedReview() {
      return '<h3>Session Paused \u2014 Plan Review</h3>' +
        '<div class="plan-preview">' + escapeHtml(state.planMd || "") + '</div>' +
        '<div class="chat-area"><textarea id="chat-input" placeholder="Request plan changes... (Ctrl+Enter to send)"></textarea>' +
        '<div class="btn-row">' +
          '<button id="btn-revise" ' + (reviseBusy ? 'disabled' : '') + '>' + (reviseBusy ? '<span class="spinner"></span> Revising...' : 'Revise Plan') + '</button>' +
          '<button class="primary" id="btn-resume" ' + (reviseBusy ? 'disabled' : '') + '>Resume</button>' +
        '</div></div>';
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

    document.getElementById("root").addEventListener("click", function(e) {
      const card = e.target.closest(".choice-card");
      if (card && card.dataset.choiceId) {
        selectChoice(parseInt(card.dataset.choiceId, 10));
      }
    });

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
