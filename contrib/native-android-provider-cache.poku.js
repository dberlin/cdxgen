import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "poku";

import { deriveAndroidProviders } from "./native-android-provider-cache.js";

const revision = "bdf0f4db82fae78492c92a55d473aacc4e963e79";
const mapping = {
  path: "evidence/mesa/dependencies.toml",
  text: '[shared_libraries]\nandroid-base = [{ target_name = "libbase" }]\nmissing-alias = [{ target_name = "absent" }]\n[header_libraries]\nandroid-headers = [{ target_name = "actual_headers" }]\n',
};
const module = {
  path: "evidence/aosp/Android.bp",
  repository: "https://android.googlesource.com/platform/system/libbase",
  revision,
  text: '// cc_library { name: "absent" }\ncc_defaults { name: "absent", }\ncc_library { target: { android: { name: "decoy" } }, name: "libbase", }\ncc_library_headers { name: "actual_headers", }\n',
};

describe("Android immutable export acquisition", () => {
  it("joins genuine hermetic aliases to owning Blueprint modules without inventing pc files or header libraries", () => {
    const result = deriveAndroidProviders({
      requirements: ["android-base", "android-headers", "missing-alias", "unmapped"].map((requestedName) => ({ requestedName })),
      mapping,
      modules: [module],
    });
    assert.deepEqual(result.snapshots.map((s) => [s.name, s.versionKind, s.version]), [
      ["android-base", "source-revision", revision],
      ["android-headers", "source-revision", revision],
    ]);
    assert.deepEqual(result.snapshots[0].exports, [
      { kind: "meson-dependency", name: "android-base" },
      { kind: "library", name: "libbase" },
    ]);
    assert.deepEqual(result.snapshots[1].exports, [{ kind: "meson-dependency", name: "android-headers" }]);
    assert.deepEqual(result.missing.map((m) => m.name), ["missing-alias", "unmapped"]);
    assert.equal(result.snapshots[0].evidence[0].sha256.length, 64);
    assert.equal(result.snapshots[0].platform, "android");
    assert.equal(result.snapshots[0].repository, module.repository);
  });

  it("requires both versioned interface ownership and executable pkg-config generation for a release", () => {
    const input = {
      requirements: [{ requestedName: "android.hardware.graphics.mapper", constraints: ">= 4.0" }],
      mapping: { path: mapping.path, text: "" },
      modules: [{ ...module, text: 'hidl_interface { name: "android.hardware.graphics.mapper@4.0", }' }],
      androidMakefile: { path: "evidence/mesa/Android.mk", text: "MESON_GEN_PKGCONFIGS += android.hardware.graphics.mapper:4.0\n" },
      crossMakefile: { path: "evidence/mesa/cross.mk", text: 'define create-pkgconfig\necho -e "Name: $2" "\\nVersion: $3" > $1/$2.pc\nendef\n$(foreach pkg, $(MESON_GEN_PKGCONFIGS), $(call create-pkgconfig,$(dir $@),$(word 1, $(subst :, ,$(pkg))),$(word 2, $(subst :, ,$(pkg)))))' },
    };
    const result = deriveAndroidProviders(input);
    assert.deepEqual(result.snapshots.map((s) => [s.name, s.versionKind, s.version, s.exports]), [[
      "android.hardware.graphics.mapper", "release", "4.0", [{ kind: "pkg-config", name: "android.hardware.graphics.mapper" }],
    ]]);
    assert.equal(result.snapshots[0].sourceRevision, revision);
    assert.equal(deriveAndroidProviders({ ...input, crossMakefile: undefined }).snapshots.length, 0);
    assert.equal(deriveAndroidProviders({ ...input, androidMakefile: { ...input.androidMakefile, text: "MESON_GEN_PKGCONFIGS += android.hardware.graphics.mapper:5.0\n" } }).snapshots.length, 0);
  });

  it("rejects mutable source revisions and does not turn constrained aliases into source releases", () => {
    const requirements = [{ requestedName: "android-base", constraints: ">= 4.0" }];
    assert.equal(deriveAndroidProviders({ requirements, mapping, modules: [module] }).snapshots.length, 0);
    assert.equal(deriveAndroidProviders({ requirements: [{ requestedName: "android-base" }], mapping, modules: [{ ...module, revision: "main" }] }).snapshots.length, 0);
  });
});

function withAndroidCacheFixture(run) {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-android-cache-"));
  const source = join(root, "source");
  const output = join(root, "output");
  mkdirSync(source);
  mkdirSync(output);
  const requirements = join(root, "requirements.json");
  writeFileSync(requirements, "[]");
  const preload = join(root, "fetch-fixture.js");
  const sourceRevision = "a".repeat(40);
  writeFileSync(preload, `globalThis.fetch = async (url) => new Response(String(url).includes("format=JSON") ? ")]}'\\n" + JSON.stringify({ commit: "${sourceRevision}" }) : Buffer.from(String(url).includes("default.xml") ? "<manifest/>" : "").toString("base64"));`);
  const invoke = () => spawnSync("bun", [
    "--preload", preload, fileURLToPath(new URL("./native-android-provider-cache.js", import.meta.url)),
    "--requirements", requirements, "--output", output, "--source-root", source,
    "--mesa-revision", sourceRevision, "--aosp-tag", "android-16.0.0_r4", "--fetch",
  ], { encoding: "utf8", timeout: 10000 });
  try { run({ source, output, invoke }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

describe("Android acquisition cache write isolation", () => {
  it("refuses evidence descendant symlinks without writing metadata into source", () => {
    withAndroidCacheFixture(({ source, output, invoke }) => {
      const sentinel = join(source, "sentinel");
      writeFileSync(sentinel, "original");
      symlinkSync(source, join(output, "evidence"), "dir");
      const result = invoke();
      assert.notEqual(result.status, 0);
      assert.ok(/Unsafe provider cache directory/.test(result.stderr));
      assert.equal(readFileSync(sentinel, "utf8"), "original");
      assert.equal(existsSync(join(source, "mesa")), false);
    });
  });

  it("refuses a manifest destination symlink without overwriting its source target", () => {
    withAndroidCacheFixture(({ source, output, invoke }) => {
      const sentinel = join(source, "sentinel");
      writeFileSync(sentinel, "original");
      symlinkSync(sentinel, join(output, "native-provider-metadata.json"), "file");
      const result = invoke();
      assert.notEqual(result.status, 0);
      assert.ok(/Unsafe provider cache file/.test(result.stderr));
      assert.equal(readFileSync(sentinel, "utf8"), "original");
    });
  });
});
