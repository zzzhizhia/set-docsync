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

// Shell snippet: replace duplicate regular files with symlinks to the first
// occurrence (by lexicographic path). Arg 1 is the directory to scan.
// Idempotent: running twice yields the same result; broken symlinks from
// previous runs are cleaned before re-scanning.
function dedupSnippet(dirExpr: string): string {
  return `DEDUP_DIR=${dirExpr}
          if [ -d "$DEDUP_DIR" ]; then
            find "$DEDUP_DIR" -xtype l -delete 2>/dev/null || true
            find "$DEDUP_DIR" -type f ! -path '*/.git/*' -exec sha256sum {} + 2>/dev/null | \\
              sort | \\
              awk '{ path = substr($0, 67); if ($1 == prev) { print canon "\\t" path; next } prev = $1; canon = path }' | \\
              while IFS=$'\\t' read -r canonical duplicate; do
                [ -f "$canonical" ] && [ -f "$duplicate" ] || continue
                rel=$(realpath --relative-to="$(dirname "$duplicate")" "$canonical")
                rm -f "$duplicate"
                ln -s "$rel" "$duplicate"
                echo "deduped: $duplicate -> $rel"
              done
          fi`;
}

function generatePushJob(config: Config): string {
  const ifClause = config.mode === "both"
    ? "\n    if: github.event_name != 'schedule'"
    : "";

  const matrixEntries = config.pushTargets.map((t) => {
    return [
      `          - dst_owner: ${q(t.dstOwner)}`,
      `            dst_repo_name: ${q(t.dstRepoName)}`,
      `            dst_path: ${q(t.dstPath)}`,
      `            dst_branch: ${q(t.dstBranch)}`,
      `            clean: ${t.clean}`,
      `            dedup: ${t.dedup ?? false}`,
    ].join("\n");
  });

  return `  push-docs:${ifClause}
    runs-on: ubuntu-latest
    strategy:
      matrix:
        include:
${matrixEntries.join("\n")}
    steps:
      - name: Checkout source repo
        uses: actions/checkout@v6
        with:
          ref: ${q(config.pushSrcBranch)}
          path: _source

      - name: Checkout target \${{ matrix.dst_owner }}/\${{ matrix.dst_repo_name }}
        uses: actions/checkout@v6
        with:
          repository: \${{ matrix.dst_owner }}/\${{ matrix.dst_repo_name }}
          ref: \${{ matrix.dst_branch }}
          token: \${{ secrets.PAT_DOCSYNC }}
          path: _target

      - name: Sync docs to target
        run: |
          DST="_target/\${{ matrix.dst_path }}"
          DST="\${DST%/}"
          if [ "\${{ matrix.clean }}" = "true" ] && [ -d "$DST" ]; then
            find "$DST" -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +
          fi
          mkdir -p "$DST"
          rsync -av --exclude '.git' "_source/${config.pushSrcPath}" "$DST/"

      - name: Deduplicate identical files
        if: matrix.dedup
        run: |
          ${dedupSnippet('"_target/${{ matrix.dst_path }}"')}

      - name: Commit and push to target
        working-directory: _target
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add -A
          if git diff --cached --quiet; then
            echo "No changes to push"
          else
            git commit -m "docs: push from \${{ github.repository }} @ \${{ github.sha }}"
            git push
          fi`;
}

function generatePullJob(config: Config): string {
  const ifClause = config.mode === "both"
    ? "\n    if: github.event_name != 'push'"
    : "";

  const pullSteps = config.pullSources.map((s, i) => {
    const srcDir = `_src_${i}`;
    const sparseDir = s.srcPath.replace(/\/$/, "");
    const shaKey = `${s.srcOwner}/${s.srcRepoName}@${s.srcBranch}`;

    return `
      - name: Check ${s.srcOwner}/${s.srcRepoName}@${s.srcBranch} for changes
        id: sha_${i}
        env:
          GH_TOKEN: \${{ secrets.PAT_DOCSYNC }}
        run: |
          CURRENT=$(gh api "repos/${s.srcOwner}/${s.srcRepoName}/commits/${s.srcBranch}" --jq .sha)
          LAST=$(jq -r '.sourceSHAs[${q(shaKey)}] // ""' .github/docsync.json 2>/dev/null || echo "")
          echo "sha=$CURRENT" >> "$GITHUB_OUTPUT"
          if [ -n "$LAST" ] && [ "$CURRENT" = "$LAST" ]; then
            echo "Skipping ${s.srcOwner}/${s.srcRepoName}@${s.srcBranch} (unchanged: $CURRENT)"
            echo "changed=false" >> "$GITHUB_OUTPUT"
          else
            echo "changed=true" >> "$GITHUB_OUTPUT"
          fi

      - name: Checkout ${s.srcOwner}/${s.srcRepoName}
        if: steps.sha_${i}.outputs.changed == 'true'
        uses: actions/checkout@v6
        with:
          repository: ${q(`${s.srcOwner}/${s.srcRepoName}`)}
          ref: ${q(s.srcBranch)}
          token: \${{ secrets.PAT_DOCSYNC }}
          path: ${srcDir}
          sparse-checkout: ${q(sparseDir)}

      - name: Sync ${s.srcOwner}/${s.srcRepoName}
        if: steps.sha_${i}.outputs.changed == 'true'
        run: |
          mkdir -p ${q(s.dstPath)}
          rsync -av --delete --exclude '.git' ${srcDir}/${s.srcPath} ${s.dstPath}
          rm -rf ${srcDir}

      - name: Update SHA state for ${s.srcOwner}/${s.srcRepoName}
        if: steps.sha_${i}.outputs.changed == 'true'
        run: |
          mkdir -p .github
          [ -f .github/docsync.json ] || echo '{}' > .github/docsync.json
          jq --arg k ${q(shaKey)} --arg v "\${{ steps.sha_${i}.outputs.sha }}" \\
            '.sourceSHAs[$k] = $v' .github/docsync.json > .github/docsync.json.tmp
          mv .github/docsync.json.tmp .github/docsync.json`;
  });

  const dedupPaths = config.pullSources.map((s) => q(s.dstPath.replace(/\/$/, "") || ".")).join(" ");
  const dedupStep = config.pullDedup
    ? `

      - name: Deduplicate identical files across sources
        run: |
          for DEDUP_DIR in ${dedupPaths}; do
            if [ -d "$DEDUP_DIR" ]; then
              find "$DEDUP_DIR" -xtype l -delete 2>/dev/null || true
            fi
          done
          find ${dedupPaths} -type f ! -path '*/.git/*' -exec sha256sum {} + 2>/dev/null | \\
            sort | \\
            awk '{ path = substr($0, 67); if ($1 == prev) { print canon "\\t" path; next } prev = $1; canon = path }' | \\
            while IFS=$'\\t' read -r canonical duplicate; do
              [ -f "$canonical" ] && [ -f "$duplicate" ] || continue
              rel=$(realpath --relative-to="$(dirname "$duplicate")" "$canonical")
              rm -f "$duplicate"
              ln -s "$rel" "$duplicate"
              echo "deduped: $duplicate -> $rel"
            done`
    : "";

  return `
  pull-docs:${ifClause}
    runs-on: ubuntu-latest
    steps:
      - name: Checkout this repo
        uses: actions/checkout@v6
        with:
          token: \${{ secrets.PAT_DOCSYNC }}
          ref: ${q(config.pullBranch)}
${pullSteps.join("\n")}${dedupStep}

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

  // Preserve runtime state (source SHAs updated by the workflow) so
  // reconfiguring via the CLI doesn't blow it away.
  const existing = readExistingConfig(cwd);
  const configToWrite: Config = existing?.sourceSHAs
    ? { ...config, sourceSHAs: existing.sourceSHAs }
    : config;

  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, yaml, "utf-8");
  writeFileSync(configPath, JSON.stringify(configToWrite, null, 2) + "\n", "utf-8");
  console.log(`\n✅ Written to ${filePath}`);
  return true;
}
