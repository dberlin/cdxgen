import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import StreamZip from "node-stream-zip";

import { openRegularFile, readRegularTextFile } from "../lib/core/boundedFile.js";
import { acquireNativeArchiveIdentity, nativeDeclaredArchiveFiles, nativeDeclaredArchiveOwner } from "../lib/ecosystems/nativeArchiveIdentity.js";
import { parseCmakeLikeFile } from "../lib/ecosystems/parsers-misc.js";
import { fetchNativeAcquisitionBytes, nativeAcquisitionRemaining } from "./native-acquisition-policy.js";
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
export async function cacheNativeDownload({ url, cache, sourceRoot, urlHash, name, allowedHosts, deadline = Date.now() + 300000 }) {
  nativeAcquisitionRemaining(deadline);
  const root = externalCache(sourceRoot, cache);
  const original = new URL(url);
  if (original.protocol !== "https:" || original.username || original.password || original.hash || original.search) throw new Error("An explicit credential-free HTTPS artifact URL is required");
  const writer = nativeProviderCacheWriter(root, sourceRoot);
  ensureCacheDirectory(join(root, "downloads")); ensureCacheDirectory(join(root, "download-artifacts"));
  writer.mkdir("downloads"); writer.mkdir("download-artifacts");
  const key = createHash("sha256").update(JSON.stringify([original.href])).digest("hex");
  let prior;
  try { prior = JSON.parse(readRegularTextFile(join(root, "downloads", `${key}.json`), 128 * 1024, root) || "null"); } catch { /* No trusted URL record. */ }
  let bytes; let finalUrl; let redirectChain;
  if (prior?.schema === 1 && prior.url === url && /^[a-f0-9]{64}$/.test(prior.sha256 || "") && prior.artifact === `download-artifacts/${prior.sha256}`) {
    const opened = openRegularFile(join(root, prior.artifact), root);
    if (opened) {
      try {
        if (opened.size > 0 && opened.size <= MAX_BYTES) {
          const buffer = Buffer.alloc(opened.size); let offset = 0;
          while (offset < buffer.length) { const count = readSync(opened.fd, buffer, offset, buffer.length - offset, offset); if (!count) break; offset += count; }
          if (offset === buffer.length && createHash("sha256").update(buffer).digest("hex") === prior.sha256) {
            bytes = buffer; finalUrl = prior.transportUrl || prior.resolvedUrl;
            redirectChain = Array.isArray(prior.redirectChain) ? prior.redirectChain : [url, prior.resolvedUrl];
          }
        }
      } finally { closeSync(opened.fd); }
    }
  }
  if (!bytes) ({ bytes, resolvedUrl: finalUrl, redirectChain } = await fetchNativeAcquisitionBytes(url, { allowedHosts, deadline, maximum: MAX_BYTES }));
  nativeAcquisitionRemaining(deadline);
  const releaseUrl = redirectChain.find((location) => githubReleaseIdentity(location));
  const identityUrl = releaseUrl || (new URL(finalUrl).search ? original.href : finalUrl);
  const algorithms = { SHA256: ["sha256", 64], SHA512: ["sha512", 128], SHA384: ["sha384", 96], SHA224: ["sha224", 56], SHA1: ["sha1", 40], MD5: ["md5", 32],
    SHA3_256: ["sha3-256", 64], SHA3_384: ["sha3-384", 96], SHA3_512: ["sha3-512", 128] };
  const [algorithm, expected] = (urlHash || "").split("=");
  if (urlHash) {
    const selected = algorithms[algorithm?.toUpperCase()];
    if (!selected || expected?.length !== selected[1] || !/^[a-f0-9]+$/i.test(expected)) throw new Error("Unsupported or unresolved declared archive checksum");
    if (createHash(selected[0]).update(bytes).digest("hex") !== expected.toLowerCase()) throw new Error("Declared archive hash mismatch");
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const artifact = `download-artifacts/${sha256}`;
  writer.write(artifact, bytes);
  const file = join(root, artifact);
  const installer = inspectInstallerHeader(bytes.subarray(0, MAX_PREFIX).toString("utf8"));
  const isa = await isaArchiveEvidence(file, bytes.subarray(0, MAX_PREFIX));
  const release = releaseUrl && githubReleaseIdentity(releaseUrl);
  const identity = await acquireNativeArchiveIdentity(file, url, root, sourceRoot, deadline);
  let archiveVersion; let archiveName; let providerManifest; let prerequisite;
  if (urlHash) {
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
    schema: 1, url: original.href, resolvedUrl: identityUrl,
    transportUrl: finalUrl.split("?")[0], redirectChain: redirectChain.map((location) => location.split("?")[0]),
    observedAt: new Date().toISOString(), sha256, md5: createHash("md5").update(bytes).digest("hex"), bytes: bytes.length,
    name: installer?.name || archiveName || release?.name || name || "machine-readable-isa",
    type: isa ? "data" : installer ? "application" : "library", artifact,
    ...(prerequisite ? { prerequisite } : {}),
    ...(release ? { releaseTag: release.tag } : {}),
    ...(installer ? { artifactVersion: installer.version, artifactVersionSource: installer.source } : {}),
    // Archive versions are consumed only after re-authenticating archive metadata,
    // never as an installer-version claim in the URL-only download reader.
    evidence: [...(release ? [`GitHub release asset: ${releaseUrl}`] : []), ...(installer ? [`${installer.source}: ${installer.name} ${installer.version}`] : []),
      ...(prerequisite ? [`Original artifact SHA256 ${sha256}; owner release remains unresolved`] : []),
      ...(identity || archiveVersion ? [`Declared archive SHA256 ${sha256}; owner metadata release ${archiveVersion || identity.version}`] : []), ...(isa || [])],
  };
  const recordFile = join(root, "downloads", `${key}.json`);
  writer.write(`downloads/${key}.json`, `${JSON.stringify(record, null, 2)}\n`);
  return { recordFile, ...record, providerManifest, archiveVersion: archiveVersion || identity?.version };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (flag) => args[args.indexOf(flag) + 1];
  if (!["--url", "--cache", "--source-root"].every((flag) => args.includes(flag) && value(flag))) {
    console.error("Usage: bun contrib/native-download-cache.js --url HTTPS_URL --cache EXTERNAL_DIR --source-root SOURCE_DIR");
    process.exitCode = 1;
  } else {
    try {
      const record = await cacheNativeDownload({ url: value("--url"), cache: value("--cache"), sourceRoot: value("--source-root") });
      console.log(JSON.stringify({ recordFile: record.recordFile, name: record.name, type: record.type, releaseTag: record.releaseTag, artifactVersion: record.artifactVersion, sha256: record.sha256 }));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
