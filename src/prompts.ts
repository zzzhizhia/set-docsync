import { input, confirm } from "@inquirer/prompts";
import { execFileSync, execSync } from "node:child_process";
import pc from "picocolors";
import type { Config, GitContext } from "./index.js";

export async function collectConfig(ctx: GitContext): Promise<Config> {
  const srcPath = await input({
    message: "文档源路径（相对仓库根目录）",
    default: "docs/",
    validate: (v) => (v.trim() ? true : "路径不能为空"),
  });

  const srcBranch = await input({
    message: "源分支",
    default: ctx.branch || "main",
  });

  const dstOwner = await input({
    message: "目标仓库 owner",
    default: ctx.owner || undefined,
    validate: (v) => (v.trim() ? true : "owner 不能为空"),
  });

  const dstRepoName = await input({
    message: "目标仓库名称",
    validate: (v) => (v.trim() ? true : "仓库名不能为空"),
  });

  const dstPath = await input({
    message: "目标路径（文件将被复制到这里）",
    default: "/",
  });

  const dstBranch = await input({
    message: "目标分支",
    default: "main",
  });

  const clean = await confirm({
    message: "是否在同步前清理目标目录？",
    default: true,
  });

  return { srcPath, srcBranch, dstOwner, dstRepoName, dstPath, dstBranch, clean };
}

export async function checkTargetRepo(owner: string, repo: string): Promise<void> {
  try {
    execSync("gh --version", { stdio: "ignore" });
  } catch {
    console.log(pc.yellow(`⚠ 未检测到 gh CLI，跳过目标仓库检查。请自行确认 ${owner}/${repo} 存在。`));
    return;
  }

  try {
    execFileSync("gh", ["api", `repos/${owner}/${repo}`], { stdio: "ignore" });
    console.log(pc.green(`✓ 目标仓库 ${owner}/${repo} 存在`));
  } catch {
    console.log(pc.yellow(`⚠ 无法访问 ${owner}/${repo}（可能是私有仓库或尚未创建）。工作流仍会生成。`));
  }
}

export async function confirmGeneration(config: Config): Promise<boolean> {
  console.log("\n" + pc.bold("配置摘要："));
  console.log(`  源路径:     ${config.srcPath}`);
  console.log(`  源分支:     ${config.srcBranch}`);
  console.log(`  目标仓库:   ${config.dstOwner}/${config.dstRepoName}`);
  console.log(`  目标路径:   ${config.dstPath}`);
  console.log(`  目标分支:   ${config.dstBranch}`);
  console.log(`  清理目标:   ${config.clean ? "是" : "否"}`);
  console.log();

  return confirm({ message: "确认生成工作流文件？", default: true });
}
