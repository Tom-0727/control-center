import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewResult, Scope, SessionCard } from "../shared/model.ts";
import { calendarBounds } from "../shared/time.ts";
import { projectKey, type Fleet } from "../server/fleet.ts";
import { DISK_VERSION, REFRESH_MS, Snapshots, filterSnapshot } from "../server/snapshots.ts";
import { Store } from "../server/store.ts";

const TODAY: Scope = { range: { kind: "today" } };
const INITIAL = new Date("2026-10-03T04:00:00Z");
const TZ = "Asia/Singapore";
function card(nodeId: string, projectId = projectKey(nodeId, nodeId)): SessionCard {
  return { id: `${nodeId}-s`, sourceId: "s", nodeId, nodeName: nodeId, provider: "claude", title: "Synthetic session",
    startedAt: INITIAL.toISOString(), endedAt: INITIAL.toISOString(), sessionStartedAt: INITIAL.toISOString(), sessionEndedAt: INITIAL.toISOString(),
    continued: false, activeMs: 0, waitMs: 0, userMessages: 1, userMessagesTotal: 1, agentId: null, projectId, origin: "human", launcher: null,
    branch: null, cwd: "/synthetic", forkedFrom: null, depth: 0, hiddenThreads: 0, spans: [], decisions: [], error: null, file: "/synthetic/s.jsonl" };
}
function result(scope: Scope, at = INITIAL, tz = TZ): ReviewResult {
  const bounds = calendarBounds(scope.range, tz, at);
  return { scope, from: bounds.fromKey, to: bounds.toKey, timezone: tz, generatedAt: at.toISOString(),
    sessions: [card("a"), card("b")], projects: ["a", "b"].map(id => ({ id: projectKey(id, id), nodeId: id, name: "同名项目", rootPath: "/synthetic" })),
    nodes: ["a", "b"].map(id => ({ id, name: id, status: "succeeded", sessions: 1 })), complete: true,
    overview: { sessions: 2, peakParallel: 0, activeMs: 0, waitMs: 0, decisions: 0, unparsable: 0 } };
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "review-snapshots-"));
  const store = new Store(root); await store.init();
  let now = INITIAL, tz = TZ, calls = 0, catalogCalls = 0;
  let scan: Pick<Fleet, "review">["review"] = async scope => result(scope, now, tz);
  const source: Pick<Fleet, "catalog" | "review"> = {
    catalog: async () => { catalogCalls++; return { nodes: [], projects: [], workspaces: [], today: "2026-10-03", timezone: tz, dataDir: root }; },
    review: async (...args) => { calls++; assert.equal(args[3], true); return scan(...args); },
  };
  const snapshots = new Snapshots(store, source, () => now, () => tz);
  return { root, store, source, snapshots, calls: () => calls, catalogCalls: () => catalogCalls, tz: () => tz,
    setScan: (fn: typeof scan) => { scan = fn; }, setNow: (at: Date) => { now = at; }, setTz: (next: string) => { tz = next; } };
}

test("snapshots: daemon warms three ranges, reads/filtering do no network work, timer scans every five minutes", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = await setup();
  try {
    await h.snapshots.init(); await h.snapshots.refresh();
    assert.equal(h.calls(), 3);
    for (let i = 0; i < 10; i++) {
      assert.equal(h.snapshots.read(TODAY).result?.sessions.length, 2);
      assert.equal(h.snapshots.read({ ...TODAY, projectId: projectKey("b", "b") }).result?.sessions[0].nodeId, "b");
      assert.equal(h.snapshots.read({ ...TODAY, nodeIds: ["a"] }).result?.overview.sessions, 1);
      h.snapshots.catalog();
    }
    assert.equal(h.calls(), 3); assert.equal(h.catalogCalls(), 1);
    t.mock.timers.tick(REFRESH_MS - 1); assert.equal(h.calls(), 3);
    t.mock.timers.tick(1); await h.snapshots.refresh(); assert.equal(h.calls(), 6);
    h.snapshots.dispose();
    t.mock.timers.tick(REFRESH_MS * 2); await h.snapshots.refresh(); assert.equal(h.calls(), 6);
    assert.equal((await stat(join(h.root, "snapshots.json"))).mode & 0o777, 0o600);
  } finally { h.snapshots.dispose(); await rm(h.root, { recursive: true, force: true }); }
});

test("snapshots: restart serves disk immediately while startup scan hangs; refresh calls share one worker", async () => {
  const h = await setup();
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  let restored: Snapshots | undefined;
  try {
    await h.snapshots.init(); await h.snapshots.refresh(); h.snapshots.dispose();
    h.setScan(async (scope, _report, signal) => { await gate; assert.equal(signal?.aborted, true); return result(scope); });
    restored = new Snapshots(h.store, h.source, () => INITIAL, h.tz);
    await restored.init();
    assert.equal(restored.read(TODAY).result?.sessions.length, 2);
    const a = restored.refresh(), b = restored.refresh(); assert.equal(a, b);
    await new Promise(r => setImmediate(r)); assert.equal(h.calls(), 4);
    const before = await readFile(join(h.root, "snapshots.json"), "utf8");
    restored.dispose(); release(); await a;
    assert.equal(await readFile(join(h.root, "snapshots.json"), "utf8"), before);
    assert.equal(h.calls(), 4);
  } finally { release(); restored?.dispose(); h.snapshots.dispose(); await rm(h.root, { recursive: true, force: true }); }
});

test("snapshots: offline nodes retain timestamped data, successful empty scans clear it, global failures preserve the snapshot", async () => {
  const h = await setup();
  try {
    await h.snapshots.init(); await h.snapshots.refresh();
    const next = new Date("2026-10-03T04:05:00Z");
    h.setScan(async scope => ({ ...result(scope, next), sessions: [], projects: [], complete: false,
      nodes: [{ id: "a", name: "a", status: "offline", error: "offline" }, { id: "b", name: "b", status: "succeeded", sessions: 0 }] }));
    await h.snapshots.refresh();
    const cached = h.snapshots.read(TODAY).result!;
    assert.deepEqual(cached.sessions.map(s => s.nodeId), ["a"]);
    assert.equal(cached.nodes?.[0].cachedAt, INITIAL.toISOString());
    assert.equal(cached.nodes?.[1].cachedAt, next.toISOString());
    assert.equal(cached.complete, false); assert.equal(cached.overview.sessions, 1);
    assert.equal(h.snapshots.read({ ...TODAY, projectId: projectKey("a", "a") }).result?.sessions.length, 1);
    h.setScan(async () => { throw new Error("connection unavailable"); });
    await h.snapshots.refresh();
    assert.equal(h.snapshots.read(TODAY).result?.sessions.length, 1);
    assert.match(h.snapshots.read(TODAY).error!, /connection unavailable/);
    const count = h.calls(); h.snapshots.read(TODAY); assert.equal(h.calls(), count);
  } finally { h.snapshots.dispose(); await rm(h.root, { recursive: true, force: true }); }
});

test("snapshots: custom ranges fill once, reuse across projects, and midnight never reuses yesterday as today", async () => {
  const h = await setup();
  try {
    await h.snapshots.init(); await h.snapshots.refresh();
    const custom: Scope = { range: { kind: "custom", from: "2026-09-01", to: "2026-09-02" } };
    assert.equal(h.snapshots.read(custom).refreshing, true);
    await h.snapshots.refresh(); assert.equal(h.calls(), 4);
    assert.equal(h.snapshots.read({ ...custom, projectId: projectKey("a", "a") }).result?.sessions.length, 1);
    assert.equal(h.calls(), 4);
    h.setNow(new Date("2026-10-03T16:01:00Z"));
    assert.equal(h.snapshots.read(TODAY).result, undefined);
    await h.snapshots.refresh();
    assert.equal(h.snapshots.read(TODAY).result?.from, "2026-10-04");
    assert.equal(h.snapshots.read({ range: { kind: "yesterday" } }).result?.from, "2026-10-03");
  } finally { h.snapshots.dispose(); await rm(h.root, { recursive: true, force: true }); }
});

test("snapshots: corrupt files rebuild, saved workspace choices are reused on restart", async () => {
  const h = await setup();
  let restored: Snapshots | undefined;
  try {
    await writeFile(join(h.root, "snapshots.json"), "broken");
    await h.snapshots.init(); await h.snapshots.refresh();
    assert.equal(h.snapshots.read(TODAY).error, undefined);
    h.snapshots.read({ ...TODAY, workspaces: { a: "existing-workspace" } });
    await h.snapshots.refresh(); h.snapshots.dispose();
    h.setScan(async scope => { assert.equal(scope.workspaces?.a, "existing-workspace"); return result(scope); });
    restored = new Snapshots(h.store, h.source, () => INITIAL, h.tz);
    await restored.init(); await restored.refresh();
    assert.equal(restored.read(TODAY).error, undefined);
  } finally { restored?.dispose(); h.snapshots.dispose(); await rm(h.root, { recursive: true, force: true }); }
});

test("snapshots: UI limits apply after cached project filtering without truncating the stored range", () => {
  const r = result(TODAY);
  r.sessions = Array.from({ length: 201 }, (_, i) => ({ ...card("a", projectKey("a", i ? "other" : "a")), id: `s-${i}` }));
  assert.throws(() => filterSnapshot(r, TODAY), /200/);
  assert.equal(filterSnapshot(r, { ...TODAY, projectId: projectKey("a", "a") }).sessions.length, 1);
  assert.equal(r.sessions.length, 201);
  assert.throws(() => filterSnapshot(r, { ...TODAY, nodeIds: ["gone"] }), /节点清单/);
  assert.throws(() => filterSnapshot(r, { ...TODAY, projectId: "invalid" }), /项目选择/);
  r.sessions = []; r.projects = []; r.nodes![0].status = "offline";
  const offline = filterSnapshot(r, { ...TODAY, projectId: projectKey("a", "a") });
  assert.equal(offline.nodes?.[0].status, "offline"); assert.equal(offline.complete, false);
});

test("snapshots: a timezone change resets the calendar, and saved ranges from another timezone are not restored", async () => {
  const h = await setup();
  let restored: Snapshots | undefined;
  try {
    await h.snapshots.init(); await h.snapshots.refresh();
    assert.equal(h.snapshots.read(TODAY).result?.from, "2026-10-03");
    // 04:00Z is still 2026-10-02 in Los Angeles; the old key must not be served as today.
    h.setTz("America/Los_Angeles");
    await h.snapshots.reset();
    assert.equal(h.snapshots.catalog().timezone, "America/Los_Angeles");
    assert.equal(h.snapshots.read(TODAY).result?.from, "2026-10-02");
    assert.equal(h.snapshots.read(TODAY).result?.timezone, "America/Los_Angeles");
    assert.equal(h.calls(), 6);
    h.snapshots.dispose();
    // Restart under the original timezone: the Los Angeles snapshots on disk are ignored and rebuilt.
    h.setTz(TZ);
    restored = new Snapshots(h.store, h.source, () => INITIAL, h.tz);
    await restored.init();
    assert.equal(restored.read(TODAY).result, undefined);
    await restored.refresh();
    assert.equal(restored.read(TODAY).result?.from, "2026-10-03");
  } finally { restored?.dispose(); h.snapshots.dispose(); await rm(h.root, { recursive: true, force: true }); }
});

test("snapshots: the origin filter counts before hiding, hidden sessions never use the limit, no origin means all", () => {
  const r = result(TODAY);
  const run = (i: number): SessionCard => ({ ...card("a"), id: `run-${i}`, origin: "scheduled", launcher: { kind: "schedule", id: "sch", name: "巡检" } });
  r.sessions = [card("a"), card("b"), ...Array.from({ length: 201 }, (_, i) => run(i)),
    { ...card("b"), id: "joined", launcher: { kind: "schedule", id: "sch", name: "巡检" } },
    { ...card("a"), id: "child", origin: "other", launcher: { kind: "agent", id: "p" } }];
  const human = filterSnapshot(r, { ...TODAY, origin: "human" });
  assert.deepEqual(human.sessions.map(s => s.id), ["a-s", "b-s", "joined"]);
  assert.deepEqual(human.origins, { human: 3, scheduled: 201, other: 1, schedules: [{ name: "巡检", sessions: 201 }] });
  assert.equal(human.overview.sessions, 3); assert.equal(human.nodes?.find(n => n.id === "a")?.sessions, 1);
  assert.throws(() => filterSnapshot(r, { ...TODAY, origin: "scheduled" }), /200/);
  assert.throws(() => filterSnapshot(r, TODAY), /200/);
  const other = filterSnapshot(r, { ...TODAY, nodeIds: ["b"], origin: "other" });
  assert.equal(other.sessions.length, 0); assert.deepEqual(other.origins, { human: 2, scheduled: 0, other: 0, schedules: [] });
});

test("snapshots: a snapshot written by another version is ignored without an error and rebuilt", async () => {
  const h = await setup();
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  try {
    await writeFile(join(h.root, "snapshots.json"), JSON.stringify({ version: 1, extractVersion: 5, results: [], customRanges: [], workspaces: {} }));
    h.setScan(async scope => { await gate; return result(scope); });
    await h.snapshots.init();
    assert.equal(h.snapshots.read(TODAY).error, undefined); assert.equal(h.snapshots.read(TODAY).result, undefined);
    release(); await h.snapshots.refresh();
    assert.equal(h.snapshots.read(TODAY).result?.sessions.length, 2);
    assert.equal(JSON.parse(await readFile(join(h.root, "snapshots.json"), "utf8")).version, DISK_VERSION);
  } finally { release(); h.snapshots.dispose(); await rm(h.root, { recursive: true, force: true }); }
});
