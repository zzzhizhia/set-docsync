import { execSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import pc from "picocolors";
import { collectConfig, checkTargetRepo, confirmGeneration } from "./prompts.js";
import { normalizePath, generateYaml, writeWorkflow } from "./workflow.js";

export interface GitContext {
  root: string;
  owner: string;
  repo: string;
  branch: string;
}

export interface Config {
  srcPath: string;
  srcBranch: string;
  dstOwner: string;
  dstRepoName: string;
  dstPath: string;
  dstBranch: string;
  clean: boolean;
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
  console.log("\n" + pc.bold("📋 接下来你需要设置 Personal Access Token:"));
  console.log();
  console.log(`  1. 创建 PAT (需要 ${pc.cyan("repo")} 权限):`);
  console.log(`     https://github.com/settings/tokens/new`);
  console.log();
  console.log(`  2. 将 PAT 添加为${pc.bold("源仓库")}的 secret（工作流从源仓库运行）:`);
  console.log(pc.dim(`     gh secret set PAT_SYNC_REPO_DOCS_TO_WIKI`));
  if (ctx.owner && ctx.repo) {
    console.log();
    console.log(`     或在浏览器中设置:`);
    console.log(`     https://github.com/${ctx.owner}/${ctx.repo}/settings/secrets/actions`);
  }
  console.log();
}

async function main(): Promise<void> {
  console.log(pc.bold("\n🔄 set-sync-docs — 配置文档同步工作流\n"));

  // Phase 1: detect git context
  let ctx: GitContext;
  try {
    ctx = detectGitContext();
  } catch {
    console.error(pc.red("错误：当前目录不是 git 仓库。请在 git 仓库中运行此工具。"));
    return process.exit(1);
  }

  if (ctx.owner && ctx.repo) {
    console.log(pc.dim(`检测到仓库: ${ctx.owner}/${ctx.repo} (${ctx.branch})\n`));
  }

  // Phase 2-3: collect config
  const rawConfig = await collectConfig(ctx);

  const config: Config = {
    ...rawConfig,
    srcPath: normalizePath(rawConfig.srcPath),
    dstPath: normalizePath(rawConfig.dstPath),
  };

  // Phase 4: check target repo
  await checkTargetRepo(config.dstOwner, config.dstRepoName);

  // Phase 5: confirm and generate
  const confirmed = await confirmGeneration(config);
  if (!confirmed) {
    console.log("已取消。");
    return;
  }

  const yaml = generateYaml(config);
  const written = await writeWorkflow(ctx.root, yaml);

  // Phase 6: PAT reminder (only if workflow was written)
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
