import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { catalogRpc, reviewReadRpc, reviewRefreshRpc } from "../shared/contracts";
import type { Origin, Range, Scope, SessionCard } from "../shared/model";
import { localTimezone } from "../shared/time";
import { Decisions } from "./decisions";
import { DetailModal } from "./detail";
import { ORIGIN_LABELS, fmtDate, fmtDuration, fmtTime } from "./format";
import { Gantt } from "./gantt";
import { Button, Choice, Muted, SectionTitle } from "./ui";

export interface ReviewProps {
  theme: PluginTheme;
  compact: boolean;
  hostId: string;
  /** Workspace panel: scope is fixed to that workspace's project. Sidebar surface: null, user picks a project. */
  workspaceId: string | null;
}

const RANGE_OPTIONS = [
  { label: "今天", value: "today" }, { label: "昨天", value: "yesterday" }, { label: "最近 7 天", value: "last7" }, { label: "自定义", value: "custom" },
] as const;

// Paseo remounts panels when the layout flips between compact and wide; keep the chosen scope across remounts.
interface Remembered { pickedProject: string | null; rangeKind: Range["kind"]; customFrom: string; customTo: string; nodeId: string | null; workspaces: Record<string, string>; origin: Origin | null }
const remembered = new Map<string, Remembered>();
const NODE_LABELS = { pending: "等待", running: "读取中", succeeded: "完成", offline: "离线", failed: "失败", needs_workspace: "选择工作区" };

export function Review({ theme, compact, hostId, workspaceId }: ReviewProps) {
  const c = theme.colors;
  const catalogCall = useRpc(catalogRpc), readCall = useRpc(reviewReadRpc), refreshCall = useRpc(reviewRefreshRpc);
  const catalog = useQuery({ queryKey: ["session-review", "catalog", hostId], queryFn: () => catalogCall({}), refetchInterval: 30_000 });

  const memoryKey = `${hostId}:${workspaceId ?? "surface"}`;
  const initial = remembered.get(memoryKey);
  const [pickedProject, setPickedProject] = useState<string | null>(initial?.pickedProject ?? null);
  const [rangeKind, setRangeKind] = useState<Range["kind"]>(initial?.rangeKind ?? "today");
  const [customFrom, setCustomFrom] = useState(initial?.customFrom ?? ""), [customTo, setCustomTo] = useState(initial?.customTo ?? "");
  const [nodeId, setNodeId] = useState<string | null>(initial?.nodeId ?? null);
  const [workspaces, setWorkspaces] = useState<Record<string, string>>(initial?.workspaces ?? {});
  // Review is about work a person took part in; null shows every origin.
  const [origin, setOrigin] = useState<Origin | null>(initial ? initial.origin : "human");
  useEffect(() => { remembered.set(memoryKey, { pickedProject, rangeKind, customFrom, customTo, nodeId, workspaces, origin }); }, [memoryKey, pickedProject, rangeKind, customFrom, customTo, nodeId, workspaces, origin]);

  const [selectedDecision, setSelectedDecision] = useState<string | null>(null);
  const [openSession, setOpenSession] = useState<SessionCard | null>(null);

  const fixedProject = workspaceId ? catalog.data?.workspaces.find((w) => w.id === workspaceId)?.projectId ?? null : null;
  const projectId = workspaceId ? fixedProject : pickedProject;

  // With a single node there is nothing to pick; a stale node choice from a previous registry must not filter everything out.
  const knownNodes = catalog.data?.nodes ?? [];
  const multiNode = knownNodes.length > 1;
  const effectiveNodeId = multiNode && nodeId && knownNodes.some(n => n.id === nodeId) ? nodeId : null;

  const scope: Scope = useMemo(() => ({
    projectId,
    nodeIds: !workspaceId && effectiveNodeId ? [effectiveNodeId] : undefined,
    workspaces,
    origin: origin ?? undefined,
    range: rangeKind === "custom"
      ? { kind: "custom", from: /^\d{4}-\d{2}-\d{2}$/.test(customFrom) ? customFrom : undefined, to: /^\d{4}-\d{2}-\d{2}$/.test(customTo) ? customTo : undefined }
      : { kind: rangeKind },
  }), [projectId, rangeKind, customFrom, customTo, effectiveNodeId, workspaceId, workspaces, origin]);

  const snapshot = useQuery({
    queryKey: ["session-review", "snapshot", hostId, scope, catalog.data?.today, catalog.data?.timezone],
    queryFn: () => readCall(scope),
    enabled: !!catalog.data,
    retry: false,
    refetchInterval: q => q.state.data?.refreshing ? 1500 : 30_000,
  });
  const refresh = useMutation({ mutationFn: () => refreshCall(scope), onSuccess: () => { void snapshot.refetch(); } });
  const result = snapshot.data?.result;
  const tz = result?.timezone ?? catalog.data?.timezone ?? localTimezone();
  const sessions = result?.sessions ?? [];
  const projects = useMemo(() => [...new Map([...(catalog.data?.projects ?? []), ...(result?.projects ?? [])].map(p => [p.id, p])).values()], [catalog.data, result]);
  const loading = catalog.isLoading || snapshot.isLoading;
  const refreshing = snapshot.data?.refreshing || refresh.isPending;
  const error = catalog.error ? String(catalog.error) : refresh.error ? String(refresh.error) : snapshot.error ? String(snapshot.error) : snapshot.data?.error;
  const projectName = projects.find((p) => p.id === projectId)?.name;
  const notices = [...(catalog.data?.warnings ?? []), ...(result?.warning ? [result.warning] : [])];
  const nodeRows = result?.nodes ?? snapshot.data?.progress?.nodes ?? knownNodes;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ padding: compact ? 12 : 20, gap: 14 }}>
      <View style={{ gap: 8 }}>
        <Muted theme={theme}>时间均为 {tz}{catalog.data?.registry ? ` · ${catalog.data.registry.message}` : ""}</Muted>
        {workspaceId === null && multiNode && <Choice theme={theme} value={effectiveNodeId ?? "__all"}
          onChange={v => { setNodeId(v === "__all" ? null : v); setPickedProject(null); }}
          options={[{ label: "全部节点", value: "__all" }, ...knownNodes.map(n => ({ label: n.name, value: n.id }))]} />}
        {workspaceId === null ? (
          <View style={{ gap: 6 }}>
            <Muted theme={theme}>项目</Muted>
            <Choice theme={theme} value={pickedProject ?? "all"} onChange={(v) => setPickedProject(v === "all" ? null : v)}
              options={[{ label: "全部项目", value: "all" }, ...projects.filter(p => !effectiveNodeId || p.nodeId === effectiveNodeId).map((p) => ({ label: p.name, value: p.id }))]} />
          </View>
        ) : (
          <Muted theme={theme}>项目 · {projectName ?? "全部"}</Muted>
        )}
        {result?.origins && (origin !== "human" || result.origins.scheduled + result.origins.other > 0) && (
          <View style={{ gap: 6 }}>
            <Muted theme={theme}>会话来源</Muted>
            <Choice theme={theme} value={origin ?? "__all"} onChange={(v) => setOrigin(v === "__all" ? null : v)}
              options={[
                ...(["human", "scheduled", "other"] as const).map((o) => ({ label: `${ORIGIN_LABELS[o]} ${result.origins![o]}`, value: o })),
                { label: `全部 ${result.origins.human + result.origins.scheduled + result.origins.other}`, value: "__all" as const },
              ]} />
            {result.origins.schedules.length > 0 && <Muted theme={theme}>定时任务：{result.origins.schedules.map((s) => `${s.name} ${s.sessions}`).join(" · ")}</Muted>}
          </View>
        )}
        <View style={{ flexDirection: compact ? "column" : "row", gap: 10, alignItems: compact ? "stretch" : "center", flexWrap: "wrap" }}>
          <Choice theme={theme} value={rangeKind} onChange={(v) => setRangeKind(v)} options={RANGE_OPTIONS} />
          {rangeKind === "custom" && (
            <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
              <TextInput value={customFrom} onChangeText={setCustomFrom} placeholder="2026-09-30" placeholderTextColor={c.foregroundMuted} style={{ color: c.foreground, borderWidth: 1, borderColor: c.border, borderRadius: 6, padding: 6, width: 110, backgroundColor: c.surface1 }} />
              <Muted theme={theme}>至</Muted>
              <TextInput value={customTo} onChangeText={setCustomTo} placeholder="2026-09-30" placeholderTextColor={c.foregroundMuted} style={{ color: c.foreground, borderWidth: 1, borderColor: c.border, borderRadius: 6, padding: 6, width: 110, backgroundColor: c.surface1 }} />
            </View>
          )}
          <Button label={refreshing ? "后台更新中…" : "立即更新"} theme={theme} disabled={loading || refreshing} onPress={() => refresh.mutate()} />
        </View>
        <Muted theme={theme}>每 5 分钟自动更新{result ? ` · 上次采集 ${fmtDate(result.generatedAt, tz)} ${fmtTime(result.generatedAt, tz)}` : ""}</Muted>
        {!result && refreshing && <Muted theme={theme}>首次采集此日期范围，完成后会自动显示；离开页面后仍会继续。</Muted>}
        {refreshing && snapshot.data?.progress ? <Muted theme={theme}>{snapshot.data.progress.phase}{snapshot.data.progress.total ? ` ${snapshot.data.progress.done}/${snapshot.data.progress.total}` : ""}</Muted> : null}
        {error ? <Text style={{ color: c.statusDanger, fontSize: 13 }}>{error}</Text> : null}
        {notices.map((n, i) => <Text key={`notice-${i}`} style={{ color: c.statusWarning, fontSize: 12 }}>{n}</Text>)}
        {nodeRows.map(n => (
          <View key={n.id} style={{ gap: 4, paddingVertical: 4 }}>
            <Text style={{ color: n.status === "offline" || n.status === "failed" ? c.statusWarning : c.foreground, fontSize: 12 }}>{n.id === catalog.data?.local?.id ? `${n.name}（本机）` : n.name} · {NODE_LABELS[n.status]}{n.sessions !== undefined ? ` · ${n.sessions} 个会话` : ""}</Text>
            {n.error && <Muted theme={theme}>{n.error}</Muted>}
            {n.status !== "succeeded" && n.cachedAt && <Muted theme={theme}>显示上次成功采集：{fmtDate(n.cachedAt, tz)} {fmtTime(n.cachedAt, tz)}</Muted>}
            {n.status === "needs_workspace" && <Choice theme={theme} value={workspaces[n.id] ?? ""}
              options={[{ label: "选择现有工作区", value: "" }, ...(n.workspaces ?? []).map(w => ({ label: w.name, value: w.workspaceId }))]}
              onChange={v => { if (v) setWorkspaces(old => ({ ...old, [n.id]: v })); }} />}
          </View>
        ))}
        {result?.complete === false && <Text style={{ color: c.statusWarning, fontSize: 12 }}>部分节点未更新，已保留其上次成功采集的数据；尚无快照的节点暂不计入统计。</Text>}
      </View>

      {result && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14 }}>
          <Stat label="时间跨度" value={result.from === result.to ? result.from : `${result.from} 至 ${result.to}`} theme={theme} />
          <Stat label="会话" value={String(result.overview.sessions)} theme={theme} />
          <Stat label="最大并行" value={String(result.overview.peakParallel)} theme={theme} />
          <Stat label="总活跃" value={fmtDuration(result.overview.activeMs)} theme={theme} />
          <Stat label="等你" value={fmtDuration(result.overview.waitMs)} theme={theme} />
          <Stat label="决策点" value={String(result.overview.decisions)} theme={theme} />
          {result.overview.unparsable > 0 && <Stat label="无法解析" value={String(result.overview.unparsable)} theme={theme} danger />}
        </View>
      )}

      {result && (
        <View style={{ gap: 8 }}>
          <SectionTitle theme={theme}>会话</SectionTitle>
          <Gantt sessions={sessions} theme={theme} compact={compact} timezone={tz} showNode={multiNode} selectedDecision={selectedDecision}
            onPickDecision={(sid, did) => setSelectedDecision(`${sid}:${did}`)} onOpenDetail={setOpenSession} />
          <SectionTitle theme={theme}>决策点</SectionTitle>
          <Decisions sessions={sessions} theme={theme} timezone={tz} selected={selectedDecision} onSelect={setSelectedDecision} />
        </View>
      )}

      <DetailModal session={openSession} hostId={hostId} theme={theme} timezone={tz} showNode={multiNode} onClose={() => setOpenSession(null)} />
    </ScrollView>
  );
}

function Stat({ label, value, theme, danger }: { label: string; value: string; theme: PluginTheme; danger?: boolean }) {
  return (
    <View style={{ gap: 2 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{label}</Text>
      <Text style={{ color: danger ? theme.colors.statusDanger : theme.colors.foreground, fontSize: 16, fontWeight: "600" }}>{value}</Text>
    </View>
  );
}
