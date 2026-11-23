import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "poku";

import { appleTbdExport, nativeAppleRequestedNames } from "./native-apple-provider-cache.js";

const stub = (extra = "") => `--- !tapi-tbd\ntbd-version: 4\ntargets: [ x86_64-macos, arm64-macos ]\ninstall-name: '/System/Library/Frameworks/Foundation.framework/Versions/C/Foundation'\ncurrent-version: 1775.118.101\ncompatibility-version: 300.0\n${extra}\n...\n`;

describe("explicit Apple SDK framework versions", () => {
  it("expands actual aggregate framework modules without inventing dynamic module names", () => {
    assert.deepEqual(nativeAppleRequestedNames([{ requestedName: "appleframeworks", arguments: ["'appleframeworks'", "modules: ['QuartzCore', 'Metal']"] }]), ["Metal", "QuartzCore"]);
    assert.deepEqual(nativeAppleRequestedNames([{ requestedName: "appleframeworks", arguments: ["'appleframeworks'", "modules: generated_modules"] }]), []);
    assert.deepEqual(nativeAppleRequestedNames([{ requestedName: "appleframeworks", arguments: ["modules: ['QuartzCore', GENERATED]"] }]), []);
  });
  it("derives the exact owner current version and install-name, not a compatibility or reexport version", () => {
    const result = appleTbdExport(stub('reexported-libraries:\n  - current-version: 9999.0\n    libraries: [ /usr/lib/libobjc.A.dylib ]'), "Foundation", "System/Library/Frameworks/Foundation.framework/Versions/C/Foundation.tbd");
    assert.deepEqual(result, {
      name: "Foundation", version: "1775.118.101", installName: "/System/Library/Frameworks/Foundation.framework/Versions/C/Foundation",
      exports: [{ kind: "framework", name: "Foundation" }], targets: ["x86_64-macos", "arm64-macos"],
    });
  });

  it("refuses missing current-version instead of borrowing SDK, compatibility, or default 1.0", () => {
    assert.equal(appleTbdExport(stub().replace("current-version: 1775.118.101\n", ""), "Foundation", "System/Library/Frameworks/Foundation.framework/Foundation.tbd"), undefined);
    assert.equal(appleTbdExport(stub(), "Security", "System/Library/Frameworks/Security.framework/Security.tbd"), undefined);
    assert.equal(appleTbdExport(stub(), "Foundation", "System/Library/Frameworks/Other.framework/Foundation.tbd"), undefined);
  });

  it("preserves a genuinely declared current-version 1 and exact private-framework identity", () => {
    const text = "--- !tapi-tbd\ninstall-name: /System/Library/PrivateFrameworks/BackBoardServices.framework/BackBoardServices\ncurrent-version: 1\ntargets: [ arm64-ios ]\n...\n";
    const result = appleTbdExport(text, "BackBoardServices", "System/Library/PrivateFrameworks/BackBoardServices.framework/BackBoardServices.tbd");
    assert.equal(result.version, "1");
    assert.deepEqual(result.exports, [{ kind: "framework", name: "BackBoardServices" }]);
  });

  it("keeps a declared zero linker version distinct from an absent current-version", () => {
    const text = "--- !tapi-tbd\ninstall-name: /System/Library/PrivateFrameworks/FrontBoardServices.framework/FrontBoardServices\ncurrent-version: 0\n...\n";
    const path = "System/Library/PrivateFrameworks/FrontBoardServices.framework/FrontBoardServices.tbd";
    assert.equal(appleTbdExport(text, "FrontBoardServices", path).version, "0");
    assert.equal(appleTbdExport(text.replace("current-version: 0\n", ""), "FrontBoardServices", path), undefined);
  });

  it("recognizes actual dylib stubs as libraries rather than fictional frameworks", () => {
    const result = appleTbdExport("--- !tapi-tbd-v3\ninstall-name: /usr/lib/liblockdown.dylib\ncurrent-version: 123.40.7\narchs: [ arm64, arm64e ]\n...\n", "lockdown", "usr/lib/liblockdown.tbd");
    assert.deepEqual(result.exports, [{ kind: "library", name: "lockdown" }, { kind: "library", name: "liblockdown" }]);
    assert.equal(result.version, "123.40.7");
  });

  it("does not borrow the version from a different document or accept ambiguous owner versions", () => {
    const path = "System/Library/Frameworks/Foundation.framework/Foundation.tbd";
    assert.equal(appleTbdExport(stub().replace("current-version: 1775.118.101\n", "") + stub().replaceAll("Foundation", "Security"), "Foundation", path), undefined);
    assert.equal(appleTbdExport(stub() + stub().replace("1775.118.101", "1800.1"), "Foundation", path), undefined);
  });
});

function withAppleCacheFixture(run) {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-apple-cache-"));
  const source = join(root, "source");
  const output = join(root, "output");
  mkdirSync(source);
  mkdirSync(output);
  const requirements = join(root, "requirements.json");
  writeFileSync(requirements, "[]");
  const preload = join(root, "fetch-fixture.js");
  const revision = "a".repeat(40);
  writeFileSync(preload, `globalThis.fetch = async () => new Response(JSON.stringify({ sha: "${revision}", tree: { sha: "${"b".repeat(40)}" } }), { headers: { "content-type": "application/json" } });`);
  const invoke = (fetch = false) => spawnSync("bun", [
    "--preload", preload, fileURLToPath(new URL("./native-apple-provider-cache.js", import.meta.url)),
    "--requirements", requirements, "--output", output, "--source-root", source,
    "--sdk", `fixture/sdk@${revision}:MacOSX11.3.sdk`, ...(fetch ? ["--fetch"] : []),
  ], { encoding: "utf8", timeout: 10000 });
  try { run({ source, output, invoke }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

describe("Apple acquisition cache write isolation", () => {
  it("refuses evidence descendant symlinks before creating source directories or writing metadata", () => {
    withAppleCacheFixture(({ source, output, invoke }) => {
      const sentinel = join(source, "sentinel");
      writeFileSync(sentinel, "original");
      symlinkSync(source, join(output, "evidence"), "dir");
      const result = invoke(true);
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(readFileSync(join(output, "acquisition-report.json"), "utf8"));
      assert.ok(report.inaccessible.some((entry) => /Unsafe provider cache directory/.test(entry.prerequisite)));
      assert.equal(readFileSync(sentinel, "utf8"), "original");
      assert.equal(existsSync(join(source, "fixture")), false);
    });
  });

  it("refuses a manifest destination symlink without overwriting its source target", () => {
    withAppleCacheFixture(({ source, output, invoke }) => {
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
