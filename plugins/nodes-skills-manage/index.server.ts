import type { PluginServerContext } from "@getpaseo/plugin/server";
import { overviewRpc, startRpc, jobsRpc, detailRpc, addSourceRpc, removeSourceRpc } from "./shared/contracts";
import { registeredRepoDir } from "./server/repo";
import { createRunner } from "./server/runner";
import { Jobs } from "./server/jobs";

export default function contribute(server: PluginServerContext) {
  const run = createRunner(process.env.NSM_CONTROL_CENTER || registeredRepoDir());
  const jobs = new Jobs(run);
  const reads = new AbortController();
  server.handle(overviewRpc, async () => overviewRpc.output.parse(await run("overview", {}, () => {}, reads.signal)));
  server.handle(detailRpc, async input => detailRpc.output.parse(await run("skill-detail", input, () => {}, reads.signal)));
  // Source edits take the controller write lock; they only change the source list, not the snapshot or nodes.
  server.handle(addSourceRpc, async input => addSourceRpc.output.parse(await run("add-source", {source: input}, () => {}, reads.signal)));
  server.handle(removeSourceRpc, async input => removeSourceRpc.output.parse(await run("remove-source", input, () => {}, reads.signal)));
  server.handle(startRpc, input => jobs.start(input));
  server.handle(jobsRpc, () => jobs.list());
  return () => { reads.abort(); jobs.dispose(); };
}
