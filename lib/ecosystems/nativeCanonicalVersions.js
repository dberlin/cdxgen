import { createHash } from "node:crypto";
import { basename, isAbsolute, join, resolve } from "node:path";

import { parse as loadYaml } from "yaml";

import { readEnvironmentVariable } from "../core/activity.js";
import { readRegularTextFile } from "../core/boundedFile.js";
import { applyPurl, parsePurlLoose, tryBuildPurl } from "../inventory/purl.js";
import { NATIVE_REQUIREMENT_PROPERTY } from "./nativeRequirementEvidence.js";

const RECIPE_REPOSITORY = "https://github.com/conan-io/conan-center-index";
const OCCURRENCE = "cdx:native:canonicalOccurrence";
const RELEASE = "cdx:native:canonicalRelease";
const ARTIFACT = "cdx:native:canonicalArtifact";
const ARTIFACT_IDENTITY = "cdx:native:canonicalArtifactIdentity";
const sourceDirectories = new Set(["cdx:cmake:sourceDir", "cdx:cmake:sourceDirectory", "cdx:cmake:subprojectDir"]);
const stable = (value) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const propertyValues = (component, name) => (component.properties || []).filter((p) => p.name === name).map((p) => p.value);
const numericTagVersion = (value) => typeof value === "string" ? value.match(/^v(\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/)?.[1] : undefined;
const unique = (items) => [...new Map(items.map((item) => [stable(item), item])).values()];
function uniqueProperties(items) {
  if (items.length < 2) return items;
  // Ordinary CycloneDX properties have exactly these two strings. Index the
  // pair directly, rather than re-escaping the (sometimes large) evidence JSON.
  const names = new Map();
  let result;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (typeof item?.name !== "string" || typeof item.value !== "string" ||
      !Object.hasOwn(item, "name") || !Object.hasOwn(item, "value") || Object.keys(item).length !== 2) return unique(items);
    let values = names.get(item.name);
    if (!values) names.set(item.name, values = new Map());
    const existing = values.get(item.value);
    if (existing === undefined) {
      values.set(item.value, result ? result.length : i);
      result?.push(item);
    } else {
      result ||= items.slice(0, i);
      result[existing] = item;
    }
  }
  return result || items;
}

const addProperty = (component, name, value) => {
  component.properties ||= [];
  if (!component.properties.some((p) => p.name === name && p.value === value)) component.properties.push({ name, value });
};

function existingCanonicalArtifact(component) {
  const text = propertyValues(component, ARTIFACT_IDENTITY)[0];
  const hash = propertyValues(component, ARTIFACT)[0];
  if (!component.version || typeof text !== "string" || !/^[a-f0-9]{64}$/.test(hash || "") || digest(text) !== hash || !component.purl) return undefined;
  try {
    if (component["bom-ref"] !== `${decodeURIComponent(component.purl)}#native-canonical-${hash}`) return undefined;
    const identity = JSON.parse(text);
    const releases = propertyValues(component, RELEASE);
    const matchingRelease = releases.includes(identity.release);
    return identity.purl === component.purl && matchingRelease ? identity : undefined;
  } catch { return undefined; }
}

/** Only a declared language owner can claim scoped source identity. A source
 * checkout's ecosystem PURL identifies its package coordinates, not its bytes. */
function languageSourcePackage(component, parsed, kinds) {
  const manifestName = parsed?.type === "cargo" ? "Cargo.toml" :
    parsed?.type === "pypi" ? "pyproject.toml" : undefined;
  if (!manifestName || !component.version || parsed.version !== component.version ||
    !component.purl || !component["bom-ref"] || !kinds.includes("source-project")) return undefined;
  const [instance, otherInstance] = propertyValues(component, "cdx:native:sourceInstance");
  if (typeof instance !== "string" || !/^[a-f0-9]{24}$/.test(instance) || otherInstance !== undefined) return undefined;
  const isManifest = (path) => typeof path === "string" && isAbsolute(path) && resolve(path) === path && basename(path) === manifestName;
  const versionSources = propertyValues(component, "cdx:version:source").filter(isManifest);
  if (!versionSources.length) return undefined;
  const previous = existingCanonicalArtifact(component);
  try {
    const previousRelease = previous && JSON.parse(previous.release);
    const originalRef = `${decodeURIComponent(component.purl)}#native-source-${instance}`;
    for (const path of propertyValues(component, "SrcPath")) {
      if (!isManifest(path) || parsed.type === "pypi" && !versionSources.includes(path)) continue;
      const manifest = digest(path);
      if (!manifest.startsWith(instance)) continue;
      const key = stable({ type: parsed.type, name: parsed.name, sourceManifest: manifest });
      if (component["bom-ref"] === originalRef || previousRelease?.package === key && previousRelease.version === component.version) return key;
    }
  } catch { /* Invalid PURL encoding or canonical provenance cannot establish scope. */ }
  return undefined;
}

/** Repository URLs and explicit GitHub archive URLs are identity evidence; homepages are not. */
function repositoryIdentity(value, distribution = false) {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value.replace(/^git\+/, "").replace(/^git@([^:]+):/, "ssh://git@$1/"));
    if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol) || url.search || url.hash || url.port) return undefined;
    let path = url.pathname.replace(/\/$/, "");
    let tag;
    let artifact;
    if (distribution) {
      if (url.hostname !== "github.com") return undefined;
      const archive = path.match(/^\/([^/]+)\/([^/]+)\/archive\/(?:refs\/tags\/)?([^/]+?)(?:\.tar\.gz|\.zip)$/);
      const release = path.match(/^\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/[^/]+$/);
      const match = archive || release;
      if (!match) return undefined;
      path = `/${match[1]}/${match[2]}`;
      tag = decodeURIComponent(match[3]);
      if (release) artifact = url.toString();
    }
    path = path.replace(/\.git$/, "");
    if (!/^\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(path)) return undefined;
    return { repository: `https://${url.hostname}${url.hostname === "github.com" ? path.toLowerCase() : path}`, tag, artifact };
  } catch { return undefined; }
}

function recipeRecord(name, cacheDirectory) {
  if (!cacheDirectory || !/^[a-zA-Z0-9_+.-]+$/.test(name) || name === "." || name === "..") return undefined;
  const text = readRegularTextFile(join(resolve(cacheDirectory), "conan", `${name}.json`), 2 * 1024 * 1024, cacheDirectory);
  if (!text) return undefined;
  try {
    const record = JSON.parse(text);
    if (record.schema !== 1 || record.repository !== RECIPE_REPOSITORY || record.package !== name ||
      !/^[a-f0-9]{40}$/.test(record.revision || "") || !Array.isArray(record.files) || record.files.length > 64) return undefined;
    const files = new Map();
    for (const file of record.files) {
      if (typeof file.content !== "string" || file.content.length > 512 * 1024 ||
        !/^[a-f0-9]{64}$/.test(file.sha256 || "") || digest(file.content) !== file.sha256 || files.has(file.path)) return undefined;
      files.set(file.path, file);
    }
    const config = files.get(`recipes/${name}/config.yml`);
    if (!config) return undefined;
    return { record, files, config: loadYaml(config.content, { maxAliasCount: 0 }) };
  } catch { return undefined; }
}

/**
 * Enrich exact Conan releases from an explicitly acquired, immutable recipe cache.
 * This never fetches or executes recipes, and an absent/invalid input changes nothing.
 */
export function enrichNativeConanRecipeIdentities(pkgList, cacheDirectory) {
  if (!cacheDirectory) return pkgList;
  const recipes = new Map();
  return pkgList.map((component) => {
    const purl = parsePurlLoose(component.purl);
    if (purl?.type !== "conan" || purl.namespace || !component.version || purl.version !== component.version) return component;
    if (!recipes.has(purl.name)) recipes.set(purl.name, recipeRecord(purl.name, cacheDirectory));
    const recipe = recipes.get(purl.name);
    const folder = recipe?.config?.versions?.[component.version]?.folder;
    if (typeof folder !== "string" || !/^[A-Za-z0-9_.+-]+$/.test(folder) || folder === "." || folder === "..") return component;
    const base = `recipes/${purl.name}/${folder}`;
    const dataFile = recipe.files.get(`${base}/conandata.yml`);
    const codeFile = recipe.files.get(`${base}/conanfile.py`);
    if (!dataFile || !codeFile) return component;
    let data;
    try { data = loadYaml(dataFile.content, { maxAliasCount: 0 }); } catch { return component; }
    const source = data?.sources?.[component.version];
    if (!source || !/^[a-f0-9]{64}$/i.test(source.sha256 || "")) return component;
    const urls = Array.isArray(source.url) ? source.url : [source.url];
    const links = urls.filter((url) => typeof url === "string" && repositoryIdentity(url, true));
    if (!links.length) return component;
    // A recipe for a different tag/version must not silently relabel a package.
    const spelling = (version) => version.replace(/^v(?=\d+(?:\.\d+)+$)/, "");
    if (links.some((url) => spelling(repositoryIdentity(url, true).tag || "") !== spelling(component.version))) return component;
    const enriched = cloneNativeMetadata(component);
    enriched.externalReferences = unique([...(enriched.externalReferences || []), ...links.map((url) => ({
      type: "distribution", url, hashes: [{ alg: "SHA-256", content: source.sha256.toLowerCase() }],
    }))]);
    addProperty(enriched, "cdx:native:recipeEvidence", JSON.stringify({
      repository: recipe.record.repository, revision: recipe.record.revision, package: purl.name, version: component.version,
      files: [`recipes/${purl.name}/config.yml`, dataFile.path, codeFile.path].map((path) => ({
        path, sha256: recipe.files.get(path).sha256,
        url: `https://raw.githubusercontent.com/conan-io/conan-center-index/${recipe.record.revision}/${path}`,
      })), sourceUrls: links, sourceSha256: source.sha256.toLowerCase(),
    }));
    const patches = data.patches?.[component.version];
    if (Array.isArray(patches) && patches.length) addProperty(enriched, "cdx:native:recipePatches", stable(patches));
    return enriched;
  });
}

// These proofs come from the existing passive archive reader, which rehashes
// the original compressed bytes. No archive IO or unpacking belongs here.
function verifiedArchiveBytes(component, parsed, repository) {
  if (!repository || !["generic", "github"].includes(parsed?.type)) return undefined;
  const records = propertyValues(component, "cdx:native:archiveIdentityEvidence");
  if (!records.length || !propertyValues(component, "cdx:cmake:depKind").some((kind) => ["fetch", "external-project", "cpm"].includes(kind))) return undefined;
  const references = (component.externalReferences || []).filter((ref) => ["distribution", "distribution-intake"].includes(ref.type));
  const download = parsed.qualifiers?.download_url;
  if (!references.length || (download && !references.some((ref) => ref.url === download))) return undefined;
  const expectedVersion = numericTagVersion(component.version) || component.version;
  const urls = new Set();
  let bytes;
  for (const text of records) {
    let proof;
    try { proof = JSON.parse(text); } catch { continue; }
    if (typeof proof?.url !== "string" || !references.some((ref) => ref.url === proof.url) || !Array.isArray(proof.fields)) continue;
    const field = (key) => proof.fields.find((entry) => entry?.field === key)?.value;
    const name = field("project.name");
    const sha256 = proof.archive?.sha256;
    if (typeof name !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/.test(name) ||
      typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256) ||
      field("project.version") !== expectedVersion || field("header.version") !== expectedVersion ||
      repositoryIdentity(field("repository"))?.repository !== repository) continue;
    if (bytes && (bytes.name !== name || bytes.sha256 !== sha256)) return undefined;
    bytes = { name, sha256 };
    urls.add(proof.url);
  }
  if (!bytes || !references.every((ref) => urls.has(ref.url))) return undefined;
  // The current archive receipt attests SHA-256 only. A different declared
  // digest is not evidence that this cache entry satisfies that pin.
  const conflicts = (hashes) => hashes?.some((hash) => hash.alg !== "SHA-256" ||
    typeof hash.content !== "string" || hash.content.toLowerCase() !== bytes.sha256);
  if (conflicts(component.hashes) || references.some((ref) => conflicts(ref.hashes))) return undefined;
  return { ...bytes, version: expectedVersion, upstream: Boolean(download && repositoryIdentity(download, true)?.artifact) };
}

function signedDebPackageSha256(owner) {
  return owner.kind === "package-manifest" && owner.packageManager === "dpkg" &&
    typeof owner.repositoryEvidence?.releaseSha256 === "string" && /^[a-f0-9]{64}$/.test(owner.repositoryEvidence.releaseSha256) &&
    typeof owner.packageSha256 === "string" && /^[a-f0-9]{64}$/.test(owner.packageSha256) ? owner.packageSha256 : undefined;
}

function componentIdentity(component, ordinal) {
  const parsed = parsePurlLoose(component.purl || component["bom-ref"]);
  const kinds = propertyValues(component, "cdx:version:kind");
  const languageSource = languageSourcePackage(component, parsed, kinds);
  const providers = propertyValues(component, "cdx:native:providerEvidence").flatMap((value) => {
    try {
      const provider = JSON.parse(value);
      return provider?.packageName === component.name && provider.version === component.version ? [provider] : [];
    } catch { return []; }
  });
  const owners = providers.filter((provider) => ["installed-package-file", "package-manifest"].includes(provider.kind) &&
    ["rpm", "dpkg"].includes(provider.packageManager));
  const ownerKeys = new Set(owners.map((owner) => stable([owner.packageManager, owner.packageName])));
  const owner = ownerKeys.size === 1 ? owners[0] : undefined;
  const recipes = providers.filter((provider) => ["wrapdb-recipe", "vcpkg-recipe"].includes(provider.kind));
  const recipeKinds = new Set(recipes.map((recipe) => recipe.kind));
  const recipe = recipeKinds.size === 1 ? recipes[0] : undefined;
  const repositories = [];
  if (parsed?.qualifiers?.vcs_url) repositories.push(repositoryIdentity(parsed.qualifiers.vcs_url));
  if (parsed?.type === "github" && parsed.namespace) repositories.push(repositoryIdentity(`https://github.com/${parsed.namespace}/${parsed.name}`));
  for (const reference of component.externalReferences || []) {
    if (reference.type === "vcs") repositories.push(repositoryIdentity(reference.url));
    if (["distribution", "distribution-intake"].includes(reference.type)) repositories.push(repositoryIdentity(reference.url, true));
  }
  if (!owner) for (const provider of recipes) if (provider.sourceUrl) repositories.push(repositoryIdentity(provider.sourceUrl, true));
  const identities = repositories.filter(Boolean);
  const repositoryNames = [...new Set(identities.map((i) => i.repository))];
  // Requirement-file provenance inherited by an installed provider is not its
  // source repository. Exact package ownership metadata has priority.
  const repository = !owner && repositoryNames.length === 1 ? repositoryNames[0] : undefined;
  const directories = (component.properties || []).filter((p) => sourceDirectories.has(p.name)).map((p) => p.value);
  const subpath = parsed?.subpath;
  const occurrencePath = parsed?.type === "generic" && subpath && directories.includes(subpath);
  const archiveBytes = !owner && !recipe && verifiedArchiveBytes(component, parsed, repository);
  let archiveIdentity;
  if (!owner && !repository && parsed?.type === "generic" &&
    propertyValues(component, "cdx:cmake:depKind").some((kind) => ["fetch", "external-project", "cpm"].includes(kind))) {
    const archiveUrls = new Set([parsed.qualifiers?.download_url,
      ...(component.externalReferences || []).filter((reference) => reference.type === "distribution").map((reference) => reference.url)]
      .flatMap((value) => {
        if (typeof value !== "string") return [];
        try {
          const url = new URL(value);
          return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? [url.href] : [];
        } catch { return []; }
      }));
    if (archiveUrls.size === 1) archiveIdentity = [...archiveUrls][0];
  }
  const qualifiers = { ...(parsed?.qualifiers || {}) };
  delete qualifiers.vcs_url;
  if (archiveBytes) delete qualifiers.download_url;
  if (archiveIdentity && qualifiers.download_url) qualifiers.download_url = archiveIdentity;
  const dimensions = stable({ qualifiers, subpath: occurrencePath ? null : subpath || null,
    artifacts: owner ? [] : archiveBytes ? [`sha256:${archiveBytes.sha256}`] :
      [...new Set(identities.map((identity) => identity.artifact).filter(Boolean))].sort(),
    ownerArtifacts: owner ? unique(owners.map((entry) => ({ arch: entry.arch || null, platform: entry.platform || null,
      packageSha256: signedDebPackageSha256(entry) }))) : [],
    recipeArtifacts: recipes.length ? unique(recipes.map((entry) => ({ kind: entry.kind,
      sourceSha256: entry.sourceSha256 || null, artifacts: entry.artifacts || [],
      portVersion: entry.portVersion ?? null, recipeVersion: entry.recipeVersion || null }))) : [] });
  const patches = (component.properties || []).filter((p) => /(?:patch|dirty|modified|contentDigest|contentHash)/i.test(p.name) &&
    !["false", "0", "[]", "{}", ""].includes(p.value));
  const divergence = stable({ patches: patches.sort((a, b) => stable(a).localeCompare(stable(b))),
    providerPatches: unique(recipes.map((entry) => entry.patchSha256 || entry.patchUrl).filter(Boolean)),
    pedigree: { patches: component.pedigree?.patches || [], ancestors: component.pedigree?.ancestors || [], descendants: component.pedigree?.descendants || [] } });
  let packageKey;
  if (languageSource) packageKey = languageSource;
  else if (owner) packageKey = stable({ packageManager: owner.packageManager, name: owner.packageName });
  else if (repository) packageKey = stable({ repository, name: archiveBytes?.name || component.name || parsed?.name,
    group: component.group || "", subpath: occurrencePath ? null : subpath || null });
  else if (recipe) packageKey = stable({ registry: recipe.kind, name: recipe.packageName });
  else if (archiveIdentity) packageKey = stable({ archive: archiveIdentity, name: (component.name || parsed.name).toLowerCase(),
    group: component.group || "", subpath: occurrencePath ? null : subpath || null });
  else if (parsed && parsed.type !== "generic" && repositoryNames.length === 0) packageKey = stable({
    type: parsed.type, namespace: parsed.namespace, name: parsed.name, subpath: subpath || null,
  });
  else {
    // A validated canonical instance keeps its original local identity when a
    // second pass sees the minted artifact ref instead of the source-instance ref.
    const previous = existingCanonicalArtifact(component);
    try {
      const previousPackage = previous && JSON.parse(previous.release).package;
      if (typeof previousPackage === "string" && Object.hasOwn(JSON.parse(previousPackage), "local")) packageKey = previousPackage;
    } catch { /* Untrusted marker contents are not identity evidence. */ }
    packageKey ||= stable({ local: component["bom-ref"] || component.purl || ordinal, directories, ordinal: component["bom-ref"] || component.purl ? undefined : ordinal });
  }
  const revision = kinds.some((kind) => ["source-revision", "archive-revision", "artifact-revision"].includes(kind));
  const tagEvidence = !revision && (kinds.includes("source-tag") || propertyValues(component, "cdx:cmake:gitRef").includes(component.version) ||
    identities.some((identity) => identity.tag === component.version));
  const packageNames = new Set(propertyValues(component, "cdx:native:packageIdentity").flatMap((value) => {
    try {
      const identity = JSON.parse(value);
      return repository && identity?.schema === 1 && /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/.test(identity.name || "") &&
        typeof identity.source === "string" && identity.source.length && typeof identity.exportSource === "string" && identity.exportSource.length &&
        (!identity.repository || repositoryIdentity(identity.repository)?.repository === repository) ? [identity.name] : [];
    } catch { return []; }
  }));
  return { component, ordinal, parsed, packageKey, repository, archiveIdentity, archiveBytes, dimensions, divergence, tagEvidence, revision, languageSource,
    ownedPackageName: packageNames.size === 1 ? [...packageNames][0] : undefined };
}

// Native BOM metadata is plain JSON data. Preserve aliases within the copy and
// share immutable strings instead of encoding evidence through structuredClone.
function cloneNativeMetadata(value, seen) {
  if (!value || typeof value !== "object") return value;
  seen ??= new WeakMap();
  const prior = seen.get(value);
  if (prior) return prior;
  const array = Array.isArray(value);
  const prototype = array ? undefined : Object.getPrototypeOf(value);
  if (!array && prototype !== Object.prototype && prototype !== null) {
    const copy = structuredClone(value);
    seen.set(value, copy);
    return copy;
  }
  const copy = array ? new Array(value.length) : {};
  seen.set(value, copy);
  for (const key of Object.keys(value)) {
    const child = value[key];
    const cloned = child && typeof child === "object" ? cloneNativeMetadata(child, seen) : child;
    if (key === "__proto__") Object.defineProperty(copy, key, { value: cloned, enumerable: true, configurable: true, writable: true });
    else copy[key] = cloned;
  }
  return copy;
}

// Arrays retain independent evidence/requirements; object scalars use the stable
// representative. Original occurrences below retain every conflicting scalar.
function mergeMetadata(target, incoming) {
  for (const [key, value] of Object.entries(incoming)) {
    if (target[key] === undefined) target[key] = cloneNativeMetadata(value);
    else if (Array.isArray(target[key]) && Array.isArray(value)) {
      const combined = [...target[key], ...cloneNativeMetadata(value)];
      target[key] = key === "properties" ? uniqueProperties(combined) : unique(combined);
    }
    else if (target[key] && value && typeof target[key] === "object" && typeof value === "object" && !Array.isArray(target[key]) && !Array.isArray(value)) mergeMetadata(target[key], value);
  }
  return target;
}

function hashSignature(component) {
  return stable(unique((component.hashes || []).map((h) => ({ alg: h.alg, content: h.content.toLowerCase() }))).sort((a, b) => stable(a).localeCompare(stable(b))));
}

function isRefKey(key) {
  return key === "ref" || key === "bom-ref" || key === "reference" || key === "dependsOn" || key === "provides" || /(?:Ref|Refs|Reference|References)$/.test(key);
}

// Use identity for unmodified subtrees; expansion followed by de-duplication
// can also produce structurally identical JSON (with different object order).
function equalJson(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object" ||
    Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && equalJson(left[key], right[key]));
}

function rewriteSerializedProperty(text, remap, cache, requirement) {
  if (requirement) {
    const cached = cache.requirements.get(text);
    if (cached !== undefined) return cached;
  }
  // Large properties can recur on every provider and in the parent. Store
  // only exact strings under this invocation's final ref map, never parsed
  // graphs. Bound both string retention (UTF-16 code units) and entry overhead.
  const maxChars = 32 * 1024 * 1024;
  const maxEntries = 2048;
  const memoize = !requirement && text.length >= 4096 && text.length <= maxChars;
  if (memoize) {
    const cached = cache.values.get(text);
    if (cached !== undefined) {
      cache.values.delete(text);
      cache.values.set(text, cached);
      return cached;
    }
  }
  let result = text;
  try {
    const parsed = JSON.parse(text);
    const changed = rewriteRefs(parsed, remap, cache);
    if (!equalJson(parsed, changed)) result = JSON.stringify(changed);
  } catch { /* Non-JSON and malformed metadata are not disposable. */ }
  if (requirement) cache.requirements.set(text, result);
  else if (memoize) {
    const chars = text.length + (result === text ? 0 : result.length);
    if (chars <= maxChars) {
      for (const [key, value] of cache.values) {
        if (cache.chars + chars <= maxChars && cache.values.size < maxEntries) break;
        cache.values.delete(key);
        cache.chars -= key.length + (value === key ? 0 : value.length);
      }
      cache.values.set(text, result);
      cache.chars += chars;
    }
  }
  return result;
}

function rewriteRefs(value, remap, cache, key = "") {
  if (typeof value === "string") return isRefKey(key) ? remap.get(value)?.[0] || value : value;
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    let rewritten;
    const refArray = isRefKey(key);
    const properties = key === "properties";
    const refKey = key === "components" ? "bom-ref" : "ref";
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      const replacement = typeof item === "string" && refArray ? remap.get(item) :
        properties && isRefKey(item?.name) && remap.get(item.value)?.length > 1 ?
          remap.get(item.value).map((ref) => ({ ...item, value: ref })) : undefined;
      const targets = !replacement && item && typeof item === "object" && remap.get(item[refKey]);
      if (replacement || targets?.length > 1) {
        rewritten ||= value.slice(0, i);
        if (replacement) for (const ref of replacement) rewritten.push(ref);
        else {
          const updated = rewriteRefs(item, remap, cache, key);
          for (const ref of targets) rewritten.push({ ...cloneNativeMetadata(updated), [refKey]: ref });
        }
      } else {
        const itemRewritten = rewriteRefs(item, remap, cache, key);
        if (itemRewritten !== item) rewritten ||= value.slice(0, i);
        rewritten?.push(itemRewritten);
      }
    }
    const items = rewritten || value;
    if (properties) return uniqueProperties(items);
    if (refArray && items.length > 1) {
      const deduplicated = unique(items);
      if (deduplicated.length !== items.length) return deduplicated;
    }
    return items;
  }
  if (value.name === OCCURRENCE || value.name === RELEASE) return value;
  let rewritten;
  for (const name of Object.keys(value)) {
    if (key === "canonicalComponent" && name === "bom-ref") continue;
    const item = rewriteRefs(value[name], remap, cache, name);
    if (item !== value[name]) (rewritten ||= { ...value })[name] = item;
  }
  if (typeof value.name === "string" && typeof value.value === "string") {
    if (isRefKey(value.name)) {
      const ref = remap.get(value.value)?.[0];
      if (ref && ref !== value.value) (rewritten ||= { ...value }).value = ref;
    } else if (/^\s*[\[{]/.test(value.value)) {
      const text = rewriteSerializedProperty(value.value, remap, cache, value.name === NATIVE_REQUIREMENT_PROPERTY);
      if (text !== value.value) (rewritten ||= { ...value }).value = text;
    }
  }
  return rewritten || value;
}

function aliasesForRef(targets, alias, ref) {
  if (!alias || !ref) return;
  if (!targets.has(alias)) targets.set(alias, new Set());
  targets.get(alias).add(ref);
}

/**
 * Consolidate equivalent native releases without selecting providers or inventing
 * versions. Scan-relative source copies become occurrence provenance. Material
 * artifact dimensions, patches, and conflicting hashes remain separate records.
 * The remap contains every changed reference as an array (including alternatives
 * when an input ref was shared by non-equivalent artifacts);
 * unchanged references are implicit, and a no-op returns an empty map.
 */
export function canonicalizeNativeComponents(pkgList, dependencies = [], parentComponent) {
  const enriched = enrichNativeConanRecipeIdentities(pkgList,
    readEnvironmentVariable("CDXGEN_NATIVE_CANONICAL_CACHE"));
  const entries = enriched.map(componentIdentity);
  // A repository basename is not necessarily its exported package name. Scope
  // explicit owner-root export evidence to that repository/name/subpackage only;
  // conflicting monorepo aliases never authorize a global name join.
  const packageAliases = new Map();
  for (const entry of entries) {
    if (entry.languageSource || !entry.repository || !entry.ownedPackageName) continue;
    if (!packageAliases.has(entry.packageKey)) packageAliases.set(entry.packageKey, new Set());
    packageAliases.get(entry.packageKey).add(entry.ownedPackageName);
  }
  for (const entry of entries) {
    const aliases = packageAliases.get(entry.packageKey);
    const name = entry.ownedPackageName || (aliases?.size === 1 ? [...aliases][0] : undefined);
    if (!entry.languageSource && entry.repository && name) entry.packageKey = stable({ ...JSON.parse(entry.packageKey), name });
  }
  const observed = new Map();
  for (const entry of entries) {
    if (!observed.has(entry.packageKey)) observed.set(entry.packageKey, new Set());
    if (!entry.revision) observed.get(entry.packageKey).add(entry.component.version);
  }
  const groups = new Map();
  for (const entry of entries) {
    const original = entry.component.version;
    const plain = numericTagVersion(original);
    entry.version = plain && !entry.revision && (entry.archiveBytes?.version === plain ||
      entry.tagEvidence && observed.get(entry.packageKey).has(plain)) ? plain : original;
    entry.releaseKey = stable({ package: entry.packageKey, version: entry.version, revision: entry.revision, divergence: entry.divergence });
    // Versionless records are requirements/inventory, not releases to consolidate.
    const key = original ? stable([entry.releaseKey, entry.dimensions]) : `unversioned:${entry.ordinal}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  const components = [];
  const purlTargets = new Map();
  const pending = [];
  for (const group of groups.values()) {
    const hashes = new Map();
    for (const { component } of group) for (const hash of component.hashes || []) {
      if (!hashes.has(hash.alg)) hashes.set(hash.alg, new Set());
      hashes.get(hash.alg).add(hash.content.toLowerCase());
    }
    const conflictingHashes = [...hashes.values()].some((values) => values.size > 1);
    const partitions = new Map();
    for (const entry of group) {
      const key = conflictingHashes ? hashSignature(entry.component) : "";
      if (!partitions.has(key)) partitions.set(key, []);
      partitions.get(key).push(entry);
    }
    for (const partition of partitions.values()) {
      // CMake source-declaration aliases are case-insensitive. Identical archive
      // evidence authorizes the join; the first declaration keeps display casing.
      if (partition[0].archiveIdentity) partition.sort((a, b) => a.ordinal - b.ordinal);
      else partition.sort((a, b) => Number(Boolean(b.archiveBytes?.upstream)) - Number(Boolean(a.archiveBytes?.upstream)) ||
        (a.component.purl || a.component["bom-ref"] || "").localeCompare(b.component.purl || b.component["bom-ref"] || ""));
      const representative = partition[0];
      const merged = cloneNativeMetadata(representative.component);
      for (const entry of partition.slice(1)) mergeMetadata(merged, entry.component);
      const changed = partition.length > 1 || merged.version !== representative.version;
      if (changed) {
        for (const { component } of partition) {
          if (propertyValues(component, OCCURRENCE).length) continue;
          // Live requirements/ref properties are unioned and rewritten, not
          // duplicated as stale candidate refs in historical source snapshots.
          const occurrence = { ...component, properties: (component.properties || []).filter((property) =>
            property.name !== NATIVE_REQUIREMENT_PROPERTY && property.name !== OCCURRENCE &&
            property.name !== RELEASE && !isRefKey(property.name)) };
          addProperty(merged, OCCURRENCE, JSON.stringify(occurrence));
        }
        merged.version = representative.version;
        const parsed = representative.parsed;
        const qualifiers = { ...(parsed?.qualifiers || {}) };
        delete qualifiers.vcs_url;
        const dimensions = JSON.parse(representative.dimensions);
        const purl = representative.repository && !representative.languageSource ? tryBuildPurl({ type: "generic", name: merged.name,
          namespace: merged.group || null, version: merged.version,
          qualifiers: { ...qualifiers, vcs_url: representative.repository }, subpath: dimensions.subpath }) :
          parsed && parsed.type !== "generic" && tryBuildPurl({ ...parsed, version: merged.version });
        if (purl) applyPurl(merged, purl);
      }
      if (merged.version) {
        merged.properties = (merged.properties || []).filter((property) => property.name !== RELEASE);
        addProperty(merged, RELEASE, representative.releaseKey);
      }
      pending.push({ merged, representative, partition });
    }
  }
  const purlCounts = new Map();
  const incomingRefCounts = new Map();
  for (const { merged, representative, partition } of pending) {
    if (merged.purl && !representative.languageSource) {
      const key = merged.purl.toLowerCase();
      purlCounts.set(key, (purlCounts.get(key) || 0) + 1);
    }
    for (const ref of new Set(partition.map(({ component }) => component["bom-ref"]).filter(Boolean))) {
      incomingRefCounts.set(ref, (incomingRefCounts.get(ref) || 0) + 1);
    }
  }
  const usedRefs = new Set();
  for (const { merged, representative, partition } of pending) {
    const needsInstance = representative.languageSource || (merged.purl && purlCounts.get(merged.purl.toLowerCase()) > 1) ||
      partition.some(({ component }) => incomingRefCounts.get(component["bom-ref"]) > 1) ||
      propertyValues(merged, ARTIFACT).length > 0;
    let ref = merged["bom-ref"];
    if (merged.version && (needsInstance || ref && usedRefs.has(ref))) {
      const identity = { purl: merged.purl || null, release: representative.releaseKey,
        dimensions: representative.dimensions, hashes: hashSignature(merged) };
      let collision = 0;
      let text;
      let hash;
      do {
        text = stable(collision ? { ...identity, collision } : identity);
        hash = digest(text);
        ref = merged.purl ? `${decodeURIComponent(merged.purl)}#native-canonical-${hash}` :
          `${merged["bom-ref"] || "native-artifact"}:native-variant:${hash}`;
        collision++;
      } while (usedRefs.has(ref));
      if (merged.purl) {
        merged.properties = (merged.properties || []).filter((property) => ![ARTIFACT, ARTIFACT_IDENTITY].includes(property.name));
        addProperty(merged, ARTIFACT_IDENTITY, text);
        addProperty(merged, ARTIFACT, hash);
      }
    }
    if (!merged.version && (propertyValues(merged, ARTIFACT).length || propertyValues(merged, ARTIFACT_IDENTITY).length)) {
      merged.properties = merged.properties.filter((property) => ![ARTIFACT, ARTIFACT_IDENTITY].includes(property.name));
    }
    if (ref) { merged["bom-ref"] = ref; usedRefs.add(ref); }
    for (const entry of partition) {
      const { component, parsed } = entry;
      if (component["bom-ref"]) aliasesForRef(purlTargets, component["bom-ref"], ref);
      // An unscoped coordinate (or inherited generic consumer ref) cannot
      // identify the checkout and may already identify another component.
      if (entry.languageSource) continue;
      const aliases = [component.purl];
      for (const alias of propertyValues(component, "cdx:cmake:sourceProjectRef")) {
        const owner = parsePurlLoose(alias);
        if (owner?.type === "generic" && owner.name === parsed?.name && owner.version === component.version &&
          owner.subpath === parsed?.subpath && (!owner.qualifiers?.vcs_url ||
            repositoryIdentity(owner.qualifiers.vcs_url)?.repository === entry.repository)) aliases.push(alias);
      }
      for (const alias of aliases.filter(Boolean)) aliasesForRef(purlTargets, alias, ref);
    }
    components.push(merged);
  }
  const rewriteMap = new Map();
  for (const [ref, targets] of purlTargets) {
    if (targets.size !== 1 || !targets.has(ref)) rewriteMap.set(ref, [...targets]);
  }
  // Requirements recur on all their candidate owners. Rewrite each distinct
  // value once without changing the component objects or serialized evidence.
  const rewriteCache = { requirements: new Map(), values: new Map(), chars: 0 };
  const rewrittenComponents = components.map((component) =>
    rewriteRefs(component, rewriteMap, rewriteCache, "canonicalComponent"));
  const graph = new Map();
  for (const dependency of dependencies) {
    const rewritten = rewriteRefs(cloneNativeMetadata(dependency), rewriteMap, rewriteCache);
    for (const ref of rewriteMap.get(dependency.ref) || [dependency.ref]) {
      const edge = { ...rewritten, ref };
      if (!graph.has(ref)) graph.set(ref, edge);
      else mergeMetadata(graph.get(ref), edge);
    }
  }
  let parent = parentComponent && rewriteRefs(cloneNativeMetadata(parentComponent), rewriteMap, rewriteCache);
  if (parent?.components) {
    const canonical = new Map(rewrittenComponents.map((component) => [component["bom-ref"], component]));
    parent.components = [...new Map(parent.components.map((component) => [component["bom-ref"], canonical.get(component["bom-ref"]) || component])).values()];
  }
  return { pkgList: rewrittenComponents, dependencies: [...graph.values()],
    remap: rewriteMap,
    ...(parentComponent ? { parentComponent: parent } : {}) };
}
