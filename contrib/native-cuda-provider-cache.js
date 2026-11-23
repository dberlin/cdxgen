import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, createReadStream, existsSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { nativeProviderCacheWriter } from "./native-provider-cache.js";
import { nativeProviderExecutionContext } from "./native-provider-process.js";
import { nativeAcquisitionRemaining, nativeAcquisitionUrl } from "./native-acquisition-policy.js";

const NVIDIA = "https://developer.download.nvidia.com/compute/";
const MAX_METADATA = 8 * 1024 * 1024;
const MAX_ARTIFACT = 768 * 1024 * 1024;
const REQUEST_MS = 240000;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const safeName = /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/;

/** Guard every metadata write and exclusive streaming destination beneath the cache. */
export function cudaProviderCache(output, sourceRoot) {
  const writer = nativeProviderCacheWriter(output, sourceRoot);
  const root = realpathSync(output);
  const file = (path) => writer.file(relative(root, path));
  return {
    file,
    mkdir: (path) => writer.mkdir(relative(root, path)),
    write: (path, bytes) => writer.write(relative(root, path), bytes),
    openExclusive: (path) => openSync(file(path), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600),
    replace: (temporary, destination) => renameSync(file(temporary), file(destination)),
    remove: (path) => rmSync(file(path), { force: true }),
  };
}

/** Library aliases follow actual linker filenames, never requested-name heuristics. */
export function cudaArchiveExports(files) {
  const names = new Set();
  for (const path of files) {
    const name = basename(path);
    const unix = /^lib(.+?)(?:\.so(?:\.[0-9.]+)?|\.a|\.dylib)$/.exec(name);
    const windows = /^(.+?)\.(?:lib|dll)$/i.exec(name);
    if (unix || windows) {
      names.add(name);
      names.add((unix || windows)[1]);
    }
  }
  return [...names].filter((name) => safeName.test(name)).sort().map((name) => ({ kind: "library", name }));
}

/** Only architecture-valid export inputs enter the consumer's files field.
 * The separately hashed archive inventory retains every original member.
 */
export function cudaArchiveSnapshot(asset, inventory, evidence, conditions = []) {
  const files = inventory.filter((file) => !/\/stubs\//.test(file) && (asset.arch !== "x64" || !/\/(?:lib32|Win32|x86)\//.test(file)));
  return { schema: 1, name: asset.component, versionKind: "release", version: asset.version,
    platform: asset.platform, arch: asset.arch, exports: cudaArchiveExports(files),
    files, evidence, conditions };
}

/** Preserve the independent package version in NVIDIA's actual release manifest. */
export function cudaRedistributables(manifest, components, platforms) {
  const records = [];
  for (const component of components) {
    const entry = manifest[component];
    if (!safeName.test(component) || !/^\d[0-9A-Za-z.+_~-]*$/.test(entry?.version || "")) continue;
    for (const platformKey of platforms) {
      const platform = platformKey.startsWith("windows-") ? "win32" : platformKey.startsWith("linux-") ? "linux" : undefined;
      const arch = platformKey.endsWith("x86_64") ? "x64" : platformKey.endsWith("aarch64") || platformKey.endsWith("sbsa") ? "arm64" : undefined;
      if (!platform || !arch || !entry[platformKey]) continue;
      const variants = entry[platformKey].relative_path ? [["", entry[platformKey]]] : Object.entries(entry[platformKey]);
      for (const [variant, asset] of variants) {
        if (!asset || !/^[a-f0-9]{64}$/.test(asset.sha256 || "") || !Number.isSafeInteger(Number(asset.size)) || Number(asset.size) <= 0 || Number(asset.size) > MAX_ARTIFACT) continue;
        if (typeof asset.relative_path !== "string" || asset.relative_path.includes("..") || !/^[A-Za-z0-9_./+-]+\.(?:tar\.xz|zip)$/.test(asset.relative_path)) continue;
        records.push({ component, version: entry.version, platform, arch, platformKey, variant, ...asset });
      }
    }
  }
  return records;
}

/** NVIDIA documents discovery-module identities even though no SDK config is shipped. */
export function cudaToolkitExports(document) {
  return [...new Set([...document.matchAll(/\bFind([A-Z][A-Za-z0-9_]*)\b/g)].map((m) => m[1]))].sort().map((name) => ({ kind: "cmake-package", name }));
}

async function fileHash(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

function trustedUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || !(
    url.hostname === "developer.download.nvidia.com" && /^\/compute\/(?:cuda\/(?:redist\/|repos\/ubuntu2204\/x86_64\/)|cusparselt\/redist\/)/.test(url.pathname) ||
    url.hostname === "docs.nvidia.com" && url.pathname.startsWith("/cuda/")
  )) throw new Error("Unapproved NVIDIA evidence URL");
  return url;
}

async function acquire(context, url, path, fetchAllowed, maxBytes, expectedHash, expectedSize) {
  nativeAcquisitionRemaining(context.deadline, REQUEST_MS);
  trustedUrl(url);
  context.cache.file(path);
  if (existsSync(path)) {
    const size = statSync(path).size;
    if (size <= maxBytes && (!expectedSize || size === Number(expectedSize)) && (!expectedHash || await fileHash(path) === expectedHash)) return;
    throw new Error(`Cached evidence failed size or hash validation: ${path}`);
  }
  if (!fetchAllowed) throw new Error(`Missing frozen evidence: ${path}; pass --fetch to acquire`);
  nativeAcquisitionUrl(url, context.allowedHosts);
  const response = await fetch(url, { redirect: "error", credentials: "omit", signal: AbortSignal.timeout(nativeAcquisitionRemaining(context.deadline, REQUEST_MS)) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`NVIDIA HTTP ${response.status}: ${url}`); }
  if (Number(response.headers.get("content-length")) > maxBytes) { await response.body?.cancel(); throw new Error("Oversized NVIDIA artifact"); }
  const temporary = `${path}.${randomUUID()}.partial`;
  const fd = context.cache.openExclusive(temporary);
  const digest = createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of response.body) {
      nativeAcquisitionRemaining(context.deadline, REQUEST_MS);
      size += chunk.byteLength;
      if (size > maxBytes) throw new Error("Oversized NVIDIA artifact stream");
      digest.update(chunk);
      writeFileSync(fd, chunk);
    }
    if (expectedSize && size !== Number(expectedSize)) throw new Error("NVIDIA artifact size mismatch");
    if (expectedHash && digest.digest("hex") !== expectedHash) throw new Error("NVIDIA artifact SHA256 mismatch");
    closeSync(fd);
    context.cache.replace(temporary, path);
  } catch (error) {
    try { closeSync(fd); } catch {}
    context.cache.remove(temporary);
    throw error;
  }
}

async function archiveFiles(context, path) {
  const timeout = nativeAcquisitionRemaining(context.deadline, REQUEST_MS);
  const command = path.endsWith(".zip") ? [context.execution.executables.unzip, "-Z1", path] : [context.execution.executables.tar, "-tf", path];
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", cwd: context.execution.cwd, env: context.execution.env });
  const timer = setTimeout(() => child.kill(), timeout);
  async function bounded(stream) {
    const chunks = []; let size = 0;
    for await (const chunk of stream) {
      size += chunk.byteLength;
      if (size > MAX_METADATA) { child.kill(); throw new Error("Oversized archive listing"); }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  try {
    const [stdout, stderr, exit] = await Promise.all([bounded(child.stdout), bounded(child.stderr), child.exited]);
    if (exit !== 0) throw new Error(`Archive listing failed (${exit}): ${stderr.slice(0, 500)}`);
    const files = stdout.split(/\r?\n/).filter(Boolean);
    if (files.some((file) => file.startsWith("/") || file.split("/").includes("..") || file.includes("\\"))) throw new Error("Unsafe archive member");
    return files;
  } finally { clearTimeout(timer); }
}

function writeJson(context, path, value) {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  context.cache.write(path, bytes);
  return hash(bytes);
}

async function debianDataArchive(context, path, output) {
  const fd = openSync(path, "r");
  try {
    const magic = Buffer.alloc(8);
    if (readSync(fd, magic, 0, 8, 0) !== 8 || magic.toString() !== "!<arch>\n") throw new Error("Invalid Debian ar archive");
    const header = Buffer.alloc(60);
    const total = statSync(path).size;
    for (let offset = 8; offset + 60 <= total;) {
      if (readSync(fd, header, 0, 60, offset) !== 60 || header.subarray(58).toString() !== "`\n") throw new Error("Invalid Debian member header");
      const name = header.subarray(0, 16).toString().trim().replace(/\/$/, "");
      const size = Number(header.subarray(48, 58).toString().trim());
      const start = offset + 60;
      if (!Number.isSafeInteger(size) || size < 0 || start + size > total) throw new Error("Invalid Debian member size");
      if (/^data\.tar(?:\.(?:xz|gz|zst|bz2))?$/.test(name)) {
        const destination = join(output, `${basename(path)}.${name}`);
        const temporary = `${destination}.${randomUUID()}.partial`;
        const fd = context.cache.openExclusive(temporary);
        try {
          for await (const chunk of createReadStream(path, { start, end: start + size - 1 })) writeFileSync(fd, chunk);
          closeSync(fd);
          context.cache.replace(temporary, destination);
        } catch (error) {
          try { closeSync(fd); } catch {}
          context.cache.remove(temporary);
          throw error;
        }
        return destination;
      }
      offset = start + size + size % 2;
    }
    throw new Error("Debian archive has no data member");
  } finally { closeSync(fd); }
}

async function acquireDriver(context, output, version, fetchAllowed) {
  if (!/^\d[0-9A-Za-z.+_~:-]*$/.test(version)) throw new Error("Invalid concrete driver package version");
  const base = `${NVIDIA}cuda/repos/ubuntu2204/x86_64/`;
  const indexPath = join(output, "nvidia-ubuntu2204-x86_64-Packages.gz");
  await acquire(context, `${base}Packages.gz`, indexPath, fetchAllowed, MAX_METADATA);
  const index = gunzipSync(readFileSync(indexPath), { maxOutputLength: 64 * 1024 * 1024 }).toString("utf8");
  const stanza = index.split(/\n\n/).find((entry) => /^Package: libnvidia-compute-\d+$/m.test(entry) && /^Architecture: amd64$/m.test(entry) && entry.split("\n").includes(`Version: ${version}`));
  if (!stanza) throw new Error(`Exact NVIDIA driver package version unavailable: ${version}`);
  const fields = Object.fromEntries(stanza.split("\n").map((line) => /^([A-Za-z0-9-]+): (.*)$/.exec(line)).filter(Boolean).map((m) => [m[1], m[2]]));
  const filename = fields.Filename?.replace(/^\.\//, "");
  if (!filename || basename(filename) !== filename || !/^[A-Za-z0-9_.+~-]+\.deb$/.test(filename) || !/^[a-f0-9]{64}$/.test(fields.SHA256 || "") || !Number.isSafeInteger(Number(fields.Size)) || Number(fields.Size) <= 0 || Number(fields.Size) > MAX_ARTIFACT) throw new Error("Invalid NVIDIA driver package metadata");
  const artifactPath = join(output, "artifacts", filename);
  const url = `${base}${filename}`;
  await acquire(context, url, artifactPath, fetchAllowed, MAX_ARTIFACT, fields.SHA256, fields.Size);
  const dataPath = await debianDataArchive(context, artifactPath, join(output, "artifacts"));
  const files = await archiveFiles(context, dataPath);
  const exports = cudaArchiveExports(files);
  if (!exports.some((item) => item.name === "nvidia-ml")) throw new Error("NVIDIA driver package does not export NVML");
  const stanzaName = `${filename}.control.txt`;
  context.cache.write(join(output, stanzaName), stanza);
  const fileList = `${filename}.files.json`;
  const fileListHash = writeJson(context, join(output, fileList), { schema: 1, acquisitionUrl: url, repositoryUrl: `${base}Packages.gz`, repositorySha256: await fileHash(indexPath), artifact: `artifacts/${filename}`, sha256: fields.SHA256, size: Number(fields.Size), files });
  const snapshot = { schema: 1, name: fields.Package, versionKind: "release", version: fields.Version, platform: "linux", arch: "x64", exports, files,
    evidence: [{ path: stanzaName, sha256: hash(stanza) }, { path: fileList, sha256: fileListHash }],
    conditions: ["Actual NVIDIA Ubuntu 22.04 amd64 driver runtime package; available, not installed or selected", "Driver package release, independent of CUDA toolkit or SDK stub versions"] };
  const snapshotPath = `${filename}.provider.json`;
  return { provider: { metadata: { path: snapshotPath, format: "provider-snapshot", sha256: writeJson(context, join(output, snapshotPath), snapshot) } }, exports,
    acquisition: { component: fields.Package, version: fields.Version, platform: "linux", arch: "x64", url, sha256: fields.SHA256, size: Number(fields.Size), fileList } };
}

/** Reusable exact release/platform orchestration; no guessed toolkit release. */
export async function acquireNativeCudaProviders({ output: directory, sourceRoot, cudaRelease, cusparseltRelease, nvtxRelease, driverVersion, platforms: platformInput, fetch: network = false, allowedHosts, requirements = [], deadline = Date.now() + 300000 }) {
  nativeAcquisitionRemaining(deadline);
  const options = new Map([["--output", directory], ["--source-root", sourceRoot], ["--cuda-release", cudaRelease],
    ["--cusparselt-release", cusparseltRelease], ["--nvtx-release", nvtxRelease], ["--driver-version", driverVersion], ["--platforms", platformInput]]);
  if (network) options.set("--fetch", true);
  if (!platformInput) throw new Error("An exact NVIDIA target platform is required");
  const output = resolve(options.get("--output"));
  const source = realpathSync(resolve(options.get("--source-root") || dirname(dirname(fileURLToPath(import.meta.url)))));
  let parent = output;
  while (!existsSync(parent) && dirname(parent) !== parent) parent = dirname(parent);
  const destination = resolve(realpathSync(parent), relative(parent, output));
  const rel = relative(source, destination);
  if (!rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))) throw new Error("Evidence cache must be outside source root");
  const platforms = (options.get("--platforms") || "linux-x86_64,windows-x86_64").split(",");
  if (platforms.some((p) => !["linux-x86_64", "windows-x86_64", "linux-aarch64", "linux-sbsa"].includes(p))) throw new Error("Unsupported artifact platform");
  const context = { cache: cudaProviderCache(output, source), execution: nativeProviderExecutionContext(source, output, ["tar", "unzip"]), allowedHosts, deadline };
  context.cache.mkdir(join(output, "artifacts"));
  const providers = []; const unavailable = []; const acquisitions = []; const observed = new Set();
  const processedAssets = new Set();
  const fetchAllowed = options.has("--fetch");
  const selections = [
    { family: "cuda", release: options.get("--cuda-release") },
    { family: "cuda", release: options.get("--nvtx-release"), nvtxOnly: true },
    { family: "cusparselt", release: options.get("--cusparselt-release") },
  ];
  for (const { family, release, nvtxOnly } of selections) {
    if (!release) continue;
    if (!/^\d+(?:\.\d+){1,3}$/.test(release)) throw new Error("Expected a concrete published NVIDIA release");
    const base = `${NVIDIA}${family}/redist/`;
    const indexName = `${family}-redist-index.html`;
    await acquire(context, base, join(output, indexName), fetchAllowed, MAX_METADATA);
    const manifestName = `redistrib_${release}.json`;
    const index = readFileSync(join(output, indexName), "utf8");
    if (![...index.matchAll(/href=["']([^"']+)["']/g)].some((m) => m[1] === manifestName)) throw new Error(`Release is not published in NVIDIA index: ${family} ${release}`);
    const frozenManifest = `${family}-${manifestName}`;
    await acquire(context, `${base}${manifestName}`, join(output, frozenManifest), fetchAllowed, MAX_METADATA);
    const manifestBytes = readFileSync(join(output, frozenManifest));
    const manifest = JSON.parse(manifestBytes);
    if (manifest.release_label !== undefined && manifest.release_label !== release) throw new Error("NVIDIA release label mismatch");
    const components = Object.keys(manifest).filter((name) => nvtxOnly ? /^(?:cuda|nsight)_nvtx$/.test(name) : /^(?:cuda_(?:cudart|cupti|nvml_dev|nvtx|nvcc)|nsight_nvtx|lib(?:cufft|cusparse|cusparse_lt|nvfatbin|nvptxcompiler))$/.test(name));
    const assets = cudaRedistributables(manifest, components, platforms);
    for (let i = 0; i < assets.length; i += 3) {
      await Promise.all(assets.slice(i, i + 3).map(async (asset) => {
        const key = `${family}/${asset.relative_path}`;
        if (processedAssets.has(key)) return;
        processedAssets.add(key);
        const artifactName = basename(asset.relative_path);
        const artifactPath = join(output, "artifacts", artifactName);
        const url = `${base}${asset.relative_path}`;
        try {
          await acquire(context, url, artifactPath, fetchAllowed, MAX_ARTIFACT, asset.sha256, asset.size);
          const files = await archiveFiles(context, artifactPath);
          const fileList = `${artifactName}.files.json`;
          const fileListHash = writeJson(context, join(output, fileList), { schema: 1, acquisitionUrl: url, artifact: `artifacts/${artifactName}`, sha256: asset.sha256, size: Number(asset.size), files });
          const conditions = [`NVIDIA redistributable ${family} ${release}; available, not installed or selected`];
          if (asset.variant) conditions.push(`NVIDIA variant ${asset.variant}`);
          if (files.some((f) => /\/stubs\/libnvidia-ml\.so$/.test(f))) conditions.push("NVML SDK link stub only; not an installed NVIDIA driver or driver runtime version");
          const snapshot = cudaArchiveSnapshot(asset, files,
            [{ path: frozenManifest, sha256: hash(manifestBytes) }, { path: fileList, sha256: fileListHash }], conditions);
          const { exports } = snapshot;
          if (!exports.length) throw new Error("Artifact has no library exports");
          const snapshotPath = `${asset.component}-${asset.version}-${asset.platformKey}${asset.variant ? `-${asset.variant}` : ""}.provider.json`;
          providers.push({ metadata: { path: snapshotPath, format: "provider-snapshot", sha256: writeJson(context, join(output, snapshotPath), snapshot) } });
          for (const item of exports) observed.add(item.name);
          acquisitions.push({ component: asset.component, version: asset.version, platform: asset.platform, arch: asset.arch, url, sha256: asset.sha256, size: Number(asset.size), fileList });
        } catch (error) { unavailable.push({ component: asset.component, platform: asset.platformKey, url, reason: error.message }); }
      }));
    }
    if (family === "cuda" && !nvtxOnly) {
      const documentName = `cuda-${release}-installation-guide.html`;
      const documentUrl = `https://docs.nvidia.com/cuda/archive/${release}/cuda-installation-guide-linux/index.html`;
      try {
        await acquire(context, documentUrl, join(output, documentName), fetchAllowed, MAX_METADATA);
        if (!manifest.release_label) throw new Error("NVIDIA manifest lacks an explicit toolkit release label");
        const document = readFileSync(join(output, documentName), "utf8");
        const exports = cudaToolkitExports(document);
        if (!exports.length) throw new Error("NVIDIA documentation has no discovery-module declarations");
        for (const platformKey of platforms) {
          const platform = platformKey.startsWith("windows-") ? "win32" : "linux";
          const arch = platformKey.endsWith("x86_64") ? "x64" : "arm64";
          const constituents = acquisitions.filter((a) => ["cuda_cudart", "cuda_nvcc"].includes(a.component) && a.platform === platform && a.arch === arch);
          if (!["cuda_cudart", "cuda_nvcc"].every((name) => constituents.some((a) => a.component === name))) throw new Error(`Toolkit discovery lacks runtime/compiler artifact evidence for ${platformKey}`);
          const snapshot = { schema: 1, name: "cuda-toolkit", versionKind: "release", version: manifest.release_label, platform, arch, exports,
            evidence: [{ path: frozenManifest, sha256: hash(manifestBytes) }, { path: documentName, sha256: hash(document) },
              ...constituents.map((a) => ({ path: a.fileList, sha256: hash(readFileSync(join(output, a.fileList))) }))],
            conditions: ["Toolkit release identity from NVIDIA redistrib release_label, not an independent component version", "CMake discovery modules documented by NVIDIA; SDK available, not installed or selected"] };
          const snapshotPath = `cuda-toolkit-${release}-${platformKey}.provider.json`;
          providers.push({ metadata: { path: snapshotPath, format: "provider-snapshot", sha256: writeJson(context, join(output, snapshotPath), snapshot) } });
        }
        for (const item of exports) observed.add(item.name);
      } catch (error) { unavailable.push({ component: "cuda-toolkit", url: documentUrl, reason: error.message }); }
    }
  }
  if (driverVersion && platforms.includes("linux-x86_64")) {
    try {
      const driver = await acquireDriver(context, output, options.get("--driver-version"), fetchAllowed);
      providers.push(driver.provider);
      acquisitions.push(driver.acquisition);
      for (const item of driver.exports) observed.add(item.name);
    } catch (error) { unavailable.push({ component: "nvidia-driver", reason: error.message }); }
  }
  providers.sort((a, b) => a.metadata.path.localeCompare(b.metadata.path));
  const manifestPath = join(output, "native-provider-metadata.json");
  writeJson(context, manifestPath, { schema: 1, providers });
  const missingIdentities = requirements.map((r) => r.requestedName).filter((name) => name && !observed.has(name)).sort();
  const rawPaths = new Set(selections.filter((s) => s.release).flatMap(({ family, release }) => [`${family}-redist-index.html`, `${family}-redistrib_${release}.json`]));
  rawPaths.add(`cuda-${options.get("--cuda-release")}-installation-guide.html`);
  if (driverVersion) rawPaths.add("nvidia-ubuntu2204-x86_64-Packages.gz");
  const rawMetadata = await Promise.all([...rawPaths].sort().filter((path) => existsSync(join(output, path))).map(async (path) => ({ path, sha256: await fileHash(join(output, path)) })));
  writeJson(context, join(output, "acquisition-report.json"), { schema: 1, manifestPath, providers: providers.length, rawMetadata, acquisitions, unavailable, missingIdentities });
  return { manifestPath, providers: providers.length, acquiredArtifacts: acquisitions.length, unavailable, missingIdentities };
}

async function main(args) {
  const options = new Map();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--fetch") options.set(args[i], true);
    else if (["--output", "--cuda-release", "--cusparselt-release", "--nvtx-release", "--driver-version", "--source-root", "--platforms", "--requirements"].includes(args[i]) && args[i + 1]) options.set(args[i], args[++i]);
    else throw new Error(`Unknown or incomplete argument: ${args[i]}`);
  }
  if (!options.get("--output") || !options.get("--cuda-release")) throw new Error("Use --output EXTERNAL_CACHE --cuda-release EXACT_RELEASE --platforms TARGETS [--source-root SOURCE] [--fetch]");
  let requirements = [];
  if (options.get("--requirements")) {
    const file = resolve(options.get("--requirements"));
    if (statSync(file).size > 32 * 1024 * 1024) throw new Error("Oversized requirements inventory");
    const inventory = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(inventory)) throw new Error("Expected requirements array");
    requirements = inventory.flatMap((r) => r.requirements || [r]);
  }
  const result = await acquireNativeCudaProviders({ output: options.get("--output"), sourceRoot: options.get("--source-root"),
    cudaRelease: options.get("--cuda-release"), cusparseltRelease: options.get("--cusparselt-release"), nvtxRelease: options.get("--nvtx-release"),
    driverVersion: options.get("--driver-version"), platforms: options.get("--platforms") || "linux-x86_64,windows-x86_64", fetch: options.has("--fetch"), requirements });
  console.log(JSON.stringify(result));
  if (!result.providers) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
