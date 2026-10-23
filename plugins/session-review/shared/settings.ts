import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const settingsSchema = z.object({
  /** Directory holding relay-allowed-hosts.json and .private/ pairing links (the paseo-nodes-use convention). Empty: environment or default registry; local-only if absent. */
  nodesDir: z.string().default(""),
  /** Checkout of this repository on this machine; its paseo-nodes-use scripts read the other nodes. Empty: the repository Paseo loaded this plugin from. */
  controlCenterDir: z.string().default(""),
  /** IANA timezone for calendar days and display. Empty: this daemon's local timezone. */
  timezone: z.string().default(""),
});
export type ReviewSettings = z.infer<typeof settingsSchema>;

export const reviewSettings = defineSettings({ id: "session-review", scope: "host", version: 1, schema: settingsSchema });
