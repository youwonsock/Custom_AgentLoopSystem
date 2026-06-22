import * as vscode from "vscode";

export type LoopStatus = "RUNNING" | "PAUSED" | "SUCCESS" | "FAILED";
export type Phase = "PLANNING" | "IMPLEMENTATION" | "TEST_GENERATION" | "VERIFICATION" | "MASTER_APPROVAL" | "INTERRUPT";
export type AgentRole = "planner" | "implementer" | "tester" | "qa_lead" | "master" | "interrupter";

export interface ModelMapping {
  planner: string;
  implementer: string;
  tester: string;
  qa_lead: string;
  master: string;
  interrupter: string;
}

export type VariantMapping = Partial<Record<AgentRole, string>>;

export interface ErrorSignature {
  signature: string;
  rawMessage: string;
  timestamp: number;
  phase: Phase;
}

export interface AgentState {
  status: "idle" | "running" | "completed" | "failed";
  lastExitCode: number | null;
  lastRunAt: string | null;
}

export interface LoopState {
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
  createdAt: string;
  updatedAt: string;
  maxIterations: number;
  phaseTimeoutMs: number;
  idleTimeoutMs: number;
  cliBinary: string;
  cliProfile: string;
  variantMapping: VariantMapping;
  awaitingPlanApproval: boolean;
  planApproved: boolean;
  planPath: string | null;
}

export interface PlanChoice {
  id: number;
  title: string;
  body: string;
}

export interface SessionMeta {
  sessionId: string;
  goal: string;
  targetProjectPath: string;
  status: LoopStatus;
  createdAt: string;
}

export interface SessionRegistry {
  version: number;
  activeSessionIds: string[];
  availableModels: string[];
  modelsDiscoveredAt: string | null;
  modelsDiscoveredCli: string | null;
  sessionMetas: SessionMeta[];
  manualModelsOverride: string[] | null;
  modelVariants: Record<string, string[]> | null;
}

export interface LoopHistoryEntry {
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
  interruptMessage?: string | null;
}

export interface FinalSummary {
  sessionId: string;
  goal: string;
  achievedAt: string;
  totalLoops: number;
  finalModelMapping: ModelMapping;
  progressNotes: string;
  approvedByMaster: boolean;
}

export interface SessionBundle {
  registry: SessionRegistry;
  state: LoopState | null;
  progressNotes: string;
  history: LoopHistoryEntry[];
  finalSummary: FinalSummary | null;
}

export type WebviewMessage =
  | { command: "requestState" }
  | { command: "newSession"; goal: string; targetProjectPath: string; cliProfile?: string; modelMapping: Partial<ModelMapping>; variantMapping?: Partial<VariantMapping> }
  | { command: "resumeSession"; sessionId: string }
  | { command: "stopSession"; sessionId: string }
  | { command: "discoverModels" }
  | { command: "selectSession"; sessionId: string }
  | { command: "refreshModels" }
  | { command: "openProgressNotes"; sessionId: string }
  | { command: "openFinalSummary"; sessionId: string }
  | { command: "deleteSession"; sessionId: string }
  | { command: "setCliProfile"; profile: string }
  | { command: "openSessionFolder"; sessionId: string }
  | { command: "interruptSession"; sessionId: string; message: string }
  | { command: "selectPlanChoice"; sessionId: string; choiceId: number }
  | { command: "revisePlan"; sessionId: string; message: string }
  | { command: "approvePlan"; sessionId: string }
  | { command: "requestPlanReviewState"; sessionId: string };

export interface PlanReviewStatePayload {
  sessionId: string;
  awaitingPlanApproval: boolean;
  planApproved: boolean;
  choices: PlanChoice[] | null;
  planMd: string | null;
  isPaused: boolean;
  phase: Phase | null;
}

export interface WebviewStatePayload {
  registry: SessionRegistry;
  selectedSessionId: string | null;
  state: LoopState | null;
  progressNotes: string;
  history: LoopHistoryEntry[];
  finalSummary: FinalSummary | null;
  isRunning: boolean;
  defaultTargetPath: string;
  cliProfile: string;
  modelsDiscoveredCli: string | null;
  modelVariants: Record<string, string[]> | null;
  variantMapping: VariantMapping;
}

export interface ExtensionConfig {
  cliBinary: string;
  cliProfile: string;
  rootDir: string;
  nodeBinary: string;
  orchestratorScript: string;
  maxIterations: number;
  phaseTimeoutMs: number;
  idleTimeoutMs: number;
  pollIntervalMs: number;
}

function normalizePathSetting(value: string | undefined): string {
  if (!value) return "";
  let v = value.trim();
  // Strip surrounding quotes that users often paste in (e.g. "C:\path" or 'C:\path').
  while (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

const KNOWN_CLI_BINARIES = new Set(["opencode", "kilo"]);
const PROFILE_DEFAULT_BINARY: Record<string, string> = {
  opencode: "opencode",
  kilo: "kilo",
};

export function readExtensionConfig(): ExtensionConfig {
  const cfg = vscode.workspace.getConfiguration("agentLoop");
  const cliProfile = cfg.get<string>("cliProfile", "opencode").trim();
  let cliBinary = cfg.get<string>("cliBinary", "opencode").trim();
  // Auto-sync: if cliBinary is one of the known default names and doesn't match the
  // active profile's default binary, adopt the profile's default. This ensures that
  // changing only `cliProfile` in settings always yields a coherent (binary, profile) pair.
  const profileDefaultBinary = PROFILE_DEFAULT_BINARY[cliProfile];
  if (profileDefaultBinary && KNOWN_CLI_BINARIES.has(cliBinary) && cliBinary !== profileDefaultBinary) {
    cliBinary = profileDefaultBinary;
    cfg.update("cliBinary", cliBinary, vscode.ConfigurationTarget.Global).then(
      () => {},
      () => {}
    );
  }
  return {
    cliBinary,
    cliProfile,
    rootDir: normalizePathSetting(cfg.get<string>("rootDir", "")),
    nodeBinary: normalizePathSetting(cfg.get<string>("nodeBinary", "node")) || "node",
    orchestratorScript: normalizePathSetting(cfg.get<string>("orchestratorScript", "")),
    maxIterations: cfg.get<number>("maxIterations", 20),
    phaseTimeoutMs: cfg.get<number>("phaseTimeoutMs", 600000),
    idleTimeoutMs: cfg.get<number>("idleTimeoutMs", 90000),
    pollIntervalMs: cfg.get<number>("pollIntervalMs", 500),
  };
}
