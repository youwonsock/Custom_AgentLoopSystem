import * as vscode from "vscode";
import { readExtensionConfig, SessionMeta, ExtensionConfig } from "./types";
import { StateStore, setGlobalContext } from "./stateStore";
import { LoopClient } from "./loopClient";
import { LoopWebviewPanel } from "./webviewPanel";

let store: StateStore | undefined;
let client: LoopClient | undefined;
let config: ExtensionConfig;
let globalContext: vscode.ExtensionContext | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  setGlobalContext(context);
  globalContext = context;

  config = readExtensionConfig();
  store = new StateStore(config);
  client = new LoopClient(config, store);

  store.ensureInitialized().catch((err) => {
    console.error("[agentLoop] Failed to initialize store:", err);
  });

  store.startPolling(config.pollIntervalMs);

  const sessionExplorerProvider = new SessionExplorerProvider(store);

  const updateNoSessionsContext = async () => {
    try {
      const registry = await store!.readRegistry();
      const noSessions = !registry.sessionMetas || registry.sessionMetas.length === 0;
      await vscode.commands.executeCommand("setContext", "agentLoop.noSessions", noSessions);
    } catch (err) {
      console.error("[agentLoop] Failed to update noSessions context:", err);
    }
  };
  store.onChange(() => {
    updateNoSessionsContext().catch(() => {});
  });
  updateNoSessionsContext().catch(() => {});

  try {
    await store.ensureInitialized();
    const autoOpenedFlag = "agentLoop.panelAutoOpened";
    const alreadyOpened = context.globalState.get<boolean>(autoOpenedFlag, false);
    if (!alreadyOpened) {
      const registry = await store.readRegistry();
      if (registry.sessionMetas.length === 0) {
        const panel = LoopWebviewPanel.getInstance(context, store!, client!, config);
        panel.show();
      }
      await context.globalState.update(autoOpenedFlag, true);
    }
  } catch (err) {
    console.error("[agentLoop] First-run auto-open failed:", err);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("agentLoop.showPanel", async () => {
      await store!.ensureInitialized();
      const panel = LoopWebviewPanel.getInstance(context, store!, client!, config);
      panel.show();
    }),

    vscode.commands.registerCommand("agentLoop.newSession", async () => {
      await store!.ensureInitialized();
      const panel = LoopWebviewPanel.getInstance(context, store!, client!, config);
      panel.postFocusComposer();
    }),

    vscode.commands.registerCommand("agentLoop.resumeSession", async () => {
      await store!.ensureInitialized();
      const registry = await store!.readRegistry();
      if (registry.sessionMetas.length === 0) {
        vscode.window.showInformationMessage("Agent Loop: No sessions found to resume.");
        return;
      }
      const items = registry.sessionMetas.map((m: SessionMeta) => ({
        label: m.sessionId,
        description: m.status,
        detail: m.goal,
        sessionId: m.sessionId,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: "Select a session to resume",
        ignoreFocusOut: true,
      });
      if (!picked) return;
      const panel = LoopWebviewPanel.getInstance(context, store!, client!, config);
      panel.show();
      panel.postResumeSession(picked.sessionId);
    }),

    vscode.commands.registerCommand("agentLoop.discoverModels", async () => {
      await store!.ensureInitialized();
      const panel = LoopWebviewPanel.getInstance(context, store!, client!, config);
      panel.show();
      panel.postDiscoverModels();
    }),

    vscode.commands.registerCommand("agentLoop.newSession", async () => {
      await store!.ensureInitialized();
      const panel = LoopWebviewPanel.getInstance(context, store!, client!, config);
      panel.postFocusComposer();
    }),

    vscode.commands.registerCommand("agentLoop.resumeSession", async () => {
      await store!.ensureInitialized();
      const registry = await store!.readRegistry();
      if (registry.sessionMetas.length === 0) {
        vscode.window.showInformationMessage("Agent Loop: No sessions found to resume.");
        return;
      }
      const items = registry.sessionMetas.map((m: SessionMeta) => ({
        label: m.sessionId,
        description: m.status,
        detail: m.goal,
        sessionId: m.sessionId,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: "Select a session to resume",
        ignoreFocusOut: true,
      });
      if (!picked) return;
      const panel = LoopWebviewPanel.getInstance(context, store!, client!, config);
      panel.show();
      panel.postResumeSession(picked.sessionId);
    }),

    vscode.commands.registerCommand("agentLoop.discoverModels", async () => {
      await store!.ensureInitialized();
      const panel = LoopWebviewPanel.getInstance(context, store!, client!, config);
      panel.show();
      panel.postDiscoverModels();
    }),

    vscode.commands.registerCommand("agentLoop.stopSession", async () => {
      const active = client!.getActiveSessionIds();
      if (active.length === 0) {
        vscode.window.showInformationMessage("Agent Loop: No active sessions to stop.");
        return;
      }
      const picked = await vscode.window.showQuickPick(
        active.map((sid) => ({ label: sid, sessionId: sid })),
        { placeHolder: "Select a session to stop", ignoreFocusOut: true }
      );
      if (!picked) return;
      client!.stopSession(picked.sessionId);
      vscode.window.showInformationMessage(`Agent Loop: Stopped session ${picked.sessionId}`);
    }),

    vscode.commands.registerCommand("agentLoop.refresh", async () => {
      sessionExplorerProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("agentLoop")) {
        const freshConfig = readExtensionConfig();
        config = freshConfig;
        if (store) { (store as any).config = freshConfig; }
        if (client) { (client as any).config = freshConfig; }
        try {
          globalContext?.globalState.update("agentLoop.detectedRoot", undefined).then(() => {}, () => {});
        } catch {
          // ignore
        }
        sessionExplorerProvider.refresh();
        vscode.window.showInformationMessage("Agent Loop: Configuration updated. Re-discover models if needed.");
      }
    })
  );

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("agentLoopExplorer", sessionExplorerProvider)
  );

  context.subscriptions.push({
    dispose: () => {
      store?.stopPolling();
      client?.dispose();
    },
  });
}

export function deactivate(): void {
  store?.stopPolling();
  client?.dispose();
}

class SessionExplorerProvider implements vscode.TreeDataProvider<SessionNode> {
  private readonly emitter = new vscode.EventEmitter<SessionNode | undefined | null>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly store: StateStore) {
    this.store.onChange(() => this.refresh());
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(element: SessionNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: SessionNode): Promise<SessionNode[]> {
    if (element) {
      return [];
    }
    const registry = await this.store.readRegistry();
    return registry.sessionMetas.map(
      (m) =>
        new SessionNode(
          m.sessionId,
          m.status,
          m.goal,
          vscode.TreeItemCollapsibleState.None,
          {
            command: "agentLoop.showPanel",
            title: "Show Panel",
            arguments: [],
          }
        )
    );
  }
}

class SessionNode extends vscode.TreeItem {
  constructor(
    sessionId: string,
    status: string,
    goal: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    command?: vscode.Command
  ) {
    super(sessionId, collapsibleState);
    this.description = status;
    this.tooltip = goal;
    this.command = command;
    this.contextValue = "session";
    this.iconPath = new vscode.ThemeIcon(
      status === "RUNNING"
        ? "sync~spin"
        : status === "SUCCESS"
        ? "check-all"
        : status === "FAILED"
        ? "error"
        : status === "PAUSED"
        ? "debug-pause"
        : "circle-outline"
    );
  }
}
