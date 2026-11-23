import { createHash } from "node:crypto";
import { closeSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { openRegularFile, readRegularTextFile } from "../core/boundedFile.js";

/** URL-keyed metadata is acquired explicitly; ordinary scans never fetch it. */
export function nativeDownloadCacheKey(url) {
  return createHash("sha256").update(JSON.stringify([url])).digest("hex");
}

function safeUrl(value) {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash || url.search) return undefined;
    return url;
  } catch { return undefined; }
}

function concreteVersion(value) {
  return typeof value === "string" && value.length <= 256 && !/[\s$\x00-\x1f]/.test(value) &&
    /\d/.test(value) && !/^(?:latest|main|master|head|trunk|develop)$/i.test(value);
}

/**
 * Read externally acquired download identity, including a concrete latest
 * redirect and inspected artifact metadata. The SHA256 identifies the acquired
 * bytes; it is never promoted into an invented software release version.
 */
export function nativeDownloadIdentity(url, cache, sourceRoot, expectedHash) {
  if (!cache || !sourceRoot || !safeUrl(url)) return undefined;
  try {
    const outside = relative(realpathSync(sourceRoot), realpathSync(cache));
    if (!(outside === ".." || outside.startsWith(`..${sep}`) || isAbsolute(outside))) return undefined;
    const source = join(resolve(cache), "downloads", `${nativeDownloadCacheKey(url)}.json`);
    const record = JSON.parse(readRegularTextFile(source, 128 * 1024, cache) || "null");
    const resolved = safeUrl(record?.resolvedUrl);
    if (record?.schema !== 1 || record.url !== url || !resolved ||
      !/^[0-9a-f]{64}$/.test(record.sha256 || "") || !Number.isFinite(Date.parse(record.observedAt)) ||
      typeof record.name !== "string" || !record.name.trim() || record.name.length > 256 || /[\x00-\x1f]/.test(record.name) ||
      !["application", "library", "data"].includes(record.type) ||
      !Array.isArray(record.evidence) || !record.evidence.length || record.evidence.length > 64 ||
      record.evidence.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > 4096)) return undefined;
    if (record.artifact !== `download-artifacts/${record.sha256}`) return undefined;
    const opened = openRegularFile(join(cache, record.artifact), cache);
    if (!opened) return undefined;
    const algorithms = { MD5: "md5", SHA1: "sha1", SHA224: "sha224", SHA256: "sha256", SHA384: "sha384", SHA512: "sha512",
      SHA3_256: "sha3-256", SHA3_384: "sha3-384", SHA3_512: "sha3-512" };
    try {
      if (opened.size <= 0 || opened.size > 300 * 1024 * 1024 || opened.size !== record.bytes) return undefined;
      const pin = expectedHash && /^([A-Za-z0-9_]+)=([a-f0-9]+)$/i.exec(expectedHash);
      const algorithm = pin?.[1].toUpperCase();
      const expected = pin?.[2].toLowerCase();
      if (expectedHash && (!algorithms[algorithm] || algorithm === "SHA256" && expected !== record.sha256)) return undefined;
      const sha = createHash("sha256");
      const declared = algorithm && algorithm !== "SHA256" && createHash(algorithms[algorithm]);
      const buffer = Buffer.alloc(Math.min(opened.size, 128 * 1024));
      let offset = 0;
      while (offset < opened.size) {
        const count = readSync(opened.fd, buffer, 0, Math.min(buffer.length, opened.size - offset), offset);
        if (!count) return undefined;
        sha.update(buffer.subarray(0, count)); declared && declared.update(buffer.subarray(0, count)); offset += count;
      }
      if (sha.digest("hex") !== record.sha256 || declared && declared.digest("hex") !== expected) return undefined;
    } finally { closeSync(opened.fd); }
    let version;
    if (record.releaseTag !== undefined) {
      if (!concreteVersion(record.releaseTag)) return undefined;
      // A release claim must agree with the resolved containing release URL,
      // not with digits opportunistically extracted from an installer name.
      const match = resolved.hostname === "github.com" && resolved.pathname.match(/^\/[^/]+\/[^/]+\/releases\/download\/([^/]+)\//);
      if (!match || decodeURIComponent(match[1]) !== record.releaseTag) return undefined;
      version = record.releaseTag;
    }
    if (record.artifactVersion !== undefined && (!concreteVersion(record.artifactVersion) ||
      typeof record.artifactVersionSource !== "string" || !record.artifactVersionSource.trim())) return undefined;
    if (record.type !== "data") {
      // Package metadata describes the artifact itself; a containing release
      // may group independently versioned installers or binary packages.
      version = record.artifactVersion || version;
      if (!version) return undefined;
    } else version = undefined;
    return { name: record.name, type: record.type, version, kind: record.type === "data" ? "data-artifact" : "release-artifact",
      url, resolvedUrl: record.resolvedUrl, observedAt: record.observedAt, sha256: record.sha256, source,
      releaseTag: record.releaseTag, artifactVersion: record.artifactVersion, artifactVersionSource: record.artifactVersionSource,
      evidence: record.evidence };
  } catch { return undefined; }
}
