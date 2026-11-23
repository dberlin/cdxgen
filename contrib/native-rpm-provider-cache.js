import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { nativeProviderExecutionContext } from "./native-provider-process.js";
import { fetchNativeAcquisitionBytes, nativeAcquisitionRemaining, nativeAcquisitionUrl } from "./native-acquisition-policy.js";
import { nativeProviderCacheWriter } from "./native-provider-cache.js";

const US = "\u001f";
const RS = "\u001e";
const MAX_METADATA = 8 * 1024 * 1024;
const MAX_QUERY = 64 * 1024 * 1024;
const QUERY_TIMEOUT = 30000;
const queryFormat = ["name", "epoch", "version", "release", "arch", "repoid", "files"].map((field) => `%{${field}}`).join(US) + RS;
const namePattern = /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/;
const versionPattern = /^\d[0-9A-Za-z.+_:~\-]*$/;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function addProgramPaths(paths, requirement) {
  for (const name of [requirement.requestedName, ...(requirement.alternatives || [])]) {
    if (typeof name !== "string" || !namePattern.test(name)) continue;
    for (const directory of ["bin", "sbin", "libexec"]) paths.add(`/usr/${directory}/${name}`);
  }
}

function addLibraryQueries(queries, requirement, capabilities = false) {
  for (const name of [requirement.requestedName, ...(requirement.alternatives || [])]) {
    if (typeof name !== "string" || !namePattern.test(name)) continue;
    const library = name.startsWith("lib") ? name : `lib${name}`;
    if (capabilities) {
      if (!name.endsWith(".a")) queries.add(`${/\.so(?:\.[0-9]+)*$/.test(library) ? library : `${library}.so`}()(64bit)`);
    } else if (/\.(?:so(?:\.[0-9]+)*|a)$/.test(name)) queries.add(`*/${name}`);
    else {
      queries.add(`*/${library}.so`);
      queries.add(`*/${library}.a`);
    }
  }
}

/** Discovery syntax determines file patterns; no owner/version alias map. */
export function nativeRpmFilePatterns(requirements) {
  const patterns = new Set();
  for (const requirement of requirements) {
    if (requirement.command === "find_program") { addProgramPaths(patterns, requirement); continue; }
    if (requirement.command === "find_library") { addLibraryQueries(patterns, requirement); continue; }
    const name = requirement.requestedName;
    if (typeof name !== "string" || !namePattern.test(name)) continue;
    if (["dependency", "pkg_check_modules", "pkg_search_module"].includes(requirement.command)) {
      patterns.add(`*/${name}.pc`);
    } else if (["find_package", "find_dependency"].includes(requirement.command)) {
      patterns.add(`*/${name}Config.cmake`);
      patterns.add(`*/${name.toLowerCase()}-config.cmake`);
    }
  }
  return [...patterns].sort();
}

/** Query the repository's indexed provides, not wildcard full file inventories. */
export function nativeRpmCapabilities(requirements) {
  const capabilities = new Set();
  for (const requirement of requirements) {
    const { requestedName: name, command } = requirement;
    if (command === "find_program") { addProgramPaths(capabilities, requirement); continue; }
    if (command === "find_library") { addLibraryQueries(capabilities, requirement, true); continue; }
    if (typeof name !== "string" || !namePattern.test(name)) continue;
    if (["dependency", "pkg_check_modules", "pkg_search_module"].includes(command)) capabilities.add(`pkgconfig(${name})`);
    else if (["find_package", "find_dependency"].includes(command)) {
      capabilities.add(`cmake(${name})`);
      capabilities.add(`cmake(${name.toLowerCase()})`);
    }
  }
  return [...capabilities].sort();
}

export function nativeRpmQueryPlan(requirements) {
  return {
    patterns: nativeRpmFilePatterns(requirements),
    capabilities: nativeRpmCapabilities(requirements),
    // DNF appends list-valued options. Clear its default comps/updateinfo
    // demand, and select the regular indexes we fetched and verified.
    queryArgs: ["--setopt=skip_if_unavailable=0", "--setopt=zchunk=false",
      "--setopt=optional_metadata_types=", "--setopt=optional_metadata_types=filelists",
      "repoquery", "--available", "--arch=x86_64,noarch", `--queryformat=${queryFormat}`],
  };
}

/** DNF5 uses seven US-separated fields, newline-separated files and final RS. */
export function parseNativeRpmQuery(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_QUERY) throw new Error("Oversized or invalid DNF query output");
  if (text.trim() && !text.trimEnd().endsWith(RS)) throw new Error("Truncated DNF query record");
  const records = [];
  for (const raw of text.split(RS)) {
    if (!raw.trim()) continue;
    const fields = raw.replace(/^\r?\n/, "").split(US);
    if (fields.length !== 7) throw new Error("Invalid DNF query field count");
    const [name, epoch, version, release, arch, repoid, members] = fields;
    if (!namePattern.test(name) || !/^\d+$/.test(epoch) || !versionPattern.test(version) || !versionPattern.test(release) || !["x86_64", "noarch"].includes(arch) || !["fedora", "updates"].includes(repoid)) throw new Error("Untrusted or invalid DNF package identity");
    const files = members.split(/\r?\n/).filter(Boolean);
    if (!files.length || files.length > 100000 || files.some((path) => !path.startsWith("/") || path.includes("\0") || path.split("/").includes(".."))) throw new Error("Invalid DNF package file inventory");
    const record = { name, epoch, version, release, arch, repoid, files };
    if (Buffer.byteLength(JSON.stringify(record)) > MAX_METADATA) throw new Error("Oversized RPM provider record");
    records.push(record);
  }
  return records;
}

/** Reject cache ancestors and descendants that could redirect DNF/file writes. */
export function assertRpmCacheDirectory(directory) {
  const root = resolve(directory);
  for (let parent = root;; parent = dirname(parent)) {
    if (lstatSync(parent, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`Symlinked RPM cache path: ${parent}`);
    if (dirname(parent) === parent) break;
  }
  const pending = [root];
  let entries = 0;
  while (pending.length) {
    const path = pending.pop();
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (!info) continue;
    if (info.isSymbolicLink()) throw new Error(`Symlinked RPM cache descendant: ${path}`);
    if (!info.isDirectory() && !info.isFile()) throw new Error(`Nonregular RPM cache descendant: ${path}`);
    if (info.isDirectory()) {
      for (const name of readdirSync(path)) {
        if (++entries > 200000) throw new Error("Oversized RPM cache directory");
        pending.push(join(path, name));
      }
    }
  }
}

function boundedText(path, maximum) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) throw new Error(`Unreadable or oversized metadata: ${path}`);
  return readFileSync(path, "utf8");
}

function writeJson(path, value) {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, bytes, { flag: "wx" });
  return hash(bytes);
}

async function queryDnf(execution, args, deadline) {
  const timeout = nativeAcquisitionRemaining(deadline, QUERY_TIMEOUT);
  const child = Bun.spawn([execution.executables.dnf, ...args], { stdout: "pipe", stderr: "pipe", cwd: execution.cwd, env: execution.env });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
  async function capture(stream, maximum) {
    const chunks = []; let size = 0;
    for await (const chunk of stream) {
      size += chunk.byteLength;
      if (size > maximum) { child.kill(); throw new Error("Oversized DNF query stream"); }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  try {
    const [stdout, stderr, exitCode] = await Promise.all([capture(child.stdout, MAX_QUERY), capture(child.stderr, MAX_METADATA), child.exited]);
    return { stdout, stderr, exitCode, timedOut };
  } finally { clearTimeout(timer); }
}

/** Acquire repomd plus its checksum-authenticated primary/filelists indexes.
 * DNF receives only this local repository: its own HTTP stack cannot bypass the
 * CLI's host/redirect policy, proxy isolation, or byte/deadline limits. */
export async function acquireNativeRpmMetadata({ repositories, output, sourceRoot, allowedHosts, fetch: network = false, deadline = Date.now() + 180000 }) {
  nativeAcquisitionRemaining(deadline);
  const writer = nativeProviderCacheWriter(output, sourceRoot);
  const acquired = [];
  for (const specification of repositories) {
    const equal = specification.indexOf("=");
    const id = specification.slice(0, equal); const base = specification.slice(equal + 1).replace(/\/?$/, "/");
    if (equal < 1 || !["fedora", "updates"].includes(id)) throw new Error("RPM repositories require explicit fedora=HTTPS_BASE or updates=HTTPS_BASE contexts");
    nativeAcquisitionUrl(base, allowedHosts);
    const key = hash(base).slice(0, 20); const prefix = `repositories/${id}-${key}`;
    const repositoryRoot = writer.mkdir(prefix);
    const repomdPath = `${prefix}/repodata/repomd.xml`;
    let repomd;
    if (existsSync(join(output, repomdPath))) repomd = boundedText(join(output, repomdPath), MAX_METADATA);
    else {
      if (!network) throw new Error(`Missing frozen RPM repomd metadata for ${id}: ${base}`);
      repomd = (await fetchNativeAcquisitionBytes(`${base}repodata/repomd.xml`, { allowedHosts, deadline, maximum: MAX_METADATA })).bytes.toString("utf8");
      writer.write(repomdPath, repomd);
    }
    if (/<!DOCTYPE|<!ENTITY/i.test(repomd)) throw new Error("RPM metadata entity declarations are forbidden");
    const indexes = [];
    for (const block of repomd.split("</data>")) {
      const type = /<data\s+type=["']([^"']+)["']/.exec(block)?.[1];
      if (!["primary", "filelists"].includes(type)) continue;
      const href = /<location\s+href=["']([^"']+)["']/.exec(block)?.[1];
      const checksum = /<checksum\s+type=["'](sha256|sha512)["']\s*>([a-f0-9]+)<\/checksum>/i.exec(block);
      if (!href || !/^[A-Za-z0-9_.+/-]+$/.test(href) || href.startsWith("/") || href.split("/").includes("..") ||
        !checksum || checksum[2].length !== (checksum[1].toLowerCase() === "sha256" ? 64 : 128)) throw new Error("RPM index lacks safe path and authenticated checksum");
      const path = `${prefix}/${href}`;
      let bytes;
      if (existsSync(join(output, path))) {
        const info = lstatSync(join(output, path));
        if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024 * 1024) throw new Error("Unsafe or oversized cached RPM index");
        bytes = readFileSync(join(output, path));
      } else {
        if (!network) throw new Error(`Missing frozen RPM ${type} metadata: ${base}${href}`);
        bytes = (await fetchNativeAcquisitionBytes(`${base}${href}`, { allowedHosts, deadline, maximum: 128 * 1024 * 1024 })).bytes;
      }
      if (createHash(checksum[1].toLowerCase()).update(bytes).digest("hex") !== checksum[2].toLowerCase()) throw new Error("RPM metadata checksum mismatch");
      writer.write(path, bytes); indexes.push({ type, path, sha256: hash(bytes), url: `${base}${href}` });
    }
    if (!["primary", "filelists"].every((type) => indexes.some((entry) => entry.type === type))) throw new Error("RPM primary and filelists metadata are both required");
    acquired.push({ id, url: base, directory: repositoryRoot, repomdPath, repomdSha256: hash(repomd), indexes });
  }
  return acquired;
}

export async function acquireNativeRpmProviders({ requirements, output: destinationRoot, sourceRoot, repositories = [], fetch: network = false, allowedHosts, deadline = Date.now() + 180000 }) {
  nativeAcquisitionRemaining(deadline);
  const options = new Map([["--output", destinationRoot], ["--source-root", sourceRoot]]);
  if (network) options.set("--fetch", true);
  const output = resolve(options.get("--output"));
  assertRpmCacheDirectory(output);
  const source = realpathSync(resolve(options.get("--source-root") || dirname(dirname(fileURLToPath(import.meta.url)))));
  let parent = output;
  while (!existsSync(parent) && dirname(parent) !== parent) parent = dirname(parent);
  const destination = resolve(realpathSync(parent), relative(parent, output));
  const rel = relative(source, destination);
  if (!rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))) throw new Error("RPM cache must be outside source root");
  mkdirSync(output, { recursive: true });
  const requirementBytes = JSON.stringify({ requirements, repositories });
  const plan = nativeRpmQueryPlan(requirements);
  const { patterns, capabilities, queryArgs } = plan;
  if (!capabilities.length) throw new Error("No literal indexed RPM capability queries");
  const key = hash(JSON.stringify([hash(requirementBytes), plan])).slice(0, 20);
  const acquisition = join(output, `query-${key}-indexed`);
  mkdirSync(acquisition, { recursive: true });
  const stdoutPath = join(acquisition, "repoquery.stdout");
  const provenancePath = join(acquisition, "query.json");
  const manifestPath = join(acquisition, "native-provider-metadata.json");
  if (!existsSync(stdoutPath)) {
    if (!options.has("--fetch")) throw new Error("Frozen repoquery evidence missing; pass --fetch for explicit acquisition");
    for (const directory of ["dnf-cache", "dnf-system-cache", "dnf-state", "dnf-logs"]) mkdirSync(join(output, directory), { recursive: true });
    if (!repositories.length) throw new Error("Cold RPM acquisition requires an explicit exact-release repository URL; host repositories are never inferred");
    const acquired = await acquireNativeRpmMetadata({ repositories, output, sourceRoot: source, fetch: network, allowedHosts, deadline: Math.min(deadline, Date.now() + 180000) });
    const execution = nativeProviderExecutionContext(source, output, ["dnf"]);
    const writer = nativeProviderCacheWriter(output, source);
    const reposdir = writer.mkdir("empty-repos");
    const installroot = writer.mkdir("installroot");
    const command = ["--config=/dev/null", "--disable-plugin=*", "--disablerepo=*", `--installroot=${installroot}`,
      `--setopt=reposdir=${reposdir}`, "--setopt=proxy=", "--setopt=plugins=0",
      ...acquired.flatMap((repo) => [`--repofrompath=${repo.id},${new URL(`file://${repo.directory}/`).href}`, `--enablerepo=${repo.id}`]),
      `--setopt=cachedir=${join(output, "dnf-cache")}`, `--setopt=system_cachedir=${join(output, "dnf-system-cache")}`,
      `--setopt=persistdir=${join(output, "dnf-state")}`, `--setopt=logdir=${join(output, "dnf-logs")}`,
      ...queryArgs];
    const started = new Date().toISOString();
    const queryDeadline = Math.min(deadline, Date.now() + 180000);
    const batches = []; const stdout = []; const stderr = [];
    let exitCode = 0; let timedOut = false; let outputBytes = 0;
    for (let i = 0; i < capabilities.length; i += 32) {
      const remaining = queryDeadline - Date.now();
      if (remaining <= 0) { exitCode = 1; timedOut = true; break; }
      const args = [...command, `--whatprovides=${capabilities.slice(i, i + 32).join(",")}`];
      const result = await queryDnf(execution, args, queryDeadline);
      assertRpmCacheDirectory(output);
      const prefix = `batch-${String(batches.length).padStart(3, "0")}`;
      writeFileSync(join(acquisition, `${prefix}.stdout`), result.stdout, { flag: "wx" });
      writeFileSync(join(acquisition, `${prefix}.stderr`), result.stderr, { flag: "wx" });
      batches.push({ arguments: args, stdout: `${prefix}.stdout`, stdoutSha256: hash(result.stdout), stderr: `${prefix}.stderr`, stderrSha256: hash(result.stderr), exitCode: result.exitCode, timedOut: result.timedOut });
      outputBytes += result.stdout.byteLength;
      if (outputBytes > MAX_QUERY) throw new Error("Oversized combined RPM query output");
      stdout.push(result.stdout); stderr.push(result.stderr);
      if (result.exitCode !== 0) { exitCode = result.exitCode; timedOut = result.timedOut; break; }
    }
    const stdoutBytes = Buffer.concat(stdout); const stderrBytes = Buffer.concat(stderr);
    writeFileSync(stdoutPath, stdoutBytes, { flag: "wx" });
    writeFileSync(join(acquisition, "repoquery.stderr"), stderrBytes, { flag: "wx" });
    writeJson(provenancePath, { schema: 1, executable: execution.executables.dnf, workingDirectory: execution.cwd, environment: execution.env, mode: "authenticated-local-repository", repositories: acquired, batches, started, completed: new Date().toISOString(), exitCode, timedOut,
      requirementsSha256: hash(requirementBytes), patterns, capabilities, queryArgs, stdoutSha256: hash(stdoutBytes), stderrSha256: hash(stderrBytes) });
  }
  const provenance = JSON.parse(boundedText(provenancePath, MAX_METADATA));
  const raw = boundedText(stdoutPath, MAX_QUERY);
  if (provenance.requirementsSha256 !== hash(requirementBytes) || provenance.stdoutSha256 !== hash(raw) ||
    JSON.stringify(provenance.patterns) !== JSON.stringify(patterns) || JSON.stringify(provenance.capabilities) !== JSON.stringify(capabilities) ||
    JSON.stringify(provenance.queryArgs) !== JSON.stringify(queryArgs)) {
    throw new Error("Frozen DNF query evidence failed input or content hash verification");
  }
  const stderr = boundedText(join(acquisition, "repoquery.stderr"), MAX_METADATA);
  if (provenance.stderrSha256 !== hash(stderr)) throw new Error("Frozen DNF stderr failed content hash verification");
  if (provenance.exitCode !== 0) {
    const reportPath = join(acquisition, "acquisition-report.json");
    if (!existsSync(reportPath)) writeJson(reportPath, { schema: 1, available: false, packageRecords: 0, queryPatterns: patterns.length,
      reason: "Official DNF repository query did not return usable provider evidence", exitCode: provenance.exitCode, timedOut: provenance.timedOut ?? null,
      started: provenance.started, completed: provenance.completed, requirementsSha256: hash(requirementBytes),
      rawQueryPath: stdoutPath, rawQuerySha256: hash(raw), stderrPath: join(acquisition, "repoquery.stderr"), stderrSha256: hash(stderr),
      queryMetadataPath: provenancePath, queryMetadataSha256: hash(boundedText(provenancePath, MAX_METADATA)) });
    throw new Error(`Official repository query unavailable (exit ${provenance.exitCode}); frozen report: ${reportPath}`);
  }
  const records = [...new Map(parseNativeRpmQuery(raw).map((record) => [hash(JSON.stringify(record)), record])).values()];
  const providers = [];
  for (const record of records) {
    const path = `${record.name}-${hash(JSON.stringify(record)).slice(0, 20)}.rpm.json`;
    const bytes = `${JSON.stringify(record, null, 2)}\n`;
    const target = join(acquisition, path);
    if (!existsSync(target)) writeFileSync(target, bytes, { flag: "wx" });
    else if (boundedText(target, MAX_METADATA) !== bytes) throw new Error("Frozen RPM record changed");
    providers.push({ metadata: { path, format: "rpm-json", sha256: hash(bytes) }, platform: "linux",
      conditions: [`Available from official Fedora ${record.repoid} repository; not installed or selected`, `RPM owner EVR ${record.epoch}:${record.version}-${record.release}; not a claim about an embedded API version`] });
  }
  providers.sort((a, b) => a.metadata.path.localeCompare(b.metadata.path));
  const manifest = { schema: 1, providers };
  if (!existsSync(manifestPath)) writeJson(manifestPath, manifest);
  else if (boundedText(manifestPath, MAX_METADATA) !== `${JSON.stringify(manifest, null, 2)}\n`) throw new Error("Frozen RPM manifest changed");
  const reportPath = join(acquisition, "acquisition-report.json");
  if (!existsSync(reportPath)) writeJson(reportPath, { schema: 1, manifestPath, requirementsSha256: hash(requirementBytes), rawQueryPath: stdoutPath, rawQuerySha256: hash(raw), queryMetadataSha256: hash(boundedText(provenancePath, MAX_METADATA)), queriedPatterns: patterns.length, packageRecords: records.length,
    prerequisites: records.length ? [] : ["No official Fedora/updates owners returned for literal requested export files"] });
  return { manifestPath, reportPath, queryPatterns: patterns.length, packageRecords: records.length };
}

async function main(args) {
  const options = new Map(); const repositories = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--fetch") options.set(args[i], true);
    else if (args[i] === "--repository" && args[i + 1]) repositories.push(args[++i]);
    else if (["--requirements", "--output", "--source-root"].includes(args[i]) && args[i + 1]) options.set(args[i], args[++i]);
    else throw new Error(`Unknown or incomplete argument: ${args[i]}`);
  }
  if (!options.get("--requirements") || !options.get("--output")) throw new Error("Use --requirements ARRAY.json --output EXTERNAL_CACHE --repository fedora=HTTPS_EXACT_RELEASE_BASE [--source-root SOURCE] [--fetch]");
  const inventory = JSON.parse(boundedText(resolve(options.get("--requirements")), 32 * 1024 * 1024));
  if (!Array.isArray(inventory)) throw new Error("Expected requirements array");
  console.log(JSON.stringify(await acquireNativeRpmProviders({ requirements: inventory.flatMap((row) => row.requirements || [row]),
    output: options.get("--output"), sourceRoot: options.get("--source-root"), repositories, fetch: options.has("--fetch") })));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
