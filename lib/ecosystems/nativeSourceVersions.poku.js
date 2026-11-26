import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { strict as assert, describe, test } from "poku";

import { preferFetchedCmakeDependencies } from "./cmakeResolver.js";
import { bindNativeObservedProvider, nativeInstalledLibraryObserver } from "./nativeExternalMetadata.js";
import { cmakeProjectDetails, reconcileCmakeSourceProjects, reconcileNativeSourceProviders } from "./nativeSourceVersions.js";
import { parseCmakeLikeFile } from "./parsers-misc.js";
import { parseCmakeCommands } from "../parsers/cmakeLists.js";
import { nativeSourceCacheKey } from "../inventory/nativeSourceIdentity.js";

function withCmake(text, run) {
  const dir = mkdtempSync(join(tmpdir(), "cdxgen-source-version-"));
  try {
    const file = join(dir, "CMakeLists.txt");
    writeFileSync(file, text);
    run(file, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("native source versions", () => {
  test("owner discovery executes observation-named helpers and retains their configured contexts", () => {
    withCmake("project(ROOT VERSION 1.0)\nmacro(find_package NAME)\nset(GENERATED 4.5.6)\ntherock_cmake_subproject_declare(${NAME} EXTERNAL_SOURCE_DIR ${ROOT_SOURCE_DIR}/vendor CMAKE_ARGS -DGEN_VERSION=${GENERATED})\nFetchContent_Declare(unrelated GIT_REPOSITORY https://example.org/unrelated.git GIT_TAG v1.0)\nendmacro()\nfind_package(Owner)", (file, dir) => {
      mkdirSync(join(dir, "vendor"));
      const vendor = join(dir, "vendor/CMakeLists.txt");
      writeFileSync(vendor, "project(Owner VERSION ${GEN_VERSION})");
      const details = cmakeProjectDetails(file, parseCmakeCommands(readFileSync(file, "utf8")), dir);
      assert.ok(details.fetchCommands.some((command) => command.name === "fetchcontent_declare"));
      assert.ok(details.requirementCommands.some((command) => command.name === "find_package"));
      assert.ok(details.contextCommands.some((command) => !command.helperTemplate && command.args.includes("-DGEN_VERSION=4.5.6")));
      const result = reconcileNativeSourceProviders([], [], dir, { nativeSourceManifests: [file, vendor] });
      assert.ok(result.pkgList.some((component) => component.name === "Owner" && component.version === "4.5.6"));
    });
  });

  test("equivalent configured owner inputs retain each condition and separate changed versions and files", () => {
    const declarations = [
      ["FLAG_A", "vendor", "1.2.3"],
      ["FLAG_B", "vendor", "1.2.3"],
      ["FLAG_C", "vendor", "2.0.0"],
      ["FLAG_D", "other", "1.2.3"],
    ].map(([flag, directory, version]) => `${flag === "FLAG_B" ? "if(OUTER_GATE)\n" : ""}if(${flag})
therock_cmake_subproject_declare(${flag} EXTERNAL_SOURCE_DIR \${ROOT_SOURCE_DIR}/${directory} CMAKE_ARGS -DGEN_VERSION=${version})
endif()${flag === "FLAG_B" ? "\nendif()" : ""}`).join("\n");
    withCmake(`project(ROOT VERSION 1.0)\n${declarations}
therock_cmake_subproject_declare(unguarded EXTERNAL_SOURCE_DIR \${ROOT_SOURCE_DIR}/vendor CMAKE_ARGS -DGEN_VERSION=1.2.3)`, (file, dir) => {
      const manifests = [file];
      for (const [directory, name] of [["vendor", "Owner"], ["other", "Other"]]) {
        mkdirSync(join(dir, directory));
        const manifest = join(dir, directory, "CMakeLists.txt");
        writeFileSync(manifest, `if(LOCAL_FLAG)\nproject(${name} VERSION \${GEN_VERSION})\nendif()`);
        manifests.push(manifest);
      }
      const result = reconcileNativeSourceProviders([], [], dir, { nativeSourceManifests: manifests });
      const actual = new Map();
      for (const component of result.pkgList.filter((entry) => ["Owner", "Other"].includes(entry.name))) {
        const flags = new Set();
        for (const property of component.properties || []) {
          if (property.name !== "cdx:native:sourceContext") continue;
          const context = JSON.parse(property.value);
          assert.equal(Object.fromEntries(context.arguments).GEN_VERSION, component.version);
          for (const condition of context.conditions) {
            for (const match of condition.matchAll(/FLAG_[A-D]/g)) flags.add(match[0]);
          }
        }
        const candidateGuards = (component.properties || [])
          .filter((property) => property.name === "cdx:cmake:conditions")
          .map((property) => JSON.parse(property.value));
        assert.ok(candidateGuards.every((conditions) => conditions.some((condition) => condition.includes("LOCAL_FLAG"))));
        const guardedFlags = new Set(candidateGuards.flatMap((conditions) =>
          conditions.flatMap((condition) => [...condition.matchAll(/FLAG_[A-D]/g)].map((match) => match[0]))));
        assert.deepEqual(guardedFlags, flags);
        if (component.name === "Owner" && component.version === "1.2.3") {
          assert.ok(candidateGuards.some((conditions) => conditions.every((condition) => !/FLAG_[A-D]/.test(condition))));
        }
        actual.set(`${component.name}@${component.version}`, [...flags].sort());
      }
      assert.deepEqual(actual, new Map([
        ["Owner@1.2.3", ["FLAG_A", "FLAG_B"]],
        ["Owner@2.0.0", ["FLAG_C"]],
        ["Other@1.2.3", ["FLAG_D"]],
      ]));
    });
  });

  test("macro writes survive include continuations without resurrecting the caller selector", () => {
    withCmake('set(V 1.0)\nmacro(change UNUSED)\nset(V 2.0)\ninclude(Empty.cmake)\nendmacro()\nchange(x)\nFetchContent_Declare(owner GIT_REPOSITORY https://example.org/owner.git GIT_TAG v${V})', (file, dir) => {
      writeFileSync(join(dir, "Empty.cmake"), "");
      const owners = parseCmakeLikeFile(file, "generic").pkgList.filter((component) => component.name === "owner");
      assert.deepEqual(new Set(owners.map((component) => component.version)), new Set(["v2.0"]));
    });
  });

  test("split block propagation keeps both macro-written source selectors", () => {
    withCmake('set(V 1.0)\nmacro(change UNUSED)\nblock(PROPAGATE V)\nif(OPTION)\nset(V 2.0)\nelse()\nset(V 3.0)\nendif()\nendblock()\nendmacro()\nchange(x)\nFetchContent_Declare(owner GIT_REPOSITORY https://example.org/owner.git GIT_TAG v${V})', (file) => {
      const owners = parseCmakeLikeFile(file, "generic").pkgList.filter((component) => component.name === "owner");
      assert.deepEqual(new Set(owners.map((component) => component.version)), new Set(["v2.0", "v3.0"]));
      assert.ok(owners.every((component) => component.properties.some((property) => property.name === "cdx:cmake:conditions" && property.value.includes("OPTION"))));
    });
  });

  test("unresolved concatenated regex input cannot manufacture an owner release", () => {
    withCmake('string(REGEX MATCH "^([0-9]+).([0-9]+).([0-9]+)" M "1.2.3" "${EXTRA}")\nproject(Owner VERSION "${CMAKE_MATCH_1}.${CMAKE_MATCH_2}.${CMAKE_MATCH_3}")', (file) => {
      assert.ok(!parseCmakeLikeFile(file, "generic").parentComponent.version);
    });
  });

  test("budget fallback cannot retain a selector across an unevaluated include writer", () => {
    withCmake("", (file, dir) => {
      writeFileSync(join(dir, "Change.cmake"), "set(VERSION 2.0.0)");
      const commands = parseCmakeCommands("set(VERSION 1.0.0)\nmessage(exhaust)\ninclude(Change.cmake)\nFetchContent_Declare(owner GIT_REPOSITORY https://example.org/owner.git GIT_TAG v${VERSION})");
      const details = cmakeProjectDetails(file, commands, dir, { declarationsOnly: true, budget: { paths: 0, commands: 0, includes: 0, activeIncludes: new Set(), depth: 0, commandLimit: 1 } });
      assert.ok(details.fetchCommands.every((command) => !command.args.includes("v1.0.0")));
    });
  });
  test("Meson foreach loop variables never reuse unrelated outer literal package identities", () => {
    withCmake("", (_file, dir) => {
      const file = join(dir, "meson.build");
      writeFileSync(file, "project('consumer')\nmodule = 'x11'\nforeach module : ['wayland-client']\n  dependency(module)\nendforeach\n");
      const parsed = parseCmakeLikeFile(file, "generic", { sourceRoot: dir });
      assert.ok(!parsed.requirements.some((requirement) => requirement.command === "dependency" && requirement.requestedName === "x11"));
    });
  });

  test("find_program preserves a single ordered executable discovery group and its destination", () => {
    withCmake("set(PROGRAM pytest)\nfind_program(TEST_EXECUTABLE NAMES ${PROGRAM} py.test REQUIRED)", (file, dir) => {
      const parsed = parseCmakeLikeFile(file, "generic", { sourceRoot: dir });
      const requirement = parsed.requirements.find((entry) => entry.command === "find_program");
      assert.equal(requirement?.requestedName, "pytest");
      assert.equal(requirement.destination, "TEST_EXECUTABLE");
      assert.deepEqual(requirement.alternatives, ["pytest", "py.test"]);
      assert.ok(!parsed.pkgList.some((entry) => entry.name === "TEST_EXECUTABLE"));
    });
  });

  test("budget fallback retains proven selector bindings but invalidates conditional rewrites", () => {
    withCmake("set(BENCHMARK_VERSION 1.9.5)\nmessage(unrelated)\nFetchContent_Declare(googlebench GIT_REPOSITORY https://github.com/google/benchmark.git GIT_TAG v${BENCHMARK_VERSION})", (file, dir) => {
      const evaluate = (text) => cmakeProjectDetails(file, parseCmakeCommands(text), dir, {
        declarationsOnly: true, budget: { paths: 0, commands: 0, includes: 0, activeIncludes: new Set(), depth: 0, commandLimit: 1 },
      });
      const proven = evaluate("set(BENCHMARK_VERSION 1.9.5)\nmessage(unrelated)\nFetchContent_Declare(googlebench GIT_REPOSITORY https://github.com/google/benchmark.git GIT_TAG v${BENCHMARK_VERSION})");
      assert.ok(proven.fetchCommands.some((command) => command.args.includes("v1.9.5") && command.conditions.includes("analysis-budget-exhausted")));
      const guarded = evaluate("message(unrelated)\nif(USER_BUILD_BENCHMARK)\nset(BENCHMARK_VERSION 1.9.5)\nif(NOT benchmark_FOUND)\nFetchContent_Declare(googlebench GIT_REPOSITORY https://github.com/google/benchmark.git GIT_TAG v${BENCHMARK_VERSION})\nendif()\nendif()");
      assert.ok(guarded.fetchCommands.some((command) => command.args.includes("v1.9.5") && command.conditions.includes("if(USER_BUILD_BENCHMARK)")));
      const unknown = evaluate("set(BENCHMARK_VERSION 1.9.5)\nif(UNKNOWN_OPTION)\nset(BENCHMARK_VERSION 8.0.0)\nendif()\nFetchContent_Declare(googlebench GIT_REPOSITORY https://github.com/google/benchmark.git GIT_TAG v${BENCHMARK_VERSION})");
      assert.ok(unknown.fetchCommands.every((command) => !command.args.includes("v1.9.5") && !command.args.includes("v8.0.0")));
    });
  });
  test("source-order requirement context expands names constraints and component lists without losing original arguments", () => {
    withCmake("set(PACKAGE Public)\nset(MIN_VERSION 2.1)\nset(OpenCV_COMPONENTS opencv_core opencv_imgproc opencv_highgui)\nfind_package(${PACKAGE} ${MIN_VERSION} CONFIG REQUIRED HINTS ${UNKNOWN_ROOT})\nfind_package(OpenCV QUIET COMPONENTS ${OpenCV_COMPONENTS})\nfind_package(Threads ${DYNAMIC_CONTROL})", (file, dir) => {
      const parsed = parseCmakeLikeFile(file, "generic", { sourceRoot: dir });
      const publicReq = parsed.requirements.find((entry) => entry.requestedName === "Public");
      assert.equal(publicReq?.constraints, "2.1");
      assert.deepEqual(publicReq.declaredArguments, ["${PACKAGE}", "${MIN_VERSION}", "CONFIG", "REQUIRED", "HINTS", "${UNKNOWN_ROOT}"]);
      assert.ok(publicReq.arguments.includes("Public") && publicReq.arguments.some((arg) => arg.includes("UNKNOWN_ROOT")));
      const opencv = parsed.requirements.find((entry) => entry.requestedName === "OpenCV");
      assert.deepEqual(opencv.arguments.slice(3), ["opencv_core", "opencv_imgproc", "opencv_highgui"]);
      assert.equal(parsed.requirements.find((entry) => entry.requestedName === "Threads").role, "software");
    });
  });
  test("owned major/minor stanzas compose the actual project release rather than a helper version", () => {
    const text = 'file(READ "VERSION.txt" owner_version_file)\nstring(REGEX MATCH "#OWNER_VERSION_MAJOR\\n([0-9]*)" _ ${owner_version_file})\nset(ver_major ${CMAKE_MATCH_1})\nstring(REGEX MATCH "#OWNER_VERSION_MINOR\\n([0-9]*)" _ ${owner_version_file})\nset(ver_minor ${CMAKE_MATCH_1})\nproject(Owned VERSION "${ver_major}.${ver_minor}.0")';
    withCmake(text, (file, dir) => {
      writeFileSync(join(dir, "VERSION.txt"), "#OWNER_VERSION_MAJOR\n3\n#OWNER_VERSION_MINOR\n5\n");
      const parsed = parseCmakeLikeFile(file, "generic", { sourceRoot: dir });
      assert.equal(parsed.parentComponent.version, "3.5.0");
    });
  });

  test("final indexed owner materialization retains branch-scoped dynamic project releases", () => {
    withCmake("", (_file, dir) => {
      const manifest = join(dir, "vendor/CMakeLists.txt");
      mkdirSync(join(dir, "vendor"));
      writeFileSync(manifest, "if(PLATFORM_A)\nset(OWNER first)\nproject(${OWNER} VERSION 1.9.0)\nelse()\nset(OWNER second)\nproject(${OWNER} VERSION 2.0.0)\nendif()\n");
      const result = reconcileNativeSourceProviders([], [], dir, { nativeSourceManifests: [manifest] });
      assert.ok(result.pkgList.some((entry) => entry.name === "first" && entry.version === "1.9.0"));
      assert.ok(result.pkgList.some((entry) => entry.name === "second" && entry.version === "2.0.0"));
      assert.ok(result.pkgList.every((entry) => entry.properties.some((property) => property.name === "cdx:cmake:conditions")));
    });
  });
  test("block parent-scope writes capture their executed value without changing block locals", () => {
    withCmake("set(V 1.0)\nblock()\nset(V 2.0 PARENT_SCOPE)\nset(V 3.0)\nendblock()\nproject(Owner VERSION ${V})", (file, dir) => {
      const result = reconcileNativeSourceProviders([], [], dir, { nativeSourceManifests: [file] });
      assert.deepEqual(result.pkgList.filter((entry) => entry.name === "Owner").map((entry) => entry.version), ["2.0"]);
    });
  });
  test("block parent-scope unset cannot resurrect the enclosing release", () => {
    withCmake("set(V 1.0)\nblock()\nunset(V PARENT_SCOPE)\nendblock()\nproject(Owner VERSION ${V})", (file, dir) => {
      const result = reconcileNativeSourceProviders([], [], dir, { nativeSourceManifests: [file] });
      assert.equal(result.pkgList.some((entry) => entry.name === "Owner" && entry.version === "1.0"), false);
    });
  });
  test("block propagation preserves branch-specific source releases in the enclosing continuation", () => {
    withCmake("block(PROPAGATE V)\nif(OPTION)\nset(V 1.0)\nelse()\nset(V 2.0)\nendif()\nendblock()\nproject(Owner VERSION ${V})", (file, dir) => {
      const result = reconcileNativeSourceProviders([], [], dir, { nativeSourceManifests: [file] });
      assert.deepEqual([...new Set(result.pkgList.filter((entry) => entry.name === "Owner").map((entry) => entry.version))].sort(), ["1.0", "2.0"]);
    });
  });
  test("parent inheritance skips a statically false earlier call to the same child", () => {
    withCmake("set(V 1.0)\nif(FALSE)\nadd_subdirectory(child)\nendif()\nset(V 2.0)\nadd_subdirectory(child)", (file, dir) => {
      mkdirSync(join(dir, "child"));
      const child = join(dir, "child/CMakeLists.txt");
      writeFileSync(child, "project(Owner VERSION ${V})");
      const result = reconcileNativeSourceProviders([], [], dir, { nativeSourceManifests: [file, child] });
      assert.deepEqual([...new Set(result.pkgList.filter((entry) => entry.name === "Owner").map((entry) => entry.version))], ["2.0"]);
    });
  });
  test("numeric capture concatenates every CMake MATCH input", () => {
    withCmake('string(REGEX MATCH "^([0-9]+)\\\\.([0-9]+)\\\\.([0-9]+)" MATCHED "1.2.3" "4")\nproject(Owner VERSION "${CMAKE_MATCH_1}.${CMAKE_MATCH_2}.${CMAKE_MATCH_3}")', (file, dir) => {
      const result = reconcileNativeSourceProviders([], [], dir, { nativeSourceManifests: [file] });
      assert.ok(result.pkgList.some((entry) => entry.name === "Owner" && entry.version === "1.2.34"));
      assert.equal(result.pkgList.some((entry) => entry.name === "Owner" && entry.version === "1.2.3"), false);
    });
  });
  test("endblock budget exhaustion preserves the remaining source declarations", () => {
    withCmake("message(x)\n".repeat(19999) + "block()\nendblock()\nFetchContent_Declare(real GIT_REPOSITORY https://example.org/real.git GIT_TAG v2.0)", (file, dir) => {
      const details = cmakeProjectDetails(file, parseCmakeCommands(readFileSync(file, "utf8")), dir, { declarationsOnly: true });
      assert.ok(details.fetchCommands.some((entry) => entry.name === "fetchcontent_declare" && entry.args.includes("v2.0") && entry.conditions.includes("analysis-budget-exhausted")));
    });
  });
  test("root JSON numeric captures propagate through a block and conditional wrapper without leaking block locals", () => {
    withCmake("project(ROOT)\nset(SHADOW outer)\nblock(PROPAGATE DIST_MAJOR DIST_MINOR DIST_PATCH)\nset(SHADOW inner)\nfile(READ ${CMAKE_CURRENT_SOURCE_DIR}/version.json VERSION_JSON_STRING)\nstring(JSON VERSION_STRING GET ${VERSION_JSON_STRING} distribution-version)\nstring(REGEX MATCH \"^([0-9]+)\\\\.([0-9]+)\\\\.([0-9]+)\" MATCHED ${VERSION_STRING})\nif(MATCHED)\nset(DIST_MAJOR ${CMAKE_MATCH_1})\nset(DIST_MINOR ${CMAKE_MATCH_2})\nset(DIST_PATCH ${CMAKE_MATCH_3})\nendif()\nendblock()\nif(ENABLE_CHILD)\nadd_subdirectory(base)\nendif()", (file, dir) => {
      writeFileSync(join(dir, "version.json"), JSON.stringify({ "distribution-version": "9.7.2" }));
      mkdirSync(join(dir, "base")); mkdirSync(join(dir, "vendor"));
      const base = join(dir, "base/CMakeLists.txt");
      const vendor = join(dir, "vendor/CMakeLists.txt");
      writeFileSync(base, "therock_cmake_subproject_declare(Owner EXTERNAL_SOURCE_DIR ${ROOT_SOURCE_DIR}/vendor CMAKE_ARGS -DGEN_VERSION=${DIST_MAJOR}.${DIST_MINOR}.${DIST_PATCH})");
      writeFileSync(vendor, "project(Owner VERSION ${GEN_VERSION})");
      const details = cmakeProjectDetails(file, parseCmakeCommands(readFileSync(file, "utf8")), dir);
      assert.equal(details.variables.get("DIST_MAJOR"), "9");
      assert.equal(details.variables.get("SHADOW"), "outer");
      assert.equal(details.variables.has("VERSION_JSON_STRING"), false);
      const result = reconcileNativeSourceProviders([], [], dir, { nativeSourceManifests: [file, base, vendor] });
      assert.ok(result.pkgList.some((component) => component.name === "Owner" && component.version === "9.7.2"));
    });
  });
  test("find_library ordered names are one occurrence rather than independent required libraries", () => {
    withCmake("find_library(BACKEND NAMES plain_api staged_api HINTS ${PREFIX}/lib NO_DEFAULT_PATH)", (file, dir) => {
      const parsed = parseCmakeLikeFile(file, "generic", { sourceRoot: dir, nativeDependencyFacts: true });
      const requirements = parsed.requirements.filter((entry) => entry.command === "find_library");
      assert.equal(requirements.length, 1);
      assert.equal(requirements[0].requestedName, "plain_api");
      assert.deepEqual(requirements[0].alternatives, ["plain_api", "staged_api"]);
      assert.equal(requirements[0].destination, "BACKEND");
      assert.ok(requirements[0].arguments.includes("NO_DEFAULT_PATH"));
      assert.equal(parsed.pkgList.filter((entry) => entry.name === "staged_api").length, 0);
    });
  });
  test("conditional project owners retain only artifacts from compatible source branches", () => {
    withCmake("", (_file, dir) => {
      const manifest = join(dir, "vendor/CMakeLists.txt");
      mkdirSync(join(dir, "vendor"));
      writeFileSync(manifest, "if(PLATFORM_A)\nproject(first VERSION 1.9.0)\nadd_library(first_api STATIC first.c)\ninstall(TARGETS first_api)\nelse()\nproject(second VERSION 2.0.0)\nadd_library(second_api STATIC second.c)\ninstall(TARGETS second_api)\nendif()\n");
      const requestFile = join(dir, "CMakeLists.txt");
      writeFileSync(requestFile, "find_library(FIRST NAMES first_api)\nfind_library(SECOND NAMES second_api)");
      const parsed = parseCmakeLikeFile(requestFile, "generic", { sourceRoot: dir, nativeDependencyFacts: true });
      const result = reconcileNativeSourceProviders(parsed.pkgList, [], dir, { nativeSourceManifests: [manifest, requestFile] });
      const owners = result.pkgList.filter((entry) => entry.version && ["first", "second"].includes(entry.name));
      assert.equal(owners.length, 2);
      for (const owner of owners) {
        const requirements = owner.properties.filter((property) => property.name === "cdx:build:requirement").map((property) => JSON.parse(property.value));
        assert.deepEqual([...new Set(requirements.map((entry) => entry.requestedName))], [`${owner.name}_api`]);
      }
    });
  });
  test("already materialized branch owners preserve their original conditions during final indexing", () => {
    withCmake("if(PLATFORM_A)\nproject(first VERSION 1.9.0)\nadd_library(first_api STATIC a.c)\ninstall(TARGETS first_api)\nelse()\nproject(second VERSION 2.0.0)\nadd_library(second_api STATIC b.c)\ninstall(TARGETS second_api)\nendif()", (file, dir) => {
      mkdirSync(join(dir, "consumer"));
      const requestFile = join(dir, "consumer/CMakeLists.txt");
      writeFileSync(requestFile, "find_library(FIRST NAMES first_api)\nfind_library(SECOND NAMES second_api)");
      const parsed = parseCmakeLikeFile(requestFile, "generic", { sourceRoot: dir, nativeDependencyFacts: true });
      const owners = [["first", "1.9.0", "if(PLATFORM_A)"], ["second", "2.0.0", "if(PLATFORM_A)/else()"]].map(([name, version, condition]) => ({
        name, version, type: "library", "bom-ref": `${name}@${version}`, properties: [
          { name: "cdx:cmake:projectFile", value: "CMakeLists.txt" },
          { name: "cdx:cmake:conditions", value: JSON.stringify([condition]) },
        ],
      }));
      const result = reconcileNativeSourceProviders([...parsed.pkgList, ...owners], [], dir, { nativeSourceManifests: [file, requestFile] });
      for (const owner of result.pkgList.filter((entry) => ["first", "second"].includes(entry.name))) {
        const names = owner.properties.filter((property) => property.name === "cdx:build:requirement").map((property) => JSON.parse(property.value).requestedName);
        assert.deepEqual([...new Set(names)], [`${owner.name}_api`]);
      }
    });
  });
  test("Meson literal dataflow preserves variable constraints and ordered dependency alternatives", () => {
    withCmake("", (_file, dir) => {
      const file = join(dir, "meson.build");
      writeFileSync(file, "project('consumer')\nx11_min = '>= 1.8'\nmodule = 'x11'\ndep = dependency(module, version : x11_min)\nlua = dependency('lua54', 'lua5.4', 'lua-5.4', version : '>= 5.4')\nif feature\nx11_min = '>= 9.0'\ninside = dependency('inside', version : x11_min)\nendif\nafter = dependency('after', version : x11_min)\n");
      const parsed = parseCmakeLikeFile(file, "generic", { sourceRoot: dir });
      assert.equal(parsed.requirements.find((entry) => entry.requestedName === "x11")?.constraints, ">= 1.8");
      const lua = parsed.requirements.find((entry) => entry.requestedName === "lua54");
      assert.deepEqual(lua.alternatives, ["lua54", "lua5.4", "lua-5.4"]);
      assert.equal(parsed.requirements.find((entry) => entry.requestedName === "inside")?.constraints, ">= 9.0");
      assert.notEqual(parsed.requirements.find((entry) => entry.requestedName === "after")?.constraints, ">= 9.0");
    });
  });
  test("reconciles only the declaring Cargo and Python source owners for requested programs", () => {
    withCmake("find_program(EXECUTABLE NAMES direct wrapped HINTS ${TOOL_PATH})", (file, dir) => {
      for (const path of ["cargo/src", "python", "unrelated"]) mkdirSync(join(dir, path), { recursive: true });
      const cargo = join(dir, "cargo/Cargo.toml");
      const python = join(dir, "python/pyproject.toml");
      const unrelated = join(dir, "unrelated/pyproject.toml");
      writeFileSync(cargo, '[package]\nname = "binary-owner"\nversion.workspace = true\n[workspace.package]\nversion = "7.0.0"\n[[bin]]\nname = "direct"\npath = "src/main.rs"\n');
      writeFileSync(join(dir, "cargo/src/main.rs"), "fn main() {}");
      writeFileSync(python, '[project]\nname = "wrapper-owner"\nversion = "2.3.0"\n[project.scripts]\nwrapped = "wrapper:main"\n');
      writeFileSync(unrelated, '[project]\nname = "direct"\nversion = "99.0"\n');
      const parsed = parseCmakeLikeFile(file, "generic", { sourceRoot: dir });
      const result = reconcileNativeSourceProviders(parsed.pkgList, [], dir, { nativeLanguageManifests: [cargo, python, unrelated], nativeSourceManifests: [file] });
      assert.deepEqual(result.pkgList.map(({ name, version }) => [name, version]).sort(), [["binary-owner", "7.0.0"], ["wrapper-owner", "2.3.0"]]);
      assert.equal(result.unresolved[0].requirement.line, 1);
      for (const component of result.pkgList) {
        const record = JSON.parse(component.properties.find((entry) => entry.name === "cdx:build:requirement").value);
        assert.equal(record.line, 1);
        assert.ok(record.providerCandidates.every((owner) => owner.compatibility === "unknown" && !owner.selected));
      }
      assert.ok(result.pkgList.find((entry) => entry.name === "binary-owner").properties.some(
        (entry) => entry.name === "cdx:version:source" && entry.value === cargo));
    });
  });

  test("attaches observed diagnostic executable ownership without requiring a program placeholder", () => {
    withCmake("project(Consumer)", (file, dir) => {
      const executable = join(dir, "ver");
      writeFileSync(executable, "#!/bin/sh\n");
      chmodSync(executable, 0o755);
      const lookup = nativeInstalledLibraryObserver(dir,
        (name) => name === "ver" ? executable : name === "rpm" ? "/usr/bin/rpm" : undefined,
        (_program, args) => args[0] === "-qf" && args[1] === executable ? "version-tool\t0\t2.1\t3\tx86_64\n" : undefined);
      const [evidence] = lookup(["ver"], "tool");
      const component = { name: evidence.name, version: evidence.version, "bom-ref": "observed-ver", properties: [
        { name: "cdx:native:providerIdentity", value: "observed" },
        { name: "cdx:native:providerEvidence", value: JSON.stringify(evidence) },
        { name: "cdx:native:providerExports", value: JSON.stringify(evidence.exports) },
      ] };
      bindNativeObservedProvider(component, evidence);
      const probe = { requestedName: "ver", file: "CMakeLists.txt", line: 2, command: "find_program", role: "diagnostic-probe",
        arguments: ["VERSION_TOOL", "ver"], constraints: "", conditions: [], providerCandidates: [] };
      const result = reconcileNativeSourceProviders([component], [], dir, { nativeSourceManifests: [file], nativeDiagnosticRequirements: [probe] });
      assert.deepEqual(result.pkgList, [component]);
      assert.deepEqual([...result.updatedRequirements.values()].flatMap((entry) => entry.providerCandidates.map((candidate) =>
        [entry.role, candidate.ref, candidate.compatibility, candidate.selected, candidate.exports[0].file])), [
        ["diagnostic-probe", "observed-ver", "unknown", false, executable],
      ]);
      assert.equal(reconcileNativeSourceProviders([JSON.parse(JSON.stringify(component))], [], dir,
        { nativeSourceManifests: [file], nativeDiagnosticRequirements: [probe] }).updatedRequirements.size, 0);
    });
  });

  test("joins a source helper template only to selectors instantiated at the same declaration", () => {
    withCmake('include("${CMAKE_CURRENT_LIST_DIR}/deps.cmake")\nacquire(v2.1.0)\nacquire(${ACTUAL_OVERRIDE})', (file, dir) => {
      const helperFile = join(dir, "deps.cmake");
      writeFileSync(helperFile, `function(acquire revision)
FetchContent_Declare(ext GIT_REPOSITORY https://example.org/owned.git GIT_TAG \${revision})
endfunction()
`);
      const template = parseCmakeLikeFile(helperFile, "generic", { sourceRoot: dir });
      const invoked = parseCmakeLikeFile(file, "generic", { sourceRoot: dir });
      const unresolved = template.pkgList.find((entry) => !entry.version);
      const known = invoked.pkgList.find((entry) => entry.version === "v2.1.0");
      assert.ok(unresolved && known);
      const unknownInvocation = invoked.pkgList.find((entry) => !entry.version && entry["bom-ref"] === unresolved["bom-ref"]);
      assert.ok(unknownInvocation);
      const resolved = reconcileNativeSourceProviders([unresolved, known, unknownInvocation], [{ ref: "consumer", dependsOn: [unresolved["bom-ref"]] }], dir, { nativeSourceManifests: [file, helperFile] });
      assert.deepEqual(new Set(resolved.dependencies[0].dependsOn), new Set([known["bom-ref"], unresolved["bom-ref"]]));
      assert.ok(resolved.pkgList.includes(unknownInvocation));
      const actualUnknown = unknownInvocation.properties.filter((entry) => entry.name === "cdx:build:requirement")
        .map((entry) => JSON.parse(entry.value)).find((entry) => entry.source?.helperInvocations?.length && entry.source?.gitTagExpression);
      assert.ok(actualUnknown);
      assert.deepEqual(actualUnknown.providerCandidates.map((entry) => entry.ref), [unknownInvocation["bom-ref"]]);
      const templateRecord = known.properties.filter((entry) => entry.name === "cdx:build:requirement").map((entry) => JSON.parse(entry.value))
        .find((entry) => entry.originalBomRef === unresolved["bom-ref"]);
      assert.equal(templateRecord.line, 2);
      assert.match(templateRecord.source.gitTagExpression, /revision/i);
      assert.deepEqual(templateRecord.providerCandidates, [{ kind: "declared-source", ref: known["bom-ref"], selected: false }]);
    });
  });

  test("does not carry a disabled CMake macro lookup or a prior version into the next call", () => {
    withCmake(`macro(probe package enabled)
cmake_parse_arguments(OPT "" "VERSION" "" \${ARGN})
set(should_find \${enabled})
if(\${should_find})
  find_package(\${package} \${OPT_VERSION})
endif()
endmacro()
probe(First TRUE VERSION 4)
probe(Disabled FALSE VERSION 9)
probe(Second TRUE)
`, (file, dir) => {
      const parsed = parseCmakeLikeFile(file, "generic", { sourceRoot: dir });
      const facts = parsed.requirements.filter((entry) => entry.helperInvocations?.length);
      assert.deepEqual(facts.map(({ requestedName, constraints, line }) => [requestedName, constraints, line]), [
        ["First", "4", 5], ["Second", "", 5],
      ]);
      assert.deepEqual(facts.map((entry) => entry.helperInvocations), [[`${file}:8`], [`${file}:10`]]);
    });
  });

  test("known owners replace software placeholders without turning unresolved predicates into satisfaction", () => {
    withCmake("project(Owner VERSION 2.0)\nconfigure_package_config_file(PublicConfig.cmake.in PublicConfig.cmake)", (_file, dir) => {
      const owner = { name: "Owner", version: "2.0", "bom-ref": "owner", properties: [{ name: "cdx:cmake:sourceDir", value: "." }] };
      const req = { requestedName: "Public", command: "find_package", arguments: ["Public", "CONFIG", "HINTS", "${UNKNOWN_ROOT}"], file: "consumer/CMakeLists.txt", line: 7, ordinal: 2, role: "software", constraints: "", conditions: [], providerCandidates: [] };
      const placeholder = { name: "Public", "bom-ref": "blank-request", properties: [{ name: "cdx:build:requirement", value: JSON.stringify(req) }] };
      const result = reconcileNativeSourceProviders([placeholder, owner], [{ ref: "consumer", dependsOn: ["blank-request"] }], dir);
      assert.ok(!result.pkgList.some((entry) => entry["bom-ref"] === "blank-request"));
      assert.deepEqual(result.refMap.get("blank-request"), ["owner"]);
      const record = result.pkgList.find((entry) => entry["bom-ref"] === "owner").properties.filter((entry) => entry.name === "cdx:build:requirement").map((entry) => JSON.parse(entry.value)).find((entry) => entry.requestedName === "Public");
      assert.equal(record.originalBomRef, "blank-request");
      assert.ok(record.providerCandidates.some((entry) => entry.ref === "owner" && entry.compatibility === "unknown" && !entry.selected));
      assert.equal(result.unresolved.length, 1);
      assert.deepEqual(result.dependencies.find((entry) => entry.ref === "consumer").dependsOn, ["owner"]);
    });
  });
  test("a satisfied finder does not erase a second versioned owner with unproved compatibility", () => {
    withCmake("", (_file, dir) => {
      const owners = ["2.0", "3.0"].map((version) => {
        const sourceDir = `vendor/${version}`;
        mkdirSync(join(dir, sourceDir), { recursive: true });
        const apiVersion = version === "2.0" ? "2.0" : "${UNKNOWN_API_VERSION}";
        writeFileSync(join(dir, sourceDir, "CMakeLists.txt"), `project(Owner VERSION ${version})
configure_package_config_file(PublicConfig.cmake.in PublicConfig.cmake)
write_basic_package_version_file(PublicConfigVersion.cmake VERSION ${apiVersion} COMPATIBILITY AnyNewerVersion)`);
        return { name: "Owner", version, "bom-ref": `owner-${version}`, properties: [{ name: "cdx:cmake:sourceDir", value: sourceDir }] };
      });
      const req = { requestedName: "Public", command: "find_package", arguments: ["Public", "2.0", "EXACT", "CONFIG"], file: "consumer/CMakeLists.txt", line: 7, role: "software", constraints: "2.0 EXACT", conditions: [], providerCandidates: [] };
      const placeholder = { name: "Public", "bom-ref": "request", properties: [{ name: "cdx:build:requirement", value: JSON.stringify(req) }] };
      const result = reconcileNativeSourceProviders([placeholder, ...owners], [{ ref: "consumer", dependsOn: ["request"] }], dir);
      assert.deepEqual(result.dependencies.find((entry) => entry.ref === "consumer").dependsOn, ["owner-2.0", "owner-3.0"]);
      const candidateStatuses = owners.map((owner) => {
        const property = owner.properties.find((entry) => entry.name === "cdx:build:requirement");
        return JSON.parse(property.value).providerCandidates.map((candidate) => [candidate.ref, candidate.compatibility, candidate.selected]);
      });
      assert.deepEqual(candidateStatuses, [
        [["owner-2.0", "satisfied", false], ["owner-3.0", "unknown", false]],
        [["owner-2.0", "satisfied", false], ["owner-3.0", "unknown", false]],
      ]);
    });
  });
  test("owner cutover splits merged occurrences and retains the genuinely owner-unidentified requirement", () => {
    withCmake("project(Owner VERSION 2.0)\nconfigure_package_config_file(PublicConfig.cmake.in PublicConfig.cmake)", (_file, dir) => {
      const owner = { name: "Owner", version: "2.0", "bom-ref": "owner", properties: [{ name: "cdx:cmake:sourceDir", value: "." }] };
      const base = { requestedName: "Public", command: "find_package", arguments: ["Public", "CONFIG"], file: "consumer/CMakeLists.txt", role: "software", constraints: "9.0 EXACT", conditions: [], providerCandidates: [] };
      const unknown = { ...base, requestedName: "Missing", arguments: ["Missing"], line: 8, constraints: "" };
      const placeholder = { name: "merged", "bom-ref": "merged-blank", properties: [base, unknown].map((entry) => ({ name: "cdx:build:requirement", value: JSON.stringify(entry) })) };
      const result = reconcileNativeSourceProviders([placeholder, owner], [{ ref: "consumer", dependsOn: ["merged-blank"] }], dir);
      const retained = result.pkgList.find((entry) => entry["bom-ref"] === "merged-blank");
      assert.equal(retained.properties.filter((entry) => entry.name === "cdx:build:requirement").length, 1);
      assert.equal(JSON.parse(retained.properties.find((entry) => entry.name === "cdx:build:requirement").value).requestedName, "Missing");
      assert.deepEqual(new Set(result.refMap.get("merged-blank")), new Set(["merged-blank", "owner"]));
      const record = owner.properties.filter((entry) => entry.name === "cdx:build:requirement").map((entry) => JSON.parse(entry.value)).find((entry) => entry.requestedName === "Public");
      assert.ok(record.providerCandidates.some((entry) => entry.ref === "owner" && entry.compatibility === "violated" && !entry.selected));
      assert.equal(record.originalBomRef, "merged-blank");
    });
  });
  test("project source variables and configured wrapper arguments supply real owner context without selecting a build", () => {
    withCmake("project(ROOT)\nadd_subdirectory(wrapper)", (file, dir) => {
      mkdirSync(join(dir, "wrapper"));
      mkdirSync(join(dir, "vendor/owner"), { recursive: true });
      mkdirSync(join(dir, "vendor/version"), { recursive: true });
      writeFileSync(join(dir, "wrapper/CMakeLists.txt"), "therock_cmake_subproject_declare(variant EXTERNAL_SOURCE_DIR ${ROOT_SOURCE_DIR}/vendor/owner CMAKE_ARGS -DCOMMON_DIR=${ROOT_SOURCE_DIR}/vendor/version -DINSTALL_EXPORT=ON)");
      writeFileSync(join(dir, "vendor/version/VERSION"), "7.18.0");
      writeFileSync(join(dir, "vendor/owner/CMakeLists.txt"), "file(READ ${COMMON_DIR}/VERSION OWNER_VERSION)\nproject(Owner VERSION ${OWNER_VERSION})\nif(INSTALL_EXPORT)\nconfigure_package_config_file(OwnerConfig.cmake.in PublicConfig.cmake)\nendif()");
      const manifests = [file, join(dir, "wrapper/CMakeLists.txt"), join(dir, "vendor/owner/CMakeLists.txt")];
      const req = { name: "Public", "bom-ref": "request", properties: [{ name: "cdx:build:requirement", value: JSON.stringify({ requestedName: "Public", command: "find_package", arguments: ["Public", "CONFIG"], file: "app/CMakeLists.txt", line: 1, role: "software", constraints: "", conditions: [], providerCandidates: [] }) }] };
      const result = reconcileNativeSourceProviders([req], [], dir, { nativeSourceManifests: manifests });
      assert.ok(result.pkgList.some((entry) => entry.name === "Owner" && entry.version === "7.18.0"));
      assert.ok(result.pkgList.flatMap((entry) => entry.properties || []).filter((entry) => entry.name === "cdx:build:requirement").map((entry) => JSON.parse(entry.value)).some((entry) => entry.providerCandidates.some((candidate) => !candidate.selected && candidate.ref)));
    });
  });
  test("authenticated cached source configs enter the existing owner index without trusting tampered members", () => {
    withCmake("FetchContent_Declare(owner GIT_REPOSITORY https://github.com/example/cached.git GIT_TAG v2.3.0)\nfind_package(Public CONFIG)\nfind_package(Unlisted CONFIG)", (file, dir) => {
      const cache = mkdtempSync(join(tmpdir(), "cdx-owner-cache-"));
      try {
        const repository = "https://github.com/example/cached";
        const revision = "a".repeat(40);
        const object = join(cache, "objects", nativeSourceCacheKey(repository, revision));
        mkdirSync(join(object, "cmake"), { recursive: true });
        mkdirSync(join(cache, "selectors"));
        const files = [["CMakeLists.txt", "project(Owner VERSION 2.3.0)\ninclude(cmake/Unlisted.cmake OPTIONAL)\ninstall(DIRECTORY cmake/ DESTINATION lib/cmake/Public)"], ["cmake/PublicConfig.cmake", "set(Public_FOUND TRUE)"]];
        for (const [path, text] of files) writeFileSync(join(object, path), text);
        writeFileSync(join(object, "cmake/Unlisted.cmake"), "configure_package_config_file(input.in UnlistedConfig.cmake)");
        writeFileSync(join(object, "cmake/UnlistedConfig.cmake"), "set(Unlisted_FOUND TRUE)");
        writeFileSync(join(cache, "selectors", `${nativeSourceCacheKey(repository, "v2.3.0")}.json`), JSON.stringify({ schema: 1, repository, selector: "v2.3.0", selectorKind: "tag", revision, files: files.map(([path, text]) => ({ path, sha256: createHash("sha256").update(text).digest("hex") })) }));
        const options = { sourceRoot: dir, nativeSourceCache: cache, nativeSourceManifests: [file] };
        const parsed = parseCmakeLikeFile(file, "generic", options);
        const result = reconcileNativeSourceProviders(parsed.pkgList, [], dir, options);
        assert.ok(!result.pkgList.some((entry) => entry.name === "Public" && !entry.version));
        assert.ok(result.pkgList.some((entry) => entry.version === "2.3.0" && entry.properties.some((property) => property.name === "cdx:build:requirement" && JSON.parse(property.value).requestedName === "Public")));
        assert.ok(result.pkgList.some((entry) => entry.name === "Unlisted" && !entry.version), "unhashed neighbours and optional helper inputs cannot authorize an export");
        writeFileSync(join(object, "cmake/PublicConfig.cmake"), "set(Public_FOUND FALSE)");
        const rejected = reconcileNativeSourceProviders(parseCmakeLikeFile(file, "generic", options).pkgList, [], dir, options);
        assert.ok(rejected.pkgList.some((entry) => entry.name === "Public" && !entry.version));
      } finally { rmSync(cache, { recursive: true, force: true }); }
    });
  });
  test("a fetched helper template retains authenticated source config exports of its concrete invocation", () => {
    withCmake(`project(consumer)
function(acquire VERSION)
  FetchContent_Declare(shared GIT_REPOSITORY https://github.com/example/shared.git GIT_TAG \${VERSION})
  FetchContent_MakeAvailable(shared)
endfunction()
acquire(v2.3.0)
acquire(\${UNKNOWN_VERSION})
`, (file, dir) => {
      const cache = mkdtempSync(join(tmpdir(), "cdx-helper-config-"));
      try {
        const repository = "https://github.com/example/shared";
        const revision = "a".repeat(40);
        const object = join(cache, "objects", nativeSourceCacheKey(repository, revision));
        mkdirSync(join(object, "cmake"), { recursive: true });
        mkdirSync(join(cache, "selectors"));
        const source = "project(Shared VERSION 2.3.0)\nif(INSTALL_EXPORT)\ninstall(FILES cmake/shared-config.cmake cmake/other-config.cmake DESTINATION lib/cmake/shared)\nendif()";
        const config = "set(shared_FOUND TRUE)";
        const files = [["CMakeLists.txt", source], ["cmake/shared-config.cmake", config], ["cmake/other-config.cmake", "set(other_FOUND TRUE)"]];
        for (const [path, text] of files) writeFileSync(join(object, path), text);
        writeFileSync(join(cache, "selectors", `${nativeSourceCacheKey(repository, "v2.3.0")}.json`), JSON.stringify({
          schema: 1, repository, selector: "v2.3.0", selectorKind: "tag", revision,
          files: files.map(([path, text]) => ({ path, sha256: createHash("sha256").update(text).digest("hex") })),
        }));
        const options = { sourceRoot: dir, nativeSourceCache: cache, nativeSourceManifests: [file] };
        const materialize = () => {
          const parsed = parseCmakeLikeFile(file, "generic", options);
          const result = reconcileNativeSourceProviders(parsed.pkgList, [], dir, options);
          return { parsed, records: result.pkgList.flatMap((component) => component.properties
            .filter((entry) => entry.name === "cdx:build:requirement").map((entry) => JSON.parse(entry.value))) };
        };
        const { parsed, records } = materialize();
        const original = parsed.requirements.find((entry) => entry.source?.helperTemplate);
        const template = records.find((entry) => entry.source?.helperTemplate);
        assert.deepEqual(template.conditions, original.conditions);
        assert.equal(template.requestedName, original.requestedName);
        assert.ok(template.providerCandidates.some((entry) => entry.kind === "declared-source"));
        const candidate = template.providerCandidates.find((entry) => entry.kind === "source-export");
        assert.equal(candidate.selected, false);
        assert.equal(candidate.compatibility, "unknown");
        assert.deepEqual(candidate.exports.map(({ name, conditions, sourceSelector }) => [name, conditions, sourceSelector.revision]),
          [["shared", ["if(INSTALL_EXPORT)"], revision]]);
        assert.ok(records.some((entry) => !entry.source?.helperTemplate && entry.source?.gitTagExpression &&
          entry.providerCandidates.every((candidate) => candidate.kind !== "source-export")));
        writeFileSync(join(object, "cmake/shared-config.cmake"), config + "\n# tampered");
        assert.ok(!materialize().records.some((entry) => entry.providerCandidates.some((candidate) => candidate.kind === "source-export")));
      } finally { rmSync(cache, { recursive: true, force: true }); }
    });
  });
  test("standalone ExternalProject binds only a verified compatible config-install declaration", () => {
    const repository = "https://github.com/example/cached";
    const revision = "a".repeat(40);
    const declaration = (name, options = "", repo = repository, selector = revision) =>
      `ExternalProject_Add(${name} GIT_REPOSITORY ${repo} GIT_TAG ${selector} ${options})`;
    withCmake([
      "if(CONSUMER)", "else()", declaration("standalone", "CMAKE_ARGS -DCMAKE_INSTALL_PREFIX=${CMAKE_CURRENT_BINARY_DIR}/prefix UPDATE_COMMAND ${GIT_EXECUTABLE} pull"), "endif()",
      "set(GIT_EXECUTABLE CONFIGURE_COMMAND)", declaration("clause", "UPDATE_COMMAND ${GIT_EXECUTABLE} pull"),
      declaration("custom", "CONFIGURE_COMMAND other-configure"), declaration("disabled", "CONFIGURE_COMMAND \"\""),
      declaration("forwarded", "${FINDER_OPTIONS}"), declaration("generator", "CMAKE_GENERATOR Ninja"),
      declaration("wrong_repository", "", "https://github.com/unrelated/cached"), declaration("wrong_selector", "", "b".repeat(40)),
      `FetchContent_Declare(fetch GIT_REPOSITORY ${repository} GIT_TAG ${revision})`,
    ].join("\n"), (file, dir) => {
      const cache = mkdtempSync(join(tmpdir(), "cdx-external-config-"));
      try {
        const object = join(cache, "objects", nativeSourceCacheKey(repository, revision));
        mkdirSync(join(object, "unreachable"), { recursive: true });
        mkdirSync(join(cache, "selectors"));
        const source = [
          "set(SUBPROJECT OFF)", "if(DEFINED PROJECT_NAME)", "set(SUBPROJECT ON)", "endif()", "project(Cached)",
          "if(NOT SUBPROJECT)", "if(CONSUMER)",
          "configure_package_config_file(input.in ${CMAKE_CURRENT_BINARY_DIR}/CachedConfig.cmake INSTALL_DESTINATION lib/cmake/Cached)",
          "install(FILES ${CMAKE_CURRENT_BINARY_DIR}/CachedConfig.cmake DESTINATION lib/cmake/Cached)", "endif()", "endif()",
          "if(UNRESOLVED)", "configure_package_config_file(input.in ContradictoryConfig.cmake INSTALL_DESTINATION lib/cmake/wrong)",
          "else()", "install(FILES ${CMAKE_CURRENT_BINARY_DIR}/ContradictoryConfig.cmake DESTINATION lib/cmake/wrong)", "endif()",
          "configure_package_config_file(input.in MissingInstallConfig.cmake INSTALL_DESTINATION lib/cmake/absent)",
          "install(FILES MissingGenerationConfig.cmake DESTINATION lib/cmake/absent)",
          "configure_package_config_file(input.in ${CMAKE_CURRENT_BINARY_DIR}/SeparateConfig.cmake INSTALL_DESTINATION lib/cmake/Separate)",
          "install(FILES SeparateConfig.cmake DESTINATION lib/cmake/Separate)",
          "include(Guessed)", "include(reachable.cmake)",
        ].join("\n");
        const snapshot = join(object, "CMakeLists.txt");
        const files = new Map([
          ["CMakeLists.txt", source],
          ...[["unreachable/CMakeLists.txt", "Unvisited"], ["unreachable/Guessed.cmake", "Guessed"], ["reachable.cmake", "Reachable"]].map(([path, name]) => [
            path, `configure_package_config_file(input.in ${name}Config.cmake INSTALL_DESTINATION lib/cmake/${name})\n` +
              `install(FILES \${CMAKE_CURRENT_BINARY_DIR}/${name}Config.cmake DESTINATION lib/cmake/${name})`,
          ]),
        ]);
        for (const [path, text] of files) writeFileSync(join(object, path), text);
        writeFileSync(join(cache, "selectors", `${nativeSourceCacheKey(repository, revision)}.json`), JSON.stringify({
          schema: 1, repository, selector: revision, selectorKind: "commit", revision,
          files: [...files].map(([path, text]) => ({ path, sha256: createHash("sha256").update(text).digest("hex") })),
        }));
        const options = { sourceRoot: dir, nativeSourceCache: cache, nativeSourceManifests: [file] };
        const materialize = () => {
          const parsed = parseCmakeLikeFile(file, "generic", options);
          const result = reconcileNativeSourceProviders(parsed.pkgList, [], dir, options);
          return result.pkgList.flatMap((component) => component.properties.filter((entry) => entry.name === "cdx:build:requirement").map((entry) => JSON.parse(entry.value)));
        };
        const records = materialize();
        const enriched = records.filter((requirement) => requirement.providerCandidates.some((candidate) => candidate.kind === "source-export"));
        assert.deepEqual(enriched.map((requirement) => requirement.requestedName), ["standalone"]);
        assert.deepEqual(enriched[0].conditions, ["if(CONSUMER)/else()"]);
        assert.equal(enriched[0].source.standaloneCmake, true);
        const candidates = enriched[0].providerCandidates;
        assert.ok(candidates.some((candidate) => candidate.kind === "declared-source" && !candidate.selected));
        const candidate = candidates.find((candidate) => candidate.kind === "source-export");
        assert.equal(candidate.selected, false);
        assert.equal(candidate.compatibility, "unknown");
        assert.deepEqual(candidate.exports.map(({ name, sourceDeclared, materialUnknown, sourceSelector }) => [
          name, sourceDeclared, materialUnknown, sourceSelector.repository, sourceSelector.revision,
        ]), [["Cached", true, true, repository, revision], ["Reachable", true, true, repository, revision]]);
        assert.deepEqual(candidate.exports[0].conditions, ["if(CONSUMER)"]);
        assert.equal(candidate.exports[0].source, `${snapshot}:8`);
        assert.equal(candidate.exports[0].installationSource, `${snapshot}:9`);
        writeFileSync(snapshot, source + "\n# changed");
        assert.ok(!materialize().some((requirement) => requirement.providerCandidates.some((entry) => entry.kind === "source-export")));
      } finally { rmSync(cache, { recursive: true, force: true }); }
    });
  });
  test("literal alternate CMake includes preserve header-derived project releases and exclude uninvoked project templates", () => {
    withCmake("if(WSL)\ninclude(CMakeLists_wsl.txt)\nelse()\nproject(regular VERSION 1.9.0)\nendif()\nfunction(unused)\nproject(Phantom VERSION 99.0)\nendfunction()", (file, dir) => {
      writeFileSync(join(dir, "version.h"), "#define OWNER_MAJOR 1\n#define OWNER_MINOR 1\n#define OWNER_PATCH 0\n");
      writeFileSync(join(dir, "CMakeLists_wsl.txt"), 'set(OWNER alternate)\nfile(STRINGS "${CMAKE_CURRENT_SOURCE_DIR}/version.h" MAJOR REGEX "^#define OWNER_MAJOR ")\nfile(STRINGS "${CMAKE_CURRENT_SOURCE_DIR}/version.h" MINOR REGEX "^#define OWNER_MINOR ")\nfile(STRINGS "${CMAKE_CURRENT_SOURCE_DIR}/version.h" PATCH REGEX "^#define OWNER_PATCH ")\nstring(REGEX REPLACE ".*MAJOR " "" MAJOR "${MAJOR}")\nstring(REGEX REPLACE ".*MINOR " "" MINOR "${MINOR}")\nstring(REGEX REPLACE ".*PATCH " "" PATCH "${PATCH}")\nproject(${OWNER} VERSION ${MAJOR}.${MINOR}.${PATCH})');
      const result = reconcileNativeSourceProviders([], [], dir, { nativeSourceManifests: [file, join(dir, "CMakeLists_wsl.txt")] });
      assert.ok(result.pkgList.some((entry) => entry.name === "alternate" && entry.version === "1.1.0"));
      assert.ok(result.pkgList.some((entry) => entry.name === "regular" && entry.version === "1.9.0"));
      assert.ok(!result.pkgList.some((entry) => entry.name === "Phantom"));
    });
  });









  test("Meson triple-quoted text does not swallow later dependency callsites", () => {
    withCmake("", (_file, dir) => {
      const file = join(dir, "meson.build");
      writeFileSync(file, [
        "project('consumer')",
        "if have_feature",
        "  dep = dependency('glvnd', version: '>=1.0',",
        "    error_message: '''EGL suffix can't close this multiline literal (",
        "    # this hash and these parentheses ) ( are literal text",
        "    still inside the message''')",
        "  after = dependency('after-triple', version: '>= 2.0', fallback: ['after-source', 'after_dep'])",
        "endif",
        "dependency('outside')",
      ].join("\n"));
      mkdirSync(join(dir, "subprojects"));
      writeFileSync(join(dir, "subprojects", "after-source.wrap"), "[wrap-file]\ndirectory = after-source-9.9\n[provide]\nafter-triple = after_dep\n");
      const parsed = parseCmakeLikeFile(file, "generic", { sourceRoot: dir });
      const after = parsed.requirements.find((requirement) => requirement.requestedName === "after-triple");
      assert.ok(after);
      assert.equal(after.file, "meson.build");
      assert.equal(after.line, 7);
      assert.deepEqual(after.conditions, ["if have_feature"]);
      assert.equal(after.constraints, ">= 2.0");
      assert.ok(after.providerCandidates.some((candidate) => candidate.name === "after-source" && !candidate.selected));
      const outside = parsed.requirements.find((requirement) => requirement.requestedName === "outside");
      assert.equal(outside.line, 9);
      assert.deepEqual(outside.conditions, []);
      assert.ok(parsed.pkgList.every((component) => !component.version));
      assert.ok(!parsed.pkgList.some((component) => component.name === "after-source"));
    });
  });

  test("bounded speculative helper analysis cannot erase caller declarations", () => {
    const helper = `${Array.from({ length: 4 }, (_, helperIndex) => `function(optional_sources_${helperIndex})
${Array.from({ length: 40 }, (_, index) => `if(OPTION_${index})\nFetchContent_Declare(optional_${helperIndex}_${index} URL https://example.org/optional-${index}-1.0.0.tar.gz)\nendif()`).join("\n")}
endfunction()`).join("\n")}
`;
    withCmake(`include(HelpersVersion.cmake)
if(CALLER_SOURCES)
${Array.from({ length: 6 }, (_, index) => `CPMAddPackage(NAME caller_${index} GITHUB_REPOSITORY example/caller_${index} GIT_TAG v1.2.${index})`).join("\n")}
endif()
`, (file, dir) => {
      writeFileSync(join(dir, "HelpersVersion.cmake"), helper);
      const parsed = parseCmakeLikeFile(file, "generic");
      for (let index = 0; index < 6; index++) {
        const source = parsed.pkgList.find((component) => component.name === `caller_${index}`);
        assert.equal(source?.version, `v1.2.${index}`);
      }
      assert.ok(parsed.requirements.filter((requirement) => requirement.role === "source-declaration")
        .every((requirement) => requirement.providerCandidates.every((candidate) => candidate.selected === false)));
    });
  });

  test("independent conditional declarations do not multiply a later include continuation", () => {
    withCmake(`include(VendorVersion.cmake)
if(PROFILER)
CPMAddPackage(NAME protocol GIT_REPOSITORY https://example.org/protocol.git GIT_TAG 1.37)
endif()
`, (file, dir) => {
      writeFileSync(join(dir, "VendorVersion.cmake"), Array.from({ length: 8 }, (_, index) =>
        `if(SYSTEM_${index})\nelse()\nCPMAddPackage(NAME vendor_${index} GITHUB_REPOSITORY example/vendor_${index} GIT_TAG v1.0.${index})\nendif()`).join("\n"));
      const parsed = parseCmakeLikeFile(file, "generic");
      for (let index = 0; index < 8; index++) assert.ok(parsed.pkgList.some((component) => component.name === `vendor_${index}` && component.version === `v1.0.${index}`));
      const protocol = parsed.pkgList.find((component) => component.name === "protocol");
      assert.equal(protocol?.version, "1.37");
      const conditions = JSON.parse(protocol.properties.find((property) => property.name === "cdx:cmake:conditions").value);
      assert.deepEqual(conditions, ["if(PROFILER)"]);
    });
  });

  test("nested MATCHES retains conditional capture state for later source selectors", () => {
    withCmake(`set(TEXT 2.0.0)
set(CMAKE_MATCH_1 1)
if(OPTION)
if(TEXT MATCHES "^([0-9]+).([0-9]+).([0-9]+)")
FetchContent_Declare(inner URL https://example.org/inner-1.0.0.tar.gz)
endif()
endif()
FetchContent_Declare(after GIT_REPOSITORY https://github.com/example/after.git GIT_TAG v\${CMAKE_MATCH_1}.0.0)
`, (file) => {
      const sources = parseCmakeLikeFile(file, "generic").pkgList.filter((component) => component.name === "after");
      assert.deepEqual(new Set(sources.map((component) => component.version)), new Set(["v1.0.0", "v2.0.0"]));
      for (const source of sources) {
        const conditions = JSON.parse(source.properties.find((property) => property.name === "cdx:cmake:conditions").value);
        assert.deepEqual(conditions, [source.version === "v2.0.0" ? "if(OPTION)" : "not(OPTION)"]);
      }
    });
  });



  test("conditional Git declarations retain concrete source refs without selecting a provider", () => {
    withCmake(`find_package(owned 1.0)
if(ENABLE_SOURCE)
set(PIN d494a3194ceb4cc4dbb2debf9fcbe8773c6d3bef)
FetchContent_Declare(owned GIT_REPOSITORY https://github.com/acme/owned.git GIT_TAG \${PIN})
endif()
`, (file) => {
      const parsed = parseCmakeLikeFile(file, "generic");
      const source = parsed.pkgList.find((component) => component.properties?.some((property) => property.name === "cdx:cmake:gitRef"));
      assert.ok(source.properties.some((property) => property.name === "cdx:cmake:gitRef" && property.value === "d494a3194ceb4cc4dbb2debf9fcbe8773c6d3bef"));
      assert.ok(source.properties.some((property) => property.name === "cdx:cmake:conditions" && property.value.includes("ENABLE_SOURCE")));
      assert.ok(!parsed.pkgList.some((component) => component.name === "owned" && !component.version));
      const consumer = source.properties.filter((property) => property.name === "cdx:build:requirement")
        .map((property) => JSON.parse(property.value)).find((requirement) => requirement.role === "software");
      assert.equal(consumer.requestedName, "owned");
      assert.equal(consumer.constraints, "1.0");
      assert.ok(consumer.providerCandidates.some((candidate) => candidate.ref === source["bom-ref"] && candidate.selected === false));
      assert.ok(parsed.requirements.every((requirement) => !requirement.providerCandidates?.some((candidate) => candidate.selected)));
    });
  });

  test("included writes stay tainted across a potentially zero-iteration loop", () => {
    withCmake(`foreach(item IN LISTS UNKNOWN_ITEMS)
include(SelectorVersion.cmake)
endforeach()
FetchContent_Declare(after URL \${SOURCE_URL})
`, (file, dir) => {
      writeFileSync(join(dir, "SelectorVersion.cmake"), "set(SOURCE_URL https://example.org/owned-9.0.0.tar.gz)\nFetchContent_Declare(inside URL https://example.org/inside-1.0.0.tar.gz)\n");
      const parsed = parseCmakeLikeFile(file, "generic");
      assert.ok(!parsed.pkgList.some((component) => component.name === "after"));
      const inside = parsed.pkgList.find((component) => component.name === "inside");
      assert.ok(inside.properties.some((property) => property.name === "cdx:cmake:conditions" && property.value.includes("foreach")));
    });
  });

  test("conditional string and list destinations participate in source alternatives", () => {
    for (const operation of ['string(REPLACE "1.0.0" "2.0.0" SOURCE_URL "\${SOURCE_URL}")', "list(GET URLS 1 SOURCE_URL)"]) {
      withCmake(`set(SOURCE_URL https://example.org/owned-1.0.0.tar.gz)
set(URLS "https://example.org/owned-1.0.0.tar.gz;https://example.org/owned-2.0.0.tar.gz")
if(OVERRIDE)
${operation}
endif()
FetchContent_Declare(owned URL \${SOURCE_URL})
`, (file) => {
        const sources = parseCmakeLikeFile(file, "generic").pkgList;
        assert.deepEqual(new Set(sources.map((component) => component.version)), new Set(["1.0.0", "2.0.0"]));
        assert.ok(sources.every((component) => component.properties.some((property) => property.name === "cdx:cmake:conditions")));
      });
    }
  });

  test("statically inactive helper bodies cannot resurrect source declarations", () => {
    for (const kind of ["function", "macro"]) withCmake(`if(FALSE)
${kind}(unavailable)
FetchContent_Declare(dead URL https://example.org/dead-9.0.0.tar.gz)
end${kind}()
endif()
if(TRUE)
${kind}(available)
FetchContent_Declare(possible URL https://example.org/possible-1.0.0.tar.gz)
end${kind}()
endif()
`, (file) => {
      const parsed = parseCmakeLikeFile(file, "generic");
      assert.ok(!parsed.pkgList.some((component) => component.name === "dead"));
      const possible = parsed.pkgList.find((component) => component.name === "possible");
      assert.ok(possible.properties.some((property) => property.name === "cdx:cmake:conditions" && property.value.includes("if(TRUE)") && property.value.includes(kind)));
    });
  });

  test("unrelated target build properties cannot exhaust owned version metadata paths", () => {
    const flags = Array.from({ length: 16 }, (_, index) => `if(FEATURE_${index})\nset(FLAGS "\${FLAGS} -DFEATURE_${index}")\nendif()`).join("\n");
    withCmake(`project(owned VERSION 1.9.0)
add_library(owned STATIC source.c)
set(FLAGS "")
set(ABI_VERSION 1.0.6)
${flags}
set_target_properties(owned PROPERTIES LINK_FLAGS "\${FLAGS}" VERSION "\${ABI_VERSION}")
`, (file, dir) => {
      writeFileSync(join(dir, "source.c"), "void api(void) {}\n");
      const parsed = parseCmakeLikeFile(file, "generic");
      const candidates = parsed.parentComponent.properties.filter((p) => p.name === "cdx:cmake:versionCandidate").map((p) => JSON.parse(p.value));
      assert.ok(candidates.some((c) => c.kind === "library-version" && c.version === "1.0.6"));
    });
  });

  test("does not materialize false elseif sources or promote unknown loop assignments", () => {
    withCmake(`if(PROFILE)
FetchContent_Declare(first URL https://example.org/first-1.0.0.tar.gz)
elseif(FALSE)
FetchContent_Declare(dead URL https://example.org/dead-9.0.0.tar.gz)
else()
FetchContent_Declare(other URL https://example.org/other-2.0.0.tar.gz)
endif()
foreach(item IN LISTS UNKNOWN_ITEMS)
set(LOOP_URL https://example.org/loop-9.0.0.tar.gz)
FetchContent_Declare(loop_literal URL https://example.org/literal-3.0.0.tar.gz)
endforeach()
FetchContent_Declare(loop_result URL \${LOOP_URL})
`, (file) => {
      const parsed = parseCmakeLikeFile(file, "generic");
      assert.ok(!parsed.pkgList.some((c) => c.name === "dead" || c.name === "loop_result"));
      const literal = parsed.pkgList.find((c) => c.name === "loop_literal");
      assert.ok(literal.properties.some((p) => p.name === "cdx:cmake:conditions" && p.value.includes("foreach")));
    });
  });

  test("exposes conditional setup versions and exact project-owned constants without binding consumers", () => {
    withCmake(`project(example)
set(EXAMPLE_VERSION 2.8.0-dev)
set(VERSION_STRING 1.0.28)
if(VERSION_HELPER_FOUND)
rocm_setup_version(VERSION \${VERSION_STRING})
endif()
find_package(example)
`, (file) => {
      const parsed = parseCmakeLikeFile(file, "generic");
      const candidates = (parsed.parentComponent.properties || []).filter((p) => p.name === "cdx:cmake:versionCandidate").map((p) => JSON.parse(p.value));
      assert.ok(candidates.some((c) => c.kind === "project-constant" && c.version === "2.8.0-dev"));
      assert.ok(candidates.some((c) => c.kind === "setup-version" && c.version === "1.0.28"));
      assert.ok(!parsed.pkgList[0].version);
    });
  });

  test("uses parent JSON ownership through the explicit child directory, never a sibling's JSON", () => {
    withCmake("add_subdirectory(src)", (_file, dir) => {
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "version.json"), '{"example_backend_version":"0.4.0"}');
      const child = join(dir, "src", "CMakeLists.txt");
      writeFileSync(child, "example_setup_version(example_backend)\nproject(example_backend VERSION ${EXAMPLE_BACKEND_VERSION})");
      assert.equal(parseCmakeLikeFile(child, "generic", { sourceRoot: dir }).parentComponent.version, "0.4.0");
      writeFileSync(join(dir, "CMakeLists.txt"), "add_subdirectory(other)");
      assert.ok(!parseCmakeLikeFile(child, "generic", { sourceRoot: dir }).parentComponent.version);
    });
  });

  test("known local definitions keep unreachable fallback rewrites from invalidating a source version", () => {
    withCmake(`set(MAJOR 2)
if(NOT DEFINED MAJOR)
file(READ missing MAJOR)
endif()
project(example VERSION \${MAJOR}.32.3)
`, (file) => assert.equal(parseCmakeLikeFile(file, "generic").parentComponent.version, "2.32.3"));
  });

  test("same-pin aliases retain every declaration and conditional provenance", () => {
    withCmake(`if(PROFILE_A)
FetchContent_Declare(alias_one GIT_REPOSITORY https://github.com/example/owned.git GIT_TAG a818c5582d1d59db055baee8fdd831ddd8381823)
else()
FetchContent_Declare(alias_two GIT_REPOSITORY https://github.com/example/owned.git GIT_TAG a818c5582d1d59db055baee8fdd831ddd8381823)
endif()`, (file) => {
      const parsed = parseCmakeLikeFile(file, "generic");
      assert.equal(parsed.pkgList.length, 1);
      const requirements = parsed.pkgList[0].properties.filter((p) => p.name === "cdx:build:requirement").map((p) => JSON.parse(p.value));
      assert.deepEqual(new Set(requirements.filter((r) => r.role === "source-declaration").map((r) => r.requestedName)), new Set(["alias_one", "alias_two"]));
      assert.equal(new Set(requirements.filter((r) => r.role === "source-declaration").map((r) => JSON.stringify(r.conditions))).size, 2);
    });
  });

  test("source-only declarations use owned manifests and keep different local copies distinct", () => {
    withCmake(`ExternalProject_Add(schedule_one SOURCE_DIR one)
ExternalProject_Add(schedule_two SOURCE_DIR two)
find_package(owned)
`, (file, dir) => {
      for (const name of ["one", "two"]) {
        mkdirSync(join(dir, name));
        writeFileSync(join(dir, name, "CMakeLists.txt"), `project(owned VERSION ${name === "one" ? "1.2.3" : "2.0.0"})`);
      }
      const parsed = parseCmakeLikeFile(file, "generic");
      const sources = parsed.pkgList.filter((c) => c.properties.some((p) => p.name === "cdx:cmake:depKind"));
      assert.deepEqual(sources.map((c) => c.name), ["owned", "owned"]);
      assert.deepEqual(sources.map((c) => c.version), ["1.2.3", "2.0.0"]);
      assert.equal(new Set(sources.map((c) => c["bom-ref"])).size, 2);
      assert.ok(parsed.pkgList.some((c) => c.name === "owned" && !c.version));
    });
  });

  test("carries bounded included default alternatives into later source declarations", () => {
    withCmake('include("${CMAKE_CURRENT_SOURCE_DIR}/selectors.cmake")\nFetchContent_Declare(example URL ${SOURCE_URL})', (file, dir) => {
      writeFileSync(join(dir, "selectors.cmake"), 'if(OVERRIDE)\nset(SOURCE_URL https://example.org/example-2.0.0.tar.gz)\nelse()\nset(SOURCE_URL https://example.org/example-1.0.0.tar.gz)\nendif()');
      const sources = parseCmakeLikeFile(file, "generic").pkgList;
      assert.deepEqual(new Set(sources.map((c) => c.version)), new Set(["1.0.0", "2.0.0"]));
      assert.equal(new Set(sources.map((c) => c["bom-ref"])).size, 2);
      assert.ok(sources.every((c) => c.properties.some((p) => p.name === "cdx:cmake:conditions")));
    });
  });

  test("reads explicit numeric header fields, bounded version lines and package constants", () => {
    withCmake(`file(READ include/api.h HEADER)
string(REGEX MATCH "#define API_VERSION_MAJOR ([0-9]+)" _ "\${HEADER}")
set(MAJOR \${CMAKE_MATCH_1})
string(REGEX MATCH "#define API_VERSION_MINOR ([0-9]+)" _ "\${HEADER}")
set(MINOR \${CMAKE_MATCH_1})
project(api VERSION \${MAJOR}.\${MINOR}.0)
`, (file, dir) => {
      mkdirSync(join(dir, "include"));
      writeFileSync(join(dir, "include", "api.h"), "#define API_VERSION_MAJOR 2\n#define API_VERSION_MINOR 1\n");
      assert.equal(parseCmakeLikeFile(file, "generic").parentComponent.version, "2.1.0");
    });
    withCmake(`file(STRINGS VERSION FULL_VERSION_STRING LIMIT_COUNT 1)
if(NOT FULL_VERSION_STRING MATCHES "^([0-9]+)\\\\.([0-9]+)\\\\.([0-9]+)")
message(FATAL_ERROR "version")
endif()
project(api VERSION \${CMAKE_MATCH_1}.\${CMAKE_MATCH_2}.\${CMAKE_MATCH_3})
set(PACKAGE_NAME api)
set(PACKAGE_VERSION 11.0)
`, (file, dir) => {
      writeFileSync(join(dir, "VERSION"), "1.2.3-dev\n999.0.0\n");
      const parsed = parseCmakeLikeFile(file, "generic");
      assert.equal(parsed.parentComponent.version, "1.2.3");
      assert.ok(parsed.parentComponent.properties.some((p) => p.name === "cdx:cmake:versionCandidate" && JSON.parse(p.value).kind === "package-constant" && JSON.parse(p.value).version === "11.0"));
    });
  });

  test("keeps conditional project, package helper and ABI metadata as separate owned candidates", () => {
    withCmake(`if(WIN_SDK)
else()
set(OWNER hsakmt)
project(\${OWNER} VERSION 1.9.0)
get_version("1.0.0")
set(LIB_VERSION_MAJOR 1)
set(LIB_VERSION_MINOR 0)
if(ROCM_PATCH_VERSION)
set(LIB_VERSION_PATCH \${ROCM_PATCH_VERSION})
else()
set(LIB_VERSION_PATCH 6)
endif()
set_property(TARGET \${OWNER} PROPERTY VERSION \${LIB_VERSION_MAJOR}.\${LIB_VERSION_MINOR}.\${LIB_VERSION_PATCH})
set_property(TARGET \${OWNER} PROPERTY SOVERSION \${LIB_VERSION_MAJOR})
endif()
find_package(hsakmt)
`, (file) => {
      const parsed = parseCmakeLikeFile(file, "generic");
      assert.equal(parsed.parentComponent.name, "hsakmt");
      assert.ok(!parsed.parentComponent.version);
      const candidates = parsed.parentComponent.properties.filter((p) => p.name === "cdx:cmake:versionCandidate").map((p) => JSON.parse(p.value));
      assert.ok(candidates.some((p) => p.kind === "project" && p.version === "1.9.0"));
      assert.ok(candidates.some((p) => p.kind === "helper-argument" && p.version === "1.0.0"));
      assert.ok(candidates.some((p) => p.kind === "library-version" && p.version === "1.0.6"));
      assert.ok(candidates.some((p) => p.kind === "soversion" && p.version === "1"));
      assert.ok(!parsed.pkgList.find((c) => c.name === "hsakmt").version);
    });
  });

  test("retains conditional owned ref alternatives and refuses unrelated header regex captures", () => {
    withCmake(`file(READ pin.conf PIN)
if(UNKNOWN)
set(PIN 1111111111111111111111111111111111111111)
endif()
FetchContent_Declare(headers GIT_REPOSITORY https://github.com/example/headers.git GIT_TAG \${PIN})
`, (file, dir) => {
      writeFileSync(join(dir, "pin.conf"), "a818c5582d1d59db055baee8fdd831ddd8381823");
      const sources = parseCmakeLikeFile(file, "generic").pkgList;
      assert.deepEqual(new Set(sources.map((component) => component.version)), new Set(["a818c5582d1d59db055baee8fdd831ddd8381823", "1111111111111111111111111111111111111111"]));
      assert.ok(sources.every((component) => component.properties.some((property) => property.name === "cdx:cmake:conditions")));
    });
    withCmake(`file(READ version.h HEADER)
string(REGEX MATCH "#define EXAMPLE_VERSION [\\\"]([0-9]+)[\\\"]" UNUSED "\${HEADER}")
project(example VERSION \${CMAKE_MATCH_1})
`, (file, dir) => {
      writeFileSync(join(dir, "version.h"), '#define EXAMPLE_VERSION "3.14"');
      assert.ok(!parseCmakeLikeFile(file, "generic").parentComponent.version);
    });
  });

  test("retains conditional list-valued default repositories and raw download source identities", () => {
    withCmake(`set(GIT_SETTINGS GIT_REPOSITORY https://github.com/microsoft/DirectXShaderCompiler.git GIT_TAG main)
if(DXC_SOURCE_DIR)
  unset(GIT_SETTINGS)
endif()
ExternalProject_Add(DXC \${GIT_SETTINGS} SOURCE_DIR \${DXC_SOURCE_DIR})
if(NOT CMakeGet_FOUND)
  file(DOWNLOAD https://raw.githubusercontent.com/pfultz2/cmake-get/master/install.cmake \${FILENAME})
endif()
`, (file) => {
      const parsed = parseCmakeLikeFile(file, "generic");
      assert.ok(parsed.pkgList.some((c) => c.purl.startsWith("pkg:github/microsoft/directxshadercompiler") && !c.version));
      assert.ok(parsed.pkgList.some((c) => c.purl.includes("cmake-get") && !c.version));
      assert.ok(parsed.pkgList.every((c) => c.properties.some((p) => p.name === "cdx:cmake:conditional")));
    });
  });

  test("inherits exact selector bindings only through an owning add_subdirectory call", () => {
    withCmake('set(PIN a818c5582d1d59db055baee8fdd831ddd8381823)\nadd_subdirectory(child)\nset(PIN 1111111111111111111111111111111111111111)', (_file, dir) => {
      mkdirSync(join(dir, "child"));
      const child = join(dir, "child", "CMakeLists.txt");
      writeFileSync(child, 'FetchContent_Declare(headers GIT_REPOSITORY https://github.com/KhronosGroup/SPIRV-Headers.git GIT_TAG ${PIN})');
      assert.equal(parseCmakeLikeFile(child, "generic", { sourceRoot: dir }).pkgList[0].version, "a818c5582d1d59db055baee8fdd831ddd8381823");
      writeFileSync(join(dir, "CMakeLists.txt"), 'set(PIN 9999999999999999999999999999999999999999)');
      assert.ok(!parseCmakeLikeFile(child, "generic", { sourceRoot: dir }).pkgList[0].version);
    });
  });

  test("retains scoped archive defaults and hashes without selecting same-name consumers", () => {
    withCmake(`function(dependencies)
if(BUILD_TESTS)
  set(SQLITE_MIN_VERSION "3.51.3")
  string(REPLACE "." "_" SQLITE_VER_UNDERSCORE \${SQLITE_MIN_VERSION})
  if(DEFINED ENV{SQLITE_\${SQLITE_VER_UNDERSCORE}_SRC_URL})
    set(SQLITE_\${SQLITE_VER_UNDERSCORE}_SRC_URL_INIT $ENV{SQLITE_\${SQLITE_VER_UNDERSCORE}_SRC_URL})
  else()
    set(SQLITE_\${SQLITE_VER_UNDERSCORE}_SRC_URL_INIT https://sqlite.org/2026/sqlite-amalgamation-3510300.zip)
  endif()
  set(SQLITE_\${SQLITE_VER_UNDERSCORE}_SRC_URL \${SQLITE_\${SQLITE_VER_UNDERSCORE}_SRC_URL_INIT} CACHE STRING "source")
  set(SQLITE_SRC_\${SQLITE_VER_UNDERSCORE}_SHA3_256 ced02ff9738970f338c9c8e269897b554bcda73f6cf1029d49459e1324dbeaea CACHE STRING "hash")
  FetchContent_Declare(sqlite_local URL \${SQLITE_\${SQLITE_VER_UNDERSCORE}_SRC_URL} URL_HASH SHA3_256=\${SQLITE_SRC_\${SQLITE_VER_UNDERSCORE}_SHA3_256})
endif()
endfunction()
find_package(SQLite3 3.51.3 REQUIRED)
`, (file) => {
      const parsed = parseCmakeLikeFile(file, "generic");
      const source = parsed.pkgList.find((c) => c.name === "sqlite_local");
      assert.ok(source);
      assert.equal(source.version, "3.51.3");
      assert.deepEqual(source.hashes, [{ alg: "SHA3-256", content: "ced02ff9738970f338c9c8e269897b554bcda73f6cf1029d49459e1324dbeaea" }]);
      assert.ok(source.properties.some((p) => p.name === "cdx:cmake:conditions" && p.value.includes("ENV{SQLITE_")));
      assert.ok(!parsed.pkgList.find((c) => c.name === "SQLite3").version);
      assert.ok(parsed.requirements.find((r) => r.requestedName === "sqlite_local").providerCandidates.every((p) => !p.selected));
    });
  });

  test("reads an owned ref file in a conditional declaration but not arbitrary conditional tag writes", () => {
    withCmake(`if(NOT DEFINED EXTERNAL_SOURCE)
file(READ pin.conf PIN)
string(STRIP "\${PIN}" PIN)
FetchContent_Declare(headers GIT_REPOSITORY https://github.com/KhronosGroup/SPIRV-Headers.git GIT_TAG \${PIN})
endif()
`, (file, dir) => {
      writeFileSync(join(dir, "pin.conf"), "a818c5582d1d59db055baee8fdd831ddd8381823\n");
      const source = parseCmakeLikeFile(file, "generic").pkgList[0];
      assert.equal(source.version, "a818c5582d1d59db055baee8fdd831ddd8381823");
      assert.ok(source.properties.some((p) => p.name === "cdx:version:kind" && p.value === "source-revision"));
    });
  });

  test("extracts project-owned header and JSON data operations, never unrelated adjacent metadata", () => {
    withCmake(`project(example)
file(READ include/example_version.h HEADER)
string(REGEX MATCH "#define EXAMPLE_VERSION [\\\"]([^\\\"]+)[\\\"]" UNUSED "\${HEADER}")
set(PROJECT_VERSION "\${CMAKE_MATCH_1}")
`, (file, dir) => {
      mkdirSync(join(dir, "include"));
      writeFileSync(join(dir, "include", "example_version.h"), '#define EXAMPLE_VERSION "3.14"\n');
      assert.equal(parseCmakeLikeFile(file, "generic").parentComponent.version, "3.14");
    });
    withCmake(`file(READ version.json DATA)
string(JSON V GET "\${DATA}" example_version)
project(example VERSION \${V})
`, (file, dir) => {
      writeFileSync(join(dir, "version.json"), '{"example_version":"0.4.0","suite_version":"9.0"}');
      assert.equal(parseCmakeLikeFile(file, "generic").parentComponent.version, "0.4.0");
    });
    withCmake("project(example)", (file, dir) => {
      writeFileSync(join(dir, "version.json"), '{"version":"9.0"}');
      assert.ok(!parseCmakeLikeFile(file, "generic").parentComponent.version);
    });
  });

  test("retains complete Meson version constraints without turning them into release values", () => {
    withCmake("", (_file, dir) => {
      const file = join(dir, "meson.build");
      writeFileSync(file, "project('consumer')\ndependency('sample', version: '>= 1.0')\ndependency('sample', version: ['>=1.0', '<2.0'])\ndependency('sample', version: requested_version)\n");
      const parsed = parseCmakeLikeFile(file, "generic");
      assert.deepEqual(parsed.requirements.map((r) => r.constraints), [">= 1.0", "['>=1.0', '<2.0']", "requested_version"]);
      assert.ok(parsed.pkgList.every((c) => !c.version));
    });
  });
  test("literal arguments cannot suppress unrelated project versions or fetched pins", () => {
    for (const literal of [String.raw`\${LABEL}`, String.raw`"\${LABEL}"`, "[[${LABEL}]]"]) {
      withCmake(`set(V 1.2.3)\nset(LABEL 9.9.9)\nproject(example VERSION \${V} DESCRIPTION ${literal})`, (file) => {
        assert.equal(parseCmakeLikeFile(file, "generic").parentComponent.version, "1.2.3");
      });
      withCmake(`set(TAG 1.2.3)\nset(LABEL 9.9.9)\nFetchContent_Declare(example GIT_REPOSITORY https://github.com/acme/example.git GIT_TAG v\${TAG} PATCH_COMMAND echo ${literal})`, (file) => {
        const component = parseCmakeLikeFile(file, "generic").pkgList[0];
        assert.equal(component.version, "v1.2.3");
        assert.ok(component.properties.some((p) => p.name === "cdx:cmake:gitRef" && p.value === "v1.2.3"));
      });
    }
    for (const literal of [String.raw`\${TAG}`, String.raw`"\${TAG}"`, "[[${TAG}]]"]) {
      withCmake(`set(TAG 9.9.9)\nFetchContent_Declare(example GIT_REPOSITORY https://github.com/acme/example.git GIT_TAG ${literal} PATCH_COMMAND echo \${TAG})`, (file) => {
        const component = parseCmakeLikeFile(file, "generic").pkgList[0];
        assert.ok(!component.version);
        assert.ok(!component.properties.some((p) => p.name === "cdx:cmake:gitRef"));
      });
    }
  });

  test("retains real package provenance after escaped unquoted shell arguments without scraping examples", () => {
    withCmake(String.raw`if(BUILD_CODE_COVERAGE)
add_custom_target(coverage COMMAND test --gtest_filter=\"value\")
find_package(Python3 COMPONENTS Interpreter)
endif()
#[[ find_package(DocumentationOnly 9.0 EXACT) ]]
`, (file) => {
      const parsed = parseCmakeLikeFile(file, "generic");
      assert.deepEqual(parsed.pkgList.map((c) => c.name), ["Python3"]);
      assert.ok(parsed.pkgList[0].evidence.identity.methods.some((m) => m.value === `Filename ${file}`));
    });
    withCmake("set(V 9.0)\nproject(example VERSION \\${V})", (file) => {
      assert.ok(!parseCmakeLikeFile(file, "generic").parentComponent.version, "escaped variables remain literal, not fabricated numeric versions");
    });
  });

  test("retains a conditional repository download when only its build-target prefix is unresolved", () => {
    withCmake(`if(NOT PBM_PREFIX)
  set(PBM_PREFIX protobuf_mutator)
endif()
ExternalProject_Add(\${PBM_PREFIX}
  GIT_REPOSITORY https://github.com/google/libprotobuf-mutator.git
  GIT_TAG master
  BUILD_BYPRODUCTS \${PBM_LIB_PATH}
  INSTALL_COMMAND "")
find_package(libprotobuf-mutator REQUIRED)
`, (file) => {
      const parsed = parseCmakeLikeFile(file, "generic");
      const source = parsed.pkgList.find((c) => c.purl.startsWith("pkg:github/google/libprotobuf-mutator"));
      assert.ok(source, "a literal repository is not an invented dynamic target name");
      assert.equal(source.name, "libprotobuf-mutator");
      assert.ok(!source.version);
      assert.ok(source.properties.some((p) => p.name === "cdx:cmake:gitRef" && p.value === "master"));
      assert.ok(source.properties.some((p) => p.name === "cdx:cmake:conditional" && p.value === "true"));
      assert.ok(source.evidence.identity.methods.some((m) => m.value === `Filename ${file}`));
      assert.ok(parsed.requirements.some((r) => r.requestedName === "${PBM_PREFIX}" && r.role === "build-target" && r.providerCandidates.some((p) => p.ref === source["bom-ref"])));
      const alternatives = preferFetchedCmakeDependencies(parsed.pkgList);
      assert.equal(new Set(alternatives.map((entry) => entry["bom-ref"])).size, 2, "potential source and unresolved package remain distinct identities");
      assert.ok(alternatives.some((entry) => entry["bom-ref"] === source["bom-ref"]));
      assert.ok(alternatives.some((entry) => entry.name === "libprotobuf-mutator" && entry["bom-ref"] !== source["bom-ref"]));
      assert.ok(parsed.requirements.filter((entry) => entry.role === "software").every((entry) => entry.providerCandidates.every((candidate) => !candidate.selected)), "an evaluated conditional context never selects its source provider");
    });
  });

  test("retains literal fallback archives without selecting an unresolved override or versioning LibIberty", () => {
    withCmake(`find_package(LibIberty)
if(BUILD_FROM_SOURCE)
  set(_li_project_name application-libiberty-build)
  ExternalProject_Add(\${_li_project_name}
    URL \${DYNINST_BINUTILS_DOWNLOAD_URL}
      https://ftpmirror.gnu.org/gnu/binutils/binutils-2.46.0.tar.gz
      https://mirrors.kernel.org/sourceware/binutils/releases/binutils-2.46.0.tar.gz
    BUILD_COMMAND make all-libiberty
    INSTALL_COMMAND "")
endif()
`, (file) => {
      const parsed = parseCmakeLikeFile(file, "generic");
      const sources = parsed.pkgList.filter((c) => c.purl.includes("download_url="));
      assert.equal(sources.length, 2);
      assert.equal(new Set(sources.map((c) => c["bom-ref"])).size, 2);
      for (const source of sources) {
        assert.ok(source.purl.startsWith("pkg:generic/"));
        assert.equal(source.version, "2.46.0");
        assert.ok(source.name.includes("binutils"));
        assert.ok(source.properties.some((p) => p.name === "cdx:cmake:conditional" && p.value === "true"));
        assert.ok(source.properties.some((p) => p.name === "cdx:cmake:sourceRole" && p.value === "literal-fallback"));
        assert.ok(source.properties.some((p) => p.name === "cdx:cmake:unresolvedUrlOverride" && p.value === "true"));
        assert.ok(source.evidence.identity.methods.some((m) => m.value === `Filename ${file}`));
        assert.ok(!source.purl.includes("DYNINST") && !source.purl.includes("unknown"));
      }
      assert.ok(!parsed.pkgList.find((c) => c.name === "LibIberty").version);
      assert.equal(preferFetchedCmakeDependencies(parsed.pkgList).length, 3);
    });
  });

  test("ExternalProject consumes quoted keyword lists without losing source pins", () => {
    withCmake(`set(DOWNLOAD_ARGS "GIT_REPOSITORY;https://github.com/acme/owner.git;GIT_TAG;v1.2.3")
ExternalProject_Add(owner "\${DOWNLOAD_ARGS}")
`, (file) => {
      const parsed = parseCmakeLikeFile(file, "generic");
      assert.deepEqual(parsed.pkgList.map(({ name, version }) => ({ name, version })), [{ name: "owner", version: "v1.2.3" }]);
    });
  });

  test("ignores false branches and unresolved source targets while retaining concrete conditional pins", () => {
    withCmake(`if(FALSE)
  ExternalProject_Add(nope GIT_REPOSITORY https://github.com/acme/nope.git GIT_TAG v1.0.0)
endif()
ExternalProject_Add(local_build SOURCE_DIR \${LOCAL_SOURCE} DOWNLOAD_COMMAND "")
if(UNKNOWN)
  set(PIN v9.0.0)
  ExternalProject_Add(\${TARGET} GIT_REPOSITORY https://github.com/acme/example.git GIT_TAG \${PIN})
endif()
`, (file) => {
      const parsed = parseCmakeLikeFile(file, "generic");
      assert.equal(parsed.pkgList.length, 1);
      assert.equal(parsed.pkgList[0].name, "example");
      assert.equal(parsed.pkgList[0].version, "v9.0.0");
      assert.ok(parsed.pkgList[0].properties.some((p) => p.name === "cdx:cmake:gitRef" && p.value === "v9.0.0"));
      assert.ok(parsed.requirements.every((requirement) => !requirement.providerCandidates?.some((candidate) => candidate.selected)));
      assert.ok(parsed.pkgList[0].properties.some((p) => p.name === "cdx:cmake:conditional" && p.value === "true"));
    });
  });

  test("keeps same-repository nonnumeric fetch pins independent through normal parsing and preference", () => {
    const sha = "c044bb52ba85058d28afe2313be98d9fed02e293";
    const pins = ["rocm-6.4.1", "rocm-6.4.3", sha];
    const declarations = pins.map((pin) => `FetchContent_Declare(rocm_cmake_local GIT_REPOSITORY https://github.com/ROCm/rocm-cmake.git GIT_TAG ${pin})`);
    withCmake(declarations.join("\n"), (file, dir) => {
      const sameFile = parseCmakeLikeFile(file, "generic").pkgList;
      assert.equal(sameFile.length, 3, "one repository does not make different declarations the same source pin");
      const sightings = [];
      for (let index = 0; index < declarations.length + 1; index++) {
        const current = join(dir, `consumer-${index}.cmake`);
        writeFileSync(current, index === declarations.length ? declarations[0].replace("rocm_cmake_local", "alternate_target") : declarations[index]);
        sightings.push(...parseCmakeLikeFile(current, "generic").pkgList);
      }
      const retained = preferFetchedCmakeDependencies(sightings);
      assert.equal(retained.length, 3);
      assert.equal(new Set(retained.map((c) => c["bom-ref"])).size, 3);
      for (const [index, pin] of pins.entries()) {
        const item = retained.find((c) => c.properties.some((p) => p.name === "cdx:cmake:gitRef" && p.value === pin));
        assert.ok(item, `retain the actual declared Git ref ${pin}`);
        const files = item.evidence.identity.methods.map((m) => m.value);
        assert.ok(files.includes(`Filename ${join(dir, `consumer-${index}.cmake`)}`));
        assert.equal(files.length, index === 0 ? 2 : 1, "same pins may merge; different pins must not acquire each other's provenance");
        if (pin === sha) {
          assert.equal(item.version, sha);
          assert.ok(item.properties.some((p) => p.name === "cdx:version:kind" && p.value === "source-revision"));
        } else {
          assert.equal(item.version, pin);
          assert.ok(decodeURIComponent(item.purl).endsWith(`@${pin}`));
          assert.ok(!item.properties.some((p) => p.name === "cdx:version:kind" && p.value === "source-revision"));
        }
      }
    });
  });

  test("never publishes unresolved expansion markers as Git refs or versions", () => {
    withCmake('set(V 1.0.0)\nif(UNKNOWN)\nset(V 9.0.0)\nendif()\nFetchContent_Declare(example GIT_REPOSITORY https://github.com/acme/example.git GIT_TAG v${V})', (file) => {
      const parsed = parseCmakeLikeFile(file, "generic");
      assert.deepEqual(new Set(parsed.pkgList.map((component) => component.version)), new Set(["v1.0.0", "v9.0.0"]));
      assert.ok(parsed.pkgList.every((component) => !/[<$]/.test(component.purl + component.version)));
      assert.ok(parsed.requirements.every((requirement) => !requirement.providerCandidates?.some((candidate) => candidate.selected)));
    });
  });

  test("materializes compatible source alternatives and retains every incompatible repeated constraint", () => {
    for (const requirements of [
      ["1.0", "9.0 EXACT"], ["9.0 EXACT", "1.0"],
      ["1.0", "3.0"], ["3.0", "1.0"],
      ["1.0", "1.0...<2.0"], ["1.0...<2.0", "1.0"],
      ["1.0", "2.0 EXACT", "1.0...2.0"],
    ]) {
      withCmake(`project(example VERSION 2.0)\n${requirements.map((value, index) => `${index % 2 ? "find_dependency" : "find_package"}(example ${value} REQUIRED)`).join("\n")}`, (file, dir) => {
        const parsed = parseCmakeLikeFile(file, "generic");
        assert.equal(parsed.pkgList.length, requirements.length);
        assert.equal(new Set(parsed.pkgList.map((p) => p["bom-ref"])).size, requirements.length);
        assert.deepEqual(new Set(parsed.requirements.map((r) => r.constraints)), new Set(requirements));
        const source = { ...parsed.parentComponent, properties: [{ name: "cdx:cmake:subprojectDir", value: "." }] };
        const edges = [{ ref: "consumer", dependsOn: parsed.pkgList.map((p) => p["bom-ref"]) }];
        const result = reconcileCmakeSourceProjects(parsed.pkgList, [source], edges, dir);
        const actualRecords = result.pkgList.flatMap((component) => (component.properties || [])
          .filter((property) => property.name === "cdx:build:requirement").map((property) => JSON.parse(property.value)));
        assert.deepEqual(new Set(actualRecords.map((record) => record.constraints)), new Set(requirements));
        const compatible = requirements.filter((value) => ["1.0", "2.0 EXACT", "1.0...2.0"].includes(value));
        for (const component of result.pkgList) {
          const records = component.properties.filter((property) => property.name === "cdx:build:requirement").map((property) => JSON.parse(property.value));
          for (const record of records) if (record.constraints.endsWith(" EXACT")) {
            assert.equal(component.version, record.constraints.slice(0, -" EXACT".length));
            assert.ok(component.properties.some((property) => property.name === "cdx:version:kind" && property.value === "declared-exact"));
          }
          if (component.version === "2.0") assert.ok(records.every((record) => record.constraints !== "9.0 EXACT"));
        }
        assert.ok(result.pkgList.some((component) => component.version === "2.0"));
        assert.deepEqual(new Set(result.dependencies[0].dependsOn), new Set(result.pkgList.map((component) => component["bom-ref"])));
        assert.ok(actualRecords.filter((record) => compatible.includes(record.constraints) && !record.constraints.endsWith(" EXACT"))
          .every((record) => record.providerCandidates.some((candidate) => !candidate.selected)));
        assert.equal(source.version, "2.0");
      });
    }
  });

  test("fetch pins snapshot ordered bindings before and after local includes", () => {
    withCmake('set(V 1.0.0)\nFetchContent_Declare(example GIT_REPOSITORY https://github.com/acme/example.git GIT_TAG v${V})\ninclude("${CMAKE_CURRENT_SOURCE_DIR}/ExampleVersion.cmake")', (file, dir) => {
      writeFileSync(join(dir, "ExampleVersion.cmake"), "set(V 2.0.0)");
      assert.equal(parseCmakeLikeFile(file, "generic").pkgList[0].version, "v1.0.0");
    });
    withCmake(`set(V 1.0.0)
FetchContent_Declare(before GIT_REPOSITORY https://github.com/acme/before.git GIT_TAG v\${V})
include("\${CMAKE_CURRENT_SOURCE_DIR}/ExampleVersion.cmake")
FetchContent_Declare(after GIT_REPOSITORY https://github.com/acme/after.git GIT_TAG v\${V})
unset(V)
FetchContent_Declare(unknown GIT_REPOSITORY https://github.com/acme/unknown.git GIT_TAG v\${V})
set(V 9.0.0)
`, (file, dir) => {
      writeFileSync(join(dir, "ExampleVersion.cmake"), "set(V 2.0.0)");
      const packages = parseCmakeLikeFile(file, "generic").pkgList;
      assert.equal(packages.find((p) => p.name === "before").version, "v1.0.0");
      assert.equal(packages.find((p) => p.name === "after").version, "v2.0.0");
      assert.ok(!packages.find((p) => p.name === "unknown").version);
      for (const p of packages) assert.ok(p.evidence.identity.methods.some((method) => method.value === `Filename ${file}`));
      writeFileSync(join(dir, "ExampleVersion.cmake"), "if(UNKNOWN)\nset(V 8.0.0)\nendif()");
      const tainted = parseCmakeLikeFile(file, "generic").pkgList;
      assert.equal(tainted.find((p) => p.name === "before").version, "v1.0.0");
      const after = tainted.filter((component) => component.name === "after");
      assert.deepEqual(new Set(after.map((component) => component.version)), new Set(["v1.0.0", "v8.0.0"]));
      assert.ok(after.every((component) => component.properties.some((property) => property.name === "cdx:cmake:conditions")));
    });
  });

  test("unsupported READ options invalidate rather than publish whole-file versions", () => {
    for (const options of ["LIMIT 3", "OFFSET 2", "HEX", "LIMIT", "UNKNOWN 3", "OFFSET 0 LIMIT 3 HEX"]) {
      withCmake(`set(V 9.0.0)\nfile(READ VERSION V ${options})\nproject(example VERSION \${V})`, (file, dir) => {
        writeFileSync(join(dir, "VERSION"), "1.2.3");
        assert.ok(!parseCmakeLikeFile(file, "generic").parentComponent.version);
      });
    }
    withCmake("file(READ VERSION V LIMIT 3)\nset(V 2.0.0)\nproject(example VERSION ${V})", (file, dir) => {
      writeFileSync(join(dir, "VERSION"), "1.2.3");
      assert.equal(parseCmakeLikeFile(file, "generic").parentComponent.version, "2.0.0");
    });
  });

  test("ordered aliases cannot resurrect cleared or tainted bindings", () => {
    for (const mutation of ["set(V)", "unset(V)", "if(UNKNOWN)\nset(V 9.0.0)\nendif()"]) {
      withCmake(`set(BASE 1.2.3)\nset(V "\${BASE}")\n${mutation}\nproject(example VERSION \${V})`,
        (file) => assert.ok(!parseCmakeLikeFile(file, "generic").parentComponent.version));
    }
    withCmake("set(V 1.0.0)\nproject(example VERSION ${V})\nset(V 9.0.0)",
      (file) => assert.equal(parseCmakeLikeFile(file, "generic").parentComponent.version, "1.0.0"));
  });

  test("file reads and includes obey later writes and their declaration positions", () => {
    for (const [tail, expected] of [["unset(V)", undefined], ["set(V)", undefined], ["set(V 2.0.0)", "2.0.0"]]) {
      withCmake(`file(READ VERSION V)\n${tail}\nproject(example VERSION \${V})`, (file, dir) => {
        writeFileSync(join(dir, "VERSION"), "1.2.3");
        assert.equal(parseCmakeLikeFile(file, "generic").parentComponent.version || undefined, expected);
      });
    }
    withCmake('set(V 1.0.0)\ninclude("${CMAKE_CURRENT_SOURCE_DIR}/ExampleVersion.cmake")\nproject(example VERSION ${V})', (file, dir) => {
      writeFileSync(join(dir, "ExampleVersion.cmake"), "set(V 2.0.0)");
      assert.equal(parseCmakeLikeFile(file, "generic").parentComponent.version, "2.0.0");
      writeFileSync(join(dir, "ExampleVersion.cmake"), "if(UNKNOWN)\nset(V 8.0.0)\nendif()");
      assert.ok(!parseCmakeLikeFile(file, "generic").parentComponent.version);
    });
  });

  test("rejects name-only providers and incompatible declared source versions", () => {
    const source = { name: "example", version: "2.0", "bom-ref": "source", properties: [{ name: "cdx:cmake:subprojectDir", value: "vendor/example" }] };
    const requirement = (file, version) => ({ name: "example", "bom-ref": "requirement",
      properties: version ? [{ name: "cdx:cmake:versionRequirements", value: version }] : [],
      evidence: { identity: { methods: [{ value: `Filename /scan/${file}/CMakeLists.txt` }] } } });
    const unrelated = requirement("app");
    assert.deepEqual(reconcileCmakeSourceProjects([unrelated], [source], [], "/scan").pkgList, [unrelated]);
    for (const version of ["9.0 EXACT", "3.0", "1.0...<2.0"]) {
      const unknown = requirement("vendor/example/tests", version);
      const edges = [{ ref: "consumer", dependsOn: ["requirement"] }];
      const result = reconcileCmakeSourceProjects([unknown], [source], edges, "/scan");
      assert.deepEqual(result.pkgList, [unknown]);
      assert.deepEqual(result.dependencies, edges);
    }
    const revision = { ...source, version: "abcdef0123456789abcdef0123456789abcdef01", properties: [...source.properties, { name: "cdx:version:kind", value: "source-revision" }] };
    const constrained = requirement("vendor/example/tests", "1.0");
    assert.deepEqual(reconcileCmakeSourceProjects([constrained], [revision], [], "/scan").pkgList, [constrained]);
    assert.equal(source.version, "2.0");
  });

  test("keeps parsed incompatible CMake consumers separate from the known source release", () => {
    for (const requirement of ["9.0 EXACT", "3.0", "1.0...<2.0"]) {
      withCmake(`project(example VERSION 2.0)\nfind_package(example ${requirement} REQUIRED)`, (file, dir) => {
        const parsed = parseCmakeLikeFile(file, "generic");
        const source = { ...parsed.parentComponent, properties: [{ name: "cdx:cmake:subprojectDir", value: "." }] };
        const unknown = parsed.pkgList.find((component) => component.name === "example");
        const edges = [{ ref: "consumer", dependsOn: [unknown["bom-ref"]] }];
        const result = reconcileCmakeSourceProjects([unknown], [source], edges, dir);
        assert.deepEqual(result.pkgList, [unknown]);
        assert.deepEqual(result.dependencies, edges);
        assert.equal(source.version, "2.0");
      });
    }
  });

  test("does not inherit wraps from outside the nearest independent Meson project", () => {
    withCmake("", (_file, dir) => {
      mkdirSync(join(dir, "subprojects"));
      mkdirSync(join(dir, "independent"));
      writeFileSync(join(dir, "meson.build"), "project('outer')");
      writeFileSync(join(dir, "subprojects", "example.wrap"), "[wrap-file]\ndirectory = example-1.2.3\nsource_filename = example-1.2.3.tar.gz");
      const file = join(dir, "independent", "meson.build");
      writeFileSync(file, "project('independent')\ndependency('example')");
      assert.ok(!parseCmakeLikeFile(file, "generic", { sourceRoot: dir }).pkgList[0].version);
    });
  });

  test("does not turn conditional, cleared or bracket-literal bindings into releases", () => {
    for (const text of [
      "set(V 1.0.0)\nif(FALSE)\nset(V 9.0.0)\nendif()\nunset(V)\nproject(example VERSION ${V})",
      "set(V 1.0.0)\nif(UNKNOWN_BUILD_OPTION)\nset(V 9.0.0)\nendif()\nproject(example VERSION ${V})",
      "set(V 1.0.0)\nset(V)\nproject(example VERSION ${V})",
      "set(V 1.0.0)\nproject(example VERSION [[${V}]])",
    ]) {
      withCmake(text, (file) => assert.ok(!parseCmakeLikeFile(file, "generic").parentComponent.version));
    }
    withCmake("set(V 1.0.0)\nif(FALSE)\nset(V 9.0.0)\nendif()\nproject(example VERSION ${V})",
      (file) => assert.equal(parseCmakeLikeFile(file, "generic").parentComponent.version, "1.0.0"));
  });
  test("uses include list-directory context without treating bare modules as local files", () => {
    withCmake('include("${CMAKE_CURRENT_SOURCE_DIR}/cmake/ExampleVersion.cmake")\nproject(example VERSION ${V})', (file, dir) => {
      mkdirSync(join(dir, "cmake"));
      writeFileSync(join(dir, "cmake", "ExampleVersion.cmake"), 'include("${CMAKE_CURRENT_LIST_DIR}/ActualVersion.cmake")');
      writeFileSync(join(dir, "cmake", "ActualVersion.cmake"), "set(V 2.4.6)");
      assert.equal(parseCmakeLikeFile(file, "generic").parentComponent.version, "2.4.6");
      writeFileSync(join(dir, "cmake", "ActualVersion.cmake"), "if(UNKNOWN)\nset(V 8.8.8)\nendif()");
      assert.ok(!parseCmakeLikeFile(file, "generic").parentComponent.version);
    });
  });


  test("reads project version expressions through the setup macro", () => {
    withCmake(`project(example LANGUAGES CXX)
set(MAJOR 3)
set(MINOR 6)
set(PATCH 3)
set(VERSION_STRING "${"${MAJOR}"}.${"${MINOR}"}.${"${PATCH}"}")
rocm_setup_version(VERSION ${"${VERSION_STRING}"})
`, (file) => {
      assert.equal(parseCmakeLikeFile(file, "generic").parentComponent.version, "3.6.3");
    });
  });

  test("reads only bounded local version files explicitly used by the project", () => {
    withCmake(`file(READ "${"${CMAKE_CURRENT_SOURCE_DIR}"}/VERSION" FULL_VERSION)
project(example VERSION ${"${FULL_VERSION}"} LANGUAGES C)
`, (file, dir) => {
      writeFileSync(join(dir, "VERSION"), "1.5.0\n");
      assert.equal(parseCmakeLikeFile(file, "generic").parentComponent.version, "1.5.0");
    });
  });

  test("reads local included version modules and retains development suffixes", () => {
    withCmake(`include("${"${CMAKE_CURRENT_SOURCE_DIR}"}/ExampleVersion.cmake")
project(Example VERSION ${"${EXAMPLE_VERSION_MAJOR}"}.${"${EXAMPLE_VERSION_MINOR}"}.${"${EXAMPLE_VERSION_PATCH}"})
`, (file, dir) => {
      writeFileSync(join(dir, "ExampleVersion.cmake"), "set(EXAMPLE_VERSION_MAJOR 24)\nset(EXAMPLE_VERSION_MINOR 0)\nset(EXAMPLE_VERSION_PATCH 0)\nset(EXAMPLE_VERSION_SUFFIX git)\n");
      assert.equal(parseCmakeLikeFile(file, "generic").parentComponent.version, "24.0.0git");
    });
  });

  test("pairs a setup-macro component with its exact adjacent JSON version key", () => {
    withCmake("example_setup_version(example_backend)", (file, dir) => {
      writeFileSync(join(dir, "version.json"), JSON.stringify({ example_backend_version: "0.4.0" }));
      assert.equal(parseCmakeLikeFile(file, "generic").parentComponent.version, "0.4.0");
    });
  });

  test("retains owning-project wraps as candidates rather than assuming a fallback was selected", () => {
    withCmake("", (_file, dir) => {
      mkdirSync(join(dir, "subprojects"));
      mkdirSync(join(dir, "nested"));
      writeFileSync(join(dir, "subprojects", "example.wrap"), "[wrap-file]\ndirectory = example-2.3.4\nsource_filename = example-2.3.4.tar.gz\n[provide]\nexample = example_dep\n");
      const file = join(dir, "nested", "meson.build");
      writeFileSync(file, "dependency('example')\ndependency(some_variable)\ndependency('prefix_' + variable)\n");
      const result = parseCmakeLikeFile(file, "generic", { sourceRoot: dir });
      assert.equal(result.pkgList.length, 1);
      assert.ok(!result.pkgList[0].version);
      assert.ok(result.requirements.some((r) => r.requestedName === "example" && r.providerCandidates.some((p) => p.kind === "local-wrap" && p.name === "example" && !p.selected)));
      assert.ok(result.requirements.some((r) => r.role === "unresolved-expression" && r.requestedName === "some_variable"));
    });
  });

  test("parses commands rather than C strings, comments, options and macro placeholders", () => {
    withCmake(`file(WRITE test.c "int dependency(void) { return 42; }")
# find_package(NotAPackage)
find_package(
  RealDependency 1.2
  REQUIRED COMPONENTS InternalTarget
)
find_library(NUMALIB NAME numa REQUIRED)
find_library(FRT NAMES FortranRuntime PATH /some/sysroot/lib)
find_file(DISTRO debian_version PATHS /etc)
ExternalProject_Add(${"${target}"} SOURCE_DIR ${"${source}"})
`, (file) => {
      const { pkgList } = parseCmakeLikeFile(file, "generic");
      assert.deepEqual(pkgList.map((p) => p.name).sort(), ["FortranRuntime", "RealDependency", "numa"].sort());
      const dependency = pkgList.find((p) => p.name === "RealDependency");
      assert.ok(!dependency.version);
      assert.ok(dependency.properties.some((p) => p.name === "cdx:cmake:versionRequirements" && p.value === "1.2"));
    });
  });

  test("reconciles source identity and every dependency reference", () => {
    const source = { name: "example", version: "2.4.0", "bom-ref": "pkg:generic/example@2.4.0", purl: "pkg:generic/example@2.4.0", properties: [{ name: "cdx:cmake:subprojectDir", value: "libs/example" }] };
    const unknown = { name: "Example", "bom-ref": "pkg:generic/Example", properties: [{ name: "cdx:cmake:versionRequirements", value: "2.0" }], evidence: { identity: { methods: [{ value: "Filename /scan/libs/example/tests/CMakeLists.txt" }] } } };
    unknown.properties.push({ name: "cdx:build:requirement", value: JSON.stringify({ requestedName: "Example", file: "libs/example/tests/CMakeLists.txt", line: 1, command: "find_package", role: "software", constraints: "2.0", conditions: [], providerCandidates: [{ kind: "selected-provider", ref: source["bom-ref"], selected: true }] }) });
    const dependencies = [{ ref: "root", dependsOn: [unknown["bom-ref"]] }, { ref: unknown["bom-ref"], dependsOn: ["other"] }];
    const result = reconcileCmakeSourceProjects([unknown], [source], dependencies, "/scan");
    assert.deepEqual(result.pkgList, [source]);
    assert.deepEqual(result.dependencies, [{ ref: "root", dependsOn: [source["bom-ref"]] }, { ref: source["bom-ref"], dependsOn: ["other"] }]);
    assert.ok(source.properties.some((p) => p.name === "cdx:cmake:versionRequirements"));
    assert.ok(source.evidence.identity.methods.length);
  });

  test("refuses competing source versions without a scoped match", () => {
    const unknown = { name: "example", "bom-ref": "unresolved", evidence: { identity: { methods: [{ value: "Filename /scan/app/CMakeLists.txt" }] } } };
    const projects = ["1.0", "2.0"].map((version) => ({ name: "example", version, "bom-ref": `example-${version}`, properties: [{ name: "cdx:cmake:subprojectDir", value: `vendor/${version}` }] }));
    const result = reconcileCmakeSourceProjects([unknown], projects, [], "/scan");
    assert.deepEqual(result.pkgList, [unknown]);
    assert.ok(!unknown.version);
  });
  test("reads numeric version captures without evaluating arbitrary project regexes", () => {
    withCmake([
      'file(READ VERSION FULL_VERSION)',
      'string(REGEX REPLACE "([0-9]+)\\\\.([0-9]+)\\\\.([0-9]+)(.*)" "\\\\1.\\\\2.\\\\3" LIB_VERSION "${FULL_VERSION}")',
      'project(example VERSION ${LIB_VERSION})',
    ].join("\n"), (file, dir) => {
      writeFileSync(join(dir, "VERSION"), "0.7.0\n");
      assert.equal(parseCmakeLikeFile(file, "generic").parentComponent.version, "0.7.0");
    });
  });

  test("reads explicit numeric Make version fields consumed by MATCHES captures", () => {
    const fields = ["MAJOR", "MINOR", "PATCH"];
    const commands = ['file(READ version.mk version_text)', 'project(example)'];
    for (const field of fields) {
      commands.push(`if("\${version_text}" MATCHES "LIB_${field} *:= *([0-9]*)")`,
        `set(LIB_${field} \${CMAKE_MATCH_1})`, "endif()");
    }
    commands.push('set(VERSION_STRING "${LIB_MAJOR}.${LIB_MINOR}.${LIB_PATCH}")',
      'rocm_setup_version(VERSION ${VERSION_STRING})');
    withCmake(commands.join("\n"), (file, dir) => {
      writeFileSync(join(dir, "version.mk"), "LIB_MAJOR := 2\nLIB_MINOR := 32\nLIB_PATCH := 3\n");
      assert.equal(parseCmakeLikeFile(file, "generic").parentComponent.version, "2.32.3");
    });
  });

  test("submodule presence alone never selects an installed provider for its tests", () => {
    const revision = "abcdef0123456789abcdef0123456789abcdef01";
    const source = { name: "example", version: revision, "bom-ref": "source", properties: [
      { name: "cdx:cmake:depKind", value: "submodule" },
      { name: "cdx:cmake:sourceDir", value: "vendor/example" },
    ] };
    const dependency = (name) => ({ name, "bom-ref": name, evidence: { identity: { methods: [{ value: `Filename /scan/${name === "example" ? "vendor/example/tests" : "app"}/CMakeLists.txt` }] } } });
    const external = dependency("unrelated");
    const local = dependency("example");
    const result = reconcileCmakeSourceProjects([local, external, source], [source], [], "/scan");
    assert.deepEqual(result.pkgList, [local, external, source]);
    assert.ok(!external.version && !local.version);
    assert.ok(!source.properties.some((p) => p.name === "cdx:cmake:resolvedVia"));
  });
  test("does not execute unused project/version definitions or publish branch names as versions", () => {
    withCmake('function(unused)\nset(PROJECT_VERSION 9.9.9)\nproject(NotAnExecutedProject VERSION ${PROJECT_VERSION})\nendfunction()\nFetchContent_Declare(external GIT_REPOSITORY https://example.invalid/external.git GIT_TAG main)\n', (file) => {
      const parsed = parseCmakeLikeFile(file, "generic");
      assert.ok(!parsed.parentComponent.name);
      assert.ok(!parsed.pkgList[0].version);
      assert.ok(parsed.pkgList[0].properties.some((p) => p.name === "cdx:cmake:gitRef" && p.value === "main"));
    });
  });

  test("uses an explicit PROJECT_VERSION assignment without a project VERSION argument", () => {
    withCmake('project(example)\nset(EXAMPLE_PROJECT_VERSION 1.5.0)\nset(PROJECT_VERSION "${EXAMPLE_PROJECT_VERSION}")\n', (file) => {
      assert.equal(parseCmakeLikeFile(file, "generic").parentComponent.version, "1.5.0");
    });
  });
  test("final source pass binds every compatible occurrence and rewrites one-to-many graph edges", () => {
    withCmake("", (_file, dir) => {
      const owners = ["1.0", "2.0"].map((version) => {
        const sourceDir = `vendor/${version}`;
        mkdirSync(join(dir, sourceDir), { recursive: true });
        writeFileSync(join(dir, sourceDir, "CMakeLists.txt"), "project(Owner)\nadd_library(actual SHARED actual.c)\nrocm_export_targets(TARGETS actual NAME public)");
        return { name: "Owner", version, "bom-ref": `owner-${version}`, properties: [{ name: "cdx:cmake:sourceDir", value: sourceDir }] };
      });
      const record = (constraints, ordinal) => ({ requestedName: "public", command: "find_package", file: "app/CMakeLists.txt", line: ordinal, ordinal, role: "software", constraints, conditions: [], providerCandidates: [] });
      const pkg = { name: "public", "bom-ref": "request", properties: ["1.0", "9.0 EXACT"].map((constraint, index) => ({ name: "cdx:build:requirement", value: JSON.stringify(record(constraint, index + 1)) })) };
      const result = reconcileNativeSourceProviders([pkg, ...owners], [{ ref: "root", dependsOn: ["request"] }, { ref: "request", dependsOn: ["leaf"], provides: ["provided"] }], dir);
      assert.deepEqual(new Set(result.refMap.get("request")), new Set(["owner-1.0", "owner-2.0"]));
      assert.deepEqual(new Set(result.dependencies.find((entry) => entry.ref === "root").dependsOn), new Set(["owner-1.0", "owner-2.0"]));
      assert.equal(result.unresolved.length, 1);
      assert.ok(!result.pkgList.some((entry) => entry["bom-ref"] === "request"));
      for (const owner of owners) {
        assert.ok(owner.properties.some((entry) => entry.name === "cdx:build:requirement" && JSON.parse(entry.value).constraints === "1.0"));
        assert.ok(owner.properties.some((entry) => entry.name === "cdx:build:requirement" && JSON.parse(entry.value).constraints === "9.0 EXACT" &&
          JSON.parse(entry.value).providerCandidates.some((candidate) => candidate.compatibility === "violated" && !candidate.selected)));
        assert.ok(result.dependencies.find((entry) => entry.ref === owner["bom-ref"]).provides.includes("provided"));
      }
    });
  });

  test("final source pass permits unconstrained revision exports without inventing releases", () => {
    withCmake("project(Owner)\nrocm_export_targets(TARGETS owned NAME public)", (_file, dir) => {
      const revision = "abcdef0123456789abcdef0123456789abcdef0123";
      const owner = { name: "Owner", version: revision, "bom-ref": "source", properties: [{ name: "cdx:cmake:sourceDir", value: "." }, { name: "cdx:version:kind", value: "source-revision" }] };
      const requirement = { name: "public", "bom-ref": "unresolved", properties: [{ name: "cdx:build:requirement", value: JSON.stringify({ requestedName: "public", command: "find_package", file: "app/CMakeLists.txt", role: "software", constraints: "", providerCandidates: [] }) }] };
      const result = reconcileNativeSourceProviders([requirement, owner], [], dir);
      assert.deepEqual(result.pkgList, [owner]);
      assert.deepEqual(result.refMap.get("unresolved"), ["source"]);
      assert.equal(owner.version, revision);
    });
  });
  test("final source pass includes the metadata parent without emitting it as a dependency component", () => {
    withCmake("project(Owner)\nrocm_export_targets(TARGETS owned NAME public)", (_file, dir) => {
      const parent = { name: "Owner", version: "2.0", "bom-ref": "root", properties: [] };
      const requirement = { name: "public", "bom-ref": "unresolved", properties: [{ name: "cdx:build:requirement", value: JSON.stringify({ requestedName: "public", command: "find_package", file: "app/CMakeLists.txt", role: "software", constraints: "", providerCandidates: [] }) }] };
      const result = reconcileNativeSourceProviders([requirement], [], dir, { parentComponent: parent });
      assert.deepEqual(result.pkgList, []);
      assert.deepEqual(result.refMap.get("unresolved"), ["root"]);
      assert.ok(parent.properties.some((entry) => entry.name === "cdx:build:requirement"));
    });
  });
  test("materializes independent indexed project owners with their exact repository revision, never an ancestor numeric release", () => {
    withCmake("", (_file, dir) => {
      const sourceDir = "repository/compiler";
      mkdirSync(join(dir, sourceDir), { recursive: true });
      const manifest = join(dir, sourceDir, "CMakeLists.txt");
      writeFileSync(manifest, "project(Compiler)\nadd_library(CompilerSupport SHARED support.c)\ninstall(TARGETS CompilerSupport)");
      const revision = "abcdef0123456789abcdef0123456789abcdef0123";
      const root = { name: "repository", version: revision, "bom-ref": "repository-revision", properties: [{ name: "cdx:cmake:sourceDir", value: "repository" }, { name: "cdx:version:kind", value: "source-revision" }] };
      const declaration = { name: "Compiler", "bom-ref": "unversioned-project", properties: [{ name: "cdx:cmake:projectFile", value: `${sourceDir}/CMakeLists.txt` }] };
      const requirement = { name: "CompilerSupport", "bom-ref": "requirement", properties: [{ name: "cdx:build:requirement", value: JSON.stringify({ requestedName: "CompilerSupport", command: "find_library", file: "consumer/CMakeLists.txt", role: "software", constraints: "", providerCandidates: [] }) }] };
      const result = reconcileNativeSourceProviders([requirement, root], [], dir, { nativeSourceProjects: [declaration], nativeSourceManifests: [manifest] });
      const provider = result.pkgList.find((component) => component.name === "Compiler");
      assert.equal(provider.version, revision);
      assert.ok(provider.properties.some((entry) => entry.name === "cdx:version:kind" && entry.value === "source-revision"));
      assert.equal(declaration.version, undefined);
      assert.deepEqual(result.refMap.get("requirement"), [provider["bom-ref"]]);
      const numericRoot = { ...root, version: "99.0", properties: [{ name: "cdx:cmake:sourceDir", value: "repository" }, { name: "cdx:version:kind", value: "release" }] };
      const numericRequirement = structuredClone(requirement);
      const rejected = reconcileNativeSourceProviders([numericRequirement, numericRoot], [], dir, { nativeSourceProjects: [declaration], nativeSourceManifests: [manifest] });
      assert.ok(rejected.pkgList.includes(numericRequirement));
      assert.equal(rejected.bindings.length, 0);
    });
  });

  test("an indexed project's own explicit release wins without mutating source declarations", () => {
    withCmake("", (_file, dir) => {
      mkdirSync(join(dir, "repository/library"), { recursive: true });
      const manifest = join(dir, "repository/library/CMakeLists.txt");
      writeFileSync(manifest, "project(Owned VERSION 2.3.4)\nadd_library(actual SHARED actual.c)\ninstall(TARGETS actual)");
      const owner = { name: "Owned", "bom-ref": "project-before", properties: [{ name: "cdx:cmake:projectFile", value: "repository/library/CMakeLists.txt" }] };
      const requirement = { name: "actual", "bom-ref": "requirement", properties: [{ name: "cdx:build:requirement", value: JSON.stringify({ requestedName: "actual", command: "find_library", file: "consumer/CMakeLists.txt", role: "software", constraints: "", providerCandidates: [] }) }] };
      const result = reconcileNativeSourceProviders([requirement], [], dir, { nativeSourceProjects: [owner], nativeSourceManifests: [manifest] });
      assert.equal(result.pkgList[0].name, "Owned");
      assert.equal(result.pkgList[0].version, "2.3.4");
      assert.equal(owner.version, undefined);
    });
  });
  for (const mode of ["tracked", "untracked-source", "untracked-manifest", "changed-source", "hidden-change"]) test(`nested executable replay with ${mode} evidence`, () => {
    withCmake("project(Suite VERSION 4.7)\nif(ENABLE_CLIENTS)\nadd_subdirectory(clients)\nendif()", (file, dir) => {
      const client = join(dir, "clients/CMakeLists.txt");
      mkdirSync(join(dir, "clients"));
      writeFileSync(join(dir, "convert.cpp"), "int main() {}");
      writeFileSync(client, `project(Client)
execute_process(COMMAND \${CMAKE_CXX_COMPILER} \${CMAKE_SOURCE_DIR}/convert.cpp -o \${PROJECT_BINARY_DIR}/convert.stage)
add_custom_command(OUTPUT \${PROJECT_BINARY_DIR}/converter
  COMMAND \${CMAKE_COMMAND} -E copy \${PROJECT_BINARY_DIR}/convert.stage \${PROJECT_BINARY_DIR}/converter
  DEPENDS \${PROJECT_BINARY_DIR}/convert.stage)`);
      const search = join(dir, "search.cmake");
      writeFileSync(search, "find_program(CONVERTER NAMES converter)");
      const git = (...args) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
        "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      git("init", "-q");
      git("add", "CMakeLists.txt", "search.cmake");
      if (mode !== "untracked-source") git("add", "convert.cpp");
      if (mode !== "untracked-manifest") git("add", "clients/CMakeLists.txt");
      git("commit", "-qm", "fixture");
      const head = git("rev-parse", "HEAD");
      if (mode === "hidden-change") git("update-index", "--assume-unchanged", "--", "convert.cpp");
      if (mode === "changed-source" || mode === "hidden-change") writeFileSync(join(dir, "convert.cpp"), "int main() { return 1; }");
      const project = parseCmakeLikeFile(file, "generic", { sourceRoot: dir }).parentComponent;
      project.properties = [...(project.properties || []), { name: "cdx:cmake:projectFile", value: "CMakeLists.txt" }];
      const inputs = parseCmakeLikeFile(search, "generic", { sourceRoot: dir }).pkgList;
      const preliminary = reconcileCmakeSourceProjects(inputs, [project], [], dir);
      const result = reconcileNativeSourceProviders(preliminary.pkgList, [], dir,
        { nativeSourceProjects: [project], nativeSourceManifests: [file, client, search] });
      const [{ candidates }] = result.unresolved;
      if (mode !== "tracked") {
        assert.deepEqual(candidates, []);
        return;
      }
      assert.equal(candidates.length, 1);
      const owner = result.pkgList.find((component) => component["bom-ref"] === candidates[0].ref);
      assert.equal(owner.name, "Suite");
      assert.equal(owner.version, "4.7");
      assert.equal(candidates[0].compatibility, "unknown");
      const [entry] = candidates[0].exports;
      assert.equal(entry.sourceRevision, head);
      assert.deepEqual(entry.conditions, ["if(ENABLE_CLIENTS)"]);
      assert.match(entry.subdirectoryReplaySource, /CMakeLists\.txt:3$/);
    });
  });

  test("source-owned script evidence follows the exact helper lookup, not a same-name sibling search", () => {
    withCmake("project(Root)", (file, dir) => {
      const files = [file];
      const inputs = [];
      for (const [directory, version] of [["first", "2.1"], ["second", "3.4"], ["other", "9.9"]]) {
        mkdirSync(join(dir, directory, "cmake"), { recursive: true });
        const manifest = join(dir, directory, "CMakeLists.txt");
        const helper = join(dir, directory, "cmake/utility.cmake");
        writeFileSync(manifest, `project(${directory} VERSION ${version})\ninclude(cmake/utility.cmake)\n`);
        writeFileSync(helper, `function(check_source)
if(ENABLE_LOCAL_CHECK)
  find_program(LOCAL_CHECK NAMES verify-source.sh PATHS \${CMAKE_CURRENT_SOURCE_DIR}/cmake)
endif()
find_program(OTHER_CHECK NAMES verify-source.sh)
endfunction()
`);
        if (directory !== "other" || process.platform !== "win32") {
          const script = join(dir, directory, "cmake/verify-source.sh");
          writeFileSync(script, "#!/bin/sh\n");
          chmodSync(script, directory === "other" ? 0o644 : 0o755);
        }
        files.push(manifest, helper);
        inputs.push(...parseCmakeLikeFile(helper, "generic", { sourceRoot: dir }).pkgList);
      }
      const result = reconcileNativeSourceProviders(inputs, [], dir, { nativeSourceManifests: files });
      const rows = result.unresolved.map(({ requirement, candidates }) => [
        requirement.file, requirement.line, candidates.map(({ ref, compatibility }) => [ref, compatibility]),
      ]);
      assert.deepEqual(rows, [
        ["first/cmake/utility.cmake", 3, [["pkg:generic/first@2.1#first", "unknown"]]],
        ["first/cmake/utility.cmake", 5, []],
        ["second/cmake/utility.cmake", 3, [["pkg:generic/second@3.4#second", "unknown"]]],
        ["second/cmake/utility.cmake", 5, []],
        ["other/cmake/utility.cmake", 3, []],
        ["other/cmake/utility.cmake", 5, []],
      ]);
      const [candidate] = result.unresolved[0].candidates;
      assert.match(candidate.exports[0].source, /first[/\\]cmake[/\\]verify-source\.sh:1$/);
      assert.ok(candidate.exports[0].conditions.includes("if(ENABLE_LOCAL_CHECK)"));
    });
  });

  test("a called helper and a dead lexical arm cannot lend private script evidence", () => {
    withCmake("project(Suite VERSION 4.7)\ninclude(scripts/check.cmake)\ncalled(OFF)\n", (file, dir) => {
      mkdirSync(join(dir, "scripts"));
      const helper = join(dir, "scripts/check.cmake");
      const script = join(dir, "scripts/verify.sh");
      writeFileSync(script, "#!/bin/sh\n");
      chmodSync(script, 0o755);
      writeFileSync(helper, `function(called enabled)
if(enabled)
  find_program(CALLED NAMES verify.sh PATHS \${CMAKE_CURRENT_SOURCE_DIR}/scripts)
endif()
endfunction()
function(uncalled)
if(FALSE)
  find_program(DEAD NAMES verify.sh PATHS \${CMAKE_CURRENT_SOURCE_DIR}/scripts)
else()
  find_program(LIVE NAMES verify.sh PATHS \${CMAKE_CURRENT_SOURCE_DIR}/scripts)
endif()
endfunction()
`);
      const inputs = parseCmakeLikeFile(helper, "generic", { sourceRoot: dir }).pkgList;
      const result = reconcileNativeSourceProviders(inputs, [], dir, { nativeSourceManifests: [file, helper] });
      assert.deepEqual(result.unresolved.map(({ requirement, candidates }) => [requirement.line, candidates.length]), [[3, 0], [8, 0], [10, 1]]);
    });
  });

  test("scoped path replay refines matching guards without replacing baseline declaration contexts", () => {
    withCmake(`project(Suite VERSION 4.7.2)
get_filename_component(DIRECT "\${CMAKE_CURRENT_LIST_DIR}/bin" ABSOLUTE)
find_program(DIRECT_TOOL NAMES direct HINTS "\${DIRECT}" NO_DEFAULT_PATH)
set(SEARCH_DIRS "\${DIRECT}" "\${CMAKE_CURRENT_LIST_DIR}/fallback")
find_program(MULTI_TOOL NAMES multiple HINTS \${SEARCH_DIRS} NO_DEFAULT_PATH)
get_filename_component(UNSUPPORTED "\${CMAKE_CXX_COMPILER}" DIRECTORY)
find_program(RESOURCE_TOOL NAMES llvm-rc HINTS "\${UNSUPPORTED}")
if(ENABLE_ALTERNATE)
  get_filename_component(ALTERNATE "\${CMAKE_CURRENT_LIST_DIR}/alternate" ABSOLUTE)
endif()
find_program(BRANCH_TOOL NAMES launcher HINTS "\${ALTERNATE}")
`, (file, root) => {
      const parsed = parseCmakeLikeFile(file, "generic", { sourceRoot: root });
      const rows = parsed.requirements.filter(({ command }) => command === "find_program").map((entry) =>
        [entry.requestedName, entry.arguments.slice(4), entry.evaluationContexts]);
      assert.deepEqual(rows, [
        ["direct", [join(root, "bin"), "NO_DEFAULT_PATH"], [[]]],
        ["multiple", [join(root, "bin"), join(root, "fallback"), "NO_DEFAULT_PATH"], [[]]],
        ["llvm-rc", ["${UNSUPPORTED}"], [[]]],
        ["launcher", ["${ALTERNATE}"], [[]]],
      ]);
    });
  });

  test("tracked source scripts prove exact HINTS and module-path lookups without becoming installed aliases", () => {
    withCmake(`file(READ "\${CMAKE_CURRENT_SOURCE_DIR}/VERSION" RAW LIMIT_COUNT 1)
string(REGEX REPLACE "(\\n|\\r)" "" CLEAN "\${RAW}")
string(REGEX REPLACE "([0-9]+)\\.([0-9]+)\\.([0-9]+)(.*)" "\\\\1.\\\\2.\\\\3" RELEASE "\${CLEAN}")
project(Suite VERSION \${RELEASE})
list(APPEND CMAKE_MODULE_PATH "\${CMAKE_CURRENT_LIST_DIR}/modules")
include(modules/Launch.cmake)
set(TOOL_DIR "\${CMAKE_CURRENT_LIST_DIR}/bin")
set(NEW_TOOL_DIR "\${CMAKE_CURRENT_LIST_DIR}/missing")
include(modules/Paths.cmake)
find_program(STALE NAMES launcher HINTS "\${TOOL_DIR}" NO_DEFAULT_PATH)
find_program(UPDATED NAMES launcher HINTS "\${NEW_TOOL_DIR}" NO_DEFAULT_PATH)
find_library(PROBE NAMES probe HINTS "\${NEW_TOOL_DIR}")
`, (manifest, root) => {
      if (process.platform === "win32") return;
      const put = (path, text, mode) => {
        const file = join(root, path);
        mkdirSync(join(file, ".."), { recursive: true });
        writeFileSync(file, text, { mode });
        return file;
      };
      put("VERSION", "4.7.2\n");
      const files = [manifest, put("modules/Paths.cmake", `
get_filename_component(TOOL_DIR "\${CMAKE_CURRENT_LIST_DIR}/missing" ABSOLUTE)
get_filename_component(NEW_TOOL_DIR "\${CMAKE_CURRENT_LIST_DIR}/../bin" ABSOLUTE)
`), put("modules/Determine.cmake", `
if(NOT DRIVER)
  find_program(DRIVER NAMES launcher HINTS "\${CMAKE_CURRENT_LIST_DIR}/../bin")
endif()
find_program(WRONG NAMES launcher HINTS "\${CMAKE_CURRENT_LIST_DIR}/missing" NO_DEFAULT_PATH)
find_program(PLAIN NAMES launcher HINTS "\${CMAKE_CURRENT_LIST_DIR}/../plain" NO_DEFAULT_PATH)
find_program(UNTRACKED NAMES local-only HINTS "\${CMAKE_CURRENT_LIST_DIR}/../bin")
`), put("modules/Launch.cmake", `
function(configure_launch)
  find_program(COMPILER NAMES launcher HINTS \${PROJECT_SOURCE_DIR} PATH_SUFFIXES bin)
endfunction()
function(shadowed)
  set(PROJECT_SOURCE_DIR "\${PROJECT_SOURCE_DIR}/missing")
  find_program(SHADOWED NAMES launcher HINTS \${PROJECT_SOURCE_DIR} PATH_SUFFIXES bin)
endfunction()
function(exits_early)
  if(TRUE)
    return()
  endif()
  find_program(UNREACHABLE NAMES launcher HINTS \${PROJECT_SOURCE_DIR}/bin)
endfunction()
function(all_arms_return)
  if(FLAG)
    return()
  else()
    return()
  endif()
  find_program(ALSO_UNREACHABLE NAMES launcher HINTS \${PROJECT_SOURCE_DIR}/bin)
endfunction()
function(one_arm_returns)
  if(FLAG)
    return()
  endif()
  find_program(REACHABLE NAMES launcher HINTS \${PROJECT_SOURCE_DIR}/bin)
endfunction()
function(loop_returns)
  foreach(x IN ITEMS one)
    return()
    find_program(LOOP_UNREACHABLE NAMES launcher HINTS \${PROJECT_SOURCE_DIR}/bin)
  endforeach()
endfunction()
function(loop_can_be_empty)
  foreach(x IN LISTS optional)
    return()
  endforeach()
  find_program(AFTER_LOOP NAMES launcher HINTS \${PROJECT_SOURCE_DIR}/bin)
endfunction()
`), put("modules/FindCoverage.cmake", `
if(LLVM_COV_BIN)
  find_program(WRAPPER coverage-wrapper PATHS \${CMAKE_MODULE_PATH})
endif()
`), put("examples/CMakeLists.txt", "project(Examples)\ninclude(cmake/Standalone.cmake)\n"),
      put("examples/cmake/Standalone.cmake", `
if(NOT DEFINED EXAMPLE_ROOT)
  get_filename_component(EXAMPLE_ROOT "\${CMAKE_CURRENT_LIST_DIR}/.." ABSOLUTE)
endif()
function(standalone)
  if(NOT DEFINED COMPILER)
    find_program(COMPILER NAMES launcher HINTS \${EXAMPLE_ROOT}/../bin /opt/vendor PATH_SUFFIXES bin)
  endif()
endfunction()
`)];
      const script = "#!/bin/sh\nexit 0\n";
      put("bin/launcher", script, 0o755);
      put("modules/coverage-wrapper", script, 0o755);
      put("plain/launcher", script, 0o644);
      const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
      git("init", "-q");
      git("add", ".");
      git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.org", "commit", "-qm", "tracked scripts");
      const revision = git("rev-parse", "HEAD");
      put("bin/local-only", script, 0o755);
      const parsedRoot = parseCmakeLikeFile(manifest, "generic", { sourceRoot: root });
      const library = parsedRoot.requirements.find(({ command }) => command === "find_library");
      assert.equal(library?.arguments.at(-1), join(root, "missing"), "path replay must not change non-program requirements");
      const inputs = [...parsedRoot.pkgList, ...files.slice(1).flatMap((file) => parseCmakeLikeFile(file, "generic", { sourceRoot: root }).pkgList)];
      const { unresolved } = reconcileNativeSourceProviders(inputs, [], root, { nativeSourceManifests: files });
      const result = new Map(unresolved.filter(({ requirement }) => requirement.command === "find_program").map(({ requirement, candidates }) =>
        [`${requirement.file}:${requirement.line}`, candidates]));
      for (const [location, path] of [["CMakeLists.txt:11", "bin/launcher"], ["modules/Determine.cmake:3", "bin/launcher"],
        ["modules/Launch.cmake:3", "bin/launcher"], ["modules/Launch.cmake:27", "bin/launcher"], ["modules/Launch.cmake:39", "bin/launcher"],
        ["modules/FindCoverage.cmake:3", "modules/coverage-wrapper"], ["examples/cmake/Standalone.cmake:7", "bin/launcher"]]) {
        const [candidate] = result.get(location);
        assert.equal(candidate?.ref, "pkg:generic/Suite@4.7.2", location);
        assert.equal(candidate.compatibility, "unknown");
        assert.ok(candidate.exports.some((entry) => entry.source === `${join(root, path)}:1` && !entry.global &&
          entry.sourceRevision === revision && entry.lookupSource === join(root, location)), location);
      }
      for (const line of [5, 6, 7]) assert.deepEqual(result.get(`modules/Determine.cmake:${line}`), []);
      for (const location of ["CMakeLists.txt:10", "modules/Launch.cmake:7", "modules/Launch.cmake:13", "modules/Launch.cmake:21", "modules/Launch.cmake:32"]) {
        assert.deepEqual(result.get(location), [], location);
      }
    });
  });

  test("scoped script proofs distinguish helper call arguments and invocation lineage", () => {
    withCmake(`project(Suite VERSION 4.7.2)
function(look root)
  find_program(LAUNCHER NAMES launcher HINTS "\${root}" NO_DEFAULT_PATH)
endfunction()
look("\${CMAKE_CURRENT_LIST_DIR}/bin")
look("\${CMAKE_CURRENT_LIST_DIR}/missing")
look("\${CMAKE_CURRENT_LIST_DIR}/bin")
function(overwrite root)
  get_filename_component(root "\${CMAKE_CURRENT_LIST_DIR}/missing" ABSOLUTE)
  find_program(OVERWRITTEN NAMES launcher HINTS "\${root}" NO_DEFAULT_PATH)
endfunction()
overwrite("\${CMAKE_CURRENT_LIST_DIR}/bin")
function(relocate root)
  get_filename_component(root "\${CMAKE_CURRENT_LIST_DIR}/bin" ABSOLUTE)
  find_program(RELOCATED NAMES launcher HINTS "\${root}" NO_DEFAULT_PATH)
endfunction()
relocate("\${CMAKE_CURRENT_LIST_DIR}/missing")
`, (file, root) => {
      if (process.platform === "win32") return;
      mkdirSync(join(root, "bin"));
      writeFileSync(join(root, "bin/launcher"), "#!/bin/sh\n", { mode: 0o755 });
      const git = (...args) => execFileSync("git", ["-C", root, ...args]);
      git("init", "-q");
      git("add", ".");
      git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.org", "commit", "-qm", "tracked lookup");
      const inputs = parseCmakeLikeFile(file, "generic", { sourceRoot: root }).pkgList;
      const { unresolved } = reconcileNativeSourceProviders(inputs, [], root, { nativeSourceManifests: [file] });
      const rows = unresolved.filter(({ requirement }) => requirement.command === "find_program").map(({ requirement, candidates }) =>
        [requirement.helperInvocations, candidates.flatMap(({ exports }) => exports.flatMap(({ conditions }) => conditions.filter((condition) => condition.startsWith("call("))))]);
      assert.deepEqual(rows, [
        [[`${file}:5`], [`call(${file}:5)`]],
        [[`${file}:6`], []],
        [[`${file}:7`], [`call(${file}:7)`]],
        [[`${file}:12`], []],
        [[`${file}:17`], [`call(${file}:17)`]],
      ]);
    });
  });

  test("a tracked cross-owner lookup uses the actual indexed includer's source bindings", () => {
    withCmake(`project(Parent VERSION 4.7.2)
set(TOOL_DIR "\${CMAKE_CURRENT_LIST_DIR}/missing")
if(ENABLE_CHILD_HELPER)
  include(cmake/Bridge.cmake)
endif()
if(FALSE)
  include(child/Inactive.cmake)
endif()
`, (file, root) => {
      if (process.platform === "win32") return;
      const put = (path, text, mode) => {
        const target = join(root, path);
        mkdirSync(join(target, ".."), { recursive: true });
        writeFileSync(target, text, { mode });
        return target;
      };
      const bridge = put("cmake/Bridge.cmake", `get_filename_component(TOOL_DIR "\${CMAKE_CURRENT_LIST_DIR}/../bin" ABSOLUTE)
include(child/Lookup.cmake)
`);
      const child = put("child/CMakeLists.txt", "project(Child VERSION 9.1)\n");
      const files = ["Lookup", "Inactive", "Unrelated"].map((name) => put(`child/${name}.cmake`,
        'find_program(LAUNCHER NAMES launcher HINTS "${TOOL_DIR}" NO_DEFAULT_PATH)\n'));
      put("bin/launcher", "#!/bin/sh\n", 0o755);
      const git = (...args) => execFileSync("git", ["-C", root, ...args]);
      git("init", "-q");
      git("add", ".");
      git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.org", "commit", "-qm", "track nested modules");
      const inputs = files.flatMap((module) => parseCmakeLikeFile(module, "generic", { sourceRoot: root }).pkgList);
      const { unresolved } = reconcileNativeSourceProviders(inputs, [], root, { nativeSourceManifests: [file, bridge, child, ...files] });
      assert.deepEqual(unresolved.map(({ requirement, candidates }) => [requirement.file, candidates.map(({ ref }) => ref)]), [
        ["child/Lookup.cmake", ["pkg:generic/Parent@4.7.2"]],
        ["child/Inactive.cmake", []],
        ["child/Unrelated.cmake", []],
      ]);
      const proof = unresolved[0].candidates[0].exports[0];
      assert.equal(proof.lookupSource, `${files[0]}:1`);
      assert.ok(proof.conditions.includes("if(ENABLE_CHILD_HELPER)"));
      assert.ok(proof.conditions.includes(`include(${bridge}:2)`));
      assert.equal(proof.global, false);
    });
  });

  test("dirty or untracked source inputs cannot label a scoped executable", () => {
    for (const changed of ["untracked-version", "modified-version", "modified-program"]) withCmake(`file(READ "\${CMAKE_CURRENT_LIST_DIR}/VERSION" RELEASE)
project(Suite VERSION \${RELEASE})
include(cmake/Lookup.cmake)
`, (file, root) => {
      if (process.platform === "win32") return;
      mkdirSync(join(root, "bin"));
      mkdirSync(join(root, "cmake"));
      const lookup = join(root, "cmake/Lookup.cmake");
      const version = join(root, "VERSION");
      const program = join(root, "bin/launcher");
      writeFileSync(lookup, 'find_program(LAUNCHER NAMES launcher HINTS "${CMAKE_CURRENT_LIST_DIR}/../bin")\n');
      writeFileSync(program, "#!/bin/sh\n", { mode: 0o755 });
      const git = (...args) => execFileSync("git", ["-C", root, ...args]);
      git("init", "-q");
      if (changed !== "untracked-version") writeFileSync(version, "1.2.3\n");
      git("add", ".");
      git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.org", "commit", "-qm", "record release inputs");
      if (changed === "modified-program") writeFileSync(program, "#!/bin/sh\nexit 1\n");
      else writeFileSync(version, "9.9.9\n");
      const inputs = parseCmakeLikeFile(lookup, "generic", { sourceRoot: root }).pkgList;
      const { unresolved } = reconcileNativeSourceProviders(inputs, [], root, { nativeSourceManifests: [file, lookup] });
      assert.deepEqual(unresolved.map(({ candidates }) => candidates), [[]]);
    });
  });

  test("an exported unsuffixed tool cannot prove a legacy versioned alias", () => {
    withCmake("project(Consumer)\nfind_program(LEGACY NAMES formatter-11 formatter-mp-11)\nfind_program(ANY NAMES formatter-11 formatter)", (file, dir) => {
      mkdirSync(join(dir, "toolchain"));
      const manifest = join(dir, "toolchain/CMakeLists.txt");
      writeFileSync(manifest, "project(CompilerSuite VERSION 24.0)\nadd_executable(formatter Format.cpp)\ninstall(TARGETS formatter)\n");
      const inputs = parseCmakeLikeFile(file, "generic", { sourceRoot: dir }).pkgList;
      const result = reconcileNativeSourceProviders(inputs, [], dir, { nativeSourceManifests: [file, manifest] });
      assert.deepEqual(result.unresolved.map(({ requirement, candidates }) => [
        requirement.line, candidates.map(({ ref, compatibility, exports }) => [ref, compatibility, exports.map((entry) => entry.name)]),
      ]), [[2, []], [3, [["pkg:generic/CompilerSuite@24.0#toolchain", "unknown", ["formatter"]]]]]);
    });
  });

  test("unbound platform comparison operands retain both source acquisition alternatives", () => {
    withCmake("if(CMAKE_SYSTEM_NAME STREQUAL Windows)\nFetchContent_Declare(windows GIT_REPOSITORY https://example.org/windows.git GIT_TAG v1.0)\nelse()\nFetchContent_Declare(other GIT_REPOSITORY https://example.org/other.git GIT_TAG v2.0)\nendif()", (file, dir) => {
      const details = cmakeProjectDetails(file, parseCmakeCommands("if(CMAKE_SYSTEM_NAME STREQUAL Windows)\nFetchContent_Declare(windows GIT_REPOSITORY https://example.org/windows.git GIT_TAG v1.0)\nelse()\nFetchContent_Declare(other GIT_REPOSITORY https://example.org/other.git GIT_TAG v2.0)\nendif()"), dir);
      assert.deepEqual(new Set(details.fetchCommands.map((command) => command.args[0])), new Set(["windows", "other"]));
    });
  });

  test("unknown forwarded keyword lists cannot prove that helper VERSION and HASH overrides are absent", () => {
    const text = `function(acquire)
cmake_parse_arguments(PARSE "" "VERSION;HASH" "" \${ARGN})
if(PARSE_HASH)
set(TAG \${PARSE_HASH})
elseif(PARSE_VERSION)
set(TAG v\${PARSE_VERSION})
else()
set(TAG v1.2.3)
endif()
FetchContent_Declare(actual GIT_REPOSITORY https://example.org/actual.git GIT_TAG \${TAG})
endfunction()
acquire(\${UNKNOWN_OPTIONS})
`;
    withCmake(text, (file, dir) => {
      const details = cmakeProjectDetails(file, parseCmakeCommands(text), dir);
      const actual = details.fetchCommands.filter((command) => !command.helperTemplate && command.helperInvocations?.length && command.args.includes("GIT_TAG"));
      assert.ok(actual.some((command) => command.args[command.args.indexOf("GIT_TAG") + 1].includes("$")));
    });
  });
  test("literal child callers inherit source helper definitions and caller-bound default inputs", () => {
    withCmake('set(DEFAULT_VERSION 1.2.3)\ninclude(cmake/DependencyHelpers.cmake)\nadd_subdirectory(sdk)', (_file, dir) => {
      mkdirSync(join(dir, "cmake"));
      mkdirSync(join(dir, "sdk"));
      writeFileSync(join(dir, "cmake/DependencyHelpers.cmake"), "function(acquire NAME)\nFetchContent_Declare(${NAME} GIT_REPOSITORY https://example.org/owned.git GIT_TAG v${DEFAULT_VERSION})\nendfunction()");
      const file = join(dir, "sdk/CMakeLists.txt");
      const text = "project(Sdk)\nacquire(owned)";
      writeFileSync(file, text);
      const details = cmakeProjectDetails(file, parseCmakeCommands(text), dir);
      assert.ok(details.fetchCommands.some((command) => command.args.includes("v1.2.3") && !command.helperTemplate && command.helperInvocations?.length));
    });
  });

  test("include path exhaustion retains later literal software downloads rather than erasing the caller tail", () => {
    const text = "include(ManyVersion.cmake)\nfile(DOWNLOAD https://example.org/software-1.2.3.zip downloads/software.zip EXPECTED_HASH SHA256=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef)";
    withCmake(text, (file, dir) => {
      writeFileSync(join(dir, "ManyVersion.cmake"), Array.from({ length: 80 }, (_, index) => `if(OPTION_${index})\nset(PIN v${index}.0)\nFetchContent_Declare(optional_${index} GIT_REPOSITORY https://example.org/optional.git GIT_TAG \${PIN})\nendif()`).join("\n"));
      const details = cmakeProjectDetails(file, parseCmakeCommands(text), dir);
      assert.ok(details.fetchCommands.some((command) => command.name === "file_download" && command.args.includes("https://example.org/software-1.2.3.zip")));
    });
  });
  test("cached provider consumer SrcPath cannot create a source owner with the installed package version", () => {
    withCmake("project(Consumer VERSION 99.0)\nadd_library(phantom SHARED phantom.c)\ninstall(TARGETS phantom)", (file, dir) => {
      const installed = { name: "foreign-package", version: "22.0", "bom-ref": "installed", properties: [
        { name: "SrcPath", value: file },
        { name: "cdx:native:providerIdentity", value: "authenticated-package" },
        { name: "cdx:native:providerEvidence", value: JSON.stringify({ kind: "installed-package-file" }) },
        { name: "cdx:native:providerExports", value: JSON.stringify([{ kind: "header-file", name: "foreign.hpp", source: "/actual/foreign.hpp", global: true }]) },
      ] };
      const requirement = { name: "phantom", "bom-ref": "request", properties: [{ name: "cdx:build:requirement", value: JSON.stringify({
        requestedName: "phantom", command: "find_library", file: "consumer/CMakeLists.txt", role: "software", constraints: "", providerCandidates: [],
      }) }] };
      const result = reconcileNativeSourceProviders([requirement, installed], [], dir);
      assert.equal(result.bindings.length, 0);
      assert.ok(result.pkgList.includes(requirement));
      assert.ok(result.providerIndex.providers.filter((provider) => provider.ref === "installed").every((provider) => provider.directory === undefined));
    });
  });
  test("reused helper fetch facts keep distinct invocation and conditional contexts", () => {
    const text = `function(acquire VERSION)
FetchContent_Declare(owned GIT_REPOSITORY https://example.org/owned.git GIT_TAG v1.2.3)
endfunction()
if(FEATURE)
acquire(1.2.3)
else()
acquire(1.2.3)
endif()
`;
    withCmake(text, (file, dir) => {
      const details = cmakeProjectDetails(file, parseCmakeCommands(text), dir);
      const actual = details.fetchCommands.filter((command) => !command.helperTemplate && command.helperInvocations?.length && command.name === "fetchcontent_declare");
      assert.equal(actual.length, 2);
      assert.equal(new Set(actual.map((command) => command.helperInvocations[0])).size, 2);
      assert.ok(actual.every((command) => command.args.includes("v1.2.3")));
      assert.ok(actual.some((command) => command.conditions.includes("if(FEATURE)")));
      assert.ok(actual.some((command) => command.conditions.includes("if(FEATURE)/else()")));
    });
  });
  test("syntax reuse keeps computed output dependencies and redefined helpers context-local", () => {
    const text = `set(PREFIX PIN)
if(FEATURE)
set(\${PREFIX}_VERSION v1.2.3)
else()
set(\${PREFIX}_VERSION v4.5.6)
endif()
function(acquire NAME)
FetchContent_Declare(\${NAME} GIT_REPOSITORY https://example.org/owned.git GIT_TAG \${PIN_VERSION} SOURCE_DIR \${PREFIX})
endfunction()
acquire(first)
function(acquire NAME)
FetchContent_Declare(\${NAME} GIT_REPOSITORY https://example.org/owned.git GIT_TAG v7.8.9)
endfunction()
acquire(second)
`;
    withCmake(text, (file, dir) => {
      const details = cmakeProjectDetails(file, parseCmakeCommands(text), dir);
      const actual = details.fetchCommands.filter((command) => !command.helperTemplate && command.helperInvocations?.length);
      const pins = (name) => new Set(actual.filter((command) => command.args[0] === name).map((command) => command.args[command.args.indexOf("GIT_TAG") + 1]));
      assert.deepEqual(pins("first"), new Set(["v1.2.3", "v4.5.6"]));
      assert.deepEqual(pins("second"), new Set(["v7.8.9"]));
      assert.ok(actual.some((command) => command.conditions.includes("if(FEATURE)")));
      assert.ok(actual.some((command) => command.conditions.includes("if(FEATURE)/else()")));
    });
  });

  test("syntax reuse does not cache changed transitive include values across evaluations", () => {
    const text = "include(Pin.cmake)\nFetchContent_Declare(owned GIT_REPOSITORY https://example.org/owned.git GIT_TAG ${PIN})";
    withCmake(text, (file, dir) => {
      const commands = parseCmakeCommands(text);
      const include = join(dir, "Pin.cmake");
      writeFileSync(include, "set(PIN v1.2.3)");
      const first = cmakeProjectDetails(file, commands, dir);
      writeFileSync(include, "set(PIN v4.5.6)");
      const second = cmakeProjectDetails(file, commands, dir);
      assert.deepEqual(first.fetchCommands.map((command) => command.args.at(-1)), ["v1.2.3"]);
      assert.deepEqual(second.fetchCommands.map((command) => command.args.at(-1)), ["v4.5.6"]);
      assert.deepEqual(first.versionFiles, [include]);
      assert.deepEqual(second.versionFiles, [include]);
    });
  });
  test("non-version command shortcuts still dispatch a locally defined helper with that name", () => {
    const text = `function(target_link_libraries NAME)
FetchContent_Declare(\${NAME} GIT_REPOSITORY https://example.org/owned.git GIT_TAG v1.2.3)
endfunction()
target_link_libraries(owned)
`;
    withCmake(text, (file, dir) => {
      const details = cmakeProjectDetails(file, parseCmakeCommands(text), dir);
      const actual = details.fetchCommands.filter((command) => !command.helperTemplate && command.helperInvocations?.length);
      assert.equal(actual.length, 1);
      assert.equal(actual[0].args[0], "owned");
      assert.ok(actual[0].args.includes("v1.2.3"));
      assert.deepEqual(actual[0].helperInvocations, [`${file}:4`]);
    });
  });
  test("helper argument binding preserves positional values without leaking them to later calls", () => {
    const text = `function(acquire NAME)
FetchContent_Declare(\${NAME} GIT_REPOSITORY https://example.org/owned.git GIT_TAG \${ARGV1})
endfunction()
set(ARGV1 v9.9.9)
acquire(first v1.2.3)
acquire(second v4.5.6)
FetchContent_Declare(outside GIT_REPOSITORY https://example.org/owned.git GIT_TAG \${ARGV1})
`;
    withCmake(text, (file, dir) => {
      const details = cmakeProjectDetails(file, parseCmakeCommands(text), dir);
      const actual = details.fetchCommands.filter((command) => !command.helperTemplate);
      assert.deepEqual(actual.map((command) => [command.args[0], command.args.at(-1)]),
        [["first", "v1.2.3"], ["second", "v4.5.6"], ["outside", "v9.9.9"]]);
      assert.equal(details.variables.get("ARGV1"), "v9.9.9");
    });
  });
  test("reusing an evaluation budget does not cache a caller-mutated dependency set", () => {
    const text = "if(FEATURE)\nset(PIN v1.2.3)\nelse()\nset(PIN v4.5.6)\nendif()";
    withCmake(text, (file, dir) => {
      const commands = parseCmakeCommands(text);
      const needed = new Set();
      const budget = { paths: 0, commands: 0, includes: 0, activeIncludes: new Set(), depth: 0 };
      const context = { declarationsOnly: true, needed, budget };
      const first = cmakeProjectDetails(file, commands, dir, context);
      needed.add("PIN");
      const second = cmakeProjectDetails(file, commands, dir, context);
      assert.equal(first.terminalStates.length, 1);
      assert.equal(first.terminalStates[0].variables.has("PIN"), false);
      assert.deepEqual(new Set(second.terminalStates.map((state) => state.variables.get("PIN"))), new Set(["v1.2.3", "v4.5.6"]));
    });
  });
  test("conservative pure-helper summaries retain changed inherited values, call provenance and command costs", () => {
    const text = `project(Consumer)
function(publish OUT)
set(\${OUT} \${DEFAULT_TAG} PARENT_SCOPE)
endfunction()
set(DEFAULT_TAG 1.2.3)
publish(PIN)
FetchContent_Declare(first GIT_REPOSITORY https://example.org/owned.git GIT_TAG \${PIN})
set(DEFAULT_TAG 4.5.6)
publish(PIN)
FetchContent_Declare(second GIT_REPOSITORY https://example.org/owned.git GIT_TAG \${PIN})
set(DEFAULT_TAG 1.2.3)
publish(PIN)
FetchContent_Declare(third GIT_REPOSITORY https://example.org/owned.git GIT_TAG \${PIN})
`;
    withCmake(text, (file, dir) => {
      const budget = { paths: 0, commands: 0, includes: 0, activeIncludes: new Set(), depth: 0, conservative: true };
      const details = cmakeProjectDetails(file, parseCmakeCommands(text), dir, { declarationsOnly: true, budget });
      assert.deepEqual(details.fetchCommands.map((command) => command.args.at(-1)), ["1.2.3", "4.5.6", "1.2.3"]);
      const outputs = details.versionCandidates.filter((candidate) => candidate.kind === "helper-output");
      assert.deepEqual(outputs.map((candidate) => candidate.version), ["1.2.3", "4.5.6", "1.2.3"]);
      assert.deepEqual(outputs.map((candidate) => candidate.conditions), [[`call(${file}:6)`], [`call(${file}:9)`], [`call(${file}:12)`]]);
      assert.equal(budget.commands, 16);
      assert.equal(budget.paths, 0);
    });
  });

  test("conservative pure-helper summary hits cannot cross command-budget exhaustion", () => {
    const text = "function(publish OUT)\nset(${OUT} v1.2.3 PARENT_SCOPE)\nendfunction()\npublish(PIN)\npublish(PIN)\nFetchContent_Declare(owned GIT_REPOSITORY https://example.org/owned.git GIT_TAG ${PIN})";
    withCmake(text, (file, dir) => {
      const budget = { paths: 0, commands: 0, includes: 0, activeIncludes: new Set(), depth: 0, conservative: true, commandLimit: 6 };
      const details = cmakeProjectDetails(file, parseCmakeCommands(text), dir, { declarationsOnly: true, budget });
      assert.equal(details.variables.get("PIN"), "$<unknown:PIN>");
      assert.equal(details.fetchCommands.length, 0);
      assert.equal(details.terminalStates.length, 0);
    });
  });

  test("locally overridden scalar commands cannot be hidden by a pure-helper summary", () => {
    const text = `function(set KEY VALUE)
FetchContent_Declare(owned GIT_REPOSITORY https://example.org/owned.git GIT_TAG v1.2.3)
endfunction()
function(publish OUT)
set(\${OUT} v1.2.3 PARENT_SCOPE)
endfunction()
publish(PIN)
publish(PIN)
`;
    withCmake(text, (file, dir) => {
      const budget = { paths: 0, commands: 0, includes: 0, activeIncludes: new Set(), depth: 0, conservative: true };
      const details = cmakeProjectDetails(file, parseCmakeCommands(text), dir, { declarationsOnly: true, budget });
      assert.equal(details.fetchCommands.length, 2);
      assert.deepEqual(details.fetchCommands.map((command) => command.helperInvocations[0]), [`${file}:7`, `${file}:8`]);
    });
  });
  test("nested conservative helper summaries observe transitive variable reads and preserve complete invocation paths", () => {
    const text = `function(child NAME)
FetchContent_Declare(\${NAME} GIT_REPOSITORY https://example.org/owned.git GIT_TAG \${GLOBAL_TAG})
endfunction()
function(parent NAME)
child(\${NAME})
endfunction()
set(GLOBAL_TAG v1.2.3)
parent(owned)
set(GLOBAL_TAG v4.5.6)
parent(owned)
set(GLOBAL_TAG v1.2.3)
parent(owned)
`;
    withCmake(text, (file, dir) => {
      const budget = { paths: 0, commands: 0, includes: 0, activeIncludes: new Set(), depth: 0, conservative: true };
      const details = cmakeProjectDetails(file, parseCmakeCommands(text), dir, { declarationsOnly: true, budget });
      assert.deepEqual(details.fetchCommands.map((command) => command.args.at(-1)), ["v1.2.3", "v4.5.6", "v1.2.3"]);
      assert.deepEqual(details.fetchCommands.map((command) => command.helperInvocations),
        [[`${file}:8`, `${file}:5`], [`${file}:10`, `${file}:5`], [`${file}:12`, `${file}:5`]]);
      assert.equal(budget.commands, 18);
    });
  });

  test("nested helper redefinition invalidates a completed conservative summary", () => {
    const text = `function(child NAME)
FetchContent_Declare(\${NAME} GIT_REPOSITORY https://example.org/owned.git GIT_TAG v1.2.3)
endfunction()
function(parent NAME)
child(\${NAME})
endfunction()
parent(first)
function(child NAME)
FetchContent_Declare(\${NAME} GIT_REPOSITORY https://example.org/owned.git GIT_TAG v4.5.6)
endfunction()
parent(second)
`;
    withCmake(text, (file, dir) => {
      const budget = { paths: 0, commands: 0, includes: 0, activeIncludes: new Set(), depth: 0, conservative: true };
      const details = cmakeProjectDetails(file, parseCmakeCommands(text), dir, { declarationsOnly: true, budget });
      assert.deepEqual(details.fetchCommands.map((command) => [command.args[0], command.args.at(-1)]),
        [["first", "v1.2.3"], ["second", "v4.5.6"]]);
    });
  });
  test("conservative helper summaries keep the currently declared project as version owner", () => {
    const text = `function(publish OUT)
set(\${OUT} 1.2.3 PARENT_SCOPE)
endfunction()
project(First)
publish(PIN)
project(Second)
publish(PIN)
FetchContent_Declare(owned GIT_REPOSITORY https://example.org/owned.git GIT_TAG \${PIN})
`;
    withCmake(text, (file, dir) => {
      const budget = { paths: 0, commands: 0, includes: 0, activeIncludes: new Set(), depth: 0, conservative: true };
      const details = cmakeProjectDetails(file, parseCmakeCommands(text), dir, { declarationsOnly: true, budget });
      assert.deepEqual(details.versionCandidates.filter((candidate) => candidate.kind === "helper-output").map((candidate) => candidate.name), ["First", "Second"]);
    });
  });
  test("ordinary path exhaustion retains repeated helper observations through conservative memo hits", () => {
    const text = `function(acquire NAME)
FetchContent_Declare(\${NAME} GIT_REPOSITORY https://example.org/owned.git GIT_TAG v1.2.3)
endfunction()
${Array.from({ length: 80 }, (_, index) => `if(OPTION_${index})\nFetchContent_Declare(optional_${index} GIT_REPOSITORY https://example.org/optional.git GIT_TAG v1.2.3)\nendif()`).join("\n")}
acquire(owned)
acquire(owned)
acquire(owned)
`;
    withCmake(text, (file, dir) => {
      const details = cmakeProjectDetails(file, parseCmakeCommands(text), dir);
      const actual = details.fetchCommands.filter((command) => command.args[0] === "owned" && !command.helperTemplate);
      assert.equal(actual.length, 3);
      assert.equal(new Set(actual.map((command) => command.helperInvocations[0])).size, 3);
      assert.ok(actual.every((command) => command.conditions.includes("analysis-budget-exhausted")));
      assert.ok(actual.every((command) => command.args.at(-1) === "v1.2.3"));
    });
  });

  test("conservative helper summaries preserve ARGC, ARGN and inherited out-of-range positional arguments", () => {
    const text = `function(acquire NAME)
FetchContent_Declare(\${NAME} GIT_REPOSITORY https://example.org/owned.git GIT_TAG \${ARGC}-\${ARGN}-\${ARGV3})
endfunction()
set(ARGV3 inherited)
acquire(first v1.2.3)
acquire(second v4.5.6)
acquire(third v1.2.3)
`;
    withCmake(text, (file, dir) => {
      const budget = { paths: 0, commands: 0, includes: 0, activeIncludes: new Set(), depth: 0, conservative: true };
      const details = cmakeProjectDetails(file, parseCmakeCommands(text), dir, { declarationsOnly: true, budget });
      assert.deepEqual(details.fetchCommands.map((command) => command.args.at(-1)),
        ["2-v1.2.3-inherited", "2-v4.5.6-inherited", "2-v1.2.3-inherited"]);
      assert.equal(details.variables.get("ARGV3"), "inherited");
    });
  });

  test("conservative nested summaries distinguish absent and empty inherited bindings without leaking either", () => {
    const text = `function(child)
if(DEFINED FLAG)
FetchContent_Declare(present GIT_REPOSITORY https://example.org/owned.git GIT_TAG v1.2.3)
else()
FetchContent_Declare(absent GIT_REPOSITORY https://example.org/owned.git GIT_TAG v4.5.6)
endif()
endfunction()
function(parent)
child()
endfunction()
function(with_empty)
set(FLAG "")
child()
endfunction()
parent()
with_empty()
parent()
`;
    withCmake(text, (file, dir) => {
      const budget = { paths: 0, commands: 0, includes: 0, activeIncludes: new Set(), depth: 0, conservative: true };
      const details = cmakeProjectDetails(file, parseCmakeCommands(text), dir, { declarationsOnly: true, budget });
      assert.deepEqual(details.fetchCommands.map((command) => command.args[0]), ["present", "absent", "present", "present", "absent"]);
      assert.equal(details.variables.has("FLAG"), false);
    });
  });
});
