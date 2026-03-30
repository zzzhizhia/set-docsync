import { describe, it, expect } from "vitest";
import { parseRemoteURL } from "../index.js";
import { normalizePath, generateYaml } from "../workflow.js";
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
});

describe("generateYaml", () => {
  const config: Config = {
    srcPath: "docs/",
    srcBranch: "main",
    dstOwner: "singularquest",
    dstRepoName: "wiki",
    dstPath: "docs/website/",
    dstBranch: "main",
    clean: true,
  };

  it("generates valid workflow YAML", () => {
    const yaml = generateYaml(config);

    expect(yaml).toContain("name: Sync Repo Docs to Wiki");
    expect(yaml).toContain('branches: [main]');
    expect(yaml).toContain('"docs/**"');
    expect(yaml).toContain("workflow_dispatch:");
    expect(yaml).toContain("uses: andstor/copycat-action@v3");
    expect(yaml).toContain("src_path: /docs/.");
    expect(yaml).toContain("dst_path: /docs/website/");
    expect(yaml).toContain("dst_owner: singularquest");
    expect(yaml).toContain("dst_repo_name: wiki");
    expect(yaml).toContain("clean: true");
  });

  it("preserves ${{ }} expressions unescaped", () => {
    const yaml = generateYaml(config);

    expect(yaml).toContain("${{ secrets.PAT_SYNC_REPO_DOCS_TO_WIKI }}");
    expect(yaml).toContain("${{ github.sha }}");
    // Should NOT contain escaped backslash
    expect(yaml).not.toContain("\\${{");
  });

  it("handles clean: false", () => {
    const yaml = generateYaml({ ...config, clean: false });
    expect(yaml).toContain("clean: false");
  });
});
