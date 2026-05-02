import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, rmSync, symlinkSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseRemoteURL, parsePushTarget, parsePullSource } from "../core/parse.js";
import { normalizePath } from "../core/paths.js";
import { normalizeConfig, generateYaml, readExistingConfig, writeWorkflow } from "../cli/workflow.js";
import { dedupeDirs } from "../core/dedup.js";
import type { CLIConfig } from "../cli/types.js";

describe("parseRemoteURL", () => {
  it("parses SSH URL", () => {
    expect(parseRemoteURL("git@github.com:singularquest/website.git")).toEqual({
      owner: "singularquest",
      repo: "website",
    });
  });

  it("parses HTTPS URL", () => {
    expect(parseRemoteURL("https://github.com/singularquest/wiki.git")).toEqual({
      owner: "singularquest",
      repo: "wiki",
    });
  });

  it("returns empty for non-GitHub URL", () => {
    expect(parseRemoteURL("git@gitlab.com:owner/repo.git")).toEqual({ owner: "", repo: "" });
  });

  it("rejects notgithub.com", () => {
    expect(parseRemoteURL("https://notgithub.com/owner/repo.git")).toEqual({ owner: "", repo: "" });
    expect(parseRemoteURL("git@notgithub.com:owner/repo.git")).toEqual({ owner: "", repo: "" });
  });
});

describe("normalizePath", () => {
  it("keeps docs/ as-is", () => expect(normalizePath("docs/")).toBe("docs/"));
  it("strips leading slash", () => expect(normalizePath("/docs/")).toBe("docs/"));
  it("adds trailing slash", () => expect(normalizePath("docs")).toBe("docs/"));
  it("handles slash-only input", () => expect(normalizePath("/")).toBe(""));
  it("strips ./ prefix", () => expect(normalizePath("./docs/")).toBe("docs/"));
  it("throws on path traversal", () => expect(() => normalizePath("../etc")).toThrow(".."));
  it("normalizes backslashes", () => expect(normalizePath("docs\\website")).toBe("docs/website/"));
});

// ── generated YAML: Action-invoking shape ──

describe("generateYaml", () => {
  const pushConfig: CLIConfig = {
    pushSrcPath: "docs/",
    pushSrcBranch: "main",
    pushTargets: [
      { dstOwner: "singularquest", dstRepoName: "wiki", dstPath: "docs/website/", dstBranch: "main" },
    ],
    pullBranch: "",
    pullSources: [],
    pullMode: "copy",
    dedup: false,
    clean: true,
  };

  it("generates push workflow with single uses: step", () => {
    const yaml = generateYaml(pushConfig);

    expect(yaml).toContain("name: Sync Docs");
    expect(yaml).toContain("push:");
    expect(yaml).toContain('branches: ["main"]');
    expect(yaml).toContain('"docs/**"');
    expect(yaml).toContain("workflow_dispatch:");
    // Single job uses our Action
    expect(yaml).toContain("- uses: zzzhizhia/set-docsync@v2");
    expect(yaml).toContain("actions/checkout@v6");
    expect(yaml).toContain("targets: |");
    expect(yaml).toContain("singularquest/wiki:docs/website/@main");
    // No schedule trigger for push-only
    expect(yaml).not.toContain("schedule:");
    // No separate pull/push job names — it's a single `sync` job
    expect(yaml).not.toContain("pull-docs:");
    expect(yaml).not.toContain("push-docs:");
  });

  it("supports multiple push targets", () => {
    const multi: CLIConfig = {
      ...pushConfig,
      pushTargets: [
        { dstOwner: "org1", dstRepoName: "wiki", dstPath: "docs/app/", dstBranch: "main" },
        { dstOwner: "org2", dstRepoName: "docs", dstPath: "web/", dstBranch: "dev" },
      ],
    };
    const yaml = generateYaml(multi);
    expect(yaml).toContain("org1/wiki:docs/app/@main");
    expect(yaml).toContain("org2/docs:web/@dev");
  });

  it("emits clean: 'false' when --no-clean was selected", () => {
    const yaml = generateYaml({ ...pushConfig, clean: false });
    expect(yaml).toContain('clean: "false"');
  });

  it("omits clean: input when clean is the default (true)", () => {
    const yaml = generateYaml(pushConfig);
    expect(yaml).not.toContain("clean:");
  });

  it("omits ref in push-only workflow so checkout picks up the pushed commit", () => {
    const yaml = generateYaml(pushConfig);
    expect(yaml).not.toContain("ref:");
  });

  it("serializes whole-repo pull sources with explicit / for srcPath", () => {
    // Empty srcPath means "sync the whole repo". If serialized as an empty
    // segment (owner/repo::dst@branch), the parser's default kicks in and
    // sync silently narrows to a non-existent docs/ subdir.
    const wholeRepoConfig: CLIConfig = {
      pushSrcPath: "",
      pushSrcBranch: "",
      pushTargets: [],
      pullBranch: "main",
      pullSources: [
        { srcOwner: "org", srcRepoName: "wiki", srcPath: "", dstPath: "raw/wiki/", srcBranch: "main" },
      ],
      pullMode: "copy",
      dedup: false,
      clean: true,
    };
    const yaml = generateYaml(wholeRepoConfig);
    expect(yaml).toContain("org/wiki:/:raw/wiki/@main");
    expect(yaml).not.toContain("org/wiki::raw/wiki/@main");
  });

  it("generates pull workflow with schedule and sources block", () => {
    const pullConfig: CLIConfig = {
      pushSrcPath: "",
      pushSrcBranch: "",
      pushTargets: [],
      pullBranch: "main",
      pullSources: [
        { srcOwner: "singularquest", srcRepoName: "website", srcPath: "docs/", dstPath: "docs/website/", srcBranch: "main" },
      ],
      pullMode: "copy",
      dedup: false,
      clean: true,
    };
    const yaml = generateYaml(pullConfig);

    expect(yaml).toContain("schedule:");
    expect(yaml).toContain('cron: "0 0 * * *"');
    expect(yaml).toContain("sources: |");
    expect(yaml).toContain("singularquest/website:docs/:docs/website/@main");
    expect(yaml).toContain('ref: "main"');
    expect(yaml).not.toContain("targets: |");
    expect(yaml).not.toContain("  push:");
  });

  it("generates combined push+pull workflow in a single job", () => {
    const both: CLIConfig = {
      pushSrcPath: "docs/",
      pushSrcBranch: "main",
      pushTargets: [
        { dstOwner: "org", dstRepoName: "wiki", dstPath: "docs/web/", dstBranch: "main" },
      ],
      pullBranch: "docs-hub",
      pullSources: [
        { srcOwner: "org", srcRepoName: "api", srcPath: "docs/", dstPath: "docs/api/", srcBranch: "main" },
      ],
      pullMode: "copy",
      dedup: true,
      clean: true,
    };
    const yaml = generateYaml(both);

    // Both triggers present
    expect(yaml).toContain("push:");
    expect(yaml).toContain("schedule:");
    // Single job with both inputs
    expect(yaml).toContain("targets: |");
    expect(yaml).toContain("sources: |");
    expect(yaml).toContain('dedup: "true"');
    // One `sync` job, not two jobs with conditionals
    expect(yaml).not.toContain("if: github.event_name");
    // Combined mode: checkout must follow the pushed ref on push events,
    // else fall back to the hub branch. This prevents push from reading
    // docs out of pullBranch when the two branches differ.
    expect(yaml).toContain(
      "ref: ${{ github.event_name == 'push' && github.ref_name || 'docs-hub' }}",
    );
  });

  it("preserves ${{ }} expressions", () => {
    const yaml = generateYaml(pushConfig);
    expect(yaml).toContain("${{ secrets.PAT_DOCSYNC }}");
    expect(yaml).not.toContain("\\${{");
  });

  it("emits mode: submodule when pullMode is submodule", () => {
    const submoduleConfig: CLIConfig = {
      pushSrcPath: "",
      pushSrcBranch: "",
      pushTargets: [],
      pullBranch: "main",
      pullSources: [
        { srcOwner: "org", srcRepoName: "wiki", srcPath: "", dstPath: "raw/repos/org/wiki/", srcBranch: "main" },
      ],
      pullMode: "submodule",
      dedup: false,
      clean: true,
    };
    const yaml = generateYaml(submoduleConfig);
    expect(yaml).toContain('mode: "submodule"');
    expect(yaml).toContain("sources: |");
  });

  it("omits mode input when pullMode is copy (default)", () => {
    const copyConfig: CLIConfig = {
      pushSrcPath: "",
      pushSrcBranch: "",
      pushTargets: [],
      pullBranch: "main",
      pullSources: [
        { srcOwner: "org", srcRepoName: "wiki", srcPath: "docs/", dstPath: "docs/wiki/", srcBranch: "main" },
      ],
      pullMode: "copy",
      dedup: false,
      clean: true,
    };
    const yaml = generateYaml(copyConfig);
    expect(yaml).not.toContain("mode:");
  });
});

describe("readExistingConfig", () => {
  const testDir = join(tmpdir(), "docsync-test-" + Date.now());

  it("returns null when no config file exists", () => {
    expect(readExistingConfig(testDir)).toBeNull();
  });

  it("reads and parses existing config", () => {
    const configDir = join(testDir, ".github");
    mkdirSync(configDir, { recursive: true });
    const config: CLIConfig = {
      pushSrcPath: "docs/",
      pushSrcBranch: "main",
      pushTargets: [
        { dstOwner: "org", dstRepoName: "wiki", dstPath: "docs/web/", dstBranch: "main" },
      ],
      pullBranch: "",
      pullSources: [],
      pullMode: "copy",
      dedup: false,
      clean: true,
    };
    writeFileSync(join(configDir, "docsync.json"), JSON.stringify(config));
    expect(readExistingConfig(testDir)).toEqual(config);
    rmSync(testDir, { recursive: true, force: true });
  });

  it("preserves sourceSHAs across writeWorkflow rewrites", async () => {
    const dir = join(tmpdir(), "docsync-state-test-" + Date.now());
    const configDir = join(dir, ".github");
    mkdirSync(configDir, { recursive: true });
    const existing: CLIConfig = {
      pushSrcPath: "",
      pushSrcBranch: "",
      pushTargets: [],
      pullBranch: "main",
      pullSources: [
        { srcOwner: "o", srcRepoName: "r", srcPath: "docs/", dstPath: "docs/r/", srcBranch: "main" },
      ],
      pullMode: "copy",
      dedup: false,
      clean: true,
      sourceSHAs: { "o/r@main": "deadbeef" },
    };
    writeFileSync(join(configDir, "docsync.json"), JSON.stringify(existing));

    const fresh: CLIConfig = { ...existing, sourceSHAs: undefined };
    await writeWorkflow(dir, "dummy yaml", fresh, false);

    const reloaded = readExistingConfig(dir);
    expect(reloaded?.sourceSHAs?.["o/r@main"]).toBe("deadbeef");
    rmSync(dir, { recursive: true, force: true });
  });
});

// ── dedup (core) ──

describe("dedupeDirs", () => {
  it("replaces identical files with relative symlinks", async () => {
    const dir = join(tmpdir(), "dedup-test-" + Date.now());
    const a = join(dir, "a");
    const b = join(dir, "b");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    writeFileSync(join(a, "shared.md"), "same content\n");
    writeFileSync(join(b, "shared.md"), "same content\n");
    writeFileSync(join(a, "unique.md"), "a only\n");

    const replaced = await dedupeDirs([a, b]);
    expect(replaced).toBe(1);

    // The lexicographically-first file stays a regular file; the other
    // becomes a relative symlink to it.
    expect(statSync(join(a, "shared.md")).isFile()).toBe(true);
    const linkTarget = readlinkSync(join(b, "shared.md"));
    expect(linkTarget).toContain("shared.md");

    rmSync(dir, { recursive: true, force: true });
  });

  it("is idempotent", async () => {
    const dir = join(tmpdir(), "dedup-idempotent-" + Date.now());
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "x.md"), "same\n");
    writeFileSync(join(dir, "y.md"), "same\n");

    const first = await dedupeDirs([dir]);
    const second = await dedupeDirs([dir]);
    expect(first).toBe(1);
    expect(second).toBe(0);

    rmSync(dir, { recursive: true, force: true });
  });

  it("cleans up broken symlinks from prior runs", async () => {
    const dir = join(tmpdir(), "dedup-broken-" + Date.now());
    mkdirSync(dir, { recursive: true });
    // Create a broken symlink that points nowhere
    symlinkSync("./does-not-exist", join(dir, "broken.md"));
    writeFileSync(join(dir, "real.md"), "hello\n");

    await dedupeDirs([dir]);

    // Broken symlink should be gone
    let brokenStill = false;
    try {
      statSync(join(dir, "broken.md"));
      brokenStill = true;
    } catch {
      /* expected */
    }
    expect(brokenStill).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  });
});

// ── CLI arg parsers ──

describe("parsePushTarget", () => {
  it("parses full format owner/repo:path@branch", () => {
    expect(parsePushTarget("org/wiki:docs/web/@dev")).toEqual({
      dstOwner: "org",
      dstRepoName: "wiki",
      dstPath: "docs/web/",
      dstBranch: "dev",
    });
  });

  it("parses minimal format owner/repo", () => {
    expect(parsePushTarget("org/wiki")).toEqual({
      dstOwner: "org",
      dstRepoName: "wiki",
      dstPath: "/",
      dstBranch: "main",
    });
  });

  it("parses owner/repo@branch without path", () => {
    expect(parsePushTarget("org/wiki@dev")).toEqual({
      dstOwner: "org",
      dstRepoName: "wiki",
      dstPath: "/",
      dstBranch: "dev",
    });
  });
});

describe("parsePullSource", () => {
  it("parses full format", () => {
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

  it("round-trips whole-repo srcPath via / → normalizePath('') ", () => {
    const parsed = parsePullSource("org/wiki:/:raw/wiki/@main");
    expect(normalizePath(parsed.srcPath)).toBe("");
    expect(normalizePath(parsed.dstPath)).toBe("raw/wiki/");
  });
});

// ── normalizeConfig ──

describe("normalizeConfig", () => {
  it("normalizes all paths in config", () => {
    const raw: CLIConfig = {
      pushSrcPath: "./docs",
      pushSrcBranch: "main",
      pushTargets: [
        { dstOwner: "o", dstRepoName: "r", dstPath: "/out/", dstBranch: "main" },
      ],
      pullBranch: "main",
      pullSources: [
        { srcOwner: "o", srcRepoName: "r", srcPath: "./src/", dstPath: "/dst", srcBranch: "main" },
      ],
      pullMode: "copy",
      dedup: false,
      clean: true,
    };
    const config = normalizeConfig(raw);
    expect(config.pushSrcPath).toBe("docs/");
    expect(config.pushTargets[0].dstPath).toBe("out/");
    expect(config.pullSources[0].srcPath).toBe("src/");
    expect(config.pullSources[0].dstPath).toBe("dst/");
  });
});
