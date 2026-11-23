import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { strict as assert, test } from "poku";

import { createCppBom } from "../cli/nativeBom.js";
import { createMultiXBom } from "../cli/index.js";

import { reconcileCmakeSourceProjects } from "./nativeSourceVersions.js";
import { parseCmakeLikeFile } from "./parsers-misc.js";

function withSource(run) {
  const directory = mkdtempSync(join(tmpdir(), "cdxgen-owned-metadata-"));
  try { run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}
function put(directory, file, text) {
  const destination = join(directory, file);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, text);
  return destination;
}
function facts(component) {
  return (component.properties || []).filter((property) => property.name === "cdx:cmake:versionCandidate").map((property) => JSON.parse(property.value));
}
function source(name, directory, revision = "1111111111111111111111111111111111111111") {
  return { name, version: revision, purl: `pkg:generic/${name}@${revision}#${directory}`, "bom-ref": `pkg:generic/${name}@${revision}#${directory}`,
    properties: [{ name: "cdx:cmake:sourceDir", value: directory }, { name: "cdx:version:kind", value: "source-revision" }] };
}

await test("VERSION-only discovery preserves explicit owners and leaves bare files unbound", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cdxgen-owned-metadata-"));
  try {
    put(directory, "explicit/VERSION", "#EXAMPLE_CORE_VERSION_MAJOR\n4\n#EXAMPLE_CORE_VERSION_MINOR\n5\n#EXAMPLE_CORE_VERSION_PATCH\n6\n");
    put(directory, "unbound/VERSION", "8.0.0\n");
    const { bomJson: bom } = await createMultiXBom([directory], { projectType: ["c", "js"], multiProject: true, installDeps: false, deep: false, specVersion: 1.7 });
    const metadata = facts(bom.metadata);
    const explicit = metadata.find((candidate) => candidate.version === "4.5.6");
    assert.ok(explicit);
    assert.equal(explicit.name, "EXAMPLE_CORE");
    assert.equal(explicit.ownerSourceDir, "explicit");
    assert.equal(explicit.source, `${join(directory, "explicit/VERSION")}:2`);
    assert.equal(explicit.default, true);
    const unbound = metadata.find((candidate) => candidate.version === "8.0.0");
    assert.ok(unbound);
    assert.equal(unbound.ownerSourceDir, "unbound");
    assert.equal(unbound.name, undefined);
    assert.ok(!(bom.components || []).some((component) => component.name === "EXAMPLE_CORE" || component.version === "8.0.0"));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

await test("root Meson source owners receive their own static fact without changing identity", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cdxgen-owned-metadata-"));
  try {
  put(directory, "meson.build", "project('owned', 'c', version : '1.0.0')\n");
  put(directory, "VERSION", "2.1.0\n");
  const { bomJson: bom } = await createCppBom(directory, { multiProject: true, createMultiXBom: true, installDeps: false, deep: false, specVersion: 1.7 });
  assert.equal(bom.metadata.component.version, "1.0.0");
  const own = facts(bom.metadata.component).find((candidate) => candidate.version === "2.1.0");
  assert.ok(own);
  assert.equal(own.name, "owned");
  assert.equal(own.ownerSourceDir, ".");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

await test("aggregate retains version-fact-only owners and their unbound source facts", async () => {
  for (const manifest of ["CMakeLists.txt", "meson.build"]) {
    const directory = mkdtempSync(join(tmpdir(), "cdxgen-owned-parent-only-"));
    try {
      put(directory, manifest, manifest === "meson.build" ? "project('owned', 'c', version: '1.0.0')\n" : "project(owned)\n");
      put(directory, "VERSION", "2.1.0\n");
      put(directory, "unbound/VERSION", "8.0.0\n");
      const { bomJson: bom } = await createMultiXBom([directory], { projectType: ["c", "js"], multiProject: true, installDeps: false, deep: false, specVersion: 1.7 });
      const owners = [];
      const visit = (component) => {
        if (!component) return;
        if (component.name === "owned") owners.push(component);
        for (const child of component.components || []) visit(child);
      };
      visit(bom.metadata.component);
      for (const component of bom.components || []) visit(component);
      assert.equal(owners.length, 1);
      const candidates = facts(owners[0]);
      assert.ok(candidates.some((candidate) => candidate.version === "2.1.0" && candidate.name === "owned" && candidate.ownerSourceDir === "."));
      assert.ok(candidates.some((candidate) => candidate.version === "8.0.0" && candidate.name === undefined && candidate.ownerSourceDir === "unbound"));
      assert.equal(owners[0].version, manifest === "CMakeLists.txt" ? "2.1.0" : "1.0.0");
      assert.ok(!(bom.components || []).some((component) => component.version === "8.0.0"));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});

test("own literal VERSION is emitted as a fact without changing source or consumer identities", () => withSource((directory) => {
  const file = put(directory, "CMakeLists.txt", "project(owned)\nfind_package(owned 9.0 REQUIRED)\n");
  put(directory, "VERSION", "# Release source fact; configured overrides are not resolved\n1.5.0\n");
  const parsed = parseCmakeLikeFile(file, "generic");
  const candidate = facts(parsed.parentComponent).find((candidate) => candidate.version === "1.5.0");
  assert.ok(candidate);
  assert.equal(candidate.name, "owned");
  assert.equal(candidate.kind, "owned-version-file");
  assert.equal(candidate.source, `${join(directory, "VERSION")}:2`);
  assert.deepEqual(candidate.conditions, []);
  assert.ok(!parsed.parentComponent.version);
  assert.ok(!parsed.pkgList.find((component) => component.name === "owned").version);
}));

test("explicit VERSION fields supply actual releases and preserve each source-copy boundary", () => withSource((directory) => {
  put(directory, "one/VERSION", "#OWN_VERSION_MAJOR\n7\n#OWN_VERSION_MINOR\n18\n#OWN_VERSION_PATCH\n0\n");
  put(directory, "two/VERSION", "VERSION_MAJOR=2\nVERSION_MINOR=0\nVERSION_PATCH=0\n");
  put(directory, "umbrella/VERSION", "99.0.0\n");
  put(directory, "umbrella/child/CMakeLists.txt", "project(child)\n");
  const projects = [source("owned", "one"), source("owned", "two"), source("child", "umbrella/child")];
  const consumer = { name: "owned", "bom-ref": "consumer", purl: "pkg:generic/owned" };
  const result = reconcileCmakeSourceProjects([consumer], projects, [{ ref: "root", dependsOn: ["consumer"] }], directory);
  assert.ok(facts(projects[0]).some((candidate) => candidate.version === "7.18.0" && candidate.source.endsWith("one/VERSION:2")));
  assert.ok(facts(projects[1]).some((candidate) => candidate.version === "2.0.0" && candidate.source.endsWith("two/VERSION:1")));
  assert.ok(!facts(projects[2]).some((candidate) => candidate.version === "99.0.0"));
  assert.deepEqual(projects.slice(0, 2).map((project) => project.version), ["7.18.0", "2.0.0"]);
  assert.ok(projects[0].purl.endsWith("#one"));
  assert.ok(projects[1].purl.endsWith("#two"));
  assert.ok(projects[0].properties.some((entry) => entry.name === "cdx:version:sourceRevision" && entry.value === "1111111111111111111111111111111111111111"));
  assert.deepEqual(result.pkgList, [consumer]);
  assert.deepEqual(result.dependencies, [{ ref: "root", dependsOn: ["consumer"] }]);
  assert.ok(!consumer.version);
}));

test("literal Autoconf AC_INIT at the exact source root or src supplies owned facts only", () => withSource((directory) => {
  put(directory, "one/src/configure.in", "# Local release declaration\nAC_PREREQ(2.59)\nAC_INIT(PAPI, 7.3.0.0, bugs@example.invalid)\n");
  put(directory, "two/configure.ac", "dnl Local release declaration\nAC_INIT([other], [1.2.3], [bugs@example.invalid])\n");
  const projects = [source("papi", "one"), source("other", "two")];
  reconcileCmakeSourceProjects([], projects, [], directory);
  const first = facts(projects[0]).find((candidate) => candidate.version === "7.3.0.0");
  assert.ok(first);
  assert.equal(first.name, "PAPI");
  assert.equal(first.kind, "owned-autoconf-init");
  assert.equal(first.source, `${join(directory, "one/src/configure.in")}:3`);
  assert.ok(facts(projects[1]).some((candidate) => candidate.version === "1.2.3"));
}));

test("invoked data-only header helpers supply actual project versions without executing source commands", () => withSource((directory) => {
  const file = put(directory, "CMakeLists.txt", `function(header_version)
file(READ "\${CMAKE_CURRENT_SOURCE_DIR}/include/api.h" header)
if(header MATCHES "#define[ ]+OWN_COMPLETE[ ]+MAKE_OWN_VERSION\\\\([ ]*[0-9]+,[ ]*([0-9]+),[ ]*([0-9]+),[ ]*OWN_REV[ ]*\\\\)")
set(MAJOR "\${CMAKE_MATCH_1}")
set(MINOR "\${CMAKE_MATCH_2}")
endif()
if(header MATCHES "#define[ ]+OWN_REV[ ]+([0-9]+)")
set(PATCH "\${CMAKE_MATCH_1}")
endif()
set(OWN_RELEASE "\${MAJOR}.\${MINOR}.\${PATCH}" PARENT_SCOPE)
endfunction()
header_version()
project(owned VERSION \${OWN_RELEASE})
`);
  const header = "#define OWN_REV 9\n#define OWN_COMPLETE MAKE_OWN_VERSION(0, 2, 4, OWN_REV)\n";
  put(directory, "include/api.h", `//${"x".repeat(300 * 1024)}\n${header}`);
  const parsed = parseCmakeLikeFile(file, "generic");
  const candidate = facts(parsed.parentComponent).find((candidate) => candidate.version === "2.4.9");
  assert.ok(candidate);
  assert.equal(candidate.kind, "helper-output");
  assert.ok(parsed.projectSource.versionFiles.includes(join(directory, "include/api.h")));
  assert.equal(parsed.parentComponent.version, "2.4.9");
  put(directory, "include/api.h", "#define OWN_REV 9\n#define OWN_COMPLETE MAKE_OWN_VERSION(unknown(), 2, 4, OWN_REV)\n");
  const unsupported = parseCmakeLikeFile(file, "generic");
  assert.ok(!facts(unsupported.parentComponent).some((candidate) => candidate.version === "2.4.9"));
  assert.ok(!unsupported.parentComponent.version);
  put(directory, "include/api.h", `//${"x".repeat(2 * 1024 * 1024)}\n${header}`);
  assert.ok(!facts(parseCmakeLikeFile(file, "generic").parentComponent).some((candidate) => candidate.version === "2.4.9"));
}));


test("project-owned cached release labels remain packaging defaults", () => withSource((directory) => {
  const file = put(directory, "CMakeLists.txt", 'project(owner)\nset(OWNER_RELEASE_VERSION "0.1a1" CACHE STRING "Packaging default")\nset(OTHER_RELEASE_VERSION "9.9.9" CACHE STRING "Unrelated owner")\n');
  const parsed = parseCmakeLikeFile(file, "generic");
  const candidate = facts(parsed.parentComponent).find((candidate) => candidate.version === "0.1a1");
  assert.ok(candidate);
  assert.equal(candidate.kind, "packaging-default");
  assert.equal(candidate.default, true);
  assert.equal(candidate.variable, "OWNER_RELEASE_VERSION");
  assert.ok(!facts(parsed.parentComponent).some((candidate) => candidate.version === "9.9.9"));
  assert.ok(!parsed.parentComponent.version);
}));

test("unsupported header regexes cannot reuse a previous numeric capture", () => withSource((directory) => {
  const file = put(directory, "CMakeLists.txt", `function(unsupported_version)
file(READ "\${CMAKE_CURRENT_SOURCE_DIR}/api.h" header)
set(CMAKE_MATCH_1 99)
if(header MATCHES "#define[ ]+OWN_REV[ ]+([0-9]+)|arbitrary")
set(OWN_RELEASE "\${CMAKE_MATCH_1}" PARENT_SCOPE)
endif()
endfunction()
unsupported_version()
project(owned VERSION \${OWN_RELEASE})
`);
  put(directory, "api.h", "#define OWN_REV 9\n");
  const parsed = parseCmakeLikeFile(file, "generic");
  assert.ok(!facts(parsed.parentComponent).some((candidate) => candidate.kind === "helper-output"));
  assert.ok(!parsed.parentComponent.version);
}));

test("unresolved conflicting executable and symlinked metadata are not release facts", () => withSource((directory) => {
  const versions = ["${VERSION}\n", "1.2.3\n9.9.9\n", "VERSION_MAJOR=1\nVERSION_MINOR=2\nVERSION_PATCH=$(run)\n", "VERSION_MAJOR=1\nOTHER_VERSION_MINOR=2\nVERSION_PATCH=3\n", "#VERSION_MAJOR=1\n#VERSION_MINOR=2\n#VERSION_PATCH=3\n"];
  const projects = [];
  for (const [index, value] of versions.entries()) { put(directory, `bad${index}/VERSION`, value); projects.push(source("owned", `bad${index}`)); }
  put(directory, "m4/configure.ac", "AC_DEFUN([hidden], [\nAC_INIT([owned], [9.0.0])\n])\n");
  put(directory, "dynamic/configure.in", "AC_INIT([owned], [m4_esyscmd(run)])\n");
  put(directory, "other/VERSION", "8.0.0\n");
  mkdirSync(join(directory, "link")); symlinkSync(join(directory, "other/VERSION"), join(directory, "link/VERSION"));
  projects.push(source("owned", "m4"), source("owned", "dynamic"), source("owned", "link"), source("owned", "../outside"));
  reconcileCmakeSourceProjects([], projects, [], directory);
  assert.ok(projects.every((project) => facts(project).length === 0));
}));

test("exact numeric header captures supply authoritative project fields", () => withSource((directory) => {
  const file = put(directory, "CMakeLists.txt", `file(READ "\${CMAKE_CURRENT_SOURCE_DIR}/api.h" header)
if(header MATCHES "#define[ ]+OWN_REV[ ]+([0-9]+)")
set(OWN_RELEASE "\${CMAKE_MATCH_1}")
endif()
project(owned VERSION \${OWN_RELEASE})
`);
  put(directory, "api.h", "#define OWN_REV 9\n");
  const parsed = parseCmakeLikeFile(file, "generic");
  assert.ok(facts(parsed.parentComponent).some((candidate) => candidate.version === "9"));
  assert.equal(parsed.parentComponent.version, "9");
}));
