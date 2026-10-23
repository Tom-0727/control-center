import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Modal, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { overviewRpc, jobsRpc, startRpc, detailRpc, addSourceRpc, removeSourceRpc, sourceSpecSchema,
  type Job, type NodeRow, type Progress, type Source, type SourceSpec, type Start } from "../shared/contracts";

const labels: Record<string, string> = {
  consistent: "一致", missing: "缺失", conflict: "冲突", modified_locally: "本地修改", update_available: "待更新",
  needs_registration: "待接管", link_issue: "链接异常", withdrawn: "待撤回", ready: "已检查", verified: "校验通过",
  verification_failed: "校验未通过", needs_workspace: "请选择工作区", error: "检查失败",
  checking: "检查中", transferring: "传输中", applying: "写入中", verifying: "校验中", finished: "检查结束",
  stale: "待重新检查",
  refresh: "扫描", "check-update": "检查更新", "apply-update": "更新技能库",
  sync: "同步", added: "新增", removed: "移除", modified: "修改",
};
const time = (value?: string) => value ? new Date(value).toLocaleString() : "尚未检查";
const shortRevision = (value: string) => value.startsWith("sha256:") ? value.slice(0, 19) : value.slice(0, 12);
type SourceEntry = Source["sources"][number];
// Git: owner/repo; well-known: the publishing host.
function sourceName(spec: SourceEntry) {
  if (spec.type === "git") return spec.url.replace(/\.git$/, "").split("/").slice(-2).join("/");
  try { return `${new URL(spec.url).host}（发现索引）`; } catch { return spec.id; }
}
const emptyForm = {type: "git" as SourceSpec["type"], id: "", url: "", ref: "", path: "", skills: ""};

export function Skills({theme, layout, host}: PluginSurfaceProps) {
  const overview = useRpc(overviewRpc), fetchJobs = useRpc(jobsRpc), startJob = useRpc(startRpc), getDetail = useRpc(detailRpc);
  const addSource = useRpc(addSourceRpc), removeSource = useRpc(removeSourceRpc);
  const toast = useToast();
  const [form, setForm] = useState(emptyForm);
  const [formOpen, setFormOpen] = useState(false);
  const [formError, setFormError] = useState("");
  const [sourceBusy, setSourceBusy] = useState(false);
  const [removing, setRemoving] = useState<string>();
  const [expandedSource, setExpandedSource] = useState<string>();
  const [source, setSource] = useState<Source>();
  const [nodes, setNodes] = useState<NodeRow[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [workspaces, setWorkspaces] = useState<Record<string, string>>({});
  const [jobs, setJobs] = useState<Job[]>([]);
  const [focus, setFocus] = useState<string>();
  const [taskOpen, setTaskOpen] = useState(false);
  const [taskError, setTaskError] = useState("");
  const [detailName, setDetailName] = useState<string>();
  const [detail, setDetail] = useState<{name: string; body: string}>();
  const [detailError, setDetailError] = useState("");
  const [expandedNode, setExpandedNode] = useState<string>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [retry, setRetry] = useState(0);
  const selectionHost = useRef<string | undefined>(undefined);
  const c = theme.colors;
  const busy = pending || sourceBusy || jobs.some(j => j.status === "running");
  const recent = [...jobs].reverse();
  // Overview carries each node's last recorded check, whether an agent or this page ran it.
  const rows = nodes;
  const nodeTask = recent.find(j => ["refresh", "sync"].includes(j.action));
  const nodeRunning = nodeTask?.status === "running" ? nodeTask.action : undefined;
  const updateTask = recent.find(j => ["check-update", "apply-update"].includes(j.action));
  const checkedUpdate = recent.find(j => j.action === "check-update");
  const hasUpdate = !!source && checkedUpdate?.status === "succeeded" && !checkedUpdate.appliedBy && checkedUpdate.result?.revision !== source.revision;
  const current = jobs.find(j => j.id === focus) || recent[0];
  const selectedSkill = source?.skills.find(s => s.name === detailName);
  const checkedCount = rows.filter(n => n.skills && !n.stale).length;
  const consistentCount = rows.filter(n => n.consistent && !n.stale).length;
  const sourceOf = (id: string) => source?.sources.find(s => s.id === id);
  const sourceLabel = (skill: Source["skills"][number]) => {
    const spec = sourceOf(skill.source);
    return spec ? sourceName(spec) : `${skill.source}（来源已移除，下次更新时移出）`;
  };
  const nodeBadge = (n: NodeRow) => n.stale ? "stale" : n.consistent ? "consistent" : n.status;
  const skillBadge = (n: NodeRow, name?: string) => n.stale ? undefined : n.skills?.find(v => v.name === name)?.status;
  const progressText = (p: Progress) => `${nodes.find(n => n.id === p.node_id)?.name || "控制中心"} · ${labels[p.result?.status || p.phase] || p.phase}`
    + (p.total_bytes ? ` ${Math.round((p.bytes || 0) / p.total_bytes * 100)}%` : "");
  const taskStatus = (job: Job) => job.status === "running" ? "进行中" : job.status === "failed" ? "未完成"
    : job.result?.complete === false ? "部分节点未完成" : "已完成";

  useEffect(() => {
    let cancelled = false;
    setDetail(undefined); setDetailError("");
    if (detailName) void getDetail({name: detailName}).then(value => {
      if (!cancelled) setDetail(value);
    }).catch(e => { if (!cancelled) setDetailError(String(e)); });
    return () => { cancelled = true; };
  }, [detailName, getDetail]);

  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
    async function poll(initial = false) {
      try {
        const next = await fetchJobs({});
        if (stopped) return;
        setJobs(next);
        const running = next.some(j => j.status === "running");
        if (initial || !running) {
          const data = await overview({});
          if (stopped) return;
          setSource(data.source); setNodes(data.nodes);
          if (selectionHost.current !== host.id) {
            setSelected(data.nodes.map(n => n.id)); selectionHost.current = host.id;
          } else setSelected(previous => previous.filter(id => data.nodes.some(n => n.id === id)));
        }
        if (running && !stopped) timer = setTimeout(() => void poll(), 1200);
      } catch (e) { if (!stopped) setError(String(e)); }
    }
    void poll(true);
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [host.id, retry, fetchJobs, overview]);

  async function run(action: Start["action"], previewId?: string) {
    const inCard = action === "apply-update";
    if (inCard) setTaskOpen(true);
    setPending(true); setError(""); setTaskError("");
    try {
      const job = await startJob({action, ...(previewId ? {previewId} : action === "check-update" ? {} : {nodeIds: selected, workspaces})});
      setJobs(previous => [...previous.filter(j => j.id !== job.id), job]); setFocus(job.id); setRetry(n => n + 1);
    } catch (e) { if (inCard) setTaskError(String(e)); else setError(String(e)); }
    finally { setPending(false); }
  }
  function openTask(job: Job) {
    setFocus(job.id); setTaskError(""); setTaskOpen(true);
  }
  async function submitSource() {
    const names = form.skills.split(/[\s,，、]+/).filter(Boolean);
    const parsed = sourceSpecSchema.safeParse({
      id: form.id.trim(), type: form.type, url: form.url.trim(),
      skills: names.length && names.join() !== "*" ? names : "*",
      ...(form.type === "git" && form.ref.trim() ? {ref: form.ref.trim()} : {}),
      ...(form.type === "git" && form.path.trim() ? {path: form.path.trim()} : {}),
    });
    if (!parsed.success) { setFormError(parsed.error.issues.map(i => i.message).join("；")); return; }
    setSourceBusy(true); setFormError("");
    try {
      const result = await addSource(parsed.data);
      setSource(result.source); setFormOpen(false); setForm(emptyForm); setRetry(n => n + 1);
      toast.show(`已登记 ${parsed.data.id}：${result.skills.join("、")}。点击「检查更新」后纳入技能库。`, {variant: "success"});
    } catch (e) { setFormError(String(e)); }
    finally { setSourceBusy(false); }
  }
  async function confirmRemove(id: string) {
    setSourceBusy(true); setError("");
    try {
      const result = await removeSource({id});
      setSource(result.source); setRemoving(undefined); setRetry(n => n + 1);
      toast.show(`已移除来源 ${id}。检查并确认更新后，它的技能移出技能库；再同步时从节点撤回。`, {variant: "success"});
    } catch (e) { setError(String(e)); }
    finally { setSourceBusy(false); }
  }
  const text = {color: c.foreground, fontSize: 14, lineHeight: 21};
  const muted = {...text, color: c.foregroundMuted};
  const heading = {...text, fontSize: 19, lineHeight: 26, fontWeight: "600" as const};
  const card = {backgroundColor: c.surface1, borderWidth: 1, borderColor: c.border, borderRadius: 14, padding: layout.compact ? 16 : 22, gap: 14};
  function Button({children, onPress, disabled = false, primary = false}: {children: ReactNode; onPress: () => void; disabled?: boolean; primary?: boolean}) {
    return <Pressable accessibilityRole="button" accessibilityState={{disabled}} disabled={disabled} onPress={onPress}
      style={({pressed}) => ({paddingVertical: 10, paddingHorizontal: 14, borderRadius: 8, borderWidth: 1,
        borderColor: primary ? c.accent : c.border, backgroundColor: primary ? c.accent : c.surface2, opacity: disabled ? 0.4 : pressed ? 0.7 : 1})}>
      <Text style={{...text, color: primary ? c.accentForeground : c.foreground, fontWeight: "500"}}>{children}</Text>
    </Pressable>;
  }
  const field = (key: "id" | "url" | "ref" | "path" | "skills", label: string, hint: string) => <View key={key} style={{gap: 6}}>
    <Text style={text}>{label}</Text>
    <TextInput value={form[key]} onChangeText={value => setForm(previous => ({...previous, [key]: value}))} placeholder={hint}
      placeholderTextColor={c.foregroundMuted} autoCapitalize="none" autoCorrect={false} editable={!sourceBusy}
      style={{...text, borderWidth: 1, borderColor: c.border, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 10, backgroundColor: c.surface0}} />
  </View>;
  function Badge({status}: {status?: string}) {
    const color = ["consistent", "verified"].includes(status || "") ? c.statusSuccess
      : ["error", "conflict", "modified_locally", "verification_failed"].includes(status || "") ? c.statusDanger
      : status ? c.statusWarning : c.foregroundMuted;
    return <Text style={{...text, color, fontSize: 12}}>{status ? labels[status] || status : "未检查"}</Text>;
  }
  function NodeDetails({node}: {node: NodeRow}) {
    return <View style={{gap: 8}}>
      <Text style={muted}>{time(node.checked_at)}</Text>
      {node.error && <Text selectable style={{...text, color: c.statusDanger}}>{node.error}</Text>}
      {node.status === "needs_workspace" && node.workspaces?.map(w => <Button key={w.workspaceId} disabled={busy}
        onPress={() => setWorkspaces(previous => ({...previous, [node.id]: w.workspaceId}))}>
        {workspaces[node.id] === w.workspaceId ? "✓ " : ""}{w.name || w.directory || w.workspaceId}
      </Button>)}
      {node.stale && <Text style={{...text, color: c.statusWarning}}>技能库已更新，上次检查结果不再适用，请重新扫描此节点。</Text>}
      {!node.stale && node.skills?.filter(s => s.status !== "consistent").map(s => <Text key={s.name} style={text}>{s.name} · {labels[s.status] || s.status}</Text>)}
      <Text style={muted}>节点专属 / 未纳管技能：{node.node_skills?.length ? [...new Set(node.node_skills.map(s => s.name))].join("、") : node.checked_at && node.skills ? "无" : "待检查"}</Text>
    </View>;
  }
  const retryIds = current?.result?.nodes?.filter(n => !["ready", "verified"].includes(n.status || "")).map(n => n.id) || [];

  return <><ScrollView style={{flex: 1, backgroundColor: c.surface0}} contentContainerStyle={{padding: layout.compact ? 14 : 28, gap: 20, paddingBottom: 60}}>
    <View style={{gap: 6}}>
      <Text style={{...muted, fontSize: 12, letterSpacing: 1.5}}>CONTROL CENTER / {host.label}</Text>
      <Text accessibilityRole="header" style={{...heading, fontSize: 28, lineHeight: 36}}>公共 Skills</Text>
      <Text style={muted}>从控制中心维护公共技能，按需分发到各节点。</Text>
    </View>
    {!!error && <View style={card}><Text selectable style={{...text, color: c.statusDanger}}>{error}</Text>
      <Button onPress={() => { setError(""); setRetry(n => n + 1); }}>重新连接并加载</Button></View>}

    <View style={card}>
      <Text accessibilityRole="header" style={heading}>概览</Text>
      <View style={{flexDirection: "row", flexWrap: "wrap", gap: 28}}>
        <View style={{gap: 4}}><Text style={muted}>公共技能</Text><Text style={{...heading, fontSize: 28, lineHeight: 34}}>{source?.skills.length ?? "—"}</Text></View>
        <View style={{gap: 4}}><Text style={muted}>来源</Text><Text style={{...heading, fontSize: 28, lineHeight: 34}}>{source?.sources.length ?? "—"}</Text></View>
        <View style={{gap: 4}}><Text style={muted}>节点</Text><Text style={{...heading, fontSize: 28, lineHeight: 34}}>{source ? nodes.length : "—"}</Text></View>
        <View style={{gap: 4}}><Text style={muted}>已同步节点</Text><Text style={{...heading, fontSize: 28, lineHeight: 34}}>{checkedCount ? `${consistentCount} / ${nodes.length}` : "待检查"}</Text></View>
      </View>
      <View style={{flexDirection: "row", flexWrap: "wrap", gap: 10}}>
        <Button disabled={busy || !source} onPress={() => void run("check-update")}>{updateTask?.action === "check-update" && updateTask.status === "running" ? "检查中…" : "检查更新"}</Button>
        {hasUpdate && <Button primary disabled={busy} onPress={() => openTask(checkedUpdate!)}>更新技能库</Button>}
        {updateTask && (updateTask.status === "failed" || updateTask.action === "apply-update") && <Button onPress={() => openTask(updateTask)}>查看更新{updateTask.status === "running" ? "进度" : "结果"}</Button>}
      </View>
      {updateTask && updateTask.status !== "running" && <Text style={muted}>
        {updateTask.status === "failed" ? "更新检查或执行未完成，请查看结果"
          : hasUpdate ? `发现更新 · ${checkedUpdate?.result?.changes?.length || 0} 个技能有变更`
          : updateTask.action === "apply-update" ? "技能库已更新，可以同步到节点" : "已是最新"}
      </Text>}
    </View>

    <View style={card}>
      <View style={{flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12}}>
        <Text accessibilityRole="header" style={heading}>来源</Text>
        <Button disabled={busy || !source} onPress={() => { setForm(emptyForm); setFormError(""); setFormOpen(true); }}>添加来源</Button>
      </View>
      <Text style={muted}>登记 Git 仓库或 well-known 发现索引。检查更新时逐个拉取并校验，确认后进入技能库。点击来源名称查看地址。</Text>
      {source?.sources.map(spec => <View key={spec.id} style={{gap: 4, paddingTop: 12, borderTopWidth: 1, borderColor: c.border}}>
        <View style={{flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8}}>
          <Pressable accessibilityRole="button" accessibilityLabel={sourceName(spec)}
            onPress={() => setExpandedSource(expandedSource === spec.id ? undefined : spec.id)}>
            <Text style={{...text, fontWeight: "600"}}>{expandedSource === spec.id ? "▾" : "▸"} {sourceName(spec)}</Text>
          </Pressable>
          {removing === spec.id ? <View style={{flexDirection: "row", gap: 8}}>
            <Button disabled={busy} onPress={() => void confirmRemove(spec.id)}>确认移除</Button>
            <Button disabled={sourceBusy} onPress={() => setRemoving(undefined)}>取消</Button>
          </View> : <Button disabled={busy} onPress={() => setRemoving(spec.id)}>移除</Button>}
        </View>
        <Text style={{...muted, fontSize: 12}}>{spec.type === "git" ? "Git 仓库" : "发现索引"} · {spec.skills === "*" ? "纳入全部技能" : `纳入 ${spec.skills.join("、")}`} · 技能库中 {spec.installed.length} 个</Text>
        {expandedSource === spec.id && <View style={{gap: 2}}>
          <Text selectable style={{...muted, fontSize: 12}}>ID：{spec.id}</Text>
          <Text selectable style={{...muted, fontSize: 12}}>地址：{spec.url}</Text>
          {spec.type === "git" && <Text selectable style={{...muted, fontSize: 12}}>分支：{spec.ref || "默认"} · 目录：{spec.path || "仓库根目录"}</Text>}
        </View>}
        {removing === spec.id && <Text style={{...text, color: c.statusWarning}}>
          移除后，确认下一次更新时这些技能移出技能库，之后同步会从节点撤回：{spec.installed.join("、") || "无"}
        </Text>}
      </View>)}
    </View>

    <View style={card}>
      <View style={{flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12}}>
        <Text accessibilityRole="header" style={heading}>节点与技能</Text>
        <View style={{flexDirection: "row", flexWrap: "wrap", gap: 10}}>
          <Button disabled={busy || !selected.length} onPress={() => void run("refresh")}>{nodeRunning === "refresh" ? "扫描中…" : "扫描"}</Button>
          <Button primary disabled={busy || !source || !selected.length} onPress={() => void run("sync")}>{nodeRunning === "sync" ? "同步中…" : "同步"}</Button>
        </View>
      </View>
      <Text style={muted}>已选择 {selected.length} / {nodes.length} 个节点 · 已检查 {checkedCount} / {nodes.length}</Text>
      <Text style={muted}>扫描只查看所选节点的一致状态；同步把技能库直接分发到所选节点并校验，有冲突的节点跳过。</Text>
      {nodeTask && <View style={{backgroundColor: c.surface0, borderRadius: 8, padding: 12, gap: 8}}>
        <View style={{flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8}}>
          <Text style={text}>{labels[nodeTask.action]} · {taskStatus(nodeTask)}</Text>
          <Button onPress={() => openTask(nodeTask)}>{nodeTask.status === "running" ? "查看任务进度" : "查看任务结果"}</Button>
        </View>
        {nodeTask.status === "running" && nodeTask.progress.map((p, i) => <Text key={p.node_id || i} style={muted}>{progressText(p)}</Text>)}
      </View>}
      <View style={{flexDirection: "row", flexWrap: "wrap", gap: 8}}>{rows.map(n => <Pressable key={n.id}
        accessibilityRole="checkbox" accessibilityLabel={n.name} accessibilityState={{checked: selected.includes(n.id), disabled: busy}}
        disabled={busy} onPress={() => setSelected(previous => previous.includes(n.id) ? previous.filter(id => id !== n.id) : [...previous, n.id])}
        style={{padding: 10, borderRadius: 8, borderWidth: 1, borderColor: selected.includes(n.id) ? c.accent : c.border}}>
        <Text style={text}>{selected.includes(n.id) ? "☑" : "☐"} {n.name}</Text>
      </Pressable>)}</View>
      {layout.compact ? rows.map(n => <View key={n.id} style={{gap: 10, paddingVertical: 12, borderTopWidth: 1, borderColor: c.border}}>
        <Text style={{...text, fontWeight: "600"}}>{n.name}</Text><Badge status={nodeBadge(n)} />
        {source?.skills.map(s => <Pressable key={s.name} accessibilityRole="button" accessibilityLabel={s.name} onPress={() => setDetailName(s.name)} style={{flexDirection: "row", justifyContent: "space-between", gap: 8}}>
          <View style={{flex: 1, gap: 3}}><Text style={text}>{s.name}</Text><Text style={{...muted, fontSize: 11}}>来源：{sourceLabel(s)}</Text></View><Badge status={skillBadge(n, s.name)} />
        </Pressable>)}<NodeDetails node={n}/>
      </View>) : <ScrollView horizontal><View style={{minWidth: 470 + 155 * rows.length}}>
        <View style={{flexDirection: "row", paddingVertical: 12, borderBottomWidth: 1, borderColor: c.border}}>
          <Text style={{...muted, width: 240}}>公共技能 · 点击查看详情</Text>
          <Text style={{...muted, width: 230}}>来源</Text>
          {rows.map(n => <Pressable key={n.id} accessibilityRole="button" onPress={() => setExpandedNode(expandedNode === n.id ? undefined : n.id)} style={{width: 155, gap: 5}}>
            <Text style={{...text, fontWeight: "600"}}>{n.name}</Text><Badge status={nodeBadge(n)}/>
          </Pressable>)}
        </View>
        {source?.skills.map(s => <View key={s.name} style={{flexDirection: "row", paddingVertical: 12, borderBottomWidth: 1, borderColor: c.border}}>
          <Pressable accessibilityRole="button" accessibilityLabel={s.name} onPress={() => setDetailName(s.name)} style={{width: 240, paddingRight: 12}}><Text style={text}>{s.name}</Text></Pressable>
          <Text style={{...muted, fontSize: 12, width: 230, paddingRight: 12}}>{sourceLabel(s)}</Text>
          {rows.map(n => <View key={n.id} style={{width: 155}}><Badge status={skillBadge(n, s.name)}/></View>)}
        </View>)}
      </View></ScrollView>}
      {!layout.compact && rows.filter(n => expandedNode === n.id || n.error || n.skills?.some(s => s.status === "withdrawn")).map(n => <View key={n.id} style={{gap: 8}}><Text style={heading}>{n.name}</Text><NodeDetails node={n}/></View>)}
      {!layout.compact && <Text style={muted}>点击节点名称查看检查时间、异常和节点专属技能。</Text>}
    </View>
  </ScrollView>

  <Modal title={detailName || "技能详情"} open={!!detailName} onOpenChange={open => { if (!open) setDetailName(undefined); }}>
    <Modal.Content contentContainerStyle={{padding: layout.compact ? 16 : 24, gap: 16}}>
      {selectedSkill && <>
        <Text style={muted}>来源：{sourceLabel(selectedSkill)}</Text>
        {sourceOf(selectedSkill.source) && <Text selectable style={muted}>{sourceOf(selectedSkill.source)!.url}</Text>}
        <Text selectable style={muted}>上游版本：{shortRevision(selectedSkill.revision)}</Text>
        {!!selectedSkill.description && <Text style={text}>{selectedSkill.description}</Text>}
      </>}
      <View style={{gap: 8}}>{rows.map(n => <View key={n.id} style={{flexDirection: "row", flexWrap: "wrap", gap: 10, justifyContent: "space-between"}}>
        <Text style={text}>{n.name}</Text><Badge status={skillBadge(n, detailName)}/>
      </View>)}</View>
      {detailError ? <Text style={{...text, color: c.statusDanger}}>{detailError}</Text>
        : <Text selectable style={{...text, fontFamily: "monospace", fontSize: 12}}>{detail && detail.name === detailName ? detail.body : "正在读取技能…"}</Text>}
    </Modal.Content>
  </Modal>

  <Modal title="添加来源" open={formOpen} onOpenChange={open => { if (!sourceBusy) setFormOpen(open); }}>
    <Modal.Content contentContainerStyle={{padding: layout.compact ? 16 : 24, gap: 14}}>
      <View style={{flexDirection: "row", flexWrap: "wrap", gap: 8}}>
        {(["git", "well-known"] as const).map(type => <Button key={type} primary={form.type === type} disabled={sourceBusy}
          onPress={() => setForm(previous => ({...previous, type}))}>{type === "git" ? "Git 仓库" : "well-known 发现索引"}</Button>)}
      </View>
      {field("id", "来源 ID", "小写字母、数字和连字符，例如 team-skills")}
      {form.type === "git"
        ? field("url", "仓库地址", "https://github.com/org/repo.git")
        : field("url", "索引地址", "https://example.com 或 …/.well-known/agent-skills/index.json")}
      {form.type === "git" && field("ref", "分支 / 标签 / commit", "留空为默认分支")}
      {form.type === "git" && field("path", "技能目录", "仓库内相对路径，留空为根目录，例如 skills")}
      {field("skills", "纳入的技能", "留空或 * 表示全部；多个用逗号分隔")}
      {!!formError && <Text selectable style={{...text, color: c.statusDanger}}>{formError}</Text>}
      <Text style={muted}>提交时会实际拉取一次来源并检查重名。登记只修改来源列表；点击「检查更新」确认后才进入技能库。</Text>
      <Button primary disabled={sourceBusy || !form.id.trim() || !form.url.trim()} onPress={() => void submitSource()}>
        {sourceBusy ? "正在验证来源…" : "验证并登记"}
      </Button>
    </Modal.Content>
  </Modal>

  <Modal title={current && !pending ? labels[current.action] : "准备任务"} open={taskOpen} onOpenChange={setTaskOpen}>
    <Modal.Content contentContainerStyle={{padding: layout.compact ? 16 : 24, gap: 16}}>
      {!!taskError && <Text selectable style={{...text, color: c.statusDanger}}>{taskError}</Text>}
      {pending && <Text style={muted}>正在准备任务…</Text>}
      {current && !pending && <>
        <Text style={{...text, fontWeight: "600"}}>{labels[current.action]} · {taskStatus(current)}</Text>
        <Text style={muted}>{time(current.createdAt)}{current.result?.source ? ` · 技能库版本 ${current.result.source.revision.slice(0, 12)}` : ""}</Text>
        {current.error && <Text selectable style={{...text, color: c.statusDanger}}>{current.error}</Text>}
        {current.status === "running" && <Text style={muted}>关闭卡片后任务继续，可在原操作区域重新查看。</Text>}
        {current.status === "running" && current.progress.map((p, i) => <Text key={p.node_id || i} style={text}>{progressText(p)}</Text>)}
        {current.result?.changes && <>
          <Text style={text}>候选版本：{current.result.revision?.slice(0, 12)} · {current.result.changes.length} 个技能有变化</Text>
          {current.result.changes.map(change => <View key={change.name} style={{gap: 8}}>
            <Text style={{...text, fontWeight: "600", color: change.kind === "removed" ? c.statusDanger : c.foreground}}>{labels[change.kind]} · {change.name}{change.source ? ` · ${sourceOf(change.source) ? sourceName(sourceOf(change.source)!) : change.source}` : ""}</Text>
            {change.files.map(file => <View key={file.path} style={{gap: 4}}><Text style={muted}>{file.path}{file.truncated ? "（差异已截断）" : ""}</Text>
              <ScrollView horizontal style={{maxHeight: 220, backgroundColor: c.surface0, padding: 10}}><Text selectable style={{...text, fontFamily: "monospace", fontSize: 12}}>{file.diff}</Text></ScrollView>
            </View>)}
          </View>)}
          {current.action === "check-update" && current.result.revision !== source?.revision && !current.appliedBy && <>
            <Text style={muted}>更新技能库后，再选择节点同步。</Text>
            <Button primary disabled={busy} onPress={() => void run("apply-update", current.id)}>确认更新技能库</Button>
          </>}
        </>}
        {current.result?.nodes?.map(n => <View key={n.id} style={{gap: 7, borderTopWidth: 1, borderColor: c.border, paddingTop: 12}}>
          <Text style={{...text, fontWeight: "600"}}>{n.name} · {labels[n.status || ""] || n.status}</Text>
          {n.error && <Text selectable style={{...text, color: c.statusDanger}}>{n.error}</Text>}
          {n.no_op && <Text style={muted}>内容和链接已一致，未做变更。</Text>}
          {/* A conflicting node is left untouched, so its planned actions never ran. */}
          {n.plan && n.status !== "conflict" && <>
            {n.plan.adoptions.length > 0 && <Text style={text}>已接管相同内容：{n.plan.adoptions.join("、")}</Text>}
            {n.plan.actions.map((a, i) => <Text selectable key={i} style={{...text, color: a.op === "remove" ? c.statusDanger : c.foreground}}>
              {a.op === "copy" ? "已写入技能" : a.op === "link" ? "已调整链接" : "已移除"} · {a.path}{a.target ? ` → ${a.target}` : ""}
            </Text>)}
            {!n.plan.actions.length && n.plan.state_changed && <Text style={text}>已更新公共技能管理记录。</Text>}
          </>}
          {n.plan?.conflicts.map((v, i) => <Text selectable key={i} style={{...text, color: c.statusDanger}}>冲突：{v.name || v.path} · {v.reason}</Text>)}
        </View>)}
        {current.action === "apply-update" && current.status === "succeeded" && <Text style={text}>技能库已更新。关闭卡片，选择节点后点击「同步」即可分发。</Text>}
        {retryIds.length > 0 && !busy && <Button onPress={() => {setSelected(retryIds); setTaskOpen(false);}}>只选中未完成的节点</Button>}
        {current.status === "failed" && (["check-update", "apply-update"].includes(current.action)
          ? <Button disabled={busy} onPress={() => { setTaskOpen(false); void run("check-update"); }}>重新检查更新</Button>
          : <Button disabled={busy || !selected.length} onPress={() => void run("refresh")}>重新扫描节点</Button>)}
      </>}
    </Modal.Content>
  </Modal>
  </>;
}
