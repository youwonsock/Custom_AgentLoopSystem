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
  sessionMetas: SessionMeta[];
  manualModelsOverride: string[] | null;
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
  | { command: "newSession"; goal: string; targetProjectPath: string; modelMapping: Partial<ModelMapping> }
  | { command: "resumeSession"; sessionId: string }
  | { command: "stopSession"; sessionId: string }
  | { command: "discoverModels" }
  | { command: "selectSession"; sessionId: string }
  | { command: "refreshModels" }
  | { command: "openProgressNotes"; sessionId: string }
  | { command: "openFinalSummary"; sessionId: string };

export interface WebviewStatePayload {
  registry: SessionRegistry;
  selectedSessionId: string | null;
  state: LoopState | null;
  progressNotes: string;
  history: LoopHistoryEntry[];
  finalSummary: FinalSummary | null;
  isRunning: boolean;
  defaultTargetPath: string;
}

export interface ExtensionConfig {
  cliBinary: string;
  rootDir: string;
  nodeBinary: string;
  orchestratorScript: string;
  maxIterations: number;
  phaseTimeoutMs: number;
  idleTimeoutMs: number;
  pollIntervalMs: number;
}

export function readExtensionConfig(): ExtensionConfig {
  const cfg = vscode.workspace.getConfiguration("agentLoop");
  return {
    cliBinary: cfg.get<string>("cliBinary", "opencode"),
    rootDir: cfg.get<string>("rootDir", ""),
    nodeBinary: cfg.get<string>("nodeBinary", "node"),
    orchestratorScript: cfg.get<string>("orchestratorScript", ""),
    maxIterations: cfg.get<number>("maxIterations", 20),
    phaseTimeoutMs: cfg.get<number>("phaseTimeoutMs", 600000),
    idleTimeoutMs: cfg.get<number>("idleTimeoutMs", 90000),
    pollIntervalMs: cfg.get<number>("pollIntervalMs", 1000),
  };
}
