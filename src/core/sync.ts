import { exec, getExecOutput } from "@actions/exec";
import * as core from "@actions/core";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { PullSource, PushTarget, State } from "./types.js";
import { dedupeDirs } from "./dedup.js";
import { readState, writeState, shaKey } from "./state.js";

function authURL(owner: string, repo: string, token: string): string {
  return `https://x-access-token:${encodeURIComponent(token)}@github.com/${owner}/${repo}.git`;
}

async function gitConfigBot(cwd: string): Promise<void> {
  await exec("git", ["config", "user.name", "github-actions[bot]"], { cwd });
  await exec("git", ["config", "user.email", "github-actions[bot]@users.noreply.github.com"], { cwd });
}

async function commitAndPush(cwd: string, message: string): Promise<boolean> {
  await exec("git", ["add", "-A"], { cwd });
  const { exitCode } = await getExecOutput("git", ["diff", "--cached", "--quiet"], {
    cwd,
    ignoreReturnCode: true,
    silent: true,
  });
  if (exitCode === 0) {
    core.info("No changes to commit");
    return false;
  }
  await gitConfigBot(cwd);
  await exec("git", ["commit", "-m", message], { cwd });
  await exec("git", ["push"], { cwd });
  return true;
}

async function cloneTarget(
  target: PushTarget,
  token: string,
  path: string,
): Promise<void> {
  await exec("git", [
    "clone",
    "--depth", "1",
    "--branch", target.dstBranch,
    authURL(target.dstOwner, target.dstRepoName, token),
    path,
  ]);
}

async function cloneSourceSparse(
  source: PullSource,
  token: string,
  path: string,
): Promise<void> {
  const sparse = source.srcPath.replace(/\/$/, "");
  const args = ["clone", "--depth", "1", "--branch", source.srcBranch];
  // `git clone --sparse` only checks out root-level files; subdirs require
  // an explicit `sparse-checkout set`. Skip --sparse entirely for
  // whole-repo syncs so every file in the tree is materialized.
  if (sparse) {
    args.push("--sparse", "--filter=blob:none");
  }
  args.push(authURL(source.srcOwner, source.srcRepoName, token), path);
  await exec("git", args);
  if (sparse) {
    await exec("git", ["-C", path, "sparse-checkout", "set", sparse]);
  }
}

async function cleanDstDir(targetRoot: string, dstPath: string): Promise<void> {
  const dst = join(targetRoot, dstPath);
  // Wipe dst's contents but keep `.git`: if dstPath is the repo root, a plain
  // `rm -rf "$dst"` would delete .git and break the subsequent git commit/push.
  // The exclusion is also a no-op (safe) for subdir dstPaths where .git lives
  // at the target repo root rather than inside dst.
  await exec("bash", [
    "-c",
    `if [ -d "${dst}" ]; then find "${dst}" -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +; fi`,
  ]);
}

async function rsyncInto(src: string, dst: string, withDelete: boolean): Promise<void> {
  const args = ["-av", "--exclude", ".git"];
  if (withDelete) args.push("--delete");
  args.push(src, dst);
  await exec("rsync", args);
}

async function getHeadSha(
  owner: string,
  repo: string,
  ref: string,
  token: string,
): Promise<string> {
  const { stdout } = await getExecOutput(
    "gh",
    ["api", `repos/${owner}/${repo}/commits/${ref}`, "--jq", ".sha"],
    {
      env: { ...process.env, GH_TOKEN: token },
      silent: true,
    },
  );
  return stdout.trim();
}

export interface PushOptions {
  sourceRepoRoot: string; // workspace where the source was checked out
  srcPath: string;
  targets: PushTarget[];
  token: string;
  dedup: boolean;
  clean: boolean;
  commitRef: string; // used in commit message
}

export async function runPush(opts: PushOptions): Promise<void> {
  if (opts.targets.length === 0) return;

  for (const [i, target] of opts.targets.entries()) {
    const targetDir = `_target_${i}`;
    core.startGroup(`Push → ${target.dstOwner}/${target.dstRepoName}:${target.dstPath}`);
    try {
      await cloneTarget(target, opts.token, targetDir);

      const dstAbs = target.dstPath.replace(/\/$/, "");
      if (opts.clean) {
        await cleanDstDir(targetDir, dstAbs);
      }
      const dstFull = join(targetDir, dstAbs) + "/";
      await mkdir(dstFull, { recursive: true });

      // Trailing slash is load-bearing: `rsync src/ dst/` copies src's
      // contents into dst; `rsync src dst/` copies src itself as a subdir.
      // join() strips trailing slashes, so re-add one here.
      const srcFull = join(opts.sourceRepoRoot, opts.srcPath) + "/";
      await rsyncInto(srcFull, dstFull, false);

      if (opts.dedup) {
        const replaced = await dedupeDirs([dstFull.replace(/\/$/, "")]);
        if (replaced > 0) core.info(`Deduped ${replaced} files`);
      }

      await commitAndPush(
        targetDir,
        `docs: push from ${process.env.GITHUB_REPOSITORY ?? "source"} @ ${opts.commitRef}`,
      );
    } finally {
      await rm(targetDir, { recursive: true, force: true });
      core.endGroup();
    }
  }
}

export interface PullOptions {
  hubRoot: string; // workspace root (user's repo)
  sources: PullSource[];
  token: string;
  dedup: boolean;
  statePath: string;
}

export async function runPull(opts: PullOptions): Promise<void> {
  if (opts.sources.length === 0) return;

  const state: State = await readState(opts.statePath);
  const shas: Record<string, string> = { ...(state.sourceSHAs ?? {}) };
  let syncedAny = false;

  for (const [i, source] of opts.sources.entries()) {
    const key = shaKey(source.srcOwner, source.srcRepoName, source.srcBranch);
    core.startGroup(`Pull ← ${source.srcOwner}/${source.srcRepoName} (${source.srcBranch})`);
    try {
      const current = await getHeadSha(source.srcOwner, source.srcRepoName, source.srcBranch, opts.token);
      const last = shas[key];
      if (last && last === current) {
        core.info(`Unchanged (${current}), skipping clone`);
        continue;
      }

      const srcDir = `_src_${i}`;
      await cloneSourceSparse(source, opts.token, srcDir);

      const dstFull = join(opts.hubRoot, source.dstPath);
      await mkdir(dstFull, { recursive: true });

      // Trailing slash required for "copy contents of". See runPush above.
      const srcFull = join(srcDir, source.srcPath) + "/";
      await rsyncInto(srcFull, dstFull, true);
      await rm(srcDir, { recursive: true, force: true });

      shas[key] = current;
      syncedAny = true;
    } finally {
      core.endGroup();
    }
  }

  state.sourceSHAs = shas;
  await writeState(opts.statePath, state);

  // Skip dedup when every source was unchanged: no rsync ran, no file
  // moved, so there's nothing new to hash. Dedup is idempotent, so the
  // only cost of running it here is a pointless walk+sha256 of the hub.
  // Tradeoff: if the user toggles dedup on *after* a no-change run, the
  // new symlinks only materialize on the next source change. Acceptable
  // because dedup is a background optimization, not a correctness gate.
  if (opts.dedup && syncedAny) {
    const dirs = opts.sources.map((s) => join(opts.hubRoot, s.dstPath).replace(/\/$/, ""));
    const replaced = await dedupeDirs(dirs);
    if (replaced > 0) core.info(`Deduped ${replaced} files across sources`);
  } else if (opts.dedup) {
    core.info("No sources changed; skipping dedup");
  }

  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  await commitAndPush(opts.hubRoot, `docs: pull from source repos @ ${stamp}`);
}
