/**
 * CMake build-context resolver: the layer-3 bridge between the pure parsers
 * (`lib/parsers/cmakeCache.js`, `lib/parsers/gitmodules.js`) and the C/C++ BOM
 * lifecycle in `lib/cli/nativeBom.js`.
 *
 * This module owns every subprocess invocation and every filesystem read
 * outside the scan root. It reads `CMakeCache.txt`, `.gitmodules`, the
 * FetchContent gitclone scripts, and `git submodule status` output, then
 * returns repo-relative facts the lifecycle can attach to components.
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import {
  DEBUG_MODE,
  isSecureMode,
  recordSensitiveFileRead,
} from "../core/activity.js";
import { readRegularTextFile } from "../core/boundedFile.js";
import { safeExistsSync } from "../core/fs.js";
import { cmakeBuildDirCandidates } from "../inventory/cmakeBuildDirs.js";
import { nativeComponentInstanceRef } from "../inventory/depsUtils.js";
import {
  execGitCommand,
  execGitMetadata,
  GIT_COMMAND,
  getOriginUrl,
} from "../inventory/envcontext.js";
import { applyPurl, tryBuildPurl } from "../inventory/purl.js";
import {
  parseCmakeCache,
  resolveCmakeCacheFacts,
} from "../parsers/cmakeCache.js";
import {
  parseGitmodules,
  parseGitRemoteUrl,
  resolveSubmoduleUrl,
  submodulePurlCoordinates,
} from "../parsers/gitmodules.js";

/**
 * Make an absolute build-machine path repo-relative. Returns `null` when the
 * path does not lie under the scan root (so the caller can drop it rather than
 * emit a verbatim build-machine path).
 *
 * @param {string} absPath Absolute path from CMakeCache
 * @param {string} scanRoot The project scan root
 * @returns {string|null} Repo-relative path using POSIX separators, or null
 */
function toRepoRelative(absPath, scanRoot) {
  if (!absPath || !scanRoot) {
    return null;
  }
  const rel = relative(resolve(scanRoot), resolve(absPath));
  if (rel.startsWith("..")) {
    return null;
  }
  return rel.split(sep).join("/");
}

/**
 * Detect the build directory that holds a `CMakeCache.txt`.
 *
 * An explicit `--cmake-cache <path>` option (passed via `options.cmakeCache`)
 * takes precedence and skips autodetection. Otherwise the project's build
 * directories are searched in order: those its CMake presets configure, then
 * the conventional `build`, `out`, `builddir` and `cmake-build-` directories
 * (see `cmakeBuildDirCandidates`).
 *
 * @param {string} path Project scan root
 * @param {Object} options CLI options; `options.cmakeCache` is an explicit override
 * @returns {{ cacheFile: string, buildDir: string } | null}
 */
export function detectCmakeBuildDir(path, options) {
  if (options?.cmakeCache) {
    const cacheFile = resolve(options.cmakeCache);
    if (safeExistsSync(cacheFile)) {
      recordSensitiveFileRead(cacheFile, {
        label: "CMakeCache.txt (explicit override)",
      });
      return { cacheFile, buildDir: resolve(dirname(cacheFile)) };
    }
    return null;
  }
  for (const buildDir of cmakeBuildDirCandidates(path, options)) {
    const cacheFile = join(buildDir, "CMakeCache.txt");
    if (safeExistsSync(cacheFile)) {
      recordSensitiveFileRead(cacheFile, {
        label: "CMakeCache.txt (autodetected)",
      });
      return { cacheFile, buildDir };
    }
  }
  return null;
}

/**
 * Read and resolve the CMakeCache facts for a project.
 *
 * @param {string} path Project scan root
 * @param {Object} options CLI options
 * @returns {{ rootProject: {name?:string, version?:string}|null, projects: Map, findPackages: Map, fetchContentBase?: string, buildDir?: string } | null}
 */
export function resolveCmakeCache(path, options) {
  const detected = detectCmakeBuildDir(path, options);
  if (!detected) {
    return null;
  }
  let text;
  try {
    text = readFileSync(detected.cacheFile, "utf-8");
  } catch (err) {
    if (DEBUG_MODE) {
      console.warn(
        `Unable to read CMakeCache at ${detected.cacheFile}: ${err.message}`,
      );
    }
    return null;
  }
  const facts = resolveCmakeCacheFacts(parseCmakeCache(text));
  return {
    ...facts,
    buildDir: detected.buildDir,
  };
}

/**
 * Read the FetchContent gitclone script and extract the repository URL and tag.
 *
 * The script lives at
 * `<build>/_deps/<name>-subbuild/<name>-populate-prefix/tmp/<name>-populate-gitclone.cmake`
 * and contains the literal `clone ... "<GIT_REPOSITORY>" "<name>-src"` and
 * `checkout "<GIT_TAG>" --` lines. No git invocation is needed.
 *
 * @param {string} buildDir Build directory
 * @param {string} depName FetchContent dep name (lowercase)
 * @returns {{ url: string|null, tag: string|null }}
 */
export function readFetchContentGitclone(buildDir, depName) {
  // `depName` reaches here from a CMakeCache key and is interpolated into a
  // path, so a separator or a `..` segment in it would read outside the build
  // directory. A FetchContent dependency name is a CMake identifier; anything
  // else is refused rather than resolved.
  if (
    !depName ||
    !/^[A-Za-z0-9_.+-]+$/.test(depName) ||
    depName.includes("..")
  ) {
    return { url: null, tag: null };
  }
  const scriptPath = join(
    buildDir,
    "_deps",
    `${depName}-subbuild`,
    `${depName}-populate-prefix`,
    "tmp",
    `${depName}-populate-gitclone.cmake`,
  );
  if (!safeExistsSync(scriptPath)) {
    return { url: null, tag: null };
  }
  recordSensitiveFileRead(scriptPath, {
    label: "FetchContent gitclone script",
  });
  let text;
  try {
    text = readFileSync(scriptPath, "utf-8");
  } catch {
    return { url: null, tag: null };
  }
  return parseGitcloneScript(text);
}

/**
 * Parse a gitclone.cmake script for the GIT_REPOSITORY and GIT_TAG literals.
 *
 * The clone line carries several quoted arguments (`--config "..."`, the
 * repository URL, and the source dir), so the URL is identified as the quoted
 * token that parses as a git remote rather than the first quoted token.
 *
 * @param {string} text Script contents
 * @returns {{ url: string|null, tag: string|null }}
 */
export function parseGitcloneScript(text) {
  if (!text || typeof text !== "string") {
    return { url: null, tag: null };
  }
  let url = null;
  let tag = null;
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (!url && line.startsWith("clone")) {
      const quoted = line.matchAll(/"([^"]+)"/g);
      for (const match of quoted) {
        const candidate = match[1];
        if (parseGitRemoteUrl(candidate)) {
          url = candidate;
          break;
        }
      }
    }
    if (!tag && line.startsWith("checkout")) {
      const quoted = line.matchAll(/"([^"]+)"/g);
      for (const match of quoted) {
        tag = match[1];
        break;
      }
    }
  }
  return { url, tag };
}

/**
 * Collect submodule pin data via a single `git submodule status --recursive`.
 *
 * Each output line is `<prefix><sha> <path> (<describe>)` where prefix is
 * ` ` (ok), `-` (uninitialised), `+` (out of sync), `U` (conflict).
 * Uninitialised submodules (the normal case for `--depth 1` clones and CI)
 * have no populated working tree, so `describe` is absent; the version
 * degrades to the commit SHA.
 *
 * Missing status entries are checked against gitlinks by resolveCmakeContext.
 *
 * @param {string} path Repo directory
 * @returns {Map<string, { sha: string, describe: string|null, prefix: string }>} Path → pin data
 */
export function collectSubmoduleStatus(path) {
  const result = new Map();
  if (isSecureMode) {
    return result;
  }
  const output = execGitCommand(path, ["submodule", "status", "--recursive"]);
  if (output) {
    for (const line of output.split("\n")) {
      const parsed = parseSubmoduleStatusLine(line);
      if (parsed) {
        result.set(parsed.path, parsed);
      }
    }
  }
  return result;
}

/**
 * Parse a single `git submodule status` output line.
 *
 * The status prefix is optional here. `git` writes a space for a submodule that
 * matches the recorded commit, and the command output arrives trimmed, so that
 * space is absent from the first line. The prefixes that carry meaning — `-`
 * uninitialised, `+` out of sync, `U` conflicted — are not whitespace and
 * always survive, so a line that opens with the SHA is in sync.
 *
 * @param {string} line Raw status line
 * @returns {{ sha: string, describe: string|null, prefix: string, path: string } | null}
 */
export function parseSubmoduleStatusLine(line) {
  if (!line) {
    return null;
  }
  const hasPrefix = ["-", "+", "U", " "].includes(line[0]);
  const prefix = hasPrefix ? line[0] : " ";
  const rest = (hasPrefix ? line.slice(1) : line).trim();
  const spaceIdx = rest.indexOf(" ");
  if (spaceIdx === -1) {
    return null;
  }
  const sha = rest.slice(0, spaceIdx).trim();
  const remainder = rest.slice(spaceIdx + 1).trim();
  let subPath;
  let describe = null;
  const parenIdx = remainder.lastIndexOf("(");
  if (parenIdx !== -1 && remainder.endsWith(")")) {
    subPath = remainder.slice(0, parenIdx).trim();
    describe = remainder.slice(parenIdx + 1, -1).trim() || null;
  } else {
    subPath = remainder;
  }
  if (!sha || !subPath) {
    return null;
  }
  return { sha, describe, prefix, path: subPath };
}

/**
 * Build the complete CMake/submodule resolution for a project.
 *
 * Combines CMakeCache facts, `.gitmodules`, submodule pins, and FetchContent
 * gitclone scripts into a single boundary set and component list the C/C++
 * lifecycle can consume.
 *
 * @param {string} path Project scan root
 * @param {Object} options CLI options
 * @returns {{ rootProject: {name?:string, version?:string}|null, findPackages: Map<string,string>, submodules: Array, fetchDeps: Array, boundaries: Map<string,{kind:string,version?:string,url?:string,name:string}> }}
 */
export function resolveCmakeContext(path, options) {
  const cacheFacts = resolveCmakeCache(path, options);
  const rootProject = cacheFacts?.rootProject || null;
  const findPackages = cacheFacts?.findPackages || new Map();
  const buildDir = cacheFacts?.buildDir;

  const boundaries = new Map();
  const fetchDeps = [];
  const submodules = [];
  const submoduleDiagnostics = [];

  if (cacheFacts?.projects) {
    for (const [name, project] of cacheFacts.projects) {
      if (project.kind === "fetch" && project.sourceDir) {
        const relDir = toRepoRelative(project.sourceDir, path);
        const gitclone = buildDir
          ? readFetchContentGitclone(buildDir, name)
          : { url: null, tag: null };
        const tag = gitclone.tag || project.version || null;
        const url = gitclone.url || null;
        const entry = {
          kind: "fetch",
          name,
          version: tag,
          url,
          sourceDir: relDir,
        };
        fetchDeps.push(entry);
        if (relDir) {
          boundaries.set(relDir, entry);
        }
        continue;
      }
      if (project.kind === "internal" && project.sourceDir) {
        const relDir = toRepoRelative(project.sourceDir, path);
        if (relDir && relDir !== ".") {
          boundaries.set(relDir, {
            kind: "internal",
            name,
            version: project.version,
          });
        }
      }
    }
  }

  const gitmodulesFile = findGitmodules(path);
  let originUrl = null;
  // Only ask git about a directory that is a working tree. A container scan
  // walks every directory of an exploded image, none of which are checkouts,
  // and each call is a process spawn.
  if (safeExistsSync(join(path, ".git"))) {
    try {
      originUrl = getOriginUrl(path);
    } catch {
      originUrl = null;
    }
  }
  if (gitmodulesFile) {
    const statusMap = collectSubmoduleStatus(path);
    const queue = [{ dir: resolve(path), origin: originUrl }];
    const seen = new Set();
    const realRoot = realpathSync(path);
    // Git's recursive status paths are relative to the superproject. Read each
    // corresponding .gitmodules in its own URL scope instead of discarding all
    // nested pins after collecting them.
    for (let cursor = 0; cursor < queue.length && seen.size < 4096; cursor++) {
      const owner = queue[cursor];
      const text = readRegularTextFile(join(owner.dir, ".gitmodules"), 256 * 1024);
      if (text === undefined) continue;
      const declaredSubmodules = parseGitmodules(text);
      let ownerGitlinks;
      const gitlinkFor = (subPath) => {
        if (ownerGitlinks === undefined) {
          ownerGitlinks = new Map();
          if (!isSecureMode) {
            const paths = declaredSubmodules.map((sub) => sub.path).filter((value) => value && toRepoRelative(resolve(owner.dir, value), path));
            for (const args of [
              ["--literal-pathspecs", "ls-files", "--stage", "-z", "--", ...paths],
              ["--literal-pathspecs", "ls-tree", "-z", "HEAD", "--", ...paths],
            ]) {
              const result = execGitMetadata(owner.dir, args);
              if (result.status !== 0) continue;
              for (const record of String(result.stdout || "").split("\0")) {
                const match = record.match(/^160000 (?:commit )?([0-9a-f]{40,64})(?: [0-3])?\t(.+)$/);
                if (match && !ownerGitlinks.has(match[2])) ownerGitlinks.set(match[2], match[1]);
              }
            }
          }
        }
        return ownerGitlinks.get(subPath);
      };
      for (const sub of declaredSubmodules) {
        if (!sub.path) continue;
        const dir = resolve(owner.dir, sub.path);
        const relDir = toRepoRelative(dir, path);
        if (!relDir || seen.has(relDir)) continue;
        seen.add(relDir);
        const status = statusMap.get(relDir);
        const sha = /^[0-9a-f]{40,64}$/i.test(status?.sha || "") ? status.sha : gitlinkFor(sub.path) || null;
        const resolvedUrl = sub.url ? resolveSubmoduleUrl(sub.url, owner.origin) : null;
        let hasCheckout = false;
        try {
          const scope = relative(realRoot, realpathSync(dir));
          hasCheckout = scope !== ".." && !scope.startsWith(`..${sep}`) && statSync(dir).isDirectory();
        } catch { /* Deinitialized submodules still have a gitlink. */ }
        if (!sha && !hasCheckout) {
          submoduleDiagnostics.push({
            name: sub.name, path: relDir, url: resolvedUrl,
            source: relative(resolve(path), join(owner.dir, ".gitmodules")).split("\\").join("/"),
            reason: "no-gitlink-or-checkout",
          });
          continue;
        }
        const entry = {
          kind: "submodule", name: basename(sub.path), path: relDir,
          version: sha, sha, describe: status?.describe || null,
          url: resolvedUrl, uninitialised: status?.prefix === "-" || !hasCheckout,
        };
        submodules.push(entry);
        boundaries.set(relDir, entry);
        if (!entry.uninitialised && safeExistsSync(join(dir, ".gitmodules"))) {
          try {
            if (!relative(realRoot, realpathSync(dir)).startsWith("..")) {
              queue.push({ dir, origin: resolvedUrl });
            }
          } catch { /* An absent/unreadable checkout still has its declared pin. */ }
        }
      }
    }
  }

  return {
    rootProject,
    findPackages,
    submodules,
    submoduleDiagnostics,
    fetchDeps,
    boundaries,
  };
}

/**
 * Locate `.gitmodules` in the project root.
 *
 * @param {string} path Project scan root
 * @returns {string|null}
 */
function findGitmodules(path) {
  const candidate = join(path, ".gitmodules");
  if (safeExistsSync(candidate)) {
    return candidate;
  }
  return null;
}

/**
 * Build a purl string from resolved submodule/fetch coordinates, returning
 * null when the parts do not form a valid purl.
 *
 * @param {string} resolvedUrl Absolute git URL
 * @param {string} [version] Resolved version
 * @returns {string|null}
 */
export function buildDependentPurl(resolvedUrl, version) {
  const coords = submodulePurlCoordinates(resolvedUrl, version);
  if (!coords) {
    return null;
  }
  return tryBuildPurl({
    type: coords.type,
    namespace: coords.namespace,
    name: coords.name,
    version: coords.version,
    qualifiers: coords.qualifiers,
  });
}

/**
 * Order two `find_package` version requirements.
 *
 * The arguments are CMake version requirements such as `1.54` or `3.0.1`, which
 * are dotted numbers rather than semver, so they are compared segment by
 * segment. A segment that is not a number orders below every number, which puts
 * git describe output and similar strings behind a plain version.
 *
 * @param {string} left First version
 * @param {string} right Second version
 * @returns {number} Negative when `left` is lower, positive when it is higher
 */
function compareCmakeVersions(left, right) {
  const leftParts = String(left).split(".");
  const rightParts = String(right).split(".");
  for (let i = 0; i < Math.max(leftParts.length, rightParts.length); i++) {
    const leftNumber = Number.parseInt(leftParts[i] ?? "", 10);
    const rightNumber = Number.parseInt(rightParts[i] ?? "", 10);
    const leftValid = Number.isFinite(leftNumber);
    const rightValid = Number.isFinite(rightNumber);
    if (!leftValid && !rightValid) {
      continue;
    }
    if (!leftValid) {
      return -1;
    }
    if (!rightValid) {
      return 1;
    }
    if (leftNumber !== rightNumber) {
      return leftNumber - rightNumber;
    }
  }
  return 0;
}

/**
 * Fold the identity methods of a discarded duplicate into the retained one.
 *
 * Each CMake-like file records itself as a `Filename` method, so a package that
 * several files declare keeps one method per file naming them all.
 *
 * @param {Object} target Component being retained
 * @param {Object} source Component being collapsed away
 */
function mergeEvidence(target, source) {
  const sourceIdentity = source?.evidence?.identity;
  const incoming = (
    Array.isArray(sourceIdentity) ? sourceIdentity[0] : sourceIdentity
  )?.methods;
  if (!incoming?.length) {
    return;
  }
  target.evidence = target.evidence || {};
  target.evidence.identity = target.evidence.identity || { field: "purl" };
  const identity = Array.isArray(target.evidence.identity)
    ? target.evidence.identity[0]
    : target.evidence.identity;
  if (!identity) {
    return;
  }
  const methods = (identity.methods = identity.methods || []);
  for (const method of incoming) {
    if (!methods.some((existing) => existing.value === method.value)) {
      methods.push(method);
    }
  }
}

/**
 * Collapse repeated, unresolved CMake package requirements, preserving their
 * provenance. A minimum, even the highest minimum across several consumers,
 * is not a resolved version. Exact source/cache/fetch identities remain
 * separate; different vendored releases must not be collapsed by name.
 *
 * @param {Object[]} pkgList Components scraped from CMake-like files
 * @returns {Object[]} Components with one entry per package name, in first-seen order
 */
export function collapseCmakeVersions(pkgList) {
  if (!Array.isArray(pkgList) || pkgList.length < 2) {
    return Array.isArray(pkgList) ? pkgList : [];
  }
  const collapsed = [];
  const byName = new Map();
  const requirements = new Map();
  for (const pkg of pkgList) {
    const isResolvedDep = pkg?.properties?.some(
      (prop) => prop.name === "cdx:cmake:depKind",
    );
    if (!pkg?.name || isResolvedDep || pkg.version) {
      collapsed.push(pkg);
      continue;
    }
    const scope = cmakeProperty(pkg, "cdx:build:consumerScope") || "";
    const key = `${pkg.group || ""}/${pkg.name.toLowerCase()}/${scope}`;
    const existing = byName.get(key);
    const declared = (pkg.properties || [])
      .filter((p) => p.name === "cdx:cmake:versionRequirements")
      .flatMap((p) => p.value.split("|"));
    if (!existing) {
      byName.set(key, pkg);
      requirements.set(key, new Set(declared));
      collapsed.push(pkg);
      continue;
    }
    mergeEvidence(existing, pkg);
    for (const version of declared) requirements.get(key).add(version);
    existing.properties ||= [];
    for (const prop of pkg.properties || []) {
      if (prop.name !== "cdx:cmake:versionRequirements" &&
        !existing.properties.some((p) => p.name === prop.name && p.value === prop.value)) {
        existing.properties.push(prop);
      }
    }
  }
  for (const [key, pkg] of byName) {
    const versions = Array.from(requirements.get(key)).sort(
      compareCmakeVersions,
    );
    if (!versions.length) {
      continue;
    }
    pkg.properties = (pkg.properties || []).filter((p) => p.name !== "cdx:cmake:versionRequirements");
    pkg.properties.push({
      name: "cdx:cmake:versionRequirements",
      value: versions.join("|"),
    });
  }
  return collapsed;
}

/** `cdx:cmake:depKind` values for dependencies downloaded at configure time. */
const FETCHED_KINDS = new Set(["fetch", "cpm", "external-project"]);

function cmakeProperty(pkg, name) {
  return pkg?.properties?.find((prop) => prop.name === name)?.value;
}

/**
 * Deduplicate identical configure-time source pins, preserving their filename
 * evidence. A fetched declaration does not select a provider for same-name
 * requirements in unrelated files or for conditional fallback consumers.
 *
 * @param {Object[]} pkgList Components scraped from CMake-like files
 * @returns {Object[]} The components, in first-seen order
 */
export function preferFetchedCmakeDependencies(pkgList) {
  if (!Array.isArray(pkgList)) {
    return [];
  }
  const fetched = new Map();
  for (const pkg of pkgList) {
    if (!FETCHED_KINDS.has(cmakeProperty(pkg, "cdx:cmake:depKind"))) continue;
    const identity = nativeComponentInstanceRef(pkg) || pkg.purl || pkg["bom-ref"];
    if (!identity) continue;
    const existing = fetched.get(identity);
    if (!existing) fetched.set(identity, pkg);
    else {
      mergeEvidence(existing, pkg);
      existing.properties ||= [];
      for (const prop of pkg.properties || []) {
        if (!existing.properties.some((p) => p.name === prop.name && p.value === prop.value)) existing.properties.push(prop);
      }
    }
  }
  return pkgList.filter((pkg) => {
    const identity = nativeComponentInstanceRef(pkg) || pkg.purl || pkg["bom-ref"];
    if (!identity || !FETCHED_KINDS.has(cmakeProperty(pkg, "cdx:cmake:depKind"))) return true;
    return fetched.get(identity) === pkg;
  });
}

/**
 * Drop the components scraped from CMake files for a dependency the build tree
 * has resolved: the gitclone script names the repository and tag that were
 * really checked out, so its component replaces the declared one.
 *
 * @param {Object[]} pkgList Components collected so far
 * @param {string} name Name of the resolved dependency
 * @returns {Object[]} The components without the scraped entries for `name`
 */
export function withoutScrapedFetchDependency(pkgList, name) {
  const key = name?.toLowerCase();
  return pkgList.filter(
    (pkg) =>
      !(
        key &&
        pkg?.name?.toLowerCase() === key &&
        cmakeProperty(pkg, "cdx:cmake:resolvedVia") === "cmake-lists" &&
        FETCHED_KINDS.has(cmakeProperty(pkg, "cdx:cmake:depKind"))
      ),
  );
}

export { GIT_COMMAND, toRepoRelative };
