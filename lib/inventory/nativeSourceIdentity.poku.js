import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { strict as assert, test } from "poku";

import { parseCmakeLikeFile } from "../ecosystems/parsers-misc.js";
import { acquireNativeSourceObjects, cacheNativeSourceConfigProvider, snapshotNativeSourceObject } from "../../contrib/native-source-cache.js";
import { materializeNativeAcquisitions, nativeAcquisitionRequests } from "../cli/nativeAcquisition.js";

test("raw branch installer exports only a hash-verified checked-in package config with a literal directory install", () => {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-source-config-"));
  const repo = join(root, "repo"); const scan = join(root, "scan"); const cache = join(root, "cache");
  const config = "share/cmake/fixture/FixtureConfig.cmake";
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();
  try {
    mkdirSync(join(repo, "share/cmake/fixture"), { recursive: true }); mkdirSync(scan);
    git("init", "--quiet", "--initial-branch=master");
    git("config", "user.email", "test@example.invalid"); git("config", "user.name", "Test");
    writeFileSync(join(repo, "CMakeLists.txt"), "project(Fixture)\ninstall(DIRECTORY share DESTINATION .)\n");
    writeFileSync(join(repo, "install.cmake"), 'set(FILENAME master.tar.gz)\nset(URL "https://github.com/example/fixture/archive/${FILENAME}")\nfile(DOWNLOAD ${URL} local.tar.gz)\n', { mode: 0o755 });
    writeFileSync(join(repo, config), "set(Fixture_FOUND TRUE)\n");
    git("add", "."); git("commit", "--quiet", "-m", "source");
    const revision = git("rev-parse", "HEAD");
    const repository = "https://github.com/example/fixture";
    const url = "https://raw.githubusercontent.com/example/fixture/master/install.cmake";
    const retained = snapshotNativeSourceObject({ repository, selector: "master", revision, gitDir: repo, cache, url, floatingRef: "refs/heads/master" });
    const args = { declaration: { url, gitRepository: repository, gitTag: "master" },
      sourceFile: join(scan, "CMakeLists.txt"), sourceRoot: scan, cache, requestedName: "Fixture" };
    const result = cacheNativeSourceConfigProvider(args);
    const manifest = JSON.parse(readFileSync(result.providerManifest, "utf8"));
    const snapshot = JSON.parse(readFileSync(join(cache, manifest.providers[0].metadata.path), "utf8"));
    assert.equal(snapshot.version, revision);
    assert.equal(snapshot.versionKind, "source-revision");
    assert.deepEqual(snapshot.files, [config]);
    assert.ok(snapshot.evidence.some((entry) => entry.member === config));
    assert.equal(cacheNativeSourceConfigProvider({ ...args, requestedName: "OtherConfig" }), undefined);
    assert.equal(cacheNativeSourceConfigProvider({ ...args, declaration: { ...args.declaration, url: args.declaration.url.replace("/master/", "/main/") } }), undefined);
    writeFileSync(join(retained.directory, config), "set(Fixture_FOUND FALSE)\n");
    assert.equal(cacheNativeSourceConfigProvider(args), undefined, "tampered object bytes do not prove the shipped config");

    writeFileSync(join(repo, "CMakeLists.txt"), "project(Fixture)\nif(ENABLE_INSTALL)\ninstall(DIRECTORY share DESTINATION .)\nendif()\n");
    git("commit", "--quiet", "-am", "conditional install");
    snapshotNativeSourceObject({ repository, selector: "master", revision: git("rev-parse", "HEAD"), gitDir: repo, cache, url, floatingRef: "refs/heads/master" });
    assert.equal(cacheNativeSourceConfigProvider(args), undefined, "unknown install conditions cannot prove an unconditional config export");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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

await test("an omitted ExternalProject Git tag freezes master, not the repository HEAD", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cdxgen-cmake-default-"));
  const repo = join(dir, "repo"); const source = join(dir, "source"); const cache = join(dir, "cache");
  mkdirSync(repo); mkdirSync(source);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env }).trim();
  try {
    git("init", "--quiet", "--initial-branch=master");
    git("config", "user.email", "test@example.invalid"); git("config", "user.name", "Test");
    writeFileSync(join(repo, "CMakeLists.txt"), "project(owned VERSION 3.4.5)\n");
    git("add", "CMakeLists.txt"); git("commit", "--quiet", "-m", "master");
    const master = git("rev-parse", "HEAD");
    git("switch", "-q", "-c", "main");
    writeFileSync(join(repo, "CMakeLists.txt"), "project(owned VERSION 9.0.0)\n");
    git("commit", "--quiet", "-am", "main");
    const main = git("rev-parse", "HEAD");
    const file = join(source, "CMakeLists.txt");
    const compare = (selector) => {
      writeFileSync(file, `ExternalProject_Add(owned GIT_REPOSITORY ${repository}${selector ? ` GIT_TAG ${selector}` : ""})\n`);
      return parseCmakeLikeFile(file, "generic", { sourceRoot: source, nativeSourceCache: cache });
    };
    const cold = compare();
    const [cached, head] = await acquireNativeSourceObjects({ cache, sourceRoot: source, resolveFloating: true, gitDir: repo,
      declarations: [{ gitRepository: repository, gitTagDefault: "cmake-master" }, { gitRepository: repository, gitTag: "HEAD" }] });
    assert.equal(cached.revision, master);
    assert.equal(head.revision, main);
    git("branch", "-f", "master", main);
    const passive = compare();
    assert.equal(passive.pkgList[0].version, "3.4.5");
    const requestKeys = new Set(nativeAcquisitionRequests(cold.requirements).map((request) => request.key));
    const acquired = materializeNativeAcquisitions(cold.pkgList, cold.dependenciesList, cold.requirements, source,
      { nativeSourceCache: cache }, requestKeys);
    const structural = acquired.updatedRequirements.values().find((requirement) => requirement.role === "build-target");
    assert.deepEqual(structural, passive.requirements.find((requirement) => requirement.role === "build-target"));
    assert.ok(!acquired.pkgList[0].properties.some((property) =>
      property.name === "cdx:build:requirement" && JSON.parse(property.value).role === "build-target"));
    assert.equal(compare("HEAD").pkgList[0].version, "9.0.0");
    assert.ok(!compare("${USER_REF}").pkgList[0].version, "an explicit unresolved tag cannot use the omitted-tag default");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
