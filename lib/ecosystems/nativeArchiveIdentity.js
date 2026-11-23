import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, readSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { Parser as TarParser } from "tar";
import StreamZip from "node-stream-zip";

import { openRegularFile, readRegularTextFile } from "../core/boundedFile.js";
import { nativeSourceRepository } from "../inventory/nativeSourceIdentity.js";
import { cmakeProjectDetails } from "./nativeSourceVersions.js";
import { parseCmakeCommands } from "../parsers/cmakeLists.js";
import { nativeDownloadCacheKey } from "./nativeDownloadSources.js";

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 64 * 1024 * 1024;
const MAX_METADATA_BYTES = 8 * 1024 * 1024;
const MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const ownerName = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && !url.port;
  } catch { return false; }
}

function safeMember(path) {
  return typeof path === "string" && path.length <= 1024 && !path.includes("\\") && !path.startsWith("/") &&
    !/^[A-Za-z]:/.test(path) && !/[\x00-\x1f]/.test(path) && !path.split("/").some((part) => !part || part === "." || part === "..");
}

function separateTrees(cache, sourceRoot) {
  const source = realpathSync(sourceRoot);
  const external = realpathSync(cache);
  const outside = (path) => path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
  return outside(relative(source, external)) && outside(relative(external, source));
}

function readArchive(file, root) {
  const opened = openRegularFile(file, root);
  if (!opened) return undefined;
  try {
    if (!opened.size || opened.size > MAX_ARCHIVE_BYTES) return undefined;
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(opened.fd, bytes, offset, bytes.length - offset, offset);
      if (!count) return undefined;
      offset += count;
    }
    return bytes;
  } finally { closeSync(opened.fd); }
}

function systemXz(sourceRoot) {
  const source = realpathSync(sourceRoot);
  for (const candidate of ["/usr/bin/xz", "/bin/xz"]) {
    try {
      const codec = realpathSync(candidate);
      const scope = relative(source, codec);
      if (!(scope === ".." || scope.startsWith(`..${sep}`) || isAbsolute(scope))) continue;
      const stat = statSync(codec);
      // UID ownership changes under user namespaces; it is not evidence that
      // a read-only mounted system executable belongs to scanned source.
      if (stat.isFile() && stat.mode & 0o111) return codec;
    } catch { /* Only verified system codecs are eligible. */ }
  }
  return undefined;
}

function unpackArchive(bytes, sourceRoot, cache, deadline) {
  if (Date.now() >= deadline) throw new Error("Native acquisition deadline exceeded");
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return gunzipSync(bytes, { maxOutputLength: MAX_UNPACKED_BYTES });
  if (bytes.subarray(0, 6).equals(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]))) {
    // Explicit acquisition only. Never resolve a codec through caller PATH,
    // inherit credentials/loader variables, or execute with a source cwd.
    const codec = systemXz(sourceRoot);
    if (!codec) return undefined;
    const timeout = Math.min(15000, deadline - Date.now());
    if (timeout <= 0) throw new Error("Native acquisition deadline exceeded");
    return execFileSync(codec, ["--decompress", "--stdout", "--memlimit-decompress=128MiB"], {
      input: bytes, maxBuffer: MAX_UNPACKED_BYTES, timeout, stdio: ["pipe", "pipe", "pipe"],
      cwd: realpathSync(cache), env: { LANG: "C", LC_ALL: "C" },
    });
  }
  return bytes.length <= MAX_UNPACKED_BYTES ? bytes : undefined;
}

function archiveMetadata(bytes, declared = false) {
  return new Promise((resolvePromise) => {
    const files = [];
    const seen = new Set();
    const members = [];
    let entries = 0;
    let metadataBytes = 0;
    let invalid = false;
    const parser = new TarParser({ strict: true, onReadEntry(entry) {
      const path = entry.path.replace(/^\.\//, "").replace(/\/$/, "");
      if (++entries > 4096 || !safeMember(path) || seen.has(path)) invalid = true;
      seen.add(path);
      if (["File", "OldFile"].includes(entry.type)) members.push(path);
      const wanted = declared ? /(?:^|\/)(?:CMakeLists\.txt|meson\.build|VERSION(?:\.txt)?|package\.json|[^/]+\.(?:pc|cmake|h|hpp|hh|hxx)(?:\.in)?)$/i.test(path) :
        /^(?:[^/]+\/)?CMakeLists\.txt$/.test(path) ||
        /^(?:[^/]+\/)?(?:include|single_include)\/.+\.(?:h|hpp|hh|hxx)$/.test(path);
      if (wanted && (entry.size > MAX_ENTRY_BYTES || files.length >= 128 ||
        (metadataBytes += entry.size) > MAX_METADATA_BYTES)) invalid = true;
      if (invalid || !wanted || !["File", "OldFile"].includes(entry.type)) {
        entry.resume();
        return;
      }
      const chunks = [];
      entry.on("data", (chunk) => chunks.push(chunk));
      entry.on("end", () => {
        const content = Buffer.concat(chunks);
        files.push({ path, sha256: hash(content), content: content.toString("utf8") });
      });
    } });
    parser.on("error", () => resolvePromise(undefined));
    parser.on("close", () => {
      if (declared) files.members = members;
      resolvePromise(invalid ? undefined : files);
    });
    parser.end(bytes);
  });
}

function ownedIdentity(files) {
  const manifests = files.filter((file) => /^(?:[^/]+\/)?CMakeLists\.txt$/.test(file.path));
  if (manifests.length !== 1) return undefined;
  const manifest = manifests[0];
  const projects = [];
  let depth = 0;
  for (const command of parseCmakeCommands(manifest.content)) {
    if (["endif", "endfunction", "endmacro", "endforeach", "endwhile"].includes(command.name)) depth--;
    if (!depth && command.name === "project") projects.push(command);
    if (["if", "function", "macro", "foreach", "while"].includes(command.name)) depth++;
  }
  if (projects.length !== 1) return undefined;
  const project = projects[0];
  const name = project.args[0];
  const versionAt = project.args.findIndex((arg) => arg.toUpperCase() === "VERSION");
  const version = versionAt >= 0 && project.args[versionAt + 1];
  if (!name || name.includes("$") || !/^\d+(?:\.\d+)+(?:[-+._~][0-9A-Za-z.]+)?$/.test(version || "")) return undefined;
  const root = manifest.path.slice(0, -"CMakeLists.txt".length);
  const candidates = [];
  for (const file of files) {
    const local = file.path.startsWith(root) && file.path.slice(root.length);
    const owned = local && local.match(/^(?:include|single_include)\/(.+)\.(?:h|hpp|hh|hxx)$/);
    if (!owned || ownerName(owned[1]) !== ownerName(name)) continue;
    const lines = file.content.split(/\r?\n/, 33);
    let bannerVersion;
    let repository;
    let versionLine;
    let repositoryLine;
    for (let index = 0; index < Math.min(lines.length, 32); index++) {
      const line = lines[index];
      if (!/^\s*(?:\/\/|\/\*|\*|$)/.test(line)) break;
      const declared = line.match(/\bversion\s+(\d+(?:\.\d+)+(?:[-+._~][0-9A-Za-z.]+)?)/i)?.[1];
      if (declared) { bannerVersion = declared; versionLine = index + 1; }
      for (const token of line.match(/https:\/\/[^\s<>"'|]+/g) || []) {
        const url = token.replace(/[),;]+$/, "");
        const normalized = nativeSourceRepository(url);
        if (!normalized || !["github.com", "gitlab.com", "bitbucket.org", "codeberg.org"].includes(new URL(normalized).hostname)) continue;
        if (repository && repository !== normalized) return undefined;
        repository = normalized;
        repositoryLine = index + 1;
      }
    }
    if (bannerVersion !== version || !repository) continue;
    candidates.push({ file, repository, versionLine, repositoryLine });
  }
  if (!candidates.length || new Set(candidates.map((candidate) => candidate.repository)).size !== 1) return undefined;
  const selected = candidates[0];
  return { repository: selected.repository, version, files: [manifest, selected.file], fields: [
    { path: manifest.path, sha256: manifest.sha256, line: project.line, field: "project.name", value: name },
    { path: manifest.path, sha256: manifest.sha256, line: project.line, field: "project.version", value: version },
    { path: selected.file.path, sha256: selected.file.sha256, line: selected.versionLine, field: "header.version", value: version },
    { path: selected.file.path, sha256: selected.file.sha256, line: selected.repositoryLine, field: "repository", value: selected.repository },
  ] };
}

/** Read declared archive metadata without extracting paths or executing builds.
 * The caller authenticates the complete archive before invoking this bridge. */
export async function nativeDeclaredArchiveFiles(archiveFile, cache, sourceRoot, deadline = Date.now() + 15000) {
  if (Date.now() >= deadline) throw new Error("Native acquisition deadline exceeded");
  if (!separateTrees(cache, sourceRoot)) throw new Error("Declared archive cache overlaps source");
  const bytes = readArchive(archiveFile, cache);
  if (!bytes) throw new Error("Declared archive is missing or exceeds the byte limit");
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const archive = new StreamZip.async({ file: archiveFile });
    try {
      const entries = Object.values(await archive.entries());
      if (entries.length > 4096) throw new Error("Declared ZIP exceeds metadata entry limit");
      const files = []; let total = 0;
      for (const entry of entries) {
        if (entry.isDirectory) continue;
        if (!safeMember(entry.name) || (entry.attr >>> 16 & 0xf000) === 0xa000) throw new Error("Unsafe declared ZIP member");
        if (!/(?:^|\/)(?:CMakeLists\.txt|meson\.build|VERSION(?:\.txt)?|package\.json|[^/]+\.(?:pc|cmake|h|hpp|hh|hxx)(?:\.in)?)$/i.test(entry.name)) continue;
        if (entry.size > MAX_ENTRY_BYTES || files.length >= 128 || (total += entry.size) > MAX_METADATA_BYTES) throw new Error("Declared ZIP metadata exceeds byte limit");
        const content = await archive.entryData(entry);
        files.push({ path: entry.name, sha256: hash(content), content: content.toString("utf8") });
      }
      files.members = entries.filter((entry) => !entry.isDirectory).map((entry) => entry.name);
      return files;
    } finally { await archive.close(); }
  }
  const unpacked = unpackArchive(bytes, sourceRoot, cache, deadline);
  const files = unpacked && await archiveMetadata(unpacked, true);
  if (!files) throw new Error("Unsupported or unsafe declared archive metadata");
  return files;
}

/** Reuse static owner interpretation on authenticated, bounded metadata files,
 * not a checkout or a second scan of the user's source tree. */
export function nativeDeclaredArchiveOwner(files, directory, mesonOwner) {
  const manifests = files.filter((entry) => /^(?:[^/]+\/)?(?:CMakeLists\.txt|meson\.build|package\.json)$/.test(entry.member || entry.path));
  const facts = [];
  for (const entry of manifests) {
    const file = join(directory, entry.path);
    const content = entry.content ?? readRegularTextFile(file, MAX_ENTRY_BYTES, directory);
    if (content === undefined) continue;
    if ((entry.member || entry.path).endsWith("CMakeLists.txt")) {
      const authenticatedFiles = new Map(files.map((entry) => [join(directory, entry.path), entry.content ?? readRegularTextFile(join(directory, entry.path), MAX_ENTRY_BYTES, directory)]));
      const owner = cmakeProjectDetails(file, parseCmakeCommands(content), file.slice(0, -"CMakeLists.txt".length), { authenticatedFiles });
      if (owner.name && owner.version) facts.push({ name: owner.name, version: owner.version });
    } else if ((entry.member || entry.path).endsWith("meson.build")) {
      const owner = mesonOwner?.(file, directory);
      if (owner?.name && owner.version) facts.push({ name: owner.name, version: owner.version });
    } else {
      let owner;
      try { owner = JSON.parse(content); } catch { continue; }
      if (/^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/.test(owner.name || "") && /^\d+(?:\.\d+)+(?:[-+._~][0-9A-Za-z.]+)?$/.test(owner.version || "")) facts.push({ name: owner.name, version: owner.version });
    }
  }
  if (!facts.length || new Set(facts.map((entry) => JSON.stringify(entry))).size !== 1) return undefined;
  return facts[0];
}

/** Passive declared-archive reader: rehash original bytes and retained metadata,
 * then derive the owner release again rather than trust an acquisition result. */
export function nativeDeclaredArchiveIdentityEvidence(url, cache, sourceRoot, expectedHash, mesonOwner) {
  if (!safeUrl(url) || !cache || !sourceRoot) return undefined;
  try {
    if (!separateTrees(cache, sourceRoot)) return undefined;
    const recordFile = join(cache, "declared-archives", `${nativeDownloadCacheKey(url)}.json`);
    const record = JSON.parse(readRegularTextFile(recordFile, MAX_METADATA_BYTES + 128 * 1024, cache) || "null");
    if (record?.schema !== 1 || record.url !== url || expectedHash && record.urlHash !== expectedHash ||
      !safeMember(record.archive?.path) || !/^[a-f0-9]{64}$/.test(record.archive?.sha256 || "") ||
      !Array.isArray(record.files) || record.files.length > 128) return undefined;
    const bytes = readArchive(join(cache, record.archive.path), cache);
    if (!bytes || hash(bytes) !== record.archive.sha256 || bytes.length !== record.archive.bytes) return undefined;
    const algorithms = { SHA256: "sha256", SHA512: "sha512", SHA384: "sha384", SHA224: "sha224", SHA1: "sha1", MD5: "md5",
      SHA3_256: "sha3-256", SHA3_384: "sha3-384", SHA3_512: "sha3-512" };
    const [algorithm, digest] = (record.urlHash || "").split("=");
    if (!algorithms[algorithm] || createHash(algorithms[algorithm]).update(bytes).digest("hex") !== digest?.toLowerCase()) return undefined;
    const authenticatedFiles = new Map(); const seen = new Set();
    for (const entry of record.files) {
      if (!safeMember(entry.member) || !safeMember(entry.path) || seen.has(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256 || "")) return undefined;
      seen.add(entry.path);
      const content = readRegularTextFile(join(cache, entry.path), MAX_ENTRY_BYTES, cache);
      if (content === undefined || hash(content) !== entry.sha256) return undefined;
      authenticatedFiles.set(join(cache, entry.path), content);
    }
    const project = nativeDeclaredArchiveOwner(record.files.map((entry) => ({ ...entry, content: authenticatedFiles.get(join(cache, entry.path)) })), cache, mesonOwner);
    if (!project) return undefined;
    return { name: project.name, version: project.version, source: recordFile,
      evidence: { archive: record.archive, urlHash: record.urlHash, observedAt: record.observedAt, fields: record.files.map((entry) => ({ path: entry.path, sha256: entry.sha256 })) } };
  } catch { return undefined; }
}

/** Explicit acquisition requires an existing cache outside the real source boundary. */
export async function acquireNativeArchiveIdentity(archiveFile, url, cache, sourceRoot, deadline = Date.now() + 15000) {
  if (!safeUrl(url) || !cache || !sourceRoot) return undefined;
  try {
    if (!separateTrees(cache, sourceRoot)) return undefined;
    const bytes = readArchive(archiveFile);
    const unpacked = bytes && unpackArchive(bytes, sourceRoot, cache, deadline);
    const files = unpacked && await archiveMetadata(unpacked);
    const identity = files && ownedIdentity(files);
    if (!identity) return undefined;
    const digest = hash(bytes);
    const artifactDirectory = join(resolve(cache), "archive-artifacts");
    mkdirSync(artifactDirectory, { recursive: true });
    const artifactInside = relative(realpathSync(cache), realpathSync(artifactDirectory));
    if (artifactInside.startsWith(`..${sep}`) || artifactInside === ".." || isAbsolute(artifactInside)) return undefined;
    const artifactPath = `archive-artifacts/${digest}.archive`;
    try { writeFileSync(join(resolve(cache), artifactPath), bytes, { flag: "wx" }); }
    catch (error) {
      const existing = error.code === "EEXIST" && readArchive(join(resolve(cache), artifactPath), cache);
      if (!existing || hash(existing) !== digest) return undefined;
    }
    const archive = { sha256: digest, bytes: bytes.length, path: artifactPath };
    const record = { schema: 1, url, observedAt: new Date().toISOString(), archive, files: identity.files };
    const directory = join(resolve(cache), "archive-identities");
    mkdirSync(directory, { recursive: true });
    const inside = relative(realpathSync(cache), realpathSync(directory));
    if (inside.startsWith(`..${sep}`) || inside === ".." || isAbsolute(inside)) return undefined;
    const target = join(directory, `${nativeDownloadCacheKey(url)}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(record), { flag: "wx" });
    renameSync(temporary, target);
    return { repository: identity.repository, version: identity.version,
      evidence: { url, archive, observedAt: record.observedAt, fields: identity.fields } };
  } catch { return undefined; }
}

/** Passive scan path: rehash and rederive owned metadata; no network, codec, or source execution. */
export function nativeArchiveIdentityEvidence(url, cache, sourceRoot) {
  if (!safeUrl(url) || !cache || !sourceRoot) return undefined;
  try {
    if (!separateTrees(cache, sourceRoot)) return undefined;
    const path = join(resolve(cache), "archive-identities", `${nativeDownloadCacheKey(url)}.json`);
    const record = JSON.parse(readRegularTextFile(path, MAX_METADATA_BYTES + 128 * 1024, cache) || "null");
    if (record?.schema !== 1 || record.url !== url || !Number.isFinite(Date.parse(record.observedAt)) ||
      !/^[0-9a-f]{64}$/.test(record.archive?.sha256 || "") || !Number.isInteger(record.archive.bytes) ||
      record.archive.bytes <= 0 || record.archive.bytes > MAX_ARCHIVE_BYTES ||
      !Array.isArray(record.files) || !record.files.length || record.files.length > 16) return undefined;
    if (!safeMember(record.archive.path)) return undefined;
    const artifact = readArchive(join(resolve(cache), record.archive.path), cache);
    if (!artifact || artifact.length !== record.archive.bytes || hash(artifact) !== record.archive.sha256) return undefined;
    const paths = new Set();
    let total = 0;
    for (const file of record.files) {
      if (!safeMember(file.path) || paths.has(file.path) || typeof file.content !== "string" ||
        Buffer.byteLength(file.content) > MAX_ENTRY_BYTES || (total += Buffer.byteLength(file.content)) > MAX_METADATA_BYTES ||
        hash(file.content) !== file.sha256) return undefined;
      paths.add(file.path);
    }
    const identity = ownedIdentity(record.files);
    if (!identity) return undefined;
    return { repository: identity.repository, version: identity.version,
      evidence: { url, archive: record.archive, observedAt: record.observedAt, fields: identity.fields } };
  } catch { return undefined; }
}
