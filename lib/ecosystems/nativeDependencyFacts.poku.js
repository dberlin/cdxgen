import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { assert, describe, it } from "poku";

const modulePath = new URL("./nativeDependencyFacts.js", import.meta.url);
const capturePath = new URL("./nativeDependencyCapture.js", import.meta.url);
const put = (file, text) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const run = (cmd, args) => {
  const result = spawnSync(cmd, args, { encoding: "utf8", timeout: 60000 });
  assert.equal(result.status, 0, `${cmd}: ${result.stderr}\n${result.stdout}`);
  return result.stdout;
};

describe("configuration-scoped native dependency facts", () => {
  it("does not bind configured CMake providers to a different NAMES or component contract at the same callsite", async () => {
    const { resolveNativeRequirement } = await import(modulePath);
    const argumentsAtConfigure = ["SDK", "CONFIG", "NAMES", "SDK2", "COMPONENTS", "Core"];
    const facts = { valid: true, records: [{
      consumer: { file: "CMakeLists.txt", line: 3, command: "find_package" },
      request: { name: "SDK", constraints: "", arguments: argumentsAtConfigure },
      applicability: "selected",
      provider: { name: "SDK2", config: "/configured/sdk/SDK2Config.cmake" },
      observedVersion: { kind: "release", value: "2.1.0" },
    }] };
    const request = { file: "CMakeLists.txt", line: 3, command: "find_package", requestedName: "SDK", role: "software", constraints: "" };
    assert.equal(resolveNativeRequirement(facts, { ...request, arguments: argumentsAtConfigure })?.observedVersion.value, "2.1.0");
    assert.equal(resolveNativeRequirement(facts, { ...request, arguments: ["SDK", "CONFIG", "NAMES", "SDK3", "COMPONENTS", "Core"] }), undefined);
    assert.equal(resolveNativeRequirement(facts, { ...request, arguments: ["SDK", "CONFIG", "NAMES", "SDK2", "COMPONENTS", "Extras"] }), undefined);
  });

  it("captures real CMake providers per executed callsite and rejects stale or foreign evidence", async () => {
    assert.ok(existsSync(modulePath), "the validating reader must exist");
    assert.ok(existsSync(capturePath), "the real configure capture must exist");
    const { captureCmakeDependencyFacts } = await import(capturePath);
    const {
      readNativeDependencyFacts,
      resolveNativeRequirement,
      applyNativeDependencyFacts,
      nativeFileFingerprint,
    } = await import(modulePath);
    const scratch = mkdtempSync(join(tmpdir(), "cdx-native-facts-"));
    try {
      const source = join(scratch, "src");
      const build = join(scratch, "build");
      const factsFile = join(scratch, "facts.json");
      put(
        join(source, "CMakeLists.txt"),
        "cmake_minimum_required(VERSION 3.24)\nproject(Consumers NONE)\nadd_subdirectory(a)\nadd_subdirectory(b)\nif(FALSE)\nfind_package(Dummy 9 CONFIG REQUIRED)\nendif()\nfind_package(NeverInstalled QUIET CONFIG)\n",
      );
      for (const [consumer, version] of [
        ["a", "1.2.0"],
        ["b", "2.4.0"],
      ]) {
        const provider = join(scratch, `provider-${consumer}`);
        put(join(provider, "release.txt"), `${version}\n`);
        put(
          join(provider, "DummyConfig.cmake"),
          'file(STRINGS "${CMAKE_CURRENT_LIST_DIR}/release.txt" Dummy_VERSION)\n',
        );
        put(
          join(provider, "DummyConfigVersion.cmake"),
          `set(PACKAGE_VERSION ${version})\nset(PACKAGE_VERSION_COMPATIBLE TRUE)\n`,
        );
        put(
          join(source, consumer, "CMakeLists.txt"),
          `unset(Dummy_DIR CACHE)\nfind_package(Dummy 1.0 CONFIG REQUIRED PATHS "${provider}" NO_DEFAULT_PATH)\n`,
        );
      }
      const original = readFileSync(join(source, "CMakeLists.txt"), "utf8");
      const facts = captureCmakeDependencyFacts({
        sourceRoot: source,
        buildRoot: build,
        output: factsFile,
      });
      assert.equal(facts.format, "native-dependency-resolution-v1");
      assert.equal(
        facts.records.filter((r) => r.applicability === "selected").length,
        2,
      );
      assert.equal(
        facts.records.find((r) => r.request.name === "NeverInstalled")
          .applicability,
        "not-found",
      );
      const loaded = readNativeDependencyFacts(factsFile, source, {
        cmakeCache: join(build, "CMakeCache.txt"),
      });
      assert.equal(loaded.valid, true, JSON.stringify(loaded.diagnostics));
      const requirement = (file, line = 2, constraints = "1.0") => ({
        requestedName: "Dummy",
        file,
        line,
        command: "find_package",
        role: "software",
        constraints,
        conditions: [],
      });
      assert.equal(
        resolveNativeRequirement(loaded, requirement("a/CMakeLists.txt"))
          .observedVersion.value,
        "1.2.0",
      );
      assert.equal(
        resolveNativeRequirement(loaded, requirement("b/CMakeLists.txt"))
          .observedVersion.value,
        "2.4.0",
      );
      assert.equal(
        resolveNativeRequirement(loaded, requirement("CMakeLists.txt", 6, "9")),
        undefined,
      );
      const contradictory = structuredClone(loaded);
      contradictory.records[0].request.constraints = ">=9.0";
      assert.equal(
        resolveNativeRequirement(
          contradictory,
          requirement("a/CMakeLists.txt", 2, ">=9.0"),
        ),
        undefined,
      );
      const mutableRef = structuredClone(loaded);
      mutableRef.records[0].observedVersion = {
        value: "main",
        kind: "source-revision",
      };
      assert.equal(
        resolveNativeRequirement(mutableRef, requirement("a/CMakeLists.txt")),
        undefined,
      );
      assert.equal(
        resolveNativeRequirement(
          loaded,
          requirement("a/CMakeLists.txt", 2, "3.0"),
        ),
        undefined,
      );
      const components = ["a", "b"].map((c) => ({
        name: "Dummy",
        purl: "pkg:generic/Dummy",
        "bom-ref": `old-${c}`,
        properties: [
          {
            name: "cdx:build:requirement",
            value: JSON.stringify(requirement(`${c}/CMakeLists.txt`)),
          },
        ],
      }));
      const dependencies = [
        { ref: "parent", dependsOn: ["old-a", "old-b"] },
        { ref: "old-a", dependsOn: [] },
        { ref: "old-b", dependsOn: [] },
      ];
      applyNativeDependencyFacts(components, dependencies, loaded);
      assert.deepEqual(
        components.map((c) => c.version),
        ["1.2.0", "2.4.0"],
      );
      assert.notEqual(components[0]["bom-ref"], components[1]["bom-ref"]);
      assert.deepEqual(
        dependencies[0].dependsOn,
        components.map((c) => c["bom-ref"]),
      );
      const aggregate = {
        name: "Dummy",
        "bom-ref": "aggregate",
        properties: components.flatMap((c) =>
          c.properties.filter((p) => p.name === "cdx:build:requirement"),
        ),
      };
      assert.equal(applyNativeDependencyFacts([aggregate], [], loaded), 0);
      assert.equal(aggregate.version, undefined);
      const addedInput = join(source, "added.cmake");
      put(addedInput, "# new build input\n");
      assert.equal(
        readNativeDependencyFacts(factsFile, source).valid,
        false,
        "new source build inputs invalidate configuration evidence",
      );
      rmSync(addedInput);
      const header = join(scratch, "provider-a", "release.txt");
      put(header, "9.9.9\n");
      assert.equal(
        readNativeDependencyFacts(factsFile, source).valid,
        false,
        "changing a read version input invalidates facts",
      );
      put(header, "1.2.0\n");
      assert.equal(readNativeDependencyFacts(factsFile, source).valid, true);
      const forged = structuredClone(facts);
      forged.records[0].observedVersion.value = "99.0.0";
      put(join(scratch, "forged.json"), JSON.stringify(forged));
      assert.equal(
        readNativeDependencyFacts(join(scratch, "forged.json"), source).valid,
        false,
        "literal version overrides are not capture evidence",
      );
      const forgedObservations = join(scratch, "forged-observations.json");
      put(forgedObservations, JSON.stringify(forged.records));
      forged.evidence = forged.evidence
        .filter((f) => f.path !== forged.capture.path)
        .concat(nativeFileFingerprint(forgedObservations));
      forged.capture.path = forgedObservations;
      put(join(scratch, "forged-raw-mismatch.json"), JSON.stringify(forged));
      assert.equal(
        readNativeDependencyFacts(
          join(scratch, "forged-raw-mismatch.json"),
          source,
        ).valid,
        false,
        "rehashing an override table cannot replace raw configure evidence",
      );
      const cacheFile = join(build, "CMakeCache.txt");
      const cache = readFileSync(cacheFile, "utf8");
      put(cacheFile, `${cache}\nCMAKE_SYSROOT:PATH=/foreign/sysroot\n`);
      assert.equal(
        readNativeDependencyFacts(factsFile, source).valid,
        false,
        "changed sysroot configuration is rejected",
      );
      put(cacheFile, cache);
      assert.equal(
        readNativeDependencyFacts(factsFile, join(scratch, "other")).valid,
        false,
      );
      const otherBuild = join(scratch, "other-build");
      run("cmake", ["-S", source, "-B", otherBuild]);
      assert.equal(
        readNativeDependencyFacts(factsFile, source, {
          cmakeCache: join(otherBuild, "CMakeCache.txt"),
        }).valid,
        false,
      );
      assert.equal(
        readFileSync(join(source, "CMakeLists.txt"), "utf8"),
        original,
      );
      put(join(source, "a", "CMakeLists.txt"), "# changed\n");
      assert.equal(readNativeDependencyFacts(factsFile, source).valid, false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("leaves custom discovery, unknown versions, repeated provider invocations and contradictory constraints unresolved", async () => {
    const { captureCmakeDependencyFacts } = await import(capturePath);
    const { readNativeDependencyFacts, resolveNativeRequirement } =
      await import(modulePath);
    const scratch = mkdtempSync(join(tmpdir(), "cdx-native-ambiguity-"));
    try {
      const source = join(scratch, "src");
      const providerA = join(scratch, "provider-a");
      const providerB = join(scratch, "provider-b");
      put(join(providerA, "DummyConfig.cmake"), "set(Dummy_VERSION 1.2.0)\n");
      put(join(providerB, "DummyConfig.cmake"), "set(Dummy_VERSION 2.4.0)\n");
      put(
        join(source, "CMakeLists.txt"),
        `cmake_minimum_required(VERSION 3.24)\nproject(Repeated NONE)\nmacro(discover provider)\nunset(Dummy_DIR CACHE)\nfind_package(Dummy CONFIG REQUIRED PATHS "\${provider}" NO_DEFAULT_PATH)\nendmacro()\ndiscover("${providerA}")\ndiscover("${providerB}")\n`,
      );
      const output = join(scratch, "repeat.json");
      const repeated = captureCmakeDependencyFacts({
        sourceRoot: source,
        buildRoot: join(scratch, "build"),
        output,
      });
      assert.equal(repeated.records.length, 2);
      assert.equal(
        resolveNativeRequirement(readNativeDependencyFacts(output, source), {
          requestedName: "Dummy",
          file: "CMakeLists.txt",
          line: 5,
          command: "find_package",
          role: "software",
          constraints: "",
        }),
        undefined,
      );
      assert.equal(
        repeated.configuration.providerSelectionUnchanged,
        true,
        "capture proves selection against the uninstrumented configure",
      );
      put(
        join(source, "CMakeLists.txt"),
        `cmake_minimum_required(VERSION 3.24)\nproject(Custom NONE)\nmacro(find_package)\n_find_package(\${ARGV})\nendmacro()\nfind_package(Dummy CONFIG REQUIRED PATHS "${providerA}" NO_DEFAULT_PATH)\n`,
      );
      const custom = captureCmakeDependencyFacts({
        sourceRoot: source,
        buildRoot: join(scratch, "custom-build"),
        output: join(scratch, "custom.json"),
      });
      assert.equal(
        custom.records.every((row) => row.applicability === "unknown"),
        true,
      );
      put(
        join(providerA, "DummyConfig.cmake"),
        "# provider exposes no version\n",
      );
      put(
        join(source, "CMakeLists.txt"),
        `cmake_minimum_required(VERSION 3.24)\nproject(Unknown NONE)\nset(Dummy_VERSION_STRING 88.0)\nfind_package(Dummy CONFIG REQUIRED PATHS "${providerA}" NO_DEFAULT_PATH)\n`,
      );
      const unknown = captureCmakeDependencyFacts({
        sourceRoot: source,
        buildRoot: join(scratch, "unknown-build"),
        output: join(scratch, "unknown.json"),
      });
      assert.equal(unknown.records[0].observedVersion, undefined);
      put(
        join(providerA, "DummyConfig.cmake"),
        'execute_process(COMMAND "${CMAKE_COMMAND}" -E echo 1.2.0 OUTPUT_VARIABLE Dummy_VERSION OUTPUT_STRIP_TRAILING_WHITESPACE)\n',
      );
      const subprocess = captureCmakeDependencyFacts({
        sourceRoot: source,
        buildRoot: join(scratch, "subprocess-build"),
        output: join(scratch, "subprocess.json"),
      });
      assert.equal(
        subprocess.records[0].applicability,
        "unknown",
        "untracked command inputs cannot authorize a provider version",
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("reads real Meson introspection and selected fallback without selecting dormant recipes", async () => {
    assert.ok(existsSync(capturePath), "the real Meson capture must exist");
    const { captureMesonDependencyFacts } = await import(capturePath);
    const { readNativeDependencyFacts, resolveNativeRequirement } =
      await import(modulePath);
    const scratch = mkdtempSync(join(tmpdir(), "cdx-meson-facts-"));
    try {
      const source = join(scratch, "src");
      const build = join(scratch, "build");
      const output = join(scratch, "facts.json");
      put(
        join(source, "meson.build"),
        "project('consumer', version: '1.0')\nchosen = dependency('cdx_missing_demo', version: ['>= 1.0', '<4.0'], fallback: ['provider', 'provider_dep'])\nif false\n  dependency('dormant', fallback: ['dormant', 'dep'])\nendif\ndependency('localpc', required: false)\n",
      );
      put(
        join(source, "subprojects", "provider", "meson.build"),
        "project('provider', version: '3.7.1')\nfs = import('fs')\nprovider_dep = declare_dependency(version: fs.read('release.txt').strip())\n",
      );
      put(join(source, "subprojects", "provider", "release.txt"), "3.8.9\n");
      const pcDir = join(scratch, "pkgconfig");
      put(
        join(pcDir, "localpc.pc"),
        "Name: localpc\nDescription: Actual external dependency\nVersion: 5.6.7\n",
      );
      const facts = captureMesonDependencyFacts({
        sourceRoot: source,
        buildRoot: build,
        output,
        configureArgs: [`--pkg-config-path=${pcDir}`],
      });
      const selected = facts.records.filter(
        (r) => r.applicability === "selected",
      );
      assert.equal(selected.length, 1);
      assert.equal(selected[0].request.name, "cdx_missing_demo");
      assert.equal(
        selected[0].observedVersion.value,
        "3.8.9",
        "actual dependency version is not replaced by subproject version",
      );
      assert.equal(selected[0].provider.name, "provider");
      assert.equal(readNativeDependencyFacts(output, source).valid, true);
      const requirement = {
        requestedName: "cdx_missing_demo",
        file: "meson.build",
        line: 2,
        command: "dependency",
        role: "software",
        constraints: "['>= 1.0', '<4.0']",
        conditions: [],
      };
      assert.equal(
        resolveNativeRequirement(
          readNativeDependencyFacts(output, source),
          requirement,
        )?.observedVersion.value,
        "3.8.9",
        "complete literal constraint lists bind semantically",
      );
      assert.equal(
        resolveNativeRequirement(readNativeDependencyFacts(output, source), {
          ...requirement,
          constraints: "['>= 1.0', '<3.0']",
        }),
        undefined,
      );
      assert.equal(
        facts.records.find((r) => r.request.name === "dormant").applicability,
        "unknown",
      );
      assert.equal(
        facts.records.find((r) => r.request.name === "localpc").applicability,
        "unknown",
        "unbound external .pc provenance is not authoritative",
      );
      const release = join(source, "subprojects", "provider", "release.txt");
      put(release, "9.9.9\n");
      assert.equal(
        readNativeDependencyFacts(output, source).valid,
        false,
        "changed selected fallback version input invalidates facts",
      );
      put(release, "3.8.9\n");
      const externalVersion = join(scratch, "external-version.txt");
      put(externalVersion, "3.8.9\n");
      put(
        join(source, "subprojects", "provider", "meson.build"),
        `project('provider', version: '3.7.1')\nprovider_dep = declare_dependency(version: run_command('cat', '${externalVersion}', check: true).stdout().strip())\n`,
      );
      const subprocess = captureMesonDependencyFacts({
        sourceRoot: source,
        buildRoot: join(scratch, "subprocess-build"),
        output: join(scratch, "subprocess.json"),
        configureArgs: [`--pkg-config-path=${pcDir}`],
      });
      assert.equal(
        subprocess.records.find((r) => r.request.name === "cdx_missing_demo")
          .applicability,
        "unknown",
        "untracked Meson subprocess reads cannot authorize a provider version",
      );
      put(
        join(source, "subprojects", "provider", "meson.build"),
        `project('provider', version: '3.7.1')\nfs = import('fs')\nprovider_dep = declare_dependency(version: fs.read('${externalVersion}').strip())\n`,
      );
      const externalRead = captureMesonDependencyFacts({
        sourceRoot: source,
        buildRoot: join(scratch, "external-read-build"),
        output: join(scratch, "external-read.json"),
        configureArgs: [`--pkg-config-path=${pcDir}`],
      });
      assert.equal(
        externalRead.records.find((r) => r.request.name === "cdx_missing_demo")
          .applicability,
        "unknown",
        "out-of-provider source reads are unsupported, not untracked authority",
      );
      put(join(source, "meson.build"), "project('changed')\n");
      assert.equal(readNativeDependencyFacts(output, source).valid, false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
