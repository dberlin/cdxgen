import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import { Parser as TarParser } from "tar";
import StreamZip from "node-stream-zip";

import { openRegularFile, readRegularTextFile } from "../lib/core/boundedFile.js";
import { acquireNativeArchiveIdentity, nativeDeclaredArchiveFiles, nativeDeclaredArchiveOwner } from "../lib/ecosystems/nativeArchiveIdentity.js";
import { nativeDownloadCacheKey } from "../lib/ecosystems/nativeDownloadSources.js";
import { parseCmakeLikeFile } from "../lib/ecosystems/parsers-misc.js";
import { fetchNativeAcquisitionBytes, nativeAcquisitionRemaining, nativeAcquisitionUrl } from "./native-acquisition-policy.js";
import { nativeProviderCacheWriter } from "./native-provider-cache.js";

const MAX_BYTES = 300 * 1024 * 1024;
const MAX_PREFIX = 64 * 1024;

export function inspectInstallerHeader(text) {
  const constructorName = text.match(/^#\s*NAME:\s*([^\r\n]+)$/m)?.[1].trim();
  const constructorVersion = text.match(/^#\s*VER:\s*([0-9][0-9A-Za-z.+_~-]*)\s*$/m)?.[1];
  if (constructorName && constructorVersion) return {
    name: constructorName, version: constructorVersion, source: "constructor installer NAME/VER header",
  };
  const cpack = text.match(/echo\s+"([^"\r\n]+?) Installer Version:\s*([0-9][0-9A-Za-z.+_~-]*),/);
  if (cpack) return { name: cpack[1], version: cpack[2], source: "CPack installer version header" };
  return undefined;
}

function readDownloadBytes(file, root) {
  const opened = openRegularFile(file, root);
  if (!opened) return undefined;
  try {
    if (opened.size <= 0 || opened.size > MAX_BYTES) return undefined;
    const buffer = Buffer.allocUnsafe(opened.size);
    for (let offset = 0; offset < buffer.length;) {
      const count = readSync(opened.fd, buffer, offset, buffer.length - offset, offset);
      if (!count) return undefined;
      offset += count;
    }
    return buffer;
  } finally { closeSync(opened.fd); }
}

/** Only the literal CPack STGZ offset is interpreted. The shell is never run. */
function cpackExecutablePayload(bytes, prefix) {
  const starts = [...prefix.matchAll(/^tail \$use_new_tail_syntax \+([1-9]\d{0,5}) "\$0" \| gunzip \| \(cd "\$\{toplevel\}" && \$\{extractor\}\) \|\| cpack_echo_exit "[^"\r\n]+"[ \t]*\r?$/gm)];
  if (starts.length !== 1 || !prefix.startsWith("#!/bin/sh\n")) return undefined;
  let offset = -1;
  for (let lines = Number(starts[0][1]) - 1; lines > 0; lines--) {
    offset = bytes.indexOf(10, offset + 1);
    if (offset < 0 || offset >= MAX_PREFIX) return undefined;
  }
  offset++;
  if (offset <= starts[0].index || bytes[offset] !== 0x1f || bytes[offset + 1] !== 0x8b ||
    !/\nexit 0\n(?:#[^\r\n]*\n|\n)*$/.test(bytes.subarray(0, offset).toString("utf8"))) return undefined;
  let tar;
  try { tar = gunzipSync(bytes.subarray(offset), { maxOutputLength: 64 * 1024 * 1024 }); } catch { return undefined; }
  return new Promise((resolvePayload) => {
    const seen = new Set(); const members = []; let invalid = false;
    const parser = new TarParser({ strict: true, onReadEntry(entry) {
      const member = entry.path.replace(/^\.\//, "").replace(/\/$/, "");
      if (seen.size >= 4096 || seen.has(member) || !member || member.length > 1024 ||
        /[\\:\x00-\x1f]/.test(member) || member.split("/").some((part) => !part || part === "." || part === "..")) invalid = true;
      seen.add(member);
      if (!invalid && /^bin\/[A-Za-z0-9_][A-Za-z0-9_.+-]*$/.test(member) &&
        ["File", "OldFile"].includes(entry.type) && entry.mode & 0o111 && entry.size > 0) {
        const digest = createHash("sha256");
        entry.on("data", (chunk) => digest.update(chunk));
        entry.on("end", () => members.push({ member, bytes: entry.size, mode: entry.mode, sha256: digest.digest("hex") }));
      } else entry.resume();
    } });
    parser.on("error", () => resolvePayload(undefined));
    parser.on("close", () => resolvePayload(!invalid && members.length ? { payloadOffset: offset, members } : undefined));
    parser.end(tar);
  });
}

export function githubReleaseIdentity(input) {
  try {
    const url = new URL(input);
    if (url.hostname !== "github.com" || url.protocol !== "https:" || url.username || url.password || url.search) return undefined;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 6 || parts[2] !== "releases" || parts[3] !== "download") return undefined;
    const tag = decodeURIComponent(parts[4]);
    if (/^(?:latest|master|main|head)$/i.test(tag) || !tag) return undefined;
    return { repository: `https://github.com/${parts[0]}/${parts[1]}`, tag, name: parts[1] };
  } catch { return undefined; }
}

function externalCache(sourceRoot, cache) {
  let ancestor = resolve(cache);
  const suffix = [];
  while (!existsSync(ancestor)) {
    suffix.unshift(basename(ancestor));
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error("Cannot locate cache ancestor");
    ancestor = parent;
  }
  const destination = resolve(realpathSync(ancestor), ...suffix);
  const scope = relative(realpathSync(sourceRoot), destination);
  if (!(scope === ".." || scope.startsWith(`..${sep}`) || isAbsolute(scope))) throw new Error("Download cache must be outside source directories");
  return destination;
}

async function isaArchiveEvidence(file, prefix) {
  if (prefix[0] !== 0x50 || prefix[1] !== 0x4b) return undefined;
  const archive = new StreamZip.async({ file });
  try {
    const entries = Object.values(await archive.entries()).filter((entry) => !entry.isDirectory);
    if (!entries.length || entries.length > 256 || entries.some((entry) => !/^[A-Za-z0-9_.-]+\.xml$/.test(entry.name))) return undefined;
    const evidence = [];
    for (const entry of entries) {
      const stream = await archive.stream(entry.name);
      const chunks = [];
      let bytes = 0;
      for await (const chunk of stream) {
        const part = chunk.subarray(0, MAX_PREFIX - bytes);
        chunks.push(part);
        bytes += part.length;
        if (bytes >= MAX_PREFIX) break;
      }
      const text = Buffer.concat(chunks, bytes).toString("utf8");
      if (!/<Spec>/.test(text) || !/<ISA>/.test(text) || !/<ArchitectureName>[^<]+<\/ArchitectureName>/.test(text)) return undefined;
      evidence.push(`${entry.name}: ISA XML; ReleaseDate=${text.match(/<ReleaseDate>([^<]+)<\/ReleaseDate>/)?.[1] || "unspecified"}; SchemaVersion=${text.match(/<SchemaVersion>([^<]+)<\/SchemaVersion>/)?.[1] || "unspecified"}`);
    }
    return evidence;
  } finally { await archive.close(); }
}

function ensureCacheDirectory(directory) {
  try {
    const existing = lstatSync(directory);
    if (existing.isSymbolicLink() || !existing.isDirectory()) throw new Error("Cache output directories must not be symlinks or files");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  mkdirSync(directory, { recursive: true });
  const created = lstatSync(directory);
  if (created.isSymbolicLink() || !created.isDirectory()) throw new Error("Cache output directories must not be symlinks or files");
}

/** Explicit bounded acquisition, shared by the normal CLI and standalone tool.
 * A declared checksum authenticates generic archives before any interpretation. */
export async function cacheNativeDownload({ url, cache, sourceRoot, urlHash, name, allowedHosts, localArtifact, artifactType, mirrorUrl, deadline = Date.now() + 300000 }) {
  nativeAcquisitionRemaining(deadline);
  const root = externalCache(sourceRoot, cache);
  const original = new URL(url);
  if (original.protocol !== "https:" || original.username || original.password || original.hash || original.search) throw new Error("An explicit credential-free HTTPS artifact URL is required");
  const pinnedData = artifactType === "data" && Boolean(urlHash);
  const algorithms = { SHA256: ["sha256", 64], SHA512: ["sha512", 128], SHA384: ["sha384", 96], SHA224: ["sha224", 56], SHA1: ["sha1", 40], MD5: ["md5", 32],
    SHA3_256: ["sha3-256", 64], SHA3_384: ["sha3-384", 96], SHA3_512: ["sha3-512", 128] };
  const [algorithm, expected, extraPin] = (urlHash || "").split("=");
  const selected = algorithms[algorithm?.toUpperCase()];
  if (urlHash && (!selected || extraPin !== undefined || expected?.length !== selected[1] || !/^[a-f0-9]+$/i.test(expected))) {
    throw new Error("Unsupported or unresolved declared archive checksum");
  }
  const declaredHash = urlHash ? `${algorithm.toUpperCase()}=${expected.toLowerCase()}` : undefined;
  if (mirrorUrl !== undefined) {
    if (!pinnedData || localArtifact !== undefined) throw new Error("A mirror requires a data artifact and its declared checksum");
    nativeAcquisitionUrl(original, allowedHosts);
    const mirror = nativeAcquisitionUrl(mirrorUrl, allowedHosts);
    if (mirror.search) throw new Error("An explicit mirror URL cannot include query parameters");
  }
  if (localArtifact !== undefined) {
    if (!urlHash) throw new Error("A declared checksum is required to import a local download artifact");
    nativeAcquisitionUrl(original, allowedHosts);
  }
  const writer = nativeProviderCacheWriter(root, sourceRoot);
  ensureCacheDirectory(join(root, "downloads")); ensureCacheDirectory(join(root, "download-artifacts"));
  writer.mkdir("downloads"); writer.mkdir("download-artifacts");
  const key = nativeDownloadCacheKey(original.href, pinnedData ? declaredHash : undefined);
  let prior;
  try { prior = JSON.parse(readRegularTextFile(join(root, "downloads", `${key}.json`), 128 * 1024, root) || "null"); } catch { /* No trusted URL record. */ }
  let bytes; let finalUrl; let redirectChain;
  if (localArtifact !== undefined) {
    const input = resolve(localArtifact);
    bytes = readDownloadBytes(input, dirname(input));
    if (!bytes) throw new Error("Local download artifact is missing, unsafe or exceeds the byte limit");
    finalUrl = original.href; redirectChain = [original.href];
  } else if (mirrorUrl === undefined && prior?.schema === 1 && prior.url === url &&
    prior.declaredHash === (pinnedData ? declaredHash : undefined) &&
    /^[a-f0-9]{64}$/.test(prior.sha256 || "") && prior.artifact === `download-artifacts/${prior.sha256}`) {
    const retained = readDownloadBytes(join(root, prior.artifact), root);
    if (retained && createHash("sha256").update(retained).digest("hex") === prior.sha256) {
      bytes = retained; finalUrl = prior.transportUrl || prior.resolvedUrl;
      redirectChain = Array.isArray(prior.redirectChain) ? prior.redirectChain : [url, prior.resolvedUrl];
    }
  }
  if (!bytes) ({ bytes, resolvedUrl: finalUrl, redirectChain } = await fetchNativeAcquisitionBytes(mirrorUrl || url, { allowedHosts, deadline, maximum: MAX_BYTES }));
  nativeAcquisitionRemaining(deadline);
  const releaseUrl = redirectChain.find((location) => githubReleaseIdentity(location));
  const identityUrl = releaseUrl || (new URL(finalUrl).search ? original.href : finalUrl);
  if (urlHash && createHash(selected[0]).update(bytes).digest("hex") !== expected.toLowerCase()) throw new Error("Declared archive hash mismatch");
  if (pinnedData && !bytes.length) throw new Error("The checksum-pinned data artifact is empty");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const artifact = `download-artifacts/${sha256}`;
  writer.write(artifact, bytes);
  const recordFile = join(root, "downloads", `${key}.json`);
  const provenance = {
    schema: 1, url: original.href, resolvedUrl: pinnedData ? original.href : identityUrl,
    transportUrl: finalUrl.split("?")[0], redirectChain: redirectChain.map((location) => location.split("?")[0]),
    observedAt: new Date().toISOString(), sha256, md5: selected?.[0] === "md5" ? expected.toLowerCase() :
      createHash("md5").update(bytes).digest("hex"), bytes: bytes.length, artifact,
  };
  if (pinnedData) {
    const record = { ...provenance, name: name || basename(original.pathname), type: "data",
      declaredHash, evidence: [`Declared data checksum ${declaredHash}`, `Data transport: ${provenance.transportUrl}`] };
    writer.write(`downloads/${key}.json`, `${JSON.stringify(record, null, 2)}\n`);
    return { recordFile, ...record };
  }
  const file = join(root, artifact);
  const prefix = bytes.subarray(0, MAX_PREFIX).toString("utf8");
  const installer = inspectInstallerHeader(prefix);
  const isa = await isaArchiveEvidence(file, bytes.subarray(0, MAX_PREFIX));
  const release = releaseUrl && githubReleaseIdentity(releaseUrl);
  const cpack = urlHash && installer?.source === "CPack installer version header";
  const identity = !cpack && await acquireNativeArchiveIdentity(file, url, root, sourceRoot, deadline);
  let archiveVersion; let archiveName; let providerManifest; let prerequisite;
  const installerFilename = basename(original.pathname);
  let installerInventory;
  if (cpack) {
    const payload = await cpackExecutablePayload(bytes, prefix);
    if (!payload) prerequisite = "CPack installer payload lacks an authenticated STGZ executable inventory";
    else {
      installerInventory = `declared-metadata/${sha256}/installer-inventory.json`;
      const inventory = JSON.stringify({ schema: 1, url, urlHash, artifact, sha256, bytes: bytes.length,
        installerFilename, releaseTag: release?.tag, packageName: installer.name, packageVersion: installer.version,
        packageVersionSource: installer.source, ...payload });
      writer.write(installerInventory, inventory);
      const path = `installer-${sha256}.provider.json`;
      const snapshot = JSON.stringify({ schema: 1, name: installer.name, versionKind: "release", version: installer.version,
        ...(release ? { repository: release.repository } : {}),
        files: payload.members.map(({ member }) => member),
        evidence: [{ path: installerInventory, sha256: createHash("sha256").update(inventory).digest("hex") }],
        conditions: ["Checksum-verified installer package payload; available, not installed or selected"] });
      writer.write(path, snapshot);
      providerManifest = join(root, `installer-${sha256}.manifest.json`);
      writer.write(`installer-${sha256}.manifest.json`, JSON.stringify({ schema: 1,
        providers: [{ metadata: { path, format: "provider-snapshot", sha256: createHash("sha256").update(snapshot).digest("hex") } }] }));
    }
  }
  if (urlHash && !cpack) {
    try {
      const files = await nativeDeclaredArchiveFiles(file, root, sourceRoot, deadline);
      const evidence = [];
      for (const entry of files) {
        const path = `declared-metadata/${sha256}/${entry.path}`;
        writer.write(path, entry.content);
        evidence.push({ path, sha256: entry.sha256, member: entry.path });
      }
      const owner = nativeDeclaredArchiveOwner(files.map((entry) => ({ ...entry, member: entry.path, path: `declared-metadata/${sha256}/${entry.path}` })), root,
        (file, sourceRoot) => parseCmakeLikeFile(file, "generic", { sourceRoot }).parentComponent);
      archiveVersion = owner?.version; archiveName = owner?.name;
      const inventoryPath = `declared-metadata/${sha256}/archive-inventory.json`;
      const inventory = JSON.stringify({ schema: 1, acquisitionUrl: url, artifact, sha256, size: bytes.length, files: files.members || files.map((entry) => entry.path) });
      writer.write(inventoryPath, inventory);
      evidence.push({ path: inventoryPath, sha256: createHash("sha256").update(inventory).digest("hex") });
      if (archiveVersion && archiveName) {
        writer.write(`declared-archives/${createHash("sha256").update(JSON.stringify([url])).digest("hex")}.json`,
          JSON.stringify({ schema: 1, url, urlHash, observedAt: new Date().toISOString(), archive: { path: artifact, sha256, bytes: bytes.length },
            files: files.map((entry) => ({ member: entry.path, path: `declared-metadata/${sha256}/${entry.path}`, sha256: entry.sha256 })) }));
        const provenance = `declared-metadata/${sha256}/acquisition.json`;
        const text = JSON.stringify({ schema: 1, url, resolvedUrl: identityUrl, transportUrl: finalUrl.split("?")[0], sha256, urlHash, declaredName: name });
        writer.write(provenance, text); evidence.push({ path: provenance, sha256: createHash("sha256").update(text).digest("hex") });
        const path = `declared-${sha256}.provider.json`;
        const snapshot = JSON.stringify({ schema: 1, name: archiveName, versionKind: "release", version: archiveVersion,
          ...(identity ? { repository: identity.repository } : {}), files: (files.members || files.map((entry) => entry.path)).filter((path) => !path.endsWith(".in")),
          evidence, conditions: ["Hash-authenticated declared source archive; available, not installed or selected", "Source owner release is not an interface/ABI selection"] });
        writer.write(path, snapshot);
        providerManifest = join(root, `declared-${sha256}.manifest.json`);
        writer.write(`declared-${sha256}.manifest.json`, JSON.stringify({ schema: 1, providers: [{ metadata: { path, format: "provider-snapshot", sha256: createHash("sha256").update(snapshot).digest("hex") } }] }));
      }
    } catch (error) {
      // A non-archive installer can still have independently inspected identity.
      if (!release && !installer && !isa) prerequisite = String(error.message).split("\n")[0];
    }
  }
  if (!release && !installer && !isa && !identity && !archiveVersion) prerequisite ||= "Original artifact acquired, but an authenticated owner release/interface remains an external metadata prerequisite";
  const record = {
    ...provenance,
    name: installer?.name || archiveName || release?.name || name || "machine-readable-isa",
    type: isa ? "data" : installer ? "application" : "library",
    ...(prerequisite ? { prerequisite } : {}),
    ...(release ? { releaseTag: release.tag } : {}),
    ...(installer ? { artifactVersion: installer.version, artifactVersionSource: installer.source } : {}),
    ...(installerInventory ? { installerInventory, installerFilename } : {}),
    // Archive versions are consumed only after re-authenticating archive metadata,
    // never as an installer-version claim in the URL-only download reader.
    evidence: [...(release ? [`GitHub release asset: ${releaseUrl}`] : []), ...(installer ? [`${installer.source}: ${installer.name} ${installer.version}`] : []),
      ...(prerequisite ? [`Original artifact SHA256 ${sha256}; owner release remains unresolved`] : []),
      ...(identity || archiveVersion ? [`Declared archive SHA256 ${sha256}; owner metadata release ${archiveVersion || identity.version}`] : []), ...(isa || [])],
  };
  writer.write(`downloads/${key}.json`, `${JSON.stringify(record, null, 2)}\n`);
  return { recordFile, ...record, providerManifest, archiveVersion: archiveVersion || identity?.version };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: {
      url: { type: "string" }, cache: { type: "string" }, "source-root": { type: "string" },
      type: { type: "string" }, hash: { type: "string" }, "mirror-url": { type: "string" }, "allowed-hosts": { type: "string" },
    } });
    if (!values.url || !values.cache || !values["source-root"] || values.type && values.type !== "data") {
      throw new Error("Usage: bun contrib/native-download-cache.js --url HTTPS_URL --cache EXTERNAL_DIR --source-root SOURCE_DIR [--type data --hash ALGORITHM=HEX --mirror-url HTTPS_MIRROR --allowed-hosts HOSTS]");
    }
    const record = await cacheNativeDownload({ url: values.url, cache: values.cache, sourceRoot: values["source-root"],
      artifactType: values.type, urlHash: values.hash, mirrorUrl: values["mirror-url"], allowedHosts: values["allowed-hosts"] });
    console.log(JSON.stringify({ recordFile: record.recordFile, name: record.name, type: record.type, releaseTag: record.releaseTag, artifactVersion: record.artifactVersion, sha256: record.sha256 }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
