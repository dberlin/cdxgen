import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

import { hashRegularFile, openRegularFile, readRegularTextFile } from "../lib/core/boundedFile.js";
import { nativeFinderToolNames, nativePackageFileExports, nativeProgramNames } from "../lib/ecosystems/nativeExternalMetadata.js";
import { nativeFinderReceiptEntry } from "../lib/ecosystems/nativeScopedReceipts.js";
import { fetchNativeAcquisitionBytes, nativeAcquisitionRemaining, nativeAcquisitionUrl } from "./native-acquisition-policy.js";
import { nativeProviderCacheWriter } from "./native-provider-cache.js";
import { nativeRpmFilePatterns } from "./native-rpm-provider-cache.js";
import { nativeDebArtifactMatches, nativeXrtDebOwner, nativeXrtDebPrograms } from "./native-xrt-provider-cache.js";

const MAX_INDEX = 48 * 1024 * 1024;
const MAX_UNPACKED = 512 * 1024 * 1024;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const suiteToken = /^[a-z0-9][a-z0-9.-]*$/;
const ownerToken = /^[a-z0-9][a-z0-9.+-]*$/;
const fileToken = /^[A-Za-z0-9_.][A-Za-z0-9_./+@-]*$/;
const archMap = { amd64: "x64", arm64: "arm64", i386: "ia32", armhf: "arm", ppc64el: "ppc64", s390x: "s390x", riscv64: "riscv64" };

const debProgram = (path) => /(?:^|\/)(?:s?bin|libexec)\/(.+)$/.exec(path)?.[1];

/** Do not reinterpret an authenticated path as a different executable name
 * (e.g. the generic file parser also emits extensionless Windows aliases). */
export function scopeNativeDebProviders(providers, programs, files, finderReceipts = []) {
  const scoped = [];
  const findersByOwner = new Map();
  for (const receipt of finderReceipts) {
    const key = receipt.owner.metadataSha256;
    if (!findersByOwner.has(key)) findersByOwner.set(key, []);
    findersByOwner.get(key).push(receipt);
  }
  for (const provider of providers) {
    // A receipt's basename is an index query only. Never admit another
    // physical path or same-named package owner through that query.
    let exact;
    for (const receipt of findersByOwner.get(provider.metadataSha256) || []) {
      if (nativeFinderReceiptEntry(receipt, provider)) (exact ||= new Set()).add(receipt.output.member);
    }
    const exports = provider.exports.filter((entry) => entry.file && (entry.kind === "tool" ?
      programs.has(entry.name) && debProgram(entry.file) === entry.name :
      exact?.has(entry.file) || files.has(entry.file.slice(entry.file.lastIndexOf("/") + 1))));
    if (exports.length) scoped.push(exports.length === provider.exports.length ? provider : { ...provider, exports });
  }
  return scoped;
}

/** Exact demands from native declaration syntax, not guesses about DEB package names. */
export function nativeDebQueryPlan(requirements) {
  const programs = [...new Set(requirements.flatMap((requirement) =>
    [...nativeProgramNames(requirement), ...nativeFinderToolNames(requirement)]))].sort();
  const files = nativeRpmFilePatterns(requirements.filter((item) => item.command !== "find_program"))
    .filter((path) => path.startsWith("*/")).map((path) => path.slice(2)).sort();
  return { programs, files };
}

function parseRepository(spec, allowedHosts) {
  const [root, suite, component, arch, keyring, ...rest] = spec.split("|");
  if (rest.length || !suiteToken.test(suite || "") || !suiteToken.test(component || "") || !Object.hasOwn(archMap, arch) ||
    !keyring || !isAbsolute(keyring)) throw new Error("Expected HTTPS-root|suite|component|DEB-architecture|/trusted-keyring.gpg");
  const url = nativeAcquisitionUrl(root, allowedHosts);
  if (url.search) throw new Error("A Debian repository URL cannot include query parameters");
  const archiveRoot = url.href.replace(/\/$/, "");
  return { archiveRoot, base: `${archiveRoot}/dists/${suite}/`, suite, component, arch, keyring };
}

function signedChecksums(payload) {
  const checksums = new Map(); let active = false;
  for (const line of payload.split(/\r?\n/)) {
    if (!line.startsWith(" ")) active = line === "SHA256:";
    if (!active) continue;
    const fields = /^\s+([a-f0-9]{64})\s+(\d+)\s+(\S+)$/.exec(line);
    if (fields) checksums.set(fields[3], checksums.has(fields[3]) ? undefined : { sha256: fields[1], size: Number(fields[2]) });
  }
  return checksums;
}

async function forEachGunzipLine(bytes, deadline, consume, filter) {
  const stream = Readable.from([bytes]).pipe(createGunzip({ chunkSize: 256 * 1024 }));
  let pending = ""; let size = 0;
  stream.setEncoding("utf8");
  try {
    for await (const chunk of stream) {
      nativeAcquisitionRemaining(deadline);
      if ((size += Buffer.byteLength(chunk)) > MAX_UNPACKED) throw new Error("Uncompressed Debian index exceeds byte limit");
      const text = pending + chunk;
      const end = text.lastIndexOf("\n");
      if (end < 0) {
        pending = text;
      } else {
        if (filter) {
          filter.lastIndex = 0;
          let match;
          while ((match = filter.exec(text)) && match.index < end) {
            const start = text.lastIndexOf("\n", match.index - 1) + 1;
            const boundary = text.indexOf("\n", match.index);
            if (boundary < 0) break;
            consume(text.slice(start, boundary));
            filter.lastIndex = boundary + 1;
          }
        } else for (let start = 0; start <= end;) {
          const boundary = text.indexOf("\n", start);
          consume(text.slice(start, boundary));
          start = boundary + 1;
        }
        pending = text.slice(end + 1);
      }
      if (pending.length > 1024 * 1024) throw new Error("Oversized Debian index line");
    }
    if (pending) consume(pending);
  } finally { stream.destroy(); }
}

async function matchedPackages(contents, plan, deadline) {
  const files = new Set(plan.files); const programs = new Set(plan.programs);
  const programLeaves = new Set(plan.programs.map((name) => name.slice(name.lastIndexOf("/") + 1)));
  // Avoid a JS callback and temporary substring for the millions of unrelated
  // package paths. Full path predicates still run on every filtered line.
  const leaves = [...new Set([...files, ...programLeaves])];
  const filter = leaves.length && leaves.length <= 2048 ? new RegExp(
    `(?:^|/)(?:${leaves.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?=[ \\t])`, "gm") : undefined;
  const result = new Map();
  await forEachGunzipLine(contents, deadline, (line) => {
    const boundary = Math.max(line.lastIndexOf(" "), line.lastIndexOf("\t"));
    if (boundary < 0) return;
    if (boundary === line.length - 1) return;
    const path = line.slice(0, boundary).trimEnd();
    const leaf = path.slice(path.lastIndexOf("/") + 1);
    const matchesFile = files.has(leaf) && (!/\.(?:h|hpp|hxx)$/.test(leaf) ||
      nativePackageFileExports([path]).some((entry) => entry.kind === "header-file"));
    const program = programLeaves.has(leaf) ? debProgram(path) : undefined;
    const matchesProgram = programs.has(program);
    if (!(matchesFile || matchesProgram) || !fileToken.test(path) || path.split("/").some((part) => !part || part === ".." || part === ".")) return;
    const keys = matchesFile && matchesProgram ? [leaf, program] : [matchesFile ? leaf : program];
    for (const owner of line.slice(boundary + 1).split(",")) {
      const name = owner.slice(owner.lastIndexOf("/") + 1);
      if (!ownerToken.test(name)) continue;
      if (!result.has(name)) result.set(name, new Map());
      result.get(name).set(`/${path}`, keys);
      if (result.size > 2048) throw new Error("Debian exact file demands exceed package-record limit");
    }
  }, filter);
  return result;
}

async function selectedControls(packages, owners, arch, deadline, selectArtifact) {
  const controls = new Map();
  let fields = Object.create(null);
  const emit = () => {
    if (selectArtifact ? fields.Architecture === arch && selectArtifact(fields) :
      owners.has(fields.Package) && (fields.Architecture === arch || fields.Architecture === "all")) {
      const valid = /^\d[0-9A-Za-z.+:~_-]*$/.test(fields.Version || "") &&
        /^pool\/[A-Za-z0-9_./+~-]+\.deb$/.test(fields.Filename || "") && !fields.Filename.split("/").includes("..") &&
        /^[a-f0-9]{64}$/.test(fields.SHA256 || "");
      const previous = controls.get(fields.Package);
      if (!controls.has(fields.Package)) controls.set(fields.Package, valid ? fields : null);
      else if (!valid || !previous || Object.keys(fields).some((key) => fields[key] !== previous[key])) controls.set(fields.Package, null);
    }
    fields = Object.create(null);
  };
  await forEachGunzipLine(packages, deadline, (line) => {
    if (!line) { emit(); return; }
    const match = (selectArtifact ? /^(Package|Version|Architecture|Filename|SHA256|Source|Size): (\S+)$/ :
      /^(Package|Version|Architecture|Filename|SHA256): (\S+)$/).exec(line);
    if (match) fields[match[1]] = Object.hasOwn(fields, match[1]) ? null : match[2];
  });
  emit();
  return controls;
}

function regularBytes(path, maximum, root, deadline) {
  nativeAcquisitionRemaining(deadline);
  const opened = openRegularFile(path, root);
  if (!opened) return undefined;
  try {
    if (opened.size <= 0 || opened.size > maximum) return undefined;
    const bytes = Buffer.allocUnsafe(opened.size);
    for (let at = 0; at < bytes.length;) {
      nativeAcquisitionRemaining(deadline);
      const count = readSync(opened.fd, bytes, at, Math.min(1024 * 1024, bytes.length - at), at);
      if (!count) return undefined;
      at += count;
    }
    return bytes;
  } finally { closeSync(opened.fd); }
}

function trustedRepository(spec, sourceRoot, allowedHosts) {
  const repository = parseRepository(spec, allowedHosts);
  const keyring = realpathSync(repository.keyring);
  const verifier = realpathSync("/usr/bin/gpgv");
  const source = realpathSync(sourceRoot);
  for (const path of [keyring, verifier]) {
    const scope = relative(source, path);
    if (!isAbsolute(scope) && scope !== ".." && !scope.startsWith(`..${sep}`)) {
      throw new Error("Debian signing keyring and verifier must be outside source root");
    }
  }
  const keyringSha256 = hashRegularFile(keyring, 8 * 1024 * 1024);
  if (!keyringSha256) throw new Error("Debian signing keyring is not a bounded regular file");
  return { ...repository, keyring, verifier, keyringSha256 };
}

export const nativeDebArchiveSuiteLimit = 4;
const replayRepositoryLimit = 12;

export function nativeDebTrustedContext(repositories, sourceRoot, allowedHosts) {
  if (repositories.length > nativeDebArchiveSuiteLimit) throw new Error("A maximum of four Debian archive suites is permitted per scan");
  return repositories.map((spec) => [spec, trustedRepository(spec, sourceRoot, allowedHosts).keyringSha256]);
}

/** An explicit replay may trust several independent repository contexts,
 * but each descriptor must still obey the original acquisition limit. */
export function nativeDebReplayTrustedContext(repositories, sourceRoot, allowedHosts) {
  if (repositories.length > replayRepositoryLimit || new Set(repositories).size !== repositories.length) {
    throw new Error(`At most ${replayRepositoryLimit} distinct Debian replay repositories are permitted`);
  }
  return repositories.map((spec) => [spec, trustedRepository(spec, sourceRoot, allowedHosts).keyringSha256]);
}

function releaseChecksums(release, repository, output, deadline) {
  const { keyring, keyringSha256, suite, verifier } = repository;
  const payload = execFileSync(verifier, ["--keyring", keyring, "--output", "-"], {
    input: release, cwd: output, encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: nativeAcquisitionRemaining(deadline),
    env: { PATH: "/usr/bin:/bin", HOME: output, GNUPGHOME: output, LANG: "C", LC_ALL: "C" }, stdio: ["pipe", "pipe", "pipe"],
  });
  if (hashRegularFile(keyring, 8 * 1024 * 1024) !== keyringSha256) throw new Error("Debian signing keyring changed during verification");
  if (![ /^Codename: (\S+)$/m.exec(payload)?.[1], /^Suite: (\S+)$/m.exec(payload)?.[1] ].includes(suite)) {
    throw new Error("Signed Debian release does not name the requested suite");
  }
  return signedChecksums(payload);
}

/** Replay recomputes the same exact join from the signed files and compares
 * the whole derived manifest. Standalone asserted control/file lists are
 * never accepted as signed repository observations.
 */
export async function acquireNativeDebProviders({ plan, repositories, output, manifestName, sourceRoot, fetch: network = false, allowedHosts, deadline }) {
  const writer = network ? nativeProviderCacheWriter(output, sourceRoot) : undefined;
  const providers = []; const unavailable = [];
  const matched = new Set();
  let retryable = false;
  if (repositories.length > nativeDebArchiveSuiteLimit) throw new Error("A maximum of four Debian archive suites is permitted per scan");
  if (plan.packages && (!Array.isArray(plan.packages) || plan.packages.length > 32 ||
    plan.packages.some((name) => typeof name !== "string" || name.length > 255 || !ownerToken.test(name)))) throw new Error("Invalid bounded Debian artifact package candidates");
  for (const [spec, expectedKeyring] of repositories) {
    try {
      const repository = trustedRepository(spec, sourceRoot, allowedHosts);
      const { archiveRoot, base, suite, component, arch, keyringSha256 } = repository;
      const vendorPrograms = nativeXrtDebPrograms(archiveRoot, component, plan);
      if (vendorPrograms?.length === 0 && !plan.packages?.length) continue;
      if (keyringSha256 !== expectedKeyring) throw new Error("Debian signing keyring changed");
      const scopePath = `repositories/${hash(JSON.stringify([base, keyringSha256]))}`;
      const releasePath = `${scopePath}/InRelease`;
      let release = regularBytes(join(output, releasePath), 2 * 1024 * 1024, output, deadline);
      let checksum;
      if (release) try { checksum = releaseChecksums(release, repository, output, deadline); }
      catch (error) { if (!network) throw error; }
      if (!checksum) {
        if (!network) throw new Error("Signed Debian InRelease is missing from cache");
        release = (await fetchNativeAcquisitionBytes(`${base}InRelease`, { allowedHosts, deadline, maximum: 2 * 1024 * 1024 })).bytes;
        checksum = releaseChecksums(release, repository, output, deadline);
        writer.write(releasePath, release);
      }
      const getIndex = async (path) => {
        const expected = checksum.get(path);
        if (!expected || expected.size <= 0 || expected.size > MAX_INDEX) throw new Error(`Signed Debian index missing or oversized: ${path}`);
        const cached = `${scopePath}/${expected.sha256}.gz`;
        let bytes = regularBytes(join(output, cached), expected.size, output, deadline);
        if (!bytes || bytes.length !== expected.size || hash(bytes) !== expected.sha256) {
          if (!network) throw new Error(`Cached signed Debian index failed authentication: ${path}`);
          ({ bytes } = await fetchNativeAcquisitionBytes(`${base}${path}`, { allowedHosts, deadline, maximum: expected.size }));
          if (bytes.length !== expected.size || hash(bytes) !== expected.sha256) throw new Error(`Debian index hash or size mismatch: ${path}`);
          writer.write(cached, bytes);
        }
        return { bytes, url: `${base}${path}`, sha256: expected.sha256, path: cached };
      };
      const releaseSha256 = hash(release);
      const repoMatched = new Set();
      const record = (fields, files, material) => {
        for (const keys of files.values()) for (const key of keys) { matched.add(key); repoMatched.add(key); }
        const provenance = JSON.stringify({ release: `${base}InRelease`, releasePath, releaseSha256, keyringSha256, ...material });
        const provenancePath = `repositories/${hash(provenance)}.json`;
        writer?.write(provenancePath, provenance);
        const control = Object.entries(fields).map(([key, value]) => `${key}: ${value}\n`).join("");
        const listing = [...files.keys()].sort().join("\n");
        const prefix = `packages/${hash(JSON.stringify([provenancePath, control, listing]))}`;
        writer?.write(`${prefix}.control`, control);
        writer?.write(`${prefix}.list`, listing);
        providers.push({ metadata: { path: `${prefix}.control`, format: "dpkg-status", sha256: hash(control) },
          files: [{ path: `${prefix}.list`, sha256: hash(listing) }], repositoryEvidence: { path: provenancePath, sha256: hash(provenance) },
          platform: "linux", targetArch: archMap[arch], conditions: [`Signed Debian archive suite ${suite}/${component}; available, not installed or selected`] });
      };
      if ((plan.packages?.length || vendorPrograms?.length) && !checksum.has(`${component}/Contents-${arch}.gz`)) {
        const { bytes: packagesBytes, ...packages } = await getIndex(`${component}/binary-${arch}/Packages.gz`);
        const requests = new Map();
        for (const program of vendorPrograms || []) {
          const owner = nativeXrtDebOwner(program);
          if (!requests.has(owner)) requests.set(owner, []);
          requests.get(owner).push(program);
        }
        const controls = await selectedControls(packagesBytes, undefined, arch, deadline,
          (fields) => plan.packages?.includes(fields.Package) || fields.Source === "xrt" && requests.has(fields.Package));
        for (const [name, fields] of controls) {
          const size = Number(fields?.Size);
          if (!Number.isSafeInteger(size) || size <= 0 || size > 16 * 1024 * 1024) {
            unavailable.push({ name, reason: "Signed Debian package record is invalid, ambiguous, or oversized" }); continue;
          }
          const path = `${scopePath}/${fields.SHA256}.deb`;
          const url = `${archiveRoot}/${fields.Filename}`;
          let bytes = regularBytes(join(output, path), size, output, deadline);
          const matches = (value) => value?.length === size && hash(value) === fields.SHA256;
          if (!matches(bytes)) {
            if (!network) throw new Error("Cached Debian artifact failed authentication");
            ({ bytes } = await fetchNativeAcquisitionBytes(url, { allowedHosts, deadline, maximum: size }));
            if (!matches(bytes)) throw new Error("Debian artifact hash or size mismatch");
            writer.write(path, bytes);
          }
          const demand = plan.packages?.includes(name) ? plan : { programs: requests.get(name), files: [] };
          const files = nativeDebArtifactMatches(bytes, fields, demand, deadline);
          if (files.size) record(fields, files,
            { packages, artifact: { path, url, size, sha256: fields.SHA256 } });
        }
        continue;
      }
      const scopes = [arch];
      if (checksum.has(`${component}/Contents-all.gz`)) scopes.push("all");
      for (const scope of scopes) {
        if (scope === "all" && plan.programs.every((name) => repoMatched.has(name)) && plan.files.every((name) => repoMatched.has(name))) break;
        const { bytes: contentsBytes, ...contents } = await getIndex(`${component}/Contents-${scope}.gz`);
        const owners = await matchedPackages(contentsBytes, plan, deadline);
        if (!owners.size) continue;
        const packageScope = scope === "all" && !checksum.has(`${component}/binary-all/Packages.gz`) ? arch : scope;
        const { bytes: packagesBytes, ...packages } = await getIndex(`${component}/binary-${packageScope}/Packages.gz`);
        const controls = await selectedControls(packagesBytes, owners, scope, deadline);
        for (const [name, fields] of controls) {
          const files = owners.get(name);
          if (!fields) {
            for (const keys of files.values()) for (const requestedName of keys) unavailable.push({ requestedName,
              reason: `Signed Debian Contents does not identify a version for ambiguous package ${name}` });
            continue;
          }
          record(fields, files, { contents, packages });
        }
      }
    } catch (error) {
      retryable = true;
      unavailable.push({ repository: spec.split("|", 4).join("|"), reason: String(error.message).split("\n")[0] });
    }
  }
  providers.sort((a, b) => a.metadata.path.localeCompare(b.metadata.path));
  const manifestPath = join(output, manifestName);
  const text = JSON.stringify({ schema: 1, providers });
  writer?.write(manifestName, text);
  const verifiedManifestSha256 = network || readRegularTextFile(manifestPath, 8 * 1024 * 1024, output) === text ? hash(text) : undefined;
  const missing = [...new Set([...plan.programs, ...plan.files])].filter((name) => !matched.has(name)).map((name) => ({
    requestedName: name, prerequisite: "Exact unambiguous file owner absent from the selected Debian archive indexes" }));
  return { manifestPath, verifiedManifestSha256, providers: providers.length, unavailable, missing, retryable };
}
