import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { acquireNativeAppleProviders } from "../../contrib/native-apple-provider-cache.js";
import { acquireNativeCudaHistoricalComponents, acquireNativeCudaProviders, nativeCudaQueryPlan } from "../../contrib/native-cuda-provider-cache.js";
import { acquireNativeDebProviders, nativeDebQueryPlan, nativeDebTrustedContext, scopeNativeDebProviders } from "../../contrib/native-deb-provider-cache.js";
import { cacheNativeDownload } from "../../contrib/native-download-cache.js";
import { acquireNativeMlirAieWheel } from "../../contrib/native-mlir-aie-provider-cache.js";
import { acquireNativeProviders, nativeProviderCacheWriter } from "../../contrib/native-provider-cache.js";
import { acquireNativePyPiProviders, nativePyPiAllowed, nativePyPiQueryPlan } from "../../contrib/native-pypi-provider-cache.js";
import { acquireNativeRpmProviders, nativeRpmQueryPlan } from "../../contrib/native-rpm-provider-cache.js";
import { acquireNativeSourceObjects, cacheNativeSourceConfigProvider } from "../../contrib/native-source-cache.js";
import { isDryRun as activityDryRun, readEnvironmentVariable } from "../core/activity.js";
import { nativeArchiveIdentityEvidence, nativeDeclaredArchiveIdentityEvidence } from "../ecosystems/nativeArchiveIdentity.js";
import { readRegularTextFile } from "../core/boundedFile.js";
import { nativeDownloadIdentity } from "../ecosystems/nativeDownloadSources.js";
import { loadNativeExternalMetadata, nativeMlirAieWheelIdentity, nativeProgramNames, nativeProviderPlatformAccepts, nativeProviderReplay } from "../ecosystems/nativeExternalMetadata.js";
import { cmakeFetchDependencyComponent, sourceAlternativeExcluded } from "../ecosystems/parsers-misc.js";
import { nativeEffectiveSourceSelector, nativeSourceIdentity } from "../inventory/nativeSourceIdentity.js";
import { sourceRootOf } from "../inventory/sourceRevision.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const array = (value) => Array.isArray(value) ? value : typeof value === "string" ? value.split(",").filter(Boolean) : [];
const manifestPaths = (value) => Array.isArray(value) ? value : typeof value === "string" ? value.split(delimiter).filter(Boolean) : [];
const MAX_DEB_REPLAYS = 4;
const MAX_DEB_REPLAY_BYTES = 1024 * 1024;
const debReplayFile = /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/;
const debReplayProgram = /^[A-Za-z0-9_][A-Za-z0-9_.+-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.+-]*)*$/;

function outsideSource(sourceRoot, path) {
  const scope = relative(sourceRoot, path);
  return isAbsolute(scope) || scope === ".." || scope.startsWith(`..${sep}`);
}

function boundedDebReplayPlan(plan) {
  const valid = (names, token) => names.every((name, i) => typeof name === "string" && name.length <= 255 &&
    (i === 0 || names[i - 1] < name) && token.test(name));
  return Array.isArray(plan?.programs) && Array.isArray(plan.files) && plan.programs.length + plan.files.length <= 4096 &&
    valid(plan.programs, debReplayProgram) && valid(plan.files, debReplayFile);
}

function signedDebContext(repositories, plan) {
  const context = [2, repositories, plan];
  return { context, manifestName: `native-provider-metadata-${hash(JSON.stringify(context))}.json` };
}

function readDebReplay(path, sourceRoot, trusted) {
  if (typeof path !== "string" || !isAbsolute(path) || !outsideSource(sourceRoot, realpathSync(path))) {
    throw new Error("Debian replay selector must be an absolute file outside the source root");
  }
  const descriptor = JSON.parse(readRegularTextFile(path, MAX_DEB_REPLAY_BYTES) || "null");
  if (descriptor?.schema !== 1 || typeof descriptor.cache !== "string" || !isAbsolute(descriptor.cache) ||
    !boundedDebReplayPlan(descriptor.plan) || !Array.isArray(descriptor.repositories) || !descriptor.repositories.length ||
    descriptor.repositories.length > trusted.size || new Set(descriptor.repositories).size !== descriptor.repositories.length) {
    throw new Error("Invalid bounded Debian replay selector");
  }
  const repositories = descriptor.repositories.map((spec) => {
    const digest = trusted.get(spec);
    if (!digest) throw new Error("Debian replay repository is not independently configured");
    return [spec, digest];
  });
  const { programs, files } = descriptor.plan;
  return { cache: resolve(descriptor.cache), repositories, plan: { programs, files } };
}

/** A scan leaf can live inside nested checkouts. Protect every enclosing source
 * repository using canonical paths, while keeping request paths scan-relative. */
function protectedNativeSourceRoot(sourceRoot) {
  const scanRoot = realpathSync(sourceRoot);
  let boundary = scanRoot;
  let checkout = sourceRootOf(join(scanRoot, "CMakeLists.txt"));
  while (checkout) {
    boundary = checkout;
    if (dirname(checkout) === checkout) break;
    checkout = sourceRootOf(checkout);
  }
  return boundary;
}

/** Declarations, including their ordered evaluation results, are the request
 * inventory. Retain all occurrences while sharing identical acquisition work. */
export function nativeAcquisitionRequests(requirements) {
  const requests = new Map();
  for (const occurrence of requirements) {
    if (!["source-declaration", "data-artifact"].includes(occurrence.role) || !occurrence.source || occurrence.source.helperTemplate) continue;
    const source = occurrence.source;
    const wrapHash = source.hashes?.find((entry) => entry.alg === "SHA-256");
    const declaration = { ...source, name: source.name || occurrence.requestedName, kind: source.kind || occurrence.command,
      ...(source.type === "wrap-git" ? { gitRepository: source.url, gitTag: source.reference, url: undefined } : {}),
      ...(!source.urlHash && wrapHash ? { urlHash: `SHA256=${wrapHash.content}` } : {}),
      ...(source.identity?.version ? { version: source.identity.version } : {}),
      conditions: occurrence.conditions, conditional: Boolean(occurrence.conditions?.length) };
    let repository = declaration.gitRepository; let selector = nativeEffectiveSourceSelector(declaration);
    if (!repository && declaration.url && !declaration.urlHash) {
      try {
        const url = new URL(source.url); const parts = url.pathname.split("/").filter(Boolean);
        if (url.hostname === "github.com" && parts[2] === "archive") {
          repository = `https://github.com/${parts[0]}/${parts[1]}`;
          selector = decodeURIComponent(parts.slice(3).join("/").replace(/\.(?:tar\.gz|zip)$/, ""));
        } else if (url.hostname === "raw.githubusercontent.com" && parts.length >= 4) {
          repository = `https://github.com/${parts[0]}/${parts[1]}`; selector = parts[2];
        }
      } catch { /* Retain invalid and unresolved declarations as named blockers. */ }
    }
    const key = hash(JSON.stringify([repository, selector, declaration.url, declaration.urlHash, source.platform, source.artifactType, source.sourceDir]));
    const request = requests.get(key) || { key, repository, selector, url: declaration.url, declaration, occurrences: [] };
    request.occurrences.push(occurrence); requests.set(key, request);
  }
  return [...requests.values()];
}

export function nativeAcquisitionRequirementKey(requirement) {
  const { providerCandidates: _candidates, ...identity } = requirement;
  return JSON.stringify(identity);
}

/** Every producer failure channel describes a retained prerequisite, including
 * rejected metadata and materials that omit a requested identity/export. */
export function nativeAcquisitionBlockers(result) {
  const blockers = [];
  for (const key of ["inaccessible", "missing", "unavailable", "rejected", "missingIdentities"]) {
    for (const failure of result[key] || []) {
      if (typeof failure === "string") blockers.push({ requestedName: failure, prerequisite: "Exact requested identity/export is absent from acquired material" });
      else if (failure && typeof failure === "object") blockers.push({ ...failure,
        ...(failure.requestedName || failure.name || failure.component ? { requestedName: failure.requestedName || failure.name || failure.component } : {}),
        prerequisite: failure.prerequisite || failure.reason || "Exact requested provider evidence is unavailable" });
    }
  }
  if (result.prerequisite) blockers.push({ prerequisite: result.prerequisite });
  return blockers;
}

function verifiedReceipt(cache, sourceRoot, key, expectedManifest) {
  try {
    if (!outsideSource(realpathSync(sourceRoot), realpathSync(cache))) return undefined;
  } catch { return undefined; }
  const text = readRegularTextFile(join(cache, "acquisitions", `${key}.json`), 1024 * 1024, cache);
  let receipt;
  try { receipt = JSON.parse(text || "null"); } catch { return undefined; }
  if (receipt?.schema !== 1 || receipt.key !== key || !Array.isArray(receipt.manifests)) return undefined;
  if (expectedManifest && (receipt.manifests.length !== 1 || receipt.manifests[0]?.path !== expectedManifest)) return undefined;
  const manifests = [];
  let invalid = false;
  for (const descriptor of receipt.manifests) {
    if (!descriptor || typeof descriptor.path !== "string" || isAbsolute(descriptor.path) || descriptor.path.split(/[\\/]/).includes("..")) {
      invalid = true; continue;
    }
    const path = join(cache, descriptor.path); const bytes = readRegularTextFile(path, 8 * 1024 * 1024, cache);
    if (bytes === undefined || hash(bytes) !== descriptor.sha256) { invalid = true; continue; }
    manifests.push(path);
  }
  const state = receipt.state === "complete" ? "complete" : "partial";
  const blockers = Array.isArray(receipt.blockers) ? receipt.blockers : state === "partial" ?
    [{ prerequisite: receipt.prerequisite || "Acquisition is incomplete; exact provider material remains unavailable" }] : [];
  return { ...receipt, state, blockers, manifests, invalid };
}

/** Discovery → bounded acquisition → retained-fact materialization. This never
 * reopens source manifests, calls createCppBom, or runs a source build. */
export async function acquireNativeEvidence(requirements, sourceRoot, inputOptions) {
  const options = { ...inputOptions };
  const protectedSourceRoot = protectedNativeSourceRoot(sourceRoot);
  const cache = options.nativeSourceCache || readEnvironmentVariable("CDXGEN_NATIVE_SOURCE_CACHE");
  const network = options.nativeAcquire === true && options.dryRun !== true && !activityDryRun;
  const diagnostics = []; const manifests = new Set(manifestPaths(options.nativeProviderMetadata ?? readEnvironmentVariable("CDXGEN_NATIVE_PROVIDER_METADATA")));
  const deadline = Date.now() + 300000;
  const replay = { deadline, debian: new Map(), prepared: new Map(), status: new Map(), verifying: new Set(), archiveVerification: new Map() };
  options[nativeProviderReplay] = replay;
  const verifyManifest = (path, debianSha256, debScope) => {
    if (!path) return true;
    replay.prepared.delete(path); replay.status.delete(path);
    if (debianSha256) replay.debian.set(path, debianSha256);
    else replay.debian.delete(path);
    replay.verifying.add(path);
    try {
      const providers = loadNativeExternalMetadata({ nativeProviderMetadata: [path], [nativeProviderReplay]: replay });
      const status = replay.status.get(path);
      if (debianSha256) {
        // A signed manifest replaced between index replay and loading must not
        // be reinterpreted as an explicitly configured unsigned manifest.
        if (!status || providers.some((provider) => !provider.repositoryEvidence || provider.manifestSha256 !== debianSha256)) {
          replay.prepared.set(path, []);
          return false;
        }
        replay.prepared.set(path, scopeNativeDebProviders(providers, debScope.programs, debScope.files));
      }
      return !!status && status.accepted === status.expected;
    } finally { replay.verifying.delete(path); }
  };
  const acquiredRequestKeys = new Set();
  let writer;
  const getWriter = () => writer ||= nativeProviderCacheWriter(cache, protectedSourceRoot);
  const remember = (key, paths, outcome) => {
    const descriptors = paths.filter(Boolean).map((path) => {
      const text = readRegularTextFile(path, 8 * 1024 * 1024, cache);
      if (text === undefined) throw new Error("Acquired provider manifest is unreadable");
      const pathInCache = relative(resolve(cache), resolve(path));
      if (isAbsolute(pathInCache) || pathInCache === ".." || pathInCache.startsWith(`..${sep}`)) throw new Error("Acquired manifest escapes cache");
      manifests.add(path); return { path: pathInCache, sha256: hash(text) };
    });
    getWriter().write(`acquisitions/${key}.json`, JSON.stringify({ schema: 1, key, manifests: descriptors, ...outcome }));
  };
  const requests = nativeAcquisitionRequests(requirements);
  // A raw script is not a package export by itself. Inspect only the package
  // rechecked later in that same explicit missing-package branch.
  const rawConfigDemands = (request) => {
    if (!request.url?.startsWith("https://raw.githubusercontent.com/") || !request.url.endsWith(".cmake")) return [];
    return [...new Set(request.occurrences.flatMap((occurrence) => {
      const names = (occurrence.conditions || []).flatMap((condition) => {
        const match = /^if\(\s*NOT\s+([A-Za-z0-9_][A-Za-z0-9_.+-]*)_FOUND\s*\)$/i.exec(condition);
        return match ? [match[1]] : [];
      });
      return names.filter((name) => requirements.some((requirement) =>
        requirement.file === occurrence.file && requirement.line > occurrence.line &&
        requirement.role === "software" && requirement.command === "find_package" &&
        requirement.requestedName === name && occurrence.conditions.every((condition) => requirement.conditions?.includes(condition))));
    }))];
  };
  // At most four independent artifacts in flight; the shared five-minute
  // deadline is checked before every request and by each HTTP response.
  for (let at = 0; at < requests.length; at += 4) {
    await Promise.all(requests.slice(at, at + 4).map(async (request) => {
      const { declaration, repository, selector, url, key } = request;
      const report = { requestedName: declaration.name, repository, selector, url, urlHash: declaration.urlHash,
        ...(declaration.gitTagDefault ? { selectorOrigin: declaration.gitTagDefault } : {}),
        occurrences: request.occurrences.map(({ file, line, command, conditions }) => ({ file, line, command, conditions })) };
      try {
        const sourceFile = resolve(sourceRoot, request.occurrences[0].file || "CMakeLists.txt");
        const sourceDeclaration = { ...declaration, gitRepository: repository, gitTag: selector };
        const configDemands = repository && selector ? rawConfigDemands(request) : [];
        const cacheSourceConfigs = () => {
          const paths = [];
          const blockers = [];
          for (const requestedName of configDemands) {
            const provider = cacheNativeSourceConfigProvider({ declaration: sourceDeclaration, sourceFile, sourceRoot: protectedSourceRoot, cache, requestedName });
            if (provider?.providerManifest && verifyManifest(provider.providerManifest)) paths.push(provider.providerManifest);
            else blockers.push({ requestedName, prerequisite: "Exact frozen source installer and checked-in config install export are required" });
          }
          return { paths, blockers };
        };
        const identity = cache && (repository && nativeSourceIdentity(sourceDeclaration, sourceFile, cache, protectedSourceRoot) ||
          url && (nativeDownloadIdentity(url, cache, protectedSourceRoot, declaration.urlHash) || nativeDeclaredArchiveIdentityEvidence(url, cache, protectedSourceRoot, declaration.urlHash) || !declaration.urlHash && nativeArchiveIdentityEvidence(url, cache, protectedSourceRoot)));
        const receipt = cache && verifiedReceipt(cache, protectedSourceRoot, key);
        const invalid = receipt?.manifests.filter((manifest) => receipt.requiresIdentity && !identity || !verifyManifest(manifest)) || [];
        if (receipt) for (const manifest of receipt.manifests) if (!invalid.includes(manifest)) manifests.add(manifest);
        const complete = receipt?.state === "complete" && !receipt.invalid && !invalid.length && (identity || receipt.manifests.length > 0) &&
          (!configDemands.length || receipt.manifests.length > 0);
        if (receipt && (complete || !network)) {
          const failed = receipt.invalid || invalid.length || receipt.state === "complete" && !complete;
          const blockers = failed ? [...receipt.blockers, { requestedName: declaration.name, prerequisite: "Cached provider material failed authentication" }] : receipt.blockers;
          diagnostics.push({ ...report, status: complete ? "cached" : "partial", blockers,
            ...(identity?.revision ? { revision: identity.revision } : {}),
            ...(receipt.prerequisite ? { prerequisite: receipt.prerequisite } : {}) });
          return;
        }
        if (identity && configDemands.length && network) {
          const { paths, blockers } = cacheSourceConfigs();
          remember(key, paths, { state: blockers.length ? "partial" : "complete", blockers, requiresIdentity: true });
          diagnostics.push({ ...report, status: blockers.length ? "partial" : "cached", revision: identity.revision, blockers });
          return;
        }
        const needsInstallerInventory = declaration.urlHash && identity?.artifactVersionSource === "CPack installer version header";
        if (identity && !receipt && !(network && needsInstallerInventory)) { diagnostics.push({ ...report, status: "cached" }); return; }
        if (!cache) throw new Error("Missing evidence: operator must provide an out-of-tree --native-source-cache");
        if (!network) throw new Error(options.dryRun || activityDryRun ? "Dry-run forbids acquisition and cache writes" : "Offline: exact evidence is absent; operator --native-acquire is required");
        if (Date.now() >= deadline) throw new Error("Native acquisition deadline exceeded; exact declaration remains unresolved");
        if (repository && selector && receipt?.state === "complete" && !/^[0-9a-f]{40,64}$/i.test(selector)) {
          throw new Error("Frozen Git selector evidence failed authentication; restore the original snapshot rather than refreshing a moving ref");
        }
        if (repository && selector) {
          const [result] = await acquireNativeSourceObjects({ declarations: [sourceDeclaration], cache, sourceRoot: protectedSourceRoot,
            fetch: true, resolveFloating: true, allowedHosts: options.nativeAcquireHosts, deadline });
          if (result.status !== "acquired") {
            remember(key, [], { state: "partial", prerequisite: result.prerequisite,
              blockers: [{ requestedName: declaration.name, prerequisite: result.prerequisite }] });
            throw new Error(result.prerequisite);
          }
          const { paths, blockers } = cacheSourceConfigs();
          remember(key, paths, { state: blockers.length ? "partial" : "complete", blockers, ...(paths.length ? { requiresIdentity: true } : {}) });
          acquiredRequestKeys.add(key);
          diagnostics.push({ ...report, status: blockers.length ? "partial" : "acquired", revision: result.revision, blockers });
        } else if (url) {
          const result = await cacheNativeDownload({ url, cache, sourceRoot: protectedSourceRoot, urlHash: declaration.urlHash,
            name: declaration.name, artifactType: declaration.artifactType, allowedHosts: options.nativeAcquireHosts, deadline });
          const blockers = nativeAcquisitionBlockers(result).map((blocker) => ({ requestedName: declaration.name, ...blocker }));
          remember(key, [result.providerManifest], { state: blockers.length ? "partial" : "complete", blockers,
            ...(result.installerInventory ? { requiresIdentity: true } : {}), ...(result.prerequisite ? { prerequisite: result.prerequisite } : {}) });
          acquiredRequestKeys.add(key);
          diagnostics.push({ ...report, status: blockers.length ? "partial" : "acquired", sha256: result.sha256, blockers, ...(result.prerequisite ? { prerequisite: result.prerequisite } : {}) });
        } else if (declaration.sourceDir && !declaration.sourceDir.includes("$")) {
          throw new Error("Declared local source directory is unavailable or does not authenticate the requested source identity");
        } else throw new Error("Exact public URL/repository selector or authorized private/site source material is required");
      } catch (error) { diagnostics.push({ ...report, status: "blocked", prerequisite: String(error.message).split("\n")[0] }); }
    }));
  }
  const contextual = requirements.filter((r) => !["source-declaration", "data-artifact", "build-target", "target-alias", "unresolved-expression"].includes(r.role));
  const contexts = [];
  if (options.nativeRegistryRevision || contextual.some((r) => (r.providerCandidates || []).some((p) => p.kind === "wrapdb-catalog"))) {
    contexts.push({ family: "registry", context: options.nativeRegistryRevision || "wrapdb-catalog", run: () => acquireNativeProviders({ requirements: contextual,
      output: join(cache, "registry"), sourceRoot: protectedSourceRoot, registryRevision: options.nativeRegistryRevision, fetch: true, allowedHosts: options.nativeAcquireHosts, deadline }) });
  }
  if (options.nativeRpmRepositories) {
    const repositories = array(options.nativeRpmRepositories);
    // A complete receipt is valid only for the actual indexed query plan.
    const context = [repositories, nativeRpmQueryPlan(contextual)];
    contexts.push({ family: "rpm", context, run: () => acquireNativeRpmProviders({ requirements: contextual,
      output: join(cache, "rpm"), sourceRoot: protectedSourceRoot, repositories, fetch: true, allowedHosts: options.nativeAcquireHosts, deadline }) });
  }
  let debPlan;
  let debRepositories;
  let debScope;
  if (options.nativeDebRepositories) {
    debPlan = nativeDebQueryPlan(contextual);
    if (debPlan.programs.length || debPlan.files.length) try {
      debScope = { programs: new Set(debPlan.programs), files: new Set(debPlan.files) };
      debRepositories = nativeDebTrustedContext(array(options.nativeDebRepositories), protectedSourceRoot, options.nativeAcquireHosts);
      const { context, manifestName } = signedDebContext(debRepositories, debPlan);
      const deb = (fetch) => acquireNativeDebProviders({ plan: debPlan, repositories: debRepositories, output: join(cache, "deb"), manifestName,
        sourceRoot: protectedSourceRoot, fetch, allowedHosts: options.nativeAcquireHosts, deadline });
      contexts.push({ family: "deb", context, exactPlan: true, names: [...debPlan.programs, ...debPlan.files],
        verify: () => deb(false), run: () => deb(true) });
    } catch (error) { diagnostics.push({ family: "deb", status: "blocked", prerequisite: String(error.message).split("\n")[0] }); }
  }
  const mlirAieWheel = options.nativeMlirAieWheel;
  if (mlirAieWheel) {
    const demands = contextual.filter((requirement) => nativeProgramNames(requirement).includes("aie-hsaco"));
    if (demands.length) {
      const identity = nativeMlirAieWheelIdentity(mlirAieWheel);
      if (!identity) diagnostics.push({ family: "mlir-aie-wheel", status: "blocked",
        prerequisite: "An exact MLIR-AIE VERSION:WHEEL-TAG selector is required" });
      else if (demands.some((requirement) => nativeProviderPlatformAccepts(identity, requirement))) {
        contexts.push({ family: "mlir-aie-wheel", context: [1, mlirAieWheel], exactPlan: true, names: ["aie-hsaco"],
          run: () => acquireNativeMlirAieWheel({ identity, selector: mlirAieWheel, output: join(cache, "mlir-aie"),
            sourceRoot: protectedSourceRoot, allowedHosts: options.nativeAcquireHosts, deadline }) });
      }
    }
  }
  if (cache && nativePyPiAllowed(options.nativeAcquireHosts)) {
    const plan = nativePyPiQueryPlan(contextual);
    if (plan.projects.length) contexts.push({ family: "pypi", context: [2, plan], exactPlan: true, names: plan.programs,
      run: (retained) => acquireNativePyPiProviders({ plan, retained, output: join(cache, "pypi"),
        manifestName: `native-provider-metadata-${hash(JSON.stringify(plan))}.json`,
        sourceRoot: protectedSourceRoot, fetch: true, allowedHosts: options.nativeAcquireHosts, deadline }) });
  }
  if (options.nativeAppleSdks) contexts.push({ family: "apple-sdk", context: array(options.nativeAppleSdks), run: () => acquireNativeAppleProviders({ requirements: contextual,
    output: join(cache, "apple"), sourceRoot: protectedSourceRoot, specifications: array(options.nativeAppleSdks), fetch: true, allowedHosts: options.nativeAcquireHosts, deadline }) });
  const cudaRequests = contextual.filter((r) => ["CUDA", "CUDAToolkit"].includes(r.requestedName));
  const cudaReleases = new Set(cudaRequests.flatMap((r) => /^\d+(?:\.\d+){1,3} EXACT$/.test(r.constraints || "") ? [r.constraints.split(" ")[0]] : []));
  if (options.nativeCudaRelease) cudaReleases.add(options.nativeCudaRelease);
  if (cudaReleases.size || options.nativeCudaPlatforms) {
    const plan = nativeCudaQueryPlan(contextual);
    for (const cudaRelease of cudaReleases) {
      const context = [2, cudaRelease, options.nativeCudaPlatforms, plan];
      contexts.push({ family: "cuda", context, exactPlan: true, names: [...plan.toolkit, ...plan.libraries, ...plan.programs],
        run: (retained) => acquireNativeCudaProviders({
          output: join(cache, "cuda", hash(cudaRelease)), manifestName: `native-provider-metadata-${hash(JSON.stringify(context))}.json`,
          sourceRoot: protectedSourceRoot, cudaRelease, platforms: options.nativeCudaPlatforms, requirements: contextual,
          fetch: true, retained, allowedHosts: options.nativeAcquireHosts, deadline }) });
    }
    if (plan.libraries.length && array(options.nativeCudaPlatforms).includes("linux-x86_64")) {
      // Before the per-release redistributable format, the vendor published
      // independently versioned component packages via its Linux APT index.
      const historical = [...cudaReleases].filter((release) => /^(?:[1-9]|10)\.\d+(?:\.\d+){0,2}$/.test(release));
      if (!cudaReleases.size) historical.push(undefined);
      for (const release of historical) {
        const context = [2, release, "linux-x86_64", plan.libraries];
        contexts.push({ family: "cuda-historical", context, exactPlan: true, names: plan.libraries, run: (retained) => acquireNativeCudaHistoricalComponents({
          output: join(cache, "cuda-historical"), manifestName: `native-provider-metadata-${hash(JSON.stringify(context))}.json`,
          sourceRoot: protectedSourceRoot, release, libraries: plan.libraries, fetch: true, retained, allowedHosts: options.nativeAcquireHosts, deadline }) });
      }
    }
  }
  for (const item of contexts) {
    const key = hash(JSON.stringify(item.exactPlan ? [item.family, item.context] : [item.family, item.context, contextual.map(nativeAcquisitionRequirementKey).sort()]));
    try {
      const receipt = cache && verifiedReceipt(cache, protectedSourceRoot, key);
      const authenticationFailure = { requestedNames: item.names || [...new Set(contextual.map((requirement) => requirement.requestedName).filter(Boolean))],
        prerequisite: "Cached provider material failed authentication" };
      const retained = [];
      if (receipt) {
        const verified = item.verify && await item.verify();
        let valid = !receipt.invalid && (!item.verify || !!verified?.verifiedManifestSha256 && !verified.retryable);
        for (const path of receipt.manifests) {
          const signed = item.verify ? verified?.manifestPath === path && verified.verifiedManifestSha256 : undefined;
          if (item.verify && !signed) { valid = false; continue; }
          if (verifyManifest(path, signed, debScope)) manifests.add(path);
          else {
            valid = false;
            if (!network && replay.prepared.get(path)?.length) manifests.add(path);
          }
          for (const provider of replay.prepared.get(path) || []) if (provider.manifestPath === path) retained.push(provider);
        }
        const complete = valid && receipt.state === "complete";
        if (complete || !network || valid && item.family === "deb") {
          const blockers = valid ? receipt.blockers : [...receipt.blockers, ...nativeAcquisitionBlockers(verified || {}), authenticationFailure];
          diagnostics.push({ family: item.family, status: complete ? "cached" : "partial", blockers });
          continue;
        }
      }
      if (!cache || !network) throw new Error("Offline: exact provider context evidence is absent; operator cache and acquisition permission are required");
      if (Date.now() >= deadline) throw new Error("Native acquisition deadline exceeded");
      const result = await item.run(retained);
      // Retry failures, not already authenticated immutable artifact digests
      // and inventories. A failed observation may now be repaired on disk.
      for (const [key, value] of replay.archiveVerification) if (!value) replay.archiveVerification.delete(key);
      const blockers = nativeAcquisitionBlockers(result);
      if (!blockers.length && (result.providers ?? result.packageRecords) === 0) blockers.push({
        requestedNames: authenticationFailure.requestedNames, prerequisite: "No authenticated provider exports were acquired for the discovered context" });
      const valid = verifyManifest(result.manifestPath, result.verifiedManifestSha256, debScope);
      if (!valid) blockers.push({ ...authenticationFailure, prerequisite: "Acquired provider material failed authentication" });
      remember(key, [result.manifestPath], { state: blockers.length ? "partial" : "complete", blockers });
      if (item.family === "deb" && valid && result.verifiedManifestSha256 && !result.retryable &&
        result.providers > 0 && boundedDebReplayPlan(debPlan)) {
        const selector = { schema: 1, cache: resolve(cache), repositories: debRepositories.map(([spec]) => spec), plan: debPlan };
        const text = JSON.stringify(selector);
        if (Buffer.byteLength(text) <= MAX_DEB_REPLAY_BYTES) getWriter().write(`acquisitions/${key}.deb-replay.json`, text);
      }
      if (!valid && !replay.prepared.get(result.manifestPath)?.length) manifests.delete(result.manifestPath);
      diagnostics.push({ family: item.family, status: blockers.length ? "partial" : "acquired", blockers });
    } catch (error) { diagnostics.push({ family: item.family, status: "blocked", prerequisite: String(error.message).split("\n")[0] }); }
  }
  const debReplays = Array.isArray(options.nativeDebReplay) ? options.nativeDebReplay :
    typeof options.nativeDebReplay === "string" ? [options.nativeDebReplay] : [];
  if (debReplays.length > MAX_DEB_REPLAYS) {
    diagnostics.push({ family: "deb-replay", status: "blocked", prerequisite: `At most ${MAX_DEB_REPLAYS} explicit Debian replay selectors are permitted` });
  } else if (debReplays.length && (!options.nativeDebRepositories || debPlan?.programs.length || debPlan?.files.length)) {
    const trusted = new Map(debRepositories);
    const observed = new Set();
    for (const selector of new Set(debReplays)) try {
      if (!trusted.size) throw new Error("Debian replay requires independently configured trusted Debian repositories");
      const { cache: replayCache, repositories, plan } = readDebReplay(selector, protectedSourceRoot, trusted);
      const requestedPrograms = new Set(plan.programs.filter((name) => debScope.programs.has(name)));
      const requestedFiles = new Set(plan.files.filter((name) => debScope.files.has(name)));
      if (!requestedPrograms.size && !requestedFiles.size) continue;
      const { context, manifestName } = signedDebContext(repositories, plan);
      const manifestInCache = join("deb", manifestName);
      const path = join(replayCache, manifestInCache);
      if (observed.has(path) || replay.debian.has(path) && manifests.has(path)) continue;
      observed.add(path);
      const key = hash(JSON.stringify(["deb", context]));
      const receipt = verifiedReceipt(replayCache, protectedSourceRoot, key, manifestInCache);
      if (!receipt || receipt.invalid) throw new Error("Focused Debian receipt or deterministic manifest failed authentication");
      const verified = await acquireNativeDebProviders({ plan, repositories, output: dirname(path), manifestName,
        sourceRoot: protectedSourceRoot, fetch: false, allowedHosts: options.nativeAcquireHosts, deadline });
      if (verified.manifestPath !== path || !verified.verifiedManifestSha256 || verified.retryable) {
        diagnostics.push({ family: "deb-replay", status: "blocked", selector, blockers: nativeAcquisitionBlockers(verified),
          prerequisite: "Focused Debian manifest failed signed archive authentication" });
        continue;
      }
      // The original plan must authenticate in full. Its exact paths may
      // contribute only to queries present in both plans.
      if (!verifyManifest(path, verified.verifiedManifestSha256, { programs: requestedPrograms, files: requestedFiles })) {
        replay.debian.delete(path);
        replay.prepared.set(path, []);
        throw new Error("Focused Debian export inventory failed authentication");
      }
      const projected = replay.prepared.get(path);
      if (projected.length) manifests.add(path);
      const blockers = nativeAcquisitionBlockers(verified).filter(({ requestedName }) =>
        requestedPrograms.has(requestedName) || requestedFiles.has(requestedName));
      diagnostics.push({ family: "deb-replay", status: projected.length && !blockers.length ? "cached" : "partial", selector, blockers });
    } catch (error) {
      diagnostics.push({ family: "deb-replay", status: "blocked", selector, prerequisite: String(error.message).split("\n")[0] });
    }
  }
  if (cudaRequests.length && !cudaReleases.size) diagnostics.push({ family: "cuda", status: "blocked", prerequisite: "Exact published CUDA toolkit release and target platform are required; a minimum version is not a release selector" });
  options.nativeSourceCache = cache;
  options.nativeProviderMetadata = [...manifests];
  return { options, diagnostics, acquiredRequestKeys };
}

/** Re-materialize only declaration identities, preserving the original occurrence
 * metadata and letting the existing reconciliation remaps close all references. */
export function materializeNativeAcquisitions(pkgList, dependencies, requirements, sourceRoot, options, acquiredRequestKeys, requirementOwners = new Map()) {
  const remap = new Map(); const replacements = new Map(); const updatedRequirements = new Map();
  if (!acquiredRequestKeys?.size) return { pkgList, dependencies, remap, updatedRequirements };
  const byRef = new Map(pkgList.map((component) => [component["bom-ref"], component]));
  const created = new Map(); const bindings = []; const addedEdges = [];
  const changed = (requirement) => updatedRequirements.set(nativeAcquisitionRequirementKey(requirement), requirement);
  const detachRequirement = (component, requirement) => {
    const key = nativeAcquisitionRequirementKey(requirement);
    component.properties = (component.properties || []).filter((property) => property.name !== "cdx:build:requirement" ||
      nativeAcquisitionRequirementKey(JSON.parse(property.value)) !== key);
  };
  const attachRequirement = (component, requirement) => {
    const value = JSON.stringify(requirement);
    component.properties ||= [];
    if (!component.properties.some((property) => property.name === "cdx:build:requirement" && property.value === value)) component.properties.push({ name: "cdx:build:requirement", value });
  };
  const addOwnerEdge = (requirement, ref) => {
    const ownerRef = requirementOwners.get(requirement)?.ownerRef;
    if (ownerRef) addedEdges.push({ ref: ownerRef, dependsOn: [ref] });
  };
  for (const request of nativeAcquisitionRequests(requirements)) {
    if (!acquiredRequestKeys.has(request.key)) continue;
    for (const requirement of request.occurrences) {
      const component = cmakeFetchDependencyComponent(request.declaration, resolve(sourceRoot, requirement.file || "CMakeLists.txt"), { ...options, sourceRoot });
      if (!component?.version && component?.type !== "data") continue;
      const previousRefs = (requirement.providerCandidates || []).map((candidate) => candidate.ref).filter(Boolean);
      const originals = (requirement.providerCandidates || []).filter((candidate) => candidate.ref && byRef.has(candidate.ref));
      if (!originals.length) {
        const owner = created.get(component["bom-ref"]) || component;
        created.set(owner["bom-ref"], owner);
        requirement.providerCandidates ||= [];
        if (!requirement.providerCandidates.length) requirement.providerCandidates.push({
          kind: requirement.command === "meson-wrap" ? "local-wrap" : "declared-source", name: requirement.requestedName, selected: false,
        });
        for (const candidate of requirement.providerCandidates) {
          if (candidate.ref && candidate.ref !== owner["bom-ref"]) remap.set(candidate.ref, [owner["bom-ref"]]);
          candidate.ref = owner["bom-ref"];
        }
        changed(requirement);
        if (requirement.command === "meson-wrap") owner.properties.push(
          { name: "cdx:meson:wrapFile", value: requirement.file },
          { name: "cdx:version:source", value: `${resolve(sourceRoot, requirement.file)}:${requirement.line}` },
        );
        attachRequirement(owner, requirement);
        bindings.push({ component: owner, requirement, previousRefs });
        addOwnerEdge(requirement, owner["bom-ref"]);
        continue;
      }
      for (const candidate of originals) {
        const previousRef = candidate.ref;
        const original = byRef.get(previousRef);
        const replacement = { ...component, properties: [...(original.properties || []).filter((p) => !p.name.startsWith("cdx:version:") && !p.name.startsWith("cdx:source:")), ...(component.properties || [])] };
        candidate.ref = replacement["bom-ref"];
        changed(requirement);
        detachRequirement(replacement, requirement);
        attachRequirement(replacement, requirement);
        const values = replacements.get(previousRef) || []; values.push(replacement); replacements.set(previousRef, values);
        if (previousRef !== replacement["bom-ref"]) remap.set(previousRef, [...new Set([...(remap.get(previousRef) || []), replacement["bom-ref"]])]);
        bindings.push({ component: replacement, requirement, previousRefs });
        addOwnerEdge(requirement, replacement["bom-ref"]);
      }
    }
  }
  const affected = new Set();
  for (const { component, requirement: declaration, previousRefs } of bindings) {
    for (const requirement of requirements) {
      if (requirement === declaration || ["source-declaration", "data-artifact"].includes(requirement.role)) continue;
      const candidates = (requirement.providerCandidates || []).filter((candidate) =>
        candidate.kind === "local-wrap" && candidate.name === declaration.requestedName && candidate.source?.file === declaration.file ||
        candidate.kind === "declared-source" && (previousRefs.includes(candidate.ref) || candidate.ref === component["bom-ref"]));
      if (!candidates.length) continue;
      for (const candidate of candidates) candidate.ref = component["bom-ref"];
      changed(requirement);
      detachRequirement(component, requirement);
      // ExternalProject's build target is consumer evidence, not a package
      // export. Remap its candidate globally just as a passive parse does.
      if (!["build-target", "target-alias"].includes(requirement.role)) affected.add(requirement);
    }
  }
  // A changed source is only one member of an occurrence's retained alternative
  // set. In particular, an unchanged cached wrap may still satisfy the consumer
  // when the newly inspected revision does not. Index explicit declaration links
  // rather than treating arbitrary same-name software or consumer placeholders
  // as source alternatives.
  const currentSources = new Map();
  for (const component of [...pkgList.flatMap((entry) => replacements.get(entry["bom-ref"]) || [entry]), ...created.values()]) {
    if (!component.version || component.properties?.some((property) => property.name === "cdx:build:consumerScope")) continue;
    const owners = currentSources.get(component["bom-ref"]) || [];
    owners.push(component); currentSources.set(component["bom-ref"], owners);
  }
  const sourceDeclarations = new Map();
  const resolvedSourceRefs = (ref) => remap.get(ref) || [ref];
  for (const declaration of requirements) {
    if (declaration.role !== "source-declaration") continue;
    for (const candidate of declaration.providerCandidates || []) {
      if (!candidate.ref) continue;
      for (const ref of resolvedSourceRefs(candidate.ref)) {
        const declarations = sourceDeclarations.get(ref) || [];
        declarations.push(declaration); sourceDeclarations.set(ref, declarations);
      }
    }
  }
  const alternatives = new Map();
  for (const requirement of affected) {
    requirement.providerCandidates = (requirement.providerCandidates || []).flatMap((candidate) =>
      candidate.ref ? resolvedSourceRefs(candidate.ref).map((ref) => ({ ...candidate, ref })) : [candidate]);
    changed(requirement);
    const compatible = new Set();
    for (const candidate of requirement.providerCandidates) {
      if (!candidate.ref) continue;
      const linked = (sourceDeclarations.get(candidate.ref) || []).some((declaration) =>
        candidate.kind === "local-wrap"
          ? declaration.command === "meson-wrap" && declaration.file === candidate.source?.file && declaration.requestedName === candidate.name
          : candidate.kind === "declared-source" && declaration.command !== "meson-wrap");
      if (!linked) continue;
      for (const component of currentSources.get(candidate.ref) || []) {
        detachRequirement(component, requirement);
        // Use the warm parser's exact exclusion predicate; neither availability
        // nor acquisition selects a provider or overrides an occurrence guard.
        if (!options.nativeDependencyFacts && !sourceAlternativeExcluded(component, requirement)) compatible.add(component);
      }
    }
    if (compatible.size) {
      alternatives.set(nativeAcquisitionRequirementKey(requirement), [...new Set([...compatible].map((component) => component["bom-ref"]))]);
      for (const component of compatible) attachRequirement(component, requirement);
    }
  }
  const retainedPlaceholders = new Set();
  for (const component of pkgList) {
    const properties = component.properties || [];
    const kinds = properties.filter((property) => property.name === "cdx:version:kind").map((property) => property.value);
    if (!properties.some((property) => property.name === "cdx:build:consumerScope") ||
      component.version && (!kinds.includes("declared-exact") || kinds.some((kind) => kind !== "declared-exact"))) continue;
    const records = properties.filter((property) => property.name === "cdx:build:requirement");
    const targets = records.flatMap((property) => alternatives.get(nativeAcquisitionRequirementKey(JSON.parse(property.value))) || []);
    const remaining = records.filter((property) => !alternatives.has(nativeAcquisitionRequirementKey(JSON.parse(property.value))));
    for (const property of remaining) retainedPlaceholders.add(nativeAcquisitionRequirementKey(JSON.parse(property.value)));
    if (targets.length) {
      remap.set(component["bom-ref"], [...new Set([...targets, ...(remaining.length ? [component["bom-ref"]] : [])])]);
      if (!remaining.length) { replacements.set(component["bom-ref"], []); continue; }
    }
    const refreshed = properties.filter((property) => property.name !== "cdx:build:requirement" ||
      !alternatives.has(nativeAcquisitionRequirementKey(JSON.parse(property.value)))).map((property) => {
      if (property.name !== "cdx:build:requirement") return property;
      const updated = updatedRequirements.get(nativeAcquisitionRequirementKey(JSON.parse(property.value)));
      return updated ? { ...property, value: JSON.stringify(updated) } : property;
    });
    if (targets.length || refreshed.some((property, index) => property !== properties[index])) replacements.set(component["bom-ref"], [{ ...component, properties: refreshed }]);
  }
  for (const requirement of affected) {
    const key = nativeAcquisitionRequirementKey(requirement);
    if (alternatives.has(key) || retainedPlaceholders.has(key)) continue;
    const materializeRequirement = requirementOwners.get(requirement)?.materializeRequirement;
    if (!materializeRequirement) throw new Error("Retained consumer materialization context is missing");
    const component = materializeRequirement(requirement);
    created.set(component["bom-ref"], component);
    addOwnerEdge(requirement, component["bom-ref"]);
  }
  const refs = (ref) => remap.get(ref) || [ref];
  const graph = new Map();
  for (const edge of [...dependencies, ...addedEdges]) for (const ref of refs(edge.ref)) {
    const current = graph.get(ref) || { ...edge, ref, dependsOn: [], ...(edge.provides ? { provides: [] } : {}) };
    current.dependsOn = [...new Set([...current.dependsOn, ...(edge.dependsOn || []).flatMap(refs)])].filter((target) => target !== ref);
    if (edge.provides) current.provides = [...new Set([...(current.provides || []), ...edge.provides.flatMap(refs)])].filter((target) => target !== ref);
    graph.set(ref, current);
  }
  return { pkgList: pkgList.flatMap((component) => replacements.get(component["bom-ref"]) || [component]).concat([...created.values()]),
    dependencies: [...graph.values()], remap, updatedRequirements };
}
