import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registeredRepoDir } from "../server/repo.ts";

test("repo: the repository is two levels above the directory Paseo registered this plugin from", async () => {
  const paseoHome = await mkdtemp(join(tmpdir(), "nsm-repo-"));
  try {
    await writeFile(join(paseoHome, "config.json"), JSON.stringify({plugins: {"nodes-skills-manage": {source: "directory", path: "/srv/center/control-center/plugins/nodes-skills-manage"}}}));
    assert.equal(registeredRepoDir({PASEO_HOME: paseoHome}), "/srv/center/control-center");
    await writeFile(join(paseoHome, "config.json"), JSON.stringify({plugins: {}}));
    assert.equal(registeredRepoDir({PASEO_HOME: paseoHome}), undefined);
    assert.equal(registeredRepoDir({PASEO_HOME: join(paseoHome, "missing")}), undefined);
  } finally { await rm(paseoHome, {recursive: true, force: true}); }
});
