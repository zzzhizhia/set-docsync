import { confirm } from "@inquirer/prompts";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./index.js";

export function normalizePath(input: string): string {
  let p = input.trim();
  while (p.startsWith("./")) p = p.slice(2);
  while (p.startsWith("/")) p = p.slice(1);
  if (p && !p.endsWith("/")) p += "/";
  return p;
}

export function generateYaml(config: Config): string {
  const srcPathTrigger = `${config.srcPath}**`;
  const srcPathAction = `/${config.srcPath}.`;
  const dstPathAction = config.dstPath ? `/${config.dstPath}` : "/";

  return `name: Sync Repo Docs to Wiki

on:
  push:
    branches: [${config.srcBranch}]
    paths:
      - "${srcPathTrigger}"
  workflow_dispatch:

jobs:
  copy-docs:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout source repo
        uses: actions/checkout@v4

      - name: Copy docs to target repo
        uses: andstor/copycat-action@v3
        with:
          personal_token: \${{ secrets.PAT_SYNC_REPO_DOCS_TO_WIKI }}
          src_path: ${srcPathAction}
          dst_path: ${dstPathAction}
          dst_owner: ${config.dstOwner}
          dst_repo_name: ${config.dstRepoName}
          dst_branch: ${config.dstBranch}
          src_branch: ${config.srcBranch}
          clean: ${config.clean}
          commit_message: "docs: sync from source repo @ \${{ github.sha }}"
`;
}

export async function writeWorkflow(cwd: string, yaml: string): Promise<boolean> {
  const dir = join(cwd, ".github", "workflows");
  const filePath = join(dir, "sync-docs.yml");

  if (existsSync(filePath)) {
    const overwrite = await confirm({
      message: `${filePath} 已存在，是否覆盖？`,
      default: false,
    });
    if (!overwrite) {
      console.log("已取消写入。");
      return false;
    }
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, yaml, "utf-8");
  console.log(`\n✅ 已写入 ${filePath}`);
  return true;
}
