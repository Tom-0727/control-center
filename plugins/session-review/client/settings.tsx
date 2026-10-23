import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsInput, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { reviewSettings, type ReviewSettings } from "../shared/settings";
import { Muted } from "./ui";

/** Every field is optional: with nothing set, this daemon reviews itself in its own timezone. */
export function ReviewSettingsScreen({ theme, layout }: PluginSurfaceProps) {
  const c = theme.colors;
  const settings = useSettings(reviewSettings);
  const [draft, setDraft] = useState<ReviewSettings | null>(null);
  const loaded = useRef<string | null>(null);
  useEffect(() => {
    if (settings.status === "ready" && loaded.current !== settings.revision) { loaded.current = settings.revision; setDraft(settings.values); }
  }, [settings]);

  if (settings.status === "loading") return <View style={{ padding: 20 }}><Muted theme={theme}>读取设置…</Muted></View>;
  if (settings.status === "error") return <View style={{ padding: 20 }}><Text style={{ color: c.statusDanger }}>{settings.error}</Text></View>;
  if (settings.status === "invalid") {
    return (
      <View style={{ padding: 20, gap: 10 }}>
        <Text style={{ color: c.statusDanger }}>已保存的设置无法解析：{settings.error}</Text>
        <SettingsAction label="恢复默认" hint="恢复环境变量或默认配置；没有节点清单时只复盘本机。" actionLabel={settings.saving ? "处理中…" : "恢复默认"} disabled={settings.saving} onPress={() => { void settings.reset(); }} />
      </View>
    );
  }
  if (!draft) return null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings.values);
  const set = (patch: Partial<ReviewSettings>) => setDraft(d => ({ ...d!, ...patch }));

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ padding: layout.compact ? 12 : 20, gap: 14 }}>
      <SettingsSection title="复盘范围" info="这台机器始终会被复盘。要同时复盘其他节点，填写 paseo-nodes-use 使用的节点清单目录。">
        <SettingsInput key={`nodes-${settings.revision}`} label="节点清单目录" placeholder="/home/ubuntu/paseo-deployment"
          hint="含 relay-allowed-hosts.json 与 .private/ 配对链接的目录。留空使用环境变量或默认清单；找不到清单时只复盘本机。"
          initialValue={draft.nodesDir} onChangeText={v => set({ nodesDir: v })} />
        <SettingsInput key={`repo-${settings.revision}`} label="control-center 仓库目录" placeholder="留空使用本插件所在仓库"
          hint="本机的仓库检出位置，读取其他节点时使用其中的 paseo-nodes-use 脚本和采集程序。留空时使用 Paseo 加载本插件的仓库，一般无需填写。"
          initialValue={draft.controlCenterDir} onChangeText={v => set({ controlCenterDir: v })} />
      </SettingsSection>
      <SettingsSection title="显示">
        <SettingsInput key={`tz-${settings.revision}`} label="时区" placeholder="例如 Asia/Singapore"
          hint="日期范围和时间轴使用的 IANA 时区。留空使用环境变量或插件所在节点的时区；跨节点复盘时建议各节点填同一个值。"
          initialValue={draft.timezone} onChangeText={v => set({ timezone: v })} />
      </SettingsSection>
      <SettingsAction label="保存设置" hint={settings.saveError ?? (dirty ? "有未保存的修改" : "已保存")} error={settings.saveError}
        actionLabel={settings.saving ? "保存中…" : "保存"} disabled={!dirty || settings.saving}
        onPress={() => { void settings.save(draft, settings.revision); }} />
    </ScrollView>
  );
}
