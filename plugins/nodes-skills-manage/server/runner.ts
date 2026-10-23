import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";

export type Runner = (action: string, input: Record<string, unknown>, progress: (value: unknown) => void,
  signal: AbortSignal) => Promise<unknown>;

export function createRunner(root: string | undefined): Runner {
  return (action, input, progress, signal) => new Promise((resolve, reject) => {
    if (!root) return reject(new Error("无法确定 control-center 仓库目录；请在 daemon 环境设置 NSM_CONTROL_CENTER"));
    const child = spawn("python3", ["-B", join(root, ".agents/skills/nodes-skills-manage/scripts/controller.py"), action],
      {cwd: root, detached: true, stdio: ["pipe", "pipe", "pipe"]});
    let result: unknown, failure: string | undefined, stderr = "", size = 0;
    const stop = () => { if (child.pid) { try { process.kill(-child.pid, "SIGTERM"); } catch {} } };
    signal.addEventListener("abort", stop, {once: true});
    if (signal.aborted) stop();
    const timer = setTimeout(() => { failure = "任务超时，结果未确认；请重新刷新节点状态"; stop(); }, 30 * 60_000);
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(input));
    child.stderr.on("data", data => { stderr = (stderr + data.toString()).slice(-4000); });
    child.stdout.on("data", data => { size += data.length; if (size > 32 * 1024 * 1024) { failure = "任务输出过大"; stop(); } });
    const lines = createInterface({input: child.stdout});
    lines.on("line", line => {
      try {
        const event = JSON.parse(line);
        if (event.event === "progress") progress(event);
        else if (event.event === "result") result = event.result;
        else if (event.event === "error") failure = event.error;
      } catch { failure = "管理脚本返回了无法解析的结果"; }
    });
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", stop); lines.close(); };
    child.on("error", error => { cleanup(); reject(error); });
    child.on("close", code => {
      cleanup();
      if (signal.aborted) reject(new Error("任务已中断，结果未确认；请刷新节点状态"));
      else if (failure || code !== 0 || result === undefined) reject(new Error(failure || stderr || "管理脚本未返回结果"));
      else resolve(result);
    });
  });
}
