import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { strict as assert, test } from "poku";

import { parseCmakeLikeFile } from "../ecosystems/parsers-misc.js";
import { snapshotNativeSourceObject } from "../../contrib/native-source-cache.js";

const repository = "https://github.com/example/owned.git";
test("normal parsing consumes exact cached source metadata, not branch heads or other refs", () => {
  const dir = mkdtempSync(join(tmpdir(), "cdxgen-source-object-"));
  const repo = join(dir, "repo");
  const cache = join(dir, "cache");
  const scan = join(dir, "scan");
  mkdirSync(repo); mkdirSync(scan);
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
  try {
    git("init", "--quiet"); git("config", "user.email", "test@example.invalid"); git("config", "user.name", "Test");
    git("remote", "add", "origin", repository);
    writeFileSync(join(repo, "CMakeLists.txt"), "project(owned VERSION 1.2.3)\nexecute_process(COMMAND touch SHOULD_NOT_RUN)\n");
    git("add", "CMakeLists.txt"); git("commit", "--quiet", "-m", "first");
    const first = git("rev-parse", "HEAD");
    git("tag", "release-a");
    writeFileSync(join(repo, "CMakeLists.txt"), "project(owned VERSION 2.0.0)\n");
    git("commit", "--quiet", "-am", "second");
    const second = git("rev-parse", "HEAD");
    snapshotNativeSourceObject({ repository, selector: first, revision: first, gitDir: repo, cache });
    const bare = join(dir, "bare");
    execFileSync("git", ["clone", "--bare", "--quiet", "--local", repo, bare], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
    snapshotNativeSourceObject({ repository, selector: second, revision: second, gitDir: bare, cache });
    snapshotNativeSourceObject({ repository, selector: "release-a", revision: first, gitDir: repo, cache });
    const file = join(scan, "CMakeLists.txt");
    writeFileSync(file, [first, second, "release-a", "main"].map((ref, i) => `FetchContent_Declare(alias${i} GIT_REPOSITORY ${repository} GIT_TAG ${ref})`).join("\n") + "\nfind_package(owned)\n");
    const parsed = parseCmakeLikeFile(file, "generic", { sourceRoot: scan, nativeSourceCache: cache });
    const sources = parsed.pkgList.filter((c) => c.properties.some((p) => p.name === "cdx:cmake:gitRef"));
    assert.equal(sources.length, 4);
    assert.deepEqual(sources.map((c) => c.version), ["1.2.3", "2.0.0", "1.2.3", ""]);
    assert.equal(new Set(sources.map((c) => c["bom-ref"])).size, 4);
    assert.ok(sources[0].properties.some((p) => p.name === "cdx:source:revision" && p.value === first));
    assert.ok(!parsed.pkgList.find((c) => c.name === "owned").version);
    assert.throws(() => snapshotNativeSourceObject({ repository, selector: "main", revision: second, gitDir: repo, cache }));
    assert.throws(() => snapshotNativeSourceObject({ repository, selector: first, revision: second, gitDir: repo, cache }));
    assert.throws(() => snapshotNativeSourceObject({ repository, selector: first, revision: first, gitDir: repo, cache: join(repo, "cache") }));
    const record = snapshotNativeSourceObject({ repository, selector: first, revision: first, gitDir: repo, cache });
    writeFileSync(join(record.directory, "CMakeLists.txt"), "project(owned VERSION 9.9.9)");
    const changed = parseCmakeLikeFile(file, "generic", { sourceRoot: scan, nativeSourceCache: cache }).pkgList.find((c) => c.properties.some((p) => p.name === "cdx:cmake:gitRef" && p.value === first));
    assert.equal(changed.version, first, "tampered cache cannot supply a release");
    assert.ok(!existsSync(join(repo, "SHOULD_NOT_RUN")));
    assert.ok(!existsSync(join(record.directory, "SHOULD_NOT_RUN")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("explicit floating-source snapshots resolve versions without following later branch changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "cdxgen-floating-source-"));
  const repo = join(dir, "repo");
  const scan = join(dir, "scan");
  const cache = join(dir, "cache");
  mkdirSync(repo); mkdirSync(scan);
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();
  try {
    git("init", "--quiet", "--initial-branch=main");
    git("config", "user.email", "test@example.invalid"); git("config", "user.name", "Test");
    writeFileSync(join(repo, "CMakeLists.txt"), "project(owned VERSION 3.4.5)\n");
    git("add", "."); git("commit", "--quiet", "-m", "first");
    const revision = git("rev-parse", "HEAD");
    const file = join(scan, "CMakeLists.txt");
    writeFileSync(file, `FetchContent_Declare(owned GIT_REPOSITORY ${repository} GIT_TAG main)\n`);
    const parse = () => parseCmakeLikeFile(file, "generic", { sourceRoot: scan, nativeSourceCache: cache }).pkgList[0];
    assert.ok(!parse().version, "an uncaptured floating branch has no exact version");
    snapshotNativeSourceObject({ repository, selector: "main", revision, gitDir: repo, cache,
      floatingRef: "refs/heads/main" });
    assert.equal(parse().version, "3.4.5");
    assert.ok(parse().properties.some((p) => p.name === "cdx:source:revision" && p.value === revision));
    writeFileSync(join(repo, "CMakeLists.txt"), "project(owned VERSION 9.0.0)\n");
    git("commit", "--quiet", "-am", "later");
    assert.equal(parse().version, "3.4.5", "passive scans consume the captured object, not the moving branch");
    git("branch", "topic", revision);
    git("branch", "origin/topic", "HEAD");
    snapshotNativeSourceObject({ repository, selector: "refs/heads/origin/topic", revision: git("rev-parse", "HEAD"),
      gitDir: repo, cache, floatingRef: "refs/heads/origin/topic" });
    writeFileSync(file, `FetchContent_Declare(owned GIT_REPOSITORY ${repository} GIT_TAG refs/heads/origin/topic)\n`);
    assert.equal(parse().version, "9.0.0", "qualified origin-prefixed branch is not a different topic branch");
    git("branch", "master", revision);
    const unspecifiedCache = join(dir, "unspecified-cache");
    assert.throws(() => execFileSync(process.execPath, [
      new URL("../../contrib/native-source-cache.js", import.meta.url).pathname,
      "--cache", unspecifiedCache, "--source-root", scan, "--git-dir", repo,
      "--repository", repository, "--resolve-floating",
    ], { stdio: "pipe" }), "direct repository requests must explicitly name a ref");
    assert.equal(existsSync(unspecifiedCache), false, "an omitted direct ref cannot create a default-branch snapshot");
    assert.throws(() => snapshotNativeSourceObject({ repository, selector: "other", revision: git("rev-parse", "HEAD"),
      gitDir: repo, cache, floatingRef: "refs/heads/main" }), "a snapshot cannot bind an unrelated selector");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
