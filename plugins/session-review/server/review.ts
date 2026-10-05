import type { Decision, Progress, ReviewResult, Scope, SessionCard, SessionDetail, Span } from "../shared/model.ts";
import { EXCERPT_MAX, MESSAGE_MAX, SESSION_LIMIT, TITLE_MAX } from "../shared/model.ts";
import { attribute, classify, inScope, loadCatalog, type Catalog } from "./catalog.ts";
import { clip } from "./decisions.ts";
import type { Homes } from "./paths.ts";
import { isUnder } from "./paths.ts";
import { redactDeep } from "./redact.ts";
import { parseClaude, scanClaude } from "./sources/claude.ts";
import { parseCodex, scanCodex } from "./sources/codex.ts";
import type { Candidate, ExtractedSession } from "./sources/types.ts";
import { peakParallel, spansFromTurns, sumMs, unionRunMs } from "./spans.ts";
import type { Store } from "./store.ts";

export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function startOfDay(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}
function endOfDay(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999);
}

export function resolveRange(range: Scope["range"], now = new Date()): { from: Date; to: Date; fromKey: string; toKey: string } {
  const today = localDateKey(now);
  let fromKey = today, toKey = today;
  if (range.kind === "yesterday") {
    const y = new Date(now); y.setDate(y.getDate() - 1); fromKey = toKey = localDateKey(y);
  } else if (range.kind === "last7") {
    const s = new Date(now); s.setDate(s.getDate() - 6); fromKey = localDateKey(s);
  } else if (range.kind === "custom") {
    fromKey = range.from ?? today; toKey = range.to ?? fromKey;
    if (fromKey > toKey) [fromKey, toKey] = [toKey, fromKey];
  }
  return { from: startOfDay(fromKey), to: endOfDay(toKey), fromKey, toKey };
}

/** Parse or reuse the cached extraction for one candidate. Never throws; parse failures become `error`. */
export async function extractOne(candidate: Candidate, store: Store): Promise<ExtractedSession> {
  const cached = await store.readExtract(candidate.provider, candidate.id, candidate.mtimeMs, candidate.size);
  if (cached) return cached;
  try {
    const parsed = candidate.provider === "claude" ? await parseClaude(candidate) : await parseCodex(candidate);
    const redacted = redactDeep(parsed);
    try { await store.writeExtract(redacted, candidate.mtimeMs, candidate.size); }
    catch { redacted.warning = "缓存写入失败，本次结果仍可查看；消息详情需重新读取"; }
    return redacted;
  } catch (error) {
    return {
      id: candidate.id, provider: candidate.provider, file: candidate.file, cwd: candidate.cwd, branch: null,
      startedAt: candidate.startedAt, endedAt: candidate.startedAt, title: "（无法解析）", messages: [], turns: [], decisions: [],
      userMessages: 0, forkedFrom: candidate.forkedFrom, hiddenThreads: [], error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface ReviewDeps { homes: Homes; store: Store; now?: () => Date; bounds?: { from: string; to: string; fromKey: string; toKey: string }; sessionLimit?: number }

export async function runReview(scope: Scope, deps: ReviewDeps, report: (p: Progress) => void, signal?: AbortSignal): Promise<ReviewResult> {
  const now = deps.now ? deps.now() : new Date();
  const resolved = deps.bounds ? { ...deps.bounds, from: new Date(deps.bounds.from), to: new Date(deps.bounds.to) } : resolveRange(scope.range, now);
  report({ phase: "读取 Paseo 目录", done: 0, total: 0 });
  const catalog = await loadCatalog(deps.homes.paseoHome);

  report({ phase: "扫描会话文件", done: 0, total: 0 });
  const [claude, codex] = await Promise.all([
    scanClaude(deps.homes.claudeHome, resolved.from, resolved.to),
    scanCodex(deps.homes.codexHome, resolved.from, resolved.to),
  ]);
  const all = [...claude, ...codex].filter((c) => !isUnder(c.cwd, deps.homes.dataDir));

  // Fold Codex child threads into their parents before anything else.
  const hiddenByParent = new Map<string, string[]>();
  const candidates: Candidate[] = [];
  for (const c of all) {
    if (c.hiddenChildOf) { hiddenByParent.set(c.hiddenChildOf, [...(hiddenByParent.get(c.hiddenChildOf) ?? []), c.id]); continue; }
    candidates.push(c);
  }

  // Attribution happens before parsing so out-of-scope files are never read in full.
  const selected = candidates.filter((c) => inScope(attribute(catalog, c.id, c.cwd), scope));

  const sessions: ExtractedSession[] = [];
  for (const [index, candidate] of selected.entries()) {
    if (signal?.aborted) throw new Error("任务已中断");
    report({ phase: "解析会话", done: index, total: selected.length });
    sessions.push(await extractOne(candidate, deps.store));
  }
  report({ phase: "整理", done: selected.length, total: selected.length });

  // A resumed Claude session is written to a new file that starts with a copy of the old one;
  // keep the longest copy and count the others as folded threads.
  const deduped = foldResumedCopies(sessions, hiddenByParent);
  // A session belongs to the range if any of its activity falls inside it; the chart then shows only that part.
  const active = deduped.filter((s) => hasActivity(s, resolved.from, resolved.to));
  const limit = deps.sessionLimit ?? SESSION_LIMIT;
  if (active.length > limit) throw new Error(`范围内有 ${active.length} 个会话，超过 ${limit} 个，请收窄日期范围或项目`);
  const cards = toCards(active, catalog, hiddenByParent, resolved.from, resolved.to);
  const spans = cards.map((c) => c.spans);
  return {
    scope, from: resolved.fromKey, to: resolved.toKey,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    generatedAt: new Date().toISOString(),
    overview: {
      sessions: cards.length,
      peakParallel: peakParallel(spans),
      activeMs: unionRunMs(spans),
      waitMs: cards.reduce((acc, c) => acc + c.waitMs, 0),
      decisions: cards.reduce((acc, c) => acc + c.decisions.length, 0),
      unparsable: cards.filter((c) => c.error).length,
    },
    sessions: cards,
  };
}

export function hasActivity(s: ExtractedSession, from: Date, to: Date): boolean {
  const inside = (at: string) => Date.parse(at) >= from.getTime() && Date.parse(at) <= to.getTime();
  return !!s.error || s.messages.some(m => inside(m.at)) || s.decisions.some(d => inside(d.at)) ||
    clipSpans(spansFromTurns(s.turns).filter(sp => sp.kind === "run"), from, to).length > 0;
}

export function foldResumedCopies(sessions: ExtractedSession[], hiddenByParent: Map<string, string[]>): ExtractedSession[] {
  // Only Claude Code copies history into a new file on resume; Codex forks are explicit (`forkedFrom`) and stay separate.
  const groups = new Map<string, ExtractedSession[]>();
  for (const s of sessions) {
    const firstUser = s.messages.find((m) => m.role === "user");
    const foldable = s.provider === "claude" && !s.forkedFrom && firstUser;
    const key = foldable ? `${s.provider}|${s.cwd}|${firstUser.at}|${firstUser.text.slice(0, 200)}` : `${s.provider}|${s.id}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const out: ExtractedSession[] = [];
  for (const group of groups.values()) {
    const [keep, ...rest] = [...group].sort((a, b) => b.messages.length - a.messages.length || b.endedAt.localeCompare(a.endedAt));
    if (rest.length) hiddenByParent.set(keep.id, [...(hiddenByParent.get(keep.id) ?? []), ...rest.map((r) => r.id)]);
    out.push(keep);
  }
  return out;
}

export function clipSpans(spans: Span[], from: Date, to: Date): Span[] {
  const lo = from.getTime(), hi = to.getTime();
  const out: Span[] = [];
  for (const span of spans) {
    const start = Math.max(Date.parse(span.start), lo);
    const end = Math.min(Date.parse(span.end), hi);
    if (end > start) out.push({ kind: span.kind, start: new Date(start).toISOString(), end: new Date(end).toISOString() });
  }
  return out;
}

export function toCards(sessions: ExtractedSession[], catalog: Catalog, hiddenByParent: Map<string, string[]>, from: Date, to: Date): SessionCard[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const cards = new Map<string, SessionCard>();
  const inRange = (at: string) => { const t = Date.parse(at); return t >= from.getTime() && t <= to.getTime(); };
  for (const s of sessions) {
    const a = attribute(catalog, s.id, s.cwd);
    const spans = clipSpans(spansFromTurns(s.turns), from, to);
    const messagesInRange = s.messages.filter((m) => inRange(m.at));
    const times = [...spans.flatMap((sp) => [sp.start, sp.end]), ...messagesInRange.map((m) => m.at)].sort();
    const clampedStart = new Date(Math.max(Date.parse(s.startedAt), from.getTime())).toISOString();
    const clampedEnd = new Date(Math.min(Date.parse(s.endedAt), to.getTime())).toISOString();
    cards.set(s.id, {
      id: s.id, provider: s.provider, title: clip(s.title, TITLE_MAX) || "（无标题）",
      startedAt: times[0] ?? clampedStart, endedAt: times[times.length - 1] ?? clampedEnd,
      sessionStartedAt: s.startedAt, sessionEndedAt: s.endedAt, continued: Date.parse(s.startedAt) < from.getTime(),
      activeMs: sumMs(spans, "run"), waitMs: sumMs(spans, "wait"),
      userMessages: messagesInRange.filter((m) => m.role === "user").length, userMessagesTotal: s.userMessages,
      agentId: a.agentId, projectId: a.projectId, origin: classify(a.launcher, s.userMessages), launcher: a.launcher,
      branch: s.branch, cwd: s.cwd, forkedFrom: s.forkedFrom, depth: 0,
      hiddenThreads: (hiddenByParent.get(s.id) ?? []).length,
      spans, decisions: s.decisions.filter((d) => inRange(d.at)).map(shortenDecision), error: s.error, warning: s.warning, file: s.file,
    });
  }
  // Order: by start time; a fork whose parent is in scope sits right under the parent with depth 1.
  const roots = [...cards.values()].filter((c) => !(c.forkedFrom && byId.has(c.forkedFrom))).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const ordered: SessionCard[] = [];
  const seen = new Set<string>();
  const append = (card: SessionCard, depth: number) => {
    if (seen.has(card.id)) return;
    seen.add(card.id);
    ordered.push({ ...card, depth });
    const children = [...cards.values()].filter(c => c.forkedFrom === card.id).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    for (const child of children) append(child, depth + 1);
  };
  for (const root of roots) append(root, 0);
  for (const card of cards.values()) append(card, 0); // Malformed cycles must not hide sessions.
  return ordered;
}

function shortenDecision(d: Decision): Decision {
  return { ...d, excerpt: clip(d.excerpt, EXCERPT_MAX), answer: d.answer ? clip(d.answer, 200) : d.answer, next: d.next ? clip(d.next, 60) : d.next };
}

export async function sessionDetail(provider: "claude" | "codex", id: string, store: Store, offset = 0, limit = 100): Promise<SessionDetail> {
  const session = await store.readExtractAny(provider, id);
  if (!session) throw new Error("没有这个会话的抽取结果，请先重新运行复盘");
  return {
    id: session.id, provider: session.provider, title: clip(session.title, TITLE_MAX), cwd: session.cwd, file: session.file,
    messages: session.messages.slice(offset, offset + limit).map((m) => ({ ...m, text: m.text.length > MESSAGE_MAX ? `${m.text.slice(0, MESSAGE_MAX)}…` : m.text })),
    totalMessages: session.messages.length,
    nextOffset: offset + limit < session.messages.length ? offset + limit : null,
    decisions: session.decisions.map(shortenDecision),
  };
}
