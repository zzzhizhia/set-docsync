import { input, confirm, select } from "@inquirer/prompts";
import { execFileSync, execSync } from "node:child_process";
import pc from "picocolors";
import type { CLIConfig, GitContext, PullSource, PushTarget, SyncMode } from "./types.js";

type Mode = "push" | "pull" | "both";

export async function collectConfig(ctx: GitContext, existing: CLIConfig | null): Promise<CLIConfig> {
  if (existing) return await handleExistingConfig(ctx, existing);
  return await collectFreshConfig(ctx);
}

async function handleExistingConfig(ctx: GitContext, existing: CLIConfig): Promise<CLIConfig> {
  console.log(pc.bold("Existing configuration found:"));
  for (const t of existing.pushTargets) {
    console.log(`  Push → ${t.dstOwner}/${t.dstRepoName}:${t.dstPath}`);
  }
  for (const s of existing.pullSources) {
    console.log(`  Pull ← ${s.srcOwner}/${s.srcRepoName}:${s.srcPath}`);
  }
  console.log();

  const action = await select<"extend" | "reconfigure">({
    message: "What would you like to do?",
    choices: [
      { value: "extend", name: "Add more targets/sources to existing config" },
      { value: "reconfigure", name: "Reconfigure from scratch" },
    ],
  });

  if (action === "reconfigure") return await collectFreshConfig(ctx);

  const config: CLIConfig = { ...existing };
  if (existing.pushTargets.length > 0) {
    console.log(pc.bold("\n── Add push targets ──\n"));
    config.pushTargets = [...existing.pushTargets, ...(await collectPushTargets(ctx))];
  }
  if (existing.pullSources.length > 0) {
    console.log(pc.bold("\n── Add pull sources ──\n"));
    config.pullSources = [...existing.pullSources, ...(await collectPullSources(ctx))];
  }
  return config;
}

async function collectFreshConfig(ctx: GitContext): Promise<CLIConfig> {
  const mode = await select<Mode>({
    message: "What do you want to sync?",
    choices: [
      { value: "push", name: "Push — push docs to target repo(s) on commit" },
      { value: "pull", name: "Pull — pull docs from source repo(s) on schedule" },
      { value: "both", name: "Both — same workflow does push and pull" },
    ],
  });

  let pushSrcPath = "";
  let pushSrcBranch = "";
  let pushTargets: PushTarget[] = [];
  let pullBranch = "";
  let pullSources: PullSource[] = [];

  if (mode === "push" || mode === "both") {
    console.log(pc.bold("\n── Push configuration ──\n"));
    pushSrcPath = await input({
      message: "Source docs path (relative to repo root)",
      default: "docs/",
      validate: (v) => (v.trim() ? true : "Path cannot be empty"),
    });
    pushSrcBranch = await input({ message: "Source branch", default: ctx.branch || "main" });
    pushTargets = await collectPushTargets(ctx);
  }

  if (mode === "pull" || mode === "both") {
    console.log(pc.bold("\n── Pull configuration ──\n"));
    pullBranch = await input({
      message: "Branch of this repo to commit pulled docs to",
      default: ctx.branch || "main",
    });
    pullSources = await collectPullSources(ctx);
  }

  let pullMode: SyncMode = "copy";
  if (mode === "pull" || mode === "both") {
    pullMode = await select<SyncMode>({
      message: "Pull strategy",
      choices: [
        { value: "copy", name: "Copy — clone + rsync files into this repo" },
        { value: "submodule", name: "Submodule — mount sources as git submodules (bidirectional)" },
      ],
    });
  }

  let clean = true;
  if (mode === "push" || mode === "both") {
    clean = await confirm({
      message: "Clean each target's destination directory before sync?",
      default: true,
    });
  }

  const dedup = await confirm({
    message: "Deduplicate identical files via symlinks?",
    default: false,
  });

  return { pushSrcPath, pushSrcBranch, pushTargets, pullBranch, pullSources, pullMode, dedup, clean };
}

async function collectPushTargets(ctx: GitContext): Promise<PushTarget[]> {
  const targets: PushTarget[] = [];
  do {
    if (targets.length > 0) console.log(pc.dim(`  (${targets.length} target(s) added)\n`));

    const dstOwner = await input({
      message: "Target repo owner",
      default: ctx.owner || undefined,
      validate: (v) => (v.trim() ? true : "Owner cannot be empty"),
    });
    const dstRepoName = await input({
      message: "Target repo name",
      validate: (v) => (v.trim() ? true : "Repo name cannot be empty"),
    });
    const dstPath = await input({
      message: "Target path (files will be copied here)",
      default: "/",
    });
    const dstBranch = await input({ message: "Target branch", default: "main" });

    targets.push({ dstOwner, dstRepoName, dstPath, dstBranch });
    if (!(await confirm({ message: "Add another push target?", default: false }))) break;
  } while (true);
  return targets;
}

async function collectPullSources(ctx: GitContext): Promise<PullSource[]> {
  const sources: PullSource[] = [];
  do {
    if (sources.length > 0) console.log(pc.dim(`  (${sources.length} source(s) added)\n`));

    const srcOwner = await input({
      message: "Source repo owner",
      default: ctx.owner || undefined,
      validate: (v) => (v.trim() ? true : "Owner cannot be empty"),
    });
    const srcRepoName = await input({
      message: "Source repo name",
      validate: (v) => (v.trim() ? true : "Repo name cannot be empty"),
    });
    const srcPath = await input({
      message: "Source docs path (in the source repo)",
      default: "docs/",
      validate: (v) => (v.trim() ? true : "Path cannot be empty"),
    });
    const dstPath = await input({
      message: "Destination path (in this repo)",
      default: `docs/${srcRepoName}/`,
    });
    const srcBranch = await input({ message: "Source branch", default: "main" });

    sources.push({ srcOwner, srcRepoName, srcPath, dstPath, srcBranch });
    if (!(await confirm({ message: "Add another pull source?", default: false }))) break;
  } while (true);
  return sources;
}

export async function checkRepos(config: CLIConfig): Promise<void> {
  let hasGh = true;
  try {
    execSync("gh --version", { stdio: "ignore" });
  } catch {
    hasGh = false;
  }

  const repos = new Set<string>();
  for (const t of config.pushTargets) repos.add(`${t.dstOwner}/${t.dstRepoName}`);
  for (const s of config.pullSources) repos.add(`${s.srcOwner}/${s.srcRepoName}`);
  if (repos.size === 0) return;

  if (!hasGh) {
    console.log(pc.yellow(`⚠ gh CLI not found. Skipping repo checks. Please verify: ${[...repos].join(", ")}`));
    return;
  }

  for (const repo of repos) {
    try {
      execFileSync("gh", ["api", `repos/${repo}`], { stdio: "ignore" });
      console.log(pc.green(`✓ ${repo} exists`));
    } catch {
      console.log(pc.yellow(`⚠ Cannot access ${repo} (may be private or not yet created)`));
    }
  }
}

export async function confirmGeneration(config: CLIConfig): Promise<boolean> {
  console.log("\n" + pc.bold("Configuration summary:"));

  if (config.pushTargets.length > 0) {
    console.log();
    console.log(`  ${pc.bold("Push:")}`);
    console.log(`    Source path:   ${config.pushSrcPath}`);
    console.log(`    Source branch: ${config.pushSrcBranch}`);
    console.log(`    Clean targets: ${config.clean}`);
    for (let i = 0; i < config.pushTargets.length; i++) {
      const t = config.pushTargets[i];
      console.log(`    Target ${i + 1}: ${t.dstOwner}/${t.dstRepoName}:${t.dstPath} (${t.dstBranch})`);
    }
  }

  if (config.pullSources.length > 0) {
    console.log();
    console.log(`  ${pc.bold("Pull:")}`);
    console.log(`    Commit branch: ${config.pullBranch}`);
    console.log(`    Mode: ${config.pullMode}`);
    for (let i = 0; i < config.pullSources.length; i++) {
      const s = config.pullSources[i];
      console.log(`    Source ${i + 1}: ${s.srcOwner}/${s.srcRepoName}:${s.srcPath} → ${s.dstPath} (${s.srcBranch})`);
    }
  }

  if (config.dedup) {
    console.log();
    console.log(`  Dedup: ${pc.green("enabled")}`);
  }

  console.log();
  return confirm({ message: "Generate workflow file?", default: true });
}
