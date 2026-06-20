import * as path from "node:path";
import * as vscode from "vscode";
import {
  WebviewMessage,
  WebviewStatePayload,
  SessionRegistry,
  LoopState,
  LoopHistoryEntry,
  FinalSummary,
  ModelMapping,
  ExtensionConfig,
  readExtensionConfig,
} from "./types";
import { StateStore } from "./stateStore";
import { LoopClient, LogEntry } from "./loopClient";

export class LoopWebviewPanel {
  private static instance: LoopWebviewPanel | undefined;
  private panel: vscode.WebviewPanel | undefined;
  private selectedSessionId: string | null = null;
  private logBuffers: Map<string, string> = new Map();
  private readonly maxLogBuffer = 50000;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: StateStore,
    private readonly client: LoopClient,
    private readonly config: ExtensionConfig
  ) {
    this.store.onChange(() => this.refresh());
  }

  static getInstance(context: vscode.ExtensionContext, store: StateStore, client: LoopClient, config: ExtensionConfig): LoopWebviewPanel {
    if (!LoopWebviewPanel.instance) {
      LoopWebviewPanel.instance = new LoopWebviewPanel(context, store, client, config);
    }
    return LoopWebviewPanel.instance;
  }

  show(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active, false);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "agentLoopPanel",
      "Agent Loop Orchestrator",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, "media"),
          vscode.Uri.joinPath(this.context.extensionUri, "out"),
        ],
      }
    );

    this.panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, "media", "icon.svg");

    this.panel.webview.html = this.getHtml(this.panel.webview);

    this.panel.webview.onDidReceiveMessage(
      (msg: WebviewMessage) => this.handleMessage(msg),
      undefined,
      this.context.subscriptions
    );

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    }, undefined, this.context.subscriptions);

    this.refresh();
  }

  postNewSession(opts: { goal: string; targetProjectPath: string }): void {
    this.show();
    const modelMapping: Partial<ModelMapping> = {};
    this.handleMessage({
      command: "newSession",
      goal: opts.goal,
      targetProjectPath: opts.targetProjectPath,
      modelMapping,
    });
  }

  postResumeSession(sessionId: string): void {
    this.show();
    this.handleMessage({ command: "resumeSession", sessionId });
  }

  postDiscoverModels(): void {
    this.show();
    this.handleMessage({ command: "discoverModels" });
  }

  private async handleMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.command) {
      case "requestState":
        await this.refresh();
        break;
      case "newSession":
        await this.handleNewSession(msg);
        break;
      case "resumeSession":
        await this.handleResume(msg);
        break;
      case "stopSession":
        this.client.stopSession(msg.sessionId);
        vscode.window.showInformationMessage(`Agent Loop: Stopped session ${msg.sessionId}`);
        await this.refresh();
        break;
      case "discoverModels":
        await this.handleDiscoverModels();
        break;
      case "selectSession":
        this.selectedSessionId = msg.sessionId;
        await this.refresh();
        break;
      case "refreshModels":
        await this.handleDiscoverModels();
        break;
      case "openProgressNotes":
        await this.openProgressNotes(msg.sessionId);
        break;
      case "openFinalSummary":
        await this.openFinalSummary(msg.sessionId);
        break;
    }
  }

  postFocusComposer(): void {
    this.show();
    this.postMessage({ command: "focusComposer" });
  }

  private async handleNewSession(msg: { goal: string; targetProjectPath: string; cliProfile?: string; modelMapping: Partial<ModelMapping> }): Promise<void> {
    if (!msg.goal || msg.goal.trim().length === 0) {
      vscode.window.showErrorMessage("Goal is required.");
      return;
    }
    const target = msg.targetProjectPath && msg.targetProjectPath.length > 0
      ? msg.targetProjectPath
      : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

    if (msg.cliProfile) {
      const cfg = vscode.workspace.getConfiguration("agentLoop");
      await cfg.update("cliProfile", msg.cliProfile, vscode.ConfigurationTarget.Global);
    }

    try {
      const sessionId = await this.client.startNewSession({
        goal: msg.goal,
        targetProjectPath: target,
        modelMapping: msg.modelMapping,
      });
      this.selectedSessionId = sessionId;
      this.attachLogListener(sessionId);
      vscode.window.showInformationMessage(`Agent Loop: Started session ${sessionId}`);
      await this.refresh();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to start session: ${errMsg}`);
    }
  }

  private async handleResume(msg: { sessionId: string }): Promise<void> {
    try {
      const sessionId = await this.client.resumeSession(msg.sessionId);
      this.selectedSessionId = msg.sessionId;
      this.attachLogListener(msg.sessionId);
      vscode.window.showInformationMessage(`Agent Loop: Resumed session ${msg.sessionId}`);
      await this.refresh();
    } catch (err) {
      const msgText = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to resume session: ${msgText}`);
    }
  }

  private async handleDiscoverModels(): Promise<void> {
    try {
      const models = await this.client.discoverModels();
      const registry = await this.store.readRegistry();
      registry.availableModels = models;
      registry.modelsDiscoveredAt = new Date().toISOString();
      await this.store.writeRegistry(registry);
      vscode.window.showInformationMessage(`Agent Loop: Discovered ${models.length} models.`);
      await this.refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Model discovery failed: ${msg}`);
    }
  }

  private attachLogListener(sessionId: string): void {
    this.logBuffers.set(sessionId, "");
    this.client.onLog(sessionId, (entry: LogEntry) => {
      const buf = this.logBuffers.get(sessionId) ?? "";
      const newBuf = (buf + entry.text).slice(-this.maxLogBuffer);
      this.logBuffers.set(sessionId, newBuf);
      this.postMessage({ command: "logAppend", sessionId, entry });
    });
    this.client.onExit(sessionId, async () => {
      await this.refresh();
      setTimeout(() => {
        this.logBuffers.delete(sessionId);
        this.client.removeLogListener(sessionId);
        this.client.removeExitListener(sessionId);
      }, 5000);
    });
  }

  private refreshPending: Promise<void> | null = null;

  private async refresh(): Promise<void> {
    if (!this.panel) return;
    if (this.refreshPending) {
      return this.refreshPending;
    }
    this.refreshPending = this.doRefresh();
    try {
      await this.refreshPending;
    } finally {
      this.refreshPending = null;
    }
  }

  private async doRefresh(): Promise<void> {
    if (!this.panel) return;
    const registry = await this.store.readRegistry();

    if (!this.selectedSessionId && registry.sessionMetas.length > 0) {
      const running = registry.sessionMetas.find((m) => m.status === "RUNNING");
      this.selectedSessionId = running?.sessionId ?? registry.sessionMetas[0].sessionId;
    }

    let state: LoopState | null = null;
    let progressNotes = "";
    let history: LoopHistoryEntry[] = [];
    let finalSummary: FinalSummary | null = null;

    if (this.selectedSessionId) {
      const bundle = await this.store.readBundle(this.selectedSessionId);
      state = bundle.state;
      progressNotes = bundle.progressNotes;
      history = bundle.history;
      finalSummary = bundle.finalSummary;
    }

    const isRunning = this.selectedSessionId ? this.client.isRunning(this.selectedSessionId) : false;

    const defaultTargetPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const liveCfg = readExtensionConfig();

    const payload: WebviewStatePayload = {
      registry,
      selectedSessionId: this.selectedSessionId,
      state,
      progressNotes,
      history,
      finalSummary,
      isRunning,
      defaultTargetPath,
      cliProfile: liveCfg.cliProfile,
    };

    this.postMessage({ command: "stateUpdate", payload });
  }

  private async openProgressNotes(sessionId: string): Promise<void> {
    try {
      const sessionDir = await this.store.getSessionDir(sessionId);
      const notesPath = path.join(sessionDir, "progress_notes.txt");
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(notesPath));
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to open progress notes: ${msg}`);
    }
  }

  private async openFinalSummary(sessionId: string): Promise<void> {
    try {
      const sessionDir = await this.store.getSessionDir(sessionId);
      const summaryPath = path.join(sessionDir, "final_summary.json");
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(summaryPath));
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to open final summary (session may not be complete yet): ${msg}`);
    }
  }

  private postMessage(msg: unknown): void {
    if (this.panel) {
      this.panel.webview.postMessage(msg).then(
        () => {},
        (err) => console.error("[WebviewPanel] postMessage failed:", err)
      );
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const mediaUri = vscode.Uri.joinPath(this.context.extensionUri, "media");
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, "webview.css"));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, "webview.js"));
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Agent Loop Orchestrator</title>
  <link rel="stylesheet" href="${cssUri}" />
</head>
<body>
  <div id="root">
    <div class="loading">Loading...</div>
  </div>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const crypto = require("node:crypto");
  return crypto.randomBytes(16).toString("base64");
}
