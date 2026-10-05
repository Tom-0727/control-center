import type { SessionCard } from "../shared/model";
import { dateKey, zonedParts } from "../shared/time";

export function fmtTime(iso: string | number, tz: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--";
  const p = zonedParts(d, tz);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

export function fmtDate(iso: string | number, tz: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return dateKey(d, tz).slice(5);
}

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0分";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "<1分";
  if (minutes < 60) return `${minutes}分`;
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return m ? `${h}时${m}分` : `${h}时`;
}

export const KIND_LABELS: Record<string, string> = {
  question: "提问", interrupt: "打断", denied: "拒绝", memory: "记忆", "memory-index": "记忆索引",
};
export const PROVIDER_LABELS: Record<string, string> = { claude: "Claude", codex: "Codex" };
export const ORIGIN_LABELS: Record<string, string> = { human: "由人发起", scheduled: "定时任务", other: "其他" };

/** Tag for a session nobody started by hand; null for a person's own session. */
export function originTag(s: Pick<SessionCard, "origin" | "launcher">): string | null {
  if (s.launcher?.kind === "schedule") return `定时 · ${s.launcher.name}`;
  if (s.launcher?.kind === "agent") return "agent 委派";
  return s.origin === "other" ? "无人发言" : null;
}
