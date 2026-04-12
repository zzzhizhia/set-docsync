import { confirm } from "@inquirer/prompts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./index.js";

export function normalizePath(input: string): string {
  let p = input.trim().replace(/\\/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  while (p.startsWith("/")) p = p.slice(1);
  if (p.split("/").some((s) => s === "..")) {
    throw new Error(`Path traversal ("..") is not allowed: ${input}`);
  }
  if (p && !p.endsWith("/")) p += "/";
  return p;
}

// Quote a YAML scalar to prevent YAML 1.1 keyword coercion (on/yes/no → boolean)
function q(value: string): string {
  return JSON.stringify(value);
}

export function normalizeConfig(raw: Config): Config {
  return {
    ...raw,
    pushSrcPath: raw.pushSrcPath ? normalizePath(raw.pushSrcPath) : "",
    pushTargets: raw.pushTargets.map((t) => ({
      ...t,
      dstPath: normalizePath(t.dstPath),
    })),
    pullSources: raw.pullSources.map((s) => ({
      ...s,
      srcPath: normalizePath(s.srcPath),
      dstPath: normalizePath(s.dstPath),
    })),
  };
}

export function generateYaml(config: Config): string {
  const parts: string[] = [];

  parts.push("name: Sync Docs\n");
  parts.push(generateTriggers(config));
  parts.push("jobs:");

  if (config.mode === "push" || config.mode === "both") {
    parts.push(generatePushJob(config));
  }

  if (config.mode === "pull" || config.mode === "both") {
    parts.push(generatePullJob(config));
  }

  return parts.join("\n") + "\n";
}

function generateTriggers(config: Config): string {
  const triggers: string[] = ["on:"];

  if (config.mode === "push" || config.mode === "both") {
    triggers.push(`  push:`);
    triggers.push(`    branches: [${q(config.pushSrcBranch)}]`);
    triggers.push(`    paths:`);
    triggers.push(`      - "${config.pushSrcPath}**"`);
  }

  if (config.mode === "pull" || config.mode === "both") {
    triggers.push(`  schedule:`);
    triggers.push(`    - cron: "0 0 * * *"`);
  }

  triggers.push(`  workflow_dispatch:\n`);
  return triggers.join("\n");
}

function generatePushJob(config: Config): string {
  const ifClause = config.mode === "both"
    ? "\n    if: github.event_name != 'schedule'"
    : "";

  const matrixEntries = config.pushTargets.map((t) => {
    const dstPathAction = t.dstPath ? `/${t.dstPath}` : "/";
    return [
      `          - dst_owner: ${q(t.dstOwner)}`,
      `            dst_repo_name: ${q(t.dstRepoName)}`,
      `            dst_path: ${q(dstPathAction)}`,
      `            dst_branch: ${q(t.dstBranch)}`,
      `            clean: ${t.clean}`,
    ].join("\n");
  });

  const srcPathAction = `/${config.pushSrcPath}.`;

  return `  push-docs:${ifClause}
    runs-on: ubuntu-latest
    strategy:
      matrix:
        include:
${matrixEntries.join("\n")}
    steps:
      - name: Checkout source repo
        uses: actions/checkout@v4

      - name: Push docs to target repo
        uses: andstor/copycat-action@v3
        with:
          personal_token: \${{ secrets.PAT_DOCSYNC }}
          src_path: ${q(srcPathAction)}
          dst_path: \${{ matrix.dst_path }}
          dst_owner: \${{ matrix.dst_owner }}
          dst_repo_name: \${{ matrix.dst_repo_name }}
          dst_branch: \${{ matrix.dst_branch }}
          src_branch: ${q(config.pushSrcBranch)}
          clean: \${{ matrix.clean }}
          commit_message: "docs: push from \${{ github.repository }} @ \${{ github.sha }}"`;
}

function generatePullJob(config: Config): string {
  const ifClause = config.mode === "both"
    ? "\n    if: github.event_name != 'push'"
    : "";

  const pullSteps = config.pullSources.map((s, i) => {
    const srcDir = `_src_${i}`;
    const sparseDir = s.srcPath.replace(/\/$/, "");
    return `
      - name: Checkout ${s.srcOwner}/${s.srcRepoName}
        uses: actions/checkout@v4
        with:
          repository: ${q(`${s.srcOwner}/${s.srcRepoName}`)}
          ref: ${q(s.srcBranch)}
          token: \${{ secrets.PAT_DOCSYNC }}
          path: ${srcDir}
          sparse-checkout: ${q(sparseDir)}

      - name: Sync ${s.srcOwner}/${s.srcRepoName}
        run: |
          mkdir -p ${q(s.dstPath)}
          rsync -av --delete ${srcDir}/${s.srcPath} ${s.dstPath}
          rm -rf ${srcDir}`;
  });

  return `
  pull-docs:${ifClause}
    runs-on: ubuntu-latest
    steps:
      - name: Checkout this repo
        uses: actions/checkout@v4
        with:
          ref: ${q(config.pullBranch)}
${pullSteps.join("\n")}

      - name: Commit and push
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add -A
          if git diff --cached --quiet; then
            echo "No changes to sync"
          else
            git commit -m "docs: pull from source repos @ \$(date -u +%Y-%m-%dT%H:%M:%SZ)"
            git push
          fi`;
}

export function readExistingConfig(cwd: string): Config | null {
  const configPath = join(cwd, ".github", "docsync.json");
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, "utf-8")) as Config;
  } catch {
    return null;
  }
}

export async function writeWorkflow(cwd: string, yaml: string, config: Config, interactive = true): Promise<boolean> {
  const dir = join(cwd, ".github", "workflows");
  const filePath = join(dir, "docsync.yml");
  const configPath = join(cwd, ".github", "docsync.json");

  if (interactive && existsSync(filePath)) {
    const overwrite = await confirm({
      message: `${filePath} already exists. Overwrite?`,
      default: true,
    });
    if (!overwrite) {
      console.log("Write cancelled.");
      return false;
    }
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, yaml, "utf-8");
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  console.log(`\n✅ Written to ${filePath}`);
  return true;
}
