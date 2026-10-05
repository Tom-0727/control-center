import { z } from "zod";

export const providerSchema = z.enum(["claude", "codex"]);
export type Provider = z.infer<typeof providerSchema>;

export const decisionKindSchema = z.enum(["question", "interrupt", "denied", "memory", "memory-index"]);
export type DecisionKind = z.infer<typeof decisionKindSchema>;

export const decisionSchema = z.object({
  id: z.string(),
  at: z.string(),
  kind: decisionKindSchema,
  excerpt: z.string(),
  answer: z.string().nullable(),
  next: z.string().nullable(),
  detail: z.string().nullable(),
});
export type Decision = z.infer<typeof decisionSchema>;

export const spanSchema = z.object({ kind: z.enum(["run", "wait"]), start: z.string(), end: z.string() });
export type Span = z.infer<typeof spanSchema>;

export const originSchema = z.enum(["human", "scheduled", "other"]);
export type Origin = z.infer<typeof originSchema>;

/** How automation started the session; null when only a person could have started it. */
export const launcherSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("schedule"), id: z.string(), name: z.string() }),
  z.object({ kind: z.literal("agent"), id: z.string() }),
]).nullable();
export type Launcher = z.infer<typeof launcherSchema>;

export const sessionCardSchema = z.object({
  id: z.string(),
  sourceId: z.string().optional(),
  nodeId: z.string().optional(),
  nodeName: z.string().optional(),
  provider: providerSchema,
  title: z.string(),
  /** First and last activity inside the selected range. */
  startedAt: z.string(),
  endedAt: z.string(),
  /** Bounds of the whole session, which may start before or end after the range. */
  sessionStartedAt: z.string(),
  sessionEndedAt: z.string(),
  continued: z.boolean(),
  activeMs: z.number(),
  waitMs: z.number(),
  userMessages: z.number(),
  userMessagesTotal: z.number(),
  agentId: z.string().nullable(),
  projectId: z.string().nullable(),
  /** human: a person spoke; scheduled: a Paseo schedule ran it and nobody joined; other: nobody spoke and no schedule. */
  origin: originSchema,
  launcher: launcherSchema,
  branch: z.string().nullable(),
  cwd: z.string(),
  forkedFrom: z.string().nullable(),
  depth: z.number(),
  hiddenThreads: z.number(),
  spans: z.array(spanSchema),
  decisions: z.array(decisionSchema),
  error: z.string().nullable(),
  warning: z.string().optional(),
  file: z.string(),
});
export type SessionCard = z.infer<typeof sessionCardSchema>;

export const overviewSchema = z.object({
  sessions: z.number(),
  peakParallel: z.number(),
  activeMs: z.number(),
  waitMs: z.number(),
  decisions: z.number(),
  unparsable: z.number(),
});
export type Overview = z.infer<typeof overviewSchema>;

export const rangeSchema = z.object({
  kind: z.enum(["today", "yesterday", "last7", "custom"]),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export type Range = z.infer<typeof rangeSchema>;

export const scopeSchema = z.object({
  nodeIds: z.array(z.string()).min(1).optional(),
  workspaces: z.record(z.string(), z.string()).optional(),
  projectId: z.string().nullable().optional(),
  /** Absent: sessions of every origin. */
  origin: originSchema.optional(),
  range: rangeSchema,
});
export type Scope = z.infer<typeof scopeSchema>;

export const originsSchema = z.object({
  human: z.number(), scheduled: z.number(), other: z.number(),
  /** Scheduled sessions per schedule name, largest first. */
  schedules: z.array(z.object({ name: z.string(), sessions: z.number() })),
});
export type Origins = z.infer<typeof originsSchema>;

export const projectSchema = z.object({ id: z.string(), name: z.string(), rootPath: z.string(), nodeId: z.string().optional() });
export const nodeSchema = z.object({
  id: z.string(), name: z.string(),
  status: z.enum(["pending", "running", "succeeded", "offline", "failed", "needs_workspace"]),
  error: z.string().optional(), sessions: z.number().optional(),
  cachedAt: z.string().optional(),
  workspaces: z.array(z.object({ workspaceId: z.string(), name: z.string() })).optional(),
});
export type NodeStatus = z.infer<typeof nodeSchema>;

export const reviewResultSchema = z.object({
  scope: scopeSchema,
  from: z.string(),
  to: z.string(),
  timezone: z.string(),
  generatedAt: z.string(),
  overview: overviewSchema,
  sessions: z.array(sessionCardSchema),
  nodes: z.array(nodeSchema).optional(),
  projects: z.array(projectSchema).optional(),
  complete: z.boolean().optional(),
  /** Counts of the node and project selection before the origin filter; set when a snapshot is read. */
  origins: originsSchema.optional(),
  /** Non-fatal condition of this scan, e.g. the node registry could not be read. */
  warning: z.string().optional(),
});
export type ReviewResult = z.infer<typeof reviewResultSchema>;

export const messageSchema = z.object({ at: z.string(), role: z.enum(["user", "assistant", "system"]), text: z.string() });
export type Message = z.infer<typeof messageSchema>;

export const sessionDetailSchema = z.object({
  id: z.string(),
  provider: providerSchema,
  title: z.string(),
  cwd: z.string(),
  file: z.string(),
  messages: z.array(messageSchema),
  decisions: z.array(decisionSchema),
  totalMessages: z.number().optional(),
  nextOffset: z.number().nullable().optional(),
});
export type SessionDetail = z.infer<typeof sessionDetailSchema>;

export const progressSchema = z.object({ phase: z.string(), done: z.number(), total: z.number(), nodes: z.array(nodeSchema).optional() });
export type Progress = z.infer<typeof progressSchema>;

export const TITLE_MAX = 60;
export const EXCERPT_MAX = 100;
export const MESSAGE_MAX = 2000;
export const SESSION_LIMIT = 200;
