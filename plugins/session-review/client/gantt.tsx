import type { PluginTheme } from "@getpaseo/plugin";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Decision, SessionCard } from "../shared/model";
import { KIND_LABELS, PROVIDER_LABELS, fmtDate, fmtDuration, fmtTime, originTag } from "./format";
import { Button, Muted, Pill, type Tone } from "./ui";
import { dateKey, dayStartMs, nextDayStartMs } from "../shared/time";

interface Props {
  sessions: SessionCard[];
  theme: PluginTheme;
  compact: boolean;
  timezone: string;
  /** Label each row with its node; off when only this machine is reviewed. */
  showNode: boolean;
  selectedDecision: string | null;
  onPickDecision(sessionId: string, decisionId: string): void;
  onOpenDetail(session: SessionCard): void;
}

const LABEL_WIDTH = 150;
const ROW_HEIGHT = 24;
const HOUR = 3_600_000;
const TONES: Record<string, Tone> = { question: "accent", interrupt: "warning", denied: "danger", memory: "success", "memory-index": "muted" };

/** Whole hours around the data, so the axis starts and ends on a round number. */
function domainOf(sessions: SessionCard[]): { start: number; end: number } {
  const starts = sessions.map((s) => Date.parse(s.startedAt));
  const ends = sessions.map((s) => Date.parse(s.endedAt));
  const first = new Date(Math.floor(Math.min(...starts) / HOUR) * HOUR);
  const lastRaw = Math.max(...ends, first.getTime() + HOUR);
  const last = new Date(Math.floor(lastRaw / HOUR) * HOUR);
  const end = last.getTime() < lastRaw ? last.getTime() + HOUR : last.getTime();
  return { start: first.getTime(), end };
}

function tickStepHours(domainHours: number, width: number): number {
  const maxTicks = Math.max(2, Math.floor(width / 64));
  for (const step of [1, 2, 3, 6, 12, 24]) if (domainHours / step <= maxTicks) return step;
  return 24;
}

export function Gantt({ sessions, theme, compact, timezone: tz, showNode, selectedDecision, onPickDecision, onOpenDetail }: Props) {
  const c = theme.colors;
  const fmtT = (at: string | number) => fmtTime(at, tz), fmtD = (at: string | number) => fmtDate(at, tz);
  const [width, setWidth] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  if (sessions.length === 0) return <Muted theme={theme}>范围内没有会话。</Muted>;

  const toggle = (id: string) => setExpanded((current) => (current === id ? null : id));
  const renderExpanded = (s: SessionCard) => (
    <View style={{ backgroundColor: c.surface1, borderColor: c.border, borderWidth: 1, borderRadius: 8, padding: 10, gap: 8, marginBottom: 6, marginLeft: compact ? 0 : LABEL_WIDTH }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <Pill label={PROVIDER_LABELS[s.provider] ?? s.provider} theme={theme} tone="accent" />
        {originTag(s) ? <Pill label={originTag(s)!} theme={theme} /> : null}
        {showNode && s.nodeName && <Pill label={s.nodeName} theme={theme} />}
        {s.depth > 0 && <Pill label="分叉" theme={theme} />}
        {s.error && <Pill label="无法解析" theme={theme} tone="danger" />}
        {s.branch && <Pill label={s.branch} theme={theme} />}
        {s.hiddenThreads > 0 && <Muted theme={theme}>已折叠 {s.hiddenThreads} 个续写或子线程</Muted>}
      </View>
      <Text style={{ color: c.foreground, fontSize: 14, fontWeight: "600" }}>{s.title}</Text>
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
        本范围内 {fmtD(s.startedAt)} {fmtT(s.startedAt)}–{fmtT(s.endedAt)} · 活跃 {fmtDuration(s.activeMs)} · 等你 {fmtDuration(s.waitMs)} · 你发了 {s.userMessages} 条
      </Text>
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
        整个会话 {fmtD(s.sessionStartedAt)} {fmtT(s.sessionStartedAt)} 开始，{fmtD(s.sessionEndedAt)} {fmtT(s.sessionEndedAt)} 最后活动，共 {s.userMessagesTotal} 条
      </Text>
      {s.error ? <Text style={{ color: c.statusDanger, fontSize: 12 }}>{s.error}</Text> : null}
      {s.warning ? <Text style={{ color: c.statusWarning, fontSize: 12 }}>{s.warning}</Text> : null}
      {s.decisions.filter((d) => d.kind !== "memory-index").length > 0 ? (
        <View style={{ gap: 4 }}>
          {s.decisions.filter((d) => d.kind !== "memory-index").map((d) => <DecisionLine key={d.id} d={d} theme={theme} timezone={tz} />)}
        </View>
      ) : <Muted theme={theme}>这个会话没有决策点。</Muted>}
      <View style={{ flexDirection: "row" }}>
        <Button label="查看消息" theme={theme} onPress={() => onOpenDetail(s)} />
      </View>
    </View>
  );

  if (compact) {
    return (
      <View style={{ gap: 4 }}>
        {sessions.map((s) => (
          <View key={s.id}>
            <Pressable accessibilityRole="button" onPress={() => toggle(s.id)} style={{ flexDirection: "row", gap: 8, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: c.border }}>
              <View style={{ flex: 2 }}>{showNode && <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 10 }}>{s.nodeName}</Text>}<Text numberOfLines={1} style={{ color: s.error ? c.statusDanger : c.foreground, fontSize: 12 }}>{s.depth ? "↳ " : ""}{s.title}</Text></View>
              <Text style={{ color: c.foregroundMuted, fontSize: 12, flex: 1 }}>{fmtT(s.startedAt)}–{fmtT(s.endedAt)}</Text>
              <Text style={{ color: c.foregroundMuted, fontSize: 12, width: 52, textAlign: "right" }}>{fmtDuration(s.activeMs)}</Text>
              <Text style={{ color: c.foregroundMuted, fontSize: 12, width: 56, textAlign: "right" }}>等{fmtDuration(s.waitMs)}</Text>
            </Pressable>
            {expanded === s.id && renderExpanded(s)}
          </View>
        ))}
      </View>
    );
  }

  const domain = domainOf(sessions);
  const span = domain.end - domain.start;
  const x = (iso: string | number) => ((typeof iso === "number" ? iso : Date.parse(iso)) - domain.start) / span * width;
  const step = tickStepHours(span / HOUR, width);
  // Ticks are anchored to midnight in the review timezone so they land on 00:00, 06:00, 12:00 … regardless of when the first session started.
  const dayStart = dayStartMs(dateKey(new Date(domain.start), tz), tz);
  const ticks: number[] = [];
  for (let t = dayStart; t <= domain.end; t += step * HOUR) if (t >= domain.start) ticks.push(t);
  const midnights: number[] = [];
  for (let t = dayStart; t <= domain.end; t = nextDayStartMs(t, tz)) if (t >= domain.start) midnights.push(t);
  const multiDay = fmtD(domain.start) !== fmtD(domain.end - 1);
  const showHours = step < 24;
  const dateLabels = multiDay ? (midnights[0] === domain.start ? midnights : [domain.start, ...midnights]) : [];

  return (
    <View style={{ gap: 2 }}>
      <View style={{ flexDirection: "row" }}>
        <View style={{ width: LABEL_WIDTH, justifyContent: "flex-end" }}>
          <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>{multiDay ? `${fmtD(domain.start)} 至 ${fmtD(domain.end - 1)}` : fmtD(domain.start)}</Text>
        </View>
        <View style={{ flex: 1, height: 30 }} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
          {width > 0 && dateLabels.map((t) => (
            <Text key={`d${t}`} style={{ position: "absolute", left: x(t) + 2, top: 0, color: c.foreground, fontSize: 10, fontWeight: "600" }}>{fmtD(t)}</Text>
          ))}
          {width > 0 && showHours && ticks.map((t) => (
            <Text key={t} style={{ position: "absolute", left: x(t) + 2, top: multiDay ? 15 : 8, color: c.foregroundMuted, fontSize: 10 }}>{fmtT(new Date(t).toISOString())}</Text>
          ))}
        </View>
      </View>
      {sessions.map((s) => (
        <View key={s.id}>
          <Pressable accessibilityRole="button" accessibilityLabel={`展开 ${s.title}`} onPress={() => toggle(s.id)} style={{ flexDirection: "row", alignItems: "center", height: ROW_HEIGHT, backgroundColor: expanded === s.id ? c.surface1 : "transparent", borderRadius: 4 }}>
            <View style={{ width: LABEL_WIDTH, paddingRight: 8, paddingLeft: s.depth ? 12 : 2, flexDirection: "row", gap: 6, alignItems: "center" }}>
              <Text style={{ color: c.foregroundMuted, fontSize: 11, width: 36 }}>{fmtT(s.startedAt)}</Text>
              <View style={{ flex: 1 }}>{showNode && <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 9 }}>{s.nodeName}</Text>}<Text numberOfLines={1} style={{ color: s.error ? c.statusDanger : c.foreground, fontSize: 11 }}>{s.depth ? "↳ " : ""}{s.title}</Text></View>
            </View>
            <View style={{ flex: 1, height: ROW_HEIGHT - 8, backgroundColor: c.surface1, borderRadius: 4 }}>
              {width > 0 && ticks.map((t) => (
                <View key={`tick-${t}`} style={{ position: "absolute", left: x(t), top: 0, bottom: 0, width: 1, backgroundColor: c.border }} />
              ))}
              {width > 0 && midnights.map((t) => (
                <View key={`mid-${t}`} style={{ position: "absolute", left: x(t), top: -2, bottom: -2, width: 1, backgroundColor: c.foregroundMuted }} />
              ))}
              {width > 0 && s.spans.map((sp, i) => {
                const left = x(sp.start);
                const w = Math.max(2, x(sp.end) - left);
                return (
                  <View
                    key={`${sp.kind}-${i}`}
                    accessibilityLabel={`${sp.kind === "run" ? "运行" : "等待"} ${fmtT(sp.start)} 到 ${fmtT(sp.end)}`}
                    style={{ position: "absolute", left, width: w, top: sp.kind === "run" ? 0 : 4, bottom: sp.kind === "run" ? 0 : 4, borderRadius: 3, backgroundColor: sp.kind === "run" ? c.accent : c.surface2, borderWidth: sp.kind === "wait" ? 1 : 0, borderColor: c.border }}
                  />
                );
              })}
              {width > 0 && s.decisions.filter((d) => d.kind !== "memory-index").map((d) => {
                const active = selectedDecision === `${s.id}:${d.id}`;
                return (
                  <Pressable
                    key={d.id}
                    accessibilityRole="button"
                    accessibilityLabel={`决策点 ${fmtT(d.at)} ${d.excerpt}`}
                    onPress={() => onPickDecision(s.id, d.id)}
                    hitSlop={6}
                    style={{ position: "absolute", left: x(d.at) - 5, top: (ROW_HEIGHT - 8) / 2 - 5, width: 10, height: 10, borderRadius: 5, backgroundColor: active ? c.statusWarning : c.foreground, borderWidth: 1.5, borderColor: c.surface0 }}
                  />
                );
              })}
            </View>
          </Pressable>
          {expanded === s.id && renderExpanded(s)}
        </View>
      ))}
      <View style={{ flexDirection: "row", gap: 12, marginTop: 4, marginLeft: LABEL_WIDTH }}>
        <Legend color={c.accent} label="运行" theme={theme} />
        <Legend color={c.surface2} label="等待你" theme={theme} border />
        <Legend color={c.foreground} label="决策点" theme={theme} round />
        <Muted theme={theme} size={11}>点一行展开</Muted>
      </View>
    </View>
  );
}

function DecisionLine({ d, theme, timezone }: { d: Decision; theme: PluginTheme; timezone: string }) {
  const c = theme.colors;
  return (
    <View style={{ gap: 2 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Text style={{ color: c.foregroundMuted, fontSize: 11, width: 40 }}>{fmtTime(d.at, timezone)}</Text>
        <Pill label={KIND_LABELS[d.kind] ?? d.kind} theme={theme} tone={TONES[d.kind] ?? "muted"} />
        <Text style={{ color: c.foreground, fontSize: 12, flex: 1 }}>{d.excerpt}</Text>
      </View>
      {d.answer ? <Text style={{ color: c.foregroundMuted, fontSize: 12, marginLeft: 46 }}>你：{d.answer}</Text> : null}
      {d.detail && d.kind !== "question" ? <Text style={{ color: c.foregroundMuted, fontSize: 12, marginLeft: 46 }}>{d.detail}</Text> : null}
      {d.next ? <Text style={{ color: c.foregroundMuted, fontSize: 12, marginLeft: 46 }}>随后：{d.next}</Text> : null}
    </View>
  );
}

function Legend({ color, label, theme, border, round }: { color: string; label: string; theme: PluginTheme; border?: boolean; round?: boolean }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      <View style={{ width: round ? 8 : 14, height: 8, borderRadius: round ? 4 : 2, backgroundColor: color, borderWidth: border ? 1 : 0, borderColor: theme.colors.border }} />
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{label}</Text>
    </View>
  );
}
