import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "poku";

import { nativeSnapshotProvider } from "../lib/ecosystems/nativeExternalMetadata.js";
import { cudaArchiveExports, cudaArchiveSnapshot, cudaProviderCache, cudaRedistributables, cudaToolkitExports } from "./native-cuda-provider-cache.js";

describe("NVIDIA SDK evidence acquisition", () => {
  it("derives exact library identities from actual archive members without inventing Windows aliases", () => {
    assert.deepEqual(cudaArchiveExports([
      "sdk/lib/libcudart.so.12.4.99", "sdk/lib/libcudart_static.a",
      "sdk/lib/x64/nvToolsExt64_1.lib", "sdk/include/not-a-library.h",
    ]), [
      { kind: "library", name: "cudart" },
      { kind: "library", name: "cudart_static" },
      { kind: "library", name: "libcudart.so.12.4.99" },
      { kind: "library", name: "libcudart_static.a" },
      { kind: "library", name: "nvToolsExt64_1" },
      { kind: "library", name: "nvToolsExt64_1.lib" },
    ]);
  });

  it("records literal SDK executable paths and aliases without mistaking plain archive files for tools", () => {
    const exports = cudaArchiveExports(["sdk/bin/cuobjdump.exe", "sdk/elsewhere/not-a-tool", "sdk/bin/../../wrong"]);
    assert.deepEqual(exports.map(({ kind, name, file }) => [kind, name, file]), [
      ["tool", "cuobjdump.exe", "sdk/bin/cuobjdump.exe"],
      ["tool", "cuobjdump", "sdk/bin/cuobjdump.exe"],
    ]);
  });

  it("rejects metadata and streaming writes redirected through cache symlinks into source", () => {
    const directory = mkdtempSync(join(tmpdir(), "cuda-provider-cache-"));
    const source = join(directory, "source");
    const output = join(directory, "cache");
    try {
      mkdirSync(source);
      const sentinel = join(source, "sentinel");
      writeFileSync(sentinel, "unchanged");
      const cache = cudaProviderCache(output, source);
      symlinkSync(source, join(output, "artifacts"), "dir");
      assert.throws(() => cache.mkdir(join(output, "artifacts", "nested")));
      assert.throws(() => cache.write(join(output, "artifacts", "sentinel"), "overwritten"));
      assert.throws(() => cache.openExclusive(join(output, "artifacts", "binary.partial")));
      rmSync(join(output, "artifacts"));
      cache.mkdir(join(output, "artifacts"));
      symlinkSync(sentinel, join(output, "metadata.json"));
      symlinkSync(sentinel, join(output, "artifacts", "binary.partial"));
      assert.throws(() => cache.write(join(output, "metadata.json"), "overwritten"));
      assert.throws(() => cache.openExclusive(join(output, "artifacts", "binary.partial")));
      assert.equal(readFileSync(sentinel, "utf8"), "unchanged");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("keeps excluded architectures in evidence inventory but not consumer-derived x64 exports", () => {
    const directory = mkdtempSync(join(tmpdir(), "cuda-provider-architecture-"));
    const files = [
      "sdk/NvToolsExt/lib/nvToolsExt64_1.lib",
      "sdk/NvToolsExt/lib32/nvToolsExt32_1.lib",
      "sdk/NvToolsExt/Win32/nvToolsExt32_1.dll",
      "sdk/NvToolsExt/x86/nvToolsExt32_1.dll",
      "sdk/lib/stubs/libnvidia-ml.so",
    ];
    const inventory = JSON.stringify({ files });
    try {
      writeFileSync(join(directory, "archive.files.json"), inventory);
      const snapshot = cudaArchiveSnapshot(
        { component: "nsight_nvtx", version: "1.21018621", platform: "win32", arch: "x64" },
        files,
        [{ path: "archive.files.json", sha256: createHash("sha256").update(inventory).digest("hex") }],
      );
      assert.deepEqual(snapshot.files, ["sdk/NvToolsExt/lib/nvToolsExt64_1.lib"]);
      const provider = nativeSnapshotProvider(JSON.stringify(snapshot), directory);
      assert.ok(provider);
      assert.ok(provider.exports.some((item) => item.kind === "library" && item.name === "nvToolsExt64_1"));
      assert.equal(provider.exports.some((item) => /nvToolsExt32|nvidia-ml/.test(item.name)), false);
      assert.deepEqual(JSON.parse(readFileSync(join(directory, "archive.files.json"), "utf8")).files, files);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("retains package versions and nested CUDA variants independently of filenames and toolkit labels", () => {
    const manifest = { release_label: "12.4.0", libexample: {
      version: "3.7.2.19", "linux-x86_64": { cuda12: {
        relative_path: "libexample/linux-x86_64/artifact.tar.xz", size: "17", sha256: "a".repeat(64),
      } },
    } };
    const records = cudaRedistributables(manifest, ["libexample"], ["linux-x86_64"]);
    assert.equal(records.length, 1);
    assert.equal(records[0].version, "3.7.2.19");
    assert.equal(records[0].variant, "cuda12");
    assert.equal(records[0].platform, "linux");
    assert.deepEqual(cudaRedistributables({ libexample: { "linux-x86_64": manifest.libexample["linux-x86_64"] } }, ["libexample"], ["linux-x86_64"]), []);
  });

  it("derives toolkit discovery identities from documented Find modules rather than a requested-name map", () => {
    assert.deepEqual(cudaToolkitExports("Use FindCUDAToolkit. The FindCUDA module is deprecated."), [
      { kind: "cmake-package", name: "CUDA" },
      { kind: "cmake-package", name: "CUDAToolkit" },
    ]);
    assert.deepEqual(cudaToolkitExports("CUDA 99.0.0 cudart_static"), []);
  });
});
