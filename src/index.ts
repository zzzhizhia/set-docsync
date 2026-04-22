import { execSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
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
  dedup?: boolean;
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
  pullDedup?: boolean;
  // Last synced commit SHA per "owner/repo@branch" — updated by the pull
  // workflow, preserved across CLI rewrites.
  sourceSHAs?: Record<string, string>;
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
  console.log(pc.dim(`     gh secret set PAT_DOCSYNC`));
  if (ctx.owner && ctx.repo) {
    console.log();
    console.log(`     Or set it in the browser:`);
    console.log(`     https://github.com/${ctx.owner}/${ctx.repo}/settings/secrets/actions`);
  }
  console.log();
}

const USAGE = `Usage: set-docsync [push|pull] [options]

No arguments    Interactive mode

Push mode:
  set-docsync push --src <path> --to <owner/repo:dst_path@branch> [--clean]

Pull mode:
  set-docsync pull --from <owner/repo:src_path:dst_path@branch> [--branch <branch>]

Options:
  --src <path>        Source docs path (default: docs/)
  --branch <branch>   Source/commit branch (default: main)
  --to <target>       Push target — owner/repo[:dst_path][@branch]  (repeatable)
  --from <source>     Pull source — owner/repo[:src_path[:dst_path]][@branch]  (repeatable)
  --clean             Clean target directory before push (default: true)
  --no-clean          Don't clean target directory before push
  --dedup             Replace identical files with symlinks to save space
  -h, --help          Show this help`;

// --to owner/repo:dst_path@branch
export function parsePushTarget(arg: string, clean: boolean, dedup = false): PushTarget {
  const [pathsPart, branch] = arg.split("@");
  const colonIdx = pathsPart.indexOf(":");
  const repo = colonIdx === -1 ? pathsPart : pathsPart.slice(0, colonIdx);
  const dstPath = colonIdx === -1 ? "/" : pathsPart.slice(colonIdx + 1);
  const slashIdx = repo.indexOf("/");
  if (slashIdx === -1) {
    console.error(pc.red(`Error: invalid --to format "${arg}". Expected owner/repo[:path][@branch]`));
    process.exit(1);
  }
  return {
    dstOwner: repo.slice(0, slashIdx),
    dstRepoName: repo.slice(slashIdx + 1),
    dstPath: dstPath || "/",
    dstBranch: branch || "main",
    clean,
    dedup,
  };
}

// --from owner/repo:src_path:dst_path@branch
export function parsePullSource(arg: string): PullSource {
  const [pathsPart, branch] = arg.split("@");
  const parts = pathsPart.split(":");
  const repo = parts[0];
  const slashIdx = repo.indexOf("/");
  if (slashIdx === -1) {
    console.error(pc.red(`Error: invalid --from format "${arg}". Expected owner/repo[:src[:dst]][@branch]`));
    process.exit(1);
  }
  const repoName = repo.slice(slashIdx + 1);
  return {
    srcOwner: repo.slice(0, slashIdx),
    srcRepoName: repoName,
    srcPath: parts[1] || "docs/",
    dstPath: parts[2] || `docs/${repoName}/`,
    srcBranch: branch || "main",
  };
}

function parseCliArgs(): Config | null {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: false,
    options: {
      src: { type: "string" },
      branch: { type: "string" },
      to: { type: "string", multiple: true },
      from: { type: "string", multiple: true },
      clean: { type: "boolean" },
      "no-clean": { type: "boolean" },
      dedup: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }

  const sub = positionals[0];
  if (!sub) return null; // interactive mode

  const clean = values["no-clean"] ? false : (values.clean ?? true);
  const dedup = (values.dedup as boolean | undefined) ?? false;

  if (sub === "push") {
    const toArgs = values.to as string[] | undefined;
    if (!toArgs?.length) {
      console.error(pc.red("Error: --to is required for push mode.\n"));
      console.log(USAGE);
      process.exit(1);
    }
    return {
      mode: "push",
      pushSrcPath: (values.src as string) || "docs/",
      pushSrcBranch: (values.branch as string) || "main",
      pushTargets: toArgs.map((t) => parsePushTarget(t, clean as boolean, dedup)),
      pullBranch: "",
      pullSources: [],
    };
  }

  if (sub === "pull") {
    const fromArgs = values.from as string[] | undefined;
    if (!fromArgs?.length) {
      console.error(pc.red("Error: --from is required for pull mode.\n"));
      console.log(USAGE);
      process.exit(1);
    }
    return {
      mode: "pull",
      pushSrcPath: "",
      pushSrcBranch: "",
      pushTargets: [],
      pullBranch: (values.branch as string) || "main",
      pullSources: fromArgs.map(parsePullSource),
      pullDedup: dedup,
    };
  }

  console.error(pc.red(`Error: unknown command "${sub}".\n`));
  console.log(USAGE);
  process.exit(1);
}

async function main(): Promise<void> {
  // Non-interactive mode: args present
  const cliConfig = parseCliArgs();
  if (cliConfig) {
    let ctx: GitContext;
    try {
      ctx = detectGitContext();
    } catch {
      console.error(pc.red("Error: not a git repository."));
      return process.exit(1);
    }
    const config = normalizeConfig(cliConfig);
    const yaml = generateYaml(config);
    await writeWorkflow(ctx.root, yaml, config, false);
    return;
  }

  // Interactive mode
  console.log(pc.bold("\n🔄 set-docsync — Configure docs sync workflow\n"));

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

  const existing = readExistingConfig(ctx.root);
  const rawConfig = await collectConfig(ctx, existing);
  const config = normalizeConfig(rawConfig);

  await checkRepos(config);

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
