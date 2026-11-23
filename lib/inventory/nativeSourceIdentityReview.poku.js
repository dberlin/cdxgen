import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { strict as assert, test } from "poku";

import { snapshotNativeSourceObject } from "../../contrib/native-source-cache.js";
import { parseCmakeLikeFile } from "../ecosystems/parsers-misc.js";
import { preferFetchedCmakeDependencies } from "../ecosystems/cmakeResolver.js";
import { nativeComponentInstanceRef, trimComponents } from "./depsUtils.js";
import { nativeSourceIdentity } from "./nativeSourceIdentity.js";

const repository = "https://github.com/example/owned.git";
function withObjects(run) {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-source-review-"));
  const repo = join(root, "repo");
  const cache = join(root, "cache");
  mkdirSync(repo);
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
  try {
    git("init", "--quiet"); git("config", "user.email", "test@example.invalid"); git("config", "user.name", "Test");
    writeFileSync(join(repo, "CMakeLists.txt"), "project(owned VERSION 1.2.3)\n");
    git("add", "CMakeLists.txt"); git("commit", "--quiet", "-m", "first");
    const first = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "revision.txt"), "Different source object, same declared release\n");
    git("add", "revision.txt"); git("commit", "--quiet", "-m", "second");
    const second = git("rev-parse", "HEAD");
    run({ root, repo, cache, git, first, second });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("same alias and release retain different Git refs while same-pin aliases merge provenance", () => withObjects(({ root, repo, cache, first, second }) => {
  for (const revision of [first, second]) snapshotNativeSourceObject({ repository, selector: revision, revision, gitDir: repo, cache });
  const scan = join(root, "scan"); mkdirSync(scan);
  const file = join(scan, "CMakeLists.txt");
  writeFileSync(file, [
    `FetchContent_Declare(owned GIT_REPOSITORY ${repository} GIT_TAG ${first})`,
    `FetchContent_Declare(owned GIT_REPOSITORY ${repository} GIT_TAG ${second})`,
    `FetchContent_Declare(other_alias GIT_REPOSITORY ${repository} GIT_TAG ${first})`,
  ].join("\n"));
  const sources = parseCmakeLikeFile(file, "generic", { sourceRoot: scan, nativeSourceCache: cache }).pkgList;
  assert.equal(sources.length, 2);
  assert.ok(sources.every((source) => source.purl.startsWith("pkg:github/example/owned@1.2.3?")));
  assert.equal(new Set(sources.map((source) => source["bom-ref"])).size, 2);
  assert.ok(sources.every((source) => decodeURIComponent(source.purl).includes(`vcs_url=${repository}@`)));
  const pinned = sources.find((source) => source.properties.some((property) => property.name === "cdx:cmake:gitRef" && property.value === first));
  const declarations = pinned.properties.filter((property) => property.name === "cdx:build:requirement").map((property) => JSON.parse(property.value));
  assert.deepEqual(new Set(declarations.filter((record) => record.role === "source-declaration").map((record) => record.requestedName)), new Set(["owned", "other_alias"]));
}));

test("same local label and release retain separate SOURCE_DIR instances through normal deduplication", () => withObjects(({ root }) => {
  const scan = join(root, "scan"); mkdirSync(scan);
  for (const name of ["one", "two"]) { mkdirSync(join(scan, name)); writeFileSync(join(scan, name, "CMakeLists.txt"), "project(owned VERSION 1.2.3)\n"); }
  const file = join(scan, "CMakeLists.txt");
  writeFileSync(file, "ExternalProject_Add(build_owned SOURCE_DIR one)\nExternalProject_Add(build_owned SOURCE_DIR two)\n");
  const sources = parseCmakeLikeFile(file, "generic", { sourceRoot: scan }).pkgList;
  assert.equal(sources.length, 2);
  assert.equal(new Set(sources.map((source) => source.purl)).size, 1);
  assert.equal(new Set(sources.map((source) => source["bom-ref"])).size, 2);
  assert.equal(trimComponents(sources).length, 2);
  assert.equal(preferFetchedCmakeDependencies(sources).length, 2);
  for (const source of sources) {
    assert.equal(nativeComponentInstanceRef(source), source["bom-ref"]);
    const forged = structuredClone(source);
    forged.properties.find((property) => property.name === "cdx:cmake:sourceDirectory").value += "/different";
    assert.equal(nativeComponentInstanceRef(forged), undefined);
  }
}));

test("producer rejects a dot-dot-prefixed child cache before source writes", () => withObjects(({ repo, first }) => {
  const cache = join(repo, "..cache");
  assert.throws(() => snapshotNativeSourceObject({ repository, selector: first, revision: first, gitDir: repo, cache }));
  assert.ok(!existsSync(cache));
}));

test("reader rejects a valid snapshot placed in a dot-dot-prefixed source child", () => withObjects(({ repo, cache, first }) => {
  snapshotNativeSourceObject({ repository, selector: first, revision: first, gitDir: repo, cache });
  const inside = join(repo, "..cache"); cpSync(cache, inside, { recursive: true });
  assert.equal(nativeSourceIdentity({ gitRepository: repository, gitTag: first }, join(repo, "CMakeLists.txt"), inside, repo), undefined);
}));

test("manifest producer validates an omitted source-root boundary before cache or network writes", () => withObjects(({ repo, first }) => {
  const cache = join(repo, "cache");
  const manifest = join(repo, "CMakeLists.txt");
  writeFileSync(manifest, `FetchContent_Declare(owned GIT_REPOSITORY ${repository} GIT_TAG ${first})\n`);
  const result = spawnSync(process.execPath, ["contrib/native-source-cache.js", "--manifest", manifest, "--git-dir", join(repo, ".git"), "--cache", cache], { encoding: "utf8", timeout: 10000 });
  assert.notEqual(result.status, 0);
  assert.ok(!existsSync(cache));
  const fetchResult = spawnSync(process.execPath, ["contrib/native-source-cache.js", "--manifest", manifest, "--fetch", "--cache", cache], { encoding: "utf8", timeout: 10000 });
  assert.notEqual(fetchResult.status, 0);
  assert.ok(!existsSync(cache));
}));

test("object-directory producer protects the enclosing worktree", () => withObjects(({ repo, first }) => {
  const cache = join(repo, "cache");
  assert.throws(() => snapshotNativeSourceObject({ repository, selector: first, revision: first, gitDir: join(repo, ".git"), cache }));
  assert.ok(!existsSync(cache));
}));

test("replacement refs cannot relabel different metadata as the selected immutable commit", () => withObjects(({ repo, cache, git, first }) => {
  writeFileSync(join(repo, "CMakeLists.txt"), "project(owned VERSION 9.0.0)\n");
  git("commit", "--quiet", "-am", "different release");
  const replacement = git("rev-parse", "HEAD");
  git("replace", first, replacement);
  snapshotNativeSourceObject({ repository, selector: first, revision: first, gitDir: repo, cache });
  const identity = nativeSourceIdentity({ gitRepository: repository, gitTag: first }, join(repo, "CMakeLists.txt"), cache, repo);
  assert.equal(identity.version, "1.2.3");
  assert.equal(identity.revision, first);
}));
