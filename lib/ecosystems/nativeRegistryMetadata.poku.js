import { assert, describe, it } from "poku";

import { nativeMesonTemplateVersions, nativeRegistryRecipeFacts } from "./nativeRegistryMetadata.js";
import { nativeVcpkgProvider } from "./nativeExternalMetadata.js";

describe("literal registry recipe metadata", () => {
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
