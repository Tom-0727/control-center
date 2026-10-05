import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig, type ResolvedConfig } from "../server/config.ts";
import { PaseoGateway, ensureCollector } from "../server/gateway.ts";

const local = { id: "srv_local", name: "macbook" };

test("gateway: without a registry only this machine is listed; the paseo-nodes-use scripts are never needed", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-gateway-"));
  try {
    const implicit = resolveConfig(undefined, { PASEO_DEPLOY_DIR: "", SR_CONTROL_CENTER: join(root, "missing-repo") });
    const config: ResolvedConfig = { ...implicit, nodesDir: join(root, "no-such-dir") };
    const gateway = new PaseoGateway(() => config, local);
    assert.deepEqual(await gateway.nodes(), [local]);
    assert.equal((await gateway.registry()).status, "none");
    const explicit = new PaseoGateway(() => ({ ...config, nodesDirExplicit: true }), local);
    const info = await explicit.registry();
    assert.equal(info.status, "missing"); assert.match(info.message, /找不到节点清单/); assert.deepEqual(await explicit.nodes(), [local]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("gateway: a registry adds the other nodes through node.sh with the configured directory, and never duplicates this machine", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-gateway-"));
  try {
    const nodesDir = join(root, "deploy"); await mkdir(nodesDir, { recursive: true });
    await writeFile(join(nodesDir, "relay-allowed-hosts.json"), "[]");
    await writeFile(join(nodesDir, "rows.tsv"), "control\tsrv_local\t中控\nvm\tsrv_vm\tVM-SG\n\n");
    const scripts = join(root, "repo", ".agents/skills/paseo-nodes-use/scripts"); await mkdir(scripts, { recursive: true });
    await writeFile(join(scripts, "node.sh"), '#!/bin/sh\n[ "$1" = list ] || exit 2\ncat "$PASEO_DEPLOY_DIR/rows.tsv"\n');
    await chmod(join(scripts, "node.sh"), 0o700);
    const config = resolveConfig({ nodesDir, controlCenterDir: join(root, "repo") }, {});
    const gateway = new PaseoGateway(() => config, local);
    assert.equal((await gateway.registry()).status, "ready");
    assert.deepEqual(await gateway.nodes(), [{ id: "srv_local", name: "control" }, { id: "srv_vm", name: "vm" }]);
    // The repository directory is wrong: the error names the script instead of failing silently.
    const misplaced = new PaseoGateway(() => ({ ...config, controlCenterDir: join(root, "elsewhere") }), local);
    await assert.rejects(misplaced.nodes(), /node\.sh/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("gateway: the collector bundle is rebuilt only when its sources are newer, and a failed build names the manual command", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-gateway-"));
  try {
    const plugin = join(root, "plugin");
    for (const dir of ["server/sources", "shared", "scripts"]) await mkdir(join(plugin, dir), { recursive: true });
    await writeFile(join(plugin, "server/sources/a.ts"), "a"); await writeFile(join(plugin, "shared/b.ts"), "b"); await writeFile(join(plugin, "scripts/collector.ts"), "c");
    let builds = 0;
    const build = async (dir: string) => { builds++; await mkdir(join(dir, "dist"), { recursive: true }); await writeFile(join(dir, "dist/collector.cjs"), "bundle"); return ""; };
    assert.equal(await ensureCollector(plugin, undefined, build), join(plugin, "dist/collector.cjs"));
    assert.equal(builds, 1);
    await ensureCollector(plugin, undefined, build); assert.equal(builds, 1, "a fresh bundle is reused");
    await new Promise(r => setTimeout(r, 20));
    await writeFile(join(plugin, "server/sources/a.ts"), "changed");
    await ensureCollector(plugin, undefined, build); assert.equal(builds, 2, "a newer source triggers a rebuild");
    await new Promise(r => setTimeout(r, 20));
    await writeFile(join(plugin, "shared/b.ts"), "changed again");
    await assert.rejects(ensureCollector(plugin, undefined, async () => { throw new Error("esbuild missing"); }), /npm run build:collector.*esbuild missing/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
