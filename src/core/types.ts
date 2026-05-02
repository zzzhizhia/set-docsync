export type SyncMode = "copy" | "submodule";

export interface PushTarget {
  dstOwner: string;
  dstRepoName: string;
  dstPath: string;
  dstBranch: string;
}

export interface PullSource {
  srcOwner: string;
  srcRepoName: string;
  srcPath: string;
  dstPath: string;
  srcBranch: string;
}

// Runtime state written by the Action into the user's state file
// (default `.github/docsync.json`). Preserved across CLI config rewrites.
export interface State {
  sourceSHAs?: Record<string, string>;
  // CLI also writes its config fields here; they're preserved as unknown
  // extras so both entry points can share the same file.
  [extra: string]: unknown;
}
