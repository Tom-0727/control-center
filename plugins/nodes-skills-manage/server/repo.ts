import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Paseo evaluates the plugin bundle from memory, so the directory it registered the plugin from is the only
 * record of where this checkout lives; the plugin sits at <repo>/plugins/nodes-skills-manage.
 */
export function registeredRepoDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    const config = JSON.parse(readFileSync(join(env.PASEO_HOME || join(homedir(), ".paseo"), "config.json"), "utf8"));
    const path = config?.plugins?.["nodes-skills-manage"]?.path;
    return typeof path === "string" && path ? resolve(path, "../..") : undefined;
  } catch { return undefined; }
}
