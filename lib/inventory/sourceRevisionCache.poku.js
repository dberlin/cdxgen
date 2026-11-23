import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { strict as assert, describe, test } from "poku";

import { safeSpawnSync, setDirWalkCacheRoot } from "../core/fs.js";
import { resetRunState } from "../core/runState.js";
import { sourceRevisionOf } from "./sourceRevision.js";

function git(root, ...args) {
  return execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-revision-cache-"));
  for (const dir of ["one", "two"]) {
    mkdirSync(join(root, dir));
    writeFileSync(join(root, dir, "package.json"), '{"name":"fixture"}');
    writeFileSync(join(root, dir, "source.txt"), "first\n");
  }
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture");
  resetRunState();
  return root;
}

function isolated(run) {
  const root = fixture();
  try { run(root); } finally {
    resetRunState();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("generation-scoped source revision snapshots", () => {
  test("keeps unrelated dirty projects separate and returns isolated values", () => isolated((root) => {
    writeFileSync(join(root, "two", "source.txt"), "dirty\n");
    const manifest = join(root, "one", "package.json");
    const first = sourceRevisionOf(manifest);
    assert.equal(first.version, git(root, "rev-parse", "HEAD"));
    first.version = "caller mutation";
    assert.notEqual(sourceRevisionOf(manifest).version, first.version);
    assert.equal(sourceRevisionOf(join(root, "two", "package.json")), undefined);
    assert.equal(sourceRevisionOf(join(root, "package.json")), undefined);
  }));

  test("observes same-size timestamp-preserving edits on the next generation", () => isolated((root) => {
    const manifest = join(root, "one", "package.json");
    const file = join(root, "one", "source.txt");
    assert.ok(sourceRevisionOf(manifest));
    const before = statSync(file);
    writeFileSync(file, "other\n");
    utimesSync(file, before.atime, before.mtime);
    assert.ok(sourceRevisionOf(manifest), "one observed snapshot lasts for a generation");
    resetRunState();
    assert.equal(sourceRevisionOf(manifest), undefined);
  }));

  test("observes staged additions, deletions, renames and new commits after reset", () => isolated((root) => {
    const manifest = join(root, "one", "package.json");
    assert.ok(sourceRevisionOf(manifest));
    writeFileSync(join(root, "one", "new.txt"), "new");
    git(root, "add", ".");
    resetRunState();
    assert.equal(sourceRevisionOf(manifest), undefined);
    git(root, "commit", "-qm", "add");
    resetRunState();
    assert.equal(sourceRevisionOf(manifest).version, git(root, "rev-parse", "HEAD"));
    git(root, "mv", "one/source.txt", "two/renamed.txt");
    resetRunState();
    assert.equal(sourceRevisionOf(manifest), undefined, "rename source subtree is dirty too");
    assert.equal(sourceRevisionOf(join(root, "two", "package.json")), undefined);
    git(root, "commit", "-qm", "rename");
    rmSync(manifest);
    resetRunState();
    assert.equal(sourceRevisionOf(manifest), undefined);
  }));

  test("uses NUL-delimited tracked paths and nearest nested repository ownership", () => isolated((root) => {
    const odd = join(root, "one", "tab\tnewline\n.json");
    writeFileSync(odd, "{}");
    git(root, "add", ".");
    git(root, "commit", "-qm", "odd path");
    const nested = join(root, "one", "nested");
    mkdirSync(nested);
    const manifest = join(nested, "package.json");
    writeFileSync(manifest, "{}");
    git(nested, "init", "-q");
    git(nested, "add", ".");
    git(nested, "commit", "-qm", "nested");
    resetRunState();
    assert.equal(sourceRevisionOf(odd).manifest, "one/tab\tnewline\n.json");
    assert.equal(sourceRevisionOf(manifest).root, nested);
    assert.equal(sourceRevisionOf(manifest).version, git(nested, "rev-parse", "HEAD"));
  }));

  test("invalidates after source-writing external helpers within a generation", () => isolated((root) => {
    const manifest = join(root, "one", "package.json");
    assert.ok(sourceRevisionOf(manifest));
    const result = safeSpawnSync(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1], 'changed')", join(root, "one", "source.txt")], { shell: false });
    assert.equal(result.status, 0);
    assert.equal(sourceRevisionOf(manifest), undefined);
  }));

  test("immutable snapshots do not suppress invalidation of a mutable checkout", () => isolated((root) => {
    const other = fixture();
    const manifest = join(root, "one", "package.json");
    const mutableManifest = join(other, "one", "package.json");
    try {
      setDirWalkCacheRoot(root);
      const immutableRevision = sourceRevisionOf(manifest);
      assert.ok(sourceRevisionOf(mutableManifest));
      const result = safeSpawnSync(process.execPath, [
        "-e", "require('node:fs').writeFileSync(process.argv[1], 'changed')",
        join(other, "one", "source.txt"),
      ], { shell: false });
      assert.equal(result.status, 0);
      assert.deepEqual(sourceRevisionOf(manifest), immutableRevision);
      assert.equal(sourceRevisionOf(mutableManifest), undefined);
      setDirWalkCacheRoot(undefined);
      writeFileSync(join(root, "one", "source.txt"), "changed");
      resetRunState();
      assert.equal(sourceRevisionOf(manifest), undefined);
    } finally {
      setDirWalkCacheRoot(undefined);
      rmSync(other, { recursive: true, force: true });
    }
  }));

  test("preserves dirty submodule and unmerged subtree evidence", () => isolated((root) => {
    const provider = fixture();
    try {
      git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", provider, "one/submodule");
      git(root, "commit", "-qam", "submodule");
      resetRunState();
      assert.ok(sourceRevisionOf(join(root, "one", "package.json")), "clean populated submodules retain revision evidence");
      writeFileSync(join(root, "one", "submodule", "one", "source.txt"), "dirty submodule");
      resetRunState();
      assert.equal(sourceRevisionOf(join(root, "one", "package.json")), undefined);
      assert.ok(sourceRevisionOf(join(root, "two", "package.json")));
      git(root, "checkout", "-qb", "conflict");
      writeFileSync(join(root, "two", "source.txt"), "branch");
      git(root, "commit", "-qam", "branch");
      git(root, "checkout", "-q", "-");
      writeFileSync(join(root, "two", "source.txt"), "other");
      git(root, "commit", "-qam", "other");
      assert.throws(() => git(root, "merge", "conflict"));
      resetRunState();
      assert.equal(sourceRevisionOf(join(root, "two", "package.json")), undefined);
    } finally {
      rmSync(provider, { recursive: true, force: true });
    }
  }));

  test("never executes configured clean/process filters in queried or sibling subtrees", () => {
    for (const driver of ["clean", "process"]) {
      for (const directory of ["one", "two"]) isolated((root) => {
        writeFileSync(join(root, ".gitattributes"), "**/source.txt filter=fixture\n");
        git(root, "add", ".");
        git(root, "commit", "-qm", "attributes");
        const marker = join(root, "filter-executed");
        git(root, "config", `filter.fixture.${driver}`, `touch '${marker}'; ${driver === "clean" ? "cat" : "exit 1"}`);
        writeFileSync(join(root, directory, "source.txt"), "changed");
        resetRunState();
        assert.equal(sourceRevisionOf(join(root, "one", "package.json")), undefined);
        assert.throws(() => statSync(marker), { code: "ENOENT" });
      });
    }
  });

  test("rechecks external included Git configuration after helpers for immutable sources", () => isolated((root) => {
    const external = mkdtempSync(join(tmpdir(), "cdxgen-external-git-config-"));
    const config = join(external, "config");
    const marker = join(external, "filter-executed");
    try {
      writeFileSync(config, "");
      writeFileSync(join(root, ".gitattributes"), "**/source.txt filter=fixture\n");
      git(root, "add", ".");
      git(root, "commit", "-qm", "attributes");
      git(root, "config", "include.path", config);
      writeFileSync(join(root, "two", "source.txt"), "already dirty");
      resetRunState();
      setDirWalkCacheRoot(root);
      assert.ok(sourceRevisionOf(join(root, "one", "package.json")));
      const filter = `[filter "fixture"]\nclean = "touch '${marker}'; cat"\n`;
      const result = safeSpawnSync(process.execPath, [
        "-e", "require('node:fs').writeFileSync(process.argv[1], process.argv[2])",
        config, filter,
      ], { shell: false });
      assert.equal(result.status, 0);
      assert.equal(sourceRevisionOf(join(root, "two", "package.json")), undefined);
      assert.throws(() => statSync(marker), { code: "ENOENT" });
    } finally {
      setDirWalkCacheRoot(undefined);
      rmSync(external, { recursive: true, force: true });
    }
  }));

  test("refreshes linked-worktree revisions when Git metadata outside the immutable root changes", () => isolated((root) => {
    const checkout = mkdtempSync(join(tmpdir(), "cdxgen-linked-immutable-"));
    try {
      git(root, "worktree", "add", "--detach", "-q", checkout, "HEAD");
      setDirWalkCacheRoot(checkout);
      const manifest = join(checkout, "one", "package.json");
      const before = sourceRevisionOf(manifest);
      const next = git(root, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "same tree");
      assert.notEqual(next, before.version);
      const headFile = git(checkout, "rev-parse", "--path-format=absolute", "--git-path", "HEAD");
      const result = safeSpawnSync(process.execPath, [
        "-e", "require('node:fs').writeFileSync(process.argv[1], process.argv[2])",
        headFile, `${next}\n`,
      ], { shell: false });
      assert.equal(result.status, 0);
      assert.equal(sourceRevisionOf(manifest).version, next);
    } finally {
      setDirWalkCacheRoot(undefined);
      git(root, "worktree", "remove", "--force", checkout);
    }
  }));

  test("does not reuse split-index evidence after its external shared index disappears", () => isolated((root) => {
    const checkout = mkdtempSync(join(tmpdir(), "cdxgen-split-immutable-"));
    try {
      git(root, "worktree", "add", "--detach", "-q", checkout, "HEAD");
      git(checkout, "update-index", "--split-index");
      const shared = git(checkout, "rev-parse", "--path-format=absolute", "--shared-index-path");
      assert.ok(shared);
      setDirWalkCacheRoot(checkout);
      const manifest = join(checkout, "one", "package.json");
      assert.ok(sourceRevisionOf(manifest));
      const result = safeSpawnSync(process.execPath, [
        "-e", "require('node:fs').unlinkSync(process.argv[1])", shared,
      ], { shell: false });
      assert.equal(result.status, 0);
      assert.equal(sourceRevisionOf(manifest), undefined);
    } finally {
      setDirWalkCacheRoot(undefined);
      git(root, "worktree", "remove", "--force", checkout);
    }
  }));

  test("guards submodule-local filters without rejecting unrelated sibling projects", () => isolated((root) => {
    const provider = fixture();
    try {
      git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", provider, "one/submodule");
      const child = join(root, "one", "submodule");
      writeFileSync(join(child, ".gitattributes"), "**/source.txt filter=child\n");
      git(child, "add", ".");
      git(child, "commit", "-qm", "attributes");
      git(root, "commit", "-qam", "submodule");
      for (const driver of ["clean", "process"]) {
        const marker = join(root, `${driver}-executed`);
        git(child, "config", `filter.child.${driver}`, `touch '${marker}'; ${driver === "clean" ? "cat" : "exit 1"}`);
        writeFileSync(join(child, "one", "source.txt"), "changed");
        resetRunState();
        assert.equal(sourceRevisionOf(join(root, "one", "package.json")), undefined);
        assert.ok(sourceRevisionOf(join(root, "two", "package.json")));
        assert.throws(() => statSync(marker), { code: "ENOENT" });
        git(child, "config", "--unset", `filter.child.${driver}`);
      }
    } finally {
      rmSync(provider, { recursive: true, force: true });
    }
  }));

  test("fails closed for cyclic populated gitlink metadata", () => isolated((root) => {
    const head = git(root, "rev-parse", "HEAD");
    git(root, "update-index", "--add", "--cacheinfo", `160000,${head},one/cycle`);
    symlinkSync("..", join(root, "one", "cycle"), "dir");
    resetRunState();
    assert.equal(sourceRevisionOf(join(root, "one", "package.json")), undefined);
    assert.ok(sourceRevisionOf(join(root, "two", "package.json")));
  }));

  test("fails closed when diff cannot read required repository objects", () => isolated((root) => {
    const manifest = join(root, "one", "package.json");
    const blob = git(root, "rev-parse", "HEAD:one/source.txt");
    rmSync(join(root, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
    writeFileSync(join(root, "one", "source.txt"), "changed");
    resetRunState();
    assert.equal(sourceRevisionOf(manifest), undefined);
  }));

  test("fails closed for corrupt Git index and refreshes repository config", () => isolated((root) => {
    const manifest = join(root, "one", "package.json");
    git(root, "remote", "add", "origin", "https://github.com/example/first.git");
    assert.equal(sourceRevisionOf(manifest).repository, "https://github.com/example/first");
    git(root, "remote", "set-url", "origin", "https://github.com/example/second.git");
    resetRunState();
    assert.equal(sourceRevisionOf(manifest).repository, "https://github.com/example/second");
    const index = join(root, ".git", "index");
    const bytes = readFileSync(index);
    writeFileSync(index, "broken");
    resetRunState();
    assert.equal(sourceRevisionOf(manifest), undefined);
    writeFileSync(index, bytes);
    resetRunState();
    assert.ok(sourceRevisionOf(manifest));
  }));
});
