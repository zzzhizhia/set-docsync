import { confirm } from "@inquirer/prompts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizePath } from "../core/paths.js";
import type { CLIConfig } from "./types.js";

// Tag of the Action `uses:` line in the generated workflow. The CLI pins
// users to a major version; patches/minors roll forward under the same tag.
const ACTION_REF = "zzzhizhia/set-docsync@v2";

function q(value: string): string {
  return JSON.stringify(value);
}

export function normalizeConfig(raw: CLIConfig): CLIConfig {
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

function serializeTargets(config: CLIConfig): string {
  return config.pushTargets
    .map((t) => {
      const path = t.dstPath ? `:${t.dstPath}` : "";
      return `${t.dstOwner}/${t.dstRepoName}${path}@${t.dstBranch}`;
    })
    .join("\n");
}

function serializeSources(config: CLIConfig): string {
  return config.pullSources
    .map((s) => {
      // Emit "/" for an empty srcPath (whole-repo sync). An empty segment
      // in owner/repo::dst@branch would be parsed as the default "docs/",
      // silently narrowing the sync to a subdirectory that may not exist.
      const src = s.srcPath || "/";
      return `${s.srcOwner}/${s.srcRepoName}:${src}:${s.dstPath}@${s.srcBranch}`;
    })
    .join("\n");
}

function indentBlock(txt: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return txt
    .split("\n")
    .map((line) => pad + line)
    .join("\n");
}

export function generateYaml(config: CLIConfig): string {
  const hasPush = config.pushTargets.length > 0;
  const hasPull = config.pullSources.length > 0;

  const lines: string[] = [];
  lines.push("name: Sync Docs");
  lines.push("");
  lines.push("on:");
  if (hasPush) {
    lines.push("  push:");
    lines.push(`    branches: [${q(config.pushSrcBranch)}]`);
    lines.push(`    paths:`);
    lines.push(`      - "${config.pushSrcPath}**"`);
  }
  if (hasPull) {
    lines.push(`  schedule:`);
    lines.push(`    - cron: "0 0 * * *"`);
  }
  lines.push("  workflow_dispatch:");
  lines.push("");
  lines.push("jobs:");
  lines.push("  sync:");
  lines.push("    runs-on: ubuntu-latest");
  lines.push("    steps:");
  lines.push("      - uses: actions/checkout@v6");
  lines.push("        with:");
  lines.push(`          token: \${{ secrets.PAT_DOCSYNC }}`);
  // Checkout ref selection:
  //  - push-only: omit `ref` so checkout defaults to github.ref (the pushed
  //    commit), which is what runPush needs to read.
  //  - pull-only: always check out the hub's pullBranch.
  //  - combined: on push events use the pushed ref (so docs reflect the
  //    commit that triggered the run); otherwise fall back to pullBranch.
  if (hasPush && hasPull) {
    lines.push(
      `          ref: \${{ github.event_name == 'push' && github.ref_name || '${config.pullBranch}' }}`,
    );
  } else if (hasPull) {
    lines.push(`          ref: ${q(config.pullBranch)}`);
  }
  lines.push("");
  lines.push(`      - uses: ${ACTION_REF}`);
  lines.push("        with:");
  lines.push(`          token: \${{ secrets.PAT_DOCSYNC }}`);
  if (hasPush) {
    lines.push(`          src-path: ${q(config.pushSrcPath)}`);
    lines.push(`          targets: |`);
    lines.push(indentBlock(serializeTargets(config), 12));
    // Only emit `clean` when non-default (action.yml defaults to 'true').
    if (!config.clean) {
      lines.push(`          clean: "false"`);
    }
  }
  if (hasPull) {
    lines.push(`          sources: |`);
    lines.push(indentBlock(serializeSources(config), 12));
    if (config.pullMode === "submodule") {
      lines.push(`          mode: "submodule"`);
    }
  }
  if (config.dedup) {
    lines.push(`          dedup: "true"`);
  }

  return lines.join("\n") + "\n";
}

export function readExistingConfig(cwd: string): CLIConfig | null {
  const configPath = join(cwd, ".github", "docsync.json");
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, "utf-8")) as CLIConfig;
  } catch {
    return null;
  }
}

export async function writeWorkflow(
  cwd: string,
  yaml: string,
  config: CLIConfig,
  interactive = true,
): Promise<boolean> {
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

  // Preserve runtime state (source SHAs the Action writes) across rewrites.
  const existing = readExistingConfig(cwd);
  const configToWrite: CLIConfig = existing?.sourceSHAs
    ? { ...config, sourceSHAs: existing.sourceSHAs }
    : config;

  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, yaml, "utf-8");
  writeFileSync(configPath, JSON.stringify(configToWrite, null, 2) + "\n", "utf-8");
  console.log(`\n✅ Written to ${filePath}`);
  return true;
}
