import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "poku";
import { nativeSourceCacheKey } from "../inventory/nativeSourceIdentity.js";
import { reconcileNativeSourceProviders } from "./nativeSourceVersions.js";
import { parseCmakeLikeFile } from "./parsers-misc.js";

function fixture(check) {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-pinned-source-"));
  try { mkdirSync(join(root, "subprojects")); check(root); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test("local wrap alternatives materialize real identities rather than duplicate unversioned requests", () => fixture((root) => {
  writeFileSync(join(root, "meson.build"), "project('consumer')\ndependency('provided', version: '>= 1.0')\ndependency('unknown', version: '>= 9.0')\n");
  for (const version of ["1.2.3", "2.3.4"]) writeFileSync(join(root, "subprojects", `source-${version}.wrap`), `[wrap-file]\nsource_url = https://example.org/source-${version}.tar.gz\nsource_hash = ${"a".repeat(64)}\n[provide]\ndependency_names = provided\n`);
  const parsed = parseCmakeLikeFile(join(root, "meson.build"), "generic", { sourceRoot: root });
  assert.deepEqual(parsed.pkgList.filter((c) => c.version).map((c) => c.version).sort(), ["1.2.3", "2.3.4"]);
  assert.ok(!parsed.pkgList.some((c) => c.name === "provided" && !c.version));
  assert.ok(parsed.pkgList.some((c) => c.name === "unknown" && !c.version));
  const requirement = parsed.requirements.find((r) => r.requestedName === "provided");
  assert.equal(requirement.constraints, ">= 1.0");
  assert.equal(requirement.providerCandidates.filter((c) => c.kind === "local-wrap" && c.ref && c.selected === false).length, 2);
  for (const c of parsed.pkgList.filter((c) => c.version)) {
    assert.ok(c.purl.includes(`@${c.version}`));
    assert.ok(c.properties.some((p) => p.name === "cdx:build:requirement" && JSON.parse(p.value).requestedName === "provided"));
    assert.ok(parsed.dependenciesList.some((d) => d.dependsOn.includes(c["bom-ref"])));
  }
}));

test("unused git recipes retain source commit or release tag, not floating branches", () => fixture((root) => {
  writeFileSync(join(root, "meson.build"), "project('consumer')\n");
  for (const [name, revision] of [["pinned", "a".repeat(40)], ["release", "vendor-1.2.3"], ["floating", "feature-branch"]]) writeFileSync(join(root, "subprojects", `${name}.wrap`), `[wrap-git]\nurl = https://example.org/vendor/source.git\nrevision = ${revision}\n`);
  const parsed = parseCmakeLikeFile(join(root, "meson.build"), "generic", { sourceRoot: root });
  assert.ok(parsed.pkgList.some((c) => c.version === "a".repeat(40)));
  assert.ok(parsed.pkgList.some((c) => c.version === "vendor-1.2.3"));
  assert.ok(!parsed.pkgList.some((c) => c.version === "feature-branch"));
}));

test("exact declarations are versioned without turning minimum constraints into versions", () => fixture((root) => {
  const file = join(root, "meson.build");
  writeFileSync(file, "project('consumer')\ndependency('exact', version: '== 2.3.4')\ndependency('minimum', version: '>= 2.3.4')\n");
  const parsed = parseCmakeLikeFile(file, "generic", { sourceRoot: root });
  assert.equal(parsed.pkgList.find((c) => c.name === "exact").version, "2.3.4");
  assert.ok(!parsed.pkgList.find((c) => c.name === "minimum").version);
}));

test("CMake preserves vendor release tags as actual version identities", () => fixture((root) => {
  const file = join(root, "CMakeLists.txt");
  writeFileSync(file, "project(consumer)\nFetchContent_Declare(rocm GIT_REPOSITORY https://github.com/ROCm/rocm-cmake.git GIT_TAG rocm-6.4.4)\nFetchContent_Declare(ft GIT_REPOSITORY https://github.com/freetype/freetype.git GIT_TAG VER-2-13-3)\n");
  const parsed = parseCmakeLikeFile(file, "generic", { sourceRoot: root });
  assert.deepEqual(parsed.pkgList.map((c) => c.version), ["rocm-6.4.4", "VER-2-13-3"]);
}));

test("unsatisfied source releases and explicit facts-mode requests remain independent", () => fixture((root) => {
  writeFileSync(join(root, "meson.build"), "project('consumer')\ndependency('provided', version: '>= 2.0')\n");
  writeFileSync(join(root, "subprojects", "provided.wrap"), "[wrap-file]\nsource_url = https://example.org/provided-1.0.tar.gz\n");
  const file = join(root, "meson.build");
  const parsed = parseCmakeLikeFile(file, "generic", { sourceRoot: root });
  assert.ok(parsed.pkgList.some((c) => c.name === "provided" && !c.version));
  assert.ok(parsed.pkgList.some((c) => c.name === "provided" && c.version === "1.0"));
  writeFileSync(file, "project('consumer')\ndependency('provided')\n");
  const explicit = parseCmakeLikeFile(file, "generic", { sourceRoot: root, nativeDependencyFacts: "/external/facts.json" });
  assert.ok(explicit.pkgList.some((c) => c.name === "provided" && !c.version));
  assert.ok(explicit.pkgList.some((c) => c.name === "provided" && c.version === "1.0"));
}));

test("parsed branch snapshots retain observation provenance including ExternalProject default master", () => fixture((root) => {
  const cache = mkdtempSync(join(tmpdir(), "cdxgen-pinned-cache-"));
  try {
    const repository = "https://github.com/example/pinned";
    const revision = "b".repeat(40);
    const observedAt = "2026-11-04T10:00:00.000Z";
    mkdirSync(join(cache, "objects", nativeSourceCacheKey(repository, revision)), { recursive: true });
    mkdirSync(join(cache, "selectors"));
    for (const selector of ["main", "refs/heads/master"]) writeFileSync(join(cache, "selectors", `${nativeSourceCacheKey(repository, selector)}.json`), JSON.stringify({
      schema: 1, repository, selector, selectorKind: "branch-snapshot", revision, files: [],
      floatingRef: selector === "main" ? "refs/heads/main" : selector, observedAt,
    }));
    for (const selector of ["main", undefined]) {
      const file = join(root, "CMakeLists.txt");
      const declaration = selector ? `FetchContent_Declare(pinned GIT_REPOSITORY ${repository}.git GIT_TAG ${selector})` :
        `ExternalProject_Add(pinned GIT_REPOSITORY ${repository}.git)`;
      writeFileSync(file, `project(consumer)\n${declaration}\nfind_package(pinned)\n`);
      const parsed = parseCmakeLikeFile(file, "generic", { sourceRoot: root, nativeSourceCache: cache });
      const source = parsed.pkgList.find((c) => c.version === revision);
      assert.ok(source);
      assert.ok(source.properties.some((p) => p.name === "cdx:source:observedAt" && p.value === observedAt));
      assert.ok(source.properties.some((p) => p.name === "cdx:source:floatingRef" && p.value === `refs/heads/${selector || "master"}`));
      assert.ok(!parsed.pkgList.some((c) => c.name === "pinned" && !c.version));
      assert.ok(parsed.requirements.every((r) => r.providerCandidates.every((candidate) => candidate.selected === false)));
    }
  } finally { rmSync(cache, { recursive: true, force: true }); }
}));

test("archive selectors and checksum-only recipes preserve their honest identity kinds", () => fixture((root) => {
  const cmake = join(root, "CMakeLists.txt");
  writeFileSync(cmake, "project(consumer)\nFetchContent_Declare(floating URL https://github.com/example/source/archive/topic-ref.zip)\nFetchContent_Declare(release URL https://github.com/example/source/archive/refs/tags/vendor-1.2.3.zip)\n");
  const sources = parseCmakeLikeFile(cmake, "generic", { sourceRoot: root }).pkgList;
  assert.ok(!sources.find((c) => c.name === "floating").version);
  assert.equal(sources.find((c) => c.name === "release").version, "vendor-1.2.3");
  writeFileSync(join(root, "meson.build"), "project('consumer')\ndependency('opaque')\n");
  const hash = "c".repeat(64);
  writeFileSync(join(root, "subprojects", "opaque.wrap"), `[wrap-file]\nsource_url = https://example.org/opaque.tar.gz\nsource_hash = ${hash}\n`);
  const parsed = parseCmakeLikeFile(join(root, "meson.build"), "generic", { sourceRoot: root });
  const source = parsed.pkgList.find((c) => c.name === "opaque");
  assert.equal(source.version, `sha256:${hash}`);
  assert.ok(source.properties.some((p) => p.name === "cdx:version:kind" && p.value === "archive-hash"));
  assert.deepEqual(source.hashes, [{ alg: "SHA-256", content: hash }]);
}));

test("known versions survive mixed floating alternatives without duplicate unknown software", () => fixture((root) => {
  const file = join(root, "CMakeLists.txt");
  writeFileSync(file, "project(consumer)\nFetchContent_Declare(shared GIT_REPOSITORY https://github.com/example/source.git GIT_TAG v1.2.3)\nFetchContent_Declare(shared GIT_REPOSITORY https://github.com/example/source.git GIT_TAG feature-branch)\nfind_package(shared)\nfind_package(unbound)\n");
  const parsed = parseCmakeLikeFile(file, "generic", { sourceRoot: root });
  assert.equal(parsed.pkgList.filter((c) => c.name === "shared").length, 1);
  assert.equal(parsed.pkgList.find((c) => c.name === "shared").version, "v1.2.3");
  assert.ok(parsed.pkgList.some((c) => c.name === "unbound" && !c.version));
  const floating = parsed.requirements.find((r) => r.role === "source-declaration" && r.source.gitTag === "feature-branch");
  assert.ok(floating);
  assert.deepEqual(floating.providerCandidates, []);
  const refs = new Set(parsed.pkgList.map((c) => c["bom-ref"]));
  for (const requirement of parsed.requirements) for (const candidate of requirement.providerCandidates) {
    if (candidate.ref) assert.ok(refs.has(candidate.ref));
    assert.equal(candidate.selected, false);
  }
}));

test("GitHub archive cache lookup distinguishes same-spelled branch and tag selectors", () => fixture((root) => {
  const cache = mkdtempSync(join(tmpdir(), "cdxgen-archive-namespace-"));
  try {
    const repository = "https://github.com/example/namespaced";
    const tagRevision = "d".repeat(40);
    const branchRevision = "e".repeat(40);
    mkdirSync(join(cache, "selectors"));
    for (const [selector, revision, selectorKind] of [
      ["v1.2.3", tagRevision, "tag"],
      ["refs/tags/v1.2.3", tagRevision, "tag"],
      ["refs/heads/v1.2.3", branchRevision, "branch-snapshot"],
    ]) {
      mkdirSync(join(cache, "objects", nativeSourceCacheKey(repository, revision)), { recursive: true });
      writeFileSync(join(cache, "selectors", `${nativeSourceCacheKey(repository, selector)}.json`), JSON.stringify({
        schema: 1, repository, selector, selectorKind, revision, files: [],
        ...(selectorKind === "branch-snapshot" ? {
          floatingRef: "refs/heads/v1.2.3", observedAt: "2026-11-04T10:00:00.000Z",
        } : {}),
      }));
    }
    const file = join(root, "CMakeLists.txt");
    writeFileSync(file, "project(consumer)\nFetchContent_Declare(branch URL https://github.com/example/namespaced/archive/refs/heads/v1.2.3.tar.gz)\nFetchContent_Declare(tag URL https://github.com/example/namespaced/archive/refs/tags/v1.2.3.tar.gz)\n");
    const parsed = parseCmakeLikeFile(file, "generic", { sourceRoot: root, nativeSourceCache: cache });
    assert.equal(parsed.pkgList.find((component) => component.name === "branch").version, branchRevision);
    assert.equal(parsed.pkgList.find((component) => component.name === "tag").version, tagRevision);
  } finally { rmSync(cache, { recursive: true, force: true }); }
}));

test("literal Meson constraint lists retain requests outside either bound", () => fixture((root) => {
  const file = join(root, "meson.build");
  writeFileSync(file, "project('consumer')\ndependency('foo', version: ['>= 2.0', '< 3.0'])\n");
  for (const [version, excluded] of [["1.0", true], ["2.0", false], ["3.0", true]]) {
    writeFileSync(join(root, "subprojects", "foo.wrap"), `[wrap-file]\nsource_url = https://example.org/foo-${version}.tar.gz\n`);
    const parsed = parseCmakeLikeFile(file, "generic", { sourceRoot: root });
    assert.equal(parsed.pkgList.some((component) => component.name === "foo" && !component.version), excluded, version);
    assert.ok(parsed.pkgList.some((component) => component.name === "foo" && component.version === version));
    assert.equal(parsed.requirements.find((requirement) => requirement.role === "software").constraints, "['>= 2.0', '< 3.0']");
  }
}));

test("CMake literal ranges enforce inclusive lower and inclusive or exclusive upper bounds", () => fixture((root) => {
  const file = join(root, "CMakeLists.txt");
  for (const [version, range, excluded] of [
    ["1.0", "2.0...3.0", true], ["2.0", "2.0...3.0", false],
    ["3.0", "2.0...3.0", false], ["3.0", "2.0...<3.0", true],
    ["2.0", "2.0...<3.0", false], ["1.0", "2.0...<3.0", true],
  ]) {
    writeFileSync(file, `project(consumer)\nFetchContent_Declare(foo URL https://example.org/foo-${version}.tar.gz)\nfind_package(foo ${range})\n`);
    const parsed = parseCmakeLikeFile(file, "generic", { sourceRoot: root });
    assert.equal(parsed.pkgList.some((component) => component.name === "foo" && !component.version), excluded, `${version}:${range}`);
    assert.ok(parsed.pkgList.some((component) => component.name === "foo" && component.version === version));
  }
}));

test("hipDNN-shaped file STRINGS and tag helper bind default, caller VERSION and caller HASH", () => fixture((root) => {
  mkdirSync(join(root, "cmake"));
  writeFileSync(join(root, "cmake", "default_flatc_version.txt"), "25.9.23\n");
  writeFileSync(join(root, "cmake", "Dependencies.cmake"), `
macro(_determine_git_tag PREFIX DEFAULT)
  if(HASH)
    set(GIT_TAG \${HASH})
  elseif(VERSION AND NOT "\${PREFIX}" STREQUAL "FALSE")
    set(GIT_TAG \${PREFIX}\${VERSION})
  else()
    set(GIT_TAG \${DEFAULT})
  endif()
endmacro()
function(_fetch_flatbuffers VERSION HASH)
  _determine_git_tag(v "\${_HIPDNN_DEFAULT_FLATBUFFERS_VERSION}")
  FetchContent_Declare(flatbuffers GIT_REPOSITORY https://github.com/google/flatbuffers.git GIT_TAG \${GIT_TAG})
endfunction()
function(_fetch_spdlog VERSION HASH)
  _determine_git_tag(v v1.15.3)
  FetchContent_Declare(spdlog GIT_REPOSITORY https://github.com/gabime/spdlog.git GIT_TAG \${GIT_TAG})
endfunction()
`);
  const file = join(root, "CMakeLists.txt");
  for (const [call, expected] of [
    ["_fetch_flatbuffers(\"\" \"\")", "25.9.23"],
    ["_fetch_spdlog(\"\" \"\")", "v1.15.3"],
    ["_fetch_spdlog(1.16.0 \"\")", "v1.16.0"],
    [`_fetch_spdlog(1.16.0 ${"a".repeat(40)})`, "a".repeat(40)],
  ]) {
    writeFileSync(file, `project(consumer)\nfile(STRINGS "\${CMAKE_CURRENT_SOURCE_DIR}/cmake/default_flatc_version.txt" _HIPDNN_DEFAULT_FLATBUFFERS_VERSION LIMIT_COUNT 1)\ninclude(cmake/Dependencies.cmake)\n${call}\n`);
    const parsed = parseCmakeLikeFile(file, "generic", { sourceRoot: root });
    assert.ok(parsed.pkgList.some((component) => component.version === expected), call);
    assert.ok(parsed.requirements.some((requirement) => requirement.source?.gitTag === expected), call);
  }
}));

test("GitHub release assets preserve decoded release tags independently of filenames and embedded revisions", () => fixture((root) => {
  const file = join(root, "CMakeLists.txt");
  const revision = "6086c272a3a59eb0b6b79dcbe00486bf4461856a";
  writeFileSync(file, `project(consumer)
file(DOWNLOAD https://github.com/shark-infra/amdgpu-device-libs/releases/download/v20231101/amdgpu-device-libs-llvm-${revision}.tgz device.tgz)
file(DOWNLOAD https://github.com/ROCm/timemory/releases/download/timemory-timem%2Fv0.0.4/timemory-timem-1.0.0-Linux.sh installer.sh EXPECTED_MD5 63da7df7996a86d6d9ce312276c2f014)
`);
  const parsed = parseCmakeLikeFile(file, "generic", { sourceRoot: root });
  const device = parsed.pkgList.find((component) => component.version === "v20231101");
  assert.ok(device);
  assert.ok(device.properties.some((property) => property.name === "cdx:download:filenameRevision" && property.value === revision));
  assert.ok(!device.properties.some((property) => property.name === "cdx:source:revision" && property.value === revision), "filename SHA is not a verified checkout revision");
  const installer = parsed.pkgList.find((component) => component.version === "timemory-timem/v0.0.4");
  assert.ok(installer);
  assert.ok(!parsed.pkgList.some((component) => component.version === "1.0.0"));
  assert.deepEqual(installer.hashes, [{ alg: "MD5", content: "63da7df7996a86d6d9ce312276c2f014" }]);
  assert.ok(installer.properties.some((property) => property.name === "cdx:download:filename" && property.value === "timemory-timem-1.0.0-Linux.sh"));
}));

test("Emscripten preloaded downloads remain data with the declaration checksum and lineage", () => fixture((root) => {
  const file = join(root, "CMakeLists.txt");
  writeFileSync(file, `project(consumer)
if(EMSCRIPTEN)
target_link_options(profiler PRIVATE --preload-file embed.tracy)
file(DOWNLOAD https://share.nereid.pl/i/embed.tracy \${CMAKE_CURRENT_BINARY_DIR}/embed.tracy EXPECTED_MD5 ca0fa4f01e7b8ca5581daa16b16c768d)
endif()
`);
  const parsed = parseCmakeLikeFile(file, "generic", { sourceRoot: root });
  const artifact = parsed.pkgList.find((component) => component.name === "embed.tracy");
  assert.equal(artifact.type, "data");
  assert.ok(!artifact.version);
  assert.deepEqual(artifact.hashes, [{ alg: "MD5", content: "ca0fa4f01e7b8ca5581daa16b16c768d" }]);
  assert.ok(decodeURIComponent(artifact.purl).includes("checksum=md5:ca0fa4f01e7b8ca5581daa16b16c768d"));
  const requirement = parsed.requirements.find((entry) => entry.command === "file-download");
  assert.equal(requirement.role, "data-artifact");
  assert.equal(requirement.line, 4);
  assert.equal(requirement.source.url, "https://share.nereid.pl/i/embed.tracy");
}));

test("an unresolved explicit Git tag never consumes the omitted-tag master cache entry", () => fixture((root) => {
  const cache = mkdtempSync(join(tmpdir(), "cdxgen-unresolved-pin-"));
  try {
    const repository = "https://github.com/example/pinned";
    const revision = "b".repeat(40);
    mkdirSync(join(cache, "objects", nativeSourceCacheKey(repository, revision)), { recursive: true });
    mkdirSync(join(cache, "selectors"));
    const selector = "refs/heads/master";
    writeFileSync(join(cache, "selectors", `${nativeSourceCacheKey(repository, selector)}.json`), JSON.stringify({
      schema: 1, repository, selector, selectorKind: "branch-snapshot", revision, files: [],
      floatingRef: "refs/heads/master", observedAt: "2026-11-04T10:00:00.000Z",
    }));
    const file = join(root, "CMakeLists.txt");
    writeFileSync(file, `project(consumer)
ExternalProject_Add(pinned GIT_REPOSITORY ${repository}.git GIT_TAG \${UNSET_TAG})
ExternalProject_Add(empty GIT_REPOSITORY ${repository}.git GIT_TAG "")
ExternalProject_Add(disabled GIT_REPOSITORY ${repository}.git DOWNLOAD_COMMAND "" UPDATE_COMMAND "")
`);
    const parsed = parseCmakeLikeFile(file, "generic", { sourceRoot: root, nativeSourceCache: cache });
    assert.ok(!parsed.pkgList.some((component) => component.version));
    assert.ok(parsed.requirements.some((requirement) => requirement.source.gitTagExpression?.includes("UNSET_TAG")));
  } finally { rmSync(cache, { recursive: true, force: true }); }
}));

test("helper templates bind exact declaration providers without resolving an unknown real invocation", () => fixture((root) => {
  const file = join(root, "CMakeLists.txt");
  writeFileSync(file, `project(consumer)
function(acquire VERSION)
  FetchContent_Declare(shared GIT_REPOSITORY https://github.com/example/shared.git GIT_TAG \${VERSION})
endfunction()
acquire(v1.2.3)
acquire(\${UNKNOWN_VERSION})
`);
  const parsed = parseCmakeLikeFile(file, "generic", { sourceRoot: root });
  const resolved = reconcileNativeSourceProviders(parsed.pkgList, parsed.dependenciesList, root, {
    parentComponent: parsed.parentComponent, nativeSourceManifests: [file],
  });
  const provider = resolved.pkgList.find((component) => component.version === "v1.2.3");
  const unresolved = resolved.pkgList.find((component) => !component.version && component.name === "shared");
  assert.ok(provider && unresolved);
  const template = parsed.requirements.find((requirement) => requirement.source?.helperTemplate);
  const { providerCandidates: _candidates, ...templateIdentity } = template;
  const updated = resolved.updatedRequirements.get(JSON.stringify(templateIdentity));
  assert.equal(updated.originalBomRef, unresolved["bom-ref"]);
  assert.equal(updated.source.gitTagExpression, template.source.gitTagExpression);
  assert.deepEqual(updated.providerCandidates, [{ kind: "declared-source", ref: provider["bom-ref"], selected: false }]);
  const candidates = unresolved.properties.filter((p) => p.name === "cdx:build:requirement").map((p) => JSON.parse(p.value));
  const unknown = candidates.find((requirement) => requirement.source?.helperInvocations?.length && requirement.source.gitTagExpression);
  assert.ok(unknown, "the actual explicitly unresolved call is still independent of the template");
  assert.deepEqual(unknown.providerCandidates.map((candidate) => candidate.ref), [unresolved["bom-ref"]]);
  assert.deepEqual(resolved.occurrenceRemapOverrides.get(unresolved["bom-ref"]), [unresolved["bom-ref"]]);
  assert.deepEqual(new Set(resolved.dependencies[0].dependsOn), new Set([provider["bom-ref"], unresolved["bom-ref"]]));
}));

test("preload classification requires the same binary-directory destination, not a matching basename", () => fixture((root) => {
  const file = join(root, "CMakeLists.txt");
  writeFileSync(file, `project(consumer)
target_link_options(app PRIVATE --preload-file assets/archive.zip)
file(DOWNLOAD https://example.org/library-1.2.3.zip downloads/archive.zip)
target_link_options(other PRIVATE --preload-file \${CMAKE_CURRENT_SOURCE_DIR}/trace.data)
file(DOWNLOAD https://example.org/trace.data \${CMAKE_CURRENT_BINARY_DIR}/trace.data)
`);
  const parsed = parseCmakeLikeFile(file, "generic", { sourceRoot: root });
  const library = parsed.pkgList.find((component) => component.name === "library-1.2.3.zip");
  assert.equal(library.type, "library");
  assert.equal(library.version, "1.2.3");
  assert.ok(library.purl.includes("@1.2.3"));
  assert.ok(!parsed.pkgList.some((component) => component.type === "data"), "source-directory and binary-directory assets are distinct");
  assert.ok(parsed.requirements.filter((requirement) => requirement.command === "file-download")
    .every((requirement) => requirement.role === "source-declaration"));
}));
