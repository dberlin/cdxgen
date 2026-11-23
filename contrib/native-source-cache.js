import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { readRegularTextFile } from "../lib/core/boundedFile.js";
import { cmakeProjectDetails } from "../lib/ecosystems/nativeSourceVersions.js";
import { immutableSourceSelector, nativeEffectiveSourceSelector, nativeSourceBranchRef, nativeSourceCacheKey, nativeSourceIdentity, nativeSourceRepository } from "../lib/inventory/nativeSourceIdentity.js";
import { sourceRootOf } from "../lib/inventory/sourceRevision.js";
import { cmakeFetchDependencies, parseCmakeCommands } from "../lib/parsers/cmakeLists.js";
import { nativeAcquisitionRemaining, nativeAcquisitionUrl } from "./native-acquisition-policy.js";
import { nativeProviderCacheWriter } from "./native-provider-cache.js";

function git(directory, args, network = false, deadline = Date.now() + 120000) {
  const bare = existsSync(join(directory, "HEAD"));
  const timeout = nativeAcquisitionRemaining(deadline, 120000);
  return execFileSync("/usr/bin/git", ["--no-pager", "--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
    "-c", "safe.bareRepository=explicit", "-c", "credential.helper=", "-c", "http.extraHeader=",
    "-c", "http.proxy=", "-c", "http.followRedirects=false", "-c", "submodule.recurse=false",
    "-c", "protocol.file.allow=never", "-c", "protocol.ext.allow=never",
    ...(bare ? ["--git-dir", directory] : ["-C", directory]), ...args], {
    encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024,
    env: { PATH: "/usr/bin:/bin", HOME: directory, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: network ? "https" : "cdxgen-no-network" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function requireExternalCache(source, cache) {
  let existing = resolve(cache);
  const pending = [];
  while (!existsSync(existing) && dirname(existing) !== existing) {
    pending.unshift(basename(existing));
    existing = dirname(existing);
  }
  const destination = resolve(realpathSync(existing), ...pending);
  const path = relative(realpathSync(source), destination);
  if (!(path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))) throw new Error("The cache must be outside every source/object repository");
}


/** Read Git blobs, never a checkout, filters, hooks, submodules or project code. */
export function snapshotNativeSourceObject({ repository: input, selector, revision, gitDir, cache, floatingRef, capturedRemoteHead, url, deadline = Date.now() + 300000 }) {
  const repository = nativeSourceRepository(input);
  const bootstrap = rawCmakeBootstrapMember(url, repository, selector);
  requireExternalCache(gitDir, cache);
  const objectRoot = realpathSync(gitDir);
  if (basename(objectRoot) === ".git") requireExternalCache(dirname(objectRoot), cache);
  if (!repository || !(floatingRef ? floatingRef === (selector === "HEAD" ? "HEAD" : nativeSourceBranchRef(selector)) : immutableSourceSelector(selector)) ||
    !/^[0-9a-f]{40,64}$/i.test(revision || "")) throw new Error("An explicit repository and immutable object/tag or captured branch are required");
  revision = revision.toLowerCase();
  const selected = floatingRef === "HEAD" && capturedRemoteHead ? "refs/cdxgen/remote-head^{commit}" :
    floatingRef ? `${floatingRef}^{commit}` : /^[0-9a-f]{40,64}$/i.test(selector) ? selector : `${selector.startsWith("refs/tags/") ? selector : `refs/tags/${selector}`}^{commit}`;
  if (git(gitDir, ["rev-parse", "--verify", selected], false, deadline).trim().toLowerCase() !== revision) throw new Error("The requested selector does not name the supplied object");
  if (git(gitDir, ["cat-file", "-t", revision], false, deadline).trim() !== "commit") throw new Error("Source object is not a commit");
  const directory = join(resolve(cache), "objects", nativeSourceCacheKey(repository, revision));
  let tree;
  try { tree = git(gitDir, ["ls-tree", "-r", "-z", revision], false, deadline); }
  catch (error) {
    // The commit was already verified above. An oversized metadata listing
    // cannot prove a release, but does not erase that immutable source identity.
    if (error.code !== "ENOBUFS") throw error;
  }
  const entries = (tree || "").split("\0").filter(Boolean).map((entry) => {
    const tab = entry.indexOf("\t");
    const [mode, type, object] = entry.slice(0, tab).split(" ");
    return { mode, type, object, path: entry.slice(tab + 1) };
  }).filter((entry) => (entry.mode === "100644" || entry.mode === "100755" && entry.path === bootstrap) && entry.type === "blob" &&
    !entry.path.split("/").some((part) => ["..", ".git", ""].includes(part)) &&
    (entry.path === "CMakeLists.txt" || entry.path.endsWith(".cmake") || /(?:^|\/)[^/]*version[^/]*\.(?:h|hpp|json|txt|cmake|mk)$/i.test(entry.path) || /(?:^|\/)VERSION(?:\.txt)?$/.test(entry.path)));
  entries.sort((a, b) => (a.path === "CMakeLists.txt" ? -1 : b.path === "CMakeLists.txt" ? 1 : a.path.localeCompare(b.path)));
  // Incomplete metadata is not a release proof. A large object can still be
  // represented by its full immutable commit, with an empty metadata snapshot.
  const files = [];
  const content = [];
  let bytes = 0;
  if (entries.length <= 256) for (const entry of entries) {
    const size = Number(git(gitDir, ["cat-file", "-s", entry.object], false, deadline).trim());
    if (!Number.isSafeInteger(size) || size < 0 || size > 256 * 1024 || bytes + size > 8 * 1024 * 1024) { files.length = 0; content.length = 0; break; }
    const text = git(gitDir, ["cat-file", "blob", entry.object], false, deadline);
    if (Buffer.byteLength(text) !== size) { files.length = 0; content.length = 0; break; }
    bytes += size;
    files.push({ path: entry.path, sha256: createHash("sha256").update(text).digest("hex") });
    content.push(text);
  }
  const writer = nativeProviderCacheWriter(cache, gitDir);
  writer.mkdir("objects");
  const temporary = mkdtempSync(join(resolve(cache), "objects", ".source-"));
  try {
    for (const [index, entry] of files.entries()) {
      const file = join(temporary, entry.path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content[index], { flag: "wx" });
    }
    // A retry may repair files only from this same authenticated Git object.
    try { renameSync(temporary, directory); } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
      const objectPath = `objects/${nativeSourceCacheKey(repository, revision)}`;
      writer.mkdir(objectPath);
      for (const [index, entry] of files.entries()) {
        nativeAcquisitionRemaining(deadline);
        if (readRegularTextFile(join(directory, entry.path), 256 * 1024, directory) !== content[index]) {
          writer.write(`${objectPath}/${entry.path}`, content[index]);
        }
      }
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  const record = { schema: 1, repository, selector,
    selectorKind: floatingRef ? "branch-snapshot" : /^[0-9a-f]{40,64}$/i.test(selector) ? "commit" : "tag", revision, files,
    ...(floatingRef ? { floatingRef, observedAt: new Date().toISOString() } : {}),
    ...(tree === undefined ? { metadataOmitted: "tree-listing-limit" } : {}) };
  writer.mkdir("selectors");
  writer.write(`selectors/${nativeSourceCacheKey(repository, selector)}.json`, `${JSON.stringify(record, null, 2)}\n`);
  return { ...record, directory };
}

function rawCmakeBootstrapMember(value, repository, selector) {
  if (!repository || !selector || !value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "raw.githubusercontent.com" || url.port ||
      url.username || url.password || url.search || url.hash) return undefined;
    const [owner, repo, rawSelector, ...member] = url.pathname.split("/").slice(1);
    if (nativeSourceRepository(`https://github.com/${owner}/${repo}`) !== repository ||
      decodeURIComponent(rawSelector) !== selector || !member.length ||
      member.some((part) => !/^[A-Za-z0-9_.+-]+$/.test(part) || part === "." || part === "..")) return undefined;
    const script = member.join("/");
    return script.endsWith(".cmake") ? script : undefined;
  } catch { return undefined; }
}

/** A raw CMake bootstrapping script may establish a checked-in config export
 * only from the same frozen repo/selector and a literal root install rule. */
export function cacheNativeSourceConfigProvider({ declaration, sourceFile, sourceRoot, cache, requestedName }) {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/.test(requestedName || "")) return undefined;
  const repository = nativeSourceRepository(declaration.gitRepository);
  const selector = nativeEffectiveSourceSelector(declaration);
  const script = rawCmakeBootstrapMember(declaration.url, repository, selector);
  if (!script) return undefined;
  const identity = nativeSourceIdentity(declaration, sourceFile, cache, sourceRoot);
  if (!identity?.selectorEvidence || !identity.sourceTexts) return undefined;
  const text = (member) => identity.sourceTexts.get(join(identity.directory, member));
  const installer = text(script);
  const root = text("CMakeLists.txt");
  if (!installer || !root) return undefined;
  const expectedArchive = `${repository.replace(/\.git$/i, "")}/archive/${selector}.tar.gz`;
  const initial = new Map();
  const nesting = new Set(["if", "function", "macro", "foreach", "while", "block"]);
  function* unconditionalCommands(commands) {
    let depth = 0;
    for (const command of commands) {
      if (nesting.has(command.name)) { depth++; continue; }
      if (command.name.startsWith("end") && nesting.has(command.name.slice(3))) { depth--; continue; }
      if (!depth) yield command;
    }
  }
  const commands = parseCmakeCommands(installer);
  const forwarding = new Set();
  for (const [index, command] of commands.entries()) {
    const next = commands[index + 1];
    if (["function", "macro"].includes(command.name) && command.args.length === 1 &&
      next?.name === "file" && next.args[0] === "DOWNLOAD" && next.args[1] === "${ARGN}") forwarding.add(command.args[0].toLowerCase());
  }
  const expand = (value) => value?.replace(/\$\{([A-Za-z0-9_]+)\}/g, (match, key) => initial.get(key) ?? match);
  let archiveDownload = false;
  for (const { name, args } of unconditionalCommands(commands)) {
    if (name === "set" && args.length === 2) initial.set(args[0], expand(args[1]));
    if (name === "file" && args[0] === "DOWNLOAD" && expand(args[1]) === expectedArchive ||
      forwarding.has(name) && expand(args[0]) === expectedArchive) archiveDownload = true;
  }
  if (!archiveDownload) return undefined;
  const literalPath = (value) => typeof value === "string" && value.split("/").every((part) =>
    /^[A-Za-z0-9_.+-]+$/.test(part) && part !== "." && part !== "..");
  const installs = [];
  for (const { name, args, line } of unconditionalCommands(parseCmakeCommands(root))) {
    const [kind, from, keyword, destination] = args;
    if (name !== "install" || args.length !== 4 || kind !== "DIRECTORY" || keyword !== "DESTINATION" ||
      !literalPath(from.replace(/\/$/, "")) || !(destination === "." || literalPath(destination))) continue;
    const sourcePrefix = `${from.replace(/\/$/, "")}/`;
    const targetPrefix = posix.join(destination, from.endsWith("/") ? "" : posix.basename(from));
    installs.push({ sourcePrefix, targetPrefix, line });
  }
  const matches = [];
  for (const [path, content] of identity.sourceTexts) {
    const member = relative(identity.directory, path).split(sep).join("/");
    if (!content || ![`${requestedName}Config.cmake`, `${requestedName.toLowerCase()}-config.cmake`].includes(basename(member))) continue;
    for (const { sourcePrefix, targetPrefix, line } of installs) {
      if (!member.startsWith(sourcePrefix)) continue;
      const installed = posix.join(targetPrefix, member.slice(sourcePrefix.length));
      if (!/^(?:share|lib(?:32|64|x32)?)\/(?:cmake\/[^/]+|[^/]+(?:\/cmake)?)\/[^/]+$/.test(installed)) continue;
      matches.push({ member, installed, line });
    }
  }
  if (matches.length !== 1) return undefined;
  const { member, installed, line } = matches[0];
  const writer = nativeProviderCacheWriter(cache, sourceRoot);
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const key = hash(JSON.stringify([repository, selector, identity.revision, requestedName, script]));
  const proofPath = `source-config-${key}.evidence.json`;
  const proof = JSON.stringify({ schema: 1, url: declaration.url, repository, selector, revision: identity.revision,
    archiveUrl: expectedArchive, script, member, installed, installFile: "CMakeLists.txt", installLine: line });
  writer.write(proofPath, proof);
  const evidence = [
    { path: proofPath, sha256: hash(proof) },
    { path: relative(cache, identity.selectorEvidence.path), sha256: identity.selectorEvidence.sha256 },
    ...[script, "CMakeLists.txt", member].map((file) => ({
      path: relative(cache, join(identity.directory, file)), sha256: hash(text(file)), ...(file === member ? { member: installed } : {}),
    })),
  ];
  const snapshot = JSON.stringify({ schema: 1, name: requestedName, version: identity.version, versionKind: identity.kind,
    repository, files: [installed], evidence, conditions: ["Frozen source and literal install export; available, not installed or selected"] });
  const path = `source-config-${key}.provider.json`;
  const manifest = `source-config-${key}.manifest.json`;
  writer.write(path, snapshot);
  writer.write(manifest, JSON.stringify({ schema: 1, providers: [{ metadata: { path, format: "provider-snapshot", sha256: hash(snapshot) } }] }));
  return { providerManifest: join(resolve(cache), manifest), revision: identity.revision, member, installed };
}

/** Shared source-object producer. Declarations arrive from the retained parser
 * facts; no manifest, project rescan, checkout, or source execution is needed. */
export async function acquireNativeSourceObjects({ declarations, cache, sourceRoot, fetch: fetchAllowed = false, allowedHosts, deadline = Date.now() + 300000, gitDir: localGitDir, resolveFloating = false }) {
  requireExternalCache(sourceRoot, cache);
  requireExternalCache(sourceRoot, "/usr/bin/git");
  const results = []; const seen = new Set();
  for (const dep of declarations) {
    const repository = nativeSourceRepository(dep.gitRepository);
    const selector = nativeEffectiveSourceSelector(dep);
    const identity = repository && selector && nativeSourceCacheKey(repository, selector);
    if (identity && seen.has(identity)) continue;
    if (identity) seen.add(identity);
    try {
      if (Date.now() >= deadline) throw new Error("Source acquisition deadline exceeded");
      if (!repository || !(immutableSourceSelector(selector) || resolveFloating && nativeSourceBranchRef(selector))) throw new Error("An exact declared repository and selector are required; no default branch or latest release is inferred");
      if (!localGitDir && !fetchAllowed) throw new Error("Missing source object; explicit native acquisition permission required");
      if (!localGitDir && nativeAcquisitionUrl(repository, allowedHosts).hostname !== "github.com") throw new Error("Source object acquisition supports explicit GitHub HTTPS repositories only");
      const writer = nativeProviderCacheWriter(cache, sourceRoot);
      const scratch = mkdtempSync(join(writer.mkdir(".source-scratch"), ".fetch-"));
      try {
        const gitDir = localGitDir || scratch;
        if (!localGitDir) git(gitDir, ["init", "--bare", "--template=", "--quiet"], false, deadline);
        let floatingRef; let capturedRemoteHead;
        let ref = /^[0-9a-f]{40,64}$/i.test(selector) ? selector : selector.startsWith("refs/tags/") ? selector : `refs/tags/${selector}`;
        const branch = resolveFloating && nativeSourceBranchRef(selector);
        if (resolveFloating && selector === "HEAD") {
          floatingRef = ref = "HEAD";
          capturedRemoteHead = !localGitDir;
        } else if (branch && selector.startsWith("refs/heads/")) {
          floatingRef = ref = branch;
        } else if (branch) {
          const refs = (localGitDir ? git(gitDir, ["for-each-ref", "--format=%(refname)", ref, branch], false, deadline).trim().split("\n") :
            git(gitDir, ["ls-remote", "--refs", "--", repository, ref, branch], true, deadline).trim().split("\n").map((line) => line.split("\t")[1]));
          if (!refs.includes(ref) && refs.includes(branch)) { floatingRef = branch; ref = branch; }
          if (!refs.includes(ref)) throw new Error(`Exact source selector ${selector} is not advertised as a tag or branch`);
        }
        if (!localGitDir) {
          git(gitDir, ["fetch", "--depth=1", "--no-tags", "--no-recurse-submodules", "--", repository,
            capturedRemoteHead ? "HEAD:refs/cdxgen/remote-head" : ref.startsWith("refs/") ? `${ref}:${ref}` : ref], true, deadline);
        }
        const observed = capturedRemoteHead ? "refs/cdxgen/remote-head" : ref;
        const revision = git(gitDir, ["rev-parse", "--verify", /^[0-9a-f]{40,64}$/i.test(observed) ? observed : `${observed}^{commit}`], false, deadline).trim();
        results.push({ repository, selector, status: "acquired", ...snapshotNativeSourceObject({ repository, selector, revision, gitDir, cache,
          floatingRef, capturedRemoteHead, url: dep.url, deadline }) });
      } finally { rmSync(scratch, { recursive: true, force: true }); }
    } catch (error) {
      const stderr = typeof error.stderr === "string" ? error.stderr : error.stderr?.toString();
      const prerequisite = stderr?.split("\n").find((line) => /^fatal:/.test(line)) ||
        (error.code === "ETIMEDOUT" ? "Exact source selector observation timed out" : String(error.message).split("\n")[0]);
      results.push({ repository, selector, status: "blocked", prerequisite: prerequisite.slice(0, 512) });
    }
  }
  return results;
}

async function main(args) {
  const values = new Map();
  const manifests = [];
  let fetch = false;
  let resolveFloating = false;
  for (let at = 0; at < args.length; at++) {
    if (args[at] === "--fetch") fetch = true;
    else if (args[at] === "--resolve-floating") resolveFloating = true;
    else if (args[at] === "--manifest") manifests.push(args[++at]);
    else if (["--cache", "--repository", "--ref", "--git-dir", "--source-root"].includes(args[at])) values.set(args[at], args[++at]);
    else throw new Error(`Unknown argument ${args[at]}`);
  }
  const cache = values.get("--cache");
  if (!cache) throw new Error("Use --cache EXTERNAL_DIRECTORY [--manifest CMakeLists.txt --source-root ROOT | --repository HTTPS_GITHUB_URL --ref REF] [--fetch | --git-dir EXISTING_REPOSITORY] [--resolve-floating]");
  if (values.has("--repository") && !values.get("--ref")) throw new Error("--repository requires an explicit --ref");
  if (values.get("--source-root")) requireExternalCache(values.get("--source-root"), cache);
  if (values.has("--git-dir") && !values.get("--source-root")) throw new Error("--git-dir requires an explicit --source-root boundary");
  if (values.get("--git-dir")) {
    requireExternalCache(values.get("--git-dir"), cache);
    if (basename(realpathSync(values.get("--git-dir"))) === ".git") requireExternalCache(dirname(realpathSync(values.get("--git-dir"))), cache);
  }
  // Validate every effective source boundary before any scratch, cache or
  // network operation, including manifests without an explicit source root.
  for (const file of manifests) requireExternalCache(sourceRootOf(resolve(file)) || dirname(resolve(file)), cache);
  const declarations = [];
  if (values.has("--repository")) declarations.push({ gitRepository: values.get("--repository"), gitTag: values.get("--ref") });
  for (const file of manifests) {
    const text = readRegularTextFile(resolve(file), 256 * 1024);
    if (text === undefined) throw new Error(`Cannot read bounded manifest ${file}`);
    declarations.push(...cmakeFetchDependencies(text, cmakeProjectDetails(resolve(file), parseCmakeCommands(text), values.get("--source-root") || dirname(resolve(file))).fetchCommands));
  }
  if (!declarations.length) throw new Error("No source declarations supplied");
  const results = await acquireNativeSourceObjects({ declarations, cache, sourceRoot: values.get("--source-root") || dirname(resolve(manifests[0] || values.get("--git-dir") || ".")),
    fetch, gitDir: values.get("--git-dir"), resolveFloating });
  for (const result of results) console.log(JSON.stringify(result));
  if (results.some((result) => result.status === "blocked")) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
