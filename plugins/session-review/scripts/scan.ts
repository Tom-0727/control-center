// Operational smoke test: print only node status/counts, never session messages.
// Runs outside the daemon, so plugin settings do not apply; use SR_CONTROL_CENTER, PASEO_DEPLOY_DIR and SR_TIMEZONE.
import { resolveConfig } from "../server/config.ts";
import { Fleet, localNode } from "../server/fleet.ts";
import { PaseoGateway } from "../server/gateway.ts";
import { resolveHomes } from "../server/paths.ts";
import { countOrigins } from "../server/snapshots.ts";
import { Store } from "../server/store.ts";
import type { Range } from "../shared/model.ts";
const kind = process.argv[2] ?? "today";
const range: Range = ["today", "yesterday", "last7"].includes(kind)
  ? { kind: kind as Range["kind"] }
  : { kind: "custom", from: kind, to: process.argv[3] ?? kind };
const homes = resolveHomes();
const store = new Store(homes.dataDir); await store.init();
const config = resolveConfig(undefined);
const local = await localNode(homes);
const fleet = new Fleet(new PaseoGateway(() => config, local), { homes, store }, local, { timezone: () => config.timezone, warnings: () => config.warnings });
console.log(JSON.stringify({ event: "catalog", local, registry: await new PaseoGateway(() => config, local).registry(), timezone: config.timezone, warnings: config.warnings }));
const result = await fleet.review({ range }, p => console.log(JSON.stringify({ event: "progress", done: p.done, total: p.total, nodes: p.nodes })));
const details = [];
for (const node of result.nodes ?? []) {
  const session = result.sessions.find(s => s.nodeId === node.id && !s.error);
  if (!session) continue;
  try {
    const detail = await fleet.detail(node.id, session.provider, session.sourceId!, 0);
    details.push({ node: node.name, ok: true, pageMessages: detail.messages.length, totalMessages: detail.totalMessages });
  } catch (error) { details.push({ node: node.name, ok: false, error: String(error) }); }
}
console.log(JSON.stringify({ event: "result", from: result.from, to: result.to, timezone: result.timezone, complete: result.complete, warning: result.warning, nodes: result.nodes, overview: result.overview, origins: countOrigins(result.sessions), projects: result.projects?.length, details }));
if (result.nodes?.every(n => n.status !== "succeeded") || details.some(d => !d.ok)) process.exitCode = 1;
