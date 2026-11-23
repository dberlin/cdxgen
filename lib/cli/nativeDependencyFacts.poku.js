import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { assert, describe, it } from "poku";

import {
  captureCmakeDependencyFacts,
  captureMesonDependencyFacts,
} from "../ecosystems/nativeDependencyCapture.js";
import { buildMinimalCliEnv, repoDir } from "./bomTestHelpers.poku.js";

const put = (file, text) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const tree = (root) => {
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else
        files.push([
          path,
          createHash("sha256").update(readFileSync(path)).digest("hex"),
        ]);
    }
  };
  visit(root);
  return files;
};
const cli = (source, facts, output, extra = []) => {
  const args = [
    join(repoDir, "bin", "cdxgen.js"),
    "-t",
    "cpp",
    "--no-install-deps",
    "--no-validate",
    "--native-dependency-facts",
    facts,
    "-o",
    output,
    ...extra,
    source,
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: repoDir,
    encoding: "utf8",
    timeout: 120000,
    env: buildMinimalCliEnv({
      FETCH_LICENSE: "false",
      FETCH_REGISTRY_PROVENANCE: "false",
    }),
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return JSON.parse(readFileSync(output, "utf8"));
};

describe("native facts through the normal cdxgen CLI", () => {
  it("binds selected CMake providers only and keeps graph identity and source bytes", () => {
    const scratch = mkdtempSync(join(tmpdir(), "cdx-facts-cli-cmake-"));
    try {
      const source = join(scratch, "source");
      const build = join(scratch, "build");
      const factsFile = join(scratch, "facts.json");
      put(
        join(source, "CMakeLists.txt"),
        "cmake_minimum_required(VERSION 3.24)\nproject(Dummy VERSION 7.0 LANGUAGES NONE)\nadd_subdirectory(a)\nadd_subdirectory(b)\nadd_subdirectory(c)\nif(FALSE)\nfind_package(Dummy 9 CONFIG REQUIRED)\nendif()\n",
      );
      for (const [name, version] of [
        ["a", "1.2.0"],
        ["b", "2.4.0"],
        ["c", "1.2.0"],
      ]) {
        const provider = join(scratch, `provider-${name}`);
        put(
          join(provider, "DummyConfig.cmake"),
          `set(Dummy_VERSION ${version})\n`,
        );
        put(
          join(provider, "DummyConfigVersion.cmake"),
          `set(PACKAGE_VERSION ${version})\nset(PACKAGE_VERSION_COMPATIBLE TRUE)\n`,
        );
        put(
          join(source, name, "CMakeLists.txt"),
          `unset(Dummy_DIR CACHE)\nfind_package(Dummy 1.0 CONFIG REQUIRED PATHS "${provider}" NO_DEFAULT_PATH)\n`,
        );
      }
      put(
        join(source, "unselected-one", "CMakeLists.txt"),
        "project(Dummy VERSION 11.0 LANGUAGES NONE)\n",
      );
      put(
        join(source, "unselected-two", "CMakeLists.txt"),
        "project(Dummy VERSION 12.0 LANGUAGES NONE)\n",
      );
      const before = tree(source);
      const facts = captureCmakeDependencyFacts({
        sourceRoot: source,
        buildRoot: build,
        output: factsFile,
      });
      const bom = cli(source, factsFile, join(scratch, "bom.json"), [
        "--cmake-cache",
        join(build, "CMakeCache.txt"),
      ]);
      const selected = bom.components.filter((c) =>
        c.properties?.some((p) => p.name === "cdx:native:configuration"),
      );
      assert.deepEqual(selected.map((c) => c.version).sort(), [
        "1.2.0",
        "1.2.0",
        "2.4.0",
      ]);
      const sameRelease = selected.filter((c) => c.version === "1.2.0");
      assert.equal(
        sameRelease[0].purl,
        sameRelease[1].purl,
        "upstream package coordinates stay valid and unchanged",
      );
      assert.notEqual(
        sameRelease[0]["bom-ref"],
        sameRelease[1]["bom-ref"],
        "configured provider instances keep distinct graph identity",
      );
      const unresolved = bom.components.filter(
        (c) =>
          c.name.toLowerCase() === "dummy" &&
          !c.properties?.some((p) => p.name === "cdx:native:configuration"),
      );
      assert.ok(
        unresolved.some((c) => !c.version),
        "disabled callsite remains unresolved",
      );
      assert.equal(
        bom.metadata.component.version,
        "7.0",
        "selected providers do not overwrite the same-name source project",
      );
      assert.deepEqual(
        (bom.metadata.component.components || []).map((c) => c.version).sort(),
        ["11.0", "12.0"],
      );
      const all = [
        bom.metadata.component,
        ...(bom.metadata.component.components || []),
        ...bom.components,
      ];
      const refs = new Set(all.map((c) => c["bom-ref"]));
      assert.equal(refs.size, all.length);
      for (const edge of bom.dependencies || []) {
        assert.ok(refs.has(edge.ref));
        for (const ref of edge.dependsOn || []) assert.ok(refs.has(ref));
      }
      assert.equal(facts.configuration.providerSelectionUnchanged, true);
      assert.deepEqual(tree(source), before);
      put(join(source, "a", "CMakeLists.txt"), "# stale source input\n");
      const stale = cli(source, factsFile, join(scratch, "stale-bom.json"));
      assert.equal(
        stale.components.some((c) =>
          c.properties?.some((p) => p.name === "cdx:native:configuration"),
        ),
        false,
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("consumes independent real Meson providers through explicit facts and rejects a foreign source configuration", () => {
    const scratch = mkdtempSync(join(tmpdir(), "cdx-facts-cli-meson-"));
    try {
      let firstFacts;
      for (const [provider, version] of [
        ["provider-one", "3.7.1"],
        ["provider-two", "4.8.2"],
      ]) {
        const root = join(scratch, provider);
        const source = join(root, "source");
        const build = join(root, "build");
        const facts = join(root, "facts.json");
        put(
          join(source, "meson.build"),
          `project('consumer', version: '1.0')\nchosen = dependency('cdx_missing_demo', version: ['>= 1.0', '<5.0'], fallback: ['${provider}', 'provider_dep'])\nif false\n dependency('dormant', fallback: ['dormant', 'dep'])\nendif\n`,
        );
        put(
          join(source, "subprojects", provider, "meson.build"),
          `project('${provider}', version: '${version}')\nprovider_dep = declare_dependency(version: meson.project_version())\n`,
        );
        const before = tree(source);
        captureMesonDependencyFacts({
          sourceRoot: source,
          buildRoot: build,
          output: facts,
        });
        const bom = cli(source, facts, join(root, "bom.json"));
        const selected = bom.components.filter((c) =>
          c.properties?.some((p) => p.name === "cdx:native:configuration"),
        );
        assert.equal(selected.length, 1);
        assert.equal(selected[0].version, version);
        assert.ok(
          selected[0].properties.some(
            (p) => p.name === "cdx:native:provider" && p.value === provider,
          ),
        );
        assert.ok(
          bom.components.some((c) => c.name === "dormant" && !c.version),
        );
        assert.deepEqual(tree(source), before);
        if (firstFacts) {
          const foreign = cli(
            source,
            firstFacts,
            join(root, "foreign-bom.json"),
          );
          assert.equal(
            foreign.components.some((c) =>
              c.properties?.some((p) => p.name === "cdx:native:configuration"),
            ),
            false,
          );
        } else firstFacts = facts;
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
