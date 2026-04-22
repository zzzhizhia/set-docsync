import { execSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import pc from "picocolors";
import { parsePullSource, parsePushTarget, parseRemoteURL } from "../core/parse.js";
import { collectConfig, checkRepos, confirmGeneration } from "./prompts.js";
import { generateYaml, normalizeConfig, readExistingConfig, writeWorkflow } from "./workflow.js";
import type { CLIConfig, GitContext } from "./types.js";

export { parseRemoteURL, parsePushTarget, parsePullSource };
export type { CLIConfig, GitContext };

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
    /* no origin — user will enter manually */
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
    console.log(`     Or in the browser:`);
    console.log(`     https://github.com/${ctx.owner}/${ctx.repo}/settings/secrets/actions`);
  }
  console.log();
}

const USAGE = `Usage: set-docsync [push|pull] [options]

No arguments    Interactive mode

Push mode:
  set-docsync push --src <path> --to <owner/repo:dst_path@branch> [--no-clean]

Pull mode:
  set-docsync pull --from <owner/repo:src_path:dst_path@branch> [--branch <branch>]

Options:
  --src <path>        Source docs path (default: docs/)
  --branch <branch>   Source/commit branch (default: main)
  --to <target>       Push target — owner/repo[:dst_path][@branch]  (repeatable)
  --from <source>     Pull source — owner/repo[:src_path[:dst_path]][@branch]  (repeatable)
  --no-clean          Don't clean target directory before push
  --dedup             Replace identical files with symlinks
  -h, --help          Show this help`;

function parseCliArgs(): CLIConfig | null {
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
  if (!sub) return null;

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
      pushSrcPath: (values.src as string) || "docs/",
      pushSrcBranch: (values.branch as string) || "main",
      pushTargets: toArgs.map((t) => parsePushTarget(t)),
      pullBranch: "",
      pullSources: [],
      dedup,
      clean: clean as boolean,
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
      pushSrcPath: "",
      pushSrcBranch: "",
      pushTargets: [],
      pullBranch: (values.branch as string) || "main",
      pullSources: fromArgs.map(parsePullSource),
      dedup,
      clean: true, // irrelevant for pull-only; kept for CLIConfig uniformity
    };
  }

  console.error(pc.red(`Error: unknown command "${sub}".\n`));
  console.log(USAGE);
  process.exit(1);
}

async function main(): Promise<void> {
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

  if (written) printPATReminder(ctx);
}

const currentFile = fileURLToPath(import.meta.url);
const isDirectRun =
  process.argv[1] != null && resolve(realpathSync(process.argv[1])) === currentFile;

if (isDirectRun) {
  main().catch((err) => {
    if (err?.name === "ExitPromptError") process.exit(0);
    console.error(pc.red(err.message || err));
    process.exit(1);
  });
}
