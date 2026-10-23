import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_NODES_DIR, registryPath, resolveConfig } from "../server/config.ts";
import { localTimezone } from "../shared/time.ts";

test("config: nothing configured reviews this machine in its own timezone, with node.sh's default registry and the repository Paseo loaded this plugin from", async () => {
  const paseoHome = await mkdtemp(join(tmpdir(), "review-config-"));
  try {
    await writeFile(join(paseoHome, "config.json"), JSON.stringify({ plugins: { "session-review": { source: "directory", path: "/srv/center/control-center/plugins/session-review" } } }));
    const c = resolveConfig(undefined, { PASEO_HOME: paseoHome });
    assert.equal(c.nodesDir, DEFAULT_NODES_DIR); assert.equal(c.nodesDirExplicit, false);
    assert.equal(c.controlCenterDir, "/srv/center/control-center");
    assert.equal(c.timezone, localTimezone()); assert.deepEqual(c.warnings, []);
    assert.equal(registryPath(c), join(DEFAULT_NODES_DIR, "relay-allowed-hosts.json"));
    // Not registered with this Paseo home: the repository stays unknown instead of guessing a path.
    assert.equal(resolveConfig(undefined, { PASEO_HOME: join(paseoHome, "missing") }).controlCenterDir, undefined);
  } finally { await rm(paseoHome, { recursive: true, force: true }); }
});

test("config: settings win over environment, blanks fall through, invalid timezones fall back with a warning", () => {
  const env = { PASEO_DEPLOY_DIR: "/env/deploy", SR_CONTROL_CENTER: "/env/repo", SR_TIMEZONE: "UTC" };
  const fromEnv = resolveConfig({ nodesDir: "  ", controlCenterDir: "", timezone: "" }, env);
  assert.equal(fromEnv.nodesDir, "/env/deploy"); assert.equal(fromEnv.nodesDirExplicit, true);
  assert.equal(fromEnv.controlCenterDir, "/env/repo"); assert.equal(fromEnv.timezone, "UTC");
  const fromSettings = resolveConfig({ nodesDir: "/mac/nodes", controlCenterDir: "/mac/control-center", timezone: "Asia/Singapore" }, env);
  assert.equal(fromSettings.nodesDir, "/mac/nodes"); assert.equal(fromSettings.controlCenterDir, "/mac/control-center"); assert.equal(fromSettings.timezone, "Asia/Singapore");
  const bad = resolveConfig({ timezone: "Mars/Olympus" }, {});
  assert.equal(bad.timezone, localTimezone()); assert.match(bad.warnings[0], /Mars\/Olympus/);
});
