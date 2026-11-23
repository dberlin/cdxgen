import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

import { parse as loadYaml } from "yaml";

import { readEnvironmentVariable } from "../core/activity.js";
import { readRegularTextFile } from "../core/boundedFile.js";
import { applyPurl, parsePurlLoose, tryBuildPurl } from "../inventory/purl.js";

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
const unique = (items) => [...new Map(items.map((item) => [stable(item), item])).values()];
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
    const enriched = structuredClone(component);
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

function componentIdentity(component, ordinal) {
  const parsed = parsePurlLoose(component.purl || component["bom-ref"]);
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
  if (archiveIdentity && qualifiers.download_url) qualifiers.download_url = archiveIdentity;
  const dimensions = stable({ qualifiers, subpath: occurrencePath ? null : subpath || null,
    artifacts: owner ? [] : [...new Set(identities.map((identity) => identity.artifact).filter(Boolean))].sort(),
    ownerArtifacts: owner ? unique(owners.map((entry) => ({ arch: entry.arch || null, platform: entry.platform || null }))) : [],
    recipeArtifacts: recipes.length ? unique(recipes.map((entry) => ({ kind: entry.kind,
      sourceSha256: entry.sourceSha256 || null, artifacts: entry.artifacts || [],
      portVersion: entry.portVersion ?? null, recipeVersion: entry.recipeVersion || null }))) : [] });
  const patches = (component.properties || []).filter((p) => /(?:patch|dirty|modified|contentDigest|contentHash)/i.test(p.name) &&
    !["false", "0", "[]", "{}", ""].includes(p.value));
  const divergence = stable({ patches: patches.sort((a, b) => stable(a).localeCompare(stable(b))),
    providerPatches: unique(recipes.map((entry) => entry.patchSha256 || entry.patchUrl).filter(Boolean)),
    pedigree: { patches: component.pedigree?.patches || [], ancestors: component.pedigree?.ancestors || [], descendants: component.pedigree?.descendants || [] } });
  let packageKey;
  if (owner) packageKey = stable({ packageManager: owner.packageManager, name: owner.packageName });
  else if (repository) packageKey = stable({ repository, name: component.name || parsed?.name, group: component.group || "", subpath: occurrencePath ? null : subpath || null });
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
  const kinds = propertyValues(component, "cdx:version:kind");
  const revision = kinds.some((kind) => ["source-revision", "archive-revision"].includes(kind));
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
  return { component, ordinal, parsed, packageKey, repository, archiveIdentity, dimensions, divergence, tagEvidence, revision,
    ownedPackageName: packageNames.size === 1 ? [...packageNames][0] : undefined };
}

// Arrays retain independent evidence/requirements; object scalars use the stable
// representative. Original occurrences below retain every conflicting scalar.
function mergeMetadata(target, incoming) {
  for (const [key, value] of Object.entries(incoming)) {
    if (target[key] === undefined) target[key] = structuredClone(value);
    else if (Array.isArray(target[key]) && Array.isArray(value)) target[key] = unique([...target[key], ...structuredClone(value)]);
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

function collectRefs(value, remap, key = "") {
  if (typeof value === "string") {
    if (isRefKey(key) && !remap.has(value)) remap.set(value, value);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { for (const item of value) collectRefs(item, remap, key); return; }
  if (value.name === OCCURRENCE || value.name === RELEASE) return;
  if (typeof value.name === "string" && typeof value.value === "string") {
    if (isRefKey(value.name)) collectRefs(value.value, remap, "ref");
    if (/^\s*[\[{]/.test(value.value)) {
      try { collectRefs(JSON.parse(value.value), remap); } catch { /* Preserve malformed evidence verbatim. */ }
    }
  }
  for (const [name, item] of Object.entries(value)) collectRefs(item, remap, name);
}

function rewriteRefs(value, remap, key = "") {
  if (typeof value === "string") return isRefKey(key) ? remap.get(value)?.[0] || value : value;
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const rewritten = value.flatMap((item) => {
      if (typeof item === "string" && isRefKey(key)) return remap.get(item) || [item];
      if (key === "properties" && isRefKey(item?.name) && remap.get(item.value)?.length > 1) {
        return remap.get(item.value).map((ref) => ({ ...item, value: ref }));
      }
      const refKey = key === "components" ? "bom-ref" : "ref";
      const targets = item && typeof item === "object" && remap.get(item[refKey]);
      if (targets?.length > 1) return targets.map((ref) => ({ ...rewriteRefs(item, remap, key), [refKey]: ref }));
      return [rewriteRefs(item, remap, key)];
    });
    return isRefKey(key) || key === "properties" ? unique(rewritten) : rewritten;
  }
  if (value.name === OCCURRENCE || value.name === RELEASE) return value;
  const rewritten = Object.fromEntries(Object.entries(value).map(([name, item]) =>
    [name, key === "canonicalComponent" && name === "bom-ref" ? item : rewriteRefs(item, remap, name)]));
  if (typeof value.name === "string" && typeof value.value === "string") {
    if (isRefKey(value.name)) rewritten.value = remap.get(value.value)?.[0] || value.value;
    else if (/^\s*[\[{]/.test(value.value)) {
      try {
        const parsed = JSON.parse(value.value);
        const changed = rewriteRefs(parsed, remap);
        if (stable(parsed) !== stable(changed)) rewritten.value = JSON.stringify(changed);
      } catch { /* Non-JSON and malformed metadata are not disposable. */ }
    }
  }
  return rewritten;
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
    if (!entry.repository || !entry.ownedPackageName) continue;
    if (!packageAliases.has(entry.packageKey)) packageAliases.set(entry.packageKey, new Set());
    packageAliases.get(entry.packageKey).add(entry.ownedPackageName);
  }
  for (const entry of entries) {
    const aliases = packageAliases.get(entry.packageKey);
    const name = entry.ownedPackageName || (aliases?.size === 1 ? [...aliases][0] : undefined);
    if (entry.repository && name) entry.packageKey = stable({ ...JSON.parse(entry.packageKey), name });
  }
  const observed = new Map();
  for (const entry of entries) {
    if (!observed.has(entry.packageKey)) observed.set(entry.packageKey, new Set());
    if (!entry.revision) observed.get(entry.packageKey).add(entry.component.version);
  }
  const groups = new Map();
  for (const entry of entries) {
    const original = entry.component.version;
    const plain = typeof original === "string" && original.match(/^v(\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/)?.[1];
    entry.version = plain && entry.tagEvidence && observed.get(entry.packageKey).has(plain) ? plain : original;
    entry.releaseKey = stable({ package: entry.packageKey, version: entry.version, revision: entry.revision, divergence: entry.divergence });
    // Versionless records are requirements/inventory, not releases to consolidate.
    const key = original ? stable([entry.releaseKey, entry.dimensions]) : `unversioned:${entry.ordinal}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  const remap = new Map();
  collectRefs(enriched, remap);
  collectRefs(dependencies, remap);
  collectRefs(parentComponent, remap);
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
      else partition.sort((a, b) => (a.component.purl || a.component["bom-ref"] || "").localeCompare(b.component.purl || b.component["bom-ref"] || ""));
      const representative = partition[0];
      const merged = structuredClone(representative.component);
      for (const entry of partition.slice(1)) mergeMetadata(merged, entry.component);
      const changed = partition.length > 1 || merged.version !== representative.version;
      if (changed) {
        for (const { component } of partition) {
          if (propertyValues(component, OCCURRENCE).length) continue;
          // Live requirements/ref properties are unioned and rewritten, not
          // duplicated as stale candidate refs in historical source snapshots.
          const occurrence = { ...component, properties: (component.properties || []).filter((property) =>
            property.name !== "cdx:build:requirement" && property.name !== OCCURRENCE &&
            property.name !== RELEASE && !isRefKey(property.name)) };
          addProperty(merged, OCCURRENCE, JSON.stringify(occurrence));
        }
        merged.version = representative.version;
        const parsed = representative.parsed;
        const qualifiers = { ...(parsed?.qualifiers || {}) };
        delete qualifiers.vcs_url;
        const dimensions = JSON.parse(representative.dimensions);
        const purl = representative.repository ? tryBuildPurl({ type: "generic", name: merged.name,
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
  for (const { merged, partition } of pending) {
    if (merged.purl) {
      const key = merged.purl.toLowerCase();
      purlCounts.set(key, (purlCounts.get(key) || 0) + 1);
    }
    for (const ref of new Set(partition.map(({ component }) => component["bom-ref"]).filter(Boolean))) {
      incomingRefCounts.set(ref, (incomingRefCounts.get(ref) || 0) + 1);
    }
  }
  const usedRefs = new Set();
  for (const { merged, representative, partition } of pending) {
    const needsInstance = (merged.purl && purlCounts.get(merged.purl.toLowerCase()) > 1) ||
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
    if (ref) { merged["bom-ref"] = ref; usedRefs.add(ref); remap.set(ref, ref); }
    for (const entry of partition) {
      const { component, parsed } = entry;
      if (component["bom-ref"]) aliasesForRef(purlTargets, component["bom-ref"], ref);
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
  const rewriteMap = new Map([...remap].map(([ref, target]) => [ref, [target]]));
  for (const [ref, targets] of purlTargets) rewriteMap.set(ref, [...targets]);
  const rewrittenComponents = components.map((component) => rewriteRefs(component, rewriteMap, "canonicalComponent"));
  const graph = new Map();
  for (const dependency of dependencies) {
    const rewritten = rewriteRefs(dependency, rewriteMap);
    for (const ref of rewriteMap.get(dependency.ref) || [dependency.ref]) {
      const edge = { ...rewritten, ref };
      if (!graph.has(ref)) graph.set(ref, edge);
      else mergeMetadata(graph.get(ref), edge);
    }
  }
  let parent = parentComponent && rewriteRefs(structuredClone(parentComponent), rewriteMap);
  if (parent?.components) {
    const canonical = new Map(rewrittenComponents.map((component) => [component["bom-ref"], component]));
    parent.components = [...new Map(parent.components.map((component) => [component["bom-ref"], canonical.get(component["bom-ref"]) || component])).values()];
  }
  return { pkgList: rewrittenComponents, dependencies: [...graph.values()],
    remap: new Map([...rewriteMap].filter(([oldRef, refs]) => refs.length !== 1 || oldRef !== refs[0])),
    ...(parentComponent ? { parentComponent: parent } : {}) };
}
