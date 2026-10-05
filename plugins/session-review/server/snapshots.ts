import { z } from "zod";
import { catalogSchema, type ReviewCatalog } from "../shared/contracts.ts";
import { rangeSchema, reviewResultSchema, SESSION_LIMIT, type Origins, type Progress, type Range, type ReviewResult, type Scope, type SessionCard } from "../shared/model.ts";
import { calendarBounds } from "../shared/time.ts";
import type { Fleet } from "./fleet.ts";
import { redactText } from "./redact.ts";
import { peakParallel, unionRunMs } from "./spans.ts";
import { EXTRACT_VERSION, type Store } from "./store.ts";

export const REFRESH_MS = 5 * 60_000;
/** Bump when the stored card shape changes; snapshots of another version are rebuilt silently. */
export const DISK_VERSION = 2;
const PRESETS: Range[] = [{ kind: "today" }, { kind: "yesterday" }, { kind: "last7" }];
const diskSchema = z.object({
  version: z.literal(DISK_VERSION), extractVersion: z.literal(EXTRACT_VERSION),
  catalog: catalogSchema.optional(), results: z.array(reviewResultSchema),
  customRanges: z.array(rangeSchema), workspaces: z.record(z.string(), z.string()),
});
interface Entry { result?: ReviewResult; error?: string; progress?: Progress }
type Source = Pick<Fleet, "catalog" | "review">;

function overview(sessions: ReviewResult["sessions"]): ReviewResult["overview"] {
  const spans = sessions.map(s => s.spans);
  return { sessions: sessions.length, peakParallel: peakParallel(spans), activeMs: unionRunMs(spans),
    waitMs: sessions.reduce((n, s) => n + s.waitMs, 0), decisions: sessions.reduce((n, s) => n + s.decisions.length, 0),
    unparsable: sessions.filter(s => s.error).length };
}

/** Keep each unavailable node's last successful data for this exact date range. */
function retainOffline(fresh: ReviewResult, previous?: ReviewResult): ReviewResult {
  const nodes = (fresh.nodes ?? []).map(n => {
    const old = previous?.nodes?.find(p => p.id === n.id);
    return { ...n, cachedAt: n.status === "succeeded" ? fresh.generatedAt : old?.cachedAt };
  });
  const staleIds = new Set(nodes.filter(n => n.status !== "succeeded" && n.cachedAt).map(n => n.id));
  const sessions = [...fresh.sessions, ...(previous?.sessions ?? []).filter(s => staleIds.has(s.nodeId!))];
  const projects = [...(fresh.projects ?? []), ...(previous?.projects ?? []).filter(p => staleIds.has(p.nodeId!))];
  return { ...fresh, nodes, sessions, projects, overview: overview(sessions),
    generatedAt: nodes.some(n => n.status === "succeeded") ? fresh.generatedAt : previous?.generatedAt ?? fresh.generatedAt };
}

/** Counts per origin, with scheduled sessions broken down by schedule name. */
export function countOrigins(sessions: SessionCard[]): Origins {
  const counts = { human: 0, scheduled: 0, other: 0 };
  const schedules = new Map<string, number>();
  for (const s of sessions) {
    counts[s.origin] += 1;
    if (s.origin === "scheduled" && s.launcher?.kind === "schedule") schedules.set(s.launcher.name, (schedules.get(s.launcher.name) ?? 0) + 1);
  }
  return { ...counts, schedules: [...schedules].map(([name, n]) => ({ name, sessions: n })).sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name)) };
}

export function filterSnapshot(result: ReviewResult, scope: Scope): ReviewResult {
  const knownNodes = new Set(result.nodes?.map(n => n.id));
  if (scope.nodeIds?.some(id => !knownNodes.has(id))) throw new Error("节点清单已变更，请重新选择节点");
  let projectNode: string | undefined;
  if (scope.projectId) {
    let project: unknown;
    try { project = JSON.parse(scope.projectId); } catch { /* Invalid selection below. */ }
    if (!Array.isArray(project) || project.length !== 2 || project.some(p => typeof p !== "string") || !knownNodes.has(project[0])) throw new Error("项目选择已过期，请重新选择");
    projectNode = project[0];
  }
  const selected = (nodeId?: string) => !scope.nodeIds || scope.nodeIds.includes(nodeId!);
  const scoped = result.sessions.filter(s => selected(s.nodeId) && (!scope.projectId || s.projectId === scope.projectId));
  // The page shows what each origin would contain, so hiding is never silent.
  const origins = countOrigins(scoped);
  const sessions = scope.origin ? scoped.filter(s => s.origin === scope.origin) : scoped;
  const projects = (result.projects ?? []).filter(p => selected(p.nodeId));
  const nodes = (result.nodes ?? []).filter(n => selected(n.id) && (!scope.projectId || n.id === projectNode)).map(n => ({
    ...n, sessions: sessions.filter(s => s.nodeId === n.id).length,
  }));
  if (nodes.some(n => n.sessions > SESSION_LIMIT)) throw new Error(`范围内单个节点超过 ${SESSION_LIMIT} 个会话，请收窄日期范围或项目`);
  return { ...result, scope, sessions, nodes, projects, origins, overview: overview(sessions), complete: nodes.every(n => n.status === "succeeded") };
}

/** One daemon-owned scheduler; page reads never wait for node connections. */
export class Snapshots {
  private store: Store;
  private source: Source;
  private now: () => Date;
  private timezone: () => string;
  private entries = new Map<string, Entry>();
  private pending = new Set<string>();
  private customRanges: Range[] = [];
  private workspaces: Record<string, string> = {};
  private savedCatalog?: ReviewCatalog;
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private current?: string;
  private writes: Promise<void> = Promise.resolve();
  private storageError?: string;
  private abort = new AbortController();
  /** Bumped by reset(); a scan started under an older generation discards its result. */
  private generation = 0;

  constructor(store: Store, source: Source, now = () => new Date(), timezone: () => string) {
    this.store = store; this.source = source; this.now = now; this.timezone = timezone;
  }

  async init(): Promise<void> {
    try {
      const raw = await this.store.readSnapshots();
      // Another version's snapshot is rebuilt without complaint; only a damaged file of this version is reported.
      if (raw && (raw as { version?: unknown }).version === DISK_VERSION) {
        const saved = diskSchema.parse(raw);
        const tz = this.timezone();
        this.savedCatalog = saved.catalog; this.customRanges = saved.customRanges.slice(-8); this.workspaces = saved.workspaces;
        // Calendar days only mean the same thing under the timezone they were computed in.
        for (const result of saved.results.filter(r => r.timezone === tz).slice(-32)) this.entries.set(`${result.from}/${result.to}`, { result });
      }
    } catch { this.storageError = "本地快照无法读取，正在重新采集"; }
    if (this.abort.signal.aborted) return;
    this.timer = setInterval(() => { void this.refresh(); }, REFRESH_MS);
    this.timer.unref();
    void this.refresh();
  }

  catalog(): ReviewCatalog {
    const projects = new Map((this.savedCatalog?.projects ?? []).map(p => [p.id, p]));
    for (const entry of this.entries.values()) for (const p of entry.result?.projects ?? []) projects.set(p.id, p);
    return { projects: [...projects.values()], nodes: this.savedCatalog?.nodes ?? [], workspaces: this.savedCatalog?.workspaces ?? [],
      local: this.savedCatalog?.local, registry: this.savedCatalog?.registry, warnings: this.savedCatalog?.warnings,
      timezone: this.timezone(), today: calendarBounds({ kind: "today" }, this.timezone(), this.now()).fromKey, dataDir: this.store.dataDir };
  }

  private key(range: Range): string {
    const b = calendarBounds(range, this.timezone(), this.now()); return `${b.fromKey}/${b.toKey}`;
  }

  private enqueue(range: Range): void {
    const key = this.key(range);
    if (!this.entries.has(key)) this.entries.set(key, {});
    if (this.current !== key) this.pending.add(key);
  }

  read(scope: Scope) {
    const key = this.key(scope.range);
    if (this.abort.signal.aborted) throw new Error("插件正在停止，请重新连接");
    let changed = false;
    for (const [id, workspace] of Object.entries(scope.workspaces ?? {})) {
      if (workspace && this.workspaces[id] !== workspace) { this.workspaces[id] = workspace; changed = true; }
    }
    if (scope.range.kind === "custom" && !this.customRanges.some(r => this.key(r) === key)) {
      const [from, to] = key.split("/");
      this.customRanges = [...this.customRanges, { kind: "custom" as const, from, to }].slice(-8);
    }
    if (!this.entries.has(key) || changed) { this.enqueue(scope.range); void this.pump(); }
    const entry = this.entries.get(key)!;
    return { result: entry.result ? filterSnapshot(entry.result, scope) : undefined,
      refreshing: this.current === key || this.pending.has(key), progress: entry.progress, error: entry.error ?? this.storageError };
  }

  refresh(scope?: Scope): Promise<void> {
    if (this.abort.signal.aborted) return Promise.resolve();
    if (scope) this.read(scope);
    // A slow sweep or repeated clicks share the current worker, without a growing queue.
    if (this.running) return this.running;
    for (const range of [...PRESETS, ...this.customRanges]) this.enqueue(range);
    return this.pump();
  }

  /** Settings changed the calendar: forget every range and start over, keeping custom ranges and workspace choices. */
  reset(): Promise<void> {
    this.generation++;
    this.entries.clear(); this.pending.clear(); this.current = undefined;
    if (this.abort.signal.aborted) return Promise.resolve();
    if (this.running) return this.running.then(() => this.refresh());
    return this.refresh();
  }

  private save(): Promise<void> {
    this.writes = this.writes.then(async () => {
      await this.store.writeSnapshots({ version: DISK_VERSION, extractVersion: EXTRACT_VERSION, catalog: this.savedCatalog,
        results: [...this.entries.values()].flatMap(e => e.result ? [e.result] : []).slice(-32),
        customRanges: this.customRanges, workspaces: this.workspaces });
      this.storageError = undefined;
    }).catch(() => { this.storageError = "本地快照保存失败，当前结果仍可查看，重启后需重新采集"; });
    return this.writes;
  }

  private pump(): Promise<void> {
    if (this.running) return this.running;
    if (this.abort.signal.aborted) return Promise.resolve();
    this.running = Promise.resolve().then(async () => {
      try { this.savedCatalog = await this.source.catalog(this.abort.signal); } catch { /* Keep the saved catalog while offline. */ }
      while (this.pending.size && !this.abort.signal.aborted) {
        const generation = this.generation;
        const [key] = this.pending.keys();
        this.pending.delete(key); this.current = key;
        const entry = this.entries.get(key)!;
        const [from, to] = key.split("/");
        entry.error = undefined;
        try {
          const result = await this.source.review({ range: { kind: "custom", from, to }, workspaces: { ...this.workspaces } },
            p => { entry.progress = p; }, this.abort.signal, true);
          if (this.abort.signal.aborted) break;
          if (generation !== this.generation) continue;
          entry.result = retainOffline(result, entry.result);
          this.entries.delete(key); this.entries.set(key, entry);
        } catch (error) {
          if (this.abort.signal.aborted) break;
          if (generation !== this.generation) continue;
          entry.error = redactText(error instanceof Error ? error.message : String(error));
        }
        entry.progress = undefined;
        await this.save();
      }
      // Bound historical in-memory snapshots as well as the persisted file.
      for (const key of [...this.entries.keys()].slice(0, Math.max(0, this.entries.size - 32))) this.entries.delete(key);
    }).finally(() => { this.current = undefined; this.running = undefined; });
    return this.running;
  }

  dispose(): void { clearInterval(this.timer); this.abort.abort(); this.pending.clear(); }
}
