import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Text, View } from "react-native";
import { sessionDetailRpc } from "../shared/contracts";
import type { SessionCard } from "../shared/model";
import { KIND_LABELS, fmtTime, originTag } from "./format";
import { Button, Muted, Pill } from "./ui";

export function DetailModal({ session, hostId, theme, timezone, showNode, onClose }: { session: SessionCard | null; hostId: string; theme: PluginTheme; timezone: string; showNode: boolean; onClose(): void }) {
  const getDetail = useRpc(sessionDetailRpc);
  const detail = useInfiniteQuery({
    queryKey: ["session-review", "detail", hostId, session?.nodeId, session?.provider, session?.id],
    queryFn: ({ pageParam }) => getDetail({ provider: session!.provider, id: session!.sourceId ?? session!.id, nodeId: session!.nodeId, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: page => page.nextOffset ?? undefined,
    enabled: !!session,
  });
  const first = detail.data?.pages[0];
  const c = theme.colors;
  return (
    <Modal title={session?.title ?? "会话"} open={!!session} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Modal.Content scrollable>
        {detail.isLoading && <Muted theme={theme}>读取中…</Muted>}
        {detail.error && <Text style={{ color: c.statusDanger }}>{String(detail.error)}</Text>}
        {first && (
          <View style={{ gap: 10 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              {session && originTag(session) ? <Pill label={originTag(session)!} theme={theme} /> : null}
              <Muted theme={theme}>{showNode && session?.nodeName ? `${session.nodeName} · ` : ""}{first.cwd}</Muted>
            </View>
            {first.decisions.length > 0 && (
              <View style={{ gap: 4 }}>
                <Text style={{ color: c.foreground, fontWeight: "600" }}>决策点</Text>
                {first.decisions.map((d) => (
                  <View key={d.id} style={{ flexDirection: "row", gap: 6, alignItems: "flex-start" }}>
                    <Text style={{ color: c.foregroundMuted, fontSize: 11, width: 40, marginTop: 2 }}>{fmtTime(d.at, timezone)}</Text>
                    <Pill label={KIND_LABELS[d.kind] ?? d.kind} theme={theme} />
                    <Text style={{ color: c.foreground, fontSize: 12, flex: 1 }}>{d.excerpt}{d.answer ? `\n你：${d.answer}` : ""}</Text>
                  </View>
                ))}
              </View>
            )}
            <Text style={{ color: c.foreground, fontWeight: "600" }}>消息</Text>
            {detail.data!.pages.flatMap(p => p.messages).map((m, i) => (
              <View key={`${m.at}-${i}`} style={{ backgroundColor: m.role === "user" ? c.surface2 : c.surface1, borderRadius: 8, padding: 8, gap: 2 }}>
                <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>{fmtTime(m.at, timezone)} · {m.role === "user" ? "你" : m.role === "assistant" ? "agent" : "系统"}</Text>
                <Text style={{ color: c.foreground, fontSize: 13 }}>{m.text}</Text>
              </View>
            ))}
            {detail.hasNextPage && <Button theme={theme} label={detail.isFetchingNextPage ? "读取中…" : "更多消息"} disabled={detail.isFetchingNextPage} onPress={() => { void detail.fetchNextPage(); }} />}
          </View>
        )}
      </Modal.Content>
    </Modal>
  );
}
