import { test } from "node:test";
import assert from "node:assert/strict";
import { Jobs } from "../server/jobs.ts";
import type { Runner } from "../server/runner.ts";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
test("confirmations use the server receipt and duplicate clicks return one job", async () => {
  const calls: Array<{action: string; input: Record<string, unknown>}> = [];
  const raw = {revision: "a".repeat(64), base_fingerprint: "private-receipt",
    skills: {example: {digest: "hash", source: "team", revision: "b".repeat(40)}}, changes: []};
  const runner: Runner = async (action, input) => { calls.push({action, input}); return action === "check-update" ? raw : {changed: true}; };
  const jobs = new Jobs(runner);
  const check = jobs.start({action: "check-update"});
  await tick();
  assert.equal(jobs.list()[0].status, "succeeded");
  assert.ok(!("base_fingerprint" in jobs.list()[0].result!));
  assert.equal(jobs.list()[0].result!.revision, raw.revision);
  const applied = jobs.start({action: "apply-update", previewId: check.id});
  const duplicate = jobs.start({action: "apply-update", previewId: check.id});
  assert.equal(duplicate.id, applied.id);
  await tick();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].input, {preview: raw});
  assert.equal(jobs.start({action: "apply-update", previewId: check.id}).id, applied.id);
});

test("update needs a finished check; sync starts directly on the chosen nodes", async () => {
  const calls: Array<{action: string; input: Record<string, unknown>}> = [];
  const jobs = new Jobs(async (action, input) => { calls.push({action, input}); return {nodes: [{id: "a", name: "A", status: "conflict"}]}; });
  assert.throws(() => jobs.start({action: "apply-update", previewId: "unknown"}), /检查结果已失效/);
  const scan = jobs.start({action: "refresh"}); await tick();
  assert.throws(() => jobs.start({action: "apply-update", previewId: scan.id}), /检查结果已失效/);
  const sync = jobs.start({action: "sync", nodeIds: ["a"], workspaces: {a: "w"}}); await tick();
  assert.deepEqual(calls.at(-1), {action: "sync", input: {node_ids: ["a"], workspaces: {a: "w"}}});
  assert.equal(jobs.list().find(j => j.id === sync.id)!.result!.nodes![0].status, "conflict");
});

test("background job exposes bounded per-node progress and survives readers leaving", async () => {
  let finish!: (value: unknown) => void;
  const jobs = new Jobs(async (_action, _input, progress) => {
    progress({phase: "transferring", node_id: "a", bytes: 1, total_bytes: 10});
    progress({phase: "transferring", node_id: "a", bytes: 8, total_bytes: 10});
    return new Promise(resolve => { finish = resolve; });
  });
  jobs.start({action: "refresh"});
  assert.equal(jobs.list()[0].progress.length, 1);
  assert.equal(jobs.list()[0].progress[0].bytes, 8);
  assert.throws(() => jobs.start({action: "refresh"}), /已有任务/);
  const copied = jobs.list(); copied[0].progress[0].bytes = 100;
  assert.equal(jobs.list()[0].progress[0].bytes, 8);
  finish({nodes: []}); await tick();
  assert.equal(jobs.list()[0].status, "succeeded");
});

test("failed apply is not silently replayed; reload disposes owned work", async () => {
  const jobs = new Jobs(async action => {
    if (action === "check-update") return {changes: []};
    throw new Error("connection lost: refresh first");
  });
  const check = jobs.start({action: "check-update"}); await tick();
  const apply = jobs.start({action: "apply-update", previewId: check.id}); await tick();
  assert.equal(jobs.list()[1].status, "failed");
  assert.equal(jobs.start({action: "apply-update", previewId: check.id}).id, apply.id);
  let aborted = false;
  const stopping = new Jobs(async (_action, _input, _progress, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(new Error("stopped")); });
  }));
  stopping.start({action: "refresh"}); stopping.dispose(); await tick();
  assert.equal(aborted, true);
  assert.equal(stopping.list()[0].status, "failed");
  assert.throws(() => stopping.start({action: "refresh"}), /停止/);
});

test("partial completion is preserved and completed job retention is bounded", async () => {
  const jobs = new Jobs(async () => ({complete: false, nodes: [{id: "a", name: "A", status: "verified"}, {id: "b", name: "B", status: "error"}]}));
  for (let i = 0; i < 24; i++) { jobs.start({action: "refresh"}); await tick(); }
  assert.equal(jobs.list().length, 20);
  assert.equal(jobs.list().at(-1)!.result!.complete, false);
});

test("source specs follow the controller's source entry rules", async () => {
  const { sourceSpecSchema } = await import("../shared/contracts.ts");
  assert.ok(sourceSpecSchema.safeParse({id: "vendor", type: "well-known", url: "https://example.com", skills: "*"}).success);
  assert.ok(sourceSpecSchema.safeParse({id: "team", type: "git", url: "https://github.com/o/r.git", ref: "main",
    path: "skills", skills: ["review"]}).success);
  for (const bad of [{id: "Bad", type: "git", url: "https://x", skills: "*"},
                     {id: "x", type: "svn", url: "https://x", skills: "*"},
                     {id: "x", type: "git", url: "https://x", skills: []}]) {
    assert.equal(sourceSpecSchema.safeParse(bad).success, false);
  }
});
