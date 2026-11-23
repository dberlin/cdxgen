import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { readRegularTextFile } from "../core/boundedFile.js";
import { cmakeProjectDetails } from "../ecosystems/nativeSourceVersions.js";
import { parseCmakeCommands } from "../parsers/cmakeLists.js";
import { isSafeGitRefName } from "./source.js";
import { sourceRevisionOf } from "./sourceRevision.js";

export function nativeSourceRepository(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) return undefined;
    const path = url.pathname.replace(/\.git$/, "").replace(/\/$/, "");
    if (!/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(path)) return undefined;
    return `https://${url.hostname}${url.hostname === "github.com" ? path.toLowerCase() : path}`;
  } catch { return undefined; }
}

export function nativeSourceCacheKey(repository, selector) {
  return createHash("sha256").update(JSON.stringify([repository, selector])).digest("hex");
}

export function immutableSourceSelector(selector) {
  return isSafeGitRefName(selector) && !["main", "master", "develop", "development", "head", "latest", "trunk"].includes(selector.toLowerCase()) &&
    !selector.startsWith("refs/heads/");
}

/** Normalize only an explicit branch selector, never a Git revision expression. */
export function nativeSourceBranchRef(selector) {
  if (!isSafeGitRefName(selector) || selector.includes("..") || selector.includes("@{") ||
    selector.startsWith("refs/tags/") || /^[0-9a-f]{40,64}$/i.test(selector)) return undefined;
  const name = selector.startsWith("refs/heads/") ? selector.slice("refs/heads/".length) : selector.replace(/^origin\//, "");
  if (!name || name.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))) return undefined;
  return `refs/heads/${name}`;
}

function projectIdentity(directory, expectedFiles, authenticatedFiles) {
  const manifest = join(directory, "CMakeLists.txt");
  const text = authenticatedFiles ? authenticatedFiles.get(manifest) : readRegularTextFile(manifest, 256 * 1024, directory);
  if (text === undefined) return undefined;
  const project = cmakeProjectDetails(manifest, parseCmakeCommands(text), directory, authenticatedFiles ? { authenticatedFiles } : undefined);
  if (expectedFiles && project.versionFiles.some((file) => !expectedFiles.has(relative(directory, file).split("\\").join("/")))) return undefined;
  return { ...project, manifest };
}

/** Passive only: no fetch, checkout, configure, source execution or cache writes. */
export function nativeSourceIdentity(dep, sourceFile, cache, sourceRoot = dirname(sourceFile)) {
  const repository = nativeSourceRepository(dep.gitRepository);
  const selector = dep.gitTag;
  if (dep.sourceDir && !dep.sourceDir.includes("$")) {
    let directory;
    try { directory = realpathSync(resolve(dirname(sourceFile), dep.sourceDir)); } catch { /* The exact object may still be cached. */ }
    const own = directory && projectIdentity(directory);
    const revision = own && sourceRevisionOf(own.manifest);
    // A source-dir override is not evidence for a different declared Git pin.
    if (own && (!repository || revision?.repository && nativeSourceRepository(revision.repository) === repository &&
      /^[0-9a-f]{40,64}$/i.test(selector || "") && revision.version.toLowerCase() === selector.toLowerCase())) {
      return { name: own.name, version: own.version || revision?.version, kind: own.version ? "release" : "source-revision",
        revision: revision?.version, source: own.source || own.manifest, directory };
    }
  }
  if (!cache || !repository || !isSafeGitRefName(selector)) return undefined;
  try {
    const cacheScope = relative(realpathSync(sourceRoot), realpathSync(cache));
    if (!(cacheScope === ".." || cacheScope.startsWith(`..${sep}`) || isAbsolute(cacheScope))) return undefined;
    const recordFile = join(resolve(cache), "selectors", `${nativeSourceCacheKey(repository, selector)}.json`);
    const selectorText = readRegularTextFile(recordFile, 128 * 1024, cache);
    const record = JSON.parse(selectorText || "null");
    if (record?.schema !== 1 || record.repository !== repository || record.selector !== selector ||
      !/^[0-9a-f]{40,64}$/.test(record.revision || "") || !Array.isArray(record.files) || record.files.length > 256) return undefined;
    if (/^[0-9a-f]{40,64}$/i.test(selector) && record.revision !== selector.toLowerCase()) return undefined;
    if (record.selectorKind === "branch-snapshot") {
      if (record.floatingRef !== nativeSourceBranchRef(selector) ||
        !Number.isFinite(Date.parse(record.observedAt))) return undefined;
    } else if (!immutableSourceSelector(selector) ||
      record.selectorKind !== (/^[0-9a-f]{40,64}$/i.test(selector) ? "commit" : "tag")) return undefined;
    const directory = join(resolve(cache), "objects", nativeSourceCacheKey(repository, record.revision));
    const objectScope = relative(realpathSync(cache), realpathSync(directory));
    if (objectScope === ".." || objectScope.startsWith(`..${sep}`) || isAbsolute(objectScope)) return undefined;
    const files = new Set();
    const sourceTexts = new Map();
    let bytes = 0;
    for (const entry of record.files) {
      if (typeof entry.path !== "string" || entry.path.startsWith("/") || entry.path.split(/[\\/]/).some((part) => ["..", ".git", ""].includes(part)) ||
        !/^[0-9a-f]{64}$/.test(entry.sha256 || "") || files.has(entry.path)) return undefined;
      const text = readRegularTextFile(join(directory, entry.path), 256 * 1024, directory);
      if (text === undefined || (bytes += Buffer.byteLength(text)) > 8 * 1024 * 1024 || createHash("sha256").update(text).digest("hex") !== entry.sha256) return undefined;
      files.add(entry.path);
      sourceTexts.set(join(directory, entry.path), text);
    }
    const own = files.has("CMakeLists.txt") && projectIdentity(directory, files, sourceTexts);
    return { version: own?.version || record.revision, kind: own?.version ? "release" : "source-revision",
      revision: record.revision, source: own?.source || recordFile, directory, selector, repository,
      sourceTexts, manifestFiles: [...sourceTexts.keys()],
      selectorEvidence: { path: recordFile, sha256: createHash("sha256").update(selectorText).digest("hex"), repository, selector, revision: record.revision },
      ...(record.selectorKind === "branch-snapshot" ? { observedAt: record.observedAt, floatingRef: record.floatingRef } : {}) };
  } catch { return undefined; }
}
