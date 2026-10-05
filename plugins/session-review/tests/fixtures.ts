import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const T = (h: number, m: number, s = 0) => new Date(Date.UTC(2026, 8, 30, h, m, s)).toISOString();

/** A synthetic Claude Code transcript mirroring the record shapes of the real files, with fake content. */
export function claudeLines(sessionId: string, cwd: string): string[] {
  const rec = (o: Record<string, unknown>) => JSON.stringify({ sessionId, cwd, gitBranch: "feat/demo", version: "2.1.0", ...o });
  const user = (ts: string, content: unknown) => rec({ type: "user", timestamp: ts, message: { role: "user", content } });
  const asst = (ts: string, id: string, block: unknown) => rec({ type: "assistant", timestamp: ts, message: { id, role: "assistant", content: [block] } });
  return [
    JSON.stringify({ type: "permission-mode", permissionMode: "auto", sessionId }),
    user(T(4, 0), "帮我做一个 demo 页面"),
    asst(T(4, 0, 5), "m1", { type: "text", text: "好的，我先看一下目录。" }),
    asst(T(4, 0, 6), "m1", { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }),
    user(T(4, 0, 7), [{ type: "tool_result", tool_use_id: "toolu_1", content: "a b c" }]),
    asst(T(4, 1), "m2", { type: "tool_use", id: "toolu_2", name: "AskUserQuestion", input: { questions: [{ question: "页面放在哪个目录？", header: "目录", options: [{ label: "web/" }] }] } }),
    user(T(4, 30), [{ type: "tool_result", tool_use_id: "toolu_2", content: 'Your questions have been answered: "页面放在哪个目录？"="web/ (Recommended)"' }]),
    asst(T(4, 30, 5), "m3", { type: "text", text: "就用 web/。开始写代码。然后部署。" }),
    asst(T(4, 31), "m4", { type: "tool_use", id: "toolu_3", name: "Bash", input: { command: "rsync -az . server:/srv/app" } }),
    user(T(4, 31, 2), [{ type: "tool_result", tool_use_id: "toolu_3", is_error: true, content: "Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Production Deploy]. If you have other tasks, continue." }]),
    asst(T(4, 32), "m5", { type: "tool_use", id: "toolu_4", name: "Write", input: { file_path: `${cwd}/.claude/projects/-x/memory/deploy-rule.md`, content: "---\nname: deploy-rule\ndescription: 部署前先问 Jack\n---\n正文" } }),
    asst(T(4, 32, 1), "m6", { type: "tool_use", id: "toolu_5", name: "Edit", input: { file_path: `${cwd}/.claude/projects/-x/memory/MEMORY.md`, old_string: "a", new_string: "- [部署规则](deploy-rule.md)" } }),
    asst(T(4, 33), "m7", { type: "text", text: "部署被拦下了，我先记下规则。token=sk-abcdefghijklmnopqrstuvwxyz1234 不该出现。" }),
    user(T(4, 40), "[Request interrupted by user]"),
    user(T(4, 41), "先不部署，只做本地"),
    asst(T(4, 41, 30), "m8", { type: "text", text: "收到，只做本地。" }),
    user(T(4, 50), "<task-notification>\n<task-id>x</task-id>\n</task-notification>"),
    asst(T(4, 50, 10), "m9", { type: "text", text: "后台任务结束了。" }),
    user(T(4, 55), "<system-reminder>注入内容</system-reminder>"),
    user(T(4, 56), "Base directory for this skill: /x\n# skill"),
  ];
}

export function codexLines(id: string, cwd: string, opts: { parent?: string; forkedFrom?: string } = {}): string[] {
  const meta = { type: "session_meta", timestamp: T(2, 0), payload: { id, cwd, timestamp: T(2, 0), originator: "codex-tui", parent_thread_id: opts.parent, forked_from_id: opts.forkedFrom } };
  const ev = (ts: string, payload: Record<string, unknown>) => JSON.stringify({ timestamp: ts, type: "event_msg", payload });
  const ri = (ts: string, payload: Record<string, unknown>) => JSON.stringify({ timestamp: ts, type: "response_item", payload });
  return [
    JSON.stringify(meta),
    ev(T(2, 0, 1), { type: "task_started", turn_id: "t1" }),
    ri(T(2, 0, 2), { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions\n<INSTRUCTIONS>..." }] }),
    ri(T(2, 0, 3), { type: "message", role: "user", content: [{ type: "input_text", text: "梳理项目上下文" }] }),
    ri(T(2, 0, 30), { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "我先读文档。" }] }),
    ri(T(2, 1), { type: "function_call", name: "request_user_input_async", arguments: JSON.stringify({ questions: [{ title: "文档权限开了吗？", options: ["开了", "没有"] }] }) }),
    ev(T(2, 1, 1), { type: "task_complete", turn_id: "t1" }),
    ev(T(2, 10), { type: "task_started", turn_id: "t2" }),
    ri(T(2, 10, 1), { type: "message", role: "user", content: [{ type: "input_text", text: '<send_user_message_question_reply>\nuser: [{"answer":"开了","question":"文档权限开了吗？"}]\n</send_user_message_question_reply>' }] }),
    ri(T(2, 11), { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "好，已经读到了。结论如下。" }] }),
    ev(T(2, 12), { type: "turn_aborted", turn_id: "t2", reason: "interrupted" }),
  ];
}

export async function makeHomes(options: { automation?: boolean } = {}): Promise<{ root: string; paseoHome: string; claudeHome: string; codexHome: string; cwd: string }> {
  const root = await mkdtemp(join(tmpdir(), "session-review-"));
  const cwd = join(root, "work", "proj");
  const paseoHome = join(root, "paseo"), claudeHome = join(root, "claude"), codexHome = join(root, "codex");
  await mkdir(join(claudeHome, "projects", "-work-proj"), { recursive: true });
  await mkdir(join(codexHome, "sessions", "2026", "09", "30"), { recursive: true });
  await mkdir(join(paseoHome, "projects"), { recursive: true });
  await mkdir(join(paseoHome, "agents", "g"), { recursive: true });
  await writeFile(join(claudeHome, "projects", "-work-proj", "c1.jsonl"), claudeLines("c1", cwd).join("\n") + "\n");
  await writeFile(join(codexHome, "sessions", "2026", "09", "30", "rollout-2026-09-30T10-00-00-x1.jsonl"), codexLines("x1", cwd).join("\n") + "\n");
  await writeFile(join(codexHome, "sessions", "2026", "09", "30", "rollout-2026-09-30T10-00-01-x2.jsonl"), codexLines("x2", cwd, { parent: "x1" }).join("\n") + "\n");
  await writeFile(join(codexHome, "sessions", "2026", "09", "30", "rollout-2026-09-30T10-00-02-x3.jsonl"), codexLines("x3", cwd, { forkedFrom: "x1" }).join("\n") + "\n");
  await writeFile(join(paseoHome, "projects", "projects.json"), JSON.stringify([{ projectId: "prj_1", rootPath: join(root, "work"), displayName: "work", customName: "工作" }]));
  await writeFile(join(paseoHome, "projects", "workspaces.json"), JSON.stringify([{ workspaceId: "wks_1", projectId: "prj_1", cwd, displayName: "proj", title: "项目" }]));
  await writeFile(join(paseoHome, "agents", "g", "a1.json"), JSON.stringify({ id: "agent-1", provider: "claude", cwd, workspaceId: "wks_1", persistence: { provider: "claude", sessionId: "c1" } }));
  if (options.automation) await addAutomation(root, paseoHome, claudeHome);
  return { root, paseoHome, claudeHome, codexHome, cwd };
}

/** Sessions nobody started by hand, in their own project so the existing counts stay untouched. */
async function addAutomation(root: string, paseoHome: string, claudeHome: string): Promise<void> {
  const bot = join(root, "bots", "cook");
  const projects = join(claudeHome, "projects", "-bots-cook");
  await mkdir(projects, { recursive: true });
  await mkdir(join(paseoHome, "schedules"), { recursive: true });
  await writeFile(join(paseoHome, "schedules", "sch_1.json"), JSON.stringify({ id: "sch_1", name: "夜间巡检", prompt: "你是巡检的一次 run" }));
  const agent = (id: string, sessionId: string, labels: Record<string, string>) =>
    JSON.stringify({ id, provider: "claude", cwd: bot, workspaceId: null, labels, persistence: { provider: "claude", sessionId } });
  await writeFile(join(paseoHome, "agents", "g", "run1.json"), agent("agent-run1", "run1", { "paseo.schedule-id": "sch_1", "paseo.schedule-run": "r1" }));
  // The schedule behind this run was deleted since, and a person typed into the run.
  await writeFile(join(paseoHome, "agents", "g", "run2.json"), agent("agent-run2", "run2", { "paseo.schedule-id": "sch_gone", "paseo.schedule-run": "r2" }));
  await writeFile(join(paseoHome, "agents", "g", "child1.json"), agent("agent-child1", "child1", { "paseo.parent-agent-id": "agent-1" }));
  // Distinct start times: two files with the same first prompt at the same instant would be folded as resumed copies.
  await writeFile(join(projects, "run1.jsonl"), botLines("run1", bot, ["你是巡检的一次 run"], 6).join("\n") + "\n");
  await writeFile(join(projects, "run2.jsonl"), botLines("run2", bot, ["你是巡检的一次 run", "我插一句：先别发"], 7).join("\n") + "\n");
  await writeFile(join(projects, "child1.jsonl"), botLines("child1", bot, ["子任务：整理清单"], 8).join("\n") + "\n");
  await writeFile(join(projects, "empty1.jsonl"), botLines("empty1", bot, [], 9).join("\n") + "\n");
}

/** A transcript starting at `hour` UTC with the given user prompts, each answered once; with none, only injected text and a reply. */
export function botLines(sessionId: string, cwd: string, prompts: string[], hour: number): string[] {
  const rec = (o: Record<string, unknown>) => JSON.stringify({ sessionId, cwd, version: "2.1.0", ...o });
  const user = (ts: string, content: unknown) => rec({ type: "user", timestamp: ts, message: { role: "user", content } });
  const asst = (ts: string, id: string, text: string) => rec({ type: "assistant", timestamp: ts, message: { id, role: "assistant", content: [{ type: "text", text }] } });
  const lines = [JSON.stringify({ type: "permission-mode", permissionMode: "auto", sessionId })];
  if (prompts.length === 0) return [...lines, user(T(hour, 0), "<system-reminder>注入内容</system-reminder>"), asst(T(hour, 0, 5), "m0", "没有收到任务。")];
  prompts.forEach((prompt, i) => { lines.push(user(T(hour, i * 10), prompt), asst(T(hour, i * 10, 5), `m${i}`, "已处理。")); });
  return lines;
}
