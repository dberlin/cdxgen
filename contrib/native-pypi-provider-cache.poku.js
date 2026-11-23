import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { strict as assert, test } from "poku";

import { acquireNativeEvidence } from "../lib/cli/nativeAcquisition.js";
import { loadNativeExternalMetadata, nativePythonWheelProvider } from "../lib/ecosystems/nativeExternalMetadata.js";

const hash = (bytes, encoding = "hex") => createHash("sha256").update(bytes).digest(encoding);
function wheel(root, name, version, options) {
  const normalized = name.replaceAll("-", "_");
  const directory = join(root, normalized);
  const dist = `${normalized}-${version}.dist-info`;
  const filename = `${normalized}-${version}-py3-none-${options.target || "any"}.whl`;
  mkdirSync(join(directory, dist), { recursive: true });
  const metadata = `Metadata-Version: 2.1\nName: ${name}\nVersion: ${version}\n${options.dependency ? `Requires-Dist: ${options.dependency}\n` : ""}\n`;
  const files = new Map([[`${dist}/METADATA`, metadata]]);
  if (options.script) files.set(`${dist}/entry_points.txt`, `[console_scripts]\n${options.script}=some_package.cli:main\n`);
  if (options.binary) {
    const archiveDir = `${normalized}-${version}.data/scripts`;
    mkdirSync(join(directory, archiveDir), { recursive: true });
    files.set(`${archiveDir}/${options.binary.name}`, options.binary.bytes);
  }
  const record = [...files].map(([member, text]) => `${member},sha256=${hash(
    options.binary?.stale && member.endsWith(`/${options.binary.name}`) ? Buffer.alloc(text.length) : text,
    "base64url")},${Buffer.byteLength(text)}\n`).join("");
  files.set(`${dist}/RECORD`, `${record}${dist}/RECORD,,\n`);
  for (const [path, text] of files) writeFileSync(join(directory, path), text);
  const path = join(root, filename);
  execFileSync("/usr/bin/zip", ["-q", path, ...files.keys()], { cwd: directory });
  const bytes = readFileSync(path);
  // The Python ZIP writers used by real wheel builders often omit S_IFREG.
  for (let at = 0; at + 46 < bytes.length; at++) if (bytes.readUInt32LE(at) === 0x02014b50) {
    bytes[at + 5] = 3;
    bytes.writeUInt32LE(0o644 << 16, at + 38);
  }
  const url = `https://files.pythonhosted.org/packages/00/00/${filename}`;
  return { bytes, url, metadata: { info: { name, version }, urls: [{ url, filename, size: bytes.length, yanked: false,
    packagetype: "bdist_wheel", digests: { sha256: hash(bytes) } }] }, path };
}

if (existsSync("/usr/bin/zip") && existsSync("/usr/bin/unzip")) await test("a transition project cannot own a script absent from its wheel; its related wheel must prove membership", async () => {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-pypi-script-"));
  const source = join(root, "source"); const cache = join(root, "cache");
  mkdirSync(source);
  const original = globalThis.fetch;
  try {
    const shim = wheel(root, "script-example", "1.0", { dependency: "real-scripts (>=2.3)" });
    const owner = wheel(root, "Real-Scripts", "2.3", { script: "script-example" });
    const fixture = new Map([
      ["https://pypi.org/pypi/script-example/json", () => Response.json(shim.metadata)],
      ["https://pypi.org/pypi/real-scripts/json", () => Response.json(owner.metadata)],
      [shim.url, () => new Response(shim.bytes)], [owner.url, () => new Response(owner.bytes)],
    ]);
    const seen = [];
    const respond = globalThis.fetch = async (url) => {
      seen.push(String(url));
      return fixture.get(String(url))?.() || new Response(null, { status: 404 });
    };
    const requirements = [{ role: "tool", command: "find_program", requestedName: "script-example", file: "CMakeLists.txt", line: 3,
      arguments: ["TOOL", "NAMES", "script-example", "PATHS", "/local/bin/wrong"] }];
    const settings = { nativeSourceCache: cache, nativeAcquireHosts: "pypi.org,files.pythonhosted.org" };
    const cold = await acquireNativeEvidence(requirements, source, { ...settings, nativeAcquire: true });
    assert.equal(cold.diagnostics.find((row) => row.family === "pypi")?.status, "acquired");
    assert.deepEqual(new Set(seen), new Set([...fixture.keys(), "https://pypi.org/pypi/script/json"]));
    assert.equal(seen.length, 5);
    const [proved] = loadNativeExternalMetadata(cold.options);
    assert.equal(proved.name, "Real-Scripts");
    assert.equal(proved.version, "2.3");
    assert.equal(proved.exports[0].entryPointTarget, "some_package.cli:main");
    assert.equal(proved.exports[0].executableUnknown, true);
    globalThis.fetch = () => { throw new Error("offline must not fetch"); };
    const warm = await acquireNativeEvidence(requirements, source, settings);
    assert.equal(warm.diagnostics.find((row) => row.family === "pypi")?.status, "cached");
    assert.deepEqual(loadNativeExternalMetadata(warm.options), [proved]);
    const artifact = proved.exports[0].provenance.path;
    assert.equal(basename(artifact), `${hash(owner.bytes)}.whl`);
    writeFileSync(artifact, shim.bytes);
    const invalid = await acquireNativeEvidence(requirements, source, settings);
    assert.deepEqual(loadNativeExternalMetadata(invalid.options), [], "tampering cannot make a different wheel an authenticated owner");
    assert.ok(invalid.diagnostics.find((row) => row.family === "pypi")?.blockers.some((entry) => /failed authentication/.test(entry.prerequisite)));
    globalThis.fetch = respond;
    const repaired = await acquireNativeEvidence(requirements, source, { ...settings, nativeAcquire: true });
    assert.deepEqual(loadNativeExternalMetadata(repaired.options), [proved]);
    assert.deepEqual(new Set(seen.slice(5)), new Set(["https://pypi.org/pypi/script/json", owner.url]),
      "repair reuses frozen project metadata and the unchanged transition wheel");
  } finally { globalThis.fetch = original; rmSync(root, { recursive: true, force: true }); }
});

if (existsSync("/usr/bin/zip") && existsSync("/usr/bin/unzip")) await test("a WIN32-guarded command acquires Windows binary inventory and rejects a same-size stale RECORD", async () => {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-pypi-target-"));
  const source = join(root, "source"); const cache = join(root, "cache"); mkdirSync(source);
  const original = globalThis.fetch;
  try {
    const binary = { name: "tool.exe", bytes: Buffer.from([77, 90, 0, 5]) };
    const stale = wheel(root, "tool", "2.0", { target: "win_amd64", binary: { ...binary, stale: true } });
    writeFileSync(stale.path, stale.bytes);
    assert.deepEqual(nativePythonWheelProvider(stale.path, root, { name: "tool", version: "2.0", sha256: hash(stale.bytes),
      platform: "win32", arch: "x64", url: stale.url })?.exports, []);
    const win = wheel(root, "tool", "3.0", { target: "win_amd64", binary });
    const linux = wheel(root, "tool", "3.0", { target: "manylinux_2_17_x86_64", script: "tool" });
    const mac = wheel(root, "tool", "3.0", { target: "macosx_10_10_x86_64", script: "tool" });
    const url = "https://pypi.org/pypi/tool/json";
    const seen = [];
    globalThis.fetch = async (input) => {
      seen.push(String(input));
      if (String(input) === url) return Response.json({ ...win.metadata, urls: [...linux.metadata.urls, ...mac.metadata.urls, ...win.metadata.urls] });
      if (String(input) === win.url) return new Response(win.bytes);
      throw new Error(`unexpected wheel: ${input}`);
    };
    const request = { role: "tool", command: "find_program", requestedName: "tool", file: "CMakeLists.txt", line: 3,
      arguments: ["APP", "tool"], conditions: ["if(WIN32)"] };
    const result = await acquireNativeEvidence([request], source, { nativeSourceCache: cache, nativeAcquire: true,
      nativeAcquireHosts: "pypi.org,files.pythonhosted.org" });
    assert.deepEqual(seen, [url, win.url]);
    assert.equal(result.diagnostics.find((row) => row.family === "pypi")?.status, "acquired");
    assert.equal(loadNativeExternalMetadata(result.options)[0]?.platform, "win32");
    assert.ok(loadNativeExternalMetadata(result.options)[0].exports.some((entry) => entry.name === "tool.exe"));
  } finally { globalThis.fetch = original; rmSync(root, { recursive: true, force: true }); }
});
