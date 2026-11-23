import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import esmock from "esmock";
import { strict as assert, test } from "poku";

import { findVendoredCode } from "./vendoredCode.js";
import { probePythonBundledNativeVersion } from "./pythonNativeVersion.js";

await test("does not infer native versions from unsupported paths or disabled policy", () => {
  assert.equal(probePythonBundledNativeVersion("/unpacked-wheel/zlib_ng/zlib-ng/LICENSE.md", { nativeVersionProbes: true }), undefined);
  assert.equal(probePythonBundledNativeVersion("/site-packages/zlib_ng/zlib-ng/LICENSE.md", { nativeVersionProbes: false }), undefined);
  assert.equal(probePythonBundledNativeVersion("/site-packages/zlib_ng/zlib-ng/LICENSE.md", { nativeVersionProbes: true, installDeps: false }), undefined);
});

// Integration is explicitly enabled against an already installed distribution;
// no installation, extension compilation or stand-in executable is performed.
if (process.env.CDXGEN_NATIVE_PROBE_SITE) {
  await test("observes native release from the RECORD-owned installed extension, not wrapper or compatibility versions", () => {
    const site = process.env.CDXGEN_NATIVE_PROBE_SITE;
    const root = join(site, "zlib_ng");
    const disabled = findVendoredCode(root, { installDeps: false }).components.find((c) => c.name === "zlib-ng");
    assert.ok(disabled);
    assert.ok(!disabled.version);
    const gated = findVendoredCode(root, { installDeps: false, nativeVersionProbes: true }).components.find((c) => c.name === "zlib-ng");
    assert.ok(!gated.version);
    const observed = findVendoredCode(root, { installDeps: false, introspect: true, nativeVersionProbes: true }).components.find((c) => c.name === "zlib-ng");
    assert.ok(observed.version);
    const facts = Object.fromEntries(observed.properties.map((p) => [p.name, p.value]));
    assert.equal(observed.version, facts["cdx:nativeVersion:runtime"]);
    assert.equal(observed.version, facts["cdx:nativeVersion:compiled"]);
    assert.notEqual(observed.version, facts["cdx:nativeVersion:compatibilityRuntime"]);
    const metadata = readFileSync(facts["cdx:nativeVersion:metadata"], "utf8");
    assert.notEqual(observed.version, metadata.match(/^Version: (.+)$/m)[1]);
    assert.equal(facts["cdx:nativeVersion:readOnly"], "true");
    assert.equal(facts["cdx:nativeVersion:api"], "zlib_ng.ZLIBNG_RUNTIME_VERSION");
    assert.ok(observed.purl.startsWith("pkg:generic/zlib-ng@"));
    assert.equal(facts["cdx:nativeVersion:pid"], "2");
    assert.equal(facts["cdx:nativeVersion:procAbsent"], "true");
    assert.equal(facts["cdx:nativeVersion:homeAbsent"], "true");
    assert.deepEqual(JSON.parse(facts["cdx:nativeVersion:extraFds"]), []);
    assert.deepEqual(JSON.parse(facts["cdx:nativeVersion:interfaces"]), ["lo"]);
    assert.ok(!JSON.parse(facts["cdx:nativeVersion:environmentKeys"]).includes("CDXGEN_PROBE_SECRET"));
  });
  await test("rejects foreign metadata, changed RECORD content and external extension links", () => {
    const originalSite = process.env.CDXGEN_NATIVE_PROBE_SITE;
    const originalEnvironment = join(originalSite, "..", "..", "..");
    const originalOwner = readdirSync(originalSite).find((entry) => entry.startsWith("zlib_ng-") && entry.endsWith(".dist-info"));
    const recordText = readFileSync(join(originalSite, originalOwner, "RECORD"), "utf8");
    const extensionEntry = recordText.split(/\r?\n/).find((line) => line.startsWith("zlib_ng/zlib_ng.") && line.includes(".so,")).split(",")[0];
    const originalMetadata = readFileSync(join(originalSite, originalOwner, "METADATA"), "utf8");
    for (const mode of ["foreign-owner", "changed-record", "external-link", "external-owner-directory"]) {
      const root = mkdtempSync(join(tmpdir(), "cdxgen-native-ownership-"));
      try {
        const site = join(root, "lib", basename(dirname(originalSite)), "site-packages");
        const owner = join(site, "zlib_ng.dist-info");
        const license = join(site, "zlib_ng", "zlib-ng", "LICENSE.md");
        mkdirSync(dirname(license), { recursive: true });
        mkdirSync(owner);
        mkdirSync(join(root, "bin"));
        symlinkSync(join(originalEnvironment, "bin", "python"), join(root, "bin", "python"));
        copyFileSync(join(originalEnvironment, "pyvenv.cfg"), join(root, "pyvenv.cfg"));
        copyFileSync(join(originalSite, "zlib_ng", "zlib-ng", "LICENSE.md"), license);
        copyFileSync(join(originalSite, extensionEntry), join(site, extensionEntry));
        writeFileSync(join(owner, "METADATA"), originalMetadata);
        writeFileSync(join(owner, "RECORD"), recordText);
        const options = { nativeVersionProbes: true, introspect: true, installDeps: false };
        assert.ok(probePythonBundledNativeVersion(license, options)?.version, "valid copied distribution must resolve before testing rejection");
        if (mode === "foreign-owner") {
          writeFileSync(join(owner, "METADATA"), originalMetadata.replace(/^Name:.*$/m, "Name: unrelated"));
        } else if (mode === "changed-record") {
          writeFileSync(join(site, extensionEntry), "not the recorded extension");
        } else if (mode === "external-owner-directory") {
          const externalOwner = join(root, "foreign.dist-info");
          renameSync(owner, externalOwner);
          symlinkSync(externalOwner, owner);
        } else {
          rmSync(join(site, extensionEntry));
          symlinkSync(join(originalSite, extensionEntry), join(site, extensionEntry));
        }
        assert.equal(probePythonBundledNativeVersion(license, options), undefined, mode);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  });
  await test("normal CLI rejects config-only consent and honors explicit operator flag/environment intent", () => {
    const root = mkdtempSync(join(tmpdir(), "cdxgen-native-cli-consent-"));
    try {
      writeFileSync(join(root, ".cdxgenrc"), JSON.stringify({ "native-version-probes": true, nativeVersionProbes: true }));
      const input = join(process.env.CDXGEN_NATIVE_PROBE_SITE, "zlib_ng");
      const cli = fileURLToPath(new URL("../../bin/cdxgen.js", import.meta.url));
      for (const [index, flags, environmentChoice, enabled] of [
        [0, [], undefined, false],
        [1, ["--native-version-probes"], undefined, true],
        [2, [], "true", true],
        [3, ["--no-native-version-probes"], "true", false],
      ]) {
        const output = join(root, `bom-${index}.json`);
        const env = { ...process.env, FETCH_LICENSE: "false" };
        if (environmentChoice === undefined) delete env.CDXGEN_NATIVE_VERSION_PROBES;
        else env.CDXGEN_NATIVE_VERSION_PROBES = environmentChoice;
        const result = spawnSync(process.execPath, [cli, "-t", "c", input,
          "--no-install-deps", "--introspect", "--no-banner", "--no-babel",
          "--no-include-formulation", "--no-bom-audit", ...flags, "-o", output], {
          cwd: root, env, encoding: "utf8", timeout: 120000, maxBuffer: 1024 * 1024,
        });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        const component = JSON.parse(readFileSync(output, "utf8")).components.find((component) => component.name === "zlib-ng");
        assert.equal(Boolean(component.version), enabled);
        assert.equal(component.properties.some((property) => property.name === "cdx:nativeVersion:api"), enabled);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  await test("treats successful hostile native output as unresolved without aborting the vendored consumer", async () => {
    if (process.versions.bun) {
      // esmock's loader isolates modules on Node, but Bun reuses already-loaded
      // static imports. Run the same consumer cases in an isolated Node process
      // instead of silently accepting ineffective process-response substitution.
      const result = spawnSync("node", [fileURLToPath(import.meta.url)], {
        env: process.env, encoding: "utf8", timeout: 120000, maxBuffer: 1024 * 1024,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return;
    }
    const root = join(process.env.CDXGEN_NATIVE_PROBE_SITE, "zlib_ng");
    const options = { installDeps: false, introspect: true, nativeVersionProbes: true };
    const actual = probePythonBundledNativeVersion(join(root, "zlib-ng", "LICENSE.md"), options);
    assert.ok(actual?.version);
    const fields = Object.fromEntries(actual.properties.map((property) => [property.name.slice("cdx:nativeVersion:".length), property.value]));
    const valid = {
      module: `/probe/${basename(actual.source)}`, readOnly: true, pid: 2,
      procAbsent: true, homeAbsent: true, environmentKeys: ["HOME"], extraFds: [], interfaces: ["lo"],
      runtime: actual.version, compiled: actual.version,
      compatibilityRuntime: fields.compatibilityRuntime, compatibilityCompiled: fields.compatibilityCompiled,
    };
    // Only the external process response is replaced. Ownership/content checks
    // and the normal vendored-generation consumer stay real. The actual native
    // API integration above remains separate from these hostile-output cases.
    for (const payload of [null, [], "text", 1, { ...valid, compatibilityRuntime: {} }, { ...valid, compatibilityCompiled: null }]) {
      let launches = 0;
      const { probePythonBundledNativeVersion: probe } = await esmock("./pythonNativeVersion.js", {
        "../core/fs.js": { safeSpawnSync: () => {
          launches++;
          return { status: 0, stdout: JSON.stringify(payload), stderr: "" };
        } },
      });
      const { findVendoredCode: collect } = await esmock("./vendoredCode.js", {
        "./pythonNativeVersion.js": { probePythonBundledNativeVersion: probe },
      });
      let result;
      assert.doesNotThrow(() => { result = collect(root, options); });
      assert.equal(launches, 1);
      assert.ok(!result.components.find((component) => component.name === "zlib-ng").version);
    }
  });
}
