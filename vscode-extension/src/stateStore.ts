import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as vscode from "vscode";
import {
  ExtensionConfig,
  LoopState,
  SessionBundle,
  SessionRegistry,
  LoopHistoryEntry,
  FinalSummary,
  readExtensionConfig,
} from "./types";

let globalContext: vscode.ExtensionContext | undefined;

export class StateStore {
  private registryCache: SessionRegistry | null = null;
  private stateCache: Map<string, LoopState> = new Map();
  private pollTimer: NodeJS.Timeout | null = null;
  private listeners: Array<() => void> = [];

  constructor(private readonly config: ExtensionConfig) {}

  async getRootDir(): Promise<string> {
    const liveRootDir = readExtensionConfig().rootDir;
    if (liveRootDir && liveRootDir.length > 0) {
      return path.resolve(liveRootDir);
    }
    if (this.config.rootDir && this.config.rootDir.length > 0) {
      return path.resolve(this.config.rootDir);
    }
    const envRoot = process.env.AGENT_LOOP_ROOT;
    if (envRoot && envRoot.length > 0) {
      const resolved = path.resolve(envRoot);
      try {
        await fs.access(path.join(resolved, "dist", "loop_orchestrator.js"));
        await this.cacheDetectedRoot(resolved);
        return resolved;
      } catch {
        // env var stale, continue
      }
    }
    if (globalContext) {
      const cached = globalContext.globalState.get<string>("agentLoop.detectedRoot");
      if (cached && cached.length > 0) {
        try {
          await fs.access(path.join(cached, "dist", "loop_orchestrator.js"));
          return cached;
        } catch {
          // stale cache, fall through
        }
      }
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const distScript = path.join(folder.uri.fsPath, "dist", "loop_orchestrator.js");
      const registry = path.join(folder.uri.fsPath, "sessions_registry.json");
      try {
        await fs.access(distScript);
        await this.cacheDetectedRoot(folder.uri.fsPath);
        return folder.uri.fsPath;
      } catch {
        // not here
      }
      try {
        await fs.access(registry);
        await this.cacheDetectedRoot(folder.uri.fsPath);
        return folder.uri.fsPath;
      } catch {
        // not here
      }
    }
    if (globalContext) {
      const storagePath = globalContext.globalStorageUri.fsPath;
      await fs.mkdir(storagePath, { recursive: true });
      return storagePath;
    }
    const defaultDir = path.join(os.homedir(), ".agent-loop");
    await fs.mkdir(defaultDir, { recursive: true });
    return defaultDir;
  }

  private async cacheDetectedRoot(root: string): Promise<void> {
    if (globalContext) {
      try {
        await globalContext.globalState.update("agentLoop.detectedRoot", root);
      } catch {
        // ignore persistence failure
      }
    }
  }

  getRegistryPath = async (): Promise<string> => {
    const root = await this.getRootDir();
    return path.join(root, "sessions_registry.json");
  };

  getSessionDir = async (sessionId: string): Promise<string> => {
    const root = await this.getRootDir();
    return path.join(root, ".goal", "sessions", sessionId);
  };

  async ensureInitialized(): Promise<void> {
    const registryPath = await this.getRegistryPath();
    try {
      await fs.access(registryPath);
    } catch {
      const root = await this.getRootDir();
      await fs.mkdir(path.join(root, ".goal", "sessions"), { recursive: true });
      const empty: SessionRegistry = {
        version: 1,
        activeSessionIds: [],
        availableModels: [],
        modelsDiscoveredAt: null,
        modelsDiscoveredCli: null,
        sessionMetas: [],
        manualModelsOverride: null,
        modelVariants: null,
      };
      await this.writeJsonAtomic(registryPath, empty);
      this.registryCache = empty;
    }
  }

  async readRegistry(): Promise<SessionRegistry> {
    const registryPath = await this.getRegistryPath();
    const data = await this.readJsonAtomic<SessionRegistry>(registryPath);
    if (data) {
      this.registryCache = data;
      return data;
    }
    if (this.registryCache) {
      return this.registryCache;
    }
    try {
      await fs.access(registryPath);
      const backupPath = `${registryPath}.corrupt.${Date.now()}`;
      try {
        await fs.copyFile(registryPath, backupPath);
        console.error(`[StateStore] Corrupted registry at ${registryPath}. Backed up to ${backupPath}.`);
      } catch {
        // ignore backup failure
      }
      await fs.unlink(registryPath).catch(() => {});
    } catch {
      // file doesn't exist, will be created below
    }
    await this.ensureInitialized();
    const fresh = await this.readJsonAtomic<SessionRegistry>(registryPath);
    if (fresh) {
      this.registryCache = fresh;
      return fresh;
    }
    const fallback: SessionRegistry = {
      version: 1,
      activeSessionIds: [],
      availableModels: [],
      modelsDiscoveredAt: null,
      modelsDiscoveredCli: null,
      sessionMetas: [],
      manualModelsOverride: null,
      modelVariants: null,
    };
    this.registryCache = fallback;
    return fallback;
  }

  async writeRegistry(registry: SessionRegistry): Promise<void> {
    const registryPath = await this.getRegistryPath();
    await this.writeJsonAtomic(registryPath, registry);
    this.registryCache = registry;
    this.notifyListeners();
  }

  async deleteSession(sessionId: string): Promise<{ removedFromRegistry: boolean; dirRemoved: boolean; error?: string }> {
    let removedFromRegistry = false;
    let dirRemoved = false;
    try {
      const registry = await this.readRegistry();
      const before = registry.sessionMetas.length;
      registry.sessionMetas = registry.sessionMetas.filter((m) => m.sessionId !== sessionId);
      registry.activeSessionIds = (registry.activeSessionIds || []).filter((id) => id !== sessionId);
      if (registry.sessionMetas.length < before) {
        await this.writeRegistry(registry);
        removedFromRegistry = true;
      }
      this.stateCache.delete(sessionId);
      const sessionDir = await this.getSessionDir(sessionId);
      try {
        await fs.rm(sessionDir, { recursive: true, force: true });
        dirRemoved = true;
      } catch (err) {
        return {
          removedFromRegistry,
          dirRemoved: false,
          error: `Registry updated but failed to remove session directory: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    } catch (err) {
      return {
        removedFromRegistry,
        dirRemoved,
        error: `Failed to delete session: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return { removedFromRegistry, dirRemoved };
  }

  async readState(sessionId: string): Promise<LoopState | null> {
    const cached = this.stateCache.get(sessionId);
    const statePath = path.join(await this.getSessionDir(sessionId), "loop_state.json");
    const data = await this.readJsonAtomic<LoopState>(statePath);
    if (data) {
      this.stateCache.set(sessionId, data);
      return data;
    }
    return cached ?? null;
  }

  async readProgressNotes(sessionId: string): Promise<string> {
    const notesPath = path.join(await this.getSessionDir(sessionId), "progress_notes.txt");
    try {
      return await fs.readFile(notesPath, "utf8");
    } catch {
      return "";
    }
  }

  async readHistory(sessionId: string): Promise<LoopHistoryEntry[]> {
    const historyDir = path.join(await this.getSessionDir(sessionId), "loop_history");
    try {
      const files = await fs.readdir(historyDir);
      const entries: LoopHistoryEntry[] = [];
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const filePath = path.join(historyDir, file);
        const data = await this.readJsonAtomic<LoopHistoryEntry>(filePath);
        if (data) entries.push(data);
      }
      entries.sort((a, b) => {
        if (a.loopNumber !== b.loopNumber) return a.loopNumber - b.loopNumber;
        return a.startedAt.localeCompare(b.startedAt);
      });
      return entries;
    } catch {
      return [];
    }
  }

  async readFinalSummary(sessionId: string): Promise<FinalSummary | null> {
    const summaryPath = path.join(await this.getSessionDir(sessionId), "final_summary.json");
    return this.readJsonAtomic<FinalSummary>(summaryPath);
  }

  async readBundle(sessionId: string): Promise<SessionBundle> {
    const registry = await this.readRegistry();
    const [state, progressNotes, history, finalSummary] = await Promise.all([
      this.readState(sessionId),
      this.readProgressNotes(sessionId),
      this.readHistory(sessionId),
      this.readFinalSummary(sessionId),
    ]);
    return { registry, state, progressNotes, history, finalSummary };
  }

  startPolling(intervalMs: number): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      this.notifyListeners();
    }, intervalMs);
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  removeChangeListener(listener: () => void): void {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        console.error("[StateStore] listener error:", err);
      }
    }
  }

  private async readJsonAtomic<T>(filePath: string): Promise<T | null> {
    try {
      const content = await fs.readFile(filePath, "utf8");
      return JSON.parse(content) as T;
    } catch {
      return null;
    }
  }

  private async writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf8");
    await this.renameWithRetry(tmpPath, filePath);
  }

  private async renameWithRetry(src: string, dest: string, maxRetries = 5): Promise<void> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await fs.rename(src, dest);
        return;
      } catch (err: unknown) {
        lastErr = err;
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EPERM" || code === "EBUSY" || code === "EACCES") {
          await new Promise<void>((resolve) => setTimeout(resolve, 50 * Math.pow(2, attempt)));
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }
}

export function setGlobalContext(context: vscode.ExtensionContext): void {
  globalContext = context;
}

export function getGlobalContext(): vscode.ExtensionContext | undefined {
  return globalContext;
}
