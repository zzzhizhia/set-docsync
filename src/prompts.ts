import { input, select, confirm } from "@inquirer/prompts";
import { execFileSync, execSync } from "node:child_process";
import pc from "picocolors";
import type { Config, GitContext, SyncMode, PushTarget, PullSource } from "./index.js";

export async function collectConfig(ctx: GitContext, existing: Config | null): Promise<Config> {
  if (existing) {
    return await handleExistingConfig(ctx, existing);
  }
  return await collectFreshConfig(ctx);
}

async function handleExistingConfig(ctx: GitContext, existing: Config): Promise<Config> {
  console.log(pc.bold("Existing configuration found:"));
  console.log(`  Mode: ${existing.mode}`);
  if (existing.pushTargets.length > 0) {
    for (const t of existing.pushTargets) {
      console.log(`  Push → ${t.dstOwner}/${t.dstRepoName}:${t.dstPath}`);
    }
  }
  if (existing.pullSources.length > 0) {
    for (const s of existing.pullSources) {
      console.log(`  Pull ← ${s.srcOwner}/${s.srcRepoName}:${s.srcPath}`);
    }
  }
  console.log();

  const action = await select<"extend" | "reconfigure">({
    message: "What would you like to do?",
    choices: [
      { value: "extend", name: "Add more targets/sources to existing config" },
      { value: "reconfigure", name: "Reconfigure from scratch" },
    ],
  });

  if (action === "reconfigure") {
    return await collectFreshConfig(ctx);
  }

  // Extend existing config
  const config = { ...existing };

  if (config.mode === "push" || config.mode === "both") {
    console.log(pc.bold("\n── Add push targets ──\n"));
    const newTargets = await collectPushTargets(ctx);
    config.pushTargets = [...config.pushTargets, ...newTargets];
  }

  if (config.mode === "pull" || config.mode === "both") {
    console.log(pc.bold("\n── Add pull sources ──\n"));
    const newSources = await collectPullSources(ctx);
    config.pullSources = [...config.pullSources, ...newSources];
  }

  return config;
}

async function collectFreshConfig(ctx: GitContext): Promise<Config> {
  const mode = await select<SyncMode>({
    message: "Sync mode",
    choices: [
      { value: "push", name: "Push — push docs to target repo(s) on commit" },
      { value: "pull", name: "Pull — pull docs from source repo(s) on schedule" },
      { value: "both", name: "Both — push and pull in one workflow" },
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

    pushSrcBranch = await input({
      message: "Source branch",
      default: ctx.branch || "main",
    });

    pushTargets = await collectPushTargets(ctx);
  }

  let pullDedup = false;
  if (mode === "pull" || mode === "both") {
    console.log(pc.bold("\n── Pull configuration ──\n"));

    pullBranch = await input({
      message: "Branch of this repo to commit pulled docs to",
      default: ctx.branch || "main",
    });

    pullSources = await collectPullSources(ctx);

    pullDedup = await confirm({
      message: "Deduplicate identical files across sources via symlinks?",
      default: false,
    });
  }

  return { mode, pushSrcPath, pushSrcBranch, pushTargets, pullBranch, pullSources, pullDedup };
}

async function collectPushTargets(ctx: GitContext): Promise<PushTarget[]> {
  const targets: PushTarget[] = [];

  do {
    if (targets.length > 0) {
      console.log(pc.dim(`  (${targets.length} target(s) added)\n`));
    }

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

    const dstBranch = await input({
      message: "Target branch",
      default: "main",
    });

    const clean = await confirm({
      message: "Clean target directory before sync?",
      default: true,
    });

    const dedup = await confirm({
      message: "Deduplicate identical files via symlinks?",
      default: false,
    });

    targets.push({ dstOwner, dstRepoName, dstPath, dstBranch, clean, dedup });

    const addMore = await confirm({
      message: "Add another push target?",
      default: false,
    });
    if (!addMore) break;
  } while (true);

  return targets;
}

async function collectPullSources(ctx: GitContext): Promise<PullSource[]> {
  const sources: PullSource[] = [];

  do {
    if (sources.length > 0) {
      console.log(pc.dim(`  (${sources.length} source(s) added)\n`));
    }

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

    const srcBranch = await input({
      message: "Source branch",
      default: "main",
    });

    sources.push({ srcOwner, srcRepoName, srcPath, dstPath, srcBranch });

    const addMore = await confirm({
      message: "Add another pull source?",
      default: false,
    });
    if (!addMore) break;
  } while (true);

  return sources;
}

export async function checkRepos(config: Config): Promise<void> {
  let hasGh = true;
  try {
    execSync("gh --version", { stdio: "ignore" });
  } catch {
    hasGh = false;
  }

  const repos = new Set<string>();
  for (const t of config.pushTargets) repos.add(`${t.dstOwner}/${t.dstRepoName}`);
  for (const s of config.pullSources) repos.add(`${s.srcOwner}/${s.srcRepoName}`);

  if (!hasGh) {
    if (repos.size > 0) {
      console.log(pc.yellow(`⚠ gh CLI not found. Skipping repo checks. Please verify these repos exist: ${[...repos].join(", ")}`));
    }
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

export async function confirmGeneration(config: Config): Promise<boolean> {
  console.log("\n" + pc.bold("Configuration summary:"));
  console.log(`  Mode: ${config.mode}`);

  if (config.mode === "push" || config.mode === "both") {
    console.log();
    console.log(`  ${pc.bold("Push:")}`);
    console.log(`    Source path:   ${config.pushSrcPath}`);
    console.log(`    Source branch: ${config.pushSrcBranch}`);
    for (let i = 0; i < config.pushTargets.length; i++) {
      const t = config.pushTargets[i];
      const flags = [`clean=${t.clean}`];
      if (t.dedup) flags.push("dedup");
      console.log(`    Target ${i + 1}: ${t.dstOwner}/${t.dstRepoName}:${t.dstPath} (${t.dstBranch}) ${flags.join(" ")}`);
    }
  }

  if (config.mode === "pull" || config.mode === "both") {
    console.log();
    console.log(`  ${pc.bold("Pull:")}`);
    console.log(`    Commit branch: ${config.pullBranch}`);
    if (config.pullDedup) console.log(`    Dedup:         enabled (cross-source)`);
    for (let i = 0; i < config.pullSources.length; i++) {
      const s = config.pullSources[i];
      console.log(`    Source ${i + 1}: ${s.srcOwner}/${s.srcRepoName}:${s.srcPath} → ${s.dstPath} (${s.srcBranch})`);
    }
  }

  console.log();
  return confirm({ message: "Generate workflow file?", default: true });
}
