import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
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

const options = { nativeVersionProbes: true, introspect: true, installDeps: false };

async function withInstalledWheel(originalSite, use) {
  const originalEnvironment = join(originalSite, "..", "..", "..");
  const originalOwner = readdirSync(originalSite).find((entry) => entry.startsWith("zlib_ng-") && entry.endsWith(".dist-info"));
  const originalDist = join(originalSite, originalOwner);
  const recordText = readFileSync(join(originalDist, "RECORD"), "utf8");
  const extensionRow = recordText.split(/\r?\n/).find((line) => line.startsWith("zlib_ng/zlib_ng.") && line.includes(".so,"));
  const extensionEntry = extensionRow.split(",")[0];
  const originalMetadata = readFileSync(join(originalDist, "METADATA"), "utf8");
  const root = mkdtempSync(join(tmpdir(), "cdxgen-native-ownership-"));
  const site = join(root, "lib", basename(dirname(originalSite)), "site-packages");
  const owner = join(site, "zlib_ng.dist-info");
  const license = join(site, "zlib_ng", "zlib-ng", "LICENSE.md");
  const extension = join(site, extensionEntry);
  const record = join(owner, "RECORD");
  try {
    mkdirSync(dirname(license), { recursive: true });
    mkdirSync(owner);
    mkdirSync(join(root, "bin"));
    symlinkSync(join(originalEnvironment, "bin", "python"), join(root, "bin", "python"));
    copyFileSync(join(originalEnvironment, "pyvenv.cfg"), join(root, "pyvenv.cfg"));
    copyFileSync(join(originalSite, "zlib_ng", "zlib-ng", "LICENSE.md"), license);
    copyFileSync(join(originalSite, extensionEntry), extension);
    writeFileSync(join(owner, "METADATA"), originalMetadata);
    writeFileSync(record, recordText);
    return await use({
      root, owner, license, extension, originalExtension: join(originalSite, extensionEntry), originalMetadata,
      rewriteExtension(bytes) {
        writeFileSync(extension, bytes);
        const sha256 = createHash("sha256").update(bytes).digest("base64url");
        writeFileSync(record, recordText.replace(extensionRow, `${extensionEntry},sha256=${sha256},${bytes.length}`));
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function configureRuntimeFixture(root) {
  // The snapshot may have a stale venv interpreter symlink. Use a real
  // installed Python for the sandbox mount paths; the process is not run,
  // so its ABI does not need to match the wheel's original interpreter.
  const pythonLink = join(root, "bin", "python");
  const candidates = [pythonLink, ...(process.env.PATH || "").split(delimiter).filter(Boolean).map((dir) => join(dir, "python3"))];
  for (const candidate of candidates) {
    let executable;
    let version;
    try {
      executable = realpathSync(candidate);
      version = /^python(\d+\.\d+)$/.exec(basename(executable))?.[1];
      const runtime = join(dirname(dirname(executable)), "lib");
      if (!version || realpathSync(runtime) !== runtime ||
        !existsSync(join(runtime, `python${version}`, "encodings", "__init__.py"))) continue;
    } catch {
      continue;
    }
    rmSync(pythonLink);
    symlinkSync(executable, pythonLink);
    writeFileSync(join(root, "pyvenv.cfg"), `executable = ${executable}\nversion = ${version}\n`);
    return;
  }
  assert.fail("runtime response regression requires an installed python3 with its adjacent standard library");
}

// Locate mutation sites in the actual wheel, not in a substitute extension.
function versionObjectOffsets(bytes) {
  const u64 = (at) => Number(bytes.readBigUInt64LE(at));
  const shoff = u64(40);
  const shent = bytes.readUInt16LE(58);
  const shnum = bytes.readUInt16LE(60);
  for (let i = 1; i < shnum; i++) {
    const sec = shoff + i * shent;
    if (bytes.readUInt32LE(sec + 4) !== 11) continue;
    const strings = shoff + bytes.readUInt32LE(sec + 40) * shent;
    const str = u64(strings + 24);
    const start = u64(sec + 24);
    const end = start + u64(sec + 32);
    const step = u64(sec + 56);
    for (let sym = start; sym < end; sym += step) {
      const name = str + bytes.readUInt32LE(sym);
      if (bytes.toString("utf8", name, bytes.indexOf(0, name)) !== "zng_vstring") continue;
      const dataSection = shoff + bytes.readUInt16LE(sym + 6) * shent;
      const data = u64(dataSection + 24) + u64(sym + 8) - u64(dataSection + 16);
      const phoff = u64(32);
      const phnum = bytes.readUInt16LE(56);
      const phent = bytes.readUInt16LE(54);
      let dataLoad;
      let symtabTag;
      for (let ph = phoff; ph < phoff + phnum * phent; ph += phent) {
        const type = bytes.readUInt32LE(ph);
        const offset = u64(ph + 8);
        const size = u64(ph + 32);
        if (type === 1 && data >= offset && data < offset + size) dataLoad = ph;
        if (type !== 2) continue;
        for (let at = offset; at < offset + size; at += 16) {
          if (u64(at) === 6) symtabTag = at;
        }
      }
      assert.notEqual(dataLoad, undefined);
      assert.notEqual(symtabTag, undefined);
      return { sym, data, dataSection, dataLoad, symtabTag, otherSymbol: sym === start + step ? sym + step : start + step };
    }
  }
  assert.fail("the installed regression wheel must export zng_vstring in ELF");
}

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
    assert.equal(observed.version, "2.2.5");
    const facts = Object.fromEntries(observed.properties.map((p) => [p.name, p.value]));
    assert.equal(facts["cdx:nativeVersion:method"], "elf-symbol");
    assert.equal(facts["cdx:nativeVersion:symbol"], "zng_vstring");
    assert.equal(facts["cdx:nativeVersion:section"], ".rodata");
    assert.match(facts["cdx:nativeVersion:extension"], /\/zlib_ng\.cpython-[^/]+\.so$/);
    assert.equal(facts["cdx:vendored:versionSource"], basename(facts["cdx:nativeVersion:extension"]));
    assert.equal(facts["cdx:nativeVersion:record"], join(dirname(facts["cdx:nativeVersion:metadata"]), "RECORD"));
    const metadata = readFileSync(facts["cdx:nativeVersion:metadata"], "utf8");
    assert.notEqual(observed.version, metadata.match(/^Version: (.+)$/m)[1]);
    for (const field of ["api", "runtime", "compiled", "compatibilityRuntime", "compatibilityCompiled", "readOnly", "pid", "procAbsent", "homeAbsent", "extraFds", "interfaces", "environmentKeys"]) {
      assert.equal(facts[`cdx:nativeVersion:${field}`], undefined, field);
    }
    assert.ok(observed.purl.startsWith("pkg:generic/zlib-ng@"));
  });
  await test("rejects foreign metadata, changed RECORD content and external extension links", async () => {
    for (const mode of ["foreign-owner", "changed-record", "changed-license", "external-link", "external-owner-directory"]) {
      await withInstalledWheel(process.env.CDXGEN_NATIVE_PROBE_SITE, (fixture) => {
        const { root, owner, license, extension, originalExtension, originalMetadata } = fixture;
        assert.equal(probePythonBundledNativeVersion(license, options)?.version, "2.2.5");
        if (mode === "foreign-owner") {
          writeFileSync(join(owner, "METADATA"), originalMetadata.replace(/^Name:.*$/m, "Name: unrelated"));
        } else if (mode === "changed-record") {
          writeFileSync(extension, "not the recorded extension");
        } else if (mode === "changed-license") {
          writeFileSync(license, "not the recorded license");
        } else if (mode === "external-owner-directory") {
          const externalOwner = join(root, "foreign.dist-info");
          renameSync(owner, externalOwner);
          symlinkSync(externalOwner, owner);
        } else {
          rmSync(extension);
          symlinkSync(originalExtension, extension);
        }
        assert.equal(probePythonBundledNativeVersion(license, options), undefined, mode);
      });
    }
  });
  await test("requires a unique defined read-only ELF object, not a stray version string", async () => {
    await withInstalledWheel(process.env.CDXGEN_NATIVE_PROBE_SITE, ({ root, extension, license, rewriteExtension }) => {
      // A valid installed RECORD can be inspected even when its runtime is unavailable.
      rmSync(join(root, "bin", "python"));
      assert.equal(probePythonBundledNativeVersion(license, options)?.version, "2.2.5");
      const original = readFileSync(extension);
      const { sym, data, dataSection, dataLoad, symtabTag, otherSymbol } = versionObjectOffsets(original);
      for (const [label, mutate] of [
        ["unbound version text", (bytes) => bytes.writeUInt32LE(0, sym)],
        ["duplicate symbol name", (bytes) => bytes.writeUInt32LE(bytes.readUInt32LE(sym), otherSymbol)],
        ["undefined symbol", (bytes) => bytes.writeUInt16LE(0, sym + 6)],
        ["local object", (bytes) => bytes.writeUInt8(0x01, sym + 4)],
        ["function, not object", (bytes) => bytes.writeUInt8(0x12, sym + 4)],
        ["hidden object", (bytes) => bytes.writeUInt8(2, sym + 5)],
        ["writable section", (bytes) => bytes.writeBigUInt64LE(3n, dataSection + 8)],
        ["writable load segment", (bytes) => bytes.writeUInt32LE(6, dataLoad + 4)],
        ["dynamic symbol table mismatch", (bytes) => bytes.writeBigUInt64LE(0n, symtabTag + 8)],
        ["outside section bounds", (bytes) => bytes.writeBigUInt64LE(bytes.readBigUInt64LE(dataSection + 16) + bytes.readBigUInt64LE(dataSection + 32), sym + 8)],
        ["invalid section table offset", (bytes) => bytes.writeBigUInt64LE(1n << 63n, 40)],
        ["non-ASCII version bytes", (bytes) => { bytes[data + 9] |= 0x80; }],
        ["non-NUL object terminator", (bytes) => { bytes[data + Number(bytes.readBigUInt64LE(sym + 16)) - 1] = 88; }],
      ]) {
        const bytes = Buffer.from(original);
        mutate(bytes);
        rewriteExtension(bytes);
        assert.equal(probePythonBundledNativeVersion(license, options), undefined, label);
      }
    });
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
        assert.equal(component.properties.some((property) => property.name === "cdx:nativeVersion:symbol" && property.value === "zng_vstring"), enabled);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  await test("validates the sandboxed runtime response after a static miss", async () => {
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
    await withInstalledWheel(process.env.CDXGEN_NATIVE_PROBE_SITE, async ({ root, license, extension, rewriteExtension }) => {
      configureRuntimeFixture(root);
      const original = readFileSync(extension);
      const { sym } = versionObjectOffsets(original);
      original.writeUInt32LE(0, sym);
      rewriteExtension(original);
      const valid = {
        module: `/probe/${basename(extension)}`, readOnly: true, pid: 2,
        procAbsent: true, homeAbsent: true, environmentKeys: ["HOME"], extraFds: [], interfaces: ["lo"],
        runtime: "2.2.5", compiled: "2.2.5",
        compatibilityRuntime: "1.3.1", compatibilityCompiled: "1.3.1",
      };
      // Only the external process response is replaced. The installed RECORD,
      // static miss, and normal vendored-generation consumer remain real.
      for (const payload of [
        null, [], "text", 1,
        { ...valid, compatibilityRuntime: {} }, { ...valid, compatibilityCompiled: null },
        { ...valid, readOnly: false }, { ...valid, extraFds: [3] }, { ...valid, interfaces: ["lo", "eth0"] },
        valid,
      ]) {
        let launches = 0;
        const { probePythonBundledNativeVersion: probe } = await esmock("./pythonNativeVersion.js", {
          "../core/fs.js": { safeSpawnSync: (command) => {
            assert.equal(command, "/usr/bin/bwrap");
            launches++;
            return { status: 0, stdout: JSON.stringify(payload), stderr: "" };
          } },
        });
        const { findVendoredCode: collect } = await esmock("./vendoredCode.js", {
          "./pythonNativeVersion.js": { probePythonBundledNativeVersion: probe },
        });
        const observed = collect(dirname(dirname(license)), options).components.find((component) => component.name === "zlib-ng");
        assert.equal(launches, 1, "the RECORD-owned extension must reach the sandbox fallback");
        assert.ok(observed);
        if (payload === valid) {
          assert.equal(observed.version, "2.2.5");
          const facts = Object.fromEntries(observed.properties.map((p) => [p.name, p.value]));
          assert.equal(facts["cdx:nativeVersion:method"], "sandboxed-runtime-api");
          assert.equal(facts["cdx:nativeVersion:symbol"], undefined);
          assert.equal(facts["cdx:nativeVersion:api"], "zlib_ng.ZLIBNG_RUNTIME_VERSION");
          assert.equal(facts["cdx:nativeVersion:runtime"], "2.2.5");
          assert.equal(facts["cdx:nativeVersion:compiled"], "2.2.5");
          assert.equal(facts["cdx:nativeVersion:compatibilityRuntime"], "1.3.1");
          assert.equal(facts["cdx:nativeVersion:pid"], "2");
        } else {
          assert.ok(!observed.version);
        }
      }
    });
  });
}
