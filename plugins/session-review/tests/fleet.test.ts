import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { makeHomes } from "./fixtures.ts";
import { Store } from "../server/store.ts";
import { Fleet, chooseWorkspace, projectKey } from "../server/fleet.ts";
import type { NodeTarget } from "../server/gateway.ts";
import type { Gateway } from "../server/gateway.ts";
import { runReview, sessionDetail } from "../server/review.ts";
import { calendarBounds } from "../shared/time.ts";

test("fleet: identical IDs stay separate, offline node yields partial results and detail routes to its source", async () => {
  const h = await makeHomes();
  const store = new Store(join(h.paseoHome, "session-review")); await store.init();
  const deps = { homes: { ...h, dataDir: store.dataDir }, store, now: () => new Date("2026-09-30T12:00:00Z") };
  const calls: Array<{ node: string; input: Record<string, any> }> = [];
  const gateway: Gateway = {
    nodes: async () => [{ id: "local", name: "中控" }, { id: "remote", name: "远端" }, { id: "offline", name: "不可达" }],
    workspaces: async n => { if (n.id === "offline") throw new Error("Cannot connect to daemon"); return [{ workspaceId: "w1", name: "环境运维" }]; },
    collect: async (n, _w, input: Record<string, any>) => {
      calls.push({ node: n.id, input });
      if (input.action === "detail") return sessionDetail(input.provider, input.id, store, input.offset);
      const r = await runReview(input.scope, { ...deps, bounds: input.bounds }, () => {});
      r.projects = [{ id: "prj_1", name: "同名项目", rootPath: "/workspace" }];
      return r;
    },
  };
  try {
    const fleet = new Fleet(gateway, deps, { id: "local", name: "中控" }, { timezone: () => "Asia/Singapore" });
    const progress: string[] = [];
    const result = await fleet.review({ range: { kind: "today" } }, p => progress.push(p.nodes?.find(n => n.id === "remote")?.status ?? ""));
    assert.equal(result.sessions.length, 6);
    assert.equal(new Set(result.sessions.map(s => s.id)).size, 6);
    assert.equal(new Set(result.projects?.map(p => p.id)).size, 2);
    assert.equal(result.complete, false);
    assert.equal(result.nodes?.find(n => n.id === "offline")?.status, "offline");
    assert.ok(progress.includes("running")); assert.ok(progress.includes("succeeded"));
    assert.equal(Date.parse(calls[0].input.bounds.from), Date.parse("2026-09-30T00:00:00.000+08:00"));
    assert.equal(result.timezone, "Asia/Singapore");
    assert.ok(result.sessions.every(s => s.origin === "human" && s.launcher === null), "cards keep their origin through the remote schema");
    const session = result.sessions.find(s => s.nodeId === "remote" && s.provider === "claude")!;
    await fleet.detail(session.nodeId, session.provider, session.sourceId!, 0);
    assert.equal(calls.at(-1)?.node, "remote"); assert.equal(calls.at(-1)?.input.id, "c1");
    const filtered = await fleet.review({ range: { kind: "today" }, projectId: projectKey("remote", "prj_1") }, () => {});
    assert.equal(filtered.nodes?.length, 1); assert.equal(filtered.sessions.length, 3);
    assert.equal(filtered.complete, true);
  } finally { await rm(h.root, { recursive: true, force: true }); }
});

test("workspace selection never guesses between unrelated workspaces", () => {
  const rows = [{ workspaceId: "a", name: "项目 A" }, { workspaceId: "b", name: "项目 B" }];
  assert.equal(chooseWorkspace(rows), undefined);
  assert.equal(chooseWorkspace(rows, "b"), "b");
  assert.throws(() => chooseWorkspace(rows, "missing"));
  assert.equal(chooseWorkspace([...rows, { workspaceId: "ops", name: "环境运维" }]), "ops");
});

test("review timezone dates ignore host timezone", () => {
  const bounds = calendarBounds({ kind: "today" }, "Asia/Singapore", new Date("2026-10-01T16:30:00Z"));
  assert.equal(bounds.fromKey, "2026-10-02");
  assert.equal(new Date(bounds.from).toISOString(), "2026-10-01T16:00:00.000Z");
  assert.throws(() => calendarBounds({ kind: "custom", from: "2026-02-30" }, "Asia/Singapore"));
});

test("fleet: this machine is reviewed with no registry, and a registry that fails to load only adds a warning", async () => {
  const h = await makeHomes();
  const store = new Store(join(h.paseoHome, "session-review")); await store.init();
  const deps = { homes: { ...h, dataDir: store.dataDir }, store, now: () => new Date("2026-09-30T12:00:00Z") };
  const local: NodeTarget = { id: "srv_local", name: "macbook" };
  const unused = () => { throw new Error("no remote collection expected"); };
  try {
    // No registry: the gateway lists only this machine.
    const alone = new Fleet({ nodes: async () => [local], registry: async () => ({ status: "none", message: "未配置节点清单，只复盘本机" }), workspaces: unused, collect: unused }, deps, local, { timezone: () => "Asia/Singapore", warnings: () => ["配置提示"] });
    const result = await alone.review({ range: { kind: "today" } }, () => {});
    assert.equal(result.nodes?.length, 1); assert.equal(result.nodes?.[0].id, "srv_local"); assert.equal(result.nodes?.[0].status, "succeeded");
    assert.equal(result.sessions.length, 3); assert.ok(result.sessions.every(s => s.nodeId === "srv_local" && s.nodeName === "macbook"));
    assert.equal(result.complete, true); assert.equal(result.warning, undefined);
    const catalog = await alone.catalog();
    assert.deepEqual(catalog.local, local); assert.equal(catalog.registry?.status, "none"); assert.deepEqual(catalog.warnings, ["配置提示"]);
    assert.equal(catalog.projects[0].nodeId, "srv_local");
    const detail = await alone.detail("srv_local", "claude", "c1", 0);
    assert.equal(detail.id, "c1");

    // Registry configured but unreadable: local results still come back, with the reason attached.
    const broken = new Fleet({ nodes: async () => { throw new Error("找不到 node.sh"); }, workspaces: unused, collect: unused }, deps, local, { timezone: () => "Asia/Singapore" });
    const partial = await broken.review({ range: { kind: "today" } }, () => {});
    assert.equal(partial.sessions.length, 3); assert.match(partial.warning!, /只复盘本机.*node\.sh/);
    assert.equal(partial.complete, true);

    // A registry that omits this machine still gets it prepended.
    const remoteOnly = new Fleet({ nodes: async () => [{ id: "srv_remote", name: "vm" }], workspaces: async () => { throw new Error("Cannot connect"); }, collect: unused }, deps, local, { timezone: () => "Asia/Singapore" });
    const merged = await remoteOnly.review({ range: { kind: "today" } }, () => {});
    assert.deepEqual(merged.nodes?.map(n => [n.id, n.status]), [["srv_local", "succeeded"], ["srv_remote", "offline"]]);
    assert.equal(merged.complete, false);
  } finally { await rm(h.root, { recursive: true, force: true }); }
});
