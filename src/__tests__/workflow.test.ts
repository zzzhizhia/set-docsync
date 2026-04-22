import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseRemoteURL, parsePushTarget, parsePullSource } from "../index.js";
import { normalizePath, normalizeConfig, generateYaml, readExistingConfig } from "../workflow.js";
import type { Config } from "../index.js";

describe("parseRemoteURL", () => {
  it("parses SSH URL", () => {
    expect(parseRemoteURL("git@github.com:singularquest/website.git")).toEqual({
      owner: "singularquest",
      repo: "website",
    });
  });

  it("parses SSH URL without .git", () => {
    expect(parseRemoteURL("git@github.com:owner/repo")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  it("parses HTTPS URL", () => {
    expect(parseRemoteURL("https://github.com/singularquest/wiki.git")).toEqual({
      owner: "singularquest",
      repo: "wiki",
    });
  });

  it("parses HTTPS URL without .git", () => {
    expect(parseRemoteURL("https://github.com/owner/repo")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  it("returns empty for non-GitHub URL", () => {
    expect(parseRemoteURL("git@gitlab.com:owner/repo.git")).toEqual({
      owner: "",
      repo: "",
    });
  });

  it("returns empty for empty string", () => {
    expect(parseRemoteURL("")).toEqual({ owner: "", repo: "" });
  });

  it("rejects notgithub.com (HTTPS)", () => {
    expect(parseRemoteURL("https://notgithub.com/owner/repo.git")).toEqual({
      owner: "",
      repo: "",
    });
  });

  it("rejects notgithub.com (SSH)", () => {
    expect(parseRemoteURL("git@notgithub.com:owner/repo.git")).toEqual({
      owner: "",
      repo: "",
    });
  });
});

describe("normalizePath", () => {
  it("keeps docs/ as-is", () => {
    expect(normalizePath("docs/")).toBe("docs/");
  });

  it("strips leading slash", () => {
    expect(normalizePath("/docs/")).toBe("docs/");
  });

  it("adds trailing slash", () => {
    expect(normalizePath("docs")).toBe("docs/");
  });

  it("handles nested path", () => {
    expect(normalizePath("docs/website")).toBe("docs/website/");
  });

  it("handles slash-only input", () => {
    expect(normalizePath("/")).toBe("");
  });

  it("handles messy input", () => {
    expect(normalizePath("  /docs/  ")).toBe("docs/");
  });

  it("strips ./ prefix", () => {
    expect(normalizePath("./docs/")).toBe("docs/");
  });

  it("strips ./ prefix without trailing slash", () => {
    expect(normalizePath("./docs")).toBe("docs/");
  });

  it("throws on path traversal (..)", () => {
    expect(() => normalizePath("../etc")).toThrow("..");
  });

  it("throws on nested path traversal", () => {
    expect(() => normalizePath("docs/../../etc")).toThrow("..");
  });

  it("normalizes backslashes", () => {
    expect(normalizePath("docs\\website")).toBe("docs/website/");
  });
});

// ── Push workflow ──

describe("generateYaml (push)", () => {
  const pushConfig: Config = {
    mode: "push",
    pushSrcPath: "docs/",
    pushSrcBranch: "main",
    pushTargets: [
      { dstOwner: "singularquest", dstRepoName: "wiki", dstPath: "docs/website/", dstBranch: "main", clean: true },
    ],
    pullBranch: "",
    pullSources: [],
  };

  it("generates push workflow with matrix", () => {
    const yaml = generateYaml(pushConfig);

    expect(yaml).toContain("name: Sync Docs");
    expect(yaml).toContain("push:");
    expect(yaml).toContain('branches: ["main"]');
    expect(yaml).toContain('"docs/**"');
    expect(yaml).toContain("workflow_dispatch:");
    expect(yaml).toContain("push-docs:");
    expect(yaml).toContain("matrix:");
    expect(yaml).toContain('dst_owner: "singularquest"');
    expect(yaml).toContain('dst_repo_name: "wiki"');
    expect(yaml).toContain('dst_path: "docs/website/"');
    // Push now uses checkout + rsync directly, not copycat-action.
    expect(yaml).not.toContain("copycat-action");
    expect(yaml).toContain("actions/checkout@v6");
    expect(yaml).toContain("PAT_DOCSYNC");
    expect(yaml).toContain("rsync -av --exclude '.git'");
    // No schedule trigger for push-only
    expect(yaml).not.toContain("schedule:");
    // No pull job
    expect(yaml).not.toContain("pull-docs:");
  });

  it("supports multiple push targets", () => {
    const multi: Config = {
      ...pushConfig,
      pushTargets: [
        { dstOwner: "org1", dstRepoName: "wiki", dstPath: "docs/app/", dstBranch: "main", clean: true },
        { dstOwner: "org2", dstRepoName: "docs", dstPath: "web/", dstBranch: "dev", clean: false },
      ],
    };
    const yaml = generateYaml(multi);

    expect(yaml).toContain('dst_owner: "org1"');
    expect(yaml).toContain('dst_repo_name: "wiki"');
    expect(yaml).toContain('dst_owner: "org2"');
    expect(yaml).toContain('dst_repo_name: "docs"');
    expect(yaml).toContain('dst_branch: "dev"');
  });

  it("includes dedup flag in matrix (default false)", () => {
    const yaml = generateYaml(pushConfig);
    expect(yaml).toContain("dedup: false");
    expect(yaml).toContain("if: matrix.dedup");
  });

  it("sets dedup: true when enabled on a target", () => {
    const withDedup: Config = {
      ...pushConfig,
      pushTargets: [
        { dstOwner: "org", dstRepoName: "wiki", dstPath: "docs/", dstBranch: "main", clean: true, dedup: true },
      ],
    };
    const yaml = generateYaml(withDedup);
    expect(yaml).toContain("dedup: true");
    expect(yaml).toContain("sha256sum");
  });

  it("preserves ${{ }} expressions", () => {
    const yaml = generateYaml(pushConfig);
    expect(yaml).toContain("${{ secrets.PAT_DOCSYNC }}");
    expect(yaml).toContain("${{ github.repository }}");
    expect(yaml).toContain("${{ github.sha }}");
    expect(yaml).not.toContain("\\${{");
  });
});

// ── Pull workflow ──

describe("generateYaml (pull)", () => {
  const pullConfig: Config = {
    mode: "pull",
    pushSrcPath: "",
    pushSrcBranch: "",
    pushTargets: [],
    pullBranch: "main",
    pullSources: [
      { srcOwner: "singularquest", srcRepoName: "website", srcPath: "docs/", dstPath: "docs/website/", srcBranch: "main" },
    ],
  };

  it("generates pull workflow with schedule", () => {
    const yaml = generateYaml(pullConfig);

    expect(yaml).toContain("name: Sync Docs");
    expect(yaml).toContain("schedule:");
    expect(yaml).toContain('cron: "0 0 * * *"');
    expect(yaml).toContain("workflow_dispatch:");
    expect(yaml).toContain("pull-docs:");
    expect(yaml).toContain('repository: "singularquest/website"');
    expect(yaml).toContain("rsync -av --delete --exclude '.git'");
    expect(yaml).toContain("docs/website/");
    expect(yaml).toContain("git commit");
    expect(yaml).toContain("PAT_DOCSYNC");
    // No push trigger for pull-only
    expect(yaml).not.toContain("  push:");
    // No push job
    expect(yaml).not.toContain("push-docs:");
  });

  it("generates SHA-based skip check for each source", () => {
    const yaml = generateYaml(pullConfig);
    expect(yaml).toContain("id: sha_0");
    expect(yaml).toContain("gh api");
    expect(yaml).toContain('repos/singularquest/website/commits/main');
    expect(yaml).toContain(".sourceSHAs");
    expect(yaml).toContain("if: steps.sha_0.outputs.changed == 'true'");
    expect(yaml).toContain("Update SHA state");
  });

  it("omits dedup step by default", () => {
    const yaml = generateYaml(pullConfig);
    expect(yaml).not.toContain("Deduplicate identical files");
  });

  it("emits cross-source dedup step when pullDedup is true", () => {
    const yaml = generateYaml({ ...pullConfig, pullDedup: true });
    expect(yaml).toContain("Deduplicate identical files across sources");
    expect(yaml).toContain("sha256sum");
    expect(yaml).toContain("ln -s");
  });

  it("supports multiple pull sources", () => {
    const multi: Config = {
      ...pullConfig,
      pullSources: [
        { srcOwner: "org1", srcRepoName: "app", srcPath: "docs/", dstPath: "docs/app/", srcBranch: "main" },
        { srcOwner: "org2", srcRepoName: "api", srcPath: "doc/", dstPath: "docs/api/", srcBranch: "develop" },
      ],
    };
    const yaml = generateYaml(multi);

    expect(yaml).toContain('repository: "org1/app"');
    expect(yaml).toContain('repository: "org2/api"');
    expect(yaml).toContain("_src_0");
    expect(yaml).toContain("_src_1");
    expect(yaml).toContain("docs/app/");
    expect(yaml).toContain("docs/api/");
  });
});

// ── Both mode ──

describe("generateYaml (both)", () => {
  const bothConfig: Config = {
    mode: "both",
    pushSrcPath: "docs/",
    pushSrcBranch: "main",
    pushTargets: [
      { dstOwner: "org", dstRepoName: "wiki", dstPath: "docs/web/", dstBranch: "main", clean: true },
    ],
    pullBranch: "main",
    pullSources: [
      { srcOwner: "org", srcRepoName: "api", srcPath: "docs/", dstPath: "docs/api/", srcBranch: "main" },
    ],
  };

  it("generates both push and pull jobs", () => {
    const yaml = generateYaml(bothConfig);

    // Both triggers
    expect(yaml).toContain("push:");
    expect(yaml).toContain("schedule:");
    expect(yaml).toContain("workflow_dispatch:");

    // Both jobs
    expect(yaml).toContain("push-docs:");
    expect(yaml).toContain("pull-docs:");

    // Conditional execution
    expect(yaml).toContain("github.event_name != 'schedule'");
    expect(yaml).toContain("github.event_name != 'push'");
  });
});

// ── normalizeConfig ──

describe("normalizeConfig", () => {
  it("normalizes all paths in config", () => {
    const raw: Config = {
      mode: "both",
      pushSrcPath: "./docs",
      pushSrcBranch: "main",
      pushTargets: [
        { dstOwner: "o", dstRepoName: "r", dstPath: "/out/", dstBranch: "main", clean: true },
      ],
      pullBranch: "main",
      pullSources: [
        { srcOwner: "o", srcRepoName: "r", srcPath: "./src/", dstPath: "/dst", srcBranch: "main" },
      ],
    };
    const config = normalizeConfig(raw);

    expect(config.pushSrcPath).toBe("docs/");
    expect(config.pushTargets[0].dstPath).toBe("out/");
    expect(config.pullSources[0].srcPath).toBe("src/");
    expect(config.pullSources[0].dstPath).toBe("dst/");
  });
});

// ── readExistingConfig ──

describe("readExistingConfig", () => {
  const testDir = join(tmpdir(), "docsync-test-" + Date.now());

  it("returns null when no config file exists", () => {
    expect(readExistingConfig(testDir)).toBeNull();
  });

  it("reads and parses existing config", () => {
    const configDir = join(testDir, ".github");
    mkdirSync(configDir, { recursive: true });

    const config: Config = {
      mode: "push",
      pushSrcPath: "docs/",
      pushSrcBranch: "main",
      pushTargets: [
        { dstOwner: "org", dstRepoName: "wiki", dstPath: "docs/web/", dstBranch: "main", clean: true },
      ],
      pullBranch: "",
      pullSources: [],
    };
    writeFileSync(join(configDir, "docsync.json"), JSON.stringify(config));

    const result = readExistingConfig(testDir);
    expect(result).toEqual(config);

    rmSync(testDir, { recursive: true, force: true });
  });

  it("returns null for invalid JSON", () => {
    const configDir = join(testDir, ".github");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "docsync.json"), "not json");

    expect(readExistingConfig(testDir)).toBeNull();

    rmSync(testDir, { recursive: true, force: true });
  });

  it("preserves state field across writeWorkflow rewrites", async () => {
    const { writeWorkflow } = await import("../workflow.js");
    const dir = join(tmpdir(), "docsync-state-test-" + Date.now());
    const configDir = join(dir, ".github");
    mkdirSync(configDir, { recursive: true });

    const existing: Config = {
      mode: "pull",
      pushSrcPath: "",
      pushSrcBranch: "",
      pushTargets: [],
      pullBranch: "main",
      pullSources: [
        { srcOwner: "o", srcRepoName: "r", srcPath: "docs/", dstPath: "docs/r/", srcBranch: "main" },
      ],
      sourceSHAs: { "o/r@main": "deadbeef" },
    };
    writeFileSync(join(configDir, "docsync.json"), JSON.stringify(existing));

    const fresh: Config = {
      mode: "pull",
      pushSrcPath: "",
      pushSrcBranch: "",
      pushTargets: [],
      pullBranch: "main",
      pullSources: [
        { srcOwner: "o", srcRepoName: "r", srcPath: "docs/", dstPath: "docs/r/", srcBranch: "main" },
      ],
    };
    await writeWorkflow(dir, "dummy yaml", fresh, false);

    const reloaded = readExistingConfig(dir);
    expect(reloaded?.sourceSHAs?.["o/r@main"]).toBe("deadbeef");

    rmSync(dir, { recursive: true, force: true });
  });
});

// ── CLI arg parsers ──

describe("parsePushTarget", () => {
  it("parses full format owner/repo:path@branch", () => {
    expect(parsePushTarget("org/wiki:docs/web/@dev", true)).toEqual({
      dstOwner: "org",
      dstRepoName: "wiki",
      dstPath: "docs/web/",
      dstBranch: "dev",
      clean: true,
      dedup: false,
    });
  });

  it("parses minimal format owner/repo", () => {
    expect(parsePushTarget("org/wiki", false)).toEqual({
      dstOwner: "org",
      dstRepoName: "wiki",
      dstPath: "/",
      dstBranch: "main",
      clean: false,
      dedup: false,
    });
  });

  it("parses owner/repo:path without branch", () => {
    expect(parsePushTarget("org/wiki:docs/", true)).toEqual({
      dstOwner: "org",
      dstRepoName: "wiki",
      dstPath: "docs/",
      dstBranch: "main",
      clean: true,
      dedup: false,
    });
  });

  it("parses owner/repo@branch without path", () => {
    expect(parsePushTarget("org/wiki@dev", true)).toEqual({
      dstOwner: "org",
      dstRepoName: "wiki",
      dstPath: "/",
      dstBranch: "dev",
      clean: true,
      dedup: false,
    });
  });

  it("propagates dedup flag", () => {
    expect(parsePushTarget("org/wiki", true, true)).toEqual({
      dstOwner: "org",
      dstRepoName: "wiki",
      dstPath: "/",
      dstBranch: "main",
      clean: true,
      dedup: true,
    });
  });
});

describe("parsePullSource", () => {
  it("parses full format owner/repo:src:dst@branch", () => {
    expect(parsePullSource("org/app:docs/:docs/app/@dev")).toEqual({
      srcOwner: "org",
      srcRepoName: "app",
      srcPath: "docs/",
      dstPath: "docs/app/",
      srcBranch: "dev",
    });
  });

  it("parses minimal format owner/repo", () => {
    expect(parsePullSource("org/app")).toEqual({
      srcOwner: "org",
      srcRepoName: "app",
      srcPath: "docs/",
      dstPath: "docs/app/",
      srcBranch: "main",
    });
  });

  it("parses owner/repo:src without dst", () => {
    expect(parsePullSource("org/app:src/")).toEqual({
      srcOwner: "org",
      srcRepoName: "app",
      srcPath: "src/",
      dstPath: "docs/app/",
      srcBranch: "main",
    });
  });
});
