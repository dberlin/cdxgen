import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, it } from "poku";

import { nativeLanguageSourceFacts, nativeMesonExports, nativeMesonTemplateVersions, nativeRegistryRecipeFacts } from "./nativeRegistryMetadata.js";
import { nativeVcpkgProvider } from "./nativeExternalMetadata.js";

describe("literal registry recipe metadata", () => {
  it("declares Cargo binary and proc-macro exports under their exact workspace owner", () => {
    const workspace = `/src/Cargo.toml`;
    const file = "/src/crates/cli/Cargo.toml";
    const text = `[package]
name = "cli-owner"
version.workspace = true
autobins = false
[[bin]]
name = "demo"
path = "src/real.rs"
required-features = ["runner"]
[[bin]]
name = "not-in-source-inventory"
path = "src/missing.rs"
[lib]
proc-macro = true
`;
    const metadata = new Map([[workspace, `[workspace]
members = ["crates/*"]
exclude = ["crates/unrelated"]
[workspace.package]
version = "0.4.5"
`]]);
    const inputs = { root: "/src", read: (path) => metadata.get(path), has: (path) =>
      ["/src/crates/cli/src/real.rs", "/src/crates/cli/src/lib.rs"].includes(path) };
    const facts = nativeLanguageSourceFacts(file, text, inputs);
    assert.equal(facts.version, "0.4.5");
    assert.equal(facts.versionSource, workspace);
    assert.deepEqual(facts.exports.map(({ kind, name, conditions }) => [kind, name, conditions]), [
      ["tool", "demo", ["cargo-feature:runner"]],
      ["target", "cli_owner", []],
    ]);
    assert.ok(facts.exports.every((entry) => entry.materialUnknown));
    assert.equal(nativeLanguageSourceFacts("/src/crates/unrelated/Cargo.toml", text, inputs).version, undefined);
  });

  it("discovers demanded conventional Cargo bins without treating unrelated source files as tools", () => {
    const inputs = new Set(["/src/src/bin/fast.rs", "/src/src/bin/slow/main.rs", "/src/src/bin/unused.rs"]);
    const text = '[package]\nname = "crate-owner"\nversion = "4.2.0"\n';
    const options = { root: "/src", has: (path) => inputs.has(path), wanted: new Set(["fast", "slow", "missing", "../unused"]) };
    const facts = nativeLanguageSourceFacts("/src/Cargo.toml", text, options);
    assert.deepEqual(facts.exports.map((entry) => [entry.name, entry.artifact]), [
      ["fast", "/src/src/bin/fast.rs"], ["slow", "/src/src/bin/slow/main.rs"],
    ]);
    assert.deepEqual(nativeLanguageSourceFacts("/src/Cargo.toml", `${text}autobins = false\n`, options).exports, []);
  });

  it("preserves Python script wrapper identity without claiming bundled binary material", () => {
    const file = "/src/pyproject.toml";
    const facts = nativeLanguageSourceFacts(file, `[project]
name = "test-tools"
version = "23.0.0"
[project.scripts]
FileCheck = "test_tools.wrapper:run_test_tool"
`);
    assert.equal(facts.name, "test-tools");
    assert.equal(facts.version, "23.0.0");
    assert.deepEqual(facts.exports.map(({ name, entryPoint, materialUnknown }) => [name, entryPoint, materialUnknown]),
      [["FileCheck", "test_tools.wrapper:run_test_tool", true]]);
  });

  it("does not publish a Meson Rust proc macro as a native linker library", () => {
    const exports = [];
    nativeMesonExports(`project('paste', 'rust', version: '1.0.14')
rust = import('rust')
lib = rust.proc_macro('paste', files('src/lib.rs'))
dep_paste = declare_dependency(link_with: [lib])
`, "/src/meson.build", "/src", (...entry) => exports.push(entry.slice(0, 2)));
    assert.deepEqual(exports, [["meson", "paste"], ["target", "paste"], ["meson", "dep_paste"]]);
  });

  it("projects only literal Meson interface versions, keeping conflicting/unknown inputs unknown", () => {
    const versions = nativeMesonTemplateVersions([`
      api_major = 1
      api_minor = 24
      api_micro = 0
      api_version = '@0@.@1@.@2@'.format(api_major, api_minor, api_micro)
      cfg.set('VA_API_VERSION', api_version)
      bad = '@0@.@1@'.format(api_major, missing)
      cfg.set('UNKNOWN_VERSION', bad)
    `]);
    assert.equal(versions.get("VA_API_VERSION"), "1.24.0");
    assert.equal(versions.has("UNKNOWN_VERSION"), false);
    assert.equal(nativeMesonTemplateVersions([`api = '1.0'
cfg.set('API_VERSION', api)`, "api = '2.0'"]).has("API_VERSION"), false);
  });

  it("does not assign a parent source release to independently configured embedded libraries", () => {
    const root = "/cache/source-metadata/hash";
    const files = new Map([
      [`${root}/archive-manifest.json`, JSON.stringify({ members: ["Python-2.7.18/configure", "Python-2.7.18/Misc/python.pc.in", "Python-2.7.18/Modules/zlib/configure", "Python-2.7.18/Modules/zlib/zlib.pc.in"] })],
      [`${root}/Python-2.7.18/Misc/python.pc.in`, "Name: Python\nVersion: @VERSION@\n"],
      [`${root}/Python-2.7.18/Modules/zlib/zlib.pc.in`, "Name: zlib\nVersion: @VERSION@\n"],
    ]);
    const provider = nativeVcpkgProvider(JSON.stringify({ name: "python2", version: "2.7.18" }),
      `vcpkg_from_github(REPO owner/python REF v2.7.18 SHA512 ${"a".repeat(128)})`, "", files);
    assert.equal(provider.version, "2.7.18");
    assert.ok(provider.exports.some((e) => e.name === "python" && e.interfaceVersionUnknown));
    assert.ok(!provider.exports.some((e) => e.name === "zlib"));
  });

  it("requires verified archive bytes and a unique regular Rust source for registry Cargo tools", () => {
    const root = mkdtempSync(join(tmpdir(), "cdxgen-cargo-archive-"));
    try {
      const cargo = join(root, "owner/Cargo.toml");
      const archive = join(root, "source.tar");
      mkdirSync(join(root, "owner/src"), { recursive: true });
      const manifest = `[package]
name = "crate-owner"
version = "4.2.0"
[[bin]]
name = "real"
path = "src/real.rs"
[[bin]]
name = "claimed"
path = "src/missing.rs"
[[bin]]
name = "linked"
path = "src/link.rs"
`;
      writeFileSync(cargo, manifest);
      writeFileSync(join(root, "owner/src/real.rs"), "fn main() {}\n");
      symlinkSync("real.rs", join(root, "owner/src/link.rs"));
      execFileSync("tar", ["-cf", archive, "-C", root, "owner"]);
      const checksum = createHash("sha512").update(readFileSync(archive)).digest("hex");
      const declared = JSON.stringify({ name: "crate-owner", version: "4.2.0" });
      const recipe = `vcpkg_from_github(REPO project/owner REF v4.2.0 SHA512 ${checksum})`;
      const files = new Map([
        [join(root, "supplement/archive-manifest.json"), JSON.stringify({
          archivePath: "source.tar", sourceSha512: checksum,
          members: ["owner/Cargo.toml", "owner/src/real.rs", "owner/src/missing.rs", "owner/src/link.rs"],
        })],
        [join(root, "supplement/owner/Cargo.toml"), manifest],
      ]);
      const observe = () => nativeVcpkgProvider(declared, recipe, "", files, undefined, { metadataRoot: root });
      const exports = observe()?.exports.filter((entry) => entry.kind === "tool") || [];
      assert.deepEqual(exports.map((entry) => entry.name), ["real"]);
      assert.equal(exports[0].sourceArchive.sha512, checksum);
      assert.equal(exports[0].sourceArchive.regularMembers, undefined);
      rmSync(archive);
      assert.deepEqual(observe()?.exports.filter((entry) => entry.kind === "tool") || [], []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("binds manifest VERSION/PORT into real source refs and config/pc exports", () => {
    const facts = nativeRegistryRecipeFacts({ name: "fixture", version: "4.2.1" }, `
      vcpkg_from_gitlab(REPO owner/fixture REF v\${VERSION} SHA512 ${"a".repeat(128)})
      vcpkg_cmake_config_fixup(CONFIG_PATH lib/cmake/FixtureSDK)
      vcpkg_replace_string("\${CURRENT_PACKAGES_DIR}/lib/pkgconfig/fixture-pc.pc" "a" "b")
    `);
    assert.equal(facts.artifacts[0].revision, "v4.2.1");
    assert.ok(facts.exports.some((e) => e.kind === "cmake-package" && e.name === "FixtureSDK"));
    assert.ok(facts.exports.some((e) => e.kind === "pkg-config" && e.name === "fixture-pc"));
  });

  it("expands literal foreach names and locally defined config-fixup wrappers without executing CMake", () => {
    const facts = nativeRegistryRecipeFacts({ name: "fixture", version: "1.2.3" }, `
      function(package_fixup package_name)
        list(APPEND fixup_args PACKAGE_NAME "\${package_name}")
        vcpkg_cmake_config_fixup(\${fixup_args})
      endfunction()
      set(packages FixtureA FixtureB)
      foreach(package_name IN LISTS packages)
        package_fixup("\${package_name}")
      endforeach()
      vcpkg_cmake_config_fixup()
    `);
    assert.deepEqual(facts.exports.filter((e) => e.kind === "cmake-package").map((e) => e.name).sort(), ["FixtureA", "FixtureB", "fixture"]);
  });

  it("does not turn find_package or an unknown filename/ref into source ownership", () => {
    const facts = nativeRegistryRecipeFacts({ name: "sdk-meta", version: "99.0" }, `
      find_package(UnrelatedRuntime 9.0)
      vcpkg_from_github(REPO owner/runtime REF \${UNKNOWN} SHA512 \${UNKNOWN_HASH})
      file(COPY "\${SOURCE_PATH}/UnrelatedConfig.cmake" DESTINATION "\${CURRENT_PACKAGES_DIR}/share/sdk-meta")
    `);
    assert.deepEqual(facts.artifacts, []);
    assert.ok(!facts.exports.some((e) => e.name === "UnrelatedRuntime"));
  });
});
