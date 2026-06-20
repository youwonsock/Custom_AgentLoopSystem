#!/usr/bin/env node

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execFile, exec } from "node:child_process";
import * as fse from "fs-extra";
import * as pty from "node-pty";

function resolveBinaryOnWindows(binary: string): string {
  if (process.platform !== "win32") return binary;
  if (path.extname(binary).length > 0) return binary;
  if (path.isAbsolute(binary) && fs.existsSync(binary)) return binary;
  const pathExt = process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD;.VBS;.JS;.WS;.MSC";
  const extensions = pathExt.split(";").filter((e) => e.length > 0);
  const pathDirs = (process.env.PATH || "").split(path.delimiter).filter((d) => d.length > 0);
  for (const dir of pathDirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, binary + ext);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        // ignore inaccessible entries
      }
    }
  }
  return binary;
}

type AnyObj = Record<string, unknown>;

enum LoopStatus {
  RUNNING = "RUNNING",
  PAUSED = "PAUSED",
  SUCCESS = "SUCCESS",
  FAILED = "FAILED",
}

enum Phase {
  PLANNING = "PLANNING",
  IMPLEMENTATION = "IMPLEMENTATION",
  TEST_GENERATION = "TEST_GENERATION",
  VERIFICATION = "VERIFICATION",
  MASTER_APPROVAL = "MASTER_APPROVAL",
  INTERRUPT = "INTERRUPT",
}

type AgentRole = "planner" | "implementer" | "tester" | "qa_lead" | "master" | "interrupter";

interface ModelMapping {
  planner: string;
  implementer: string;
  tester: string;
  qa_lead: string;
  master: string;
  interrupter: string;
}

interface ErrorSignature {
  signature: string;
  rawMessage: string;
  timestamp: number;
  phase: Phase;
}

interface AgentState {
  status: "idle" | "running" | "completed" | "failed";
  lastExitCode: number | null;
  lastRunAt: string | null;
}

interface LoopState {
  sessionId: string;
  status: LoopStatus;
  phase: Phase;
  loopCount: number;
  goal: string;
  targetProjectPath: string;
  modelMapping: ModelMapping;
  errorQueue: ErrorSignature[];
  agentStates: Record<AgentRole, AgentState>;
  refinedGoal: string | null;
  planningComplete: boolean;
  masterApproved: boolean;
  lastFailureDigest: string | null;
  createdAt: string;
  updatedAt: string;
  maxIterations: number;
  phaseTimeoutMs: number;
  idleTimeoutMs: number;
  cliBinary: string;
  cliProfile: string;
}

interface SessionMeta {
  sessionId: string;
  goal: string;
  targetProjectPath: string;
  status: LoopStatus;
  createdAt: string;
}

interface SessionRegistry {
  version: number;
  activeSessionIds: string[];
  availableModels: string[];
  modelsDiscoveredAt: string | null;
  sessionMetas: SessionMeta[];
  manualModelsOverride: string[] | null;
}

interface HandoffPayload {
  sessionId: string;
  refinedGoal: string;
  targetProjectPath: string;
  progressNotes: string;
  failureDigest: string | null;
  phase: Phase;
  loopCount: number;
}

interface AgentSkills {
  role: AgentRole;
  allowedTools: string[];
  enforcedRules: string[];
  systemPrompt: string;
}

interface AgentRoom {
  role: AgentRole;
  statePath: string;
  skillsPath: string;
  inputPayloadPath: string;
  outputPayloadPath: string;
}

interface LoopHistoryEntry {
  loopNumber: number;
  phase: Phase;
  agentRole: AgentRole;
  model: string;
  exitCode: number;
  startedAt: string;
  endedAt: string;
  output: string;
  result: "success" | "failure" | "timeout";
  signature: string | null;
}

interface FinalSummary {
  sessionId: string;
  goal: string;
  achievedAt: string;
  totalLoops: number;
  finalModelMapping: ModelMapping;
  progressNotes: string;
  approvedByMaster: boolean;
}

interface PtyRunResult {
  pid: number;
  exitCode: number;
  output: string;
  events: AnyObj[];
  timedOut: boolean;
  autoInjected: { prompt: string; response: string; timestamp: string }[];
}

interface SpawnHandle {
  pid: number;
  done: Promise<PtyRunResult>;
}

interface SpawnCliOptions {
  model: string;
  agentRole: AgentRole;
  sessionId: string;
  targetProjectPath: string;
  prompt: string;
  timeoutMs: number;
  idleTimeoutMs: number;
  cliBinary: string;
  cliProfile: CliProfile;
  phaseLabel: string;
}

const SENTINEL = "[PHASE_DONE]";

const INTERACTION_WHITELIST: string[] = [
  "Apply changes? [y/n]",
  "Apply changes? (y/n)",
  "Continue? [y/n]",
  "Continue? (y/n)",
  "Proceed? [y/n]",
  "Proceed? (y/n)",
  "Allow? [y/n]",
  "Allow? (y/n)",
  "Overwrite? [y/n]",
  "Confirm? [y/n]",
  "Do you want to continue? [y/n]",
  "Do you want to apply",
];

const DESTRUCTIVE_PROMPTS: string[] = [
  "Delete",
  "Remove all",
  "Destroy",
  "Force overwrite",
  "git clean",
  "git checkout --",
  "git reset --hard",
  "Drop table",
  "Drop database",
];

interface CliProfile {
  name: string;
  defaultBinary: string;
  modelsArgs: string[];
  buildRunArgs: (opts: { model: string; targetProjectPath: string; prompt: string }) => string[];
  interactionWhitelist: string[];
}

const OPENCODE_PROFILE: CliProfile = {
  name: "opencode",
  defaultBinary: "opencode",
  modelsArgs: ["models"],
  buildRunArgs: (opts) => [
    "run",
    "--format", "json",
    "--model", opts.model,
    "--dir", opts.targetProjectPath,
    "--dangerously-skip-permissions",
    opts.prompt,
  ],
  interactionWhitelist: INTERACTION_WHITELIST,
};

const KILO_PROFILE: CliProfile = {
  name: "kilo",
  defaultBinary: "kilo",
  modelsArgs: ["models"],
  buildRunArgs: (opts) => [
    "run",
    "--auto",
    "--format", "json",
    "--model", opts.model,
    "--dir", opts.targetProjectPath,
    opts.prompt,
  ],
  interactionWhitelist: [
    ...INTERACTION_WHITELIST,
    "Action Required",
    "Run Command (y)",
    "Allow (y)",
  ],
};

const CLI_PROFILES: Record<string, CliProfile> = {
  opencode: OPENCODE_PROFILE,
  kilo: KILO_PROFILE,
};

function resolveCliProfile(profileName: string | null, binaryName: string): CliProfile {
  if (profileName && CLI_PROFILES[profileName]) {
    return CLI_PROFILES[profileName];
  }
  const lower = binaryName.toLowerCase();
  for (const profile of Object.values(CLI_PROFILES)) {
    if (lower === profile.defaultBinary || lower === profile.name) {
      return profile;
    }
  }
  return OPENCODE_PROFILE;
}

const DEFAULT_MAX_ITERATIONS = 20;
const DEFAULT_PHASE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_IDLE_TIMEOUT_MS = 90 * 1000;

const DEFAULT_SKILLS: Record<AgentRole, AgentSkills> = {
  planner: {
    role: "planner",
    allowedTools: ["read", "glob", "grep", "bash", "webfetch"],
    enforcedRules: [
      "Do NOT modify any source code files.",
      "Output a clear, actionable plan as a concise text summary.",
      "Identify the key files that need to be created or modified.",
      "Specify the approach and any libraries to use.",
    ],
    systemPrompt: "Analyze the goal and the target project. Produce a concise implementation plan that the implementer agent can follow step by step.",
  },
  implementer: {
    role: "implementer",
    allowedTools: ["read", "write", "edit", "glob", "grep", "bash"],
    enforcedRules: [
      "Do NOT run destructive git commands (git clean, git checkout --, git reset --hard).",
      "Apply cumulative fixes. Never delete previous work. Build on top of it.",
      "Only modify files within the target project path.",
      "If a failure digest is provided, address the specific failures described.",
    ],
    systemPrompt: "Implement the code changes described in the goal and plan. Write clean, production-ready code. If a failure digest is provided, fix the specific issues mentioned.",
  },
  tester: {
    role: "tester",
    allowedTools: ["read", "write", "edit", "glob", "grep", "bash"],
    enforcedRules: [
      "Review the implementation the implementer just produced (read the changed files).",
      "Design and perform appropriate tests based on that implementation content, not a fixed test command.",
      "You may write test files and run them with your bash tool to actually execute the tests.",
      "Cover happy paths, error paths, and boundary/edge cases.",
      "Do NOT modify production source code. Only create or update test files.",
      "End with a clear verdict line: 'VERDICT: PASS' or 'VERDICT: FAIL' followed by concise reasons.",
    ],
    systemPrompt: "You are the tester. First read what the implementer changed in the target project. Then design appropriate tests for that implementation, write them as test files, run them with your shell tools, and report the results. Your tests must be derived from the actual implementation, not from a preconfigured command. Conclude with 'VERDICT: PASS' or 'VERDICT: FAIL' and a short justification.",
  },
  qa_lead: {
    role: "qa_lead",
    allowedTools: ["read", "glob", "grep", "bash"],
    enforcedRules: [
      "Do NOT modify any files.",
      "You are given the tester's verdict and test output. Verify the tests are legitimate (no mocking-everything, no empty/skipped assertions, no cheating).",
      "Cross-check that the implementation actually satisfies the goal.",
      "Output APPROVED if verification passes, otherwise REJECTED with concrete reasons.",
    ],
    systemPrompt: "You are the QA lead. Review the tester's verdict and the implementation. Confirm the tests genuinely exercise the implementation and that the goal is met. Output APPROVED or REJECTED with clear reasoning.",
  },
  master: {
    role: "master",
    allowedTools: ["read", "glob", "grep", "bash"],
    enforcedRules: [
      "Do NOT modify any files.",
      "Perform final acceptance testing against the original goal.",
      "Output APPROVED if the goal is fully achieved, otherwise REJECTED with specific feedback.",
    ],
    systemPrompt: "You are the final gatekeeper. Perform acceptance testing on the implementation. Confirm the goal is fully achieved. Output APPROVED or REJECTED with detailed reasoning.",
  },
  interrupter: {
    role: "interrupter",
    allowedTools: ["read", "glob", "grep"],
    enforcedRules: [
      "Do NOT modify any files.",
      "Summarize the oscillation pattern and recommend a course correction.",
      "Be concise and actionable for the human operator.",
    ],
    systemPrompt: "The loop has paused due to detected oscillation (repeated failures). Analyze the error history and progress notes. Brief the human on what went wrong and recommend a specific course of action to break the cycle.",
  },
};

const ROOM_DIR_NAMES: Record<AgentRole, string> = {
  planner: "0_planner",
  implementer: "1_implementer",
  tester: "2_tester",
  qa_lead: "3_qa_lead",
  master: "4_master",
  interrupter: "5_interrupter",
};

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  await fse.ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}`;
  const jsonStr = JSON.stringify(data, null, 2);
  await fse.writeFile(tmpPath, jsonStr, "utf8");
  await renameWithRetry(tmpPath, filePath);
}

async function renameWithRetry(src: string, dest: string, maxRetries = 5): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await fse.rename(src, dest);
      return;
    } catch (err: unknown) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EBUSY" || code === "EACCES") {
        await sleep(50 * Math.pow(2, attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function atomicReadJson<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fse.readFile(filePath, "utf8");
    return JSON.parse(content) as T;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    const backupPath = `${filePath}.corrupt.${Date.now()}`;
    try {
      await fse.copy(filePath, backupPath);
      console.error(`[atomicReadJson] Corrupted JSON at ${filePath}. Backed up to ${backupPath}.`);
    } catch {
      console.error(`[atomicReadJson] Corrupted JSON at ${filePath} and backup failed.`);
    }
    return null;
  }
}

async function atomicAppendLine(filePath: string, line: string): Promise<void> {
  await fse.ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.append.${process.pid}.${Date.now()}`;
  let existing = "";
  try {
    existing = await fse.readFile(filePath, "utf8");
  } catch {
    existing = "";
  }
  const newline = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  const newContent = existing + newline + line + "\n";
  await fse.writeFile(tmpPath, newContent, "utf8");
  await renameWithRetry(tmpPath, filePath);
}

function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b[()][AB012]/g, "")
    .replace(/\x1b[=>]/g, "")
    .replace(/[\x00-\x08\x0e-\x1f\x7f]/g, "");
}

class LineBuffer {
  private buffer = "";

  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines: string[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, "");
      lines.push(line);
      this.buffer = this.buffer.slice(idx + 1);
    }
    return lines;
  }

  flush(): string | null {
    if (this.buffer.length > 0) {
      const remaining = this.buffer;
      this.buffer = "";
      return remaining;
    }
    return null;
  }
}

function killProcessTree(pid: number): Promise<void> {
  return new Promise<void>((resolve) => {
    if (process.platform === "win32") {
      exec(`taskkill /T /F /PID ${pid}`, () => resolve());
    } else {
      exec(`pkill -TERM -P ${pid} 2>/dev/null; kill -TERM ${pid} 2>/dev/null`, () => resolve());
    }
  });
}

function generateSessionId(): string {
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

function spawnCliPty(opts: SpawnCliOptions): SpawnHandle {
  const args = opts.cliProfile.buildRunArgs({
    model: opts.model,
    targetProjectPath: opts.targetProjectPath,
    prompt: opts.prompt,
  });

  const env: { [key: string]: string } = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env["AGENT_LOOP_SESSION_ID"] = opts.sessionId;
  env["AGENT_LOOP_AGENT_ROLE"] = opts.agentRole;
  env["AGENT_LOOP_PHASE"] = opts.phaseLabel;

  const resolvedBinary = resolveBinaryOnWindows(opts.cliBinary);

  const ptyProc = pty.spawn(resolvedBinary, args, {
    name: "xterm-256color",
    cols: 200,
    rows: 50,
    cwd: opts.targetProjectPath,
    env,
    useConpty: process.platform === "win32",
  });

  const pid = ptyProc.pid;

  const done = new Promise<PtyRunResult>((resolve) => {
    const lineBuffer = new LineBuffer();
    const events: AnyObj[] = [];
    const autoInjected: { prompt: string; response: string; timestamp: string }[] = [];
    let output = "";
    let resolved = false;
    let idleTimer: NodeJS.Timeout | null = null;
    let phaseTimer: NodeJS.Timeout | null = null;

    const finish = (result: Omit<PtyRunResult, "pid">) => {
      if (resolved) return;
      resolved = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (phaseTimer) clearTimeout(phaseTimer);
      try { ptyProc.kill(); } catch { /* already exited */ }
      resolve({ pid, ...result });
    };

    const triggerTimeout = (reason: string) => {
      killProcessTree(pid).then(() => {
        finish({ exitCode: -1, output, events, timedOut: true, autoInjected });
        console.error(`[spawnCliPty] ${reason} for session=${opts.sessionId} role=${opts.agentRole}`);
      });
    };

    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (!resolved) triggerTimeout(`Idle timeout (${opts.idleTimeoutMs}ms)`);
      }, opts.idleTimeoutMs);
    };

    if (opts.timeoutMs > 0) {
      phaseTimer = setTimeout(() => {
        if (!resolved) triggerTimeout(`Phase timeout (${opts.timeoutMs}ms)`);
      }, opts.timeoutMs);
    }

    resetIdle();

    ptyProc.onData((data) => {
      output += data;
      resetIdle();

      const stripped = stripAnsi(data);
      const lines = lineBuffer.push(stripped);

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;

        if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
          try {
            const evt = JSON.parse(trimmed) as AnyObj;
            events.push(evt);
          } catch {
            // Not a valid JSON line, skip
          }
        }

        const lower = trimmed.toLowerCase();
        const isDestructive = DESTRUCTIVE_PROMPTS.some((p) => lower.includes(p.toLowerCase()));
        const matchedWhitelist = opts.cliProfile.interactionWhitelist.find((p) => lower.includes(p.toLowerCase()));

        if (matchedWhitelist && !isDestructive) {
          const response = "y\n";
          ptyProc.write(response);
          autoInjected.push({ prompt: trimmed, response: "y", timestamp: new Date().toISOString() });
        }
      }
    });

    ptyProc.onExit((e) => {
      finish({ exitCode: e.exitCode, output, events, timedOut: false, autoInjected });
    });
  });

  return { pid, done };
}

function discoverCliModels(cliBinary: string, override: string[] | null, profile: CliProfile): Promise<string[]> {
  if (override && override.length > 0) {
    return Promise.resolve(override);
  }
  return new Promise<string[]>((resolve) => {
    execFile(
      cliBinary,
      profile.modelsArgs,
      { maxBuffer: 10 * 1024 * 1024, timeout: 30 * 1000, shell: process.platform === "win32" },
      (err, stdout, stderr) => {
      if (err) {
        console.warn(`[discoverCliModels] Failed to run '${cliBinary} ${profile.modelsArgs.join(" ")}': ${err.message}`);
        resolve([]);
        return;
      }
      const text = `${stdout}\n${stderr}`;
      const models: string[] = [];
      const regex = /([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)/g;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text)) !== null) {
        const model = `${match[1]}/${match[2]}`;
        if (!models.includes(model)) {
          models.push(model);
        }
      }
      resolve(models);
    });
  });
}

function normalizeSignature(raw: string): string {
  let s = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  s = s.replace(/[A-Za-z]:[\\/][^\s:|"'`]+/g, "<PATH>");
  s = s.replace(/(^|[\s:(])(\/[^\s:|"'`]+)/g, "$1<PATH>");
  s = s.replace(/:\d+:\d+/g, ":<LN>:<COL>");
  s = s.replace(/:\d+/g, ":<LN>");
  s = s.replace(/0x[0-9a-fA-F]+/g, "0x<HEX>");
  s = s.replace(/\b\d{10,}\b/g, "<TS>");

  const errorMatch = s.match(/(?:error|exception|fail(?:ed)?)[:]\s*([^\n]+)/i);
  if (errorMatch) {
    return errorMatch[1].trim().slice(0, 120).toLowerCase();
  }

  return s.trim().slice(0, 120).toLowerCase();
}

function pushAndCheckOscillation(
  queue: ErrorSignature[],
  entry: ErrorSignature
): { oscillation: boolean; queue: ErrorSignature[] } {
  const newQueue = [...queue, entry].slice(-5);

  let freqCount = 0;
  for (const e of newQueue) {
    if (e.signature === entry.signature) freqCount++;
  }
  if (freqCount >= 3) {
    return { oscillation: true, queue: newQueue };
  }

  const sigs = newQueue.map((e) => e.signature);
  if (sigs.length >= 4) {
    const half = Math.floor(sigs.length / 2);
    const recent = sigs.slice(-half);
    const older = sigs.slice(-half * 2, -half);
    if (recent.length === older.length && recent.every((v, i) => v === older[i])) {
      return { oscillation: true, queue: newQueue };
    }
  }

  return { oscillation: false, queue: newQueue };
}

function extractFailureDigest(testLog: string): string {
  const lines = testLog.split("\n").map((l) => stripAnsi(l)).filter((l) => l.trim().length > 0);
  const failures: string[] = [];
  const files = new Set<string>();

  for (const line of lines) {
    const failMatch = line.match(/(?:FAIL|failed|✕|AssertionError|Error:)\s*(.*)/i);
    if (failMatch) {
      const text = failMatch[1] ? failMatch[1].trim() : failMatch[0].trim();
      if (text.length > 0) failures.push(text.slice(0, 120));
    }
    const fileMatch = line.match(/([A-Za-z0-9_./\\-]+\.(ts|js|tsx|jsx|py|go|rs|java|cpp|c|h|cs|rb|php|swift|kt))/);
    if (fileMatch) {
      files.add(path.basename(fileMatch[1]));
    }
    if (failures.length >= 5 && files.size >= 5) break;
  }

  const parts: string[] = [];
  if (failures.length > 0) {
    parts.push("Failures:");
    for (const f of failures.slice(0, 5)) {
      parts.push(`  - ${f}`);
    }
  }
  if (files.size > 0) {
    parts.push("Affected files:");
    for (const f of Array.from(files).slice(0, 5)) {
      parts.push(`  - ${f}`);
    }
  }

  if (parts.length === 0) {
    const cleanLog = stripAnsi(testLog);
    const lastLines = cleanLog.split("\n").filter((l) => l.trim().length > 0).slice(-20);
    return lastLines.join("\n").slice(0, 800);
  }

  return parts.join("\n");
}

function extractOutput(result: PtyRunResult): string {
  const messages: string[] = [];
  for (const evt of result.events) {
    const contentKeys = ["content", "text", "message", "output"];
    for (const key of contentKeys) {
      const val = evt[key];
      if (typeof val === "string" && val.length > 0) {
        messages.push(val);
        break;
      }
    }
  }
  if (messages.length > 0) {
    return messages.join("\n");
  }

  const stripped = stripAnsi(result.output);
  const sentinelIdx = stripped.indexOf(SENTINEL);
  if (sentinelIdx >= 0) {
    return stripped.slice(0, sentinelIdx).trim();
  }

  return stripped.trim().slice(-2000);
}

function parseVerdict(output: string): boolean {
  const lower = output.toLowerCase();
  if (lower.trim().length === 0) return false;
  if (/\breject(ed)?\b/.test(lower)) return false;
  if (/\bfail(ed|ing)?\b/.test(lower) && !/\b0\s*fail/.test(lower)) return false;
  if (lower.includes("not approved")) return false;
  if (lower.includes("verdict: pass")) return true;
  if (lower.includes("verdict:pass")) return true;
  if (/\bapproved\b/.test(lower) && !/\bnot approved\b/.test(lower)) return true;
  if (lower.includes("all tests passed")) return true;
  if (lower.includes("tests passed")) return true;
  return false;
}

async function initGoalTree(
  rootDir: string,
  sessionId: string
): Promise<{ sessionDir: string; rooms: Record<AgentRole, AgentRoom> }> {
  const sessionsRoot = path.join(rootDir, ".goal", "sessions");
  const sessionDir = path.join(sessionsRoot, sessionId);

  const rooms: Partial<Record<AgentRole, AgentRoom>> = {};

  for (const role of Object.keys(ROOM_DIR_NAMES) as AgentRole[]) {
    const roomDir = path.join(sessionDir, ROOM_DIR_NAMES[role]);
    await fse.ensureDir(roomDir);
    rooms[role] = {
      role,
      statePath: path.join(roomDir, "state.json"),
      skillsPath: path.join(roomDir, "skills.json"),
      inputPayloadPath: path.join(roomDir, "input.json"),
      outputPayloadPath: path.join(roomDir, "output.json"),
    };
    await atomicWriteJson(rooms[role]!.skillsPath, DEFAULT_SKILLS[role]);
    await atomicWriteJson(rooms[role]!.statePath, { status: "idle", lastExitCode: null, lastRunAt: null });
    await atomicWriteJson(rooms[role]!.inputPayloadPath, {});
    await atomicWriteJson(rooms[role]!.outputPayloadPath, {});
  }

  await fse.ensureDir(path.join(sessionDir, "loop_history"));

  const notesPath = path.join(sessionDir, "progress_notes.txt");
  if (!await fse.pathExists(notesPath)) {
    await fse.writeFile(notesPath, "", "utf8");
  }

  return { sessionDir, rooms: rooms as Record<AgentRole, AgentRoom> };
}

function buildPrompt(role: AgentRole, payload: HandoffPayload): string {
  const skills = DEFAULT_SKILLS[role];
  const lines: string[] = [];
  lines.push(`You are the ${role.toUpperCase()} agent in an autonomous coding loop.`);
  lines.push(`Session ID: ${payload.sessionId}`);
  lines.push(`Phase: ${payload.phase}`);
  lines.push(`Loop iteration: ${payload.loopCount}`);
  lines.push("");
  lines.push("=== GOAL ===");
  lines.push(payload.refinedGoal);
  lines.push("");
  lines.push("=== TARGET PROJECT PATH ===");
  lines.push(payload.targetProjectPath);
  lines.push("");
  lines.push("=== PROGRESS NOTES (cumulative) ===");
  lines.push(payload.progressNotes.length > 0 ? payload.progressNotes : "(none yet)");
  lines.push("");
  if (payload.failureDigest && payload.failureDigest.length > 0) {
    lines.push("=== LAST FAILURE DIGEST (address these specifically) ===");
    lines.push(payload.failureDigest);
    lines.push("");
  }
  lines.push("=== ENFORCED RULES (do NOT violate) ===");
  for (const rule of skills.enforcedRules) {
    lines.push(`- ${rule}`);
  }
  lines.push("");
  lines.push("=== YOUR INSTRUCTIONS ===");
  lines.push(skills.systemPrompt);
  lines.push("");
  lines.push(`When you have completed your task, output the token ${SENTINEL} on a line by itself, then stop.`);
  return lines.join("\n");
}

function parseArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const eqIdx = key.indexOf("=");
      if (eqIdx >= 0) {
        result[key.slice(0, eqIdx)] = key.slice(eqIdx + 1);
        continue;
      }
      if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        result[key] = args[++i];
      } else {
        result[key] = "true";
      }
    }
  }
  return result;
}

function parseIntSafe(value: string | undefined, defaultValue: number): number {
  if (value === undefined || value === "true" || value.length === 0) return defaultValue;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return defaultValue;
  return n;
}

function printUsage(): void {
  console.log(`
Custom Agent Loop System - Dynamic Multi-Model Multi-Session Orchestrator

Usage:
  agent-loop init                                    Initialize the system in the current directory
  agent-loop models [--binary opencode] [--profile]  List available CLI models
  agent-loop run --goal "..." --target "..." [opts]  Start a new session
  agent-loop resume --session <id> [opts]            Resume a paused session

Options for 'run':
  --goal <text>              The goal to achieve (required)
  --target <path>            Target project path (default: cwd)
  --binary <name>            CLI binary name (default: opencode)
  --profile <name>           CLI profile: opencode | kilo (auto-detected from --binary)
  --max-iterations <n>       Max loop iterations (default: 20)
  --phase-timeout <ms>       Phase timeout in ms (default: 600000)
  --idle-timeout <ms>        Idle timeout in ms (default: 90000)
  --planner-model <m>        Model for planner agent
  --implementer-model <m>    Model for implementer agent
  --tester-model <m>         Model for tester agent
  --qa-model <m>             Model for qa_lead agent
  --master-model <m>         Model for master agent
  --interrupter-model <m>    Model for interrupter agent
  --root <path>              Orchestrator root dir (default: this file's dir)

Options for 'resume':
  --session <id>             Session ID to resume (required)
  --root <path>              Orchestrator root dir
`);
}

class LoopOrchestrator {
  private registry: SessionRegistry;
  private state: LoopState;
  private rooms: Record<AgentRole, AgentRoom>;
  private readonly rootDir: string;
  private readonly registryPath: string;
  private readonly sessionDir: string;
  private activePtyPid: number | null = null;
  private disposed = false;
  private signalHandlersRegistered = false;

  constructor(
    rootDir: string,
    registry: SessionRegistry,
    state: LoopState,
    rooms: Record<AgentRole, AgentRoom>
  ) {
    this.rootDir = rootDir;
    this.registry = registry;
    this.state = state;
    this.rooms = rooms;
    this.registryPath = path.join(rootDir, "sessions_registry.json");
    this.sessionDir = path.join(rootDir, ".goal", "sessions", state.sessionId);
  }

  async run(): Promise<void> {
    this.registerSignalHandlers();

    while (!this.disposed && this.state.status === LoopStatus.RUNNING) {
      if (this.state.loopCount >= this.state.maxIterations) {
        this.state.status = LoopStatus.FAILED;
        await this.saveState();
        await this.saveRegistry();
        console.error(`[orchestrator] Max iterations (${this.state.maxIterations}) reached. Session FAILED.`);
        return;
      }

      try {
        switch (this.state.phase) {
          case Phase.PLANNING:
            await this.runPlanning();
            break;
          case Phase.IMPLEMENTATION:
            await this.runImplementation(this.state.lastFailureDigest);
            this.state.lastFailureDigest = null;
            break;
          case Phase.TEST_GENERATION:
            await this.runTestGeneration();
            break;
          case Phase.VERIFICATION:
            await this.runVerification();
            break;
          case Phase.MASTER_APPROVAL:
            await this.runMasterApproval();
            break;
          case Phase.INTERRUPT:
            await this.runInterrupter();
            break;
          default:
            this.state.status = LoopStatus.FAILED;
            await this.saveState();
            await this.saveRegistry();
            return;
        }
        await this.saveState();
        await this.saveRegistry();
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[orchestrator] Error in phase ${this.state.phase}: ${errMsg}`);

        const entry: ErrorSignature = {
          signature: normalizeSignature(errMsg),
          rawMessage: errMsg,
          timestamp: Date.now(),
          phase: this.state.phase,
        };
        const oscResult = pushAndCheckOscillation(this.state.errorQueue, entry);
        this.state.errorQueue = oscResult.queue;

        if (oscResult.oscillation) {
          console.warn(`[orchestrator] Oscillation detected. Entering INTERRUPT phase.`);
          this.state.phase = Phase.INTERRUPT;
          await this.saveState();
          await this.saveRegistry();
        } else {
          if (this.state.phase !== Phase.PLANNING) {
            this.state.phase = Phase.IMPLEMENTATION;
          }
          await this.saveState();
          await this.saveRegistry();
        }
      }
    }
  }

  private async runPlanning(): Promise<void> {
    if (this.state.planningComplete) {
      this.state.phase = Phase.IMPLEMENTATION;
      return;
    }

    const payload: HandoffPayload = {
      sessionId: this.state.sessionId,
      refinedGoal: this.state.goal,
      targetProjectPath: this.state.targetProjectPath,
      progressNotes: "",
      failureDigest: null,
      phase: Phase.PLANNING,
      loopCount: 0,
    };

    const prompt = buildPrompt("planner", payload);
    const result = await this.executeAgent("planner", prompt);

    if (result.exitCode !== 0) {
      throw new Error(`Planner exited with code ${result.exitCode}`);
    }

    const output = extractOutput(result);
    this.state.refinedGoal = output.length > 0 ? output : this.state.goal;
    this.state.planningComplete = true;
    this.state.phase = Phase.IMPLEMENTATION;

    await this.appendProgressNote(`[Loop 0] PLANNING: Goal refined.`);
    await this.archiveLoop(0, Phase.PLANNING, "planner", result, new Date(), new Date());
  }

  private async runImplementation(failureDigest: string | null): Promise<void> {
    this.state.loopCount++;
    await this.saveState();

    const notes = await this.readProgressNotes();
    const payload: HandoffPayload = {
      sessionId: this.state.sessionId,
      refinedGoal: this.state.refinedGoal || this.state.goal,
      targetProjectPath: this.state.targetProjectPath,
      progressNotes: notes,
      failureDigest,
      phase: Phase.IMPLEMENTATION,
      loopCount: this.state.loopCount,
    };

    const prompt = buildPrompt("implementer", payload);
    const startedAt = new Date();
    const result = await this.executeAgent("implementer", prompt);
    const endedAt = new Date();

    await this.archiveLoop(this.state.loopCount, Phase.IMPLEMENTATION, "implementer", result, startedAt, endedAt);

    if (result.exitCode !== 0) {
      throw new Error(`Implementer exited with code ${result.exitCode}: ${extractOutput(result).slice(0, 200)}`);
    }

    await this.appendProgressNote(`[Loop ${this.state.loopCount}] IMPLEMENTATION: Code changes applied.`);
    this.state.phase = Phase.TEST_GENERATION;
  }

  private async runTestGeneration(): Promise<void> {
    const notes = await this.readProgressNotes();
    const payload: HandoffPayload = {
      sessionId: this.state.sessionId,
      refinedGoal: this.state.refinedGoal || this.state.goal,
      targetProjectPath: this.state.targetProjectPath,
      progressNotes: notes,
      failureDigest: null,
      phase: Phase.TEST_GENERATION,
      loopCount: this.state.loopCount,
    };

    const prompt = buildPrompt("tester", payload);
    const startedAt = new Date();
    const result = await this.executeAgent("tester", prompt);
    const endedAt = new Date();

    await this.archiveLoop(this.state.loopCount, Phase.TEST_GENERATION, "tester", result, startedAt, endedAt);

    if (result.exitCode !== 0) {
      throw new Error(`Tester exited with code ${result.exitCode}: ${extractOutput(result).slice(0, 200)}`);
    }

    const testerOutput = extractOutput(result);
    await atomicWriteJson(this.rooms.tester.outputPayloadPath, {
      loopCount: this.state.loopCount,
      producedAt: endedAt.toISOString(),
      output: testerOutput,
      verdict: parseVerdict(testerOutput) ? "PASS" : "FAIL",
    });

    await this.appendProgressNote(`[Loop ${this.state.loopCount}] TEST_GENERATION: Tester performed tests. Verdict: ${parseVerdict(testerOutput) ? "PASS" : "FAIL"}.`);
    this.state.phase = Phase.VERIFICATION;
  }

  private async runVerification(): Promise<void> {
    const testerBundle = await atomicReadJson<{ output?: string; verdict?: string; loopCount?: number }>(
      this.rooms.tester.outputPayloadPath
    );
    const testerOutput = testerBundle?.output ?? "";
    const testerVerdict = testerBundle?.verdict ?? (parseVerdict(testerOutput) ? "PASS" : "FAIL");

    const notes = await this.readProgressNotes();
    const payload: HandoffPayload = {
      sessionId: this.state.sessionId,
      refinedGoal: this.state.refinedGoal || this.state.goal,
      targetProjectPath: this.state.targetProjectPath,
      progressNotes: notes,
      failureDigest: null,
      phase: Phase.VERIFICATION,
      loopCount: this.state.loopCount,
    };

    const qaPrompt =
      buildPrompt("qa_lead", payload) +
      `\n\n=== TESTER VERDICT ===\n${testerVerdict}\n\n=== TESTER OUTPUT (truncated) ===\n` +
      stripAnsi(testerOutput).slice(0, 3000);

    const startedAt = new Date();
    const result = await this.executeAgent("qa_lead", qaPrompt);
    const endedAt = new Date();

    await this.archiveLoop(this.state.loopCount, Phase.VERIFICATION, "qa_lead", result, startedAt, endedAt);

    const qaOutput = extractOutput(result);
    if (result.exitCode === 0) {
      const isApproved = /\bapproved\b/i.test(qaOutput) && !/\breject/i.test(qaOutput);
      if (isApproved) {
        await this.appendProgressNote(`[Loop ${this.state.loopCount}] VERIFICATION: PASSED. QA approved.`);
        this.state.phase = Phase.MASTER_APPROVAL;
        return;
      }
    }

    const failureDigest = extractFailureDigest(`${qaOutput}\n${testerOutput}`);
    const entry: ErrorSignature = {
      signature: normalizeSignature(failureDigest),
      rawMessage: failureDigest,
      timestamp: Date.now(),
      phase: Phase.VERIFICATION,
    };
    const oscResult = pushAndCheckOscillation(this.state.errorQueue, entry);
    this.state.errorQueue = oscResult.queue;

    if (oscResult.oscillation) {
      await this.appendProgressNote(`[Loop ${this.state.loopCount}] VERIFICATION: FAILED. Oscillation detected. Entering INTERRUPT.`);
      this.state.phase = Phase.INTERRUPT;
      return;
    }

    await this.appendProgressNote(`[Loop ${this.state.loopCount}] VERIFICATION: FAILED. Regressing to IMPLEMENTATION with failure digest.`);
    this.state.lastFailureDigest = failureDigest;
    this.state.phase = Phase.IMPLEMENTATION;
  }

  private async runMasterApproval(): Promise<void> {
    const notes = await this.readProgressNotes();
    const payload: HandoffPayload = {
      sessionId: this.state.sessionId,
      refinedGoal: this.state.refinedGoal || this.state.goal,
      targetProjectPath: this.state.targetProjectPath,
      progressNotes: notes,
      failureDigest: null,
      phase: Phase.MASTER_APPROVAL,
      loopCount: this.state.loopCount,
    };

    const prompt = buildPrompt("master", payload);
    const startedAt = new Date();
    const result = await this.executeAgent("master", prompt);
    const endedAt = new Date();

    await this.archiveLoop(this.state.loopCount, Phase.MASTER_APPROVAL, "master", result, startedAt, endedAt);

    const output = extractOutput(result).toLowerCase();
    const approved = result.exitCode === 0 && /\bapproved\b/.test(output) && !/\breject/.test(output);

    if (approved) {
      this.state.masterApproved = true;
      this.state.status = LoopStatus.SUCCESS;
      await this.emitFinalSummary();
      await this.appendProgressNote(`[Loop ${this.state.loopCount}] MASTER_APPROVAL: APPROVED. Session SUCCESS.`);
      await this.saveRegistry();
      console.log(`[orchestrator] Session ${this.state.sessionId} achieved SUCCESS.`);
    } else {
      await this.appendProgressNote(`[Loop ${this.state.loopCount}] MASTER_APPROVAL: REJECTED. Regressing to IMPLEMENTATION.`);
      const rejectEntry: ErrorSignature = {
        signature: normalizeSignature(`master_reject:${output.slice(0, 80)}`),
        rawMessage: output.slice(0, 200),
        timestamp: Date.now(),
        phase: Phase.MASTER_APPROVAL,
      };
      const rejectOsc = pushAndCheckOscillation(this.state.errorQueue, rejectEntry);
      this.state.errorQueue = rejectOsc.queue;
      if (rejectOsc.oscillation) {
        this.state.phase = Phase.INTERRUPT;
      } else {
        this.state.phase = Phase.IMPLEMENTATION;
      }
    }
  }

  private async runInterrupter(): Promise<void> {
    const notes = await this.readProgressNotes();
    const errorSummary = this.state.errorQueue
      .map((e) => `[${e.phase}] ${e.signature}`)
      .join("\n");

    const payload: HandoffPayload = {
      sessionId: this.state.sessionId,
      refinedGoal: this.state.refinedGoal || this.state.goal,
      targetProjectPath: this.state.targetProjectPath,
      progressNotes: notes,
      failureDigest: errorSummary,
      phase: Phase.INTERRUPT,
      loopCount: this.state.loopCount,
    };

    const prompt = buildPrompt("interrupter", payload);
    const startedAt = new Date();
    const result = await this.executeAgent("interrupter", prompt);
    const endedAt = new Date();

    await this.archiveLoop(this.state.loopCount, Phase.INTERRUPT, "interrupter", result, startedAt, endedAt);

    const briefing = extractOutput(result);
    console.warn("\n=== INTERRUPTER BRIEFING ===");
    console.warn(briefing);
    console.warn("============================");
    console.warn(`Session ${this.state.sessionId} is PAUSED. Review the briefing and resume with:`);
    console.warn(`  agent-loop resume --session ${this.state.sessionId} --root ${this.rootDir}`);

    this.state.status = LoopStatus.PAUSED;
  }

  private async executeAgent(role: AgentRole, prompt: string): Promise<PtyRunResult> {
    const model = this.state.modelMapping[role];
    this.state.agentStates[role] = {
      status: "running",
      lastExitCode: null,
      lastRunAt: new Date().toISOString(),
    };
    await this.saveState();

    console.log(`\n[${this.state.sessionId}] Phase=${this.state.phase} Role=${role} Model=${model} Loop=${this.state.loopCount}`);
    console.log(`[${this.state.sessionId}] Prompt length: ${prompt.length} chars`);

    const handle = spawnCliPty({
      model,
      agentRole: role,
      sessionId: this.state.sessionId,
      targetProjectPath: this.state.targetProjectPath,
      prompt,
      timeoutMs: this.state.phaseTimeoutMs,
      idleTimeoutMs: this.state.idleTimeoutMs,
      cliBinary: this.state.cliBinary,
      cliProfile: resolveCliProfile(this.state.cliProfile, this.state.cliBinary),
      phaseLabel: this.state.phase,
    });

    this.activePtyPid = handle.pid;

    const result = await handle.done;

    this.activePtyPid = null;
    this.state.agentStates[role] = {
      status: result.exitCode === 0 ? "completed" : "failed",
      lastExitCode: result.exitCode,
      lastRunAt: new Date().toISOString(),
    };

    if (result.autoInjected.length > 0) {
      console.warn(`[audit] Auto-injected ${result.autoInjected.length} interaction(s) for ${role}:`);
      for (const a of result.autoInjected) {
        console.warn(`  prompt="${a.prompt}" response="${a.response}" at=${a.timestamp}`);
      }
    }

    if (result.timedOut) {
      console.warn(`[orchestrator] Agent ${role} timed out (pid=${result.pid}).`);
    } else {
      console.log(`[orchestrator] Agent ${role} finished with exitCode=${result.exitCode} (pid=${result.pid}).`);
    }

    return result;
  }

  private async archiveLoop(
    loopNum: number,
    phase: Phase,
    role: AgentRole,
    result: PtyRunResult,
    startedAt: Date,
    endedAt: Date
  ): Promise<void> {
    const entry: LoopHistoryEntry = {
      loopNumber: loopNum,
      phase,
      agentRole: role,
      model: this.state.modelMapping[role],
      exitCode: result.exitCode,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      output: result.output,
      result: result.timedOut ? "timeout" : result.exitCode === 0 ? "success" : "failure",
      signature: null,
    };
    const fileName = `loop_${loopNum}_${phase.toLowerCase()}_${role}.json`;
    const filePath = path.join(this.sessionDir, "loop_history", fileName);
    await atomicWriteJson(filePath, entry);
  }

  private async appendProgressNote(note: string): Promise<void> {
    const notesPath = path.join(this.sessionDir, "progress_notes.txt");
    await atomicAppendLine(notesPath, note);
  }

  private async readProgressNotes(): Promise<string> {
    const notesPath = path.join(this.sessionDir, "progress_notes.txt");
    try {
      return await fse.readFile(notesPath, "utf8");
    } catch {
      return "";
    }
  }

  private async emitFinalSummary(): Promise<void> {
    const notes = await this.readProgressNotes();
    const summary: FinalSummary = {
      sessionId: this.state.sessionId,
      goal: this.state.goal,
      achievedAt: new Date().toISOString(),
      totalLoops: this.state.loopCount,
      finalModelMapping: this.state.modelMapping,
      progressNotes: notes,
      approvedByMaster: this.state.masterApproved,
    };
    const summaryPath = path.join(this.sessionDir, "final_summary.json");
    await atomicWriteJson(summaryPath, summary);
  }

  private async saveState(): Promise<void> {
    this.state.updatedAt = new Date().toISOString();
    const statePath = path.join(this.sessionDir, "loop_state.json");
    await atomicWriteJson(statePath, this.state);

    const roomStatePath = this.rooms[this.currentRole()]?.statePath;
    if (roomStatePath) {
      await atomicWriteJson(roomStatePath, this.state.agentStates[this.currentRole()]);
    }
  }

  private currentRole(): AgentRole {
    switch (this.state.phase) {
      case Phase.PLANNING: return "planner";
      case Phase.IMPLEMENTATION: return "implementer";
      case Phase.TEST_GENERATION: return "tester";
      case Phase.VERIFICATION: return "qa_lead";
      case Phase.MASTER_APPROVAL: return "master";
      case Phase.INTERRUPT: return "interrupter";
      default: return "planner";
    }
  }

  private async saveRegistry(): Promise<void> {
    const existing = this.registry.sessionMetas.find((m) => m.sessionId === this.state.sessionId);
    if (existing) {
      existing.status = this.state.status;
      existing.goal = this.state.goal;
      existing.targetProjectPath = this.state.targetProjectPath;
    } else {
      this.registry.sessionMetas.push({
        sessionId: this.state.sessionId,
        goal: this.state.goal,
        targetProjectPath: this.state.targetProjectPath,
        status: this.state.status,
        createdAt: this.state.createdAt,
      });
      if (!this.registry.activeSessionIds.includes(this.state.sessionId)) {
        this.registry.activeSessionIds.push(this.state.sessionId);
      }
    }
    await atomicWriteJson(this.registryPath, this.registry);
  }

  private registerSignalHandlers(): void {
    if (this.signalHandlersRegistered) return;
    this.signalHandlersRegistered = true;

    const handler = () => {
      this.dispose().catch((err) => {
        console.error(`[orchestrator] Error during disposal: ${err.message}`);
        process.exit(1);
      });
    };

    process.on("SIGINT", handler);
    process.on("SIGTERM", handler);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    if (this.activePtyPid !== null) {
      console.log(`[orchestrator] Killing active PTY pid=${this.activePtyPid}`);
      await killProcessTree(this.activePtyPid);
      this.activePtyPid = null;
    }

    if (this.state.status === LoopStatus.RUNNING) {
      this.state.status = LoopStatus.PAUSED;
    }
    await this.saveState();
    await this.saveRegistry();
    console.log(`[orchestrator] Session ${this.state.sessionId} disposed. Status: ${this.state.status}.`);
  }
}

function createDefaultLoopState(
  sessionId: string,
  goal: string,
  targetProjectPath: string,
  modelMapping: ModelMapping,
  cliBinary: string,
  cliProfile: string,
  maxIterations: number,
  phaseTimeoutMs: number,
  idleTimeoutMs: number
): LoopState {
  const now = new Date().toISOString();
  const agentStates: Record<AgentRole, AgentState> = {
    planner: { status: "idle", lastExitCode: null, lastRunAt: null },
    implementer: { status: "idle", lastExitCode: null, lastRunAt: null },
    tester: { status: "idle", lastExitCode: null, lastRunAt: null },
    qa_lead: { status: "idle", lastExitCode: null, lastRunAt: null },
    master: { status: "idle", lastExitCode: null, lastRunAt: null },
    interrupter: { status: "idle", lastExitCode: null, lastRunAt: null },
  };

  return {
    sessionId,
    status: LoopStatus.RUNNING,
    phase: Phase.PLANNING,
    loopCount: 0,
    goal,
    targetProjectPath: path.resolve(targetProjectPath),
    modelMapping,
    errorQueue: [],
    agentStates,
    refinedGoal: null,
    planningComplete: false,
    masterApproved: false,
    lastFailureDigest: null,
    createdAt: now,
    updatedAt: now,
    maxIterations,
    phaseTimeoutMs,
    idleTimeoutMs,
    cliBinary,
    cliProfile,
  };
}

function resolveModelMapping(
  parsed: Record<string, string>,
  availableModels: string[],
  fallback: string
): ModelMapping {
  const pick = (key: string): string => {
    const explicit = parsed[key];
    if (explicit && explicit.length > 0) return explicit;
    if (availableModels.length > 0) return availableModels[0];
    return fallback;
  };

  return {
    planner: pick("planner-model"),
    implementer: pick("implementer-model"),
    tester: pick("tester-model"),
    qa_lead: pick("qa-model"),
    master: pick("master-model"),
    interrupter: pick("interrupter-model"),
  };
}

async function resolveRootDir(parsed: Record<string, string>): Promise<string> {
  if (parsed.root) return path.resolve(parsed.root);
  const scriptDir = path.dirname(process.argv[1]);
  if (await fse.pathExists(path.join(scriptDir, "sessions_registry.json"))) {
    return scriptDir;
  }
  return process.cwd();
}

async function cmdInit(rootDir: string): Promise<void> {
  await fse.ensureDir(path.join(rootDir, ".goal", "sessions"));
  const registryPath = path.join(rootDir, "sessions_registry.json");
  const existing = await atomicReadJson<SessionRegistry>(registryPath);
  if (existing) {
    console.log(`Already initialized at ${rootDir}`);
    return;
  }
  const registry: SessionRegistry = {
    version: 1,
    activeSessionIds: [],
    availableModels: [],
    modelsDiscoveredAt: null,
    sessionMetas: [],
    manualModelsOverride: null,
  };
  await atomicWriteJson(registryPath, registry);
  console.log(`Initialized agent-loop system at ${rootDir}`);
  console.log(`Registry: ${registryPath}`);
  console.log(`Sessions dir: ${path.join(rootDir, ".goal", "sessions")}`);
}

async function cmdModels(parsed: Record<string, string>, rootDir: string): Promise<void> {
  const cliBinary = parsed.binary || "opencode";
  const profile = resolveCliProfile(parsed.profile ?? null, cliBinary);
  const registryPath = path.join(rootDir, "sessions_registry.json");
  const registry = await atomicReadJson<SessionRegistry>(registryPath);
  const override = registry?.manualModelsOverride ?? null;
  const models = await discoverCliModels(cliBinary, override, profile);

  if (registry) {
    registry.availableModels = models;
    registry.modelsDiscoveredAt = new Date().toISOString();
    await atomicWriteJson(registryPath, registry);
  }

  if (models.length === 0) {
    console.log(`No models discovered from '${cliBinary} ${profile.modelsArgs.join(" ")}'.`);
    console.log(`Check that '${cliBinary}' is installed and authenticated (profile: ${profile.name}).`);
  } else {
    console.log(`Available models (${models.length}):`);
    for (const m of models) {
      console.log(`  ${m}`);
    }
  }
}

async function cmdRun(parsed: Record<string, string>, rootDir: string): Promise<void> {
  const goal = parsed.goal;
  if (!goal || goal === "true") {
    console.error("Error: --goal is required for 'run'");
    printUsage();
    process.exit(1);
  }

  const targetProjectPath = parsed.target && parsed.target !== "true" ? parsed.target : process.cwd();
  const cliBinary = parsed.binary && parsed.binary !== "true" ? parsed.binary : "opencode";
  const profile = resolveCliProfile(parsed.profile ?? null, cliBinary);
  const maxIterations = parseIntSafe(parsed["max-iterations"], DEFAULT_MAX_ITERATIONS);
  const phaseTimeoutMs = parseIntSafe(parsed["phase-timeout"], DEFAULT_PHASE_TIMEOUT_MS);
  const idleTimeoutMs = parseIntSafe(parsed["idle-timeout"], DEFAULT_IDLE_TIMEOUT_MS);

  const registryPath = path.join(rootDir, "sessions_registry.json");
  let registry = await atomicReadJson<SessionRegistry>(registryPath);
  if (!registry) {
    await cmdInit(rootDir);
    registry = await atomicReadJson<SessionRegistry>(registryPath);
  }
  if (!registry) {
    console.error("Error: Failed to initialize or read session registry.");
    process.exit(1);
  }
  const reg: SessionRegistry = registry;

  console.log(`[orchestrator] CLI profile: ${profile.name} | binary: ${cliBinary}`);
  console.log(`[orchestrator] Discovering available models from '${cliBinary}'...`);
  const models = await discoverCliModels(cliBinary, reg.manualModelsOverride, profile);
  reg.availableModels = models;
  reg.modelsDiscoveredAt = new Date().toISOString();
  await atomicWriteJson(registryPath, reg);

  if (models.length === 0) {
    console.warn(`[orchestrator] No models discovered. Using fallback model names. Specify models explicitly with --planner-model etc.`);
  } else {
    console.log(`[orchestrator] Discovered ${models.length} models.`);
  }

  const fallbackModel = models.length > 0 ? models[0] : "anthropic/claude-sonnet-4-5";
  const modelMapping = resolveModelMapping(parsed, models, fallbackModel);

  console.log(`[orchestrator] Model mapping:`);
  for (const [role, model] of Object.entries(modelMapping)) {
    console.log(`  ${role}: ${model}`);
  }

  const sessionId = generateSessionId();
  console.log(`[orchestrator] New session: ${sessionId}`);

  const { sessionDir, rooms } = await initGoalTree(rootDir, sessionId);

  const state = createDefaultLoopState(
    sessionId,
    goal,
    targetProjectPath,
    modelMapping,
    cliBinary,
    profile.name,
    maxIterations,
    phaseTimeoutMs,
    idleTimeoutMs
  );

  const statePath = path.join(sessionDir, "loop_state.json");
  await atomicWriteJson(statePath, state);

  const orchestrator = new LoopOrchestrator(rootDir, reg, state, rooms);
  await orchestrator.run();

  const finalState = await atomicReadJson<LoopState>(statePath);
  if (finalState) {
    console.log(`\n[orchestrator] Session ${sessionId} ended with status: ${finalState.status}`);
    if (finalState.status === LoopStatus.SUCCESS) {
      const summaryPath = path.join(sessionDir, "final_summary.json");
      console.log(`[orchestrator] Final summary: ${summaryPath}`);
    } else if (finalState.status === LoopStatus.PAUSED) {
      console.log(`[orchestrator] Session paused. Resume with: agent-loop resume --session ${sessionId} --root ${rootDir}`);
    }
  }
}

async function cmdResume(parsed: Record<string, string>, rootDir: string): Promise<void> {
  const sessionId = parsed.session;
  if (!sessionId || sessionId === "true") {
    console.error("Error: --session is required for 'resume'");
    printUsage();
    process.exit(1);
  }

  const registryPath = path.join(rootDir, "sessions_registry.json");
  const registry = await atomicReadJson<SessionRegistry>(registryPath);
  if (!registry) {
    console.error(`Error: No registry found at ${registryPath}. Run 'agent-loop init' first.`);
    process.exit(1);
  }

  const sessionDir = path.join(rootDir, ".goal", "sessions", sessionId);
  const statePath = path.join(sessionDir, "loop_state.json");
  const state = await atomicReadJson<LoopState>(statePath);
  if (!state) {
    console.error(`Error: No session found with ID ${sessionId}`);
    process.exit(1);
  }

  if (state.status === LoopStatus.SUCCESS) {
    console.log(`Session ${sessionId} is already SUCCESS. Nothing to resume.`);
    return;
  }
  if (state.status === LoopStatus.FAILED) {
    console.log(`Session ${sessionId} is FAILED. Cannot resume.`);
    return;
  }

  if (parsed["max-iterations"]) state.maxIterations = parseIntSafe(parsed["max-iterations"], state.maxIterations);
  if (parsed["phase-timeout"]) state.phaseTimeoutMs = parseIntSafe(parsed["phase-timeout"], state.phaseTimeoutMs);
  if (parsed["idle-timeout"]) state.idleTimeoutMs = parseIntSafe(parsed["idle-timeout"], state.idleTimeoutMs);
  if (parsed.binary && parsed.binary !== "true") state.cliBinary = parsed.binary;
  if (parsed.profile && parsed.profile !== "true") state.cliProfile = parsed.profile;
  if (!state.cliProfile) state.cliProfile = resolveCliProfile(null, state.cliBinary).name;

  if (state.status === LoopStatus.PAUSED) {
    state.status = LoopStatus.RUNNING;
    if (state.phase === Phase.INTERRUPT) {
      state.phase = Phase.IMPLEMENTATION;
    }
  }

  const rooms: Partial<Record<AgentRole, AgentRoom>> = {};
  for (const role of Object.keys(ROOM_DIR_NAMES) as AgentRole[]) {
    const roomDir = path.join(sessionDir, ROOM_DIR_NAMES[role]);
    rooms[role] = {
      role,
      statePath: path.join(roomDir, "state.json"),
      skillsPath: path.join(roomDir, "skills.json"),
      inputPayloadPath: path.join(roomDir, "input.json"),
      outputPayloadPath: path.join(roomDir, "output.json"),
    };
  }

  await atomicWriteJson(statePath, state);

  const orchestrator = new LoopOrchestrator(rootDir, registry, state, rooms as Record<AgentRole, AgentRoom>);
  await orchestrator.run();

  const finalState = await atomicReadJson<LoopState>(statePath);
  if (finalState) {
    console.log(`\n[orchestrator] Session ${sessionId} ended with status: ${finalState.status}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    printUsage();
    process.exit(1);
  }

  const command = args[0];

  if (command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  const parsed = parseArgs(args.slice(1));
  const rootDir = await resolveRootDir(parsed);

  switch (command) {
    case "init":
      await cmdInit(rootDir);
      break;
    case "models":
      await cmdModels(parsed, rootDir);
      break;
    case "run":
      await cmdRun(parsed, rootDir);
      break;
    case "resume":
      await cmdResume(parsed, rootDir);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
  process.exit(0);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[fatal] ${msg}`);
  process.exit(1);
});
