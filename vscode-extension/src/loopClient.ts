import { ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { ExtensionConfig, ModelMapping } from "./types";
import { StateStore } from "./stateStore";

export interface NewSessionOptions {
  goal: string;
  targetProjectPath: string;
  modelMapping: Partial<ModelMapping>;
}

export interface LogEntry {
  timestamp: string;
  stream: "stdout" | "stderr";
  text: string;
}

export class LoopClient {
  private activeProcesses: Map<string, ChildProcess> = new Map();
  private logListeners: Map<string, (entry: LogEntry) => void> = new Map();
  private exitListeners: Map<string, (code: number | null, signal: NodeJS.Signals | null) => void> = new Map();

  constructor(
    private readonly config: ExtensionConfig,
    private readonly store: StateStore
  ) {}

  async resolveOrchestratorScript(): Promise<string> {
    if (this.config.orchestratorScript && this.config.orchestratorScript.length > 0) {
      return path.resolve(this.config.orchestratorScript);
    }
    const candidates: string[] = [];
    const root = await this.store.getRootDir();
    candidates.push(path.join(root, "dist", "loop_orchestrator.js"));
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      candidates.push(path.join(folder.uri.fsPath, "dist", "loop_orchestrator.js"));
    }
    candidates.push(path.join(process.cwd(), "dist", "loop_orchestrator.js"));
    for (const candidate of candidates) {
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        // try next
      }
    }
    return candidates[0];
  }

  async discoverModels(): Promise<string[]> {
    const root = await this.store.getRootDir();
    const script = await this.resolveOrchestratorScript();
    const args = ["models", "--binary", this.config.cliBinary, "--root", root];
    return new Promise<string[]>((resolve) => {
      const child = spawn(this.config.nodeBinary, [script, ...args], {
        cwd: root,
        env: process.env,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", (err) => {
        vscode.window.showErrorMessage(`Failed to run model discovery: ${err.message}`);
        resolve([]);
      });
      child.on("exit", () => {
        const models: string[] = [];
        const lines = stdout.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          const match = trimmed.match(/^([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)$/);
          if (match) {
            const model = `${match[1]}/${match[2]}`;
            if (!models.includes(model)) {
              models.push(model);
            }
          }
        }
        resolve(models);
      });
    });
  }

  async startNewSession(opts: NewSessionOptions): Promise<string> {
    const root = await this.store.getRootDir();
    const script = await this.resolveOrchestratorScript();

    const args: string[] = [
      script,
      "run",
      "--goal", opts.goal,
      "--target", opts.targetProjectPath,
      "--binary", this.config.cliBinary,
      "--root", root,
      "--max-iterations", String(this.config.maxIterations),
      "--phase-timeout", String(this.config.phaseTimeoutMs),
      "--idle-timeout", String(this.config.idleTimeoutMs),
    ];

    if (opts.modelMapping.planner) args.push("--planner-model", opts.modelMapping.planner);
    if (opts.modelMapping.implementer) args.push("--implementer-model", opts.modelMapping.implementer);
    if (opts.modelMapping.tester) args.push("--tester-model", opts.modelMapping.tester);
    if (opts.modelMapping.qa_lead) args.push("--qa-model", opts.modelMapping.qa_lead);
    if (opts.modelMapping.master) args.push("--master-model", opts.modelMapping.master);
    if (opts.modelMapping.interrupter) args.push("--interrupter-model", opts.modelMapping.interrupter);

    return this.spawnSession(args, root);
  }

  async resumeSession(sessionId: string): Promise<string> {
    const root = await this.store.getRootDir();
    const script = await this.resolveOrchestratorScript();

    const args: string[] = [
      script,
      "resume",
      "--session", sessionId,
      "--root", root,
    ];

    return this.spawnSession(args, root);
  }

  private spawnSession(args: string[], cwd: string): string {
    const child = spawn(this.config.nodeBinary, args, {
      cwd,
      env: process.env,
    });

    let sessionId = `proc-${child.pid}`;
    const sessionIdx = args.indexOf("--session");
    if (sessionIdx >= 0 && sessionIdx + 1 < args.length) {
      sessionId = args[sessionIdx + 1];
    }

    this.activeProcesses.set(sessionId, child);

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      this.emitLog(sessionId, { timestamp: new Date().toISOString(), stream: "stdout", text });
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      this.emitLog(sessionId, { timestamp: new Date().toISOString(), stream: "stderr", text });
    });

    child.on("error", (err) => {
      vscode.window.showErrorMessage(`Agent loop process error: ${err.message}`);
    });

    child.on("exit", (code, signal) => {
      this.activeProcesses.delete(sessionId);
      const listeners = this.exitListeners.get(sessionId);
      if (listeners) {
        listeners(code, signal);
        this.exitListeners.delete(sessionId);
      }
      this.emitLog(sessionId, {
        timestamp: new Date().toISOString(),
        stream: "stderr",
        text: `\n[process exited] code=${code ?? "null"} signal=${signal ?? "null"}\n`,
      });
    });

    return sessionId;
  }

  stopSession(sessionId: string): void {
    const child = this.activeProcesses.get(sessionId);
    if (child) {
      let exited = false;
      child.on("exit", () => { exited = true; });
      try { child.kill("SIGTERM"); } catch { /* already dead */ }
      const killTimer = setTimeout(() => {
        if (!exited && child.exitCode === null && child.signalCode === null) {
          try { child.kill("SIGKILL"); } catch { /* already dead */ }
        }
      }, 5000);
      child.on("exit", () => clearTimeout(killTimer));
    }
    this.activeProcesses.delete(sessionId);
  }

  stopAll(): void {
    for (const [sid, child] of this.activeProcesses) {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
      this.activeProcesses.delete(sid);
    }
  }

  isRunning(sessionId: string): boolean {
    const child = this.activeProcesses.get(sessionId);
    return !!child && !child.killed;
  }

  getActiveSessionIds(): string[] {
    return Array.from(this.activeProcesses.keys());
  }

  onLog(sessionId: string, listener: (entry: LogEntry) => void): void {
    this.logListeners.set(sessionId, listener);
  }

  onExit(sessionId: string, listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitListeners.set(sessionId, listener);
  }

  removeLogListener(sessionId: string): void {
    this.logListeners.delete(sessionId);
  }

  removeExitListener(sessionId: string): void {
    this.exitListeners.delete(sessionId);
  }

  private emitLog(sessionId: string, entry: LogEntry): void {
    const listener = this.logListeners.get(sessionId);
    if (listener) {
      listener(entry);
    }
  }

  dispose(): void {
    this.stopAll();
    this.logListeners.clear();
    this.exitListeners.clear();
  }
}
