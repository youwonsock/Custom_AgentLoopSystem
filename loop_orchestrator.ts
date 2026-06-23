#!/usr/bin/env node

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execFile, exec } from "node:child_process";
import * as fse from "fs-extra";
import * as pty from "node-pty";

function resolveCmdToExe(cmdPath: string): string {
  try {
    const content = fs.readFileSync(cmdPath, "utf8");
    const cmdDir = path.dirname(cmdPath);
    const exeMatch = content.match(/"%dp0%\\([^"]+\.exe)"/i);
    if (exeMatch) {
      const resolved = path.join(cmdDir, exeMatch[1]);
      if (fs.existsSync(resolved)) return resolved;
    }
  } catch {
    // ignore read errors
  }
  return cmdPath;
}

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
        if (fs.existsSync(candidate)) {
          const extLower = ext.toLowerCase();
          if (extLower === ".cmd" || extLower === ".bat") {
            const resolved = resolveCmdToExe(candidate);
            if (resolved !== candidate) return resolved;
          }
          return candidate;
        }
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

type VariantMapping = Partial<Record<AgentRole, string>>;

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
  awaitingPlanApproval: boolean;
  planApproved: boolean;
  planPath: string | null;
  createdAt: string;
  updatedAt: string;
  maxIterations: number;
  phaseTimeoutMs: number;
  idleTimeoutMs: number;
  cliBinary: string;
  cliProfile: string;
  variantMapping: VariantMapping;
  lastFailureDigest: string | null;
  interruptMessage?: string;
  interruptBriefing?: string | null;
}

interface PlanChoice {
  id: number;
  title: string;
  body: string;
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
  modelsDiscoveredCli: string | null;
  sessionMetas: SessionMeta[];
  manualModelsOverride: string[] | null;
  modelVariants: Record<string, string[]> | null;
}

interface LoopPathsConfig {
  sessionsRoot: string;
  registryFileName: string;
  variantsConfigFileName: string;
  loopHistoryDirName: string;
  sessionFileNames: {
    state: string;
    progressNotes: string;
    finalSummary: string;
    plan: string;
    planChoices: string;
    interruptMessage: string;
    stopRequest: string;
  };
  roomFileNames: {
    state: string;
    skills: string;
    input: string;
    output: string;
  };
  roomDirNames: Record<AgentRole, string>;
}

interface LoopDefaultsConfig {
  cliBinary: string;
  maxIterations: number;
  phaseTimeoutMs: number;
  idleTimeoutMs: number;
  ptyCols: number;
  ptyRows: number;
  profileFallbackModels: Record<string, string>;
}

interface LoopCliProfileConfig {
  defaultBinary: string;
  modelsArgs: string[];
  interactionWhitelist: string[];
  extraInteractionPatterns: string[];
}

interface LoopConfig {
  paths: LoopPathsConfig;
  defaults: LoopDefaultsConfig;
  cliProfiles: Record<string, LoopCliProfileConfig>;
  destructivePrompts: string[];
  variantDefaults: Record<string, string[]>;
}

function getDefaultConfig(): LoopConfig {
  return {
    paths: {
      sessionsRoot: ".goal/sessions",
      registryFileName: "sessions_registry.json",
      variantsConfigFileName: "model_variants.json",
      loopHistoryDirName: "loop_history",
      sessionFileNames: {
        state: "loop_state.json",
        progressNotes: "progress_notes.txt",
        finalSummary: "final_summary.json",
        plan: "plan.md",
        planChoices: "plan_choices.json",
        interruptMessage: "interrupt_message.txt",
        stopRequest: "stop_request.txt",
      },
      roomFileNames: {
        state: "state.json",
        skills: "skills.json",
        input: "input.json",
        output: "output.json",
      },
      roomDirNames: {
        planner: "0_planner",
        implementer: "1_implementer",
        tester: "2_tester",
        qa_lead: "3_qa_lead",
        master: "4_master",
        interrupter: "5_interrupter",
      },
    },
    defaults: {
      cliBinary: "opencode",
      maxIterations: 20,
      phaseTimeoutMs: 10 * 60 * 1000,
      idleTimeoutMs: 10 * 60 * 1000,
      ptyCols: 200,
      ptyRows: 50,
      profileFallbackModels: {
        opencode: "opencode/big-pickle",
        kilo: "anthropic/claude-sonnet-4-5",
        _default: "anthropic/claude-sonnet-4-5",
      },
    },
    cliProfiles: {},
    destructivePrompts: [
      "Delete", "Remove all", "Destroy", "Force overwrite",
      "git clean", "git checkout --", "git reset --hard",
      "Drop table", "Drop database",
    ],
    variantDefaults: {
      anthropic: ["high", "max"],
      openai: ["none", "minimal", "low", "medium", "high", "xhigh"],
      google: ["low", "high"],
      gemini: ["low", "high"],
      opencode: ["none", "minimal", "low", "medium", "high", "xhigh"],
      "opencode-go": ["none", "minimal", "low", "medium", "high", "xhigh"],
      kilo: ["none", "minimal", "low", "medium", "high", "xhigh"],
      deepseek: ["low", "medium", "high", "max"],
    },
  };
}

function mergeConfig(defaults: LoopConfig, overrides: Partial<LoopConfig>): LoopConfig {
  return {
    paths: { ...defaults.paths, ...overrides.paths } as LoopPathsConfig,
    defaults: { ...defaults.defaults, ...overrides.defaults } as LoopDefaultsConfig,
    cliProfiles: { ...defaults.cliProfiles, ...overrides.cliProfiles },
    destructivePrompts: overrides.destructivePrompts ?? defaults.destructivePrompts,
    variantDefaults: { ...defaults.variantDefaults, ...overrides.variantDefaults },
  };
}

async function loadLoopConfig(rootDir: string): Promise<LoopConfig> {
  const cfgPath = path.join(rootDir, "loop_config.json");
  const defaults = getDefaultConfig();
  try {
    const raw = await fse.readFile(cfgPath, "utf-8");
    const overrides = JSON.parse(raw) as Partial<LoopConfig>;
    return mergeConfig(defaults, overrides);
  } catch {
    return defaults;
  }
}

function cliProfileFromConfig(config: LoopConfig, profileName: string, binaryLower: string): CliProfile {
  const profileCfg = config.cliProfiles[profileName] || config.cliProfiles[binaryLower];
  if (profileCfg) {
    return {
      name: profileName || binaryLower,
      defaultBinary: profileCfg.defaultBinary,
      modelsArgs: profileCfg.modelsArgs,
      buildRunArgs: (opts) => {
        const args = [
          "run", "--format", "json",
          "--model", opts.model,
          "--dir", opts.targetProjectPath,
        ];
        if (profileName === "kilo") {
          args.push("--auto", "--pure");
        } else {
          args.push("--dangerously-skip-permissions");
        }
        if (opts.variant) args.push("--variant", opts.variant);
        args.push(opts.prompt);
        return args;
      },
      interactionWhitelist: profileCfg.interactionWhitelist,
    };
  }
  return profileName === "kilo" ? KILO_PROFILE : OPENCODE_PROFILE;
}

interface HandoffPayload {
  sessionId: string;
  refinedGoal: string;
  targetProjectPath: string;
  progressNotes: string;
  failureDigest: string | null;
  phase: Phase;
  loopCount: number;
  interruptMessage?: string;
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
  interruptMessage: string | null;
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
  cancelled: boolean;
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
  variant?: string;
  stopRequestPath?: string;
}

class StopRequestedError extends Error {
  constructor() {
    super("Stop requested");
    this.name = "StopRequestedError";
  }
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
  buildRunArgs: (opts: { model: string; targetProjectPath: string; prompt: string; variant?: string }) => string[];
  interactionWhitelist: string[];
}

const OPENCODE_PROFILE: CliProfile = {
  name: "opencode",
  defaultBinary: "opencode",
  modelsArgs: ["models"],
  buildRunArgs: (opts) => {
    const args = [
      "run",
      "--format", "json",
      "--model", opts.model,
      "--dir", opts.targetProjectPath,
      "--dangerously-skip-permissions",
    ];
    if (opts.variant) args.push("--variant", opts.variant);
    args.push(opts.prompt);
    return args;
  },
  interactionWhitelist: INTERACTION_WHITELIST,
};

const KILO_PROFILE: CliProfile = {
  name: "kilo",
  defaultBinary: "kilo",
  modelsArgs: ["models", "--pure"],
  buildRunArgs: (opts) => {
    const args = [
      "run",
      "--auto",
      "--pure",
      "--format", "json",
      "--model", opts.model,
      "--dir", opts.targetProjectPath,
    ];
    if (opts.variant) args.push("--variant", opts.variant);
    args.push(opts.prompt);
    return args;
  },
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
  const lower = binaryName.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");
  if (profileName && CLI_PROFILES[profileName]) {
    const builtin = CLI_PROFILES[profileName];
    if (lower !== builtin.defaultBinary && lower !== builtin.name && CLI_PROFILES[lower]) {
      return cliProfileFromConfig(loopConfig, profileName, lower);
    }
    return cliProfileFromConfig(loopConfig, profileName, lower);
  }
  if (CLI_PROFILES[lower]) {
    return cliProfileFromConfig(loopConfig, profileName ?? lower, lower);
  }
  return OPENCODE_PROFILE;
}

function getModelVariants(modelId: string, registry?: SessionRegistry): string[] {
  const slashIdx = modelId.indexOf("/");
  const provider = slashIdx > 0 ? modelId.slice(0, slashIdx).toLowerCase() : "";
  if (registry?.modelVariants?.[modelId]) {
    return registry.modelVariants[modelId];
  }
  return loopConfig.variantDefaults[provider] ?? [];
}

async function loadModelVariantsConfig(rootDir: string): Promise<Record<string, string[]> | null> {
  const cfgPath = path.join(rootDir, loopConfig.paths.variantsConfigFileName);
  try {
    const raw = await fse.readFile(cfgPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

let loopConfig: LoopConfig = getDefaultConfig();

const DEFAULT_MAX_ITERATIONS = 20;
const DEFAULT_PHASE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

const DEFAULT_SKILLS: Record<AgentRole, AgentSkills> = {
  planner: {
    role: "planner",
    allowedTools: ["read", "glob", "grep", "bash", "webfetch"],
    enforcedRules: [
      "Do NOT modify any source code files.",
      "Output exactly 3 numbered alternative implementation plans in the format below.",
      "Each plan must be self-contained with full detail (title + markdown body).",
      "Identify key files, approach, libraries, and step-by-step instructions in each plan.",
    ],
    systemPrompt: `Analyze the goal and the target project. Produce exactly 3 distinct, alternative implementation plans.

Output MUST follow this format EXACTLY:

=== PLAN OPTIONS ===
## OPTION 1: <short descriptive title>
<full markdown plan body with approach, files, steps, libraries>

## OPTION 2: <short descriptive title>
<full markdown plan body with approach, files, steps, libraries>

## OPTION 3: <short descriptive title>
<full markdown plan body with approach, files, steps, libraries>

Each plan must be a complete, standalone implementation strategy. Vary the approach between options (e.g. different libraries, architecture patterns, or implementation paths). End after OPTION 3.`,
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

function parsePlanChoices(output: string): PlanChoice[] {
  const marker = "=== PLAN OPTIONS ===";
  const idx = output.indexOf(marker);
  const section = idx >= 0 ? output.slice(idx + marker.length) : output;

  const choices: PlanChoice[] = [];
  const regex = /^## OPTION\s+(\d+):\s*(.+)$/gm;
  const matches: { index: number; id: number; title: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(section)) !== null) {
    matches.push({ index: m.index, id: parseInt(m[1], 10), title: m[2].trim() });
  }

  if (matches.length === 0) {
    choices.push({ id: 1, title: "Plan", body: output.trim() });
    return choices;
  }

  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index + matches[i].title.length + ("## OPTION ?: ".length + String(matches[i].id).length);
    const end = i + 1 < matches.length ? matches[i + 1].index : section.length;
    const body = section.slice(start, end).trim();
    choices.push({ id: matches[i].id, title: matches[i].title, body });
  }

  return choices;
}

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

interface SessionMetaPatch {
  sessionId: string;
  goal?: string;
  targetProjectPath?: string;
  status?: LoopStatus;
  createdAt?: string;
}

function upsertSessionMeta(registry: SessionRegistry, patch: SessionMetaPatch): void {
  const existing = registry.sessionMetas.find((m) => m.sessionId === patch.sessionId);
  if (existing) {
    if (patch.status !== undefined) existing.status = patch.status;
    if (patch.goal !== undefined) existing.goal = patch.goal;
    if (patch.targetProjectPath !== undefined) existing.targetProjectPath = patch.targetProjectPath;
  } else {
    registry.sessionMetas.push({
      sessionId: patch.sessionId,
      goal: patch.goal ?? "",
      targetProjectPath: patch.targetProjectPath ?? "",
      status: patch.status ?? LoopStatus.RUNNING,
      createdAt: patch.createdAt ?? new Date().toISOString(),
    });
  }
  if (!registry.activeSessionIds.includes(patch.sessionId)) {
    registry.activeSessionIds.push(patch.sessionId);
  }
}

async function reloadRegistry(registryPath: string, fallback: SessionRegistry): Promise<SessionRegistry> {
  const fresh = await atomicReadJson<SessionRegistry>(registryPath);
  return fresh ?? fallback;
}

async function mergeAndWriteSessionMeta(
  registryPath: string,
  fallback: SessionRegistry,
  patch: SessionMetaPatch
): Promise<SessionRegistry> {
  const merged = await reloadRegistry(registryPath, fallback);
  upsertSessionMeta(merged, patch);
  await atomicWriteJson(registryPath, merged);
  return merged;
}

async function mergeAndWriteRegistryFields(
  registryPath: string,
  fallback: SessionRegistry,
  fields: Partial<Pick<SessionRegistry, "availableModels" | "modelsDiscoveredAt" | "modelsDiscoveredCli" | "modelVariants">>
): Promise<SessionRegistry> {
  const merged = await reloadRegistry(registryPath, fallback);
  if (fields.availableModels !== undefined) merged.availableModels = fields.availableModels;
  if (fields.modelsDiscoveredAt !== undefined) merged.modelsDiscoveredAt = fields.modelsDiscoveredAt;
  if (fields.modelsDiscoveredCli !== undefined) merged.modelsDiscoveredCli = fields.modelsDiscoveredCli;
  if (fields.modelVariants !== undefined) merged.modelVariants = fields.modelVariants;
  await atomicWriteJson(registryPath, merged);
  return merged;
}

function resetStaleRunningAgentStates(agentStates: Record<AgentRole, AgentState>): void {
  for (const role of Object.keys(agentStates) as AgentRole[]) {
    if (agentStates[role].status === "running") {
      agentStates[role] = {
        status: "idle",
        lastExitCode: -1,
        lastRunAt: new Date().toISOString(),
      };
    }
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
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
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
    variant: opts.variant,
  });

  const env: { [key: string]: string } = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env["AGENT_LOOP_SESSION_ID"] = opts.sessionId;
  env["AGENT_LOOP_AGENT_ROLE"] = opts.agentRole;
  env["AGENT_LOOP_PHASE"] = opts.phaseLabel;

  const resolvedBinary = resolveBinaryOnWindows(opts.cliBinary);

  const hasTty = !!(process.stdin && (process.stdin as { isTTY?: boolean }).isTTY);
  const useConpty = process.platform === "win32" && hasTty;

  if (process.platform === "win32" && !hasTty) {
    console.warn(`[spawnCliPty] No TTY detected; disabling ConPTY to avoid AttachConsole failures.`);
  }

  const ptyProc = pty.spawn(resolvedBinary, args, {
    name: "xterm-256color",
    cols: loopConfig.defaults.ptyCols,
    rows: loopConfig.defaults.ptyRows,
    cwd: opts.targetProjectPath,
    env,
    useConpty,
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
      let jsonReassemblyBuffer = "";

    const finish = (result: Omit<PtyRunResult, "pid">) => {
      if (resolved) return;
      resolved = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (phaseTimer) clearTimeout(phaseTimer);
      if (stopTimer) clearInterval(stopTimer);
      try { ptyProc.kill(); } catch { /* already exited */ }
      resolve({ pid, ...result });
    };

    const triggerTimeout = (reason: string) => {
      killProcessTree(pid).then(() => {
        finish({ exitCode: -1, output, events, timedOut: true, cancelled: false, autoInjected });
        console.error(`[spawnCliPty] ${reason} for session=${opts.sessionId} role=${opts.agentRole}`);
      });
    };

    let stopTimer: NodeJS.Timeout | null = null;
    const checkStopRequest = async () => {
      if (resolved || !opts.stopRequestPath) return;
      try {
        const s = await fse.readFile(opts.stopRequestPath, "utf8");
        if (s.trim().length > 0) {
          await fse.remove(opts.stopRequestPath).catch(() => {});
          killProcessTree(pid).then(() => {
            finish({ exitCode: -1, output, events, timedOut: false, cancelled: true, autoInjected });
            console.log(`[spawnCliPty] Stop requested for session=${opts.sessionId} role=${opts.agentRole}`);
          });
        }
      } catch {
        // stop file does not exist
      }
    };

    if (opts.stopRequestPath) {
      stopTimer = setInterval(() => {
        checkStopRequest().catch(() => {});
      }, 500);
    }

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

        if (jsonReassemblyBuffer.length > 0) {
          jsonReassemblyBuffer += trimmed;
          if (jsonReassemblyBuffer.endsWith("}")) {
            try {
              const evt = JSON.parse(jsonReassemblyBuffer) as AnyObj;
              events.push(evt);
            } catch {
              // Genuinely invalid JSON, discard
            }
            jsonReassemblyBuffer = "";
          }
        } else if (trimmed.startsWith("{")) {
          if (trimmed.endsWith("}")) {
            try {
              const evt = JSON.parse(trimmed) as AnyObj;
              events.push(evt);
            } catch {
              // Starts with { and ends with } but invalid — try accumulating anyway
              jsonReassemblyBuffer = trimmed;
            }
          } else {
            jsonReassemblyBuffer = trimmed;
          }
        }

        const lower = trimmed.toLowerCase();
        const isDestructive = loopConfig.destructivePrompts.some((p) => lower.includes(p.toLowerCase()));
        const matchedWhitelist = opts.cliProfile.interactionWhitelist.find((p) => lower.includes(p.toLowerCase()));

        if (matchedWhitelist && !isDestructive) {
          const response = "y\n";
          ptyProc.write(response);
          autoInjected.push({ prompt: trimmed, response: "y", timestamp: new Date().toISOString() });
        }
      }
    });

    ptyProc.onExit((e) => {
      finish({ exitCode: e.exitCode, output, events, timedOut: false, cancelled: false, autoInjected });
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
      // Match lines that look like "provider/model" or "kilo/provider/model" (kilo nested format).
      // We prefer the longest match per line to capture nested identifiers like kilo/ai21/jamba-large-1.7.
      const lineRegex = /^([a-zA-Z0-9_~.-]+)\/([a-zA-Z0-9_~.-]+)(?:\/([a-zA-Z0-9_~.-]+))?/gm;
      let lineMatch: RegExpExecArray | null;
      while ((lineMatch = lineRegex.exec(text)) !== null) {
        let model: string;
        if (lineMatch[3]) {
          // 3-part: kilo/provider/model
          model = `${lineMatch[1]}/${lineMatch[2]}/${lineMatch[3]}`;
        } else {
          // 2-part: provider/model
          model = `${lineMatch[1]}/${lineMatch[2]}`;
        }
        if (!model.startsWith(".") && !model.startsWith("/") && !models.includes(model)) {
          models.push(model);
        }
      }
      if (models.length === 0) {
        const tuiErrorPatterns = [
          "registered data providers",
          "no registered",
          "tui",
          "auth",
          "connect",
        ];
        const lowerText = text.toLowerCase();
        const matched = tuiErrorPatterns.find((p) => lowerText.includes(p));
        if (matched) {
          console.warn(
            `[discoverCliModels] '${cliBinary} ${profile.modelsArgs.join(" ")}' returned a TUI/auth error instead of models. ` +
            `Output: ${text.slice(0, 400)}\n` +
            `If using kilo: run 'kilo auth' or set KILOCODE_API_KEY environment variable, then retry.`
          );
        } else if (text.trim().length > 0) {
          console.warn(
            `[discoverCliModels] '${cliBinary} ${profile.modelsArgs.join(" ")}' returned no parseable models. ` +
            `Output: ${text.slice(0, 400)}`
          );
        } else {
          console.warn(
            `[discoverCliModels] '${cliBinary} ${profile.modelsArgs.join(" ")}' produced no output. ` +
            `Verify the CLI is installed and authenticated.`
          );
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
    if (evt.type === "text") {
      const part = evt.part as Record<string, unknown> | undefined;
      const text = part && typeof part.text === "string" ? (part.text as string) : null;
      if (text && text.length > 0) {
        messages.push(text);
        continue;
      }
    }
    if (evt.type === "step_finish") {
      const part = evt.part as Record<string, unknown> | undefined;
      const result = part && typeof part.result === "string" ? (part.result as string) : null;
      if (result && result.length > 0) {
        messages.push(result);
        continue;
      }
    }
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

function sanitizeRefinedGoal(raw: string, fallback: string): string {
  if (raw.length === 0) return fallback;
  const trimmed = raw.trim();
  if (/^\{[\s\S]*"type"\s*:\s*"(step_start|tool_use|step_finish|text)"/.test(trimmed)) {
    return fallback;
  }
  if (trimmed.startsWith("<path>") || trimmed.startsWith("<type>")) {
    return fallback;
  }
  const lines = trimmed.split("\n").filter((l) => {
    const t = l.trim();
    if (t.length === 0) return false;
    if (/^\{[\s\S]*"type"\s*:/i.test(t)) return false;
    if (/^<[a-z]+>/.test(t)) return false;
    return true;
  });
  const cleaned = lines.join("\n").trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

function extractVerdictFromOutput(result: PtyRunResult): string {
  const textMessages: string[] = [];
  for (const evt of result.events) {
    if (evt.type === "text") {
      const part = evt.part as Record<string, unknown> | undefined;
      const partText = part && typeof part.text === "string" ? (part.text as string) : null;
      const val = partText || evt.text || evt.content || evt.message;
      if (typeof val === "string" && val.length > 0) {
        textMessages.push(val);
      }
    }
  }
  if (textMessages.length > 0) {
    return textMessages[textMessages.length - 1].trim();
  }

  const allMessages: string[] = [];
  for (const evt of result.events) {
    if (evt.type === "text") {
      const part = evt.part as Record<string, unknown> | undefined;
      const partText = part && typeof part.text === "string" ? (part.text as string) : null;
      if (partText && partText.length > 0) {
        allMessages.push(partText);
        continue;
      }
    }
    if (evt.type === "step_finish") {
      const part = evt.part as Record<string, unknown> | undefined;
      const partResult = part && typeof part.result === "string" ? (part.result as string) : null;
      if (partResult && partResult.length > 0) {
        allMessages.push(partResult);
        continue;
      }
    }
    const contentKeys = ["content", "text", "message", "output"];
    for (const key of contentKeys) {
      const val = evt[key];
      if (typeof val === "string" && val.length > 0) {
        allMessages.push(val);
        break;
      }
    }
  }
  if (allMessages.length > 0) {
    return allMessages[allMessages.length - 1].trim();
  }

  const stripped = stripAnsi(result.output);
  const sentinelIdx = stripped.indexOf(SENTINEL);
  if (sentinelIdx >= 0) {
    return stripped.slice(0, sentinelIdx).trim();
  }

  return stripped.trim().slice(-2000);
}

function parseMasterVerdict(output: string): "approved" | "rejected" | "unknown" {
  const lower = output.toLowerCase().trim();
  if (lower.length === 0) return "unknown";

  const last500 = lower.slice(-500);

  if (/\bapproved\b/.test(last500) && !/\bnot\s+approved\b/.test(last500)) {
    return "approved";
  }
  if (/\brejected\b/.test(last500) || /\breject\b/.test(last500)) {
    return "rejected";
  }
  if (/\bverdict:\s*pass\b/.test(last500)) {
    return "approved";
  }
  if (/\bverdict:\s*fail\b/.test(last500)) {
    return "rejected";
  }
  if (/\ball\s+tests?\s+passed\b/.test(last500)) {
    return "approved";
  }

  if (/\bapproved\b/.test(lower) && !/\bnot\s+approved\b/.test(lower) && !/\breject(ed|ing)?\b/.test(lower.slice(-1000))) {
    return "approved";
  }

  return "unknown";
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
  const cfg = loopConfig.paths;
  const sessionsRoot = path.join(rootDir, cfg.sessionsRoot);
  const sessionDir = path.join(sessionsRoot, sessionId);

  const rooms: Partial<Record<AgentRole, AgentRoom>> = {};

  for (const role of Object.keys(cfg.roomDirNames) as AgentRole[]) {
    const roomDir = path.join(sessionDir, cfg.roomDirNames[role]);
    await fse.ensureDir(roomDir);
    rooms[role] = {
      role,
      statePath: path.join(roomDir, cfg.roomFileNames.state),
      skillsPath: path.join(roomDir, cfg.roomFileNames.skills),
      inputPayloadPath: path.join(roomDir, cfg.roomFileNames.input),
      outputPayloadPath: path.join(roomDir, cfg.roomFileNames.output),
    };
    await atomicWriteJson(rooms[role]!.skillsPath, DEFAULT_SKILLS[role]);
    await atomicWriteJson(rooms[role]!.statePath, { status: "idle", lastExitCode: null, lastRunAt: null });
    await atomicWriteJson(rooms[role]!.inputPayloadPath, {});
    await atomicWriteJson(rooms[role]!.outputPayloadPath, {});
  }

  await fse.ensureDir(path.join(sessionDir, cfg.loopHistoryDirName));

  const notesPath = path.join(sessionDir, cfg.sessionFileNames.progressNotes);
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
  if (payload.interruptMessage && payload.interruptMessage.length > 0) {
    lines.push("=== HUMAN OPERATOR INTERRUPT MESSAGE ===");
    lines.push(payload.interruptMessage);
    lines.push("");
    lines.push("The operator has paused this session with the above message.");
    lines.push("Address their specific concerns in your briefing.");
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
  agent-loop revise-plan --session <id> --message "..."  Revise the plan with AI

Options for 'run':
  --goal <text>              The goal to achieve (required)
  --target <path>            Target project path (default: cwd)
  --binary <name>            CLI binary name (default: opencode)
  --profile <name>           CLI profile: opencode | kilo (auto-detected from --binary)
  --max-iterations <n>       Max loop iterations (default: 20)
  --phase-timeout <ms>       Phase timeout in ms (default: 600000)
  --idle-timeout <ms>        Idle timeout in ms (default: 600000)
  --planner-model <m>        Model for planner agent
  --implementer-model <m>    Model for implementer agent
  --tester-model <m>         Model for tester agent
  --qa-model <m>             Model for qa_lead agent
  --master-model <m>         Model for master agent
  --interrupter-model <m>    Model for interrupter agent
  --session <id>             Pre-assigned session ID (optional; auto-generated if omitted)
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
    const cfg = loopConfig.paths;
    this.rootDir = rootDir;
    this.registry = registry;
    this.state = state;
    this.rooms = rooms;
    this.registryPath = path.join(rootDir, cfg.registryFileName);
    this.sessionDir = path.join(rootDir, cfg.sessionsRoot, state.sessionId);
  }

  async run(): Promise<void> {
    this.registerSignalHandlers();

    while (!this.disposed && this.state.status === LoopStatus.RUNNING) {
      const interruptPath = path.join(this.sessionDir, loopConfig.paths.sessionFileNames.interruptMessage);
      try {
        const msg = await fse.readFile(interruptPath, "utf8");
        if (msg.trim().length > 0) {
          await fse.remove(interruptPath);
          this.state.interruptMessage = msg.trim();
          this.state.phase = Phase.INTERRUPT;
          await this.appendProgressNote(
            `[Loop ${this.state.loopCount}] INTERRUPT: Human operator message: "${msg.trim()}"`
          );
          await this.saveState();
          continue;
        }
      } catch {
        // file doesn't exist — no interrupt pending
      }

      const stopPath = path.join(this.sessionDir, loopConfig.paths.sessionFileNames.stopRequest);
      try {
        const s = await fse.readFile(stopPath, "utf8");
        if (s.trim().length > 0) {
          await fse.remove(stopPath);
          this.state.status = LoopStatus.PAUSED;
          await this.appendProgressNote(
            `[Loop ${this.state.loopCount}] STOP: User requested stop. Session paused by user request.`
          );
          await this.saveState();
          await this.saveRegistry();
          return;
        }
      } catch {
        // file doesn't exist — no stop pending
      }

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
        if (err instanceof StopRequestedError) {
          return;
        }
        if (this.disposed || this.state.status !== LoopStatus.RUNNING) {
          return;
        }
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

    if (this.state.awaitingPlanApproval) {
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
    const choices = parsePlanChoices(output);

    const planPath = path.join(this.sessionDir, loopConfig.paths.sessionFileNames.plan);
    const choicesPath = path.join(this.sessionDir, loopConfig.paths.sessionFileNames.planChoices);
    await atomicWriteJson(choicesPath, choices);

    this.state.planPath = planPath;
    this.state.awaitingPlanApproval = true;
    this.state.planApproved = false;
    this.state.status = LoopStatus.PAUSED;

    await this.appendProgressNote(`[Loop 0] PLANNING: ${choices.length} plan options generated. Awaiting user selection.`);
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

    const fullOutput = extractOutput(result);
    const verdictText = extractVerdictFromOutput(result);
    const verdict = parseMasterVerdict(verdictText);
    const approved = result.exitCode === 0 && verdict === "approved";

    console.log(`[orchestrator] Master verdict: ${verdict} (exitCode=${result.exitCode})`);
    console.log(`[orchestrator] Verdict text (last 200 chars): ${verdictText.slice(-200)}`);

    if (approved) {
      this.state.masterApproved = true;
      this.state.status = LoopStatus.SUCCESS;
      await this.emitFinalSummary();
      await this.appendProgressNote(`[Loop ${this.state.loopCount}] MASTER_APPROVAL: APPROVED. Session SUCCESS.`);
      await this.saveRegistry();
      console.log(`[orchestrator] Session ${this.state.sessionId} achieved SUCCESS.`);
    } else {
      await this.appendProgressNote(`[Loop ${this.state.loopCount}] MASTER_APPROVAL: REJECTED (${verdict}). Regressing to IMPLEMENTATION.`);
      const rejectEntry: ErrorSignature = {
        signature: normalizeSignature(`master_reject:${verdictText.slice(0, 80)}`),
        rawMessage: verdictText.slice(0, 200),
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

    const humanMessage = this.state.interruptMessage;
    if (humanMessage) {
      this.state.interruptMessage = undefined;
    }

    const payload: HandoffPayload = {
      sessionId: this.state.sessionId,
      refinedGoal: this.state.refinedGoal || this.state.goal,
      targetProjectPath: this.state.targetProjectPath,
      progressNotes: notes,
      failureDigest: errorSummary,
      phase: Phase.INTERRUPT,
      loopCount: this.state.loopCount,
      interruptMessage: humanMessage,
    };

    const prompt = buildPrompt("interrupter", payload);
    const startedAt = new Date();
    const result = await this.executeAgent("interrupter", prompt);
    const endedAt = new Date();

    await this.archiveLoop(this.state.loopCount, Phase.INTERRUPT, "interrupter", result, startedAt, endedAt);

    const briefing = extractOutput(result);
    this.state.interruptBriefing = briefing;
    console.warn("\n=== INTERRUPTER BRIEFING ===");
    console.warn(briefing);
    console.warn("============================");
    console.warn(`Session ${this.state.sessionId} is PAUSED. Review the briefing and resume with:`);
    console.warn(`  agent-loop resume --session ${this.state.sessionId} --root ${this.rootDir}`);

    this.state.status = LoopStatus.PAUSED;
  }

  private getStopRequestPath(): string {
    return path.join(this.sessionDir, loopConfig.paths.sessionFileNames.stopRequest);
  }

  private resetRunningAgentStates(): void {
    resetStaleRunningAgentStates(this.state.agentStates);
  }

  private async executeAgent(role: AgentRole, prompt: string): Promise<PtyRunResult> {
    const model = this.state.modelMapping[role];
    const variant = this.state.variantMapping?.[role] || undefined;
    this.state.agentStates[role] = {
      status: "running",
      lastExitCode: null,
      lastRunAt: new Date().toISOString(),
    };
    await this.saveState();

    console.log(`\n[${this.state.sessionId}] Phase=${this.state.phase} Role=${role} Model=${model}${variant ? ` Variant=${variant}` : ""} Loop=${this.state.loopCount}`);
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
      variant,
      stopRequestPath: this.getStopRequestPath(),
    });

    this.activePtyPid = handle.pid;

    const result = await handle.done;

    this.activePtyPid = null;

    if (result.cancelled) {
      this.state.status = LoopStatus.PAUSED;
      this.state.agentStates[role] = {
        status: "failed",
        lastExitCode: -1,
        lastRunAt: new Date().toISOString(),
      };
      await this.appendProgressNote(
        `[Loop ${this.state.loopCount}] STOP: User requested stop; ${role} agent terminated immediately.`
      );
      await this.saveState();
      await this.saveRegistry();
      throw new StopRequestedError();
    }

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
      interruptMessage: this.state.interruptMessage ?? null,
    };
    const fileName = `loop_${loopNum}_${phase.toLowerCase()}_${role}.json`;
    const filePath = path.join(this.sessionDir, loopConfig.paths.loopHistoryDirName, fileName);
    await atomicWriteJson(filePath, entry);
  }

  private async appendProgressNote(note: string): Promise<void> {
    const notesPath = path.join(this.sessionDir, loopConfig.paths.sessionFileNames.progressNotes);
    await atomicAppendLine(notesPath, note);
  }

  private async readProgressNotes(): Promise<string> {
    const notesPath = path.join(this.sessionDir, loopConfig.paths.sessionFileNames.progressNotes);
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
    const summaryPath = path.join(this.sessionDir, loopConfig.paths.sessionFileNames.finalSummary);
    await atomicWriteJson(summaryPath, summary);
  }

  private async saveState(): Promise<void> {
    this.state.updatedAt = new Date().toISOString();
    const statePath = path.join(this.sessionDir, loopConfig.paths.sessionFileNames.state);
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
    this.registry = await mergeAndWriteSessionMeta(this.registryPath, this.registry, {
      sessionId: this.state.sessionId,
      goal: this.state.goal,
      targetProjectPath: this.state.targetProjectPath,
      status: this.state.status,
      createdAt: this.state.createdAt,
    });
  }

  private registerSignalHandlers(): void {
    if (this.signalHandlersRegistered) return;
    this.signalHandlersRegistered = true;

    const handler = () => {
      this.dispose().then(() => {
        process.exit(0);
      }).catch((err) => {
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
      await this.appendProgressNote(
        `[Loop ${this.state.loopCount}] STOPPED: Operator stopped the session via command.`
      );
    }
    this.resetRunningAgentStates();
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
  variantMapping: VariantMapping,
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
    variantMapping,
    errorQueue: [],
    agentStates,
    refinedGoal: null,
    planningComplete: false,
    masterApproved: false,
    awaitingPlanApproval: false,
    planApproved: false,
    planPath: null,
    lastFailureDigest: null,
    interruptBriefing: null,
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

function resolveVariantMapping(parsed: Record<string, string>): VariantMapping {
  const mapping: VariantMapping = {};
  const roleToFlag: Record<string, AgentRole> = {
    "planner-variant": "planner",
    "implementer-variant": "implementer",
    "tester-variant": "tester",
    "qa-variant": "qa_lead",
    "master-variant": "master",
    "interrupter-variant": "interrupter",
  };
  for (const [flag, role] of Object.entries(roleToFlag)) {
    if (parsed[flag]) mapping[role] = parsed[flag];
  }
  return mapping;
}

async function resolveRootDir(parsed: Record<string, string>): Promise<string> {
  if (parsed.root) return path.resolve(parsed.root);
  const scriptDir = path.dirname(process.argv[1]);
  if (await fse.pathExists(path.join(scriptDir, loopConfig.paths.registryFileName))) {
    return scriptDir;
  }
  return process.cwd();
}

async function cmdInit(rootDir: string): Promise<void> {
  const cfg = loopConfig.paths;
  await fse.ensureDir(path.join(rootDir, cfg.sessionsRoot));
  const registryPath = path.join(rootDir, cfg.registryFileName);
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
    modelsDiscoveredCli: null,
    sessionMetas: [],
    manualModelsOverride: null,
    modelVariants: null,
  };
  await atomicWriteJson(registryPath, registry);
  console.log(`Initialized agent-loop system at ${rootDir}`);
  console.log(`Registry: ${registryPath}`);
  console.log(`Sessions dir: ${path.join(rootDir, loopConfig.paths.sessionsRoot)}`);
}

async function cmdModels(parsed: Record<string, string>, rootDir: string): Promise<void> {
  const cliBinary = parsed.binary || loopConfig.defaults.cliBinary;
  const profile = resolveCliProfile(parsed.profile ?? null, cliBinary);
  const registryPath = path.join(rootDir, loopConfig.paths.registryFileName);
  const registry = await atomicReadJson<SessionRegistry>(registryPath);
  const override = registry?.manualModelsOverride ?? null;
  const models = await discoverCliModels(cliBinary, override, profile);

  if (registry) {
    const modelVariantsConfig = await loadModelVariantsConfig(rootDir);
    await mergeAndWriteRegistryFields(registryPath, registry, {
      availableModels: models,
      modelsDiscoveredAt: new Date().toISOString(),
      modelsDiscoveredCli: `${cliBinary} (${profile.name})`,
      modelVariants: modelVariantsConfig ?? null,
    });
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
  const cliBinary = parsed.binary && parsed.binary !== "true" ? parsed.binary : loopConfig.defaults.cliBinary;
  const profile = resolveCliProfile(parsed.profile ?? null, cliBinary);
  const maxIterations = parseIntSafe(parsed["max-iterations"], loopConfig.defaults.maxIterations);
  const phaseTimeoutMs = parseIntSafe(parsed["phase-timeout"], loopConfig.defaults.phaseTimeoutMs);
  const idleTimeoutMs = parseIntSafe(parsed["idle-timeout"], loopConfig.defaults.idleTimeoutMs);

  const registryPath = path.join(rootDir, loopConfig.paths.registryFileName);
  let registry = await atomicReadJson<SessionRegistry>(registryPath);
  if (!registry) {
    await cmdInit(rootDir);
    registry = await atomicReadJson<SessionRegistry>(registryPath);
  }
  if (!registry) {
    console.error("Error: Failed to initialize or read session registry.");
    process.exit(1);
  }
  let reg: SessionRegistry = registry;

  console.log(`[orchestrator] CLI profile: ${profile.name} | binary: ${cliBinary}`);
  if (profile.defaultBinary !== cliBinary) {
    const baseName = cliBinary.toLowerCase().replace(/\.(exe|cmd|bat)$/, "");
    if (baseName !== profile.name) {
      console.warn(
        `[orchestrator] WARNING: CLI profile '${profile.name}' expects binary '${profile.defaultBinary}' but got '${cliBinary}'. ` +
        `Arguments may not be compatible. Use --profile matching your binary, or use --binary ${profile.defaultBinary}.`
      );
    }
  }
  console.log(`[orchestrator] Discovering available models from '${cliBinary}'...`);
  const models = await discoverCliModels(cliBinary, reg.manualModelsOverride, profile);
  reg = await mergeAndWriteRegistryFields(registryPath, reg, {
    availableModels: models,
    modelsDiscoveredAt: new Date().toISOString(),
    modelsDiscoveredCli: `${cliBinary} (${profile.name})`,
  });

  if (models.length === 0) {
    console.warn(`[orchestrator] No models discovered. Using fallback model names. Specify models explicitly with --planner-model etc.`);
  } else {
    console.log(`[orchestrator] Discovered ${models.length} models.`);
  }

  const fallbackModels = loopConfig.defaults.profileFallbackModels;
  const profileFallback = fallbackModels[profile.name] ?? fallbackModels["_default"] ?? "anthropic/claude-sonnet-4-5";
  const fallbackModel = models.length > 0 ? models[0] : profileFallback;
  const modelMapping = resolveModelMapping(parsed, models, fallbackModel);
  const variantMapping = resolveVariantMapping(parsed);

  console.log(`[orchestrator] Model mapping:`);
  for (const [role, model] of Object.entries(modelMapping)) {
    const vrnt = variantMapping[role as AgentRole] || "(default)";
    console.log(`  ${role}: ${model} (variant: ${vrnt})`);
  }

  const modelVariantsConfig = await loadModelVariantsConfig(rootDir);
  if (modelVariantsConfig) {
    reg = await mergeAndWriteRegistryFields(registryPath, reg, {
      modelVariants: modelVariantsConfig,
    });
  }

  const sessionId = parsed.session && parsed.session !== "true" ? parsed.session : generateSessionId();
  const sessionDir = path.join(rootDir, loopConfig.paths.sessionsRoot, sessionId);
  const statePath = path.join(sessionDir, loopConfig.paths.sessionFileNames.state);
  if (await fse.pathExists(statePath)) {
    console.error(`Error: Session ${sessionId} already exists.`);
    process.exit(1);
  }
  console.log(`[orchestrator] New session: ${sessionId}`);

  const { sessionDir: _, rooms } = await initGoalTree(rootDir, sessionId);

  const state = createDefaultLoopState(
    sessionId,
    goal,
    targetProjectPath,
    modelMapping,
    variantMapping,
    cliBinary,
    profile.name,
    maxIterations,
    phaseTimeoutMs,
    idleTimeoutMs
  );

  await atomicWriteJson(statePath, state);

  reg = await mergeAndWriteSessionMeta(registryPath, reg, {
    sessionId,
    goal,
    targetProjectPath: path.resolve(targetProjectPath),
    status: LoopStatus.RUNNING,
    createdAt: state.createdAt,
  });

  const orchestrator = new LoopOrchestrator(rootDir, reg, state, rooms);
  await orchestrator.run();

  const finalState = await atomicReadJson<LoopState>(statePath);
  if (finalState) {
    console.log(`\n[orchestrator] Session ${sessionId} ended with status: ${finalState.status}`);
    if (finalState.status === LoopStatus.SUCCESS) {
      const summaryPath = path.join(sessionDir, loopConfig.paths.sessionFileNames.finalSummary);
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

  const registryPath = path.join(rootDir, loopConfig.paths.registryFileName);
  let registry = await atomicReadJson<SessionRegistry>(registryPath);
  if (!registry) {
    console.error(`Error: No registry found at ${registryPath}. Run 'agent-loop init' first.`);
    process.exit(1);
  }

  const sessionDir = path.join(rootDir, loopConfig.paths.sessionsRoot, sessionId);
  const statePath = path.join(sessionDir, loopConfig.paths.sessionFileNames.state);
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
  if (state.idleTimeoutMs <= 90 * 1000) {
    state.idleTimeoutMs = 10 * 60 * 1000;
  }
  if (parsed.binary && parsed.binary !== "true") state.cliBinary = parsed.binary;
  if (parsed.profile && parsed.profile !== "true") state.cliProfile = parsed.profile;
  if (!state.cliProfile) state.cliProfile = resolveCliProfile(null, state.cliBinary).name;
  state.variantMapping = state.variantMapping ?? resolveVariantMapping(parsed);

  resetStaleRunningAgentStates(state.agentStates);

  if (state.status === LoopStatus.PAUSED) {
    state.status = LoopStatus.RUNNING;
    if (state.awaitingPlanApproval && state.planApproved) {
      try {
        const plan = await fse.readFile(path.join(sessionDir, loopConfig.paths.sessionFileNames.plan), "utf8");
        if (plan.trim().length > 0) state.refinedGoal = plan.trim();
      } catch { /* plan.md not yet written */ }
      state.planningComplete = true;
      state.awaitingPlanApproval = false;
      state.phase = Phase.IMPLEMENTATION;
    } else if (state.planPath) {
      try {
        const plan = await fse.readFile(state.planPath, "utf8");
        if (plan.trim().length > 0) state.refinedGoal = plan.trim();
      } catch { /* keep existing refinedGoal */ }
    }
    if (state.phase === Phase.INTERRUPT) {
      state.phase = Phase.IMPLEMENTATION;
      state.interruptBriefing = null;
    }
  }

  const rooms: Partial<Record<AgentRole, AgentRoom>> = {};
  for (const role of Object.keys(loopConfig.paths.roomDirNames) as AgentRole[]) {
    const roomDir = path.join(sessionDir, loopConfig.paths.roomDirNames[role]);
    rooms[role] = {
      role,
      statePath: path.join(roomDir, loopConfig.paths.roomFileNames.state),
      skillsPath: path.join(roomDir, loopConfig.paths.roomFileNames.skills),
      inputPayloadPath: path.join(roomDir, loopConfig.paths.roomFileNames.input),
      outputPayloadPath: path.join(roomDir, loopConfig.paths.roomFileNames.output),
    };
  }

  await atomicWriteJson(statePath, state);

  registry = await mergeAndWriteSessionMeta(registryPath, registry, {
    sessionId,
    goal: state.goal,
    targetProjectPath: state.targetProjectPath,
    status: state.status,
    createdAt: state.createdAt,
  });

  const orchestrator = new LoopOrchestrator(rootDir, registry, state, rooms as Record<AgentRole, AgentRoom>);
  await orchestrator.run();

  const finalState = await atomicReadJson<LoopState>(statePath);
  if (finalState) {
    console.log(`\n[orchestrator] Session ${sessionId} ended with status: ${finalState.status}`);
  }
}

async function cmdRevisePlan(parsed: Record<string, string>, rootDir: string): Promise<void> {
  const sessionId = parsed.session;
  if (!sessionId || sessionId === "true") {
    console.error("Error: --session is required for 'revise-plan'");
    process.exit(1);
  }
  const message = parsed.message || "";
  if (!message || message === "true") {
    console.error("Error: --message is required for 'revise-plan'");
    process.exit(1);
  }

  const registryPath = path.join(rootDir, loopConfig.paths.registryFileName);
  const registry = await atomicReadJson<SessionRegistry>(registryPath);
  if (!registry) {
    console.error(`Error: No registry found at ${registryPath}.`);
    process.exit(1);
  }

  const sessionDir = path.join(rootDir, loopConfig.paths.sessionsRoot, sessionId);
  const statePath = path.join(sessionDir, loopConfig.paths.sessionFileNames.state);
  const state = await atomicReadJson<LoopState>(statePath);
  if (!state) {
    console.error(`Error: No session found with ID ${sessionId}`);
    process.exit(1);
  }

  const planPath = state.planPath || path.join(sessionDir, loopConfig.paths.sessionFileNames.plan);
  let currentPlan = "";
  try { currentPlan = await fse.readFile(planPath, "utf8"); } catch { /* empty */ }

  const payload: HandoffPayload = {
    sessionId: state.sessionId,
    refinedGoal: state.refinedGoal || state.goal,
    targetProjectPath: state.targetProjectPath,
    progressNotes: "",
    failureDigest: null,
    phase: state.phase,
    loopCount: state.loopCount,
  };

  const prompt = `You are the planner agent. Revise the plan according to the user's request.

Current Plan:
${currentPlan || "(no plan yet — the goal is: " + (state.refinedGoal || state.goal) + ")"}

User Revision Request: ${message}

Output the full revised plan as markdown only. Do not include the original prompt or any meta-commentary. Output ONLY the revised markdown plan.`;

  const handle = spawnCliPty({
    model: state.modelMapping.planner,
    agentRole: "planner",
    sessionId: state.sessionId,
    targetProjectPath: state.targetProjectPath,
    prompt,
    timeoutMs: state.phaseTimeoutMs,
    idleTimeoutMs: state.idleTimeoutMs,
    cliBinary: state.cliBinary,
    cliProfile: resolveCliProfile(state.cliProfile, state.cliBinary),
    phaseLabel: "PLAN_REVISION",
    variant: state.variantMapping?.planner,
  });

  const result = await handle.done;

  const output = extractOutput(result);
  await fse.writeFile(planPath, output, "utf8");

  if (!state.planPath) {
    state.planPath = planPath;
    await atomicWriteJson(statePath, state);
  }

  console.log(output);
  process.exit(result.exitCode === 0 ? 0 : 1);
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
  loopConfig = await loadLoopConfig(rootDir);

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
    case "revise-plan":
      await cmdRevisePlan(parsed, rootDir);
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
