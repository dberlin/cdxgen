import { closeSync, lstatSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { hashRegularFile, openRegularFile } from "../core/boundedFile.js";
import { sourceRootOf } from "../inventory/sourceRevision.js";
import { applyPurl, tryBuildPurl } from "../inventory/purl.js";
import { nativeFactsHash } from "./nativeDependencyFacts.js";

const manifestLimit = 1024 * 1024;
const fileLimit = 32 * 1024 * 1024;
const evidenceLimit = 64 * 1024 * 1024;
const bundleLimit = 16;
const digest = /^[a-f0-9]{64}$/;
const token = /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/;
const targetName = /^[A-Za-z0-9_][A-Za-z0-9_.+:@-]*$/;
const validToken = (value) => typeof value === "string" && value.length <= 255 && token.test(value);
const memberPath = (value) => typeof value === "string" && value.length <= 4096 &&
  value.split("/").every((part) => part !== "." && part !== ".." && /^[A-Za-z0-9_.+-]+$/.test(part));
const absolutePath = (value) => typeof value === "string" && value.length <= 4096 && isAbsolute(value) && resolve(value) === value;
const within = (root, path) => {
  const member = relative(root, path);
  return !isAbsolute(member) && member !== ".." && !member.startsWith(`..${sep}`);
};

function readPinnedManifest(path, root, sha256) {
  const file = openRegularFile(path, root);
  if (!file) return undefined;
  try {
    if (!file.size || file.size > manifestLimit) return undefined;
    const bytes = Buffer.alloc(file.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(file.fd, bytes, offset, bytes.length - offset, offset);
      if (!count) return undefined;
      offset += count;
    }
    return nativeFactsHash(bytes) === sha256 ? JSON.parse(bytes.toString("utf8")) : undefined;
  } finally {
    closeSync(file.fd);
  }
}

function finderReceiptOutput(record) {
  const { occurrence, output } = record;
  const args = occurrence.arguments;
  if (output?.mode === "meson-fallback") {
    // This is a local subproject declaration, not a global pkg-config alias.
    if (occurrence.command !== "dependency" || occurrence.role !== "software" ||
      !validToken(output.name) || output.name !== occurrence.requestedName || !validToken(output.member) ||
      !validToken(output.dependencyVariable) || !memberPath(output.wrap) || !memberPath(output.patch) ||
      output.interfaceVersion !== undefined || !Array.isArray(record.sourceInputs)) return undefined;
    const packageName = basename(output.wrap, ".wrap");
    const subprojects = dirname(output.wrap);
    if (!output.wrap.endsWith(".wrap") || basename(subprojects) !== "subprojects" || !validToken(packageName) ||
      output.patch !== join(subprojects, "packagefiles", packageName, "meson.build") ||
      (dirname(subprojects) !== "." && !occurrence.file.startsWith(`${dirname(subprojects)}/`)) ||
      ![output.wrap, output.patch].every((file) => record.sourceInputs.some((input) => input?.file === file))) return undefined;
    const alternatives = occurrence.mesonOptions?.fallback?.alternatives;
    if (!Array.isArray(alternatives)) return undefined;
    const matches = alternatives.filter((entry) =>
      Array.isArray(entry?.value) && entry.value.length === 2 && entry.value[0] === packageName &&
      entry.value[1] === output.dependencyVariable && Array.isArray(entry.conditions) &&
      entry.conditions.every((condition) => typeof condition === "string"));
    if (matches.length !== 1) return undefined;
    return { lookup: { kind: "finder-owner" }, output: { name: output.name, mode: output.mode, member: output.member,
      wrap: output.wrap, patch: output.patch, dependencyVariable: output.dependencyVariable, conditions: matches[0].conditions } };
  }
  if (output?.mode === "program") {
    // An explicit operator receipt can describe a real product in a
    // non-default PATH directory. No receipt can relax source search controls.
    if (occurrence.command !== "find_program" || !["tool", "software"].includes(occurrence.role) ||
      !Array.isArray(args) || !validToken(output.name) || output.name !== occurrence.requestedName ||
      !absolutePath(output.member) || basename(output.member) !== output.name ||
      output.interfaceVersion !== undefined || occurrence.constraints) return undefined;
    const nameAt = args[1] === "NAMES" || args[1] === "NAME" ? 2 : 1;
    if (!validToken(args[0]) || args[nameAt] !== output.name) return undefined;
    for (let index = nameAt + 1; index < args.length; index++) {
      if (args[index] === "DOC" && typeof args[index + 1] === "string") index++;
      else if (!["REQUIRED", "OPTIONAL", "NO_CACHE"].includes(args[index])) return undefined;
    }
    return { lookup: { kind: "finder-owner" }, output: { name: output.name, mode: "program", member: output.member } };
  }
  if (output?.mode === "meson-dependency") {
    // A native build declaration can identify an owner without proving that
    // Meson can discover its package metadata. Scope that alternative to the
    // bare dependency occurrence; do not bypass explicit method or options.
    if (occurrence.command !== "dependency" || occurrence.role !== "software" ||
      !validToken(output.name) || output.name !== occurrence.requestedName ||
      !Array.isArray(args) || args.length !== 1 ||
      args[0] !== `'${output.name}'` && args[0] !== `"${output.name}"` ||
      !absolutePath(output.member) && !memberPath(output.member) ||
      output.interfaceVersion !== undefined || occurrence.constraints) return undefined;
    return { lookup: { kind: "finder-owner" }, output: { name: output.name, mode: output.mode, member: output.member } };
  }
  if (occurrence.role !== "software" || occurrence.command !== "find_package" ||
    !Array.isArray(args) || args[0] !== occurrence.requestedName || !validToken(output?.name) ||
    output.name !== occurrence.requestedName || !absolutePath(output.member) && !memberPath(output.member) ||
    output.interfaceVersion !== undefined && !validToken(output.interfaceVersion)) return undefined;
  const config = args.some((arg) => ["CONFIG", "NO_MODULE", "NAMES", "CONFIGS"].includes(arg));
  const mode = output.mode || (config ? "config" : "module");
  if (!["config", "module"].includes(mode) || mode === "module" && config || mode === "config" && args.includes("MODULE")) return undefined;
  return { lookup: { kind: "finder-owner" }, output: { name: output.name, mode, member: output.member,
    ...(output.interfaceVersion ? { interfaceVersion: output.interfaceVersion } : {}) } };
}

function receiptOutput(record, evidence) {
  const { occurrence, lookup, output } = record;
  const args = occurrence.arguments;
  if (!lookup || !output || output.name !== occurrence.requestedName || !validToken(output.name) ||
    typeof output.target !== "string" || output.target.length > 255 || !targetName.test(output.target) ||
    !absolutePath(lookup.root) || typeof lookup.configuration !== "string" || !digest.test(lookup.configuration) ||
    !Array.isArray(args)) return undefined;
  if (lookup.kind === "restricted-install-plan") {
    // An executable planned by an isolated configure is not an installed
    // executable. Admit only the literal single-name, single-root search
    // described by the capture; never widen its program search.
    if (occurrence.role !== "tool" || occurrence.command !== "find_program" || occurrence.constraints ||
      args.length !== 6 || !validToken(args[0]) || args[1] !== "NAMES" || args[2] !== output.name ||
      args[3] !== "PATHS" || args[4] !== lookup.root || args[5] !== "NO_DEFAULT_PATH" ||
      !evidence.has(output.file) || ![...evidence.values()].includes(lookup.configuration) ||
      !absolutePath(output.capturedFile) || output.capturedFile !== join(lookup.root, output.name)) return undefined;
    const alias = output.alias;
    if (alias !== undefined && (!alias || alias.kind !== "relative-symlink" || !validToken(alias.target) ||
      alias.target === output.name || !Number.isSafeInteger(alias.sourceLine) || alias.sourceLine < 1)) return undefined;
    return { lookup: { kind: lookup.kind, root: lookup.root, configuration: lookup.configuration },
      output: { name: output.name, file: output.file, capturedFile: output.capturedFile, target: output.target,
        ...(alias ? { alias: { kind: alias.kind, target: alias.target, sourceLine: alias.sourceLine } } : {}) } };
  }
  if (lookup.kind !== "configured-package") return undefined;
  // Only an exact configured package observation may enter the source
  // provider resolver. It does not attest installation or build selection.
  const paths = args.indexOf("PATHS");
  const flags = paths < 0 ? args.slice(1) : args.slice(1, paths);
  if (paths >= 0 && (args.length !== paths + 3 || args[paths + 1] !== lookup.root ||
    args[paths + 2] !== "NO_DEFAULT_PATH")) return undefined;
  if (occurrence.role !== "software" || occurrence.command !== "find_package" || occurrence.constraints ||
    args[0] !== output.name || !flags.some((arg) => arg === "CONFIG" || arg === "NO_MODULE") ||
    !flags.every((arg) => ["CONFIG", "NO_MODULE", "REQUIRED", "QUIET"].includes(arg)) ||
    !evidence.has(output.file) || output.alias !== undefined ||
    !absolutePath(output.capturedFile) || output.capturedFile !== join(lookup.root, basename(output.file)) ||
    ![...evidence.values()].includes(lookup.configuration) ||
    ![`${output.name}Config.cmake`, `${output.name.toLowerCase()}-config.cmake`].includes(basename(output.file))) return undefined;
  return { lookup: { kind: lookup.kind, root: lookup.root, configuration: lookup.configuration },
    output: { name: output.name, file: output.file, capturedFile: output.capturedFile, target: output.target } };
}

/**
 * This is a read-only import of an operator-approved producer's statements,
 * not a signature made by the scanned project. The independent digest pins
 * the manifest; the manifest pins the raw artifacts and exact current input.
 * No project code, CMake, install instructions or binary is ever executed.
 */
export function readNativeScopedReceipts(selector, sourceRoot) {
  // Validate the whole bounded selector list before opening anything. A
  // manifest path may appear only once, even with a different digest.
  const selectors = Array.isArray(selector) ? selector : [selector];
  if (!selectors.length || selectors.length > bundleLimit) return [];
  const bundles = new Map();
  for (const item of selectors) {
    if (typeof item !== "string" || item[64] !== ":" || !digest.test(item.slice(0, 64))) return [];
    const path = item.slice(65);
    if (!absolutePath(path) || bundles.has(path)) return [];
    bundles.set(path, item.slice(0, 64));
  }
  const records = [];
  for (const [path, sha256] of bundles) {
    for (const receipt of readScopedReceiptBundle(path, sha256, sourceRoot)) records.push(receipt);
  }
  return records;
}

function readScopedReceiptBundle(path, sha256, sourceRoot) {
  let root;
  let manifest;
  const bundle = dirname(path);
  try {
    root = realpathSync(sourceRoot);
    let protectedRoot = root;
    let checkout = sourceRootOf(join(root, "CMakeLists.txt"));
    while (checkout) {
      protectedRoot = checkout;
      if (dirname(checkout) === checkout) break;
      checkout = sourceRootOf(checkout);
    }
    if (within(protectedRoot, bundle) || within(bundle, root) || realpathSync(path) !== path) return [];
    manifest = readPinnedManifest(path, bundle, sha256);
  } catch { return []; }
  if (manifest?.format !== "native-scoped-receipts-v1" || manifest.sourceRoot !== root ||
    !Array.isArray(manifest.records) || manifest.records.length > 128) return [];

  const fingerprints = new Map();
  let remaining = evidenceLimit;
  const verify = (base, file, hash) => {
    if (!memberPath(file) || typeof hash !== "string" || !digest.test(hash)) return undefined;
    const pathname = resolve(base, file);
    if (!fingerprints.has(pathname)) {
      if (fingerprints.size >= 256) return undefined;
      let observed;
      try {
        const stat = lstatSync(pathname);
        if (stat.isFile() && stat.size <= Math.min(fileLimit, remaining) && realpathSync(pathname) === pathname) {
          remaining -= stat.size;
          observed = hashRegularFile(pathname, stat.size, base);
        }
      } catch { /* Missing or unsafe paths cannot authorize a receipt. */ }
      fingerprints.set(pathname, observed);
    }
    return fingerprints.get(pathname) === hash ? pathname : undefined;
  };
  const records = [];
  for (const record of manifest.records) {
    const { owner, occurrence, sourceSha256, sourceInputs, evidence } = record || {};
    const finder = record?.lookup?.kind === "finder-owner";
    if (!owner || !validToken(owner.name) ||
      (finder ? typeof owner.version !== "string" || !owner.version || owner.version.length > 255 ||
        !digest.test(owner.metadataSha256 || "") :
        typeof owner.revision !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(owner.revision) ||
        typeof owner.repository !== "string" || owner.repository.length > 2048) || !occurrence ||
      Object.hasOwn(occurrence, "providerCandidates") || !Number.isSafeInteger(occurrence.line) || occurrence.line < 1 ||
      !Number.isSafeInteger(occurrence.ordinal) || occurrence.ordinal < 0 || !Array.isArray(occurrence.conditions) ||
      !Array.isArray(sourceInputs) || sourceInputs.length > 16 ||
      !Array.isArray(evidence) || !evidence.length || evidence.length > 32) continue;
    let repository;
    if (!finder) try {
      const url = new URL(owner.repository);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) continue;
      repository = url.href;
    } catch { continue; }
    const sourceFile = verify(root, occurrence.file, sourceSha256);
    if (!sourceFile || !sourceInputs.every((input) => verify(root, input?.file, input?.sha256))) continue;
    const members = new Map();
    for (const descriptor of evidence) {
      if (!verify(bundle, descriptor?.file, descriptor?.sha256)) break;
      members.set(descriptor.file, descriptor.sha256);
    }
    if (members.size !== evidence.length) continue;
    const result = finder ? finderReceiptOutput(record) : receiptOutput(record, members);
    if (!result) continue;
    records.push({ ...result, occurrence, owner: finder ?
      { name: owner.name, version: owner.version, metadataSha256: owner.metadataSha256 } :
      { name: owner.name, version: owner.revision, repository },
      evidence: { manifest: path, sha256, sourceSha256,
        sourceInputs: sourceInputs.map(({ file, sha256 }) => ({ file, sha256 })),
        materials: [...members].map(([file, sha256]) => ({ file, sha256 })) } });
  }
  return records;
}

export function nativeScopedOccurrenceKey(requirement) {
  // Keep receipts exact on the evaluated guards and arguments, not additive analysis diagnostics.
  const { providerCandidates: _, enclosingConditions: _enclosing, evaluationCoverage: _coverage, ...record } = requirement;
  return JSON.stringify(record, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])) : value);
}

/**
 * Build ordinary versioned provider records from exact operator receipts.
 * The caller must restrict each export to its occurrence key. Configure-only
 * observations provide a source owner alternative, never guaranteed finder
 * satisfaction or an installed/selected provider.
 */
export function nativeConfiguredReceiptProviders(selector, sourceRoot) {
  return configuredReceiptProviders(readNativeScopedReceipts(selector, sourceRoot));
}

/** Read each bundle once for both resolution routes. Nothing is cached across calls. */
export function nativeScopedReceiptProviders(selector, sourceRoot) {
  const receipts = readNativeScopedReceipts(selector, sourceRoot);
  return { configuredProviders: configuredReceiptProviders(receipts),
    finderReceipts: receipts.filter((receipt) => receipt.lookup.kind === "finder-owner") };
}

function configuredReceiptProviders(receipts) {
  const owners = new Map();
  for (const receipt of receipts) {
    if (!["configured-package", "restricted-install-plan"].includes(receipt.lookup.kind)) continue;
    const { name, version, repository } = receipt.owner;
    const purl = tryBuildPurl({ type: "generic", name, version, qualifiers: { vcs_url: repository } });
    if (!purl) continue;
    const configuration = receipt.lookup.configuration;
    const program = receipt.lookup.kind === "restricted-install-plan";
    const ownerId = nativeFactsHash(JSON.stringify(program ? [name, version, repository, configuration, receipt.lookup.kind] :
      [name, version, repository, configuration]));
    const ref = `${decodeURIComponent(purl)}#scoped-native-${ownerId.slice(0, 20)}`;
    let provider = owners.get(ref);
    if (!provider) {
      const component = { type: program ? "application" : "library", name, version, externalReferences: [{ type: "vcs", url: repository }], properties: [
        { name: "cdx:version:kind", value: "source-revision" },
        { name: "cdx:version:sourceRevision", value: version },
        { name: "cdx:native:configuration", value: configuration },
        { name: "cdx:native:configurationContext", value: JSON.stringify({ kind: program ? "restricted-install-plan" : "isolated-configure", selected: false, installed: false, configuration }) },
        { name: "cdx:native:providerIdentity", value: ownerId },
        { name: "cdx:native:selection", value: "available-not-selected" },
      ] };
      applyPurl(component, purl);
      component["bom-ref"] = ref;
      provider = { ref, component, packageIdentity: component.purl, version, versionKind: "source-revision",
        exports: [], conditions: [], provenance: [], occurrenceKeys: new Map() };
      owners.set(ref, provider);
    }
    const { occurrence, lookup, output, evidence } = receipt;
    const key = nativeScopedOccurrenceKey(occurrence);
    const proof = { occurrenceSha256: nativeFactsHash(key), file: occurrence.file, line: occurrence.line,
      ordinal: occurrence.ordinal, lookup, output, ...evidence };
    const entry = { kind: program ? "tool" : "cmake-package", name: output.name, source: `${occurrence.file}:${occurrence.line}`,
      ...(program ? { file: output.capturedFile, executableUnknown: true } : {}),
      global: false, materialUnknown: true, interfaceVersionUnknown: true, conditions: occurrence.conditions,
      configuredReceipt: proof };
    provider.exports.push(entry);
    provider.provenance.push(entry.source);
    provider.occurrenceKeys.set(entry, key);
    provider.component.properties.push({ name: "cdx:native:scopedReceipt", value: JSON.stringify(proof) });
  }
  return [...owners.values()];
}

/** Scope authenticated cached owner material to one finder occurrence.
 * A receipt is an operator's static contract observation, not a new global
 * export or proof of successful configuration. The owner must independently
 * replay through its ordinary authenticated metadata route. */
export function nativeFinderReceiptEntry(receipt, authenticated) {
  if (receipt.lookup.kind !== "finder-owner" || receipt.owner.name !== authenticated.name ||
    receipt.owner.version !== authenticated.version || receipt.owner.metadataSha256 !== authenticated.metadataSha256) return undefined;
  const materialDigest = authenticated.repositoryEvidence ? authenticated.packageSha256 :
    authenticated.kind === "provider-snapshot" ? authenticated.metadataSha256 : undefined;
  if (!materialDigest || !receipt.evidence.materials.some((member) => member.sha256 === materialDigest)) return undefined;
  const { occurrence, lookup, output, evidence } = receipt;
  const program = output.mode === "program";
  const fallback = output.mode === "meson-fallback";
  const meson = output.mode === "meson-dependency";
  if (program && !authenticated.repositoryEvidence || fallback && authenticated.kind !== "provider-snapshot") return undefined;
  const material = authenticated.exports.find((entry) => program ?
    entry.kind === "tool" && entry.name === output.name && entry.file === output.member :
    fallback ? entry.kind === "library" && entry.name === output.member && entry.sourceDeclared === true :
      (entry.file || entry.name) === output.member && (meson ?
        entry.kind === "library" && (entry.name === output.name || entry.name === `lib${output.name}`) &&
          (entry.sourceDeclared === true || typeof entry.file === "string") :
        ["header-file", "library", "pkg-config", "cmake-package"].includes(entry.kind)));
  if (!material) return undefined;
  const key = nativeScopedOccurrenceKey(occurrence);
  return { kind: program ? "tool" : fallback || meson ? "meson" : "cmake-package", name: output.name, source: `${occurrence.file}:${occurrence.line}`,
    ...(program ? { file: material.file, executableUnknown: true } : {}),
    global: false, materialUnknown: true, predicateStatus: "unknown",
    conditions: fallback ? [...new Set([...occurrence.conditions, ...output.conditions])] : occurrence.conditions,
    ...(fallback ? { dependencyVariable: output.dependencyVariable } : {}),
    ...(output.mode === "module" ? { via: `${occurrence.file}:${occurrence.line}` } : {}),
    ...(output.interfaceVersion ? { interfaceVersion: output.interfaceVersion } : { interfaceVersionUnknown: true }),
    finderReceipt: { occurrenceSha256: nativeFactsHash(key), file: occurrence.file, line: occurrence.line,
      ordinal: occurrence.ordinal, lookup, output, material, ...evidence } };
}
