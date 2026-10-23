import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const actionSchema = z.enum(["refresh", "check-update", "apply-update", "sync"]);
export const startSchema = z.object({
  action: actionSchema,
  nodeIds: z.array(z.string().min(1)).min(1).max(100).optional(),
  workspaces: z.record(z.string(), z.string().min(1)).optional(),
  previewId: z.string().optional(),
});
// One upstream entry of source.json; see nodes-skills-manage references/common-source.md.
export const sourceSpecSchema = z.object({
  id: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/, "id 须为小写字母、数字和连字符"),
  type: z.enum(["git", "well-known"]),
  url: z.string().min(1).max(2048),
  ref: z.string().min(1).max(200).optional(),
  path: z.string().max(500).optional(),
  skills: z.union([z.literal("*"), z.array(z.string().min(1).max(128)).min(1).max(200)]),
});
export const sourceSchema = z.object({
  sources: z.array(sourceSpecSchema.extend({installed: z.array(z.string())})),
  revision: z.string(), fingerprint: z.string(), prepared_at: z.string(),
  skills: z.array(z.object({name: z.string(), description: z.string(), digest: z.string(),
    source: z.string(), revision: z.string()})),
});
const planSchema = z.object({
  actions: z.array(z.object({op: z.string(), path: z.string(), target: z.string().optional()})),
  conflicts: z.array(z.object({name: z.string().optional(), path: z.string().optional(), reason: z.string()})),
  adoptions: z.array(z.string()), state_changed: z.boolean(),
});
export const nodeSchema = z.object({
  id: z.string(), name: z.string(), status: z.string().optional(), error: z.string().optional(),
  checked_at: z.string().optional(), workspace: z.string().nullable().optional(),
  workspaces: z.array(z.object({workspaceId: z.string(), name: z.string(), directory: z.string().optional()})).optional(),
  consistent: z.boolean().optional(), stale: z.boolean().optional(), no_op: z.boolean().optional(), plan: planSchema.optional(),
  skills: z.array(z.object({name: z.string(), status: z.string()})).optional(),
  node_skills: z.array(z.object({name: z.string(), path: z.string(), scope: z.string()})).optional(),
});
export const resultSchema = z.object({
  source: sourceSchema.optional(), nodes: z.array(nodeSchema).optional(),
  checked_at: z.string().optional(), revision: z.string().optional(),
  complete: z.boolean().optional(), changed: z.boolean().optional(),
  changes: z.array(z.object({name: z.string(), kind: z.string(), source: z.string().optional(),
    files: z.array(z.object({path: z.string(), diff: z.string(), truncated: z.boolean()}))})).optional(),
});
export const progressSchema = z.object({node_id: z.string().optional(), phase: z.string(),
  bytes: z.number().optional(), total_bytes: z.number().optional(), result: nodeSchema.optional()});
export const jobSchema = z.object({
  id: z.string(), action: actionSchema, status: z.enum(["running", "succeeded", "failed"]),
  createdAt: z.string(), updatedAt: z.string(), progress: z.array(progressSchema),
  result: resultSchema.optional(), error: z.string().optional(), appliedBy: z.string().optional(),
});
export const overviewRpc = defineRpc({name: "overview", input: z.object({}),
  output: z.object({source: sourceSchema, nodes: z.array(nodeSchema)})});
export const startRpc = defineRpc({name: "start", input: startSchema, output: jobSchema});
export const jobsRpc = defineRpc({name: "jobs", input: z.object({}), output: z.array(jobSchema)});
export const detailRpc = defineRpc({name: "detail", input: z.object({name: z.string().min(1).max(128)}),
  output: z.object({name: z.string(), body: z.string()})});
export const addSourceRpc = defineRpc({name: "add-source", input: sourceSpecSchema,
  output: z.object({skills: z.array(z.string()), source: sourceSchema})});
export const removeSourceRpc = defineRpc({name: "remove-source", input: z.object({id: z.string().min(1).max(64)}),
  output: z.object({source: sourceSchema})});
export type Start = z.infer<typeof startSchema>;
export type Job = z.infer<typeof jobSchema>;
export type Result = z.infer<typeof resultSchema>;
export type Source = z.infer<typeof sourceSchema>;
export type SourceSpec = z.infer<typeof sourceSpecSchema>;
export type NodeRow = z.infer<typeof nodeSchema>;
export type Progress = z.infer<typeof progressSchema>;
