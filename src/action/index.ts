import * as core from "@actions/core";
import { parsePullSource, parsePushTarget } from "../core/parse.js";
import { normalizePath } from "../core/paths.js";
import { runPull, runPush } from "../core/sync.js";

async function run(): Promise<void> {
  const token = core.getInput("token", { required: true });
  const rawSources = core.getMultilineInput("sources").map((s) => s.trim()).filter(Boolean);
  const rawTargets = core.getMultilineInput("targets").map((s) => s.trim()).filter(Boolean);
  const srcPath = core.getInput("src-path") || "docs/";
  const dedup = core.getBooleanInput("dedup");
  const statePath = core.getInput("state-path") || ".github/docsync.json";
  const clean = core.getBooleanInput("clean");

  const event = process.env.GITHUB_EVENT_NAME ?? "";
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const ref = process.env.GITHUB_SHA ?? "HEAD";

  const wantPush = rawTargets.length > 0;
  const wantPull = rawSources.length > 0;

  if (!wantPush && !wantPull) {
    throw new Error("No work to do: set at least one of `sources` (pull) or `targets` (push)");
  }

  // Event-aware gating. workflow_dispatch runs whatever is configured.
  const doPush = wantPush && (event === "push" || event === "workflow_dispatch");
  const doPull = wantPull && (event === "schedule" || event === "workflow_dispatch");

  if (!doPush && !doPull) {
    core.info(`Nothing to do for event '${event}' with the provided inputs`);
    return;
  }

  if (doPush) {
    const targets = rawTargets.map((t) => {
      const parsed = parsePushTarget(t);
      parsed.dstPath = normalizePath(parsed.dstPath);
      return parsed;
    });
    await runPush({
      sourceRepoRoot: workspace,
      srcPath: normalizePath(srcPath),
      targets,
      token,
      dedup,
      clean,
      commitRef: ref.slice(0, 7),
    });
  }

  if (doPull) {
    const sources = rawSources.map((s) => {
      const parsed = parsePullSource(s);
      parsed.srcPath = normalizePath(parsed.srcPath);
      parsed.dstPath = normalizePath(parsed.dstPath);
      return parsed;
    });
    await runPull({
      hubRoot: workspace,
      sources,
      token,
      dedup,
      statePath,
    });
  }
}

run().catch((err: unknown) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
