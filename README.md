# set-docsync

Interactive CLI to set up GitHub Actions workflows that sync documentation between repositories. Supports **push** (on commit), **pull** (on schedule), or **both** — with multi-repo targets.

## Quick Start

```bash
# Interactive mode
npx set-docsync

# Non-interactive push
npx set-docsync push --src docs/ --to org/wiki:docs/website/@main

# Non-interactive pull
npx set-docsync pull --from org/website:docs/:docs/website/@main

# Multiple targets
npx set-docsync push --src docs/ --to org/wiki:docs/web/ --to org/docs:api/
```

Run inside any GitHub repository. Generates `.github/workflows/docsync.yml`.

### CLI Options

```
Usage: set-docsync [push|pull] [options]

No arguments    Interactive mode

Options:
  --src <path>        Source docs path (default: docs/)
  --branch <branch>   Source/commit branch (default: main)
  --to <target>       Push target — owner/repo[:dst_path][@branch]  (repeatable)
  --from <source>     Pull source — owner/repo[:src_path[:dst_path]][@branch]  (repeatable)
  --clean             Clean target directory before push (default: true)
  --no-clean          Don't clean target directory
  --dedup             Replace identical files with symlinks to save space
  -h, --help          Show help
```

### Options cheatsheet

- **`--dedup`**: After sync, scans the target directory and replaces byte-identical files with relative symlinks pointing to the first occurrence (lex-sorted). Useful for hub repos that aggregate many wikis/docs with common files (licenses, templates, shared images). Idempotent across runs. Requires Linux/macOS — the generated workflow runs on `ubuntu-latest`, so Windows runners are not supported.
- **Pull incremental**: The generated pull workflow checks each source's HEAD SHA against the last synced SHA (stored in `.github/docsync.json` under `sourceSHAs`). Unchanged sources skip clone/rsync entirely. State is preserved across CLI rewrites of the config.

## Sync Modes

| Mode | Trigger | Use case |
|------|---------|----------|
| **Push** | On commit to source repo | Source repo pushes docs to one or more target repos |
| **Pull** | Daily cron (00:00 UTC) | Wiki/hub repo pulls docs from one or more source repos |
| **Both** | Push + cron | Repo is both a source and a destination |

Each mode supports **multiple targets/sources** in a single workflow.

## Example

```
$ npx set-docsync

🔄 set-docsync — Configure docs sync workflow

Detected repo: myorg/website (main)

? Sync mode Push — push docs to target repo(s) on commit
? Source docs path (relative to repo root) docs/
? Source branch main
? Target repo owner myorg
? Target repo name wiki
? Target path (files will be copied here) docs/website/
? Target branch main
? Clean target directory before sync? Yes
? Add another push target? No

Configuration summary:
  Mode: push

  Push:
    Source path:   docs/
    Source branch: main
    Target 1: myorg/wiki:docs/website/ (main) clean=true

? Generate workflow file? Yes

✅ Written to /path/to/website/.github/workflows/docsync.yml
```

## Generated Workflows

### Push (multi-target via matrix)

```yaml
name: Sync Docs

on:
  push:
    branches: ["main"]
    paths:
      - "docs/**"
  workflow_dispatch:

jobs:
  push-docs:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        include:
          - dst_owner: "myorg"
            dst_repo_name: "wiki"
            dst_path: "docs/website/"
            dst_branch: "main"
            clean: true
            dedup: false
    steps:
      - uses: actions/checkout@v6
        with: { ref: "main", path: _source }
      - uses: actions/checkout@v6
        with:
          repository: ${{ matrix.dst_owner }}/${{ matrix.dst_repo_name }}
          ref: ${{ matrix.dst_branch }}
          token: ${{ secrets.PAT_DOCSYNC }}
          path: _target
      - run: |
          DST="_target/${{ matrix.dst_path }}"
          if [ "${{ matrix.clean }}" = "true" ] && [ -d "$DST" ]; then
            find "$DST" -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +
          fi
          mkdir -p "$DST"
          rsync -av --exclude '.git' _source/docs/ "$DST/"
      # Optional: dedup step if matrix.dedup is true
      - working-directory: _target
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add -A
          git diff --cached --quiet || { git commit -m "docs: push from ${{ github.repository }}"; git push; }
```

### Pull (multi-source, sequential)

```yaml
name: Sync Docs

on:
  schedule:
    - cron: "0 0 * * *"
  workflow_dispatch:

jobs:
  pull-docs:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with: { token: "${{ secrets.PAT_DOCSYNC }}", ref: "main" }

      # Per source: SHA check → skip if unchanged
      - id: sha_0
        env: { GH_TOKEN: "${{ secrets.PAT_DOCSYNC }}" }
        run: |
          CURRENT=$(gh api "repos/myorg/website/commits/main" --jq .sha)
          LAST=$(jq -r '.sourceSHAs["myorg/website@main"] // ""' .github/docsync.json 2>/dev/null || echo "")
          echo "sha=$CURRENT" >> "$GITHUB_OUTPUT"
          [ "$CURRENT" = "$LAST" ] && echo "changed=false" >> "$GITHUB_OUTPUT" || echo "changed=true" >> "$GITHUB_OUTPUT"

      - if: steps.sha_0.outputs.changed == 'true'
        uses: actions/checkout@v6
        with:
          repository: "myorg/website"
          ref: "main"
          token: ${{ secrets.PAT_DOCSYNC }}
          path: _src_0
          sparse-checkout: "docs"

      - if: steps.sha_0.outputs.changed == 'true'
        run: |
          mkdir -p docs/website/
          rsync -av --delete --exclude '.git' _src_0/docs/ docs/website/
          rm -rf _src_0

      # Update stored SHA in .github/docsync.json under .sourceSHAs
      # Optional: cross-source dedup step if pullDedup is true

      - run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add -A
          git diff --cached --quiet || { git commit -m "docs: pull from source repos"; git push; }
```

### Both (combined, conditional jobs)

When mode is "both", push and pull jobs coexist in one file with conditional execution:
- `push-docs` runs on push and workflow_dispatch
- `pull-docs` runs on schedule and workflow_dispatch

## PAT Setup

The workflow needs a Personal Access Token with **repo** scope:

1. Create a PAT at [github.com/settings/tokens/new](https://github.com/settings/tokens/new)
2. Add it as a repository secret:
   ```bash
   gh secret set PAT_DOCSYNC
   ```

The secret is added to the repo **where the workflow runs**.

## Requirements

- Node.js >= 20
- Must be run inside a git repository
- [GitHub CLI](https://cli.github.com/) (`gh`) optional, used for repo validation

## License

MIT
