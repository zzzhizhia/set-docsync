# set-docsync

Interactive CLI to set up GitHub Actions workflows that sync documentation between repositories. Supports **push** (on commit), **pull** (on schedule), or **both** — with multi-repo targets.

## Quick Start

```bash
npx set-docsync
```

Run this inside any GitHub repository. The CLI walks you through configuration and generates `.github/workflows/docsync.yml`.

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
            dst_path: "/docs/website/"
            dst_branch: "main"
            clean: true
    steps:
      - uses: actions/checkout@v4
      - uses: andstor/copycat-action@v3
        with:
          personal_token: ${{ secrets.GITHUB_PAT_DOCSYNC }}
          src_path: "/docs/."
          dst_path: ${{ matrix.dst_path }}
          dst_owner: ${{ matrix.dst_owner }}
          dst_repo_name: ${{ matrix.dst_repo_name }}
          dst_branch: ${{ matrix.dst_branch }}
          src_branch: "main"
          clean: ${{ matrix.clean }}
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
      - uses: actions/checkout@v4

      - uses: actions/checkout@v4
        with:
          repository: "myorg/website"
          ref: "main"
          token: ${{ secrets.GITHUB_PAT_DOCSYNC }}
          path: _src_0
          sparse-checkout: "docs"

      - run: |
          mkdir -p docs/website/
          rsync -av --delete _src_0/docs/ docs/website/
          rm -rf _src_0

      - run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add -A
          if git diff --cached --quiet; then
            echo "No changes to sync"
          else
            git commit -m "docs: pull from source repos"
            git push
          fi
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
   gh secret set GITHUB_PAT_DOCSYNC
   ```

The secret is added to the repo **where the workflow runs**.

## Requirements

- Node.js >= 20
- Must be run inside a git repository
- [GitHub CLI](https://cli.github.com/) (`gh`) optional, used for repo validation

## License

MIT
