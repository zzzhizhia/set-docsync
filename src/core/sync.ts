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
  await exec("git", [
    "clone",
    "--depth", "1",
    "--branch", source.srcBranch,
    "--sparse",
    "--filter=blob:none",
    authURL(source.srcOwner, source.srcRepoName, token),
    path,
  ]);
  const sparse = source.srcPath.replace(/\/$/, "");
  if (sparse) {
    await exec("git", ["-C", path, "sparse-checkout", "set", sparse]);
  }
}

async function cleanDstDir(targetRoot: string, dstPath: string): Promise<void> {
  const dst = join(targetRoot, dstPath);
  // Remove contents of dst but preserve the .git dir at the repo root.
  // `find -mindepth 1 ... ! -name .git -exec rm -rf` on the shell, expressed here via rm:
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

      const srcFull = join(opts.sourceRepoRoot, opts.srcPath);
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

      const srcFull = join(srcDir, source.srcPath);
      await rsyncInto(srcFull, dstFull, true);
      await rm(srcDir, { recursive: true, force: true });

      shas[key] = current;
    } finally {
      core.endGroup();
    }
  }

  state.sourceSHAs = shas;
  await writeState(opts.statePath, state);

  if (opts.dedup) {
    const dirs = opts.sources.map((s) => join(opts.hubRoot, s.dstPath).replace(/\/$/, ""));
    const replaced = await dedupeDirs(dirs);
    if (replaced > 0) core.info(`Deduped ${replaced} files across sources`);
  }

  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  await commitAndPush(opts.hubRoot, `docs: pull from source repos @ ${stamp}`);
}
