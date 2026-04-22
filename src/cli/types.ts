import type { PullSource, PushTarget } from "../core/types.js";
export type { PullSource, PushTarget } from "../core/types.js";

export interface GitContext {
  root: string;
  owner: string;
  repo: string;
  branch: string;
}

export interface CLIConfig {
  // Push (targets exist → generated workflow triggers on push events)
  pushSrcPath: string;
  pushSrcBranch: string;
  pushTargets: PushTarget[];
  // Pull (sources exist → generated workflow triggers on schedule)
  pullBranch: string;
  pullSources: PullSource[];
  // Single global toggles (applied to every push target / pull source)
  dedup: boolean;
  clean: boolean;
  // Runtime state written by the Action. The CLI preserves this field
  // across rewrites so reconfiguring doesn't re-trigger full pulls.
  sourceSHAs?: Record<string, string>;
}
