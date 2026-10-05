import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { RegistryInfo } from "../shared/contracts.ts";
import { readable, registryPath, type ResolvedConfig } from "./config.ts";
import { redactText } from "./redact.ts";

export interface NodeTarget { id: string; name: string }
export interface Workspace { workspaceId: string; name: string; cwd?: string; project?: string }
export interface Gateway {
  /** Every node to review. This machine is always included, so the list never depends on a registry. */
  nodes(signal?: AbortSignal): Promise<NodeTarget[]>;
  registry?(): Promise<RegistryInfo>;
  workspaces(node: NodeTarget, signal?: AbortSignal): Promise<Workspace[]>;
  collect(node: NodeTarget, workspace: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
export function command(file: string, args: string[], signal?: AbortSignal, timeout = 65000, env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("任务已中断")); return; }
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], detached: true, env: env ? { ...process.env, ...env } : process.env });
    let stdout = "", stderr = "", failure = "";
    const stop = () => { if (child.pid) { try { process.kill(-child.pid, "SIGTERM"); } catch {} } };
    const abort = () => { failure = "任务已中断"; stop(); };
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { failure = "节点响应超时，请重试"; stop(); }, timeout);
    child.stdout.on("data", data => { stdout += data; if (stdout.length > 8 * 1024 * 1024) { failure = "节点输出超过安全传输上限"; stop(); } });
    child.stderr.on("data", data => { stderr = (stderr + data).slice(-4000); });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    child.on("error", error => { cleanup(); reject(error); });
    child.on("close", code => {
      cleanup();
      let detail = stderr.replace(/^\[node\].*$/gm, "").trim();
      try { const e = JSON.parse(stdout).error; if (e) detail = typeof e === "string" ? e : `${e.code ?? ""}: ${e.message ?? "节点命令失败"}`; } catch {}
      if (failure || code) reject(new Error(redactText(failure || detail || stdout.slice(-1200) || "节点命令失败")));
      else resolve(stdout);
    });
  });
}

async function newestMtime(path: string): Promise<number> {
  const info = await stat(path);
  if (!info.isDirectory()) return info.mtimeMs;
  const children = await readdir(path);
  const times = await Promise.all(children.map(child => newestMtime(join(path, child))));
  return Math.max(info.mtimeMs, ...times);
}

/**
 * The collector bundle is a build product that is not committed, so a freshly pulled checkout rebuilds it
 * before the next remote collection; a plain plugin reload is then enough to pick up new code.
 */
export async function ensureCollector(pluginDir: string, signal?: AbortSignal, build = defaultBuild): Promise<string> {
  const bundle = join(pluginDir, "dist/collector.cjs");
  const sources = await Promise.all(["server", "shared", "scripts/collector.ts"].map(name => newestMtime(join(pluginDir, name))));
  const built = await stat(bundle).then(info => info.mtimeMs, () => -1);
  if (built >= Math.max(...sources)) return bundle;
  try { await build(pluginDir, signal); }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`采集程序构建失败，请在仓库目录执行 npm ci 和 npm run build:collector --workspace=session-review：${detail}`);
  }
  return bundle;
}

function defaultBuild(pluginDir: string, signal?: AbortSignal): Promise<string> {
  return command(process.execPath, [join(pluginDir, "scripts/build-collector.mjs")], signal, 120000);
}

export function parseFrame(output: string): any {
  const lines = output.split(/\r?\n/).map(s => s.trim());
  const first = lines.indexOf("SR_BEGIN"), last = lines.indexOf("SR_END", first + 1);
  if (first < 0 || last <= first) throw new Error("节点结果不完整，请重试");
  const data = lines.slice(first + 1, last).join("");
  return JSON.parse(gunzipSync(Buffer.from(data, "base64"), { maxOutputLength: 32 * 1024 * 1024 }).toString());
}

/**
 * Reads other nodes through the paseo-nodes-use scripts when a registry is configured, and never needs one
 * for this machine: the local node is reviewed in-process by the Fleet.
 */
export class PaseoGateway {
  private config: () => ResolvedConfig;
  private local: NodeTarget;
  private installed = new Map<string, Promise<string>>();
  constructor(config: () => ResolvedConfig, local: NodeTarget) { this.config = config; this.local = local; }

  private scripts(config: ResolvedConfig) {
    const dir = join(config.controlCenterDir, ".agents/skills/paseo-nodes-use/scripts");
    return { nodeSh: join(dir, "node.sh"), execSh: join(dir, "exec.sh"), pluginDir: join(config.controlCenterDir, "plugins/session-review") };
  }
  private run(file: string, args: string[], signal?: AbortSignal, timeout?: number): Promise<string> {
    return command(file, args, signal, timeout, { PASEO_DEPLOY_DIR: this.config().nodesDir });
  }

  async registry(): Promise<RegistryInfo> {
    const config = this.config();
    const path = registryPath(config);
    if (await readable(path)) return { status: "ready", path, message: `节点清单 ${path}` };
    if (config.nodesDirExplicit) return { status: "missing", path, message: `找不到节点清单 ${path}，当前只复盘本机` };
    return { status: "none", message: "未配置节点清单，只复盘本机" };
  }

  async nodes(signal?: AbortSignal): Promise<NodeTarget[]> {
    const config = this.config();
    if ((await this.registry()).status !== "ready") return [this.local];
    const { nodeSh } = this.scripts(config);
    if (!(await readable(nodeSh))) throw new Error(`找不到 ${nodeSh}，请在设置中填写本机的 control-center 仓库目录`);
    const rows = await this.run(nodeSh, ["list"], signal);
    const listed = rows.trim().split("\n").filter(Boolean)
      .map(line => { const [name, id] = line.split("\t"); return { name, id }; })
      .filter(n => n.id && n.name);
    // A control node usually lists itself; keep the registry's name but never review this machine twice.
    const self = listed.find(n => n.id === this.local.id);
    return [self ?? this.local, ...listed.filter(n => n.id !== this.local.id)];
  }
  async workspaces(node: NodeTarget, signal?: AbortSignal): Promise<Workspace[]> {
    return JSON.parse(await this.run(this.scripts(this.config()).nodeSh, [node.name, "workspace", "ls", "--json"], signal));
  }
  private execute(node: NodeTarget, workspace: string, code: string, signal?: AbortSignal): Promise<string> {
    return this.run(this.scripts(this.config()).execSh, [node.name, "--workspace", workspace, "--timeout", "300", "--", code], signal, 330000);
  }
  private async install(node: NodeTarget, workspace: string, signal?: AbortSignal): Promise<string> {
    const { nodeSh, pluginDir } = this.scripts(this.config());
    const bundle = await ensureCollector(pluginDir, signal);
    const bytes = await readFile(bundle);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const pathCode = `require('node:path').join(process.env.PASEO_HOME||require('node:path').join(require('node:os').homedir(),'.paseo'),'session-review','collectors','${digest}.cjs')`;
    const probe = `const fs=require('node:fs'),crypto=require('node:crypto'),p=${pathCode};const b=require('node:zlib').gzipSync(JSON.stringify({path:p,exists:fs.existsSync(p)&&crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')==='${digest}'})).toString('base64');console.log('SR_BEGIN\\n'+b.match(/.{1,60}/g).join('\\n')+'\\nSR_END')`;
    const found = parseFrame(await this.execute(node, workspace, `node -e ${quote(probe)}`, signal));
    if (found.exists) return found.path;
    const uploaded = await this.run(nodeSh, [node.name, "sdk-upload", "--timeout", "120", "--", bundle], signal, 420000);
    const result = uploaded.split("\n").filter(Boolean).map(s => JSON.parse(s)).find(e => e.event === "result");
    if (!result || result.sha256 !== `sha256:${digest}`) throw new Error("采集程序上传校验失败");
    const parts = result.parts.map((p: any) => ({ path: p.path, sha256: p.sha256 }));
    // All shell content is quoted; input is only the verified upload metadata.
    const setup = `const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');const parts=${JSON.stringify(parts)};try{const data=Buffer.concat(parts.map(p=>{const b=fs.readFileSync(p.path);if('sha256:'+crypto.createHash('sha256').update(b).digest('hex')!==p.sha256)throw Error('Part checksum mismatch');return b}));if(crypto.createHash('sha256').update(data).digest('hex')!=='${digest}')throw Error('Collector checksum mismatch');const out=${pathCode};fs.mkdirSync(path.dirname(out),{recursive:true,mode:448});const tmp=out+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,data,{mode:384});fs.renameSync(tmp,out);}finally{for(const p of parts){const dir=path.dirname(p.path);if(path.basename(p.path).startsWith('nsm-')&&path.basename(dir).startsWith('upload_')&&path.basename(path.dirname(dir))==='uploads')fs.rmSync(dir,{recursive:true,force:true})}}`;
    await this.execute(node, workspace, `node -e ${quote(setup)}`, signal);
    return found.path;
  }
  async collect(node: NodeTarget, workspace: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    let ready = this.installed.get(node.id);
    if (!ready) { ready = this.install(node, workspace, signal); this.installed.set(node.id, ready); }
    let path: string;
    try { path = await ready; } catch (error) { this.installed.delete(node.id); throw error; }
    const invoke = async (request: Record<string, unknown>) => {
      const encoded = Buffer.from(JSON.stringify(request)).toString("base64");
      const frame = parseFrame(await this.execute(node, workspace, `node ${quote(path)} ${quote(encoded)}`, signal));
      if (frame.error) throw new Error(frame.error);
      return frame;
    };
    const result = await invoke(input);
    if (!result.transfer) return result.value;
    if (!Number.isSafeInteger(result.length) || result.length > 16 * 1024 * 1024 || typeof result.first !== "string") throw new Error("节点结果过大，请收窄范围");
    let encoded: string = result.first;
    try {
      while (encoded.length < result.length) {
        const { chunk } = await invoke({ action: "chunk", token: result.transfer, offset: encoded.length });
        if (typeof chunk !== "string" || !chunk.length) throw new Error("节点结果被截断");
        encoded += chunk;
      }
      return JSON.parse(gunzipSync(Buffer.from(encoded, "base64"), { maxOutputLength: 32 * 1024 * 1024 }).toString()).value;
    } finally { await invoke({ action: "release", token: result.transfer }).catch(() => {}); }
  }
}
