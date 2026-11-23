import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { strict as assert, test } from "poku";

import { acquireNativeEvidence } from "../lib/cli/nativeAcquisition.js";
import { loadNativeExternalMetadata } from "../lib/ecosystems/nativeExternalMetadata.js";

if (["/usr/bin/zip", "/usr/bin/unzip"].every(existsSync)) await test("MLIR-AIE claims a console launcher only from the exact admitted GitHub release wheel", async () => {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-mlir-aie-wheel-"));
  const source = join(root, "source");
  const original = globalThis.fetch;
  try {
    mkdirSync(source);
    const pkg = "mlir_aie-8.7.6.dist-info";
    mkdirSync(join(root, pkg));
    const files = {
      [`${pkg}/METADATA`]: "Name: mlir-aie\nVersion: 8.7.6\n\n",
      [`${pkg}/entry_points.txt`]: "[console_scripts]\naie-hsaco = aie.compiler.hsaco.pack:main\n",
    };
    for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
    const record = `${pkg}/RECORD`;
    writeFileSync(join(root, record), Object.entries(files).map(([path, text]) =>
      `${path},sha256=${createHash("sha256").update(text).digest("base64url")},${Buffer.byteLength(text)}\n`).join("") + `${record},,\n`);
    const selector = "8.7.6:cp312-cp312-manylinux_2_35_x86_64";
    const filename = "mlir_aie-8.7.6-cp312-cp312-manylinux_2_35_x86_64.whl";
    const api = "https://api.github.com/repos/Xilinx/mlir-aie/releases/tags/v8.7.6";
    const url = `https://github.com/Xilinx/mlir-aie/releases/download/v8.7.6/${filename}`;
    const mirror = "https://release-assets.githubusercontent.com/wheel";
    execFileSync("/usr/bin/zip", ["-q", filename, ...Object.keys(files), record], { cwd: root });
    const bytes = readFileSync(join(root, filename));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const metadata = { url: "https://api.github.com/repos/Xilinx/mlir-aie/releases/123", tag_name: "v8.7.6", draft: false, prerelease: false,
      assets: [{ name: filename, browser_download_url: url, digest: `sha256:${sha256}`, size: bytes.length, state: "uploaded" }] };
    const requests = [];
    globalThis.fetch = async (resource) => {
      const path = String(resource); requests.push(path);
      if (path === api) return new Response(JSON.stringify(metadata));
      if (path === url) return Response.redirect(mirror);
      if (path === mirror) return new Response(bytes);
      return new Response(null, { status: 404 });
    };
    const req = { requestedName: "aie-hsaco", file: "CMakeLists.txt", line: 148, role: "tool", command: "find_program",
      arguments: ["AIE_HSACO", "aie-hsaco"], conditions: ["if(AIE_KERNEL_TOOLCHAIN)"] };
    const options = { nativeMlirAieWheel: selector, nativeSourceCache: join(root, "cache"), nativeAcquire: true,
      nativeAcquireHosts: "api.github.com,github.com,release-assets.githubusercontent.com" };
    for (const noMatch of [{ ...req, arguments: ["TOOL", "aie-hsaco-dump"] }, { ...req, conditions: ["if(WIN32)"] }]) {
      assert.deepEqual(loadNativeExternalMetadata((await acquireNativeEvidence([noMatch], source, options)).options), []);
    }
    assert.deepEqual(requests, []);
    const cold = await acquireNativeEvidence([req], source, options);
    const providers = loadNativeExternalMetadata(cold.options);
    assert.deepEqual(requests, [api, url, mirror]);
    assert.equal(providers.length, 1);
    const [provider] = providers;
    assert.equal(provider.name, "mlir-aie");
    assert.equal(provider.version, "8.7.6");
    assert.equal(provider.arch, "x64");
    assert.equal(provider.registry.url, api);
    assert.deepEqual(provider.exports.map(({ name, declaredEntryPoint, executableUnknown, entryPointTarget, provenance }) =>
      [name, declaredEntryPoint, executableUnknown, entryPointTarget, provenance.sha256]),
    [["aie-hsaco", true, true, "aie.compiler.hsaco.pack:main", sha256]]);
    globalThis.fetch = () => { throw new Error("offline replay fetched"); };
    const warm = await acquireNativeEvidence([req], source, { ...options, nativeAcquire: false });
    assert.deepEqual(loadNativeExternalMetadata(warm.options), providers);
    assert.deepEqual(loadNativeExternalMetadata((await acquireNativeEvidence([req], source, { ...options, nativeAcquire: false, nativeMlirAieWheel: undefined })).options), []);
    writeFileSync(provider.exports[0].provenance.path, Buffer.alloc(bytes.length));
    const tampered = await acquireNativeEvidence([req], source, { ...options, nativeAcquire: false });
    assert.deepEqual(loadNativeExternalMetadata(tampered.options), []);
  } finally { globalThis.fetch = original; rmSync(root, { recursive: true, force: true }); }
});
