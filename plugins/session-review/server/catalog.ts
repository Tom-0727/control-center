import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Launcher, Origin } from "../shared/model.ts";
import { isUnder } from "./paths.ts";

export interface ProjectInfo { id: string; name: string; rootPath: string; archived: boolean }
export interface WorkspaceInfo { id: string; projectId: string; name: string; cwd: string; archived: boolean }
export interface AgentLink { agentId: string; workspaceId: string | null; provider: string; cwd: string; launcher: Launcher }

/** Paseo labels an agent with the schedule that ran it, or with the agent that delegated to it. */
const SCHEDULE_LABEL = "paseo.schedule-id";
const PARENT_AGENT_LABEL = "paseo.parent-agent-id";

function label(labels: unknown, key: string): string | null {
  const value = (labels as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export interface Catalog {
  projects: ProjectInfo[];
  workspaces: WorkspaceInfo[];
  /** provider session id → Paseo agent */
  agents: Map<string, AgentLink>;
}

async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return fallback; }
}

/** Reads the daemon home's own registry files; Paseo 0.9.2 keeps the provider session id only there. */
export async function loadCatalog(paseoHome: string): Promise<Catalog> {
  type RawProject = { projectId: string; rootPath: string; displayName?: string; customName?: string | null; archivedAt?: string | null };
  type RawWorkspace = { workspaceId: string; projectId: string; cwd: string; displayName?: string; title?: string | null; archivedAt?: string | null };
  const rawProjects = await readJsonFile<RawProject[]>(join(paseoHome, "projects", "projects.json"), []);
  const rawWorkspaces = await readJsonFile<RawWorkspace[]>(join(paseoHome, "projects", "workspaces.json"), []);
  const projects = rawProjects.map((p) => ({ id: p.projectId, name: p.customName || p.displayName || p.rootPath, rootPath: p.rootPath, archived: !!p.archivedAt }));
  const workspaces = rawWorkspaces.map((w) => ({ id: w.workspaceId, projectId: w.projectId, name: w.title || w.displayName || w.cwd, cwd: w.cwd, archived: !!w.archivedAt }));

  // Schedule names live next to the agents; a deleted schedule leaves runs that only know its id.
  const schedules = new Map<string, string>();
  let scheduleFiles: string[] = [];
  try { scheduleFiles = await readdir(join(paseoHome, "schedules")); } catch { scheduleFiles = []; }
  for (const file of scheduleFiles) {
    if (!file.endsWith(".json")) continue;
    const record = await readJsonFile<{ id?: unknown; name?: unknown } | null>(join(paseoHome, "schedules", file), null);
    const id = typeof record?.id === "string" && record.id ? record.id : file.replace(/\.json$/, "");
    schedules.set(id, typeof record?.name === "string" && record.name.trim() ? record.name.trim() : id);
  }

  const agents = new Map<string, AgentLink>();
  const agentsDir = join(paseoHome, "agents");
  let groups: string[] = [];
  try { groups = await readdir(agentsDir); } catch { groups = []; }
  for (const group of groups) {
    const dir = join(agentsDir, group);
    let files: string[] = [];
    try { files = await readdir(dir); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const record = await readJsonFile<Record<string, unknown> | null>(join(dir, file), null);
      if (!record) continue;
      const persistence = (record.persistence ?? {}) as Record<string, unknown>;
      const sessionId = typeof persistence.sessionId === "string" ? persistence.sessionId : null;
      if (!sessionId) continue;
      const scheduleId = label(record.labels, SCHEDULE_LABEL), parentId = label(record.labels, PARENT_AGENT_LABEL);
      agents.set(sessionId, {
        agentId: String(record.id ?? file.replace(/\.json$/, "")),
        workspaceId: typeof record.workspaceId === "string" ? record.workspaceId : null,
        provider: String(record.provider ?? ""),
        cwd: String(record.cwd ?? ""),
        launcher: scheduleId ? { kind: "schedule", id: scheduleId, name: schedules.get(scheduleId) ?? scheduleId }
          : parentId ? { kind: "agent", id: parentId } : null,
      });
    }
  }
  return { projects, workspaces, agents };
}

export interface Attribution { agentId: string | null; projectId: string | null; launcher: Launcher }

/** A Paseo agent record wins; otherwise the session belongs to the project whose root contains its cwd. */
export function attribute(catalog: Catalog, sessionId: string, cwd: string): Attribution {
  const link = catalog.agents.get(sessionId);
  if (link) {
    const workspace = link.workspaceId ? catalog.workspaces.find((w) => w.id === link.workspaceId) : undefined;
    return { agentId: link.agentId, projectId: workspace?.projectId ?? projectFor(catalog, cwd), launcher: link.launcher };
  }
  return { agentId: null, projectId: projectFor(catalog, cwd), launcher: null };
}

/**
 * One rule: an automated launch's first prompt is not a person, so anyone speaking after it makes the session
 * theirs; when nobody spoke, a schedule's run is "scheduled" and anything else is "other".
 */
export function classify(launcher: Launcher, userMessages: number): Origin {
  if (userMessages - (launcher ? 1 : 0) > 0) return "human";
  return launcher?.kind === "schedule" ? "scheduled" : "other";
}

function projectFor(catalog: Catalog, cwd: string): string | null {
  const ordered = [...catalog.projects].sort((a, b) => b.rootPath.length - a.rootPath.length);
  return ordered.find((p) => isUnder(cwd, p.rootPath))?.id ?? null;
}

export function inScope(attribution: Attribution, scope: { projectId?: string | null }): boolean {
  return !scope.projectId || attribution.projectId === scope.projectId;
}
