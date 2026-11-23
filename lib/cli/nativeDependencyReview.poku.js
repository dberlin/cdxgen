import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { assert, describe, it } from "poku";

import { captureCmakeDependencyFacts, captureMesonDependencyFacts } from "../ecosystems/nativeDependencyCapture.js";
import { readNativeDependencyFacts } from "../ecosystems/nativeDependencyFacts.js";
import { buildMinimalCliEnv, repoDir } from "./bomTestHelpers.poku.js";

const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const generate = (source, facts, output) => {
  const result = spawnSync(process.execPath, [join(repoDir, "bin", "cdxgen.js"), "-t", "cpp", "--no-install-deps", "--native-dependency-facts", facts, "-o", output, source], { cwd: repoDir, encoding: "utf8", timeout: 120000, env: buildMinimalCliEnv({ FETCH_LICENSE: "false", FETCH_REGISTRY_PROVENANCE: "false" }) });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(readFileSync(output, "utf8"));
};
const selected = bom => bom.components.filter(component => component.properties?.some(property => property.name === "cdx:native:providerInstance"));

describe("reviewed native facts correctness regressions", () => {
  it("keeps disabled literals unresolved beside an executed dynamic Meson dependency and retains the dynamic requirement", () => {
    const root = mkdtempSync(join(tmpdir(), "cdx-meson-dynamic-"));
    try {
      for (const variant of ["ordinary-positive", "dynamic-negative"]) {
        const source = join(root, variant, "source");
        const facts = join(root, variant, "facts.json");
        put(join(source, "meson.build"), "project('consumer', version: '1.0')\n" + (variant === "ordinary-positive" ? "dependency('cdx_missing_demo', fallback: ['provider', 'provider_dep'])\n" : "n = 'cdx_missing_demo'\ndependency(n, fallback: ['provider', 'provider_dep'])\nif false\n dependency('cdx_missing_demo', fallback: ['provider', 'provider_dep'])\nendif\n"));
        put(join(source, "subprojects", "provider", "meson.build"), "project('provider', version: '3.8.9')\nprovider_dep = declare_dependency(version: meson.project_version())\n");
        captureMesonDependencyFacts({ sourceRoot: source, buildRoot: join(root, variant, "build"), output: facts });
        const bom = generate(source, facts, join(root, variant, "bom.json"));
        if (variant === "ordinary-positive") assert.deepEqual(selected(bom).map(component => component.version), ["3.8.9"]);
        else {
          assert.equal(selected(bom).length, 0, "a dynamic call's name-only log cannot select the disabled literal callsite");
          assert.ok(bom.components.some(component => component.name === "cdx_missing_demo" && !component.version));
          const requirements = (bom.metadata.component.properties || []).filter(property => property.name === "cdx:build:requirement").map(property => JSON.parse(property.value));
          assert.ok(requirements.some(requirement => requirement.role === "unresolved-expression" && requirement.requestedName === "n"));
        }
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("never accepts a top-level decoy for a nested consumer's relative CMake version input", () => {
    const root = mkdtempSync(join(tmpdir(), "cdx-cmake-relative-input-"));
    try {
      const source = join(root, "source");
      const provider = join(root, "provider");
      const facts = join(root, "facts.json");
      put(join(source, "CMakeLists.txt"), "cmake_minimum_required(VERSION 3.24)\nproject(Consumer VERSION 1.0 LANGUAGES NONE)\nadd_subdirectory(consumer)\n");
      put(join(source, "consumer", "CMakeLists.txt"), `find_package(Dummy 1.0 CONFIG REQUIRED PATHS "${provider}" NO_DEFAULT_PATH)\n`);
      put(join(source, "release.txt"), "99.0.0\n");
      const realInput = join(source, "consumer", "release.txt");
      put(realInput, "1.2.0\n");
      put(join(provider, "DummyConfig.cmake"), 'configure_file(release.txt "${CMAKE_CURRENT_BINARY_DIR}/captured-release.txt" COPYONLY)\nfile(STRINGS "${CMAKE_CURRENT_BINARY_DIR}/captured-release.txt" Dummy_VERSION)\n');
      put(join(provider, "DummyConfigVersion.cmake"), "set(PACKAGE_VERSION 1.2.0)\nset(PACKAGE_VERSION_COMPATIBLE TRUE)\n");
      captureCmakeDependencyFacts({ sourceRoot: source, buildRoot: join(root, "build"), output: facts });
      put(realInput, "2.4.0\n");
      const loaded = readNativeDependencyFacts(facts, source);
      assert.ok(!loaded.valid || loaded.records.every(row => row.applicability !== "selected" || !row.observedVersion), "changed actual nested input must invalidate or leave facts unknown, not trust an unrelated decoy");
      const bom = generate(source, facts, join(root, "bom.json"));
      assert.equal(selected(bom).length, 0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
