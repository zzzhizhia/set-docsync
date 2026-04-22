import type { PushTarget, PullSource } from "./types.js";

export function parseRemoteURL(url: string): { owner: string; repo: string } {
  // SSH: git@github.com:owner/repo.git
  const sshMatch = url.match(/(?:^|[@/])github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };

  // HTTPS: https://github.com/owner/repo.git
  const httpsMatch = url.match(/[:\/]github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };

  return { owner: "", repo: "" };
}

// owner/repo[:dst_path][@branch]
export function parsePushTarget(arg: string): PushTarget {
  const [pathsPart, branch] = arg.split("@");
  const colonIdx = pathsPart.indexOf(":");
  const repo = colonIdx === -1 ? pathsPart : pathsPart.slice(0, colonIdx);
  const dstPath = colonIdx === -1 ? "/" : pathsPart.slice(colonIdx + 1);
  const slashIdx = repo.indexOf("/");
  if (slashIdx === -1) {
    throw new Error(`invalid push target "${arg}". Expected owner/repo[:path][@branch]`);
  }
  return {
    dstOwner: repo.slice(0, slashIdx),
    dstRepoName: repo.slice(slashIdx + 1),
    dstPath: dstPath || "/",
    dstBranch: branch || "main",
  };
}

// owner/repo[:src_path[:dst_path]][@branch]
export function parsePullSource(arg: string): PullSource {
  const [pathsPart, branch] = arg.split("@");
  const parts = pathsPart.split(":");
  const repo = parts[0];
  const slashIdx = repo.indexOf("/");
  if (slashIdx === -1) {
    throw new Error(`invalid pull source "${arg}". Expected owner/repo[:src[:dst]][@branch]`);
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
