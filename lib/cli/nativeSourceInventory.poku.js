import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { strict as assert, describe, test } from "poku";

import { createCppBom } from "./nativeBom.js";
import { createContainerSpecLikeBom, createMultiXBom } from "./index.js";
function writeMesonSelection(root, requestedName, provider, version) {
  const info = join(root, "build", "meson-info");
  mkdirSync(info, { recursive: true });
  mkdirSync(join(root, "build", "meson-logs"), { recursive: true });
  writeFileSync(join(info, "meson-info.json"), JSON.stringify({ directories: { source: root }, error: false }));
  writeFileSync(join(info, "intro-buildoptions.json"), JSON.stringify([{ name: "wrap_mode", value: "forcefallback" }]));
  writeFileSync(join(info, "intro-projectinfo.json"), JSON.stringify({ subproject_dir: "subprojects", subprojects: [{ name: provider, version }] }));
  writeFileSync(join(info, "intro-buildsystem_files.json"), JSON.stringify([join(root, "meson.build")]));
  writeFileSync(join(root, "build", "meson-logs", "meson-log.txt"), `Dependency ${requestedName} for host machine from subproject subprojects/${provider} found: YES ${version}\n`);
}

function nativeDeclarations(bom) {
  const declarations = [];
  const collect = (component) => {
    if (!component) return;
    declarations.push(component);
    for (const child of component.components || []) collect(child);
  };
  collect(bom.metadata?.component);
  for (const component of bom.components || []) collect(component);
  return declarations;
}

function assertNativeReferences(bom) {
  const declarations = nativeDeclarations(bom);
  const refs = new Set(declarations.map((component) => component["bom-ref"]));
  assert.equal(refs.size, declarations.length);
  for (const edge of bom.dependencies || []) {
    for (const ref of [edge.ref, ...(edge.dependsOn || []), ...(edge.provides || [])]) assert.ok(refs.has(ref));
  }
  for (const holder of [...declarations, bom.metadata || {}]) {
    for (const property of holder.properties || []) {
      if (property.name !== "cdx:build:requirement") continue;
      for (const candidate of JSON.parse(property.value).providerCandidates || []) {
        if (candidate.ref) assert.ok(refs.has(candidate.ref), `undeclared requirement candidate: ${candidate.ref}`);
      }
    }
  }
}

describe("native source inventory under a product override", () => {
  test("normal assembly preserves source and external alternatives in parent occurrence metadata", async () => {
    const root = mkdtempSync(join(tmpdir(), "cdxgen-joint-provider-"));
    try {
      const source = join(root, "source");
      mkdirSync(join(source, "provider"), { recursive: true });
      writeFileSync(join(source, "CMakeLists.txt"), "project(Consumer VERSION 1.0)\nfind_package(ClosureWidget)\n");
      writeFileSync(join(source, "provider", "CMakeLists.txt"), "project(ClosureWidget VERSION 1.2.3)\nconfigure_file(ClosureWidgetConfig.cmake.in ClosureWidgetConfig.cmake @ONLY)\ninstall(FILES ${CMAKE_CURRENT_BINARY_DIR}/ClosureWidgetConfig.cmake DESTINATION lib/cmake/ClosureWidget)\n");
      writeFileSync(join(source, "provider", "ClosureWidgetConfig.cmake.in"), "set(ClosureWidget_VERSION @PROJECT_VERSION@)\n");
      const descriptor = (name, value, format) => {
        const text = JSON.stringify(value);
        writeFileSync(join(root, name), text);
        return { path: name, sha256: createHash("sha256").update(text).digest("hex"), ...(format ? { format } : {}) };
      };
      const evidence = descriptor("release.json", { release: "2.3.4" });
      const metadata = descriptor("snapshot.json", { schema: 1, name: "external-widget", versionKind: "release", version: "2.3.4", platform: "linux", exports: [{ kind: "cmake-package", name: "ClosureWidget" }], evidence: [evidence] }, "provider-snapshot");
      const manifest = join(root, "providers.json");
      writeFileSync(manifest, JSON.stringify({ schema: 1, providers: [{ metadata }] }));
      const { bomJson: bom } = await createCppBom(source, { multiProject: true, installDeps: false, deep: false, specVersion: 1.7, introspect: true, nativeVersionProbes: true, nativeProviderMetadata: manifest });
      const alternatives = nativeDeclarations(bom).filter((component) => ["1.2.3", "2.3.4"].includes(component.version));
      assert.deepEqual(new Set(alternatives.map((component) => component.version)), new Set(["1.2.3", "2.3.4"]));
      const parentRequirements = bom.metadata.component.properties.filter((property) => property.name === "cdx:build:requirement").map((property) => JSON.parse(property.value));
      const occurrence = parentRequirements.find((record) => record.requestedName === "ClosureWidget");
      const candidates = new Set(occurrence.providerCandidates.map((candidate) => candidate.ref));
      for (const provider of alternatives) assert.ok(candidates.has(provider["bom-ref"]), `parent occurrence lost ${provider.version}`);
      assertNativeReferences(bom);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("shared native evidence reconstructs both roots' original occurrence attachments", async () => {
    const root = mkdtempSync(join(tmpdir(), "cdxgen-shared-native-"));
    try {
      const roots = ["First", "Second"].map((name) => {
        const consumer = join(root, name);
        const owner = join(consumer, "provider");
        mkdirSync(owner, { recursive: true });
        writeFileSync(join(consumer, "CMakeLists.txt"), `project(${name} VERSION 1.0)\nfind_program(BUILD_TOOL NAMES ${name}Tool)\n`);
        writeFileSync(join(owner, "CMakeLists.txt"), `project(${name}Tools VERSION 2.0)\nadd_executable(${name}Tool main.c)\ninstall(TARGETS ${name}Tool RUNTIME DESTINATION bin)\n`);
        return consumer;
      });
      const options = { projectType: ["c"], multiProject: true, installDeps: false, deep: false, specVersion: 1.7 };
      const { bomJson: inline } = await createMultiXBom(roots, { ...options });
      const { bomJson: shared } = await createMultiXBom(roots, { ...options, nativeEvidenceFormat: "shared" });
      const prefix = "cdx:build:requirementTable:";
      const table = new Map((shared.metadata.properties || []).filter((p) => p.name.startsWith(prefix)).map((p) => [p.name.slice(prefix.length), p.value]));
      const collect = (bom) => nativeDeclarations(bom).map((component) => [component["bom-ref"], (component.properties || []).flatMap((p) =>
        p.name === "cdx:build:requirement" ? [p.value] : p.name === "cdx:build:requirementLink" ? [table.get(p.value)] : [])]);
      assert.ok(table.size >= 2);
      assert.deepEqual(collect(shared), collect(inline));
      assert.deepEqual(shared.dependencies, inline.dependencies);
      const { bomJson: universal } = await createContainerSpecLikeBom(roots[0], {
        ...options, projectType: ["universal"], nativeEvidenceFormat: "shared",
      });
      const outerIds = new Set((universal.metadata.properties || []).filter((p) => p.name.startsWith(prefix)).map((p) => p.name.slice(prefix.length)));
      const outerLinks = nativeDeclarations(universal).flatMap((component) =>
        (component.properties || []).filter((p) => p.name === "cdx:build:requirementLink").map((p) => p.value));
      assert.ok(outerLinks.length && outerLinks.every((id) => outerIds.has(id)));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("single-project assembly keeps final parent requirements and submodule diagnostics", async () => {
    const root = mkdtempSync(join(tmpdir(), "cdxgen-final-parent-"));
    try {
      writeFileSync(join(root, "CMakeLists.txt"), "project(Consumer VERSION 1.0.0)\nfind_file(CAPABILITY_HEADER capability.h)\n");
      writeFileSync(join(root, ".gitmodules"), '[submodule "gone"]\npath = vendor/gone\nurl = https://example.invalid/gone.git\n');
      const { bomJson: bom } = await createCppBom(root, { multiProject: true, installDeps: false, deep: false, specVersion: 1.7 });
      const properties = bom.metadata.component.properties || [];
      assert.ok(properties.some((property) => property.name === "cdx:build:requirement" &&
        JSON.parse(property.value).requestedName === "capability.h" && JSON.parse(property.value).role === "file-search"));
      const diagnostic = properties.find((property) => property.name === "cdx:cmake:submoduleDiagnostic");
      assert.equal(JSON.parse(diagnostic.value).path, "vendor/gone");
      assert.equal(JSON.parse(diagnostic.value).reason, "no-gitlink-or-checkout");
      assert.equal(nativeDeclarations(bom).some((component) => component.name === "gone"), false);
      assertNativeReferences(bom);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  for (const [label, body, requestedName, role, line] of [
    ["raw-only", "find_package(${GENERATED_PACKAGE})", "${GENERATED_PACKAGE}", "unresolved-expression", 2],
    ["module-only", "add_library(LocalCapability INTERFACE)", "LocalCapability", "build-target", 2],
    ["capability-only", "find_file(CAPABILITY_HEADER capability.h)", "capability.h", "file-search", 2],
    ["mixed", "find_package(ZLIB)\nfind_package(${GENERATED_PACKAGE})", "${GENERATED_PACKAGE}", "unresolved-expression", 3],
  ]) {
    test(`aggregate retains a declared parent owning ${label} requirements`, async () => {
      const root = mkdtempSync(join(tmpdir(), "cdxgen-native-owned-"));
      try {
        writeFileSync(join(root, "CMakeLists.txt"), `project(Consumer)\n${body}\n`);
        const { bomJson: bom } = await createMultiXBom([root], { projectType: ["c"], multiProject: true, installDeps: false, deep: false, specVersion: 1.7 });
        const owner = nativeDeclarations(bom).find((component) => component.name === "Consumer");
        assert.ok(owner, "the declared requirement owner must survive aggregate collection");
        const requirements = owner.properties.filter((property) => property.name === "cdx:build:requirement").map((property) => JSON.parse(property.value));
        assert.ok(requirements.some((requirement) => requirement.requestedName === requestedName && requirement.role === role && requirement.file === "CMakeLists.txt" && requirement.line === line));
        assert.equal(bom.components.length, label === "mixed" ? 1 : 0);
        assert.ok(!bom.components.some((component) => component.name.includes("$")));
        assertNativeReferences(bom);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }

  test("generic archive aliases retain closed source candidates in either casing order", async () => {
    for (const names of [["Example", "example"], ["example", "Example"]]) {
      const root = mkdtempSync(join(tmpdir(), "cdxgen-native-source-alias-"));
      try {
        writeFileSync(join(root, "CMakeLists.txt"), `project(Consumer)\nFetchContent_Declare(${names[0]} URL https://example.org/lib-1.2.3.tar.gz)\nFetchContent_Declare(${names[1]} URL https://example.org/lib-1.2.3.tar.gz)\n`);
        const { bomJson: bom } = await createCppBom(root, { multiProject: true, createMultiXBom: true, installDeps: false, deep: false, specVersion: 1.7 });
        assert.equal(bom.components.length, 1);
        const source = bom.components[0];
        assert.equal(source.name, names[0]);
        for (const holder of [source, bom.metadata.component]) {
          const declarations = holder.properties.filter((property) => property.name === "cdx:build:requirement").map((property) => JSON.parse(property.value)).filter((requirement) => requirement.role === "source-declaration");
          assert.deepEqual(new Set(declarations.map((requirement) => `${requirement.requestedName}:${requirement.line}`)), new Set([`${names[0]}:2`, `${names[1]}:3`]));
          for (const declaration of declarations) assert.ok(declaration.providerCandidates.every((candidate) => candidate.ref === source["bom-ref"]));
        }
        assertNativeReferences(bom);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  });
  test("aggregate deduplication preserves both case-variant callsites and closes their graph", async () => {
    for (const names of [["Example", "example"], ["example", "Example"]]) {
      const root = mkdtempSync(join(tmpdir(), "cdxgen-native-aggregate-case-"));
      try {
        writeFileSync(join(root, "CMakeLists.txt"), `project(Consumer)\nfind_package(${names[0]})\nfind_package(${names[1]})\n`);
        const { bomJson: bom } = await createMultiXBom([root], { projectType: ["c"], multiProject: true, installDeps: false, deep: false, specVersion: 1.7 });
        const components = bom.components.filter((c) => c.name.toLowerCase() === "example");
        assert.equal(components.length, 1);
        assert.equal(components[0].name, names[0]);
        const requirements = components[0].properties.filter((p) => p.name === "cdx:build:requirement").map((p) => JSON.parse(p.value));
        assert.deepEqual(new Set(requirements.map((r) => `${r.requestedName}:${r.line}`)), new Set([`${names[0]}:2`, `${names[1]}:3`]));
        const refs = new Set();
        const collect = (component) => { refs.add(component["bom-ref"]); for (const child of component.components || []) collect(child); };
        collect(bom.metadata.component);
        for (const component of bom.components) collect(component);
        for (const edge of bom.dependencies) assert.ok(refs.has(edge.ref) && edge.dependsOn.every((ref) => refs.has(ref)));
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  });

  test("aggregate metadata retains generated requests without a detected native project", async () => {
    for (const literal of [true, false]) {
      const root = mkdtempSync(join(tmpdir(), "cdxgen-native-unparented-"));
      try {
        writeFileSync(join(root, "CMakeLists.txt"), `${literal ? "find_package(ZLIB)\n" : ""}find_package(\${GENERATED_PACKAGE})\n`);
        const { bomJson: bom } = await createMultiXBom([root], { projectType: ["c"], multiProject: true, installDeps: false, deep: false, specVersion: 1.7 });
        const requirements = (bom.metadata.properties || []).filter((p) => p.name === "cdx:build:requirement").map((p) => JSON.parse(p.value));
        assert.ok(requirements.some((r) => r.requestedName === "${GENERATED_PACKAGE}" && r.role === "unresolved-expression" && r.file === "CMakeLists.txt" && r.line === (literal ? 2 : 1)));
        assert.ok(!bom.components.some((c) => c.name.includes("$")));
        if (literal) assert.ok(bom.components.some((c) => c.name === "ZLIB"));
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  });
  test("a name-only root cache cannot stamp repeated same-file requests", async () => {
    const root = mkdtempSync(join(tmpdir(), "cdxgen-native-root-cache-"));
    try {
      writeFileSync(join(root, "CMakeLists.txt"), "project(Consumer)\nfind_package(example 1.0 EXACT)\nfind_package(example 2.0 EXACT)\n");
      mkdirSync(join(root, "build"));
      writeFileSync(join(root, "build", "CMakeCache.txt"), "FIND_PACKAGE_MESSAGE_DETAILS_example:INTERNAL=[/provider/two][v2.0()]\n");
      const { bomJson: bom } = await createCppBom(root, { multiProject: true, createMultiXBom: true, installDeps: false, deep: false, specVersion: 1.7 });
      const alternatives = bom.components.filter((component) => component.name === "example");
      assert.deepEqual(new Set(alternatives.map((component) => component.version)), new Set(["1.0", "2.0"]));
      assert.deepEqual(new Set(alternatives.flatMap((component) => component.properties
        .filter((property) => property.name === "cdx:build:requirement").map((property) => JSON.parse(property.value).constraints))),
      new Set(["1.0 EXACT", "2.0 EXACT"]));
      assert.ok(alternatives.every((component) => component.properties.some((property) =>
        property.name === "cdx:version:kind" && property.value === "declared-exact")));
      assert.ok(alternatives.every((component) => !component.properties.some((property) =>
        property.name === "cdx:cmake:resolvedVia" && property.value === "cmake-cache")));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("source-only parsing keeps independent fallback recipes unselected even beside raw configure logs", async () => {
    const root = mkdtempSync(join(tmpdir(), "cdxgen-native-configured-providers-"));
    try {
      writeFileSync(join(root, "CMakeLists.txt"), "project(Consumer)");
      for (const [name, version] of [["provider-one", "1.0"], ["provider-two", "2.0"]]) {
        const consumer = join(root, name);
        mkdirSync(join(consumer, "subprojects"), { recursive: true });
        writeFileSync(join(consumer, "meson.build"), `project('${name}-consumer')\ndependency('shared', fallback: ['${name}', 'dep'])`);
        writeFileSync(join(consumer, "subprojects", `${name}.wrap`), `[wrap-file]\ndirectory = ${name}-9.9\n[provide]\nshared = dep`);
        writeMesonSelection(consumer, "shared", name, version);
      }
      const { bomJson: bom } = await createCppBom(root, { multiProject: true, createMultiXBom: true, installDeps: false, deep: false, specVersion: 1.7 });
      const component = bom.components.find((c) => c.name === "shared");
      assert.ok(component && !component.version);
      const requirements = component.properties.filter((p) => p.name === "cdx:build:requirement").map((p) => JSON.parse(p.value));
      for (const name of ["provider-one", "provider-two"]) {
        const requirement = requirements.find((r) => r.file === `${name}/meson.build`);
        assert.equal(requirement.line, 2);
        assert.ok(requirement.providerCandidates.some((p) => p.name === name && !p.selected));
        assert.ok(!bom.components.some((c) => c.name === name));
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("same-file calls retain independent constraints without selecting an enclosing source copy", async () => {
    const root = mkdtempSync(join(tmpdir(), "cdxgen-native-callsites-"));
    try {
      writeFileSync(join(root, "CMakeLists.txt"), "project(Consumer)");
      mkdirSync(join(root, "provider"));
      writeFileSync(join(root, "provider", "CMakeLists.txt"), "project(example VERSION 2.0)\nfind_package(example 1.0 EXACT)\nfind_package(example 2.0 EXACT)\n");
      const { bomJson: bom } = await createCppBom(root, { multiProject: true, createMultiXBom: true, installDeps: false, deep: false, specVersion: 1.7 });
      const ownSource = bom.metadata.component.components?.find((c) => c.name === "example" && c.version === "2.0");
      assert.ok(ownSource);
      for (const [line, version] of [[3, "2.0"], [2, "1.0"]]) {
        const alternative = bom.components.find((component) => component.name === "example" && component.version === version);
        assert.ok(alternative);
        const record = alternative.properties.filter((property) => property.name === "cdx:build:requirement")
          .map((property) => JSON.parse(property.value)).find((record) => record.line === line);
        assert.equal(record.constraints, `${version} EXACT`);
        assert.ok(!record.providerCandidates.some((provider) => provider.selected || provider.ref === ownSource["bom-ref"]));
      }
      assert.ok(!ownSource.properties.some((property) => property.name === "cdx:build:requirement"));
      const refs = new Set([bom.metadata.component["bom-ref"], ownSource?.["bom-ref"], ...bom.components.map((c) => c["bom-ref"])]);
      for (const edge of bom.dependencies) assert.ok(refs.has(edge.ref) && edge.dependsOn.every((ref) => refs.has(ref)));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("catalog aliases remain requested requirements with callsite provenance", async () => {
    const root = mkdtempSync(join(tmpdir(), "cdxgen-native-aliases-"));
    try {
      writeFileSync(join(root, "CMakeLists.txt"), [
        "project(Consumer)", "if(UNRESOLVED_PLATFORM)", "find_package(GLUT 3.0 REQUIRED)",
        "find_library(DL_DESTINATION NAMES dl)", "find_package(${GENERATED_PACKAGE})", "endif()",
      ].join("\n"));
      const { bomJson: bom } = await createCppBom(root, { multiProject: true, createMultiXBom: true, installDeps: false, deep: false, specVersion: 1.7 });
      assert.ok(!bom.components.some((c) => ["freeglut", "dlfcn-win32", "DL_DESTINATION"].includes(c.name)));
      for (const [name, line] of [["GLUT", 3], ["dl", 4]]) {
        const component = bom.components.find((c) => c.name === name);
        assert.ok(component);
        const requirements = component.properties.filter((p) => p.name === "cdx:build:requirement").map((p) => JSON.parse(p.value));
        assert.ok(requirements.some((r) => r.requestedName === name && r.file === "CMakeLists.txt" && r.line === line && r.conditions.includes("if(UNRESOLVED_PLATFORM)")));
        assert.ok(requirements.some((r) => r.providerCandidates.some((candidate) => candidate.kind === "wrapdb-catalog" && !candidate.selected)));
      }
      assert.ok(bom.metadata.component.properties.some((p) => p.name === "cdx:build:requirement" && JSON.parse(p.value).requestedName === "${GENERATED_PACKAGE}"));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("normal generation preserves independent source candidates without selecting either by ancestry", async () => {
    const root = mkdtempSync(join(tmpdir(), "cdxgen-native-providers-"));
    try {
      writeFileSync(join(root, "CMakeLists.txt"), "project(Consumer)");
      for (const [dir, version] of [["one", "1.2.0"], ["two", "2.4.0"]]) {
        mkdirSync(join(root, dir));
        writeFileSync(join(root, dir, "CMakeLists.txt"), `project(example VERSION ${version})\nfind_package(example REQUIRED)\n`);
      }
      mkdirSync(join(root, "build"));
      writeFileSync(join(root, "build", "CMakeCache.txt"), "FIND_PACKAGE_MESSAGE_DETAILS_example:INTERNAL=[/foreign/provider][v9.9.0()]\n");
      const { bomJson: bom } = await createCppBom(root, { multiProject: true, createMultiXBom: true, installDeps: false, deep: false, specVersion: 1.7 });
      const providers = bom.metadata.component.components.filter((c) => c.name === "example");
      assert.deepEqual(providers.map((c) => c.version).sort(), ["1.2.0", "2.4.0"]);
      assert.ok(!bom.components.some((component) => component.name === "example" && !component.version));
      for (const [dir, version] of [["one", "1.2.0"], ["two", "2.4.0"]]) {
        const provider = providers.find((component) => component.version === version);
        const requirement = provider.properties.filter((property) => property.name === "cdx:build:requirement")
          .map((property) => JSON.parse(property.value)).find((record) => record.file === `${dir}/CMakeLists.txt`);
        assert.ok(requirement);
        assert.ok(requirement.providerCandidates.some((candidate) => candidate.ref === provider["bom-ref"] && !candidate.selected));
        assert.ok(!requirement.providerCandidates.some((candidate) => candidate.ref === providers.find((component) => component.version !== version)["bom-ref"]));
      }
      const refs = new Set([bom.metadata.component["bom-ref"], ...providers.map((component) => component["bom-ref"]), ...bom.components.map((component) => component["bom-ref"])]);
      for (const edge of bom.dependencies) assert.ok(refs.has(edge.ref) && edge.dependsOn.every((ref) => refs.has(ref)));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("external build labels preserve source software and declared target relationships", async () => {
    const root = mkdtempSync(join(tmpdir(), "cdxgen-native-labels-"));
    try {
      writeFileSync(join(root, "CMakeLists.txt"), [
        "project(Consumer)", "ExternalProject_Add(precision_double URL https://example.org/transform-3.3.9.tar.gz SOURCE_DIR ${CMAKE_CURRENT_BINARY_DIR}/src/transform)",
        'ExternalProject_Add(precision_single DOWNLOAD_COMMAND "" SOURCE_DIR ${CMAKE_CURRENT_BINARY_DIR}/src/transform)',
        "function(find_link_library libname)", "find_library(RESULT ${libname})", "find_library(LITERAL_RESULT libname)", "find_package(RealLiteralDependency)", "endfunction()",
        "add_library(transform_double INTERFACE)", "add_library(Transform::Double ALIAS transform_double)",
      ].join("\n"));
      const { bomJson: bom } = await createCppBom(root, { multiProject: true, createMultiXBom: true, installDeps: false, deep: false, specVersion: 1.7 });
      assert.ok(!bom.components.some((c) => ["precision_double", "precision_single", "libname", "RESULT"].includes(c.name)));
      const source = bom.components.find((c) => c.name === "transform");
      assert.equal(source.version, "3.3.9");
      const labels = bom.metadata.component.properties.filter((p) => p.name === "cdx:build:requirement").map((p) => JSON.parse(p.value));
      assert.ok(labels.some((r) => r.requestedName === "libname" && r.role === "unresolved-expression" && r.definition === "function(find_link_library libname)"));
      assert.ok(bom.components.some((c) => c.name === "RealLiteralDependency"), "real literal dependencies in helper bodies must remain explicit");
      for (const name of ["precision_double", "precision_single"]) assert.ok(labels.some((r) => r.requestedName === name && r.role === "build-target" && r.providerCandidates.some((p) => p.ref === source["bom-ref"])));
      assert.ok(labels.some((r) => r.requestedName === "Transform::Double" && r.role === "target-alias" && r.providerCandidates.some((p) => p.name === "transform_double")));
      assert.ok(bom.dependencies.find((d) => d.ref === bom.metadata.component["bom-ref"]).dependsOn.includes(source["bom-ref"]));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("local wrap and raw configuration metadata remain candidate evidence without validated native facts", async () => {
    const root = mkdtempSync(join(tmpdir(), "cdxgen-native-wraps-"));
    try {
      writeFileSync(join(root, "meson.build"), "project('Consumer')\ndependency('glut', fallback: ['freeglut', 'glut_dep'])");
      mkdirSync(join(root, "subprojects"));
      writeFileSync(join(root, "subprojects", "freeglut.wrap"), "[wrap-file]\ndirectory = freeglut-3.6.0\n[provide]\nglut = glut_dep");
      const options = { multiProject: true, createMultiXBom: true, installDeps: false, deep: false, specVersion: 1.7 };
      const { bomJson: unselected } = await createCppBom(root, options);
      assert.ok(unselected.components.find((c) => c.name === "glut" && !c.version));
      assert.ok(!unselected.components.some((c) => c.name === "freeglut"));
      mkdirSync(join(root, "build", "meson-info"), { recursive: true });
      writeFileSync(join(root, "build", "meson-info", "intro-buildoptions.json"), JSON.stringify([
        { name: "wrap_mode", value: "forcefallback" },
      ]));
      writeFileSync(join(root, "build", "meson-info", "meson-info.json"), JSON.stringify({ directories: { source: root }, error: false }));
      writeFileSync(join(root, "build", "meson-info", "intro-projectinfo.json"), JSON.stringify({ subprojects: [{ name: "freeglut", version: "3.6.0" }] }));
      const { bomJson: policyOnly } = await createCppBom(root, options);
      assert.ok(policyOnly.components.find((c) => c.name === "glut" && !c.version));
      writeMesonSelection(root, "glut", "freeglut", "3.6.0");
      const { bomJson: rawMetadata } = await createCppBom(root, options);
      const requirement = rawMetadata.components.find((c) => c.name === "glut");
      assert.ok(requirement && !requirement.version);
      assert.ok(requirement.properties.some((p) => p.name === "cdx:build:requirement" &&
        JSON.parse(p.value).providerCandidates.some((candidate) => candidate.name === "freeglut" && !candidate.selected && candidate.declaredVersion === "3.6.0")));
      writeFileSync(join(root, "meson.build"), "project('Consumer')\ndependency('glut', fallback: ['freeglut', 'glut_dep'])\ndependency('glut', version: '>=2', fallback: ['freeglut', 'other_dep'])");
      const { bomJson: duplicateCalls } = await createCppBom(root, options);
      assert.ok(duplicateCalls.components.find((c) => c.name === "glut" && !c.version));
      assert.ok(!duplicateCalls.components.some((c) => c.name === "freeglut"));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("normal generation retains contradictory repeated constraints and ordered fetch pins", async () => {
    const root = mkdtempSync(join(tmpdir(), "cdxgen-native-constraints-"));
    try {
      writeFileSync(join(root, "CMakeLists.txt"), "project(SourceRoot VERSION 1.0.0)");
      mkdirSync(join(root, "vendor", "example"), { recursive: true });
      writeFileSync(join(root, "vendor", "example", "CMakeLists.txt"), [
        "project(example VERSION 2.0)", "find_package(example 1.0 REQUIRED)",
        "find_package(example 9.0 EXACT REQUIRED)", "find_dependency(example 1.0...3.0)",
        "set(V 1.0.0)",
        "FetchContent_Declare(before GIT_REPOSITORY https://github.com/acme/before.git GIT_TAG v${V})",
        'include("${CMAKE_CURRENT_SOURCE_DIR}/ExampleVersion.cmake")',
        "FetchContent_Declare(after GIT_REPOSITORY https://github.com/acme/after.git GIT_TAG v${V})",
      ].join("\n"));
      // CURRENT_SOURCE_DIR in a parsed source project is its own directory.
      writeFileSync(join(root, "vendor", "example", "ExampleVersion.cmake"), "set(V 2.0.0)");
      const result = await createCppBom(root, { multiProject: true, createMultiXBom: true, installDeps: false, deep: false, specVersion: 1.7 });
      const bom = result.bomJson;
      const flatten = (component) => [component, ...(component.components || []).flatMap(flatten)];
      const allComponents = [bom.metadata.component, ...bom.components].flatMap(flatten);
      const requirement = bom.components.find((component) => component.name === "example" && component.version === "9.0");
      assert.ok(requirement, "the exact declared 9.0 identity remains distinct from the source release 2.0");
      assert.ok(requirement.properties.some((property) => property.name === "cdx:version:kind" && property.value === "declared-exact"));
      const exactRecord = requirement.properties.filter((property) => property.name === "cdx:build:requirement")
        .map((property) => JSON.parse(property.value)).find((record) => record.constraints === "9.0 EXACT");
      assert.ok(exactRecord && !exactRecord.providerCandidates.some((candidate) => candidate.selected));
      assert.deepEqual(new Set(allComponents.filter((c) => c.name === "example").flatMap((c) => c.properties.filter((p) => p.name === "cdx:cmake:versionRequirements").flatMap((p) => p.value.split("|")))),
        new Set(["1.0", "9.0 EXACT", "1.0...3.0"]));
      assert.equal(bom.components.find((c) => c.name === "before").version, "v1.0.0");
      assert.equal(bom.components.find((c) => c.name === "after").version, "v2.0.0");
      const declarations = allComponents.map((component) => component["bom-ref"]);
      assert.equal(new Set(declarations).size, declarations.length);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("keeps competing source releases without guessing the aggregate requirement", async () => {
    const root = mkdtempSync(join(tmpdir(), "cdxgen-native-source-inventory-"));
    try {
      writeFileSync(join(root, "CMakeLists.txt"), "project(SourceRoot VERSION 1.0.0)\nfind_package(example REQUIRED)\n");
      for (const [dir, version] of [["first", "1.2.0"], ["second", "2.4.0"]]) {
        mkdirSync(join(root, dir));
        writeFileSync(join(root, dir, "CMakeLists.txt"), `project(example VERSION ${version})\n`);
      }
      const result = await createCppBom(root, { multiProject: true, createMultiXBom: true, installDeps: false, deep: false, specVersion: 1.7, projectName: "Aggregate", projectVersion: "9.9.9" });
      const bom = result.bomJson;
      assert.equal(bom.metadata.component.name, "Aggregate");
      const source = bom.components.find((c) => c.name === "SourceRoot");
      assert.ok(source, "the detected source root must survive the product override");
      assert.deepEqual(source.components.filter((c) => c.name === "example").map((c) => c.version).sort(), ["1.2.0", "2.4.0"]);
      const requirement = bom.components.find((c) => c.name === "example");
      assert.ok(requirement && !requirement.version);
      const refs = new Set([bom.metadata.component["bom-ref"], ...bom.components.map((c) => c["bom-ref"]), ...source.components.map((c) => c["bom-ref"])]);
      for (const dependency of bom.dependencies) {
        assert.ok(refs.has(dependency.ref));
        assert.ok(dependency.dependsOn.every((ref) => refs.has(ref)));
      }
      assert.ok(bom.dependencies.find((d) => d.ref === bom.metadata.component["bom-ref"]).dependsOn.includes(source["bom-ref"]));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
