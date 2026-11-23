import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert, describe, test } from "poku";
import { create as createTar } from "tar";
import { collectNativeProviders, resolveNativeRequirements } from "./nativeProviderIndex.js";
import { bindNativeObservedProvider, loadNativeExternalMetadata, nativeInstalledLibraryObserver, nativeInstalledToolObserver, nativeProviderReplay } from "./nativeExternalMetadata.js";

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-provider-index-"));
  const put = (file, text) => { mkdirSync(join(root, file, ".."), { recursive: true }); writeFileSync(join(root, file), text); };
  const owner = (directory, name, version, versionKind = "release") => ({ directory: join(root, directory), component: {
    name, version, "bom-ref": `${directory}@${version}`, properties: [{ name: "cdx:version:kind", value: versionKind }],
  } });
  try { run({ root, put, owner }); } finally { rmSync(root, { recursive: true, force: true }); }
}
const request = (name, command = "find_package", extra = {}) => ({ requestedName: name, command, file: "app/CMakeLists.txt", line: 1, role: "software", constraints: "", conditions: [], providerCandidates: [], ...extra });

let providerFixtureId = 0;
function authenticatedComponent(root, put, name, version, exports, interfaceVersionUnknown = false, files) {
  const id = `provider-${providerFixtureId++}`;
  const hash = (text) => createHash("sha256").update(text).digest("hex");
  const original = JSON.stringify({ name, version, exports, files });
  put(`${id}.original`, original);
  const snapshot = JSON.stringify({ schema: 1, name, version, versionKind: "release", exports, files, interfaceVersionUnknown,
    evidence: [{ path: `${id}.original`, sha256: hash(original) }] });
  put(`${id}.json`, snapshot);
  put(`${id}.manifest.json`, JSON.stringify({ schema: 1, providers: [{ metadata: { path: `${id}.json`, format: "provider-snapshot", sha256: hash(snapshot) } }] }));
  const provider = loadNativeExternalMetadata({ nativeProviderMetadata: join(root, `${id}.manifest.json`) })[0];
  return { name, version, "bom-ref": name, properties: [
    { name: "cdx:native:providerIdentity", value: hash(JSON.stringify(provider)) },
    { name: "cdx:native:providerEvidence", value: JSON.stringify(provider) },
    { name: "cdx:native:providerExports", value: JSON.stringify(provider.exports) },
  ] };
}

describe("source-scoped native provider index", () => {
  test("a wrapper-installed executable carries its owner and output name, not its target alias or a library export", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `project(ToolSuite VERSION 4.7)
function(make_tool target)
  add_executable(\${target} main.c)
  set_target_properties(\${target} PROPERTIES OUTPUT_NAME schema-gen)
  install(TARGETS \${target} RUNTIME DESTINATION bin)
endfunction()
make_tool(generator)
add_executable(local-only debug.c)
add_executable(alias ALIAS generator)
add_executable(foreign IMPORTED)
install(TARGETS foreign RUNTIME DESTINATION bin)
`);
    const index = collectNativeProviders([owner("vendor", "ToolSuite", "4.7")], {
      scanRoot: root, nativeSourceManifests: [join(root, "vendor/CMakeLists.txt")],
    });
    const program = (name, extra) => request(name, "find_program", { role: "tool", ...extra });
    const discovered = resolveNativeRequirements([program("schema-gen", { arguments: ["GEN", "schema-gen", "HINTS", "/opt/bin"] })], index);
    assert.equal(discovered.unresolved[0]?.compatibility, "unknown");
    assert.deepEqual(discovered.unresolved[0]?.candidates.map((candidate) => candidate.ref), ["vendor@4.7"]);
    assert.equal(discovered.unresolved[0]?.candidates[0]?.exports[0]?.executableUnknown, true);
    const negatives = ["generator", "alias", "local-only", "foreign"].map((name) => program(name));
    negatives.push(request("schema-gen", "find_library"));
    assert.ok(resolveNativeRequirements(negatives, index).unresolved.every((entry) => !entry.candidates.length));
  }));

  test("installed programs honor configured inputs and rename without claiming another owner's script", () => fixture(({ root, put, owner }) => {
    put("vendor/scripts/prepare.in", "#!/bin/sh\n");
    put("vendor/scripts/support", `#!/bin/sh\n${"# script data\n".repeat(50000)}`);
    put("foreign/shortcut", "#!/bin/sh\n");
    put("vendor/CMakeLists.txt", `project(ToolSuite VERSION 4.7)
configure_file(scripts/prepare.in "\${CMAKE_CURRENT_BINARY_DIR}/prepare")
install(PROGRAMS "\${CMAKE_CURRENT_BINARY_DIR}/prepare" DESTINATION bin RENAME prepare-tool)
install(PROGRAMS scripts/support DESTINATION libexec)
install(PROGRAMS ../foreign/shortcut DESTINATION bin)
install(PROGRAMS scripts/missing DESTINATION bin)
`);
    const index = collectNativeProviders([owner("vendor", "ToolSuite", "4.7")], { scanRoot: root });
    const result = resolveNativeRequirements(["prepare-tool", "support", "prepare", "shortcut", "missing"].map((name) =>
      request(name, "find_program", { role: "tool" })), index);
    assert.deepEqual(result.unresolved.map((row) => [row.requirement.requestedName, row.candidates.map((candidate) => candidate.ref)]), [
      ["prepare-tool", ["vendor@4.7"]], ["support", ["vendor@4.7"]], ["prepare", []], ["shortcut", []], ["missing", []],
    ]);
  }));

  test("declared executable copies carry the source target, not an arbitrary custom target name", () => fixture(({ root, put, owner }) => {
    put("vendor/source-tool.sh", "#!/bin/sh\n");
    put("vendor/CMakeLists.txt", `project(Suite VERSION 4.7)
function(make_alias alias target)
  set(out "\${CMAKE_CURRENT_BINARY_DIR}/bin/\${alias}\${CMAKE_EXECUTABLE_SUFFIX}")
  add_custom_command(OUTPUT "\${out}"
    COMMAND "\${CMAKE_COMMAND}" -E create_symlink "$<TARGET_FILE:\${target}>" "\${out}"
    DEPENDS \${target})
endfunction()
add_executable(driver main.cpp)
make_alias(other-driver driver)
add_executable(driver_alias ALIAS driver)
make_alias(copied-alias driver_alias)
add_executable(external IMPORTED)
make_alias(foreign external)
add_executable(source_utility IMPORTED)
set_target_properties(source_utility PROPERTIES IMPORTED_LOCATION "\${CMAKE_CURRENT_SOURCE_DIR}/source-tool.sh")
make_alias(copied-script source_utility)
add_custom_target(fake COMMAND "\${CMAKE_COMMAND}" -E echo other-driver)
`);
    const index = collectNativeProviders([owner("vendor", "Suite", "4.7")], { scanRoot: root });
    const names = ["other-driver", "bin/other-driver", "copied-alias", "copied-script", "driver_alias", "foreign", "fake"];
    const result = resolveNativeRequirements(names.map((name) => request(name, "find_program")), index);
    assert.deepEqual(result.unresolved.map((row) => row.candidates.map((candidate) => candidate.ref)),
      [["vendor@4.7"], ["vendor@4.7"], ["vendor@4.7"], ["vendor@4.7"], [], [], []]);
    assert.equal(result.unresolved[0].candidates[0].exports[0].executableUnknown, true);
    assert.match(result.unresolved[0].candidates[0].exports[0].source, /CMakeLists\.txt:8$/);
  }));

  test("executable FILES installs correlate the generated material with a symbolic install directory", () => fixture(({ root, put, owner }) => {
    put("vendor/script.sh", "#!/bin/sh\n");
    put("vendor/data.txt", "not executable");
    put("vendor/CMakeLists.txt", `project(Suite VERSION 4.7)
configure_file(script.sh "\${PROJECT_BINARY_DIR}/\${CMAKE_INSTALL_LIBEXECDIR}/owned/launch" COPYONLY)
install(FILES "\${PROJECT_BINARY_DIR}/\${CMAKE_INSTALL_LIBEXECDIR}/owned/launch"
  DESTINATION "\${CMAKE_INSTALL_LIBEXECDIR}/owned" PERMISSIONS OWNER_EXECUTE OWNER_READ)
install(FILES data.txt DESTINATION bin)
install(FILES missing DESTINATION bin PERMISSIONS OWNER_EXECUTE)
`);
    const index = collectNativeProviders([owner("vendor", "Suite", "4.7")], { scanRoot: root });
    const result = resolveNativeRequirements(["launch", "data.txt", "missing"].map((name) => request(name, "find_program")), index);
    assert.deepEqual(result.unresolved.map((row) => row.candidates.map((candidate) => candidate.ref)), [["vendor@4.7"], [], []]);
    assert.match(result.unresolved[0].candidates[0].exports[0].installationSource, /CMakeLists\.txt:3$/);
  }));

  test("a copied compiler output is owned by its confined declared source, not a requested filename", () => fixture(({ root, put, owner }) => {
    put("vendor/convert.cpp", "int main() {}");
    put("other/foreign.cpp", "int main() {}");
    put("vendor/CMakeLists.txt", `project(Suite VERSION 4.7)
if(NOT CONVERTER)
  set(CONVERTER "\${PROJECT_SOURCE_DIR}/convert.cpp")
endif()
execute_process(COMMAND \${CMAKE_CXX_COMPILER} \${CONVERTER} -O3 -o "\${PROJECT_BINARY_DIR}/converter.stage" RESULT_VARIABLE STATUS)
execute_process(COMMAND \${CMAKE_CXX_COMPILER} "../other/foreign.cpp" -o "\${PROJECT_BINARY_DIR}/foreign.stage")
add_custom_command(OUTPUT "\${PROJECT_BINARY_DIR}/converter" COMMAND \${CMAKE_COMMAND} -E copy
  "\${PROJECT_BINARY_DIR}/converter.stage" "\${PROJECT_BINARY_DIR}/converter" DEPENDS "\${PROJECT_BINARY_DIR}/converter.stage")
add_custom_command(OUTPUT "\${PROJECT_BINARY_DIR}/foreign" COMMAND \${CMAKE_COMMAND} -E copy
  "\${PROJECT_BINARY_DIR}/foreign.stage" "\${PROJECT_BINARY_DIR}/foreign" DEPENDS "\${PROJECT_BINARY_DIR}/foreign.stage")
`);
    const index = collectNativeProviders([owner("vendor", "Suite", "4.7")], { scanRoot: root });
    const result = resolveNativeRequirements(["converter", "foreign", "converter.stage"].map((name) => request(name, "find_program")), index);
    assert.deepEqual(result.unresolved.map((row) => row.candidates.map((candidate) => candidate.ref)), [["vendor@4.7"], [], []]);
    assert.match(result.unresolved[0].candidates[0].exports[0].source, /convert\.cpp:1$/);
    assert.ok(result.unresolved[0].candidates[0].exports[0].conditions.includes("if(NOT CONVERTER)"));
  }));

  test("a guarded nested project can produce a copied parent-source executable without lending its libraries", () => fixture(({ root, put, owner }) => {
    put("vendor/deps/converter.cpp", "int main() {}");
    put("vendor/CMakeLists.txt", `project(Suite)
if(BUILD_CLIENTS)
  add_subdirectory(clients)
endif()`);
    put("vendor/clients/CMakeLists.txt", `project(Client)
if(BUILD_TESTS)
  set(CONVERTER "\${CMAKE_SOURCE_DIR}/deps/converter.cpp")
  execute_process(COMMAND \${CMAKE_CXX_COMPILER} \${CONVERTER} -O3 -o "\${PROJECT_BINARY_DIR}/converter.stage")
  add_custom_command(OUTPUT "\${PROJECT_BINARY_DIR}/converter" COMMAND \${CMAKE_COMMAND} -E copy
    "\${PROJECT_BINARY_DIR}/converter.stage" "\${PROJECT_BINARY_DIR}/converter" DEPENDS "\${PROJECT_BINARY_DIR}/converter.stage")
  add_library(client_api SHARED client.c)
  install(TARGETS client_api)
endif()`);
    const manifests = ["vendor/CMakeLists.txt", "vendor/clients/CMakeLists.txt"].map((file) => join(root, file));
    const git = (...args) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "-c", "commit.gpgsign=false", ...args], { cwd: join(root, "vendor"), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init", "-q");
    git("add", "CMakeLists.txt", "clients/CMakeLists.txt", "deps/converter.cpp");
    git("commit", "-qm", "fixture");
    const revision = git("rev-parse", "HEAD");
    const suite = owner("vendor", "Suite", revision, "source-revision");
    const client = { ...owner("vendor/clients", "Client", revision, "source-revision"), scopeDirectory: suite.directory };
    const indexOf = (parent, child) => collectNativeProviders([parent, child], { scanRoot: root, nativeSourceManifests: manifests });
    const program = request("converter", "find_program");
    const result = resolveNativeRequirements([program, request("client_api", "find_library")], indexOf(suite, client));
    assert.deepEqual(result.bindings[0].providerRefs, [`vendor/clients@${revision}`]);
    assert.deepEqual(result.unresolved[0].candidates.map((candidate) => candidate.ref), [`vendor@${revision}`]);
    const [entry] = result.unresolved[0].candidates[0].exports;
    assert.deepEqual(entry.conditions, ["if(BUILD_CLIENTS)", "if(BUILD_TESTS)"]);
    assert.match(entry.subdirectoryReplaySource, /vendor[/\\]CMakeLists\.txt:3$/);
    assert.equal(entry.sourceRevision, revision);
    assert.match(entry.source, /deps[/\\]converter\.cpp:1$/);
    for (const index of [indexOf({ ...suite, variables: [["BUILD_CLIENTS", "OFF"]] }, client),
      indexOf(suite, { ...client, scopeDirectory: client.directory }),
      indexOf(owner("vendor", "Suite", "4.7"), client),
      indexOf(owner("vendor", "Suite", "a".repeat(40), "source-revision"), client)]) {
      assert.deepEqual(resolveNativeRequirements([program], index).unresolved[0].candidates, []);
    }
  }));

  test("preparsed language declarations in a CMake directory keep a separate owner and no selected artifact", () => fixture(({ root, owner, put }) => {
    put("vendor/CMakeLists.txt", "project(Owner VERSION 2.0)\nadd_executable(cmake-tool main.c)\ninstall(TARGETS cmake-tool)");
    const cmake = owner("vendor", "Owner", "2.0");
    const cargo = { ...owner("vendor", "cargo-owner", "8.0"), declaredExports: [
      { kind: "tool", name: "cargo-bin", source: join(root, "vendor/Cargo.toml:7") },
      { kind: "tool", name: "external-bin", source: join(root, "other/Cargo.toml:7") },
    ] };
    const index = collectNativeProviders([cmake, cargo], { scanRoot: root });
    const result = resolveNativeRequirements(["cmake-tool", "cargo-bin", "external-bin"].map((name) => request(name, "find_program")), index);
    assert.deepEqual(result.unresolved.map((row) => row.candidates.map((candidate) => candidate.ref)), [["vendor@2.0"], ["vendor@8.0"], []]);
  }));

  test("an owner-shipped CMake config is a versioned source alternative, not installed material", () => fixture(({ root, owner, put }) => {
    put("vendor/CMakeLists.txt", "project(Widget VERSION 2.0)");
    put("vendor/lib/cmake/Widget/WidgetConfig.cmake", "include(\"${CMAKE_CURRENT_LIST_DIR}/WidgetTargets.cmake\")");
    put("vendor/lib/cmake/foreign/foreign-config.cmake", "include(foreign-targets.cmake)");
    put("vendor/unrelated/WidgetConfig.cmake", "include(unrelated.cmake)");
    const index = collectNativeProviders([owner("vendor", "Widget", "2.0")], { scanRoot: root });
    const result = resolveNativeRequirements(["Widget", "foreign"].map((name) =>
      request(name, "find_package", { arguments: [name, "CONFIG"] })), index);
    const [widget, foreign] = result.unresolved;
    assert.deepEqual(widget.candidates.map(({ ref, compatibility }) => [ref, compatibility]), [["vendor@2.0", "unknown"]]);
    assert.equal(widget.candidates[0].exports.length, 1);
    assert.match(widget.candidates[0].exports[0].source, /lib[/\\]cmake[/\\]Widget[/\\]WidgetConfig\.cmake:1$/);
    assert.deepEqual(foreign.candidates, []);
  }));

  test("explicit package NAMES and interface versions survive unknown selection", () => fixture(({ root, owner, put }) => {
    put("vendor/CMakeLists.txt", `project(Owner VERSION 2.0)
configure_package_config_file(config.in ActualConfig.cmake)
write_basic_package_version_file(ActualConfigVersion.cmake VERSION 2.0 COMPATIBILITY SameMajorVersion)`);
    const index = collectNativeProviders([owner("vendor", "Owner", "2.0")], { scanRoot: root });
    const result = resolveNativeRequirements([request("Alias", "find_package", {
      arguments: ["Alias", "3.0", "CONFIG", "NAMES", "Absent", "Actual", "HINTS", "/missing"], constraints: "3.0",
    })], index);
    assert.deepEqual(result.unresolved[0].candidates.map((candidate) => [candidate.ref, candidate.compatibility]), [["vendor@2.0", "violated"]]);
  }));

  test("Find-module companion artifacts cannot be assembled from unrelated owners", () => fixture(({ root, owner, put }) => {
    put("app/CMakeLists.txt", "project(Consumer VERSION 9.0)");
    put("app/FindSuite.cmake", `find_library(MAIN NAMES suite)
find_library(COMPANION NAMES companion other-companion)
find_path(HEADERS suite.h)
if(MAIN AND COMPANION AND HEADERS)
  set(Suite_FOUND TRUE)
endif()`);
    const a = authenticatedComponent(root, put, "first", "1.0", [
      { kind: "library", name: "suite", source: "inventory" }, { kind: "header-file", name: "suite.h", source: "inventory" },
    ]);
    const b = authenticatedComponent(root, put, "second", "2.0", [{ kind: "library", name: "other-companion", source: "inventory" }]);
    const index = collectNativeProviders([owner("app", "Consumer", "9.0")], { scanRoot: root, availableProviders: [a, b] });
    const result = resolveNativeRequirements([request("Suite"), request("suite", "find_library", { file: "app/FindSuite.cmake" })], index);
    assert.deepEqual(result.unresolved[0].candidates.map((candidate) => [candidate.ref, candidate.compatibility]), [["first", "unknown"], ["second", "unknown"]]);
    assert.deepEqual(result.unresolved[0].candidates[0].exports[0].requiredArtifacts.map((group) => group.destination), ["MAIN", "COMPANION", "HEADERS"]);
    assert.deepEqual(result.unresolved[1].candidates.map((candidate) => [candidate.ref, candidate.compatibility]), [["first", "unknown"]]);
    assert.equal(result.unresolved[1].candidates[0].exports[0].requiredArtifacts[1].destination, "COMPANION");
  }));

  test("guarded shared and static exports retain separate artifact names and linkage", () => fixture(({ root, owner, put }) => {
    put("vendor/CMakeLists.txt", `project(Owner VERSION 2.0)
if(BUILD_SHARED_LIBS)
  add_library(actual SHARED x.c)
  set_target_properties(actual PROPERTIES LIBRARY_OUTPUT_NAME dynamic)
  install(TARGETS actual LIBRARY DESTINATION lib)
else()
  add_library(actual STATIC x.c)
  set_target_properties(actual PROPERTIES ARCHIVE_OUTPUT_NAME packed)
  install(TARGETS actual ARCHIVE DESTINATION lib)
endif()`);
    const index = collectNativeProviders([owner("vendor", "Owner", "2.0")], { scanRoot: root });
    const result = resolveNativeRequirements([
      request("libpacked.a", "find_static_library"),
      request("libdynamic.so", "find_shared_library"),
      request("libpacked.a", "find_shared_library"),
      request("libdynamic.so", "find_static_library"),
      request("libdynamic.so", "find_library", { conditions: ["if(WIN32)"] }),
    ], index);
    assert.deepEqual(result.unresolved.map((row) => row.candidates.map((candidate) => [candidate.ref, candidate.compatibility])),
      [[["vendor@2.0", "unknown"]], [["vendor@2.0", "unknown"]], [["vendor@2.0", "violated"]], [["vendor@2.0", "violated"]], []]);
    assert.deepEqual(result.unresolved.slice(0, 2).map((row) => row.candidates[0].exports[0].conditions[0]),
      ["if(BUILD_SHARED_LIBS)/else()", "if(BUILD_SHARED_LIBS)"]);
  }));

  test("conditional Meson methods retain both real interfaces without joining independent version alternatives", () => fixture(({ root, owner, put }) => {
    put("vendor/CMakeLists.txt", "project(Source VERSION 2.0)\nconfigure_package_config_file(config.in PublicConfig.cmake)");
    put("vendor/Public.pc", "Name: Public\nVersion: 2.0\n");
    const index = collectNativeProviders([owner("vendor", "Source", "2.0")], { scanRoot: root });
    const result = resolveNativeRequirements([request("Public", "dependency", {
      arguments: ["'Public'", "method : backend", "version : wanted"], constraints: "[\">= 5.0\",\"< 3.0\"]",
      mesonOptions: {
        method: { expression: "backend", alternatives: [{ value: "pkg-config", conditions: ["pkg"] }, { value: "cmake", conditions: ["config"] }] },
        version: { expression: "wanted", alternatives: [{ value: ">= 5.0", conditions: ["modern"] }, { value: "< 3.0", conditions: ["legacy"] }] },
      },
    })], index);
    assert.deepEqual(result.unresolved[0].candidates.map((candidate) => [candidate.ref, candidate.compatibility]), [["vendor@2.0", "unknown"]]);
    assert.deepEqual(result.unresolved[0].candidates[0].exports.filter((entry) => entry.global).map((entry) =>
      [entry.kind, entry.requirementConditions]), [["pkg-config", ["pkg"]], ["cmake-package", ["config"]]]);
  }));

  test("package inventories expose both the literal Windows filename and its command alias", () => fixture(({ root, put }) => {
    const component = authenticatedComponent(root, put, "sdk-owner", "9.1", [], true, ["sdk\\bin\\msvc-lib.exe", "/usr/libexec/sdk-helper"]);
    const index = collectNativeProviders([], { scanRoot: root, availableProviders: [component] });
    const result = resolveNativeRequirements(["msvc-lib.exe", "msvc-lib", "sdk-helper"].map((name) =>
      request(name, "find_program", { role: "tool" })), index);
    assert.deepEqual(result.unresolved.map((row) => [row.requirement.requestedName, row.candidates.map((candidate) => candidate.ref)]), [
      ["msvc-lib.exe", ["sdk-owner"]], ["msvc-lib", ["sdk-owner"]], ["sdk-helper", ["sdk-owner"]],
    ]);
  }));

  test("an executable branch preserves the library alternative and only emits its guarded runtime name", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `project(Owner VERSION 1.0)
if(BUILD_TOOL)
  add_executable(artifact main.c)
  set_target_properties(artifact PROPERTIES RUNTIME_OUTPUT_NAME actual-tool)
  install(TARGETS artifact RUNTIME DESTINATION bin)
else()
  add_library(artifact STATIC api.c)
  install(TARGETS artifact ARCHIVE DESTINATION lib)
endif()
`);
    const index = collectNativeProviders([owner("vendor", "Owner", "1.0")], { scanRoot: root });
    const result = resolveNativeRequirements([
      request("artifact", "find_library"), request("artifact", "find_program"), request("actual-tool", "find_program"),
    ], index);
    assert.deepEqual(result.bindings.map((row) => row.requirement.command), ["find_library"]);
    assert.deepEqual(result.unresolved.map((row) => row.candidates.map((candidate) => candidate.ref)), [[], ["vendor@1.0"]]);
  }));

  test("repeated conditions do not create impossible executable output names", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `project(Owner VERSION 1.0)
add_executable(generator main.c)
if(USE_ALT)
  set_target_properties(generator PROPERTIES OUTPUT_NAME alt)
endif()
if(USE_ALT)
  set_target_properties(generator PROPERTIES SUFFIX .tool)
endif()
install(TARGETS generator RUNTIME DESTINATION bin)
`);
    const index = collectNativeProviders([owner("vendor", "Owner", "1.0")], { scanRoot: root });
    const result = resolveNativeRequirements(["generator", "alt.tool", "alt", "generator.tool"].map((name) =>
      request(name, "find_program", { role: "tool" })), index);
    assert.deepEqual(result.unresolved.map((row) => row.candidates.map((candidate) => candidate.ref)), [
      ["vendor@1.0"], ["vendor@1.0"], [], [],
    ]);
  }));

  test("a default runtime name is only exported on the branch without a name override", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `project(Owner VERSION 1.0)
add_executable(generator main.c)
if(CUSTOM)
  set_property(TARGET generator PROPERTY PREFIX custom-)
  install(TARGETS generator RUNTIME DESTINATION custom-bin)
else()
  install(TARGETS generator RUNTIME DESTINATION default-bin)
endif()
`);
    const index = collectNativeProviders([owner("vendor", "Owner", "1.0")], { scanRoot: root });
    const result = resolveNativeRequirements([request("generator", "find_program"), request("custom-generator", "find_program")], index);
    assert.deepEqual(result.unresolved.map((row) => row.candidates[0]?.exports.map((entry) => entry.installationSource?.split(":").at(-1))), [["7"], ["5"]]);
  }));

  test("source-declared executables cannot satisfy a Find-module runtime contract before installation", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `project(Owner VERSION 1.0)
add_library(actual STATIC api.c)
add_executable(compiler-tool main.c)
install(TARGETS actual compiler-tool)
`);
    put("app/CMakeLists.txt", "project(Consumer VERSION 1.0)");
    put("app/cmake/FindSuite.cmake", `find_library(SUITE_LIB NAMES actual)
find_program(SUITE_TOOL NAMES compiler-tool)
find_package_handle_standard_args(Suite REQUIRED_VARS SUITE_LIB SUITE_TOOL)
`);
    const index = collectNativeProviders([owner("vendor", "Owner", "1.0"), owner("app", "Consumer", "1.0")], { scanRoot: root });
    const result = resolveNativeRequirements([request("Suite")], index);
    assert.equal(result.unresolved[0]?.candidates.find((candidate) => candidate.ref === "vendor@1.0")?.compatibility, "unknown");
  }));

  test("an install through a symlink into an independent project is not a source export", () => {
    if (process.platform === "win32") return;
    fixture(({ root, put, owner }) => {
      put("vendor/CMakeLists.txt", "project(Owner VERSION 1.0)\ninstall(PROGRAMS scripts/not-owned DESTINATION bin)");
      put("sibling/CMakeLists.txt", "project(Sibling VERSION 2.0)");
      put("sibling/not-owned", "#!/bin/sh\n");
      symlinkSync(join(root, "sibling"), join(root, "vendor/scripts"));
      const index = collectNativeProviders([owner("vendor", "Owner", "1.0"), owner("sibling", "Sibling", "2.0")], { scanRoot: root });
      const result = resolveNativeRequirements([request("not-owned", "find_program")], index);
      assert.deepEqual(result.unresolved[0]?.candidates, []);
    });
  });

  test("unverified program files and unexecuted validators cannot satisfy a program lookup", () => fixture(({ root, put }) => {
    const component = authenticatedComponent(root, put, "tools", "3.0", [
      { kind: "tool", name: "host-tool", interfaceVersion: "3.0" },
    ], false, ["/usr/libexec/helpers"]);
    const index = collectNativeProviders([], { scanRoot: root, availableProviders: [component] });
    const result = resolveNativeRequirements([
      request("helpers", "find_program"),
      request("host-tool", "find_program", { arguments: ["TOOL", "host-tool", "NO_SYSTEM_ENVIRONMENT_PATH"] }),
      request("host-tool", "find_program", { arguments: ["TOOL", "host-tool", "VALIDATOR", "reject_all"] }),
    ], index);
    assert.deepEqual(result.unresolved.map((row) => row.candidates.map((candidate) => [candidate.ref, candidate.compatibility])),
      [[["tools", "unknown"]], [["tools", "unknown"]], [["tools", "unknown"]]]);
  }));

  test("a diagnostic program probe only retains an actually observed executable owner, without choosing it", () => fixture(({ root, put, owner }) => {
    put("scan/vendor/CMakeLists.txt", "project(Source VERSION 9.0)\nadd_executable(ver main.c)\ninstall(TARGETS ver)");
    put("bin/ver", "#!/bin/sh\n");
    const scanRoot = join(root, "scan");
    const file = join(root, "bin/ver");
    chmodSync(file, 0o755);
    const lookup = nativeInstalledLibraryObserver(scanRoot, (name) => name === "ver" ? file : name === "rpm" ? "/usr/bin/rpm" : undefined,
      (_program, args) => args[0] === "-qf" && args[1] === file ? "version-tool\t0\t2.1\t3\tx86_64\n" : undefined);
    const [evidence] = lookup(["ver"], "tool");
    const component = { name: evidence.name, version: evidence.version, "bom-ref": "observed-ver", properties: [
      { name: "cdx:native:providerIdentity", value: "observed" },
      { name: "cdx:native:providerEvidence", value: JSON.stringify(evidence) },
      { name: "cdx:native:providerExports", value: JSON.stringify(evidence.exports) },
    ] };
    bindNativeObservedProvider(component, evidence);
    const inventory = authenticatedComponent(root, put, "file-list-only", "3.0", [], true, ["/usr/bin/ver"]);
    const fact = owner("scan/vendor", "Source", "9.0");
    const probe = request("ver", "find_program", { role: "diagnostic-probe" });
    const result = resolveNativeRequirements([probe, request("ver", "find_package", { role: "diagnostic-probe" })],
      collectNativeProviders([fact], { scanRoot, availableProviders: [component, inventory] }));
    assert.deepEqual(result.bindings, []);
    assert.equal(result.unresolved.length, 1);
    assert.equal(result.unresolved[0].requirement, probe);
    assert.deepEqual(result.unresolved[0].candidates.map((candidate) => [candidate.ref, candidate.compatibility]), [["observed-ver", "unknown"]]);
    assert.deepEqual(result.unresolved[0].candidates[0].exports.map((entry) => entry.file), [file]);

    const replay = JSON.parse(JSON.stringify(component));
    const unavailable = collectNativeProviders([fact], { scanRoot, availableProviders: [replay, inventory] });
    assert.deepEqual(resolveNativeRequirements([probe], unavailable), { bindings: [], unresolved: [] });
  }));

  test("observed installed CMake modules provide contracts, never dependency owner versions", () => fixture(({ root, put }) => {
    const installation = mkdtempSync(join(tmpdir(), "cdxgen-cmake-contract-"));
    try {
      mkdirSync(join(installation, "Modules"));
      const moduleFile = join(installation, "Modules", "FindIconv.cmake");
      const contract = "find_path(Iconv_INCLUDE_DIR NAMES iconv.h)\nfind_library(Iconv_LIBRARY NAMES iconv)\nfind_package_handle_standard_args(Iconv REQUIRED_VARS Iconv_INCLUDE_DIR Iconv_LIBRARY)";
      writeFileSync(moduleFile, contract);
      const toolFile = join(installation, "cmake");
      writeFileSync(toolFile, "fixture tool");
      const observe = nativeInstalledToolObserver(root, () => toolFile, (_file, args) => args[0] === "--version" ?
        "cmake version 4.4.5" : `-- CMAKE_ROOT "${installation}"\n-- CMAKE_VERSION "4.4.5"`);
      const evidence = observe({ kind: "cmake-modules", moduleNames: ["Iconv"] })[0];
      assert.ok(evidence);
      const tool = { name: "CMake", version: "4.4.5", "bom-ref": "cmake", properties: [
        { name: "cdx:native:providerIdentity", value: "observed" },
        { name: "cdx:native:providerEvidence", value: JSON.stringify(evidence) },
        { name: "cdx:native:providerExports", value: JSON.stringify(evidence.exports) },
      ] };
      bindNativeObservedProvider(tool, evidence);
      const library = authenticatedComponent(root, put, "libiconv-owner", "1.18", [{ kind: "library", name: "iconv", source: "/observed/libiconv.so" },
        { kind: "header-file", name: "iconv.h", source: "/observed/iconv.h" }]);
      const resolve = (component = { ...tool }) => resolveNativeRequirements([request("Iconv")],
        collectNativeProviders([], { scanRoot: root, availableProviders: [component, library] }));
      assert.deepEqual(resolve().bindings[0]?.providerRefs, ["libiconv-owner"]);
      assert.ok(resolve().bindings.every((binding) => !binding.providerRefs.includes("cmake")));
      assert.equal(resolve(JSON.parse(JSON.stringify(tool))).bindings.length, 0, "JSON replay cannot authenticate a tool contract");
      const forged = { ...tool, version: "99.0" };
      assert.equal(resolve(forged).bindings.length, 0);
      writeFileSync(moduleFile, contract.replace("iconv.h", "unrelated.h"));
      assert.equal(resolve().bindings.length, 0, "module bytes are revalidated on each collection");
      writeFileSync(moduleFile, contract);
      put("app/CMakeLists.txt", "project(App)");
      put("app/cmake/FindIconv.cmake", "find_library(LOCAL_ICONV NAMES unrelated)\nfind_package_handle_standard_args(Iconv REQUIRED_VARS LOCAL_ICONV)");
      const local = collectNativeProviders([], { scanRoot: root, nativeSourceManifests: [join(root, "app/CMakeLists.txt"), join(root, "app/cmake/FindIconv.cmake")], availableProviders: [{ ...tool }, library] });
      assert.equal(resolveNativeRequirements([request("Iconv")], local).bindings.length, 0, "source-local contract takes precedence even without an owner");
    } finally { rmSync(installation, { recursive: true, force: true }); }
  }));

  test("signed package export rechecks retain the acquisition trust context", () => fixture(({ root, put }) => {
    const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
    const metadata = "Package: devscripts\nVersion: 2.23.4+deb12u2\nArchitecture: all\n";
    const listing = "/usr/bin/debuild\n/usr/sbin/debuild\n/bin/debuild\n/sbin/debuild\n/opt/cross/usr/bin/debuild\n/usr/lib/llvm-19/bin/debuild\n/usr/libexec/debuild\n/usr/libexec/helpers/real.cmd\n";
    const receipt = JSON.stringify({ releaseSha256: "1".repeat(64) });
    const manifest = JSON.stringify({ schema: 1, providers: [{
      metadata: { path: "pkg.control", format: "dpkg-status", sha256: hash(metadata) },
      files: [{ path: "pkg.list", sha256: hash(listing) }],
      repositoryEvidence: { path: "repository.json", sha256: hash(receipt) }, platform: "linux", targetArch: "x64",
    }] });
    put("pkg.control", metadata);
    put("pkg.list", listing);
    put("repository.json", receipt);
    put("manifest.json", manifest);
    const manifestPath = join(root, "manifest.json");
    // The acquisition verifier provides this per-run authorization; this test
    // exercises its downstream handoff, not Debian signature verification.
    const replay = { debian: new Map([[manifestPath, hash(manifest)]]), prepared: new Map(), status: new Map(), verifying: new Set() };
    const [record] = loadNativeExternalMetadata({ nativeProviderMetadata: [manifestPath], [nativeProviderReplay]: replay });
    const owner = { name: record.name, version: record.version, "bom-ref": "devscripts", properties: [
      { name: "cdx:native:providerIdentity", value: "fixture" },
      { name: "cdx:native:providerEvidence", value: JSON.stringify(record) },
      { name: "cdx:native:providerExports", value: JSON.stringify(record.exports) },
    ] };
    const index = (token, component = owner) => collectNativeProviders([], {
      scanRoot: root, availableProviders: [component], [nativeProviderReplay]: token,
    });
    const resolve = (token, component = owner) => resolveNativeRequirements([request("debuild", "find_program")], index(token, component));
    const search = (args, name = "debuild") => {
      const guarded = request(name, "find_program", { arguments: args, conditions: ["if(TOOLS)"] });
      const result = resolveNativeRequirements([guarded], index(replay)).unresolved[0];
      assert.deepEqual(result.requirement, guarded);
      for (const candidate of result.candidates) assert.equal(candidate.compatibility, "unknown");
      return result;
    };
    const files = (result) => result.candidates.flatMap((candidate) => candidate.exports.map((entry) => entry.file)).sort();
    const defaults = ["/bin/debuild", "/sbin/debuild", "/usr/bin/debuild", "/usr/sbin/debuild"];
    const lookup = (...args) => search(["DEBUILD", "NAMES", "debuild", ...args]);
    assert.deepEqual(files(resolve(replay).unresolved[0]), defaults, "default lookup cannot use private bin or libexec exports");
    assert.deepEqual(files(lookup("HINTS", "/usr/lib/llvm-19/bin")), [...defaults, "/usr/lib/llvm-19/bin/debuild"].sort());
    assert.deepEqual(files(lookup("PATHS", "/usr/lib/llvm-19", "PATH_SUFFIXES", "bin", "NO_DEFAULT_PATH")), ["/usr/lib/llvm-19/bin/debuild"]);
    assert.deepEqual(files(search(["DEBUILD", "debuild", "HINTS", "/usr/libexec", "NO_DEFAULT_PATH"])), ["/usr/libexec/debuild"]);
    assert.deepEqual(files(search(["DEBUILD", "debuild", "/usr/libexec"])), [...defaults, "/usr/libexec/debuild"].sort());
    assert.deepEqual(files(search(["CMD", "NAMES", "helpers/real.cmd", "PATHS", "/usr/libexec", "NO_DEFAULT_PATH"], "helpers/real.cmd")), ["/usr/libexec/helpers/real.cmd"]);
    assert.deepEqual(files(search(["CMD", "NAMES", "helpers/real.cmd"], "helpers/real.cmd")), []);
    assert.deepEqual(files(lookup("DOC", "NO_DEFAULT_PATH")), defaults);
    assert.deepEqual(lookup("PATHS", "/opt/vendor", "PATH_SUFFIXES", "bin", "NO_DEFAULT_PATH").candidates, []);
    assert.deepEqual(files(lookup("PATHS", "/usr", "PATH_SUFFIXES", "bin", "NO_DEFAULT_PATH")), ["/usr/bin/debuild"]);
    assert.deepEqual(files(lookup("PATHS", "/usr/bin", "NO_DEFAULT_PATH")), ["/usr/bin/debuild"]);
    assert.deepEqual(lookup("PATHS", "${UNEXPANDED}", "NO_DEFAULT_PATH").candidates.map((candidate) => candidate.ref), ["devscripts"]);
    assert.deepEqual(files(lookup("PATHS", "/opt/vendor")), defaults);
    const disableDefaults = ["NO_PACKAGE_ROOT_PATH", "NO_CMAKE_PATH", "NO_CMAKE_ENVIRONMENT_PATH",
      "NO_SYSTEM_ENVIRONMENT_PATH", "NO_CMAKE_SYSTEM_PATH"];
    const rooted = "/opt/cross/usr/bin/debuild";
    const rerooted = [...defaults, rooted, "/usr/lib/llvm-19/bin/debuild"].sort();
    const extraRoots = Array.from({ length: 256 }, (_, at) => `/opt/unused-${at}`);
    const extraSuffixes = Array.from({ length: 256 }, (_, at) => `nested/path-${at}`);
    assert.deepEqual({
      disabled: files(lookup(...disableDefaults)),
      explicitlyAdmitted: files(lookup(...disableDefaults, "HINTS", "/usr/bin")),
      oneRouteEnabled: files(lookup(...disableDefaults.slice(0, -1))),
      rootedOnly: files(lookup("ONLY_CMAKE_FIND_ROOT_PATH")),
      rootedAndUnrooted: files(lookup("CMAKE_FIND_ROOT_PATH_BOTH")),
      rootedAndDynamic: files(lookup("CMAKE_FIND_ROOT_PATH_BOTH", "HINTS", "${TOOL_ROOT}")),
      noPathsToReroot: files(lookup(...disableDefaults, "ONLY_CMAKE_FIND_ROOT_PATH")),
      notRerooted: files(lookup("ONLY_CMAKE_FIND_ROOT_PATH", "NO_CMAKE_FIND_ROOT_PATH")),
      manyMixed: files(lookup(...disableDefaults, "PATHS", ...extraRoots, "/opt/cross", "/usr/lib/llvm-19", "PATH_SUFFIXES",
        ...extraSuffixes, "usr/bin", "bin")),
    }, {
      disabled: [], explicitlyAdmitted: ["/usr/bin/debuild"], oneRouteEnabled: defaults,
      rootedOnly: rerooted, rootedAndUnrooted: rerooted,
      rootedAndDynamic: [...rerooted, "/usr/libexec/debuild"].sort(),
      noPathsToReroot: [], notRerooted: defaults,
      manyMixed: [rooted, "/usr/lib/llvm-19/bin/debuild"],
    });
    assert.deepEqual(index(replay).providers[0].exports, record.exports.map((entry) => ({ ...entry, global: true, ownerRef: "devscripts", conditions: [] })));
    assert.deepEqual(resolve(undefined).unresolved[0].candidates, []);
    const exportProperty = owner.properties.at(-1);
    const forged = { ...owner, properties: [...owner.properties.slice(0, -1), {
      ...exportProperty, value: JSON.stringify(record.exports.map((entry) => ({ ...entry, file: "/unverified/debuild" }))),
    }] };
    assert.deepEqual(resolve(replay, forged).unresolved[0].candidates, []);
  }));
  test("malformed null provider evidence is rejected without dereferencing caller metadata", () => fixture(({ root }) => {
    const component = { name: "forged", version: "1.0", "bom-ref": "forged", properties: [
      { name: "cdx:native:providerIdentity", value: "not-authenticated" },
      { name: "cdx:native:providerEvidence", value: "null" },
      { name: "cdx:native:providerExports", value: "[]" },
    ] };
    assert.doesNotThrow(() => collectNativeProviders([], { scanRoot: root, availableProviders: [component] }));
    assert.equal(collectNativeProviders([], { scanRoot: root, availableProviders: [component] }).providers.length, 0);
  }));
  test("authenticated export variants retain order and reject modified or extended claims", () => fixture(({ root, put }) => {
    const initial = authenticatedComponent(root, put, "owner", "1.2.3", [
      { kind: "cmake-package", name: "First", interfaceVersion: "1.2.3" },
      { kind: "cmake-package", name: "Second", interfaceVersion: "1.2.3" },
    ]);
    const originals = JSON.parse(initial.properties.find((entry) => entry.name === "cdx:native:providerExports").value);
    const component = (ref, exports) => ({ ...initial, "bom-ref": ref, properties: initial.properties.map((entry) =>
      entry.name === "cdx:native:providerExports" ? { ...entry, value: JSON.stringify(exports) } : entry) });
    const unknown = originals.map((entry) => ({ ...entry, interfaceVersionUnknown: true }));
    const index = collectNativeProviders([], { scanRoot: root, availableProviders: [
      component("normal", [originals[1], originals[0], originals[1]]),
      component("unknown", unknown),
      component("mixed", [originals[0], unknown[1]]),
      component("modified", [{ ...originals[0], source: `${originals[0].source}.forged` }]),
      component("extended", [{ ...originals[0], inventedEvidence: true }]),
      component("extended-unknown", [{ ...unknown[0], inventedEvidence: true }]),
      component("reordered", [Object.fromEntries(Object.entries(originals[0]).reverse())]),
    ] });
    assert.deepEqual(index.providers.map((provider) => provider.ref), ["normal", "unknown", "mixed"]);
    assert.deepEqual(index.providers.map((provider) => provider.exports.map((entry) => entry.name)),
      [["Second", "First", "Second"], ["First", "Second"], ["First", "Second"]]);
    assert.ok(index.providers[1].exports.every((entry) => entry.interfaceVersionUnknown === true));
    assert.equal(index.providers[2].exports[1].interfaceVersionUnknown, true);
    const result = resolveNativeRequirements([request("First", "find_package", { constraints: "1.0" })], index);
    assert.deepEqual(result.bindings[0]?.providerRefs, ["normal", "mixed"]);
    assert.ok(result.bindings[0].candidates.some((candidate) => candidate.ref === "unknown" && candidate.compatibility === "unknown"));
  }));

  test("duplicate consumer observations do not multiply identical export evidence", () => fixture(({ root, put }) => {
    const first = authenticatedComponent(root, put, "sdk-owner", "9.1", [
      { kind: "cmake-package", name: "Public" },
    ]);
    const distinct = authenticatedComponent(root, put, "sdk-owner", "9.1", [
      { kind: "cmake-package", name: "Public", interfaceVersion: "9.2" },
    ]);
    const result = resolveNativeRequirements([request("Public")], collectNativeProviders([], {
      scanRoot: root, availableProviders: [first, { ...first }, distinct, { ...first }],
    }));
    assert.deepEqual(result.bindings[0]?.providerRefs, ["sdk-owner"]);
    assert.deepEqual(result.bindings[0]?.providers[0]?.exports.map((entry) => entry.interfaceVersion), [undefined, "9.2"]);
  }));

  test("one authenticated metadata file retains every distinct platform and conditional record", () => fixture(({ root, put }) => {
    const initial = authenticatedComponent(root, put, "owner", "2.0", [{ kind: "cmake-package", name: "Public" }]);
    const evidence = JSON.parse(initial.properties.find((entry) => entry.name === "cdx:native:providerEvidence").value);
    put(evidence.manifestPath.slice(root.length + 1), JSON.stringify({ schema: 1, providers: [
      { metadata: { path: evidence.metadataPath, format: "provider-snapshot", sha256: evidence.metadataSha256 }, platform: "linux", conditions: ["linux-variant"] },
      { metadata: { path: evidence.metadataPath, format: "provider-snapshot", sha256: evidence.metadataSha256 }, platform: "win32", conditions: ["windows-variant"] },
    ] }));
    const components = loadNativeExternalMetadata({ nativeProviderMetadata: evidence.manifestPath }).map((record) => ({ name: record.name, version: record.version, "bom-ref": `owner-${record.platform}`, properties: [
      { name: "cdx:native:providerIdentity", value: record.platform },
      { name: "cdx:native:providerEvidence", value: JSON.stringify(record) },
      { name: "cdx:native:providerExports", value: JSON.stringify(record.exports) },
    ] }));
    const result = resolveNativeRequirements([request("Public", "find_package", { conditions: ["if(LINUX)"] }), request("Public", "find_package", { conditions: ["if(WIN32)"] })], collectNativeProviders([], { scanRoot: root, availableProviders: components }));
    assert.deepEqual(result.bindings.map((entry) => entry.providerRefs), [["owner-linux"], ["owner-win32"]]);
  }));
  test("unknown explicit config interface never borrows the owner's numeric release", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", "project(Owner VERSION 2.1)\nconfigure_package_config_file(input.in PublicConfig.cmake)\nwrite_basic_package_version_file(PublicConfigVersion.cmake VERSION ${UNKNOWN_INTERFACE} COMPATIBILITY AnyNewerVersion)");
    const result = resolveNativeRequirements([request("Public", "find_package", { constraints: "2.0" })], collectNativeProviders([owner("vendor", "Owner", "2.1")], { scanRoot: root }));
    assert.equal(result.bindings.length, 0);
    assert.ok(result.unresolved[0].candidates.some((candidate) => candidate.ref === "vendor@2.1" && candidate.compatibility === "unknown"));
  }));
  test("CONFIG requests exclude bundled Find helpers and explicit target suffixes exclude default artifacts", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", 'project(Owner VERSION 2.0)\nadd_library(physical STATIC p.c)\nset_target_properties(physical PROPERTIES PREFIX "" SUFFIX ".lib")\ninstall(TARGETS physical)');
    put("vendor/cmake/FindCoverage.cmake", "function(coverage)\nendfunction()");
    const result = resolveNativeRequirements([request("Coverage", "find_package", { file: "vendor/tests/CMakeLists.txt", arguments: ["Coverage", "CONFIG"] }), request("physical.lib", "find_library"), request("libphysical.a", "find_library")], collectNativeProviders([owner("vendor", "Owner", "2.0")], { scanRoot: root }));
    assert.deepEqual(result.bindings.map((entry) => entry.requirement.requestedName), ["physical.lib"]);
    assert.ok(result.unresolved.some((entry) => entry.requirement.requestedName === "Coverage" && !entry.candidates.length));
    assert.ok(result.unresolved.some((entry) => entry.requirement.requestedName === "libphysical.a" && !entry.candidates.length));
  }));

  test("a project-scoped source directory identifies actual installed config payload", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `project(ExportOwner VERSION 3.0.2)
function(package_install)
  install(DIRECTORY "\${ExportOwner_SOURCE_DIR}/package/" DESTINATION lib/cmake)
endfunction()
package_install()
`);
    put("vendor/package/PublicConfig.cmake", "set(Public_FOUND TRUE)");
    const index = collectNativeProviders([owner("vendor", "ExportOwner", "3.0.2")], { scanRoot: root });
    const result = resolveNativeRequirements([request("Public", "find_package", { arguments: ["Public", "CONFIG"] })], index);
    assert.deepEqual(result.bindings[0]?.providerRefs, ["vendor@3.0.2"]);
  }));

  test("project binary aliases do not claim identically named source-tree payloads", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `project(ExportOwner VERSION 3.0.2)
install(DIRECTORY "\${ExportOwner_BINARY_DIR}/pkg/" DESTINATION lib)
`);
    put("vendor/pkg/PublicConfig.cmake", "set(Public_FOUND TRUE)");
    const index = collectNativeProviders([owner("vendor", "ExportOwner", "3.0.2")], { scanRoot: root });
    const result = resolveNativeRequirements([request("Public", "find_package", { arguments: ["Public", "CONFIG"] })], index);
    assert.deepEqual(result.bindings, []);
    assert.deepEqual(result.unresolved[0].candidates, []);
  }));

  test("elseif compares entry values and unbound cache modes keep both arms reachable", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `project(ExportOwner VERSION 3.0.2)
set(MODE "A")
set(MODES "A")
if(PREFER_OVERRIDE)
  set(MODE "B")
elseif("\${MODE}" IN_LIST MODES)
  install(FILES EntryConfig.cmake DESTINATION lib)
endif()
if(BUILD_MODE IN_LIST MODES)
  install(FILES CacheMatchConfig.cmake DESTINATION lib)
else()
  install(FILES CacheFallbackConfig.cmake DESTINATION lib)
endif()
`);
    const index = collectNativeProviders([owner("vendor", "ExportOwner", "3.0.2")], { scanRoot: root });
    const result = resolveNativeRequirements(["Entry", "CacheMatch", "CacheFallback"].map((name) =>
      request(name, "find_package", { arguments: [name, "CONFIG"] })), index);
    assert.deepEqual(result.bindings.map((row) => [row.requirement.requestedName, row.providerRefs, row.candidates[0].exports[0].conditions]), [
      ["Entry", ["vendor@3.0.2"], ["if(PREFER_OVERRIDE)/elseif(${MODE} IN_LIST MODES)"]],
      ["CacheMatch", ["vendor@3.0.2"], ["if(BUILD_MODE IN_LIST MODES)"]],
      ["CacheFallback", ["vendor@3.0.2"], ["if(BUILD_MODE IN_LIST MODES)/else()"]],
    ]);
  }));

  test("known CMake list membership preserves the install argument vector", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `project(ExportOwner VERSION 3.0.2)
function(package_install kind path)
  set(RUNTIME_MODES "PROGRAMS")
  set(INSTALL_ARGS "\${kind};" "\${path}")
  if(kind STREQUAL "PROGRAMS")
    return()
  elseif(NOT kind IN_LIST RUNTIME_MODES)
    list(APPEND INSTALL_ARGS DESTINATION lib/cmake)
  endif()
  install(\${INSTALL_ARGS} FILES_MATCHING PATTERN "*.cmake")
endfunction()
package_install(DIRECTORY "\${ExportOwner_SOURCE_DIR}/public/")
`);
    put("vendor/public/PublicConfig.cmake", "set(Public_FOUND TRUE)");
    put("vendor/not-installed/PrivateConfig.cmake", "set(Private_FOUND TRUE)");
    const index = collectNativeProviders([owner("vendor", "ExportOwner", "3.0.2")], { scanRoot: root });
    const result = resolveNativeRequirements(["Public", "Private"].map((name) =>
      request(name, "find_package", { arguments: [name, "CONFIG"] })), index);
    assert.deepEqual(result.bindings.map((row) => row.requirement.requestedName), ["Public"]);
    assert.deepEqual(result.unresolved[0].candidates, []);
  }));

  test("explicit CONFIG mode cannot discover a source-owned Find helper", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", "project(Owner VERSION 2.0)");
    put("vendor/cmake/FindCoverage.cmake", "function(coverage)\nendfunction()");
    const result = resolveNativeRequirements([request("Coverage", "find_package", { file: "vendor/tests/CMakeLists.txt", arguments: ["Coverage", "CONFIG"] })], collectNativeProviders([owner("vendor", "Owner", "2.0")], { scanRoot: root }));
    assert.equal(result.bindings.length, 0);
    assert.equal(result.unresolved[0].candidates.length, 0);
  }));

  test("invoked install forwarding preserves FILES_MATCHING patterns and bounded regex exclusions", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", "project(Owner VERSION 3.0.2)\nfunction(forward_install)\ninstall(${ARGN})\nendfunction()\nforward_install(DIRECTORY ${PROJECT_SOURCE_DIR}/lib DESTINATION lib FILES_MATCHING PATTERN *.cmake REGEX .*HiddenConfig.cmake.* EXCLUDE)");
    put("vendor/lib/cmake/Public/PublicConfig.cmake", "set(Public_FOUND TRUE)");
    put("vendor/lib/cmake/Public/HiddenConfig.cmake", "set(Hidden_FOUND TRUE)");
    put("vendor/unused/UnusedConfig.cmake", "");
    const manifests = ["vendor/CMakeLists.txt", "vendor/lib/cmake/Public/PublicConfig.cmake", "vendor/lib/cmake/Public/HiddenConfig.cmake", "vendor/unused/UnusedConfig.cmake"].map((file) => join(root, file));
    const result = resolveNativeRequirements([request("Public"), request("Hidden"), request("Unused")], collectNativeProviders([owner("vendor", "Owner", "3.0.2")], { scanRoot: root, nativeSourceManifests: manifests }));
    assert.deepEqual(result.bindings.map((binding) => binding.requirement.requestedName), ["Public"]);
    assert.deepEqual(result.unresolved.map((entry) => entry.requirement.requestedName), ["Hidden", "Unused"]);
  }));

  test("typed tool and Python component interfaces preserve available owners without claiming missing development predicates", () => fixture(({ root, put }) => {
    const provider = authenticatedComponent(root, put, "python-runtime", "3.15.2", [
      { kind: "tool", name: "python3", interfaceVersion: "3.15.2" },
      { kind: "capability", name: "python-interpreter", interfaceVersion: "3.15.2" },
    ]);
    const pytest = authenticatedComponent(root, put, "pytest", "8.4.2", [{ kind: "tool", name: "pytest", interfaceVersion: "8.4.2" }]);
    const index = collectNativeProviders([], { scanRoot: root, availableProviders: [provider, pytest] });
    const result = resolveNativeRequirements([
      request("Python3", "find_package", { constraints: "3.9", arguments: ["Python3", "3.9", "COMPONENTS", "Interpreter"] }),
      request("Python3", "find_package", { constraints: "3.9", arguments: ["Python3", "3.9", "COMPONENTS", "Development"] }),
      request("Pytest", "find_package", { arguments: ["Pytest"] }),
      request("pytest", "find_program", { arguments: ["PYTEST_EXECUTABLE", "NAMES", "pytest"] }),
    ], index);
    assert.equal(result.bindings.length, 3);
    assert.equal(result.unresolved.length, 1);
    assert.ok(result.unresolved[0].candidates.some((candidate) => candidate.ref === "python-runtime" && candidate.compatibility === "unknown"));
    assert.ok(result.bindings.find((binding) => binding.requirement.requestedName === "Pytest").providers.every((owner) => owner.component.name === "pytest" && owner.version === "8.4.2"));
  }));

  test("installed literal ConfigVersion data retains interface evidence on its genuine revision owner", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", "project(Owner)\ninstall(FILES cmake/PublicConfig.cmake cmake/PublicConfigVersion.cmake DESTINATION lib/cmake/Public)");
    put("vendor/cmake/PublicConfig.cmake", "set(Public_FOUND TRUE)");
    put("vendor/cmake/PublicConfigVersion.cmake", 'set(API_MAJOR 4)\nset(API_MINOR 50)\nset(API_PATCH 0)\nset(PACKAGE_VERSION "${API_MAJOR}.${API_MINOR}.${API_PATCH}")\nif(PACKAGE_FIND_VERSION VERSION_EQUAL PACKAGE_VERSION)\nset(PACKAGE_VERSION_EXACT TRUE)\nendif()');
    const index = collectNativeProviders([owner("vendor", "Owner", "a".repeat(40), "source-revision")], { scanRoot: root });
    const result = resolveNativeRequirements([request("Public", "find_package", { constraints: "4.50.0 EXACT" })], index);
    assert.ok(result.unresolved[0]?.candidates.some((candidate) => candidate.ref === `vendor@${"a".repeat(40)}` && candidate.exports.some((entry) => entry.interfaceVersion === "4.50.0" && entry.interfaceVersionSource.includes("PublicConfigVersion.cmake"))));
    assert.equal(result.bindings.length, 0, "custom config compatibility is not silently replaced by a generic policy");
  }));

  test("scoped executable Find predicates bind actual tool owners rather than the finder helper owner", () => fixture(({ root, put, owner }) => {
    put("app/CMakeLists.txt", "project(Consumer VERSION 99.0)");
    put("app/cmake/FindTestingHelper.cmake", "find_program(TEST_EXECUTABLE NAMES pytest)\nfind_package_handle_standard_args(TestingHelper REQUIRED_VARS TEST_EXECUTABLE VERSION_VAR TEST_VERSION)");
    const provider = authenticatedComponent(root, put, "pytest", "8.4.2", [{ kind: "tool", name: "pytest", interfaceVersion: "8.4.2" }]);
    const index = collectNativeProviders([owner("app", "Consumer", "99.0")], { scanRoot: root, availableProviders: [provider] });
    const result = resolveNativeRequirements([request("TestingHelper", "find_package", { constraints: "8.0" }), request("TestingHelper", "find_package", { file: "foreign/CMakeLists.txt" })], index);
    assert.deepEqual(result.bindings[0]?.providerRefs, ["pytest"]);
    assert.equal(result.unresolved.length, 1);
    assert.ok(result.bindings[0].providers.every((provider) => provider.component.name !== "Consumer"));
  }));

  test("installed header payload ownership is discovered once despite headers not being CMake manifests", () => fixture(({ root, put, owner }) => {
    put("app/CMakeLists.txt", "project(Consumer VERSION 99.0)");
    put("app/cmake/FindPublic.cmake", "find_path(PUBLIC_INCLUDE_DIR NAMES owned/api.h)\nfind_package_handle_standard_args(Public REQUIRED_VARS PUBLIC_INCLUDE_DIR)");
    put("vendor/CMakeLists.txt", "project(Owner VERSION 2.0)\ninstall(DIRECTORY include/ DESTINATION include FILES_MATCHING PATTERN *.h)");
    put("vendor/include/owned/api.h", "#define OWNED_API_VERSION 2");
    const manifests = ["app/CMakeLists.txt", "app/cmake/FindPublic.cmake", "vendor/CMakeLists.txt"].map((file) => join(root, file));
    const result = resolveNativeRequirements([request("Public")], collectNativeProviders([owner("app", "Consumer", "99.0"), owner("vendor", "Owner", "2.0")], { scanRoot: root, nativeSourceManifests: manifests }));
    assert.ok(result.unresolved[0]?.candidates.some((candidate) => candidate.ref === "vendor@2.0" && candidate.exports.some((entry) => entry.source.includes("api.h"))));
    assert.equal(result.bindings.length, 0, "source ownership alone does not prove selected installed include roots");
  }));

  test("compiler feature Find checks retain actual compiler owners without inventing a feature release", () => fixture(({ root, put, owner }) => {
    put("app/CMakeLists.txt", "project(Consumer VERSION 99.0)");
    put("app/cmake/FindFilesystemFeature.cmake", 'include(CheckCXXSourceCompiles)\ncheck_cxx_source_compiles("#include <filesystem>\\nint main() {}" FEATURE_PRESENT)');
    const compiler = authenticatedComponent(root, put, "gcc-c++", "15.2.1", [{ kind: "capability", name: "cxx-compiler", interfaceVersion: "15.2.1" }]);
    const result = resolveNativeRequirements([request("FilesystemFeature")], collectNativeProviders([owner("app", "Consumer", "99.0")], { scanRoot: root, availableProviders: [compiler] }));
    assert.equal(result.bindings.length, 0);
    assert.ok(result.unresolved[0].candidates.some((candidate) => candidate.ref === "gcc-c++" && candidate.exports.some((entry) => entry.predicateStatus === "unknown")));
    assert.ok(result.unresolved[0].candidates.every((candidate) => candidate.ref !== "app@99.0"));
  }));

  test("authenticated Meson archive members expose only their actual source owner libraries", () => fixture(({ root, put }) => {
    const descriptor = (path, text, format) => {
      put(path, text);
      return { path, sha256: createHash("sha256").update(text).digest("hex"), ...(format ? { format } : {}) };
    };
    const source = "source-metadata/archive/owner";
    const members = ["owner/meson.build", "owner/va/meson.build", "owner/subprojects/embedded/meson.build"];
    const supplemental = [
      descriptor(`${source}/meson.build`, "project('owner', 'c', version : '2.24.1')\nsubdir('va')\n"),
      descriptor(`${source}/va/meson.build`, "va = shared_library('va_win32', 'va.c', install : true)\n"),
      descriptor(`${source}/subprojects/embedded/meson.build`, "project('embedded', 'c', version : '9.0')\nshared_library('unrelated', 'x.c', install : true)\n"),
      descriptor("source-metadata/archive/archive-manifest.json", JSON.stringify({ members })),
    ];
    put(`${source}/va/unlisted/meson.build`, "shared_library('forged', 'x.c', install : true)");
    const metadata = descriptor("owner.json", JSON.stringify({ name: "owner", version: "2.24.1" }), "vcpkg-json");
    const recipe = descriptor("portfile.cmake", `vcpkg_from_github(REPO example/owner REF v2.24.1 SHA512 ${"a".repeat(128)})\nvcpkg_cmake_config_fixup(PACKAGE_NAME Owner)\n`);
    put("providers.json", JSON.stringify({ schema: 1, providers: [{ metadata, recipe, supplemental, registryRevision: "a".repeat(40) }] }));
    const evidence = loadNativeExternalMetadata({ nativeProviderMetadata: join(root, "providers.json") })[0];
    const component = { name: evidence.name, version: evidence.version, "bom-ref": "owner@2.24.1", properties: [
      { name: "cdx:native:providerIdentity", value: "fixture" },
      { name: "cdx:native:providerEvidence", value: JSON.stringify(evidence) },
      { name: "cdx:native:providerExports", value: JSON.stringify(evidence.exports) },
    ] };
    const index = collectNativeProviders([], { scanRoot: root, availableProviders: [component] });
    const result = resolveNativeRequirements([request("va_win32", "find_library"), request("unrelated", "find_library"), request("forged", "find_library")], index);
    assert.equal(result.bindings.length, 0, "source library declarations are not installed material");
    assert.ok(result.unresolved.find((entry) => entry.requirement.requestedName === "va_win32").candidates.some((candidate) => candidate.ref === "owner@2.24.1" && candidate.compatibility === "unknown" && candidate.exports.some((entry) => entry.source.includes("/va/meson.build") && entry.sourceSha256)));
    assert.ok(result.unresolved.filter((entry) => entry.requirement.requestedName !== "va_win32").every((entry) => !entry.candidates.length));
    put(`${source}/va/meson.build`, "shared_library('tampered', 'x.c', install : true)");
    assert.equal(collectNativeProviders([], { scanRoot: root, availableProviders: [component] }).providers.length, 0);
  }));

  test("generated installed data files identify the real owner for a custom version-file finder", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", 'project(Owner VERSION 2.0)\nfunction(split_version INPUT)\nstring(REGEX MATCHALL "[0123456789]+" PARTS ${INPUT})\nlist(LENGTH PARTS COUNT)\nif(${COUNT} GREATER 2)\nlist(GET PARTS 0 MAJOR)\nlist(GET PARTS 1 MINOR)\nlist(GET PARTS 2 PATCH)\nset(VERSION_MAJOR ${MAJOR} PARENT_SCOPE)\nset(VERSION_MINOR ${MINOR} PARENT_SCOPE)\nset(VERSION_PATCH ${PATCH} PARENT_SCOPE)\nendif()\nendfunction()\nsplit_version(9.7.2)\nfile(WRITE ${CMAKE_CURRENT_BINARY_DIR}/version "${VERSION_MAJOR}.${VERSION_MINOR}.${VERSION_PATCH}\\n")\ninstall(FILES ${CMAKE_CURRENT_BINARY_DIR}/version DESTINATION .info)');
    put("app/CMakeLists.txt", "project(Consumer VERSION 99.0)");
    put("app/cmake/FindDistribution.cmake", 'function(read_version FILE)\nfile(READ "${FILE}" TEXT)\nendfunction()\nset(FILES version version-dev)\nforeach(FILE ${FILES})\nset(FULL_PATH ${PREFIX}/.info/${FILE})\nset(Distribution_VERSION_FILE ${FULL_PATH})\nread_version(${FULL_PATH})\nendforeach()\nfind_package_handle_standard_args(Distribution VERSION_VAR Distribution_FULL_VERSION REQUIRED_VARS Distribution_VERSION_FILE Distribution_FULL_VERSION)');
    const result = resolveNativeRequirements([request("Distribution", "find_package", { constraints: "9.0" })], collectNativeProviders([owner("vendor", "Owner", "2.0"), owner("app", "Consumer", "99.0")], { scanRoot: root }));
    assert.equal(result.bindings.length, 0);
    assert.ok(result.unresolved[0].candidates.some((candidate) => candidate.ref === "vendor@2.0" && candidate.exports.some((entry) => entry.name === "Distribution" && entry.generatedVersion === "9.7.2" && entry.interfaceVersion === "9.7.2" && entry.source.includes("vendor/CMakeLists.txt"))));
    assert.ok(result.unresolved[0].candidates.every((candidate) => candidate.ref !== "app@99.0"));
  }));

  const customVersionFinder = 'function(read_version FILE)\nfile(READ "${FILE}" TEXT)\nendfunction()\nset(FILES version)\nforeach(FILE ${FILES})\nset(FULL_PATH ${PREFIX}/.info/${FILE})\nset(Distribution_VERSION_FILE ${FULL_PATH})\nread_version(${FULL_PATH})\nendforeach()\nfind_package_handle_standard_args(Distribution REQUIRED_VARS Distribution_VERSION_FILE)';
  for (const [name, finder] of [
    ["statement order", customVersionFinder.replace("endforeach()", "endforeach()\nset(FILES version-dev)")],
    ["function-local scope", customVersionFinder.replace("set(FILES version)", "set(FILES version)\nfunction(other)\nset(FILES version-dev)\nendfunction()\nother()")],
  ]) test(`custom Find filename bindings: ${name}`, () => fixture(({ root, put, owner }) => {
    put("first/CMakeLists.txt", 'project(First VERSION 1.0)\nfile(WRITE ${CMAKE_CURRENT_BINARY_DIR}/version "1.2.3")\ninstall(FILES ${CMAKE_CURRENT_BINARY_DIR}/version DESTINATION .info)');
    put("second/CMakeLists.txt", 'project(Second VERSION 2.0)\nfile(WRITE ${CMAKE_CURRENT_BINARY_DIR}/version-dev "9.8.7")\ninstall(FILES ${CMAKE_CURRENT_BINARY_DIR}/version-dev DESTINATION .info)');
    put("app/CMakeLists.txt", "project(Consumer VERSION 99.0)");
    put("app/cmake/FindDistribution.cmake", finder);
    const result = resolveNativeRequirements([request("Distribution")], collectNativeProviders([owner("first", "First", "1.0"), owner("second", "Second", "2.0"), owner("app", "Consumer", "99.0")], { scanRoot: root }));
    assert.deepEqual(result.unresolved[0].candidates.map((candidate) => candidate.ref), ["first@1.0"]);
  }));
  test("invoked custom Find helpers inherit caller bindings at invocation without leaking locals", () => fixture(({ root, put, owner }) => {
    put("first/CMakeLists.txt", 'project(First VERSION 1.0)\nfile(WRITE ${CMAKE_CURRENT_BINARY_DIR}/version "1.2.3")\ninstall(FILES ${CMAKE_CURRENT_BINARY_DIR}/version DESTINATION .info)');
    put("second/CMakeLists.txt", 'project(Second VERSION 2.0)\nfile(WRITE ${CMAKE_CURRENT_BINARY_DIR}/version-dev "9.8.7")\ninstall(FILES ${CMAKE_CURRENT_BINARY_DIR}/version-dev DESTINATION .info)');
    put("app/CMakeLists.txt", "project(Consumer VERSION 99.0)");
    put("app/cmake/FindDistribution.cmake", 'function(read_version FILE)\nfile(READ "${FILE}" TEXT)\nendfunction()\nfunction(search)\nforeach(FILE ${FILES})\nset(FULL_PATH ${PREFIX}/.info/${FILE})\nset(Distribution_VERSION_FILE ${FULL_PATH} PARENT_SCOPE)\nread_version(${FULL_PATH})\nendforeach()\nset(FILES version-dev)\nendfunction()\nset(FILES version)\nsearch()\nset(FILES version-dev)\nfind_package_handle_standard_args(Distribution REQUIRED_VARS Distribution_VERSION_FILE)');
    const result = resolveNativeRequirements([request("Distribution")], collectNativeProviders([owner("first", "First", "1.0"), owner("second", "Second", "2.0"), owner("app", "Consumer", "99.0")], { scanRoot: root }));
    assert.deepEqual(result.unresolved[0].candidates.map((candidate) => candidate.ref), ["first@1.0"]);
  }));
  test("conditional generated overwrites preserve both final installed payload alternatives", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", 'project(Owner VERSION 2.0)\nfile(WRITE ${CMAKE_CURRENT_BINARY_DIR}/version "1.2.3")\ninstall(FILES ${CMAKE_CURRENT_BINARY_DIR}/version DESTINATION .info)\nif(ENABLE_DEV)\nfile(WRITE ${CMAKE_CURRENT_BINARY_DIR}/version "9.8.7")\nendif()');
    put("app/CMakeLists.txt", "project(Consumer VERSION 99.0)");
    put("app/cmake/FindDistribution.cmake", customVersionFinder);
    const result = resolveNativeRequirements([request("Distribution")], collectNativeProviders([owner("vendor", "Owner", "2.0"), owner("app", "Consumer", "99.0")], { scanRoot: root }));
    const exports = result.unresolved[0].candidates.find((candidate) => candidate.ref === "vendor@2.0")?.exports || [];
    assert.deepEqual([...new Set(exports.map((entry) => entry.generatedVersion))].sort(), ["1.2.3", "9.8.7"]);
    assert.notDeepEqual(exports.find((entry) => entry.generatedVersion === "1.2.3")?.conditions, exports.find((entry) => entry.generatedVersion === "9.8.7")?.conditions);
  }));
  for (const [name, producer, expected] of [
    ["write after install", 'file(WRITE ${CMAKE_CURRENT_BINARY_DIR}/version "1.2.3")\ninstall(FILES ${CMAKE_CURRENT_BINARY_DIR}/version DESTINATION .info)\nfile(WRITE ${CMAKE_CURRENT_BINARY_DIR}/version "9.8.7")', "9.8.7"],
    ["install before first write", 'install(FILES ${CMAKE_CURRENT_BINARY_DIR}/version DESTINATION .info)\nfile(WRITE ${CMAKE_CURRENT_BINARY_DIR}/version "9.8.7")', "9.8.7"],
    ["unexecuted parent-scope branch", 'set(MAJOR 1)\nfunction(parse INPUT)\nstring(REGEX MATCHALL "[0-9]+" PARTS ${INPUT})\nlist(GET PARTS 0 MAJOR)\nlist(LENGTH PARTS COUNT)\nif(COUNT GREATER 3)\nset(MAJOR ${MAJOR} PARENT_SCOPE)\nendif()\nendfunction()\nparse(9.7.2)\nfile(WRITE ${CMAKE_CURRENT_BINARY_DIR}/version "${MAJOR}.0.0")\ninstall(FILES ${CMAKE_CURRENT_BINARY_DIR}/version DESTINATION .info)', "1.0.0"],
    ["parent-scope value capture", 'function(parse)\nset(V 1.2.3 PARENT_SCOPE)\nset(V 9.8.7)\nset(OTHER ${V} PARENT_SCOPE)\nendfunction()\nparse()\nfile(WRITE ${CMAKE_CURRENT_BINARY_DIR}/version "${V}")\ninstall(FILES ${CMAKE_CURRENT_BINARY_DIR}/version DESTINATION .info)', "1.2.3"],
    ["block-local variables", 'set(V 1.2.3)\nblock()\nset(V 9.8.7)\nendblock()\nfile(WRITE ${CMAKE_CURRENT_BINARY_DIR}/version "${V}")\ninstall(FILES ${CMAKE_CURRENT_BINARY_DIR}/version DESTINATION .info)', "1.2.3"],
    ["block parent-scope capture", 'set(V 1.2.3)\nblock()\nset(V 9.8.7 PARENT_SCOPE)\nset(V 3.4.5)\nendblock()\nfile(WRITE ${CMAKE_CURRENT_BINARY_DIR}/version "${V}")\ninstall(FILES ${CMAKE_CURRENT_BINARY_DIR}/version DESTINATION .info)', "9.8.7"],
    ["macro lexical parent scope", 'set(V 0.0.1)\nmacro(change)\nset(V 1.2.3 PARENT_SCOPE)\nset(V 9.8.7)\nendmacro()\nfunction(compute)\nset(V 2.0.0)\nchange()\nendfunction()\ncompute()\nfile(WRITE ${CMAKE_CURRENT_BINARY_DIR}/version "${V}")\ninstall(FILES ${CMAKE_CURRENT_BINARY_DIR}/version DESTINATION .info)', "1.2.3"],
    ["parent-scope deletion", 'set(V 1.2.3)\nfunction(parse)\nunset(V PARENT_SCOPE)\nendfunction()\nparse()\nfile(WRITE ${CMAKE_CURRENT_BINARY_DIR}/version "${V}")\ninstall(FILES ${CMAKE_CURRENT_BINARY_DIR}/version DESTINATION .info)', undefined],
  ]) test(`generated file final-state evidence: ${name}`, () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `project(Owner VERSION 2.0)\n${producer}`);
    put("app/CMakeLists.txt", "project(Consumer VERSION 99.0)");
    put("app/cmake/FindDistribution.cmake", customVersionFinder);
    const result = resolveNativeRequirements([request("Distribution")], collectNativeProviders([owner("vendor", "Owner", "2.0"), owner("app", "Consumer", "99.0")], { scanRoot: root }));
    const candidate = result.unresolved[0].candidates.find((entry) => entry.ref === "vendor@2.0");
    assert.ok(candidate);
    assert.ok(candidate.exports.every((entry) => entry.generatedVersion === expected));
    if (!expected) assert.ok(candidate.exports.every((entry) => entry.interfaceVersionUnknown));
  }));

  const stagedFixture = (run) => fixture(({ root, put, owner }) => {
    const sourceText = "libowner = shared_library(\n  'plain_api',\n  'api.c', install : true)\n";
    const sourceRoot = "source-metadata/archive/owner-2.24.1";
    const descriptor = (path, text, format) => {
      put(path, text);
      return { path, sha256: createHash("sha256").update(text).digest("hex"), ...(format ? { format } : {}) };
    };
    const supplemental = [
      descriptor(`${sourceRoot}/meson.build`, "project('owner', 'c', version : '2.24.1')\nsubdir('va')"),
      descriptor(`${sourceRoot}/va/meson.build`, sourceText),
    ];
    createTar({ sync: true, cwd: join(root, "source-metadata/archive"), file: join(root, "owner.tar.gz"), gzip: true }, ["owner-2.24.1"]);
    const archive = readFileSync(join(root, "owner.tar.gz"));
    const archiveSha256 = createHash("sha256").update(archive).digest("hex");
    const archiveSha512 = createHash("sha512").update(archive).digest("hex");
    const url = "https://example.org/owner-2.24.1.tar.gz";
    supplemental.push(descriptor("source-metadata/archive/archive-manifest.json", JSON.stringify({
      archivePath: "owner.tar.gz", sourceSha512: archiveSha512, acquisitionUrls: [url],
      members: ["owner-2.24.1/meson.build", "owner-2.24.1/va/meson.build"],
    })));
    const metadata = descriptor("owner.json", JSON.stringify({ name: "owner", version: "2.24.1" }), "vcpkg-json");
    const recipe = descriptor("portfile.cmake", `vcpkg_from_github(REPO example/owner REF v2.24.1 SHA512 ${archiveSha512})\nvcpkg_cmake_config_fixup(PACKAGE_NAME Owner)\n`);
    put("providers.json", JSON.stringify({ schema: 1, providers: [{ metadata, recipe, supplemental, registryRevision: "a".repeat(40) }] }));
    const evidence = loadNativeExternalMetadata({ nativeProviderMetadata: join(root, "providers.json") })[0];
    const component = { name: evidence.name, version: evidence.version, "bom-ref": "owner", properties: [
      { name: "cdx:native:providerIdentity", value: "fixture" },
      { name: "cdx:native:providerEvidence", value: JSON.stringify(evidence) },
      { name: "cdx:native:providerExports", value: JSON.stringify(evidence.exports) },
    ] };
    const wrap = (sha256 = archiveSha256) => "[wrap-file]\ndirectory = owner-2.24.1\nsource_url = " + url + "\nsource_hash = " + sha256;
    put("mesa/subprojects/owner.wrap", wrap());
    const command = "project(Stage VERSION 99.0)\nset(SOURCE_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../mesa)\nset(PATCH_SOURCE_DIR ${CMAKE_CURRENT_BINARY_DIR}/staged)\nadd_custom_target(stage COMMAND ${CMAKE_COMMAND} -E copy_directory ${SOURCE_DIR} ${PATCH_SOURCE_DIR} COMMAND powershell -File ${CMAKE_CURRENT_SOURCE_DIR}/patch.ps1 ${PATCH_SOURCE_DIR})";
    put("stage/CMakeLists.txt", command);
    const scriptBody = 'param([string]$SourceDir)\n$Subproject = Get-ChildItem -Path "$SourceDir/subprojects" -Directory |\n  Where-Object { $_.Name -match \'^owner-[0-9]\' } | Select-Object -First 1\n$MesonBuild = "$($Subproject.FullName)/va/meson.build"\n$content = Convert-Lf (Get-Content $MesonBuild -Raw)\n$old = @\'\nlibowner = shared_library(\n  \'plain_api\',\n\'@\n$new = @\'\nlibowner = shared_library(\n  \'staged_api\',\n\'@\n$content = $content.Replace($old, $new)\nSet-Utf8NoBom $MesonBuild $content\n';
    const script = scriptBody.replace("param([string]$SourceDir)\n", 'param([string]$SourceDir)\nfunction Convert-Lf([string]$s) { return $s.Replace("`r`n", "`n") }\nfunction Set-Utf8NoBom([string]$path, [string]$text) {\n$utf8NoBom = New-Object System.Text.UTF8Encoding($false)\n[System.IO.File]::WriteAllText($path, $text, $utf8NoBom)\n}\n');
    put("stage/patch.ps1", script);
    const resolve = (name = "staged_api") => resolveNativeRequirements([request(name, "find_library")], collectNativeProviders([owner("stage", "Stage", "99.0")], { scanRoot: root, availableProviders: [component] }));
    run({ root, put, owner, component, script, command, wrap, archiveSha256, archiveSha512, resolve, metadata, recipe, supplemental, descriptor, sourceRoot });
  });
  test("literal invoked staging replacements bind renamed libraries only to the exact wrapped acquisition", () => stagedFixture(({ put, script, command, wrap, archiveSha256, archiveSha512, resolve }) => {
    const result = resolve();
    assert.equal(result.bindings.length, 0);
    assert.ok(result.unresolved[0].candidates.some((candidate) => candidate.ref === "owner" && candidate.exports.some((entry) => entry.name === "staged_api" && entry.transformationSource?.includes("patch.ps1") && entry.sourceArchive.sha256 === archiveSha256 && entry.sourceArchive.sha512 === archiveSha512)));
    put("mesa/subprojects/owner.wrap", wrap(createHash("sha256").update("same-version-different-artifact").digest("hex")));
    assert.equal(resolve().unresolved[0].candidates.length, 0);
    put("mesa/subprojects/owner.wrap", wrap());
    put("stage/patch.ps1", script.replace("param([string]$SourceDir)\n", ""));
    assert.equal(resolve().unresolved[0].candidates.length, 0, "CMake variables do not implicitly bind PowerShell parameters");
    put("stage/patch.ps1", script.replace('return $s.Replace("`r`n", "`n")', 'return "unrelated"'));
    assert.equal(resolve().unresolved[0].candidates.length, 0, "helper names alone do not establish literal transformation semantics");
    put("stage/patch.ps1", script);
    put("stage/CMakeLists.txt", command.replace("COMMAND powershell -File ${CMAKE_CURRENT_SOURCE_DIR}/patch.ps1 ${PATCH_SOURCE_DIR}", ""));
    assert.equal(resolve().unresolved[0].candidates.length, 0, "uninvoked scripts are not source transformations");
  }));
  test("single-quoted PowerShell discovery paths cannot bind a source parameter", () => stagedFixture(({ put, script, resolve }) => {
    put("stage/patch.ps1", script.replace('"$SourceDir/subprojects"', "'$SourceDir/subprojects'"));
    assert.equal(resolve().unresolved[0].candidates.length, 0);
    put("stage/patch.ps1", script.replace('"$SourceDir/subprojects"', '"`$SourceDir/subprojects"'));
    assert.equal(resolve().unresolved[0].candidates.length, 0, "a backtick-escaped dollar is literal, not parameter interpolation");
  }));
  test("PowerShell rereads observe previously written transformed source bytes", () => stagedFixture(({ put, script, resolve }) => {
    put("stage/patch.ps1", `${script}$content = Convert-Lf (Get-Content $MesonBuild -Raw)\n$content = $content.Replace('staged_api', 'final_api')\nSet-Utf8NoBom $MesonBuild $content\n`);
    assert.ok(resolve("final_api").unresolved[0].candidates.some((candidate) => candidate.ref === "owner" && candidate.exports.some((entry) => entry.name === "final_api" && entry.transformedSourceSha256)));
    assert.equal(resolve().unresolved[0].candidates.length, 0, "an intermediate write is not the final projected library");
  }));
  test("uninvoked PowerShell functions do not execute staged transformations", () => stagedFixture(({ put, script, resolve }) => {
    const start = script.indexOf("$Subproject =");
    put("stage/patch.ps1", `${script.slice(0, start)}function Unused {\n${script.slice(start)}\n}\n`);
    assert.equal(resolve().unresolved[0].candidates.length, 0);
  }));
  test("statically false PowerShell blocks do not execute staged transformations", () => stagedFixture(({ put, script, resolve }) => {
    const start = script.indexOf("$Subproject =");
    put("stage/patch.ps1", `${script.slice(0, start)}if ($false) {\n${script.slice(start)}\n}\n`);
    assert.equal(resolve().unresolved[0].candidates.length, 0);
  }));
  test("PowerShell derives only the content reaching the verified writer", () => stagedFixture(({ put, script, resolve }) => {
    put("stage/patch.ps1", script.replace("$content = $content.Replace($old, $new)\nSet-Utf8NoBom $MesonBuild $content", "Set-Utf8NoBom $MesonBuild $content\n$content = $content.Replace($old, $new)"));
    assert.equal(resolve().unresolved[0].candidates.length, 0);
  }));
  test("PowerShell helper redefinitions are case insensitive", () => stagedFixture(({ put, script, resolve }) => {
    put("stage/patch.ps1", script.replace("$Subproject =", 'function convert-lf([string]$s) { return "unrelated" }\n$Subproject ='));
    assert.equal(resolve().unresolved[0].candidates.length, 0);
  }));
  test("PowerShell case-variant content overwrites cannot retain an earlier literal pipeline", () => stagedFixture(({ put, script, resolve }) => {
    put("stage/patch.ps1", script.replace("$content = $content.Replace($old, $new)", '$CONTENT = "unrelated"\n$content = $content.Replace($old, $new)'));
    assert.equal(resolve().unresolved[0].candidates.length, 0);
  }));
  test("PowerShell comments are not executable transformation statements", () => stagedFixture(({ put, script, resolve }) => {
    const start = script.indexOf("$Subproject =");
    put("stage/patch.ps1", `${script.slice(0, start)}<#\n${script.slice(start)}\n#>\n`);
    assert.equal(resolve().unresolved[0].candidates.length, 0);
  }));
  test("PowerShell here-string data is not an executable transformation", () => stagedFixture(({ put, script, resolve }) => {
    const start = script.indexOf("$Subproject =");
    const body = script.slice(start);
    put("stage/patch.ps1", `${script.slice(0, start)}$example = @"\n${body}\n"@\n`);
    assert.equal(resolve().unresolved[0].candidates.length, 0);
  }));
  test("unlisted Meson ownership declarations cannot authenticate a listed child library", () => stagedFixture(({ root, put, owner, metadata, recipe, supplemental, descriptor }) => {
    const inventory = descriptor("source-metadata/archive/archive-manifest.json", JSON.stringify({ members: ["owner-2.24.1/va/meson.build"] }));
    put("providers.json", JSON.stringify({ schema: 1, providers: [{ metadata, recipe, supplemental: [...supplemental.filter((entry) => !entry.path.endsWith("archive-manifest.json")), inventory], registryRevision: "a".repeat(40) }] }));
    const record = loadNativeExternalMetadata({ nativeProviderMetadata: join(root, "providers.json") })[0];
    const component = { name: record.name, version: record.version, "bom-ref": "owner", properties: [
      { name: "cdx:native:providerIdentity", value: "fixture" },
      { name: "cdx:native:providerEvidence", value: JSON.stringify(record) },
      { name: "cdx:native:providerExports", value: JSON.stringify(record.exports) },
    ] };
    const result = resolveNativeRequirements([request("plain_api", "find_library")], collectNativeProviders([owner("stage", "Stage", "99.0")], { scanRoot: root, availableProviders: [component] }));
    assert.equal(result.unresolved[0].candidates.length, 0);
  }));


  test("indexes actual config, installed library, alias and output names with owner spans", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `project(Owner VERSION 2.4.0)
set(LIB owned)
add_subdirectory(library)
configure_package_config_file(OwnerConfig.cmake.in \${CMAKE_CURRENT_BINARY_DIR}/PublicConfig.cmake INSTALL_DESTINATION lib/cmake/Public)
`);
    put("vendor/library/CMakeLists.txt", `add_library(\${LIB} SHARED source.cpp)
add_library(Public::API ALIAS owned)
set_target_properties(owned PROPERTIES OUTPUT_NAME artifact EXPORT_NAME API)
install(TARGETS owned EXPORT PublicTargets)
install(EXPORT PublicTargets NAMESPACE Public:: DESTINATION lib/cmake/Public)
`);
    const index = collectNativeProviders([owner("vendor", "Owner", "2.4.0")], { scanRoot: root });
    const result = resolveNativeRequirements([request("Public"), request("artifact", "find_library"), request("Public::API", "target_link_libraries")], index);
    assert.equal(result.unresolved.length, 0);
    assert.ok(result.bindings.every((binding) => binding.providerRefs[0] === "vendor@2.4.0"));
    assert.ok(result.bindings.every((binding) => binding.providers.every((provider) => provider.exports.every((entry) => entry.source && entry.ownerDir === join(root, "vendor")))));
  }));

  test("retains both export alternatives when a declaration lacks its version argument", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `project(Owner VERSION)
if(TRUE)
endif()
if(PROJECT_VERSION)
  add_library(first SHARED first.c)
else()
  add_library(second SHARED second.c)
endif()
install(TARGETS first second)
`);
    const index = collectNativeProviders([owner("vendor", "Owner", "2.4.0")], {
      scanRoot: root, nativeSourceManifests: [join(root, "vendor/CMakeLists.txt")],
    });
    const result = resolveNativeRequirements([request("first", "find_library"), request("second", "find_library")], index);
    assert.deepEqual(result.bindings.map((binding) => binding.requirement.requestedName), ["first", "second"]);
  }));

  test("rejects bare global project names and nested unrelated library ownership", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", "project(Owner VERSION 2.0)\nadd_library(private SHARED private.c)\nadd_subdirectory(foreign)");
    put("vendor/foreign/CMakeLists.txt", "project(Foreign VERSION 9.0)\nadd_library(stolen SHARED stolen.c)\ninstall(TARGETS stolen)");
    const index = collectNativeProviders([owner("vendor", "Owner", "2.0")], { scanRoot: root });
    const requests = [request("Owner"), request("private", "find_library"), request("stolen", "find_library"), request("Owner", "find_package", { file: "vendor/test/CMakeLists.txt" })];
    const result = resolveNativeRequirements(requests, index);
    assert.deepEqual(result.unresolved.map((entry) => entry.requirement.requestedName), ["Owner", "private", "stolen"]);
    assert.equal(result.bindings.length, 1);
  }));

  test("returns all explicit compatible releases and does not turn revisions into numeric releases", () => fixture(({ root, put, owner }) => {
    const facts = [owner("a", "rocRAND", "5.3.0"), owner("b", "rocRAND", "5.4.0"), owner("revision", "rocRAND", "abc0123456789abcdef0123456789abcdef0123456", "source-revision")];
    for (const path of ["a", "b", "revision"]) put(`${path}/CMakeLists.txt`, "project(rocRAND)\nadd_library(rocrand SHARED rand.c)\nrocm_export_targets(TARGETS roc::rocrand NAMESPACE roc::)");
    const index = collectNativeProviders(facts, { scanRoot: root });
    const unconstrained = resolveNativeRequirements([request("rocrand")], index);
    assert.equal(unconstrained.bindings[0].providerRefs.length, 3);
    const constrained = resolveNativeRequirements([request("rocrand", "find_package", { constraints: "5.3...<5.4" })], index);
    assert.deepEqual(constrained.bindings[0].providerRefs, ["a@5.3.0"]);
    assert.equal(constrained.bindings[0].compatibility, "satisfied");
    assert.ok(constrained.bindings[0].candidates.some((candidate) => candidate.compatibility === "unknown"));
    assert.ok(constrained.bindings[0].candidates.some((candidate) => candidate.compatibility === "violated"));
    const onlyRevision = collectNativeProviders([facts[2]], { scanRoot: root });
    assert.equal(resolveNativeRequirements([request("rocrand", "find_package", { constraints: "5.0" })], onlyRevision).unresolved[0].compatibility, "unknown");
  }));

  test("does not accept a selected foreign owner merely because its name matches", () => fixture(({ root, put, owner }) => {
    put("a/CMakeLists.txt", "project(Owner)\nrocm_export_targets(TARGETS a NAME same)");
    put("b/CMakeLists.txt", "project(Unrelated)");
    const index = collectNativeProviders([owner("a", "Owner", "1.0"), owner("b", "same", "9.0")], { scanRoot: root });
    const result = resolveNativeRequirements([request("same", "find_package", { providerCandidates: [{ ref: "b@9.0", selected: true }] })], index);
    assert.equal(result.bindings.length, 0);
  }));

  test("collects helper-created exports only from invoked helpers and preserves conditions", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `project(Owner VERSION 3.0)
include(cmake/Export.cmake)
if(ENABLE_PUBLIC)
make_export(public)
endif()
`);
    put("vendor/cmake/Export.cmake", `function(make_export NAME)
add_library(\${NAME} SHARED public.c)
install(TARGETS \${NAME})
endfunction()
function(unused)
add_library(fake SHARED fake.c)
install(TARGETS fake)
endfunction()
`);
    const index = collectNativeProviders([owner("vendor", "Owner", "3.0")], { scanRoot: root });
    const result = resolveNativeRequirements([request("public", "find_library"), request("fake", "find_library")], index);
    assert.equal(result.bindings.length, 1);
    assert.equal(result.unresolved.length, 1);
    assert.ok(result.bindings[0].providers[0].exports.some((entry) => entry.conditions.includes("if(ENABLE_PUBLIC)")));
  }));

  test("collects pc and Meson override/pkgconfig names with Meson constraints", () => fixture(({ root, put, owner }) => {
    put("meson/meson.build", `project('owner', 'c', version : '2.6.0')
lib = library('physical', 'lib.c', install : true)
dep = declare_dependency(link_with : lib)
meson.override_dependency('public-dep', dep)
pkg = import('pkgconfig')
pkg.generate(lib, filebase : 'public-pc', name : 'Human readable name')
`);
    put("meson/extra.pc", "Name: NotTheIdentity\nVersion: 2.6.0\nLibs: -lphysical\n");
    const index = collectNativeProviders([owner("meson", "owner", "2.6.0")], { scanRoot: root });
    const result = resolveNativeRequirements([request("public-dep", "dependency", { constraints: ">= 2.0" }), request("public-pc", "dependency"), request("extra", "dependency"), request("NotTheIdentity", "dependency")], index);
    assert.equal(result.bindings.length, 3);
    assert.equal(result.unresolved[0].requirement.requestedName, "NotTheIdentity");
    for (const method of ["pkg-config", "cmake"]) {
      const overridden = resolveNativeRequirements([request("public-dep", "dependency", {
        arguments: ["'public-dep'", `method : '${method}'`],
      })], index);
      assert.equal(overridden.bindings.length, 1, "Meson overrides take precedence over explicit backend lookup");
      assert.ok(overridden.bindings[0].providers.every((provider) => provider.exports.every((entry) => entry.kind === "meson")));
    }
  }));

  test("keeps duplicate requirement occurrences and numeric unknowns explicit", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", "project(Owner)\nrocm_export_targets(TARGETS x NAME public)");
    const index = collectNativeProviders([owner("vendor", "Owner", "2.0")], { scanRoot: root });
    const a = request("public", "find_package", { ordinal: 1, constraints: "1.0" });
    const b = request("public", "find_package", { ordinal: 2, constraints: "9.0 EXACT" });
    const result = resolveNativeRequirements([a, b], index);
    assert.equal(result.bindings[0].requirement, a);
    assert.equal(result.unresolved[0].requirement, b);
    assert.equal(result.unresolved[0].compatibility, "violated");
  }));
  test("config interfaces remain distinct from source revisions and retain compatibility policy", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", "project(Owner)\nconfigure_package_config_file(PublicConfig.cmake.in PublicConfig.cmake)\nwrite_basic_package_version_file(PublicConfigVersion.cmake VERSION 3.7.02 COMPATIBILITY SameMajorVersion)");
    const index = collectNativeProviders([owner("vendor", "Owner", "a".repeat(40), "source-revision")], { scanRoot: root });
    const result = resolveNativeRequirements([request("Public", "find_package", { constraints: "3.1" }), request("Public", "find_package", { constraints: "2.0" })], index);
    assert.equal(result.bindings.length, 1);
    assert.equal(result.bindings[0].providers[0].version, "a".repeat(40));
    assert.ok(result.bindings[0].providers[0].exports.some((entry) => entry.interfaceVersion === "3.7.02" && entry.compatibilityMode === "SameMajorVersion"));
    assert.equal(result.unresolved[0].compatibility, "violated");
  }));

  test("unknown config re-evaluation does not erase an independently known owner interface", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", "project(Owner VERSION ${UNSUPPORTED_HEADER_VERSION})\nconfigure_package_config_file(PublicConfig.cmake.in PublicConfig.cmake)\nwrite_basic_package_version_file(PublicConfigVersion.cmake VERSION ${PROJECT_VERSION} COMPATIBILITY AnyNewerVersion)");
    const result = resolveNativeRequirements([request("Public")], collectNativeProviders([owner("vendor", "Owner", "2.1.0")], { scanRoot: root }));
    assert.equal(result.bindings[0]?.providers[0].version, "2.1.0");
  }));

  test("installed directory payloads export real configs but not excluded or uninstalled files", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", "project(Owner VERSION 3.0.2)\ninstall(DIRECTORY lib/ DESTINATION lib PATTERN HiddenConfig.cmake EXCLUDE)");
    put("vendor/lib/cmake/Public/PublicConfig.cmake", "include(PublicTargets.cmake)");
    put("vendor/lib/cmake/Public/HiddenConfig.cmake", "");
    put("vendor/unused/UnusedConfig.cmake", "");
    const manifests = ["vendor/CMakeLists.txt", "vendor/lib/cmake/Public/PublicConfig.cmake", "vendor/lib/cmake/Public/HiddenConfig.cmake", "vendor/unused/UnusedConfig.cmake"].map((file) => join(root, file));
    const result = resolveNativeRequirements([request("Public"), request("Hidden"), request("Unused")], collectNativeProviders([owner("vendor", "Owner", "3.0.2")], { scanRoot: root, nativeSourceManifests: manifests }));
    assert.deepEqual(result.bindings.map((entry) => entry.requirement.requestedName), ["Public"]);
    assert.deepEqual(result.unresolved.map((entry) => entry.requirement.requestedName), ["Hidden", "Unused"]);
  }));

  test("literal static and shared artifacts never borrow each other's filename", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", "project(Owner VERSION 1.9.0)\nadd_library(hsakmt STATIC source.c)\ninstall(TARGETS hsakmt)");
    const result = resolveNativeRequirements([request("libhsakmt.a", "find_library"), request("libhsakmt.so", "find_library")], collectNativeProviders([owner("vendor", "Owner", "1.9.0")], { scanRoot: root }));
    assert.deepEqual(result.bindings.map((entry) => entry.requirement.requestedName), ["libhsakmt.a"]);
    assert.deepEqual(result.unresolved.map((entry) => entry.requirement.requestedName), ["libhsakmt.so"]);
  }));

  test("uses consumer-owned Find module library identity without assigning the module owner's version", () => fixture(({ root, put, owner }) => {
    put("app/CMakeLists.txt", "project(App VERSION 9.0)");
    put("app/cmake/FindPublic.cmake", "find_library(PUBLIC_LIB NAMES actual)");
    put("vendor/CMakeLists.txt", "project(Owner VERSION 2.0)\nadd_library(actual SHARED actual.c)\ninstall(TARGETS actual)");
    const index = collectNativeProviders([owner("app", "App", "9.0"), owner("vendor", "Owner", "2.0")], { scanRoot: root });
    const result = resolveNativeRequirements([request("Public"), request("Public", "find_package", { file: "elsewhere/CMakeLists.txt" })], index);
    assert.deepEqual(result.bindings[0].providerRefs, ["vendor@2.0"]);
    assert.equal(result.unresolved.length, 1);
    assert.ok(result.bindings[0].providers[0].exports.some((entry) => entry.via?.endsWith("app/cmake/FindPublic.cmake:1")));
  }));
  test("a scoped finder retains owner candidates but cannot satisfy a missing required artifact conjunction", () => fixture(({ root, put, owner }) => {
    put("app/CMakeLists.txt", "project(App VERSION 9.0)");
    put("app/cmake/FindPublic.cmake", "find_library(PUBLIC_LIBRARY NAMES actual)\nfind_path(PUBLIC_INCLUDE_DIR NAMES public/api.h)\nfind_package_handle_standard_args(Public REQUIRED_VARS PUBLIC_LIBRARY PUBLIC_INCLUDE_DIR)");
    put("vendor/CMakeLists.txt", "project(Owner VERSION 2.0)\nadd_library(actual SHARED actual.c)\ninstall(TARGETS actual)");
    const result = resolveNativeRequirements([request("Public")], collectNativeProviders([owner("app", "App", "9.0"), owner("vendor", "Owner", "2.0")], { scanRoot: root }));
    assert.equal(result.bindings.length, 0);
    assert.ok(result.unresolved[0].candidates.some((entry) => entry.ref === "vendor@2.0"));
    assert.equal(result.unresolved[0].compatibility, "unknown");
  }));

  test("a bundled data-only finder belongs to its actual source helper owner, not the tool it searches", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", "project(Owner VERSION 3.11.0)");
    put("vendor/cmake/FindCoverage.cmake", "find_package(Gcov)\nfind_package(Lcov)\nfind_package_handle_standard_args(Coverage REQUIRED_VARS GCOV_EXECUTABLE LCOV_EXECUTABLE)");
    const result = resolveNativeRequirements([request("Coverage", "find_package", { file: "vendor/tests/CMakeLists.txt" })], collectNativeProviders([owner("vendor", "Owner", "3.11.0")], { scanRoot: root }));
    assert.ok(result.unresolved[0].candidates.some((entry) => entry.ref === "vendor@3.11.0" && entry.exports.some((exp) => exp.kind === "build-helper")));
    assert.equal(result.bindings.length, 0);
  }));
  test("owner candidates cannot silently satisfy unknown roots or unknown component predicates", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", "project(Owner VERSION 2.0)\nconfigure_package_config_file(PublicConfig.cmake.in PublicConfig.cmake)");
    const index = collectNativeProviders([owner("vendor", "Owner", "2.0")], { scanRoot: root });
    const result = resolveNativeRequirements([
      request("Public", "find_package", { arguments: ["Public", "CONFIG", "HINTS", "${UNKNOWN_ROOT}"] }),
      request("Public", "find_package", { arguments: ["Public", "CONFIG", "COMPONENTS", "Absent"] }),
    ], index);
    assert.equal(result.bindings.length, 0);
    assert.ok(result.unresolved.every((entry) => entry.candidates.some((candidate) => candidate.ref === "vendor@2.0" && candidate.compatibility === "unknown")));
  }));
  test("Meson list-valued private links and rust proc macros retain genuine source-owned exports", () => fixture(({ root, put, owner }) => {
    put("vendor/meson.build", "project('owner', version : '1.0.14')\nrust = import('rust')\nmacro = rust.proc_macro('paste', 'lib.rs')\nlib = static_library('physical', 'lib.c')\nprivate_dep = declare_dependency(link_with : [lib])\nmeson.override_dependency('public', private_dep)\n");
    const result = resolveNativeRequirements([request("public", "dependency"), request("paste", "find_library", { file: "vendor/meson.build" }),
      request("paste", "target_link_libraries", { file: "vendor/meson.build" }), request("paste", "target_link_libraries")],
    collectNativeProviders([owner("vendor", "owner", "1.0.14")], { scanRoot: root }));
    assert.deepEqual(result.bindings[0].providerRefs, ["vendor@1.0.14"]);
    assert.deepEqual(result.unresolved.map((row) => row.candidates.map((candidate) => candidate.ref)), [[], ["vendor@1.0.14"], []]);
    assert.equal(result.unresolved[1].candidates[0].exports[0].materialType, "rust-proc-macro");
  }));
  test("cached provider imports reject invented export source metadata even when strings are nonempty", () => fixture(({ root }) => {
    const provider = { name: "forged", version: "9.0", "bom-ref": "forged", properties: [
      { name: "cdx:native:providerIdentity", value: "pretend-authenticated" },
      { name: "cdx:native:providerEvidence", value: JSON.stringify({ kind: "package-manifest", metadataPath: join(root, "missing.json"), metadataSha256: "a".repeat(64), manifestPath: join(root, "missing-manifest.json"), manifestSha256: "b".repeat(64) }) },
      { name: "cdx:native:providerExports", value: JSON.stringify([{ kind: "cmake-package", name: "Public", source: "pretend-verified.json#/usr/PublicConfig.cmake" }]) },
    ] };
    assert.equal(collectNativeProviders([], { scanRoot: root, availableProviders: [provider] }).providers.length, 0);
  }));




  test("Meson overrides cannot assign an external dependency the wrapper owner's version", () => fixture(({ root, put, owner }) => {
    put("meson/meson.build", "project('wrapper', version : '9.0')\nexternal = dependency('external')\nmeson.override_dependency('external-alias', external)");
    const result = resolveNativeRequirements([request("external-alias", "dependency")], collectNativeProviders([owner("meson", "wrapper", "9.0")], { scanRoot: root }));
    assert.equal(result.bindings.length, 0);
  }));

  test("wrap provides aliases require a checked-out versioned owner and stay consumer-scoped", () => fixture(({ root, put, owner }) => {
    put("app/meson.build", "project('app', version : '9.0')");
    put("app/subprojects/source.wrap", "[wrap-file]\ndirectory = source-tree\n[provide]\npublic-dep = public_dependency\nmissing = missing_dep");
    put("app/subprojects/source-tree/meson.build", "project('real-owner', version : '2.0')");
    const index = collectNativeProviders([owner("app", "app", "9.0"), owner("app/subprojects/source-tree", "real-owner", "2.0")], { scanRoot: root });
    const result = resolveNativeRequirements([
      request("public-dep", "dependency", { file: "app/meson.build", providerCandidates: [{
        kind: "local-wrap", ref: "app/subprojects/source-tree@2.0", source: { file: "app/subprojects/source.wrap" },
        dependencyVariable: "public_dependency", conditions: ["fallback_enabled"], selected: false,
      }] }),
      request("public-dep", "dependency", { file: "elsewhere/meson.build" }),
    ], index);
    assert.deepEqual(result.unresolved.map((row) => row.candidates.map((candidate) => [candidate.ref, candidate.compatibility])),
      [[["app/subprojects/source-tree@2.0", "unknown"]], []]);
    assert.equal(result.unresolved[0].candidates[0].exports[0].dependencyVariable, "public_dependency");
    assert.deepEqual(result.unresolved[0].candidates[0].exports[0].requirementConditions, ["fallback_enabled"]);
  }));
  test("indexes supplied manifests and transitive argument-bound export helpers without owner-wide command loss", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", "project(Owner VERSION 2.0)\nlist(APPEND CMAKE_MODULE_PATH ${CMAKE_CURRENT_SOURCE_DIR}/cmake/modules)\ninclude(AddNative)\n");
    put("vendor/cmake/modules/AddNative.cmake", `function(native_library NAME)
cmake_parse_arguments(ARG "SHARED;STATIC" "OUTPUT_NAME" "" \${ARGN})
${Array.from({ length: 200 }, (_, index) => `set(unused_source_${index} irrelevant.cpp)`).join("\n")}
add_library(\${NAME} \${ARG_UNPARSED_ARGUMENTS})
if(ARG_OUTPUT_NAME)
set_target_properties(\${NAME} PROPERTIES OUTPUT_NAME \${ARG_OUTPUT_NAME})
endif()
endfunction()
macro(native_component NAME)
native_library(\${NAME} \${ARGN})
install(TARGETS \${NAME} EXPORT OwnerTargets)
endmacro()
`);
    const manifests = ["vendor/CMakeLists.txt", "vendor/cmake/modules/AddNative.cmake"];
    for (let index = 0; index < 420; index++) {
      const file = `vendor/lib/component-${index}/CMakeLists.txt`;
      put(file, `native_component(target_${index} OUTPUT_NAME artifact_${index})`);
      manifests.push(file);
    }
    const index = collectNativeProviders([owner("vendor", "Owner", "2.0")], { scanRoot: root, nativeSourceManifests: manifests.map((file) => join(root, file)) });
    const requests = Array.from({ length: 420 }, (_, at) => request(`artifact_${at}`, "find_library"));
    const result = resolveNativeRequirements(requests, index);
    assert.equal(result.bindings.length, 420);
    assert.equal(result.unresolved.length, 0);
    assert.ok(!index.diagnostics.some((entry) => entry.reason === "command-budget"));
    assert.ok(result.bindings[419].providers[0].exports.some((entry) => entry.conditions.some((condition) => condition.startsWith("call("))));
  }));

  test("resolves explicitly included shared helper modules without borrowing their owner's version", () => fixture(({ root, put, owner }) => {
    put("toolkit/CMakeLists.txt", "project(Toolkit VERSION 99.0)");
    put("toolkit/cmake/InstallOwned.cmake", "function(install_owned)\ncmake_parse_arguments(ARG \"\" \"\" \"TARGETS\" ${ARGN})\nforeach(target IN LISTS ARG_TARGETS)\ninstall(TARGETS ${target})\nendforeach()\nendfunction()");
    put("library/CMakeLists.txt", "project(Library VERSION 2.0)\ninclude(../toolkit/cmake/InstallOwned.cmake)\nadd_library(actual SHARED actual.c)\ninstall_owned(TARGETS actual)");
    const manifests = ["toolkit/CMakeLists.txt", "toolkit/cmake/InstallOwned.cmake", "library/CMakeLists.txt"].map((file) => join(root, file));
    const index = collectNativeProviders([owner("toolkit", "Toolkit", "99.0"), owner("library", "Library", "2.0")], { scanRoot: root, nativeSourceManifests: manifests });
    const result = resolveNativeRequirements([request("actual", "find_library")], index);
    assert.deepEqual(result.bindings[0].providerRefs, ["library@2.0"]);
    assert.ok(result.bindings[0].providers[0].exports.every((entry) => entry.ownerDir === join(root, "library")));
  }));
  test("a unique module basename in an unrelated repository is not an implicit include", () => fixture(({ root, put, owner }) => {
    put("foreign/Hidden.cmake", "function(make_hidden)\nadd_executable(hidden hidden.c)\ninstall(TARGETS hidden)\nendfunction()");
    put("app/CMakeLists.txt", "project(App VERSION 2.0)\ninclude(Hidden)\nmake_hidden()");
    const manifests = ["app/CMakeLists.txt", "foreign/Hidden.cmake"].map((file) => join(root, file));
    const index = collectNativeProviders([owner("app", "App", "2.0")], { scanRoot: root, nativeSourceManifests: manifests });
    assert.deepEqual(resolveNativeRequirements([request("hidden", "find_program")], index).unresolved[0].candidates, []);
  }));

  test("a repository sibling finder retains its real owner only as an unselected candidate", () => fixture(({ root, put, owner }) => {
    put("suite/b/CMakeLists.txt", "project(Sibling VERSION 99.0)");
    put("suite/a/CMakeLists.txt", "project(Owner VERSION 2.0)");
    put("suite/a/FindPublic.cmake", "find_library(FOUND_LIB NAMES actual)");
    const component = authenticatedComponent(root, put, "actual-owner", "3.0", [{ kind: "library", name: "actual", source: "inventory" }]);
    const manifests = ["suite/a/CMakeLists.txt", "suite/b/CMakeLists.txt", "suite/a/FindPublic.cmake"].map((file) => join(root, file));
    const facts = [owner("suite/a", "Owner", "2.0"), owner("suite/b", "Sibling", "99.0")].map((entry) => ({ ...entry, scopeDirectory: join(root, "suite") }));
    const index = collectNativeProviders(facts, { scanRoot: root, nativeSourceManifests: manifests, availableProviders: [component] });
    const result = resolveNativeRequirements(["suite/b/CMakeLists.txt", "other/CMakeLists.txt"].map((file) => request("Public", "find_package", { file })), index);
    assert.deepEqual(result.unresolved.map((row) => row.candidates.map((entry) => [entry.ref, entry.compatibility])), [[["actual-owner", "unknown"]], []]);
  }));
  test("bare Meson versions are exact and explicit backend methods do not cross-bind", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", "project(Owner VERSION 3.0)\nconfigure_package_config_file(PublicConfig.cmake.in PublicConfig.cmake)");
    put("vendor/Public.pc", "Name: Public\nVersion: 3.0\n");
    const index = collectNativeProviders([owner("vendor", "Owner", "3.0")], { scanRoot: root });
    const result = resolveNativeRequirements([
      request("Public", "dependency", { constraints: "2.0" }),
      request("Public", "dependency", { constraints: "3.0", arguments: ["'Public'", "method : 'pkg-config'"] }),
      request("Public", "dependency", { constraints: "3.0", arguments: ["'Public'", "method : 'cmake'"] }),
      request("Public", "dependency", { arguments: ["'Public'", "method : 'system'"] }),
    ], index);
    assert.equal(result.unresolved.length, 2);
    assert.equal(result.bindings.length, 2);
    assert.ok(result.bindings[0].providers.every((provider) => provider.exports.every((entry) => entry.kind === "pkg-config")));
    assert.ok(result.bindings[1].providers.every((provider) => provider.exports.every((entry) => entry.kind === "cmake-package")));
  }));

  test("a configured or installed pc file never borrows a conflicting owner version", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", "project(Owner VERSION 2.0)\nconfigure_file(public.pc.in public.pc @ONLY)\ninstall(FILES public.pc.in DESTINATION lib/pkgconfig)");
    put("vendor/public.pc.in", "Name: public\nVersion: 9.0\n");
    const result = resolveNativeRequirements([request("public", "dependency", { constraints: "< 5.0", arguments: ["'public'", "method : 'pkg-config'"] })],
      collectNativeProviders([owner("vendor", "Owner", "2.0")], { scanRoot: root }));
    assert.equal(result.bindings.length, 0);
    assert.equal(result.unresolved.length, 1);
  }));

  test("false elseif branches and the else after a true elseif cannot export libraries", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", "project(Owner VERSION 2.0)\nif(FALSE)\nelseif(FALSE)\nadd_library(phantom SHARED p.c)\ninstall(TARGETS phantom)\nelseif(TRUE)\nadd_library(real SHARED r.c)\ninstall(TARGETS real)\nelse()\nadd_library(impossible SHARED i.c)\ninstall(TARGETS impossible)\nendif()");
    const result = resolveNativeRequirements(["phantom", "real", "impossible"].map((name) => request(name, "find_library")),
      collectNativeProviders([owner("vendor", "Owner", "2.0")], { scanRoot: root }));
    assert.deepEqual(result.bindings.map((binding) => binding.requirement.requestedName), ["real"]);
    assert.equal(result.unresolved.length, 2);
  }));
  test("Find-module header bridges require exact authenticated public header paths and preserve interface unknowns", () => fixture(({ root, put, owner }) => {
    put("app/CMakeLists.txt", "project(App VERSION 9.0)");
    put("app/cmake/FindHALF.cmake", "find_path(HALF_INCLUDE_DIRS NAMES half.hpp)");
    const provider = (name, header, unknown = false) => authenticatedComponent(root, put, name, "2.2.1", [{
      kind: "header-file", name: header, ...(unknown ? { interfaceVersionUnknown: true } : { interfaceVersion: "2.2.1" }),
    }], unknown);
    const manifests = ["app/CMakeLists.txt", "app/cmake/FindHALF.cmake"].map((file) => join(root, file));
    const index = collectNativeProviders([owner("app", "App", "9.0")], { scanRoot: root, nativeSourceManifests: manifests,
      availableProviders: [provider("half", "half.hpp"), provider("unrelated", "nested/half.hpp")] });
    const result = resolveNativeRequirements([request("HALF", "find_package", { constraints: "2.0" }), request("HALF", "find_package", { file: "elsewhere/CMakeLists.txt" })], index);
    assert.deepEqual(result.bindings[0].providerRefs, ["half"]);
    assert.ok(result.bindings[0].providers[0].exports.every((entry) => entry.via.endsWith("FindHALF.cmake:1")));
    assert.equal(result.unresolved.length, 1);
    const uncertainIndex = collectNativeProviders([owner("app", "App", "9.0")], { scanRoot: root, nativeSourceManifests: manifests,
      availableProviders: [provider("half", "half.hpp", true)] });
    assert.equal(resolveNativeRequirements([request("HALF", "find_package", { constraints: "2.0" })], uncertainIndex).unresolved[0].compatibility, "unknown");
  }));

  test("an evidenced interface version overrides owner-level API uncertainty without relabeling the owner", () => fixture(({ root, put }) => {
    const component = authenticatedComponent(root, put, "interface-owner", "2.24.1", [
      { kind: "pkg-config", name: "public-api", interfaceVersion: "1.24.0" },
    ], true);
    const index = collectNativeProviders([], { scanRoot: root, availableProviders: [component] });
    const result = resolveNativeRequirements([
      request("public-api", "dependency", { constraints: ">= 1.0" }),
      request("public-api", "dependency", { constraints: ">= 2.0" }),
    ], index);
    assert.equal(result.bindings.length, 1);
    assert.equal(result.bindings[0].providers[0].version, "2.24.1");
    assert.equal(result.unresolved.length, 1);
    assert.equal(result.unresolved[0].compatibility, "violated");
  }));

  test("package aliases require matching owned project declarations and actual package exports", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", "project(ActualPackage VERSION 2.0)\nconfigure_package_config_file(config.in ActualPackageConfig.cmake)\nconfigure_package_config_file(other.in UnrelatedConfig.cmake)");
    const fact = owner("vendor", "repository-name", "2.0");
    collectNativeProviders([fact], { scanRoot: root });
    const alias = JSON.parse(fact.component.properties.find((entry) => entry.name === "cdx:native:packageIdentity").value);
    assert.equal(alias.name, "ActualPackage");
    assert.ok(alias.source.endsWith("vendor/CMakeLists.txt:1"));
    assert.ok(alias.exportSource.endsWith("vendor/CMakeLists.txt:2"));
  }));
  test("indexed recursive global-property helpers leave real owner exports intact", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `project(Owner VERSION 1.0)
function(no_effect)
set_property(GLOBAL PROPERTY ignored TRUE)
no_effect()
no_effect()
endfunction()
no_effect()
add_library(public SHARED public.c)
install(TARGETS public)
`);
    const index = collectNativeProviders([owner("vendor", "Owner", "1.0")], {
      scanRoot: root, nativeSourceManifests: [join(root, "vendor/CMakeLists.txt")],
    });
    const result = resolveNativeRequirements([request("public", "find_library")], index);
    assert.equal(result.bindings.length, 1);
    assert.equal(result.bindings[0].providerRefs[0], "vendor@1.0");
    assert.equal(index.diagnostics.length, 0);
  }));

  test("macro state and direct parent-scope outputs survive non-target property helpers", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `project(Owner VERSION 1.0)
macro(select_macro NAME)
set(MACRO_LIB \${NAME})
set_property(GLOBAL PROPERTY ignored \${MACRO_LIB})
endmacro()
function(select_parent)
set(PARENT_LIB from_function PARENT_SCOPE)
set_property(GLOBAL PROPERTY ignored \${PARENT_LIB})
endfunction()
select_macro(from_macro)
select_parent()
add_library(\${MACRO_LIB} SHARED macro.c)
add_library(\${PARENT_LIB} SHARED parent.c)
install(TARGETS \${MACRO_LIB} \${PARENT_LIB})
`);
    const index = collectNativeProviders([owner("vendor", "Owner", "1.0")], {
      scanRoot: root, nativeSourceManifests: [join(root, "vendor/CMakeLists.txt")],
    });
    const result = resolveNativeRequirements([request("from_macro", "find_library"), request("from_function", "find_library")], index);
    assert.equal(result.bindings.length, 2);
    assert.equal(result.unresolved.length, 0);
  }));

  test("dynamic target-property modes and recursive graphs with reachable exports retain effects", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `project(Owner VERSION 1.0)
function(reachable NAME)
set_property(GLOBAL PROPERTY ignored TRUE)
reachable(\${NAME})
add_library(\${NAME} SHARED source.c)
install(TARGETS \${NAME})
endfunction()
function(rename MODE)
set_property(\${MODE} physical PROPERTY OUTPUT_NAME visible)
endfunction()
reachable(physical)
rename(TARGET)
`);
    const index = collectNativeProviders([owner("vendor", "Owner", "1.0")], {
      scanRoot: root, nativeSourceManifests: [join(root, "vendor/CMakeLists.txt")],
    });
    assert.equal(resolveNativeRequirements([request("visible", "find_library")], index).bindings.length, 1);
  }));

  test("effect classification observes redefined helpers instead of reusing an empty recursive result", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `project(Owner VERSION 1.0)
function(child)
set_property(GLOBAL PROPERTY ignored TRUE)
endfunction()
function(parent)
child()
endfunction()
parent()
function(child)
add_library(visible SHARED visible.c)
install(TARGETS visible)
endfunction()
parent()
`);
    const index = collectNativeProviders([owner("vendor", "Owner", "1.0")], {
      scanRoot: root, nativeSourceManifests: [join(root, "vendor/CMakeLists.txt")],
    });
    assert.equal(resolveNativeRequirements([request("visible", "find_library")], index).bindings.length, 1);
  }));

  test("unexecuted helper inspection cannot reuse slices after a transitive helper changes", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `project(Owner VERSION 1.0)
function(leaf NAME)
set_property(GLOBAL PROPERTY ignored TRUE)
endfunction()
function(child NAME)
leaf(\${NAME})
endfunction()
function(parent NAME)
if(FALSE)
child(unexecuted)
endif()
add_library(\${NAME} SHARED source.c)
install(TARGETS \${NAME})
endfunction()
parent(first)
parent(second)
function(leaf NAME)
add_library(\${NAME} SHARED source.c)
install(TARGETS \${NAME})
endfunction()
child(visible)
`);
    const index = collectNativeProviders([owner("vendor", "Owner", "1.0")], {
      scanRoot: root, nativeSourceManifests: [join(root, "vendor/CMakeLists.txt")],
    });
    const result = resolveNativeRequirements(["first", "second", "visible", "unexecuted"].map((name) => request(name, "find_library")), index);
    assert.deepEqual(result.bindings.map((binding) => binding.requirement.requestedName), ["first", "second", "visible"]);
    assert.deepEqual(result.unresolved.map((entry) => entry.requirement.requestedName), ["unexecuted"]);
    assert.equal(index.diagnostics.length, 0);
  }));

  test("same-sized conditional helper redefinitions remain local to each source context", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `project(Owner VERSION 1.0)
function(leaf NAME)
set_property(GLOBAL PROPERTY ignored TRUE)
endfunction()
function(child NAME)
leaf(\${NAME})
endfunction()
child(before)
if(ENABLE_EXPORT)
function(leaf NAME)
add_library(\${NAME} SHARED source.c)
install(TARGETS \${NAME})
endfunction()
endif()
child(\${VISIBLE})
child(\${VISIBLE})
`);
    const enabled = { ...owner("vendor", "Owner", "1.0"), contextKey: "enabled",
      variables: [["ENABLE_EXPORT", "ON"], ["VISIBLE", "present"]] };
    const disabled = { ...owner("vendor", "Owner", "1.0"), contextKey: "disabled",
      variables: [["ENABLE_EXPORT", "OFF"], ["VISIBLE", "absent"]] };
    disabled.component["bom-ref"] = "disabled@1.0";
    const index = collectNativeProviders([enabled, disabled], {
      scanRoot: root, nativeSourceManifests: [join(root, "vendor/CMakeLists.txt")],
    });
    const result = resolveNativeRequirements(["present", "absent", "before"].map((name) => request(name, "find_library")), index);
    assert.deepEqual(result.bindings.map((binding) => binding.requirement.requestedName), ["present"]);
    assert.deepEqual(result.bindings[0].providerRefs, ["vendor@1.0"]);
    assert.deepEqual(index.providers.find((provider) => provider.ref === "disabled@1.0").exports.filter((entry) => ["target", "library"].includes(entry.kind)), []);
    assert.equal(index.diagnostics.length, 0);
  }));

  test("recursive list consumption reaches its base case and stops at return", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `project(Owner VERSION 1.0)
function(flag_target input output)
set(\${output} flag_\${input} PARENT_SCOPE)
endfunction()
function(walk flags)
list(LENGTH flags count)
if(NOT \${count})
add_library(complete INTERFACE)
return()
add_library(unreachable INTERFACE)
endif()
list(GET flags 0 flag)
flag_target(\${flag} selected)
add_library(\${selected} INTERFACE)
list(REMOVE_AT flags 0)
walk("\${flags}")
endfunction()
walk("one;two;three")
`);
    const index = collectNativeProviders([owner("vendor", "Owner", "1.0")], {
      scanRoot: root, nativeSourceManifests: [join(root, "vendor/CMakeLists.txt")],
    });
    assert.deepEqual(index.providers[0].exports.filter((entry) => entry.kind === "target").map((entry) => entry.name).sort(), ["complete", "flag_one", "flag_three", "flag_two"]);
  }));

  test("list removal uses original positive and negative indices without duplicate shifts", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `project(Owner VERSION 1.0)
function(emit)
set(items a;b;c;d)
list(REMOVE_AT items 1 -1 1)
list(GET items 1 selected)
add_library(\${selected} INTERFACE)
endfunction()
emit()
`);
    const index = collectNativeProviders([owner("vendor", "Owner", "1.0")], {
      scanRoot: root, nativeSourceManifests: [join(root, "vendor/CMakeLists.txt")],
    });
    assert.deepEqual(index.providers[0].exports.filter((entry) => entry.kind === "target").map((entry) => entry.name), ["c"]);
  }));

  test("literal flag suffix predicates and replacements preserve concrete helper exports", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `project(Owner VERSION 1.0)
set(NO shadowed)
set(ONLY shadowed)
function(normalize input output mode)
if(\${input} MATCHES "__NO$")
string(REGEX REPLACE "__NO$" "" flag "\${input}")
set(\${output} \${flag} PARENT_SCOPE)
set(\${mode} "NO" PARENT_SCOPE)
elseif(\${input} MATCHES "__ONLY$")
string(REGEX REPLACE "__ONLY$" "" flag "\${input}")
set(\${output} \${flag} PARENT_SCOPE)
set(\${mode} "ONLY" PARENT_SCOPE)
else()
set(\${output} \${input} PARENT_SCOPE)
set(\${mode} "" PARENT_SCOPE)
endif()
endfunction()
function(emit input)
normalize(\${input} flag modifier)
if("\${modifier}" STREQUAL "NO")
add_library(disabled_\${flag} INTERFACE)
elseif("\${modifier}" STREQUAL "ONLY")
add_library(only_\${flag} INTERFACE)
else()
add_library(default_\${flag} INTERFACE)
endif()
endfunction()
emit(plain)
emit(skip__NO)
emit(need__ONLY)
`);
    const index = collectNativeProviders([owner("vendor", "Owner", "1.0")], {
      scanRoot: root, nativeSourceManifests: [join(root, "vendor/CMakeLists.txt")],
    });
    assert.deepEqual(index.providers[0].exports.filter((entry) => entry.kind === "target").map((entry) => entry.name), ["default_plain", "disabled_skip", "only_need"]);
  }));

  for (const [label, setup, condition] of [
    ["literal MATCHES pattern", 'set(foo "^bar$")', '"foo" MATCHES foo'],
    ["variable nonconstant zero spelling", "set(flag 00)", "flag"],
    ["expanded condition quotation", 'set(prefix "TRUE;AND;TRUE")\nset(v x)\nset(x x)', '${prefix} AND v STREQUAL "x"'],
  ]) {
    test(`${label} preserves the real export branch`, () => fixture(({ root, put, owner }) => {
      put("vendor/CMakeLists.txt", `project(Owner VERSION 1.0)
${setup}
if(${condition})
add_library(selected INTERFACE)
else()
add_library(rejected INTERFACE)
endif()
`);
      const index = collectNativeProviders([owner("vendor", "Owner", "1.0")], {
        scanRoot: root, nativeSourceManifests: [join(root, "vendor/CMakeLists.txt")],
      });
      assert.deepEqual(index.providers[0].exports.filter((entry) => entry.kind === "target").map((entry) => entry.name), ["selected"]);
    }));
  }

  test("policy-dependent repeated start replacements do not invent concrete targets", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `cmake_minimum_required(VERSION 3.20)
project(Owner VERSION 1.0)
string(REGEX REPLACE "^a" "b" ambiguous "aaaa")
add_library(\${ambiguous} INTERFACE)
string(REGEX REPLACE "^a" "b" stable "ac")
add_library(\${stable} INTERFACE)
`);
    const index = collectNativeProviders([owner("vendor", "Owner", "1.0")], {
      scanRoot: root, nativeSourceManifests: [join(root, "vendor/CMakeLists.txt")],
    });
    assert.deepEqual(index.providers[0].exports.filter((entry) => entry.kind === "target").map((entry) => entry.name), ["bc"]);
  }));

  test("conditional calls retain concrete helper outputs inside their guarded branch", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `project(Owner VERSION 1.0)
function(resolve_name input output)
set(\${output} \${input} PARENT_SCOPE)
endfunction()
if(UNKNOWN_CONFIG)
resolve_name(selected resolved)
add_library(\${resolved} INTERFACE)
endif()
add_library(\${resolved}_outside INTERFACE)
`);
    const index = collectNativeProviders([owner("vendor", "Owner", "1.0")], {
      scanRoot: root, nativeSourceManifests: [join(root, "vendor/CMakeLists.txt")],
    });
    const targets = index.providers[0].exports.filter((entry) => entry.kind === "target");
    assert.deepEqual(targets.map((entry) => entry.name), ["selected"]);
    assert(targets[0].conditions.includes("if(UNKNOWN_CONFIG)"));
  }));


  test("exact owner-input reuse preserves occurrence order, conditions, and isolated exports", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", "project(Owner VERSION 1.0)\nconfigure_package_config_file(input.in OwnerConfig.cmake)\nif(OPTION)\nadd_library(enabled INTERFACE)\nelse()\nadd_library(disabled INTERFACE)\nendif()");
    const makeFacts = () => [
      ["first", ["if(OPTION)"]], ["second", ["if(OPTION)/else()"]], ["third", []],
    ].map(([ref, conditions]) => {
      const fact = owner("vendor", "Owner", "1.0");
      return { ...fact, contextKey: ref, conditions, variables: [["OPTION", "$<unknown:OPTION>"]],
        component: { ...fact.component, "bom-ref": ref, purl: `pkg:github/example/owner-${ref}@1.0` } };
    });
    const inputs = { scanRoot: root, nativeSourceManifests: [join(root, "vendor/CMakeLists.txt")] };
    const index = collectNativeProviders(makeFacts(), inputs);
    assert.deepEqual(index, collectNativeProviders(makeFacts(), { ...inputs, nativeProviderContextReuse: false }));
    assert.deepEqual(index.providers.map((provider) => provider.ref), ["first", "second", "third"]);
    assert.deepEqual(index.providers.map((provider) => JSON.parse(provider.component.properties.find((entry) => entry.name === "cdx:native:packageIdentity").value).repository),
      ["https://github.com/example/owner-first", "https://github.com/example/owner-second", "https://github.com/example/owner-third"]);
    const targets = index.providers.map((provider) => provider.exports.filter((entry) => entry.kind === "target"));
    assert.deepEqual(targets.map((entries) => entries.map((entry) => entry.name)), [["enabled"], ["disabled"], ["enabled", "disabled"]]);
    assert.notEqual(targets[0][0], targets[2][0]);
    targets[0][0].conditions.push("caller-mutation");
    assert.ok(!targets[2][0].conditions.includes("caller-mutation"));
  }));

  test("owner-input reuse distinguishes absent, undefined, and empty variable bindings", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", "project(Owner VERSION 1.0)\nif(PRESENCE)\nadd_library(present INTERFACE)\nelse()\nadd_library(absent INTERFACE)\nendif()");
    const makeFacts = () => [[["PRESENCE", undefined]], [], [["PRESENCE", ""]], [["PRESENCE", undefined]]].map((variables, at) => {
      const fact = owner("vendor", "Owner", "1.0");
      return { ...fact, contextKey: `context-${at}`, variables, component: { ...fact.component, "bom-ref": `owner-${at}` } };
    });
    const inputs = { scanRoot: root, nativeSourceManifests: [join(root, "vendor/CMakeLists.txt")] };
    const index = collectNativeProviders(makeFacts(), inputs);
    assert.deepEqual(index, collectNativeProviders(makeFacts(), { ...inputs, nativeProviderContextReuse: false }));
    assert.deepEqual(index.providers.map((provider) => provider.exports.filter((entry) => entry.kind === "target").map((entry) => entry.name)),
      [["present"], ["present", "absent"], ["absent"], ["present"]]);
  }));

  test("owner-input reuse keeps scope-selected includes and revision-kind interfaces distinct", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", 'project(Owner)\ninclude(Select)\nwrite_basic_package_version_file(PublicConfigVersion.cmake VERSION "${PROJECT_VERSION}" COMPATIBILITY SameMajorVersion)');
    put("scope-a/Select.cmake", "add_library(selected_a INTERFACE)");
    put("scope-b/Select.cmake", "add_library(selected_b INTERFACE)");
    const makeFacts = () => [["a", "release"], ["b", "release"], ["a", "source-revision"], ["a", "release"]].map(([scope, kind], at) => {
      const fact = owner("vendor", "Owner", "1.2", kind);
      return { ...fact, contextKey: `context-${at}`, scopeDirectory: join(root, `scope-${scope}`), component: { ...fact.component, "bom-ref": `owner-${at}` } };
    });
    const inputs = { scanRoot: root, nativeSourceManifests: ["vendor/CMakeLists.txt", "scope-a/Select.cmake", "scope-b/Select.cmake"].map((file) => join(root, file)) };
    const index = collectNativeProviders(makeFacts(), inputs);
    assert.deepEqual(index, collectNativeProviders(makeFacts(), { ...inputs, nativeProviderContextReuse: false }));
    assert.deepEqual(index.providers.map((provider) => provider.exports.filter((entry) => entry.kind === "target").map((entry) => entry.name)),
      [["selected_a"], ["selected_b"], ["selected_a"], ["selected_a"]]);
    assert.ok(index.providers[0].exports.some((entry) => entry.name === "Public" && entry.interfaceVersion === "1.2"));
    assert.ok(index.providers[2].exports.some((entry) => entry.name === "Public" && entry.interfaceVersionUnknown));
  }));

  test("owner-input reuse distinguishes a contract context that skips the root project", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", "project(Owner VERSION 1.0)\nset(SEARCH_NAME from_root)");
    put("vendor/FindContract.cmake", "find_program(PROGRAM NAMES ${SEARCH_NAME})");
    const makeFacts = () => [false, true, false].map((contract, at) => {
      const fact = owner("vendor", "Owner", "1.0");
      return { ...fact, contextKey: `context-${at}`, variables: [["SEARCH_NAME", "from_seed"]],
        ...(contract ? { contractFiles: [{ file: join(root, "vendor/FindContract.cmake") }] } : {}),
        component: { ...fact.component, "bom-ref": `owner-${at}` } };
    });
    const inputs = { scanRoot: root, nativeSourceManifests: ["vendor/CMakeLists.txt", "vendor/FindContract.cmake"].map((file) => join(root, file)) };
    const index = collectNativeProviders(makeFacts(), inputs);
    assert.deepEqual(index, collectNativeProviders(makeFacts(), { ...inputs, nativeProviderContextReuse: false }));
    assert.deepEqual(index.providers.map((provider) => provider.ref), ["owner-0", "owner-2"]);
    assert.deepEqual(index.findModules.map((module) => module.programs), [["from_root"], ["from_seed"], ["from_root"]]);
  }));

  test("reused root state remains isolated from metadata definitions, targets, and interleaved owners", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", "project(Owner VERSION 1.0)\nadd_library(physical INTERFACE)\ninstall(TARGETS physical EXPORT Bundle)\nfunction(select_name)\nset(SEARCH_NAME root PARENT_SCOPE)\nendfunction()\ncmake_language(CALL ${UNKNOWN_COMMAND})");
    put("vendor/FindFirst.cmake", "install(EXPORT Bundle NAMESPACE Before::)\nset_target_properties(physical PROPERTIES EXPORT_NAME Changed)\nselect_name()\nfind_program(PROGRAM NAMES ${SEARCH_NAME})\nfunction(select_name)\nset(SEARCH_NAME changed PARENT_SCOPE)\nendfunction()\nfind_package_handle_standard_args(First REQUIRED_VARS PROGRAM)");
    put("vendor/FindSecond.cmake", "install(EXPORT Bundle NAMESPACE After::)\nselect_name()\nfind_program(PROGRAM NAMES ${SEARCH_NAME})\nfind_package_handle_standard_args(Second REQUIRED_VARS PROGRAM)");
    put("other/CMakeLists.txt", "project(Other VERSION 2.0)");
    put("other/FindOther.cmake", "find_program(OTHER_PROGRAM NAMES other)\nfind_package_handle_standard_args(Other REQUIRED_VARS OTHER_PROGRAM)");
    const makeFacts = () => [["vendor", "first"], ["other", "other"], ["vendor", "last"]].map(([directory, ref]) => {
      const fact = owner(directory, directory === "vendor" ? "Owner" : "Other", directory === "vendor" ? "1.0" : "2.0");
      return { ...fact, contextKey: ref, component: { ...fact.component, "bom-ref": ref } };
    });
    const inputs = { scanRoot: root, nativeSourceManifests: ["vendor/CMakeLists.txt", "vendor/FindFirst.cmake", "vendor/FindSecond.cmake", "other/CMakeLists.txt", "other/FindOther.cmake"].map((file) => join(root, file)) };
    const index = collectNativeProviders(makeFacts(), inputs);
    assert.deepEqual(index, collectNativeProviders(makeFacts(), { ...inputs, nativeProviderContextReuse: false }));
    assert.deepEqual(index.providers.map((provider) => provider.ref), ["first", "other", "last"]);
    assert.deepEqual(index.findModules.map((module) => module.programs), [["root"], ["changed"], ["other"], ["root"], ["changed"]]);
    for (const provider of [index.providers[0], index.providers[2]]) {
      assert.deepEqual(provider.exports.filter((entry) => entry.kind === "target").map((entry) => entry.name),
        ["physical", "Before::physical", "After::Changed"]);
    }
    assert.equal(index.diagnostics.filter((entry) => entry.reason === "dynamic-call-unknown").length, 2);
    assert.ok(index.localFindDefinitions.get("other").has(join(root, "other")));
    assert.notEqual(index.findModules[0], index.findModules[3]);
  }));

  test("boundary growth invalidates an otherwise identical root-evaluation snapshot", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", "project(Owner VERSION 1.0)\ninstall(DIRECTORY payload/ DESTINATION include FILES_MATCHING PATTERN *.h)\nadd_subdirectory(payload/child)");
    put("vendor/payload/child/CMakeLists.txt", "project(Child)");
    put("vendor/payload/child/api.h", "int api(void);");
    const makeFacts = () => [0, 1, 2].map((at) => {
      const fact = owner("vendor", "Owner", "1.0");
      return { ...fact, contextKey: `context-${at}`, component: { ...fact.component, "bom-ref": `owner-${at}` } };
    });
    const inputs = { scanRoot: root };
    const index = collectNativeProviders(makeFacts(), inputs);
    assert.deepEqual(index, collectNativeProviders(makeFacts(), { ...inputs, nativeProviderContextReuse: false }));
    assert.deepEqual(index.providers.map((provider) => provider.exports.some((entry) => entry.kind === "header-file" && entry.name === "api.h")),
      [true, false, false]);
  }));

  test("repeated owner contexts preserve staged transforms without duplicating global effects", () => stagedFixture(({ root, owner, component }) => {
    const makeFacts = () => [0, 1, 2].map((at) => {
      const fact = owner("stage", "Stage", "99.0");
      return { ...fact, contextKey: `stage-${at}`, component: { ...fact.component, "bom-ref": `stage-${at}` } };
    });
    const inputs = { scanRoot: root, availableProviders: [component] };
    const index = collectNativeProviders(makeFacts(), inputs);
    assert.deepEqual(index, collectNativeProviders(makeFacts(), { ...inputs, nativeProviderContextReuse: false }));
    assert.deepEqual(index.providers.slice(0, 3).map((provider) => provider.ref), ["stage-0", "stage-1", "stage-2"]);
    assert.equal(index.providers.find((provider) => provider.ref === "owner").exports.filter((entry) => entry.name === "staged_api").length, 1);
  }));

  for (const [label, body, expected] of [
    ["changed caller reads", `function(select_name)
set(RESULT \${INPUT} PARENT_SCOPE)
endfunction()
set(INPUT first)
select_name()
select_name()
set(INPUT second)
select_name()
add_library(\${RESULT} INTERFACE)`, ["second"]],
    ["absent versus empty bindings", `function(select_name)
set(RESULT prefix\${INPUT} PARENT_SCOPE)
endfunction()
select_name()
select_name()
set(INPUT "")
select_name()
add_library(\${RESULT} INTERFACE)`, ["prefix"]],
    ["fresh child reads after an enclosing provider effect", `function(leaf)
set(RESULT \${INPUT} PARENT_SCOPE)
endfunction()
function(select_name)
add_library(physical INTERFACE)
leaf()
leaf()
set(RESULT \${RESULT} PARENT_SCOPE)
endfunction()
set(INPUT first)
select_name()
add_library(\${RESULT} INTERFACE)
set(INPUT second)
select_name()
add_library(\${RESULT} INTERFACE)`, ["physical", "first", "second"]],
    ["winning child-summary reads in a pure enclosing helper", `function(leaf)
set(RESULT \${INPUT} PARENT_SCOPE)
endfunction()
function(select_name)
leaf()
set(RESULT \${RESULT} PARENT_SCOPE)
endfunction()
function(warm_name)
leaf()
endfunction()
set(INPUT first)
warm_name()
select_name()
select_name()
set(INPUT second)
select_name()
add_library(\${RESULT} INTERFACE)`, ["second"]],
    ["unrelated caller changes versus genuinely read merged inputs", `function(select_name)
if(UNKNOWN_BRANCH)
set(LOCAL left)
else()
set(LOCAL right)
endif()
set(IGNORED \${LOCAL} PARENT_SCOPE)
set(RESULT \${INPUT} PARENT_SCOPE)
endfunction()
set(INPUT first)
set(UNRELATED before)
select_name()
set(UNRELATED after)
select_name()
set(INPUT second)
select_name()
add_library(\${RESULT} INTERFACE)`, ["second"]],
    ["equal branch input becoming divergent", `function(select_name)
if(UNKNOWN_BRANCH)
set(MERGED chosen)
endif()
set(RESULT \${MERGED} PARENT_SCOPE)
endfunction()
set(MERGED chosen)
select_name()
select_name()
set(MERGED other)
select_name()
add_library(\${RESULT} INTERFACE)
add_library(preserved INTERFACE)`, ["preserved"]],
    ["divergent branch input becoming equal", `function(select_name)
if(UNKNOWN_BRANCH)
set(MERGED chosen)
endif()
set(RESULT \${MERGED} PARENT_SCOPE)
endfunction()
set(MERGED other)
select_name()
select_name()
set(MERGED chosen)
select_name()
add_library(\${RESULT} INTERFACE)`, ["chosen"]],
    ["absent versus empty input after a merge", `function(select_name)
if(UNKNOWN_BRANCH)
set(LOCAL left)
else()
set(LOCAL right)
endif()
set(IGNORED \${LOCAL} PARENT_SCOPE)
set(RESULT prefix\${INPUT} PARENT_SCOPE)
endfunction()
select_name()
select_name()
set(INPUT "")
select_name()
add_library(\${RESULT} INTERFACE)`, ["prefix"]],
    ["restored inherited input after an inactive branch", `function(select_name)
if(FALSE)
set(INPUT changed)
else()
set(RESULT \${INPUT} PARENT_SCOPE)
endif()
endfunction()
set(INPUT first)
select_name()
set(INPUT second)
select_name()
add_library(\${RESULT} INTERFACE)`, ["second"]],
    ["changed transitive definitions", `function(leaf)
set(RESULT first PARENT_SCOPE)
endfunction()
function(select_name)
leaf()
set(RESULT \${RESULT} PARENT_SCOPE)
endfunction()
select_name()
select_name()
function(leaf)
set(RESULT second PARENT_SCOPE)
endfunction()
select_name()
add_library(\${RESULT} INTERFACE)`, ["second"]],
    ["conditional parent writes", `function(select_name)
if(FLAG)
set(RESULT guarded PARENT_SCOPE)
endif()
endfunction()
set(FLAG TRUE)
select_name()
select_name()
set(FLAG FALSE)
set(RESULT retained)
select_name()
add_library(\${RESULT} INTERFACE)`, ["retained"]],
    ["returned parent deletions", `function(select_name)
unset(RESULT PARENT_SCOPE)
endfunction()
set(RESULT stale)
select_name()
set(RESULT stale_again)
select_name()
add_library(\${RESULT} INTERFACE)
add_library(preserved INTERFACE)`, ["preserved"]],
    ["nested return propagation", `function(select_name)
block()
set(RESULT returned)
return(PROPAGATE RESULT)
endblock()
endfunction()
select_name()
unset(RESULT)
select_name()
add_library(\${RESULT} INTERFACE)`, ["returned"]],
    ["changed actual arguments", `function(select_name input)
set(RESULT \${input} PARENT_SCOPE)
endfunction()
select_name(first)
select_name(first)
select_name(second)
add_library(\${RESULT} INTERFACE)`, ["second"]],
    ["CPM-style unknown arguments without suffix recovery", `function(select_name)
list(LENGTH ARGN count)
if(count EQUAL 1)
set(ARGN \${UNKNOWN_SHORTHAND})
endif()
cmake_parse_arguments(P "" "NAME;SOURCE_DIR" "" \${ARGN})
set(RESULT \${P_NAME} PARENT_SCOPE)
endfunction()
select_name(NAME tempting SOURCE_DIR \${UNKNOWN_SOURCE})
select_name(NAME tempting SOURCE_DIR \${UNKNOWN_SOURCE})
add_library(\${RESULT} INTERFACE)
select_name(NAME concrete SOURCE_DIR known)
add_library(\${RESULT} INTERFACE)`, ["concrete"]],
    ["branch restoration of inherited reads", `function(select_name)
if(UNKNOWN_BRANCH)
set(INPUT changed)
else()
set(RESULT \${INPUT} PARENT_SCOPE)
endif()
endfunction()
set(INPUT first)
select_name()
select_name()
set(INPUT second)
select_name()
add_library(\${RESULT} INTERFACE)
add_library(preserved INTERFACE)`, ["preserved"]],
    ["macro substitutions within ordinary functions", `macro(assign_result value)
set(RESULT \${value} PARENT_SCOPE)
endmacro()
function(select_name input)
assign_result(\${input})
endfunction()
select_name(captured)
select_name(captured)
set(value changed)
select_name(captured)
add_library(\${RESULT} INTERFACE)`, ["captured"]],
    ["intervening target and generated-file mutations", `function(select_name)
set(RESULT restored PARENT_SCOPE)
set_target_properties(physical PROPERTIES OUTPUT_NAME restored)
set(VERSION_TEXT 1.2.3 PARENT_SCOPE)
endfunction()
add_library(physical SHARED lib.c)
select_name()
select_name()
file(WRITE \${CMAKE_CURRENT_BINARY_DIR}/version "\${VERSION_TEXT}")
set_target_properties(physical PROPERTIES OUTPUT_NAME intervening)
set(VERSION_TEXT 9.8.7)
file(WRITE \${CMAKE_CURRENT_BINARY_DIR}/version "\${VERSION_TEXT}")
select_name()
file(WRITE \${CMAKE_CURRENT_BINARY_DIR}/version "\${VERSION_TEXT}")
install(TARGETS physical)
install(FILES \${CMAKE_CURRENT_BINARY_DIR}/version DESTINATION .info)
add_library(\${RESULT} INTERFACE)`, ["physical", "restored"]],
    ["effectful helpers never replay only their parent writes", `function(select_name)
set(RESULT \${INPUT} PARENT_SCOPE)
add_library(\${INPUT} INTERFACE)
file(WRITE \${CMAKE_CURRENT_BINARY_DIR}/\${INPUT}Config.cmake "set(found TRUE)")
endfunction()
set(INPUT first)
select_name()
select_name()
set(INPUT second)
select_name()
install(FILES \${CMAKE_CURRENT_BINARY_DIR}/secondConfig.cmake DESTINATION lib/cmake)`, ["first", "second"]],
    ["diagnostics from every invocation", `function(select_name)
cmake_language(CALL \${UNKNOWN_COMMAND})
set(RESULT preserved PARENT_SCOPE)
endfunction()
select_name()
select_name()
add_library(\${RESULT} INTERFACE)`, ["preserved"]],
  ]) test(`ordinary-function summaries preserve ${label}`, () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `project(Owner VERSION 1.0)\n${body}\n`);
    const inputs = { scanRoot: root, nativeSourceManifests: [join(root, "vendor/CMakeLists.txt")] };
    const facts = [owner("vendor", "Owner", "1.0")];
    const index = collectNativeProviders(facts, inputs);
    const uncached = collectNativeProviders(facts, { ...inputs, nativeProviderMemoization: false });
    assert.deepEqual(index, uncached, "complete provider graph and diagnostics must match");
    assert.deepEqual(index.providers[0].exports.filter((entry) => entry.kind === "target").map((entry) => entry.name), expected);
    if (label === "intervening target and generated-file mutations") {
      assert.ok(index.providers[0].exports.some((entry) => entry.kind === "library" && entry.name === "restored"));
      assert.ok(!index.providers[0].exports.some((entry) => entry.kind === "library" && entry.name === "intervening"));
      assert.ok(index.providers[0].exports.some((entry) => entry.kind === "data-file" && entry.generatedVersion === "1.2.3"));
    }
    if (label === "diagnostics from every invocation") {
      assert.equal(index.diagnostics.filter((entry) => entry.reason === "dynamic-call-unknown").length, 2);
    }
  }));

  test("unchanged undefined merge bindings retain cleanup and input-presence dependencies", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `project(Owner VERSION 1.0)
function(select_name)
if(UNKNOWN_BRANCH)
set(LOCAL left)
else()
set(LOCAL right)
endif()
set(IGNORED \${LOCAL} PARENT_SCOPE)
if(UNDEFINED)
set(RESULT present PARENT_SCOPE)
else()
set(RESULT absent PARENT_SCOPE)
endif()
endfunction()
select_name()
add_library(\${RESULT} INTERFACE)
set(UNDEFINED TRUE)
select_name()
add_library(\${RESULT} INTERFACE)
add_library(preserved INTERFACE)
`);
    const makeFacts = () => [{ ...owner("vendor", "Owner", "1.0"), variables: [["UNDEFINED", undefined]] }];
    const inputs = { scanRoot: root, nativeSourceManifests: [join(root, "vendor/CMakeLists.txt")] };
    const index = collectNativeProviders(makeFacts(), inputs);
    assert.deepEqual(index, collectNativeProviders(makeFacts(), { ...inputs, nativeProviderMemoization: false }));
    assert.deepEqual(index.providers[0].exports.filter((entry) => entry.kind === "target").map((entry) => entry.name), ["present", "preserved"]);
  }));

  test("summary generation resets preserve command costs at the unindexed budget boundary", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `project(Owner VERSION 1.0)
function(select_name)
set(RESULT selected PARENT_SCOPE)
${"set(RESULT selected PARENT_SCOPE)\n".repeat(96)}
endfunction()
${"select_name()\n".repeat(400)}
function(new_definition)
set(UNUSED marker PARENT_SCOPE)
endfunction()
${"select_name()\n".repeat(500)}
add_library(after_budget INTERFACE)
`);
    const facts = [owner("vendor", "Owner", "1.0")];
    const inputs = { scanRoot: root };
    const index = collectNativeProviders(facts, inputs);
    assert.deepEqual(index, collectNativeProviders(facts, { ...inputs, nativeProviderMemoization: false }));
    assert.ok(index.diagnostics.some((entry) => entry.reason === "command-budget"));
    assert.ok(!index.providers[0].exports.some((entry) => entry.name === "after_budget"));
  }));

  test("ordinary-function summary storage limits never truncate later source analysis", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `project(Owner VERSION 1.0)
${Array.from({ length: 33 }, (_, index) => `function(select_${index} input)\nset(RESULT \${input} PARENT_SCOPE)\nendfunction()`).join("\n")}
${Array.from({ length: 33 }, (_, index) => Array.from({ length: 65 }, (_, value) => `select_${index}(value_${value})`).join("\n")).join("\n")}
add_library(\${RESULT} INTERFACE)
`);
    const facts = [owner("vendor", "Owner", "1.0")];
    const inputs = { scanRoot: root, nativeSourceManifests: [join(root, "vendor/CMakeLists.txt")] };
    const index = collectNativeProviders(facts, inputs);
    assert.deepEqual(index, collectNativeProviders(facts, { ...inputs, nativeProviderMemoization: false }));
    assert.deepEqual(index.providers[0].exports.filter((entry) => entry.kind === "target").map((entry) => entry.name), ["value_64"]);
  }));

  test("definition changes after cache pressure preserve new helper results and complete analysis", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `project(Owner VERSION 1.0)
function(leaf)
set(RESULT before PARENT_SCOPE)
endfunction()
function(select_name)
leaf()
set(RESULT \${RESULT} PARENT_SCOPE)
endfunction()
${Array.from({ length: 33 }, (_, index) => `function(pressure_${index} input)\nset(PRESSURE \${input} PARENT_SCOPE)\nendfunction()`).join("\n")}
select_name()
${Array.from({ length: 33 }, (_, index) => Array.from({ length: 64 }, (_, value) => `pressure_${index}(value_${value})`).join("\n")).join("\n")}
function(leaf)
set(RESULT after PARENT_SCOPE)
endfunction()
select_name()
select_name()
add_library(\${RESULT} INTERFACE)
`);
    const makeFacts = () => [owner("vendor", "Owner", "1.0")];
    const inputs = { scanRoot: root, nativeSourceManifests: [join(root, "vendor/CMakeLists.txt")] };
    const index = collectNativeProviders(makeFacts(), inputs);
    assert.deepEqual(index, collectNativeProviders(makeFacts(), { ...inputs, nativeProviderMemoization: false }));
    assert.deepEqual(index.providers[0].exports.filter((entry) => entry.kind === "target").map((entry) => entry.name), ["after"]);
  }));

  test("ordinary finder no-ops do not suppress active Find-module observations", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `project(Owner VERSION 1.0)
function(locate_patch)
find_program(PATCH_EXECUTABLE NAMES patch)
set(RESULT ready PARENT_SCOPE)
endfunction()
locate_patch()
locate_patch()
add_library(\${RESULT} INTERFACE)
`);
    put("vendor/cmake/FindPatch.cmake", "locate_patch()\nlocate_patch()\nfind_package_handle_standard_args(Patch REQUIRED_VARS PATCH_EXECUTABLE)");
    const inputs = { scanRoot: root, nativeSourceManifests: ["vendor/CMakeLists.txt", "vendor/cmake/FindPatch.cmake"].map((file) => join(root, file)) };
    const facts = [owner("vendor", "Owner", "1.0")];
    const index = collectNativeProviders(facts, inputs);
    assert.deepEqual(index, collectNativeProviders(facts, { ...inputs, nativeProviderMemoization: false }));
    assert.deepEqual(index.providers[0].exports.filter((entry) => entry.kind === "target").map((entry) => entry.name), ["ready"]);
    assert.equal(index.findModules.length, 2);
    assert.ok(index.findModules.every((entry) => entry.name === "Patch" && entry.moduleFile === join(root, "vendor/cmake/FindPatch.cmake") &&
      entry.destination === "PATCH_EXECUTABLE" && entry.programs.join(";") === "patch"));
    assert.notDeepEqual(index.findModules[0].conditions, index.findModules[1].conditions, "each call retains its observation provenance");
  }));

  test("unbalanced helper slices cannot memoize shared branch-stack mutations", () => fixture(({ root, put, owner }) => {
    // Deliberately malformed nesting makes the existing slice evaluate a stray
    // endif inside foreach. Preserve the reader's uncached observable result;
    // this is not a claim that a real CMake configure accepts the source.
    put("vendor/CMakeLists.txt", `project(Owner VERSION 1.0)
add_library(physical SHARED lib.c)
function(unbalanced)
if(TRUE)
foreach(item IN ITEMS one)
set(RESULT stable PARENT_SCOPE)
endif()
endfunction()
if(FLAG)
unbalanced()
endif()
if(FLAG)
unbalanced()
set_target_properties(physical PROPERTIES OUTPUT_NAME inside)
endif()
install(TARGETS physical)
`);
    const facts = [owner("vendor", "Owner", "1.0")];
    const inputs = { scanRoot: root, nativeSourceManifests: [join(root, "vendor/CMakeLists.txt")] };
    const index = collectNativeProviders(facts, inputs);
    assert.deepEqual(index, collectNativeProviders(facts, { ...inputs, nativeProviderMemoization: false }));
    assert.ok(index.providers[0].exports.some((entry) => entry.kind === "library" && entry.name === "inside"));
    assert.ok(!index.providers[0].exports.some((entry) => entry.kind === "library" && entry.name === "physical"));
  }));

  test("a stray endif cannot warm a reusable summary against an empty caller stack", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `project(Owner VERSION 1.0)
add_library(physical SHARED lib.c)
function(unbalanced)
if(TRUE)
foreach(item IN ITEMS one)
set(RESULT stable PARENT_SCOPE)
endif()
endfunction()
foreach(item IN ITEMS \${UNKNOWN})
unbalanced()
endforeach()
if(UNKNOWN_FLAG)
foreach(item IN ITEMS one)
unbalanced()
set_target_properties(physical PROPERTIES OUTPUT_NAME inside)
endforeach()
endif()
install(TARGETS physical)
`);
    const facts = [owner("vendor", "Owner", "1.0")];
    const inputs = { scanRoot: root, nativeSourceManifests: [join(root, "vendor/CMakeLists.txt")] };
    const index = collectNativeProviders(facts, inputs);
    assert.deepEqual(index, collectNativeProviders(facts, { ...inputs, nativeProviderMemoization: false }));
    assert.ok(index.providers[0].exports.some((entry) => entry.kind === "library" && entry.name === "inside"));
    assert.ok(!index.providers[0].exports.some((entry) => entry.kind === "library" && entry.name === "physical"));
  }));

  test("repeated keywords preserve missing single values and append multi-values", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `project(Owner VERSION 1.0)
cmake_parse_arguments(P "" "NAME;FORCE" "ALIASES" NAME retained NAME "" NAME FORCE TRUE ALIASES before ALIASES after)
add_library(\${P_NAME} INTERFACE)
foreach(alias IN LISTS P_ALIASES)
add_library(\${alias} INTERFACE)
endforeach()
`);
    const index = collectNativeProviders([owner("vendor", "Owner", "1.0")], {
      scanRoot: root, nativeSourceManifests: [join(root, "vendor/CMakeLists.txt")],
    });
    assert.deepEqual(index.providers[0].exports.filter((entry) => entry.kind === "target").map((entry) => entry.name), ["retained", "before", "after"]);
  }));

  test("argument-free macros preserve the caller function argument list", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `project(Owner VERSION 1.0)
macro(configure_policy)
set(POLICY_READY TRUE PARENT_SCOPE)
endmacro()
function(emit)
configure_policy()
cmake_parse_arguments(P "" "NAME" "" \${ARGN})
add_library(\${P_NAME} INTERFACE)
endfunction()
emit(NAME preserved)
`);
    const index = collectNativeProviders([owner("vendor", "Owner", "1.0")], {
      scanRoot: root, nativeSourceManifests: [join(root, "vendor/CMakeLists.txt")],
    });
    assert.deepEqual(index.providers[0].exports.filter((entry) => entry.kind === "target").map((entry) => entry.name), ["preserved"]);
  }));

  test("indirect variable references inside macros read real caller variables", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `project(Owner VERSION 1.0)
set(selector value)
macro(emit value)
set(value changed)
add_library(\${value} INTERFACE)
add_library(\${\${selector}} INTERFACE)
endmacro()
emit(argument)
`);
    const index = collectNativeProviders([owner("vendor", "Owner", "1.0")], {
      scanRoot: root, nativeSourceManifests: [join(root, "vendor/CMakeLists.txt")],
    });
    assert.deepEqual(index.providers[0].exports.filter((entry) => entry.kind === "target").map((entry) => entry.name), ["argument", "changed"]);
  }));

  test("macro parameters substitute without replacing caller variables or deferred definitions", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `project(Owner VERSION 1.0)
set(value original)
macro(emit value)
set(value changed)
block()
add_library(\${value} INTERFACE)
endblock()
endmacro()
emit(argument)
add_library(\${value} INTERFACE)
macro(define_saved saved_name)
function(saved)
add_library(\${saved_name} INTERFACE)
endfunction()
endmacro()
define_saved(captured)
set(saved_name later)
saved()
`);
    const index = collectNativeProviders([owner("vendor", "Owner", "1.0")], {
      scanRoot: root, nativeSourceManifests: [join(root, "vendor/CMakeLists.txt")],
    });
    assert.deepEqual(index.providers[0].exports.filter((entry) => entry.kind === "target").map((entry) => entry.name), ["argument", "changed", "captured"]);
  }));

  test("dynamic helper calls create the called provider rather than an uninvoked template", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `project(Owner VERSION 1.0)
function(make_target NAME)
add_library(\${NAME} INTERFACE)
endfunction()
function(dispatch NAME MAKER)
cmake_language(CALL \${MAKER} \${NAME})
endfunction()
dispatch(visible make_target)
dispatch(unknown \${MISSING_MAKER})
`);
    const index = collectNativeProviders([owner("vendor", "Owner", "1.0")], {
      scanRoot: root, nativeSourceManifests: [join(root, "vendor/CMakeLists.txt")],
    });
    assert.deepEqual(index.providers[0].exports.filter((entry) => entry.kind === "target").map((entry) => entry.name), ["visible"]);
  }));

  test("quoted argument forwarding still obeys cmake_parse_arguments list semantics", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `project(Owner VERSION 1.0)
function(emit)
cmake_parse_arguments(P "" "NAME" "" "\${ARGN}")
add_library(\${P_NAME} INTERFACE)
endfunction()
emit(NAME visible)
`);
    const index = collectNativeProviders([owner("vendor", "Owner", "1.0")], {
      scanRoot: root, nativeSourceManifests: [join(root, "vendor/CMakeLists.txt")],
    });
    assert.deepEqual(index.providers[0].exports.filter((entry) => entry.kind === "target").map((entry) => entry.name), ["visible"]);
  }));

  test("a returned branch cannot lend its local target name to a surviving path", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `project(Owner VERSION 1.0)
function(emit)
if(STOP_EARLY)
set(LOCAL_TARGET leaked)
return()
endif()
add_library(\${LOCAL_TARGET} INTERFACE)
endfunction()
emit()
add_library(visible INTERFACE)
`);
    const index = collectNativeProviders([owner("vendor", "Owner", "1.0")], {
      scanRoot: root, nativeSourceManifests: [join(root, "vendor/CMakeLists.txt")],
    });
    assert.deepEqual(index.providers[0].exports.filter((entry) => entry.kind === "target").map((entry) => entry.name), ["visible"]);
  }));

  test("an empty or possibly empty list cannot force a foreach return", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `project(Owner VERSION 1.0)
foreach(item IN LISTS items)
return()
endforeach()
add_library(visible INTERFACE)
`);
    const empty = { ...owner("vendor", "Owner", "1.0"), contextKey: "empty", variables: [["items", ""]] };
    const unknown = { ...owner("vendor", "Owner", "1.0"), contextKey: "unknown" };
    unknown.component["bom-ref"] = "unknown@1.0";
    const index = collectNativeProviders([empty, unknown], {
      scanRoot: root, nativeSourceManifests: [join(root, "vendor/CMakeLists.txt")],
    });
    for (const ref of ["vendor@1.0", "unknown@1.0"]) {
      assert.deepEqual(index.providers.find((provider) => provider.ref === ref).exports.filter((entry) => entry.kind === "target").map((entry) => entry.name), ["visible"]);
    }
  }));

  test("conditional block returns retain their guard after an enclosing branch", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `project(Owner VERSION 1.0)
if(TRUE)
block()
if(STOP)
return()
endif()
endblock()
else()
endif()
add_library(tail INTERFACE)
`);
    const index = collectNativeProviders([owner("vendor", "Owner", "1.0")], {
      scanRoot: root, nativeSourceManifests: [join(root, "vendor/CMakeLists.txt")],
    });
    const target = index.providers[0].exports.find((entry) => entry.kind === "target" && entry.name === "tail");
    assert.ok(target.conditions.some((guard) => guard.includes("STOP")));
  }));

  test("included-file returns rejoin variable alternatives at the caller", () => fixture(({ root, put, owner }) => {
    put("vendor/select.cmake", `if(STOP)
set(NAME early)
return()
else()
set(NAME late)
endif()
`);
    put("vendor/CMakeLists.txt", `project(Owner VERSION 1.0)
set(NAME original)
include(select.cmake)
add_library(\${NAME} INTERFACE)
add_library(visible INTERFACE)
`);
    const index = collectNativeProviders([owner("vendor", "Owner", "1.0")], {
      scanRoot: root, nativeSourceManifests: [join(root, "vendor/CMakeLists.txt"), join(root, "vendor/select.cmake")],
    });
    assert.deepEqual(index.providers[0].exports.filter((entry) => entry.kind === "target").map((entry) => entry.name), ["visible"]);
  }));

  test("returned foreach states restore the iterator but preserve other included-file writes", () => fixture(({ root, put, owner }) => {
    put("vendor/select.cmake", `foreach(item IN ITEMS leaked)
set(RESULT observed)
return()
endforeach()
`);
    put("vendor/CMakeLists.txt", `project(Owner VERSION 1.0)
set(item outer)
include(select.cmake)
add_library(\${item} INTERFACE)
add_library(\${RESULT} INTERFACE)
unset(item)
include(select.cmake)
add_library(missing_\${item} INTERFACE)
`);
    const index = collectNativeProviders([owner("vendor", "Owner", "1.0")], {
      scanRoot: root, nativeSourceManifests: [join(root, "vendor/CMakeLists.txt"), join(root, "vendor/select.cmake")],
    });
    assert.deepEqual(index.providers[0].exports.filter((entry) => entry.kind === "target").map((entry) => entry.name), ["outer", "observed"]);
  }));

  test("disjunctive return continuations cannot export through a terminated owner path", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `project(Owner VERSION 1.0)
if(STOP)
return()
elseif(OTHER)
else()
endif()
add_library(tail INTERFACE)
`);
    const stopped = { ...owner("vendor", "Owner", "1.0"), contextKey: "stopped", conditions: ["if(STOP)"] };
    const continuing = { ...owner("vendor", "Owner", "1.0"), contextKey: "continuing", conditions: ["if(STOP)/elseif(OTHER)"] };
    continuing.component["bom-ref"] = "continuing@1.0";
    const index = collectNativeProviders([stopped, continuing], {
      scanRoot: root, nativeSourceManifests: [join(root, "vendor/CMakeLists.txt")],
    });
    assert.deepEqual(index.providers.find((provider) => provider.ref === "vendor@1.0").exports.filter((entry) => entry.kind === "target"), []);
    assert.deepEqual(index.providers.find((provider) => provider.ref === "continuing@1.0").exports.filter((entry) => entry.kind === "target").map((entry) => entry.name), ["tail"]);
  }));

  test("return PROPAGATE retains producers and bypasses nested block scopes", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `project(Owner VERSION 1.0)
function(direct)
set(NAME direct)
return(PROPAGATE NAME)
endfunction()
direct()
add_library(direct_\${NAME} INTERFACE)
function(blocked)
block()
block()
set(NAME visible)
add_library(inside INTERFACE)
return(PROPAGATE NAME)
endblock()
endblock()
endfunction()
blocked()
add_library(caller_\${NAME} INTERFACE)
`);
    const index = collectNativeProviders([owner("vendor", "Owner", "1.0")], {
      scanRoot: root, nativeSourceManifests: [join(root, "vendor/CMakeLists.txt")],
    });
    assert.deepEqual(index.providers[0].exports.filter((entry) => entry.kind === "target").map((entry) => entry.name), ["direct_direct", "inside", "caller_visible"]);
  }));

  test("a surviving conditional return path cannot overwrite uncertain parent output", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `project(Owner VERSION 1.0)
function(select)
if(STOP)
set(NAME early PARENT_SCOPE)
return()
endif()
set(NAME late PARENT_SCOPE)
endfunction()
select()
add_library(\${NAME} INTERFACE)
add_library(visible INTERFACE)
`);
    const index = collectNativeProviders([owner("vendor", "Owner", "1.0")], {
      scanRoot: root, nativeSourceManifests: [join(root, "vendor/CMakeLists.txt")],
    });
    assert.deepEqual(index.providers[0].exports.filter((entry) => entry.kind === "target").map((entry) => entry.name), ["visible"]);
  }));

  test("conditional helper returns preserve only reachable continuations without leaking guards", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `project(Owner VERSION 1.0)
function(emit NAME)
if(STOP_EARLY)
return()
endif()
add_library(\${NAME} INTERFACE)
endfunction()
emit(\${LABEL})
add_library(tail_\${LABEL} INTERFACE)
`);
    const facts = [["on", "ON"], ["off", "OFF"], ["unknown", undefined]].map(([label, stop]) => {
      const fact = { ...owner("vendor", "Owner", "1.0"), contextKey: label,
        variables: [["LABEL", label], ...(stop === undefined ? [] : [["STOP_EARLY", stop]])] };
      fact.component["bom-ref"] = `${label}@1.0`;
      return fact;
    });
    const index = collectNativeProviders(facts, {
      scanRoot: root, nativeSourceManifests: [join(root, "vendor/CMakeLists.txt")],
    });
    const targets = (ref) => index.providers.find((provider) => provider.ref === ref).exports.filter((entry) => entry.kind === "target");
    assert.deepEqual(targets("on@1.0").map((entry) => entry.name), ["tail_on"]);
    assert.deepEqual(targets("off@1.0").map((entry) => entry.name), ["off", "tail_off"]);
    assert.deepEqual(targets("unknown@1.0").map((entry) => entry.name), ["unknown", "tail_unknown"]);
    assert.ok(targets("unknown@1.0").find((entry) => entry.name === "unknown").conditions.some((guard) => guard.includes("STOP_EARLY")));
    assert.deepEqual(targets("unknown@1.0").find((entry) => entry.name === "tail_unknown").conditions, []);
  }));

  test("return from a macro inside a loop exits its function but not the caller", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `project(Owner VERSION 1.0)
macro(stop)
return()
endmacro()
function(outer)
foreach(item IN ITEMS one two)
stop()
add_library(unreachable_loop INTERFACE)
endforeach()
add_library(unreachable_function INTERFACE)
endfunction()
outer()
add_library(visible INTERFACE)
`);
    const index = collectNativeProviders([owner("vendor", "Owner", "1.0")], {
      scanRoot: root, nativeSourceManifests: [join(root, "vendor/CMakeLists.txt")],
    });
    assert.deepEqual(index.providers[0].exports.filter((entry) => entry.kind === "target").map((entry) => entry.name), ["visible"]);
  }));

  test("unindexed recursive helper analysis retains its existing command-budget diagnostics", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `project(Owner VERSION 1.0)
function(no_effect)
set_property(GLOBAL PROPERTY ignored TRUE)
no_effect()
no_effect()
endfunction()
no_effect()
`);
    const index = collectNativeProviders([owner("vendor", "Owner", "1.0")], { scanRoot: root });
    assert.ok(index.diagnostics.some((entry) => entry.reason === "command-budget"));
  }));

  test("mutually recursive helpers retain an export reached through an off-cycle helper", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `project(Owner VERSION 1.0)
function(left)
right()
endfunction()
function(right)
left()
emit()
endfunction()
function(emit)
add_library(visible SHARED visible.c)
install(TARGETS visible)
endfunction()
left()
`);
    const index = collectNativeProviders([owner("vendor", "Owner", "1.0")], {
      scanRoot: root, nativeSourceManifests: [join(root, "vendor/CMakeLists.txt")],
    });
    const result = resolveNativeRequirements([request("visible", "find_library")], index);
    assert.equal(result.bindings.length, 1);
    assert.deepEqual(result.bindings[0].providerRefs, ["vendor@1.0"]);
    assert.equal(result.unresolved.length, 0);
  }));

  test("indexed oversized helper slices retain their command-budget diagnostic", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `project(Owner VERSION 1.0)
function(oversized)
${"set_property(GLOBAL)\n".repeat(20002)}
endfunction()
oversized()
`);
    const index = collectNativeProviders([owner("vendor", "Owner", "1.0")], {
      scanRoot: root, nativeSourceManifests: [join(root, "vendor/CMakeLists.txt")],
    });
    assert.ok(index.diagnostics.some((entry) => entry.reason === "command-budget"));
  }));

  test("a locally defined no-op command name can still expose real provider effects", () => fixture(({ root, put, owner }) => {
    put("vendor/CMakeLists.txt", `project(Owner VERSION 1.0)
function(message)
add_library(visible SHARED visible.c)
install(TARGETS visible)
endfunction()
function(wrapper)
message()
endfunction()
wrapper()
`);
    const index = collectNativeProviders([owner("vendor", "Owner", "1.0")], {
      scanRoot: root, nativeSourceManifests: [join(root, "vendor/CMakeLists.txt")],
    });
    const result = resolveNativeRequirements([request("visible", "find_library")], index);
    assert.equal(result.bindings.length, 1);
    assert.deepEqual(result.bindings[0].providerRefs, ["vendor@1.0"]);
  }));
});
