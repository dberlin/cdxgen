import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { assert, it } from "poku";

import { captureCmakeDependencyFacts } from "../ecosystems/nativeDependencyCapture.js";
import { readNativeDependencyFacts } from "../ecosystems/nativeDependencyFacts.js";
import { buildMinimalCliEnv, repoDir } from "./bomTestHelpers.poku.js";

const put = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

it("preserves effective typed, initial-cache and preset initializer lists before observing actual providers", () => {
  const root = mkdtempSync(join(tmpdir(), "cdx-native-initializers-"));
  try {
    const source = join(root, "source");
    put(
      join(source, "CMakeLists.txt"),
      "cmake_minimum_required(VERSION 3.24)\nproject(InitializerConsumer VERSION 1.0 LANGUAGES NONE)\nfind_package(Dummy 1.0 CONFIG REQUIRED)\n",
    );
    const initializers = [];
    for (const [name, version] of [
      ["first", "1.2.0"],
      ["second", "2.4.0"],
    ]) {
      const provider = join(root, name);
      put(
        join(provider, "DummyConfig.cmake"),
        `set(Dummy_VERSION ${version})\n`,
      );
      put(
        join(provider, "DummyConfigVersion.cmake"),
        `set(PACKAGE_VERSION ${version})\nset(PACKAGE_VERSION_COMPATIBLE TRUE)\n`,
      );
      const initializer = join(root, `${name}.cmake`);
      put(
        initializer,
        `set(Dummy_DIR "${provider}" CACHE PATH "Actual initializer-selected provider" FORCE)\n`,
      );
      initializers.push(initializer);
    }
    const includes = initializers.join(";");
    const cacheScript = join(root, "initial-cache.cmake");
    put(
      cacheScript,
      `set(CMAKE_PROJECT_TOP_LEVEL_INCLUDES "${includes}" CACHE STRING "Required initializer list")\n`,
    );
    put(
      join(source, "CMakePresets.json"),
      JSON.stringify({
        version: 3,
        configurePresets: [
          {
            name: "observer-test",
            generator: "Unix Makefiles",
            binaryDir: join(root, "unused-preset-build"),
            cacheVariables: {
              CMAKE_PROJECT_TOP_LEVEL_INCLUDES: {
                type: "STRING",
                value: includes,
              },
            },
          },
        ],
      }),
    );
    const originalSource = readFileSync(join(source, "CMakeLists.txt"), "utf8");
    let lastFacts;
    for (const [mode, configureArgs] of [
      ["typed", [`-DCMAKE_PROJECT_TOP_LEVEL_INCLUDES:FILEPATH=${includes}`]],
      ["initial-cache", ["-C", cacheScript]],
      ["preset", ["--preset", "observer-test"]],
    ]) {
      const build = join(root, mode, "build");
      const factsPath = join(root, mode, "facts.json");
      const facts = captureCmakeDependencyFacts({
        sourceRoot: source,
        buildRoot: build,
        output: factsPath,
        configureArgs,
      });
      const selected = facts.records.filter(
        (row) => row.applicability === "selected",
      );
      assert.equal(selected.length, 1);
      assert.equal(selected[0].consumer.file, "CMakeLists.txt");
      assert.equal(selected[0].consumer.line, 3);
      assert.equal(selected[0].observedVersion.value, "2.4.0");
      assert.equal(
        selected[0].provider.config,
        join(root, "second", "DummyConfig.cmake"),
      );
      assert.equal(facts.configuration.providerSelectionUnchanged, true);
      assert.ok(
        initializers.every((file) =>
          facts.inputs.some((input) => input.path === file),
        ),
      );
      const cache = readFileSync(join(build, "CMakeCache.txt"), "utf8");
      const configuredIncludes = cache
        .split("\n")
        .find((line) => line.startsWith("CMAKE_PROJECT_TOP_LEVEL_INCLUDES:"))
        .split("=")
        .slice(1)
        .join("=");
      assert.equal(
        configuredIncludes,
        `${includes};${join(dirname(facts.capture.path), "capture.cmake")}`,
      );
      const mounts = [];
      for (const entry of readdirSync("/", { withFileTypes: true })) {
        if (["dev", "proc", "sys"].includes(entry.name)) continue;
        const path = `/${entry.name}`;
        if (entry.isSymbolicLink())
          mounts.push("--symlink", readlinkSync(path), path);
        else mounts.push("--ro-bind", path, path);
      }
      const output = join(build, "bom.json");
      const scannerTmp = join(build, "scanner-tmp");
      mkdirSync(scannerTmp);
      const result = spawnSync(
        "bwrap",
        [
          "--die-with-parent",
          "--unshare-net",
          ...mounts,
          "--dev",
          "/dev",
          "--proc",
          "/proc",
          "--bind",
          build,
          build,
          "--ro-bind",
          source,
          source,
          "--chdir",
          repoDir,
          "--setenv",
          "TMPDIR",
          scannerTmp,
          "--",
          process.execPath,
          join(repoDir, "bin", "cdxgen.js"),
          "-t",
          "cpp",
          "--no-install-deps",
          "--native-dependency-facts",
          factsPath,
          "--cmake-cache",
          join(build, "CMakeCache.txt"),
          "-o",
          output,
          source,
        ],
        {
          encoding: "utf8",
          timeout: 120000,
          env: buildMinimalCliEnv({
            FETCH_LICENSE: "false",
            FETCH_REGISTRY_PROVENANCE: "false",
          }),
        },
      );
      assert.equal(result.status, 0, result.stderr + result.stdout);
      const bom = JSON.parse(readFileSync(output, "utf8"));
      const components = bom.components.filter((component) =>
        component.properties?.some(
          (property) => property.name === "cdx:native:providerInstance",
        ),
      );
      assert.equal(components.length, 1);
      assert.equal(components[0].version, "2.4.0");
      assert.equal(
        readFileSync(join(source, "CMakeLists.txt"), "utf8"),
        originalSource,
      );
      lastFacts = factsPath;
    }
    const originalInitializer = readFileSync(initializers[1], "utf8");
    put(
      initializers[1],
      `${originalInitializer}\n# changed required initializer\n`,
    );
    assert.equal(
      readNativeDependencyFacts(lastFacts, source).valid,
      false,
      "initializer changes invalidate captured facts",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
