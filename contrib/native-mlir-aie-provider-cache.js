import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { hashRegularFile, readRegularTextFile } from "../lib/core/boundedFile.js";
import { nativeMlirAieWheelAsset } from "../lib/ecosystems/nativeExternalMetadata.js";
import { fetchNativeAcquisitionBytes, nativeAcquisitionRemaining, nativeAcquisitionUrl } from "./native-acquisition-policy.js";
import { nativeProviderCacheWriter } from "./native-provider-cache.js";

const releaseLimit = 2 * 1024 * 1024;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fetchWheel(url, size, digest, { deadline, allowedHosts, writer, path }) {
  let current = nativeAcquisitionUrl(url, allowedHosts);
  let response;
  for (let redirects = 0; redirects <= 5; redirects++) {
    response = await fetch(current, { redirect: "manual", credentials: "omit",
      signal: AbortSignal.timeout(nativeAcquisitionRemaining(deadline, 180000)) });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location || redirects === 5) throw new Error("Invalid MLIR-AIE wheel redirect");
    current = nativeAcquisitionUrl(new URL(location, current), allowedHosts);
  }
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > size) {
    await response.body?.cancel();
    throw new Error(`Invalid MLIR-AIE wheel response (HTTP ${response.status})`);
  }
  const temporary = `${path}.${randomUUID()}.partial`;
  const destination = writer.file(temporary);
  let fd;
  try {
    fd = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
    const hash = createHash("sha256");
    let received = 0;
    for await (const chunk of response.body) {
      nativeAcquisitionRemaining(deadline);
      received += chunk.byteLength;
      if (received > size) throw new Error("MLIR-AIE wheel exceeds published size");
      hash.update(chunk);
      writeFileSync(fd, chunk);
    }
    if (received !== size || hash.digest("hex") !== digest) throw new Error("MLIR-AIE wheel differs from GitHub's published size or SHA256");
    closeSync(fd); fd = undefined;
    renameSync(writer.file(temporary), writer.file(path));
  } catch (error) {
    await response.body.cancel().catch(() => {});
    if (fd !== undefined) closeSync(fd);
    rmSync(destination, { force: true });
    throw error;
  }
}

/** Record the exact vendor release and stream one admitted wheel. The generic
 * Python wheel reader validates and interprets metadata; nothing is installed. */
export async function acquireNativeMlirAieWheel({ identity, selector, output, sourceRoot, allowedHosts, deadline }) {
  nativeAcquisitionUrl(identity.releaseUrl, allowedHosts);
  nativeAcquisitionUrl(identity.url, allowedHosts);
  const writer = nativeProviderCacheWriter(output, sourceRoot);
  const key = sha(selector);
  const releasePath = `releases/${key}.json`;
  let text = readRegularTextFile(join(output, releasePath), releaseLimit, output);
  if (text === undefined) {
    const { bytes } = await fetchNativeAcquisitionBytes(identity.releaseUrl, { allowedHosts, deadline, maximum: releaseLimit });
    text = bytes.toString("utf8");
  }
  const asset = nativeMlirAieWheelAsset(JSON.parse(text), identity);
  if (!asset) throw new Error("Exact MLIR-AIE release wheel lacks an unambiguous published SHA256 or supported size");
  const path = `artifacts/${asset.sha256}.whl`;
  if (hashRegularFile(join(output, path), asset.size, output) !== asset.sha256) {
    await fetchWheel(identity.url, asset.size, asset.sha256, { deadline, allowedHosts, writer, path });
  }
  writer.write(releasePath, text);
  const record = JSON.stringify({ schema: 1, selector, releaseSha256: sha(text) });
  const recordPath = `wheel-${key}.json`;
  writer.write(recordPath, record);
  const manifestName = `native-provider-metadata-${key}.json`;
  writer.write(manifestName, JSON.stringify({ schema: 1, providers: [{ metadata: { path: recordPath, format: "mlir-aie-wheel", sha256: sha(record) } }] }));
  return { manifestPath: join(output, manifestName), providers: 1 };
}
