import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { runReview, sessionDetail, resolveRange } from "../server/review.ts";
import { redactText } from "../server/redact.ts";
import { Store } from "../server/store.ts";
import { scopeSchema } from "../shared/model.ts";
import { makeHomes } from "./fixtures.ts";

const now = () => new Date(2026, 8, 30, 20, 0, 0);

async function deps(options?: Parameters<typeof makeHomes>[0]) {
  const h = await makeHomes(options);
  const store = new Store(join(h.paseoHome, "session-review"));
  await store.init();
  return { h, deps: { homes: { paseoHome: h.paseoHome, claudeHome: h.claudeHome, codexHome: h.codexHome, dataDir: store.dataDir }, store, now } };
}

test("review: attribution, fork nesting, hidden threads, overview", async () => {
  const { deps: d } = await deps();
  const result = await runReview({ projectId: "prj_1", range: { kind: "today" } }, d, () => {});
  assert.equal(result.from, "2026-09-30");
  assert.equal(result.sessions.length, 3, "claude session + codex parent + codex fork; hidden child folded");
  const claude = result.sessions.find((s) => s.provider === "claude")!;
  assert.equal(claude.agentId, "agent-1");
  assert.equal(claude.projectId, "prj_1");
  const parent = result.sessions.find((s) => s.id === "x1")!;
  assert.equal(parent.agentId, null, "no Paseo agent record");
  assert.equal(parent.projectId, "prj_1", "attributed by project root");
  assert.equal(parent.hiddenThreads, 1);
  const fork = result.sessions.find((s) => s.id === "x3")!;
  assert.equal(fork.depth, 1);
  assert.equal(result.sessions.indexOf(fork), result.sessions.indexOf(parent) + 1, "fork sits right under its parent");
  assert.ok(result.overview.peakParallel >= 1);
  assert.equal(result.overview.decisions, 5 + 2 + 2);
  assert.ok(result.sessions.every((s) => s.title.length <= 60));
});

test("review: project scope includes all branches and ignores legacy branch filters; cache reuse", async () => {
  const { deps: d } = await deps();
  const byProject = await runReview({ projectId: "prj_1", range: { kind: "today" } }, d, () => {});
  assert.equal(byProject.sessions.length, 3);
  const other = await runReview({ projectId: "prj_other", range: { kind: "today" } }, d, () => {});
  assert.equal(other.sessions.length, 0);
  const all = await runReview({ range: { kind: "today" } }, d, () => {});
  assert.equal(all.sessions.length, 3);
  const legacyScope = scopeSchema.parse({ projectId: "prj_1", range: { kind: "today" }, branch: "feat/demo" });
  assert.ok(!("branch" in legacyScope), "old clients cannot keep a hidden branch filter");
  const unfiltered = await runReview(legacyScope, d, () => {});
  assert.deepEqual(unfiltered.sessions.map(s => s.id), byProject.sessions.map(s => s.id));
  const cached = await d.store.readExtractAny("claude", "c1");
  assert.ok(cached, "extract cached after first run");
  const detail = await sessionDetail("claude", "c1", d.store);
  assert.equal(detail.messages.filter((m) => m.role === "user").length, 2);
});

test("redaction happens before caching", async () => {
  const { deps: d } = await deps();
  await runReview({ projectId: "prj_1", range: { kind: "today" } }, d, () => {});
  const cached = await d.store.readExtractAny("claude", "c1");
  const text = JSON.stringify(cached);
  assert.ok(!text.includes("sk-abcdefghijklmnopqrstuvwxyz1234"), "api key masked");
  assert.ok(text.includes("[已打码]"));
});

test("redact patterns", () => {
  assert.equal(redactText("Bearer abcdefghijklmnopqrstuvwxyz"), "Bearer [已打码]");
  assert.equal(redactText("socks5://user:secretpass@1.2.3.4:1080"), "socks5://[已打码]@1.2.3.4:1080");
  assert.equal(redactText("DEEPSEEK_API_KEY=abcdefgh12345678"), "DEEPSEEK_API_KEY=[已打码]");
  assert.equal(redactText("https://goat.example/insights/WdJMi1XvV-79MhfTLFGpmKkfkiEUIxDOyNJcGwcZX7o"), "https://goat.example/insights/[已打码]");
  assert.equal(redactText("普通文字 和 短id abc123"), "普通文字 和 短id abc123");
});

test("resolveRange uses local calendar days", () => {
  const r = resolveRange({ kind: "yesterday" }, new Date(2026, 9, 1, 1, 0));
  assert.equal(r.fromKey, "2026-09-30");
  assert.equal(r.toKey, "2026-09-30");
  const c = resolveRange({ kind: "custom", from: "2026-09-30", to: "2026-09-28" }, new Date());
  assert.equal(c.fromKey, "2026-09-28");
  assert.equal(c.toKey, "2026-09-30");
});

test("wait segments longer than the cap are treated as parked, not waiting", async () => {
  const { spansFromTurns, WAIT_CAP_MS } = await import("../server/spans.ts");
  const spans = spansFromTurns([
    { startedAt: "2026-09-30T04:00:00.000Z", endedAt: "2026-09-30T04:10:00.000Z", waitsForUser: true, nextStartedAt: "2026-09-30T04:40:00.000Z" },
    { startedAt: "2026-09-30T04:40:00.000Z", endedAt: "2026-09-30T04:50:00.000Z", waitsForUser: true, nextStartedAt: new Date(Date.parse("2026-09-30T04:50:00.000Z") + WAIT_CAP_MS + 1000).toISOString() },
  ]);
  assert.equal(spans.filter((s) => s.kind === "wait").length, 1);
});

test("resumed copies of the same session are folded into the longest one", async () => {
  const { foldResumedCopies } = await import("../server/review.ts");
  const base = { provider: "claude" as const, file: "", cwd: "/w", branch: null, startedAt: "a", endedAt: "b", title: "t", turns: [], decisions: [], userMessages: 1, forkedFrom: null, hiddenThreads: [], error: null };
  const short = { ...base, id: "s1", messages: [{ at: "2026-10-01T00:42:00.000Z", role: "user" as const, text: "同一句话" }] };
  const long = { ...base, id: "s2", endedAt: "c", messages: [...short.messages, { at: "2026-10-01T10:00:00.000Z", role: "assistant" as const, text: "后续" }] };
  const other = { ...base, id: "s3", messages: [{ at: "2026-10-01T00:42:00.000Z", role: "user" as const, text: "另一句话" }] };
  const hidden = new Map<string, string[]>();
  const out = foldResumedCopies([short, long, other], hidden);
  assert.deepEqual(out.map((s) => s.id).sort(), ["s2", "s3"]);
  assert.deepEqual(hidden.get("s2"), ["s1"]);
});

test("long silences inside a turn split the run", async () => {
  const { buildTurns, RUN_GAP_MS } = await import("../server/sources/claude.ts");
  const t0 = Date.parse("2026-10-01T02:39:00.000Z");
  const iso = (ms: number) => new Date(ms).toISOString();
  const turns = buildTurns(
    [{ at: iso(t0), real: true }, { at: iso(t0 + 8 * 3_600_000), real: true }],
    [iso(t0 + 30_000), iso(t0 + 60_000), iso(t0 + 7 * 3_600_000), iso(t0 + 7 * 3_600_000 + 60_000)],
    iso(t0), iso(t0 + 8 * 3_600_000 + 60_000),
  );
  assert.equal(turns.length, 3, "first turn splits into two runs around the silence, plus the second turn");
  assert.equal(turns[0].waitsForUser, false);
  assert.equal(turns[1].waitsForUser, true, "only the last cluster of a turn waits for the user");
  assert.ok(Date.parse(turns[0].endedAt) - Date.parse(turns[0].startedAt) < RUN_GAP_MS);
});

test("a session is shown on every day it was active, clipped to that day", async () => {
  const { toCards } = await import("../server/review.ts");
  const { loadCatalog } = await import("../server/catalog.ts");
  const { h } = await deps();
  const catalog = await loadCatalog(h.paseoHome);
  const session = {
    id: "long", provider: "claude" as const, file: "", cwd: "/w", branch: null,
    startedAt: "2026-09-29T15:00:00.000Z", endedAt: "2026-09-30T04:30:00.000Z", title: "跨天会话",
    messages: [
      { at: "2026-09-29T15:00:00.000Z", role: "user" as const, text: "开始" },
      { at: "2026-09-30T04:00:00.000Z", role: "user" as const, text: "第二天继续" },
    ],
    turns: [
      { startedAt: "2026-09-29T15:00:00.000Z", endedAt: "2026-09-29T15:20:00.000Z", waitsForUser: true, nextStartedAt: "2026-09-30T04:00:00.000Z" },
      { startedAt: "2026-09-30T04:00:00.000Z", endedAt: "2026-09-30T04:30:00.000Z", waitsForUser: false, nextStartedAt: null },
    ],
    decisions: [
      { id: "d1", at: "2026-09-29T15:10:00.000Z", kind: "memory" as const, excerpt: "第一天", answer: null, next: null, detail: null },
      { id: "d2", at: "2026-09-30T04:10:00.000Z", kind: "memory" as const, excerpt: "第二天", answer: null, next: null, detail: null },
    ],
    userMessages: 2, forkedFrom: null, hiddenThreads: [], error: null,
  };
  // Local day 2026-09-30 in UTC+8 is 2026-09-29T16:00Z .. 2026-09-30T15:59:59Z
  const from = new Date("2026-09-29T16:00:00.000Z"), to = new Date("2026-09-30T15:59:59.999Z");
  const [card] = toCards([session], catalog, new Map(), from, to);
  assert.equal(card.continued, true);
  assert.equal(card.startedAt, "2026-09-30T04:00:00.000Z", "row starts at the first activity inside the day");
  assert.equal(card.userMessages, 1);
  assert.equal(card.userMessagesTotal, 2);
  assert.deepEqual(card.decisions.map((d) => d.id), ["d2"]);
  assert.equal(card.spans.filter((s) => s.kind === "run").length, 1, "only the second day's run survives");
  assert.equal(card.activeMs, 30 * 60_000);
});

test("origin: a schedule's run, a run a person joined, a delegated agent and an empty session", async () => {
  const { classify } = await import("../server/catalog.ts");
  const { deps: d } = await deps({ automation: true });
  const result = await runReview({ range: { kind: "today" } }, d, () => {});
  const by = (id: string) => result.sessions.find((s) => s.id === id)!;
  assert.equal(result.sessions.length, 7, "three original sessions plus four automated ones");
  assert.equal(by("c1").origin, "human"); assert.equal(by("c1").launcher, null);
  assert.equal(by("run1").origin, "scheduled");
  assert.deepEqual(by("run1").launcher, { kind: "schedule", id: "sch_1", name: "夜间巡检" });
  assert.equal(by("run2").origin, "human", "a person typed after the launch prompt");
  assert.deepEqual(by("run2").launcher, { kind: "schedule", id: "sch_gone", name: "sch_gone" }, "a deleted schedule is named by its id");
  assert.equal(by("child1").origin, "other"); assert.deepEqual(by("child1").launcher, { kind: "agent", id: "agent-1" });
  assert.equal(by("empty1").origin, "other"); assert.equal(by("empty1").launcher, null);
  assert.equal(by("x1").origin, "human", "Codex sessions have no Paseo record and are classified by who spoke");
  assert.equal(classify(null, 0), "other"); assert.equal(classify(null, 1), "human");
  assert.equal(classify({ kind: "schedule", id: "s", name: "s" }, 1), "scheduled");
  assert.equal(classify({ kind: "agent", id: "a" }, 1), "other");
  assert.equal(classify({ kind: "agent", id: "a" }, 2), "human");
});
