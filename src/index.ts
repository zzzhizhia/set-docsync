import { execSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import pc from "picocolors";
import { collectConfig, checkRepos, confirmGeneration } from "./prompts.js";
import { normalizeConfig, generateYaml, writeWorkflow, readExistingConfig } from "./workflow.js";

export interface GitContext {
  root: string;
  owner: string;
  repo: string;
  branch: string;
}

export type SyncMode = "push" | "pull" | "both";

export interface PushTarget {
  dstOwner: string;
  dstRepoName: string;
  dstPath: string;
  dstBranch: string;
  clean: boolean;
}

export interface PullSource {
  srcOwner: string;
  srcRepoName: string;
  srcPath: string;
  dstPath: string;
  srcBranch: string;
}

export interface Config {
  mode: SyncMode;
  // Push
  pushSrcPath: string;
  pushSrcBranch: string;
  pushTargets: PushTarget[];
  // Pull
  pullBranch: string;
  pullSources: PullSource[];
}

export function parseRemoteURL(url: string): { owner: string; repo: string } {
  // SSH: git@github.com:owner/repo.git
  const sshMatch = url.match(/(?:^|[@/])github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };

  // HTTPS: https://github.com/owner/repo.git
  const httpsMatch = url.match(/[:\/]github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };

  return { owner: "", repo: "" };
}

function detectGitContext(): GitContext {
  const run = (cmd: string) => execSync(cmd, { encoding: "utf-8" }).trim();

  const root = run("git rev-parse --show-toplevel");
  const branch = run("git branch --show-current");

  let owner = "";
  let repo = "";
  try {
    const remoteURL = run("git remote get-url origin");
    ({ owner, repo } = parseRemoteURL(remoteURL));
  } catch {
    // no origin remote — user will enter manually
  }

  return { root, owner, repo, branch };
}

function printPATReminder(ctx: GitContext): void {
  console.log("\n" + pc.bold("Next: set up a Personal Access Token:"));
  console.log();
  console.log(`  1. Create a PAT with ${pc.cyan("repo")} scope:`);
  console.log(`     https://github.com/settings/tokens/new`);
  console.log();
  console.log(`  2. Add the PAT as a secret on ${pc.bold("this repo")} (where the workflow runs):`);
  console.log(pc.dim(`     gh secret set GITHUB_PAT_DOCSYNC`));
  if (ctx.owner && ctx.repo) {
    console.log();
    console.log(`     Or set it in the browser:`);
    console.log(`     https://github.com/${ctx.owner}/${ctx.repo}/settings/secrets/actions`);
  }
  console.log();
}

async function main(): Promise<void> {
  console.log(pc.bold("\n🔄 set-docsync — Configure docs sync workflow\n"));

  // Phase 1: detect git context
  let ctx: GitContext;
  try {
    ctx = detectGitContext();
  } catch {
    console.error(pc.red("Error: not a git repository. Please run this tool inside a git repo."));
    return process.exit(1);
  }

  if (ctx.owner && ctx.repo) {
    console.log(pc.dim(`Detected repo: ${ctx.owner}/${ctx.repo} (${ctx.branch})\n`));
  }

  // Phase 2: collect config (with existing config if available)
  const existing = readExistingConfig(ctx.root);
  const rawConfig = await collectConfig(ctx, existing);
  const config = normalizeConfig(rawConfig);

  // Phase 3: check repos
  await checkRepos(config);

  // Phase 4: confirm and generate
  const confirmed = await confirmGeneration(config);
  if (!confirmed) {
    console.log("Cancelled.");
    return;
  }

  const yaml = generateYaml(config);
  const written = await writeWorkflow(ctx.root, yaml, config);

  if (written) {
    printPATReminder(ctx);
  }
}

// Only run when executed directly, not when imported by tests.
// Use realpathSync to resolve npm/pnpm symlinks in node_modules/.bin/
const currentFile = fileURLToPath(import.meta.url);
const isDirectRun =
  process.argv[1] != null &&
  resolve(realpathSync(process.argv[1])) === currentFile;

if (isDirectRun) {
  main().catch((err) => {
    if (err?.name === "ExitPromptError") {
      process.exit(0);
    }
    console.error(pc.red(err.message || err));
    process.exit(1);
  });
}
