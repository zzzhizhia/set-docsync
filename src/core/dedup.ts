import { createHash } from "node:crypto";
import { readdir, readFile, unlink, symlink, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function* walkFiles(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(full);
    } else if (entry.isFile()) {
      // isFile() returns false for symlinks — exactly what we want
      yield full;
    }
  }
}

async function removeBrokenSymlinks(dir: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      if (!(await exists(full))) {
        await unlink(full);
      }
    } else if (entry.isDirectory()) {
      await removeBrokenSymlinks(full);
    }
  }
}

async function hashFile(path: string): Promise<string> {
  const buf = await readFile(path);
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Replace byte-identical regular files with relative symlinks to the
 * lexicographically-first occurrence. Idempotent: re-running yields the same
 * result; broken symlinks from previous runs are cleaned before scanning.
 *
 * Returns the number of files replaced.
 */
export async function dedupeDirs(dirs: string[]): Promise<number> {
  const absDirs = dirs.filter(Boolean);

  for (const dir of absDirs) {
    if (await exists(dir)) await removeBrokenSymlinks(dir);
  }

  const hashToPaths = new Map<string, string[]>();
  for (const dir of absDirs) {
    if (!(await exists(dir))) continue;
    for await (const path of walkFiles(dir)) {
      const h = await hashFile(path);
      const arr = hashToPaths.get(h);
      if (arr) arr.push(path);
      else hashToPaths.set(h, [path]);
    }
  }

  let replaced = 0;
  for (const [, paths] of hashToPaths) {
    if (paths.length <= 1) continue;
    // Sort lexicographically so canonical selection is stable across runs:
    // otherwise re-runs could pick a different canonical and flip symlink
    // directions, filling git history with meaningless diff noise.
    paths.sort();
    const canonical = paths[0];
    for (let i = 1; i < paths.length; i++) {
      const duplicate = paths[i];
      // Confirm both still exist (defensive in case of concurrent writes)
      if (!(await exists(canonical)) || !(await exists(duplicate))) continue;
      const rel = relative(dirname(duplicate), canonical);
      await unlink(duplicate);
      await symlink(rel, duplicate);
      replaced++;
    }
  }
  return replaced;
}
