import { access } from "node:fs/promises";
import { constants, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ReviewSettings } from "../shared/settings.ts";
import { isValidTimezone, localTimezone } from "../shared/time.ts";
import { resolveHomes } from "./paths.ts";

/** node.sh's own default, so a control node keeps working with no settings at all. */
export const DEFAULT_NODES_DIR = "/home/ubuntu/paseo-deployment";
export const REGISTRY_FILE = "relay-allowed-hosts.json";

export interface ResolvedConfig {
  /** Undefined when neither configured nor recorded in Paseo's plugin registry; only other nodes need it. */
  controlCenterDir: string | undefined;
  nodesDir: string;
  /** The user or environment named the directory, so a missing registry is reported instead of silently ignored. */
  nodesDirExplicit: boolean;
  timezone: string;
  warnings: string[];
}

export function resolveConfig(values: Partial<ReviewSettings> | undefined, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const warnings: string[] = [];
  const pick = (value: string | undefined) => value?.trim() || undefined;
  const controlCenterDir = pick(values?.controlCenterDir) ?? pick(env.SR_CONTROL_CENTER) ?? registeredRepoDir(env);
  const configuredNodes = pick(values?.nodesDir) ?? pick(env.PASEO_DEPLOY_DIR);
  let timezone = pick(values?.timezone) ?? pick(env.SR_TIMEZONE) ?? localTimezone();
  if (!isValidTimezone(timezone)) { warnings.push(`时区「${timezone}」无效，已改用本机时区 ${localTimezone()}`); timezone = localTimezone(); }
  return { controlCenterDir, nodesDir: configuredNodes ?? DEFAULT_NODES_DIR, nodesDirExplicit: !!configuredNodes, timezone, warnings };
}

/**
 * Paseo evaluates the plugin bundle from memory, so the directory it registered the plugin from is the only
 * record of where this checkout lives; the plugin sits at <repo>/plugins/session-review.
 */
export function registeredRepoDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    const config = JSON.parse(readFileSync(join(resolveHomes(env).paseoHome, "config.json"), "utf8"));
    const path = config?.plugins?.["session-review"]?.path;
    return typeof path === "string" && path ? resolve(path, "../..") : undefined;
  } catch { return undefined; }
}

export const registryPath = (config: Pick<ResolvedConfig, "nodesDir">) => join(config.nodesDir, REGISTRY_FILE);

export async function readable(path: string): Promise<boolean> {
  try { await access(path, constants.R_OK); return true; } catch { return false; }
}
