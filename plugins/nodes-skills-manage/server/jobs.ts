import { randomUUID } from "node:crypto";
import { progressSchema, resultSchema, type Job, type Start } from "../shared/contracts.ts";
import type { Runner } from "./runner.ts";

const TTL = 60 * 60_000;
export class Jobs {
  private entries = new Map<string, {job: Job; raw?: unknown; abort: AbortController}>();
  private disposed = false;
  private runner: Runner;
  constructor(runner: Runner) { this.runner = runner; }

  list(): Job[] {
    const completed = [...this.entries.values()].filter(e => e.job.status !== "running");
    for (const [index, entry] of completed.entries()) {
      if (Date.now() - Date.parse(entry.job.updatedAt) > TTL || index < completed.length - 20) this.entries.delete(entry.job.id);
    }
    return [...this.entries.values()].map(e => structuredClone(e.job));
  }

  start(input: Start): Job {
    if (this.disposed) throw new Error("插件正在停止，请重新连接");
    this.list();
    let request: Record<string, unknown> = {node_ids: input.nodeIds, workspaces: input.workspaces};
    let preview: {job: Job; raw?: unknown} | undefined;
    if (input.action === "apply-update") {
      preview = input.previewId ? this.entries.get(input.previewId) : undefined;
      if (!preview || preview.job.action !== "check-update" || preview.job.status !== "succeeded") throw new Error("检查结果已失效，请重新检查更新");
      if (preview.job.appliedBy) {
        const prior = this.entries.get(preview.job.appliedBy);
        if (prior) return structuredClone(prior.job);
        throw new Error("此检查结果已使用，请重新检查更新");
      }
      request = {preview: preview.raw};
    }
    if ([...this.entries.values()].some(e => e.job.status === "running")) throw new Error("已有任务正在运行，请等待完成");
    const time = new Date().toISOString();
    const job: Job = {id: randomUUID(), action: input.action, status: "running", createdAt: time, updatedAt: time, progress: []};
    const entry = {job, abort: new AbortController(), raw: undefined as unknown};
    this.entries.set(job.id, entry);
    if (preview) preview.job.appliedBy = job.id;
    void this.runner(input.action, request, value => {
      const parsed = progressSchema.safeParse(value);
      if (!parsed.success) return;
      const index = job.progress.findIndex(p => p.node_id === parsed.data.node_id);
      if (index < 0) job.progress.push(parsed.data); else job.progress[index] = parsed.data;
      job.updatedAt = new Date().toISOString();
    }, entry.abort.signal).then(raw => {
      job.result = resultSchema.parse(raw);
      entry.raw = raw;
      job.status = "succeeded";
    }).catch(error => { job.status = "failed"; job.error = error instanceof Error ? error.message : String(error); })
      .finally(() => { job.updatedAt = new Date().toISOString(); });
    return structuredClone(job);
  }

  dispose() { this.disposed = true; for (const entry of this.entries.values()) entry.abort.abort(); }
}
