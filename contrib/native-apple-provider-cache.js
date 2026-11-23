import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { parseAllDocuments } from "yaml";

import { readRegularTextFile } from "../lib/core/boundedFile.js";
import { nativeProviderCacheWriter } from "./native-provider-cache.js";
import { fetchNativeAcquisitionBytes, nativeAcquisitionRemaining } from "./native-acquisition-policy.js";

const hash = (text) => createHash("sha256").update(text).digest("hex");
const gitBlob = (text) => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex");
const descriptor = (d) => ({ path: d.path, sha256: hash(d.text) });

/** Derive a framework/dylib's own explicit linker version, never an SDK release. */
export function appleTbdExport(text, requestedName, sourcePath) {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/.test(requestedName || "")) return undefined;
  let documents;
  try {
    // TBD tags identify the format, not executable/custom YAML constructors.
    // Failsafe scalars preserve an actual declared version 1 as "1", not 1.0.
    documents = parseAllDocuments(text.replace(/^---\s+!tapi-tbd(?:-v\d+)?\s*$/gm, "---"), { schema: "failsafe", uniqueKeys: true });
  } catch { return undefined; }
  const matches = [];
  for (const document of documents) {
    if (document.errors.length) return undefined;
    let record;
    try { record = document.toJS({ maxAliasCount: 0 }); } catch { return undefined; }
    if (!record || typeof record !== "object") continue;
    const installName = record["install-name"] || record.install_name;
    const version = record["current-version"] || record.current_version;
    if (typeof installName !== "string" || typeof version !== "string" || !/^\d+(?:\.\d+){0,2}$/.test(version)) continue;
    const framework = /^\/System\/Library\/(?:PrivateFrameworks|Frameworks)\/([^/]+)\.framework\/(?:Versions\/[^/]+\/)?([^/]+)$/.exec(installName);
    let exports;
    if (framework && framework[1] === requestedName && framework[2] === requestedName &&
        sourcePath.startsWith("System/Library/") && sourcePath.includes(`/${requestedName}.framework/`) && basename(sourcePath) === `${requestedName}.tbd`) {
      exports = [{ kind: "framework", name: requestedName }];
    } else if (installName === `/usr/lib/lib${requestedName}.dylib` && sourcePath === `usr/lib/lib${requestedName}.tbd`) {
      exports = [{ kind: "library", name: requestedName }, { kind: "library", name: `lib${requestedName}` }];
    } else continue;
    matches.push({ name: requestedName, version, installName, exports,
      targets: Array.isArray(record.targets) ? record.targets : Array.isArray(record.archs) ? record.archs : [] });
  }
  if (!matches.length || new Set(matches.map((m) => `${m.installName}@${m.version}`)).size !== 1) return undefined;
  return matches[0];
}

async function download(url, maximum, deadline, allowedHosts) {
  return (await fetchNativeAcquisitionBytes(url, { maximum, deadline, allowedHosts })).bytes.toString("utf8");
}

function outsideSource(output, source) {
  let ancestor = output;
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
  const actual = resolve(realpathSync(ancestor), relative(ancestor, output));
  const rel = relative(realpathSync(source), actual);
  if (!rel || !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)) throw new Error("SDK cache must be outside source and cdxgen roots");
}

export function nativeAppleRequestedNames(requirements) {
  const names = new Set();
  for (const requirement of requirements) {
    if (requirement.requestedName !== "appleframeworks") {
      if (/^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/.test(requirement.requestedName || "")) names.add(requirement.requestedName);
      continue;
    }
    const expression = (requirement.arguments || []).find((arg) => /^modules\s*:/.test(arg))?.replace(/^modules\s*:\s*/, "");
    const modules = requirement.modules || requirement.components;
    if (Array.isArray(modules)) {
      for (const name of modules) if (typeof name === "string" && /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/.test(name)) names.add(name);
    } else if (expression?.startsWith("[") && expression.endsWith("]")) {
      const literals = [...expression.matchAll(/(['"])([A-Za-z0-9_][A-Za-z0-9_.+-]*)\1/g)];
      if (!expression.replace(/(['"])([A-Za-z0-9_][A-Za-z0-9_.+-]*)\1/g, "").replace(/[\s,\[\]]/g, "")) {
        for (const literal of literals) names.add(literal[2]);
      }
    }
  }
  return [...names].sort();
}

/** Exact SDK contexts are operator prerequisites, never guessed from framework names. */
export async function acquireNativeAppleProviders({ requirements, output: destination, sourceRoot, specifications, fetch: network = false, allowedHosts, deadline = Date.now() + 4 * 60 * 1000 }) {
  deadline = Math.min(deadline, Date.now() + 4 * 60 * 1000);
  nativeAcquisitionRemaining(deadline);
  const options = new Map([["--output", destination], ["--source-root", sourceRoot]]);
  if (network) options.set("--fetch", true);
  if (!specifications?.length) throw new Error("Exact immutable SDK repository and platform are required");
  const sources = specifications.map((specification) => {
    const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([a-f0-9]{40}):([A-Za-z][A-Za-z0-9_.-]+\.sdk)$/.exec(specification);
    if (!match) throw new Error("Each SDK must have an explicit repository, immutable commit and safe SDK directory");
    return { repository: match[1], revision: match[2], sdk: match[3] };
  });
  const output = resolve(options.get("--output"));
  outsideSource(output, resolve(options.get("--source-root")));
  outsideSource(output, resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  const writer = nativeProviderCacheWriter(output, options.get("--source-root"));
  const inventoryText = JSON.stringify(requirements);
  const names = nativeAppleRequestedNames(requirements);
  const acquisitions = [];
  const inaccessible = [];
  const rejected = [];
  const providers = [];
  const evidenceSources = [];
  const resolvedNames = new Set();
  const acquire = async (path, url, maximum = 4 * 1024 * 1024, expectedBlob) => {
    nativeAcquisitionRemaining(deadline);
    let text = readRegularTextFile(join(output, path), maximum, output);
    if (text === undefined) {
      if (!options.has("--fetch")) throw new Error(`Missing frozen metadata ${path}; explicit --fetch required`);
      text = await download(url, maximum, deadline, allowedHosts);
      if (expectedBlob && gitBlob(text) !== expectedBlob) throw new Error(`Source bytes do not match immutable Git blob ${path}`);
      writer.write(path, text);
    }
    if (expectedBlob && gitBlob(text) !== expectedBlob) throw new Error(`Frozen source bytes do not match immutable Git blob ${path}`);
    acquisitions.push({ path, url, sha256: hash(text), ...(expectedBlob ? { gitBlob: expectedBlob } : {}) });
    return { path, text };
  };
  for (const source of sources) {
    const prefix = `evidence/${source.repository}/${source.revision}`;
    const api = `https://api.github.com/repos/${source.repository}`;
    const raw = `https://raw.githubusercontent.com/${source.repository}/${source.revision}/${source.sdk}`;
    try {
      const commit = await acquire(`${prefix}/commit.json`, `${api}/git/commits/${source.revision}`);
      const commitData = JSON.parse(commit.text);
      if (commitData.sha !== source.revision || !/^[a-f0-9]{40}$/.test(commitData.tree?.sha || "")) throw new Error("Invalid immutable SDK repository commit metadata");
      const root = await acquire(`${prefix}/root-tree.json`, `${api}/git/trees/${commitData.tree.sha}`);
      const rootData = JSON.parse(root.text);
      const sdkEntry = rootData.tree?.find((e) => e.type === "tree" && e.path === source.sdk);
      if (rootData.truncated || !sdkEntry) throw new Error("Exact SDK directory absent from immutable repository root");
      const tree = await acquire(`${prefix}/${source.sdk}/sdk-tree.json`, `${api}/git/trees/${sdkEntry.sha}?recursive=1`, 16 * 1024 * 1024);
      const treeData = JSON.parse(tree.text);
      if (treeData.truncated || !Array.isArray(treeData.tree)) throw new Error("Truncated SDK export inventory is not evidence of absence");
      const settingsEntry = treeData.tree.find((e) => e.type === "blob" && e.path === "SDKSettings.json" && e.mode !== "120000");
      if (!settingsEntry) throw new Error("SDK lacks actual SDKSettings.json provenance");
      const settings = await acquire(`${prefix}/${source.sdk}/SDKSettings.json`, `${raw}/SDKSettings.json`, 1024 * 1024, settingsEntry.sha);
      const sdkSettings = JSON.parse(settings.text);
      if (typeof sdkSettings.Version !== "string" || !sdkSettings.CanonicalName) throw new Error("SDK release provenance is missing");
      const canonical = sdkSettings.CanonicalName;
      const platform = /^macosx/.test(canonical) ? "darwin" : /^iphonesimulator/.test(canonical) ? "ios-simulator" : /^iphoneos/.test(canonical) ? "ios" :
        /^watchsimulator/.test(canonical) ? "watchos-simulator" : /^watchos/.test(canonical) ? "watchos" : /^appletvsimulator/.test(canonical) ? "tvos-simulator" : /^appletvos/.test(canonical) ? "tvos" : undefined;
      if (!platform) throw new Error("Exact SDK platform is not evidenced in SDKSettings.json");
      const sdkProvenance = { directory: source.sdk, version: sdkSettings.Version, canonicalName: sdkSettings.CanonicalName, displayName: sdkSettings.DisplayName, repository: `https://github.com/${source.repository}`, revision: source.revision };
      // The complete recursive inventory is retained separately: it can exceed
      // the loader's per-evidence cap. Snapshot evidence is original owner
      // metadata plus the actual stub, whose Git blob is checked against it.
      const commonEvidence = [commit, root, settings].map(descriptor);
      evidenceSources.push({ ...sdkProvenance, evidence: [...commonEvidence, descriptor(tree)] });
      const candidates = treeData.tree.filter((entry) => {
        if (entry.type !== "blob" || entry.mode === "120000" || !entry.path.endsWith(".tbd")) return false;
        if (!/^(?:System\/Library\/(?:PrivateFrameworks|Frameworks)\/|usr\/lib\/)/.test(entry.path)) return false;
        const name = basename(entry.path, ".tbd").replace(/^lib(?=lockdown$)/, "");
        return names.includes(name);
      });
      for (let i = 0; i < candidates.length; i += 4) {
        const results = await Promise.all(candidates.slice(i, i + 4).map(async (entry) => {
          const name = basename(entry.path, ".tbd").replace(/^lib(?=lockdown$)/, "");
          try {
            const document = await acquire(`${prefix}/${source.sdk}/${entry.path}`, `${raw}/${entry.path}`, 8 * 1024 * 1024, entry.sha);
            const exported = appleTbdExport(document.text, name, entry.path);
            if (!exported) {
              rejected.push({ name, sdk: source.sdk, path: entry.path, prerequisite: "No unambiguous explicit owner current-version matching the actual install-name and export path" });
              return undefined;
            }
            const snapshot = { schema: 1, name, versionKind: "release", version: exported.version, platform,
              repository: sdkProvenance.repository, sourceRevision: source.revision, sdk: sdkProvenance, installName: exported.installName, versionSource: "tbd-current-version",
              targets: exported.targets, exports: exported.exports, evidence: [...commonEvidence, descriptor(document)] };
            const path = `${source.sdk}-${name}-${hash(entry.path).slice(0, 12)}.json`;
            const text = `${JSON.stringify(snapshot, null, 2)}\n`;
            writer.write(path, text);
            return { name, version: exported.version, versionSource: "tbd-current-version", platform, sdk: source.sdk, installName: exported.installName,
              metadata: { path, format: "provider-snapshot", sha256: hash(text) } };
          } catch (error) { inaccessible.push({ name, sdk: source.sdk, path: entry.path, prerequisite: error.message }); return undefined; }
        }));
        for (const result of results.filter(Boolean)) { providers.push(result); resolvedNames.add(result.name); }
      }
    } catch (error) { inaccessible.push({ ...source, prerequisite: error.message }); }
  }
  providers.sort((a, b) => a.metadata.path.localeCompare(b.metadata.path));
  const missing = names.filter((name) => !resolvedNames.has(name)).map((name) => ({ name,
    prerequisite: "Exact requested SDK/platform framework or dylib metadata with explicit owner current-version is required; SDK release and another platform are not substitutes" }));
  const manifest = join(output, "native-provider-metadata.json");
  writer.write("native-provider-metadata.json", `${JSON.stringify({ schema: 1, providers: providers.map((p) => ({ metadata: p.metadata })) }, null, 2)}\n`);
  writer.write("acquisition-report.json", `${JSON.stringify({ schema: 1, selected: false, requirementsSha256: hash(inventoryText), sources: evidenceSources, providers, missing, inaccessible, rejected,
    acquisitions: acquisitions.sort((a, b) => a.path.localeCompare(b.path)) }, null, 2)}\n`);
  return { manifestPath: manifest, providers: providers.length, missing, inaccessible, rejected };
}

async function main(args) {
  const options = new Map(); const specifications = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--fetch") options.set(args[i], true);
    else if (args[i] === "--sdk") specifications.push(args[++i]);
    else if (["--requirements", "--output", "--source-root"].includes(args[i]) && args[i + 1]) options.set(args[i], args[++i]);
    else throw new Error(`Unknown or incomplete argument ${args[i]}`);
  }
  const text = options.get("--requirements") && readRegularTextFile(resolve(options.get("--requirements")), 32 * 1024 * 1024);
  if (!text || !options.get("--output") || !options.get("--source-root")) throw new Error("Use --requirements ARRAY.json --output EXTERNAL_CACHE --source-root SOURCE --sdk REPOSITORY@COMMIT:SDK.sdk [--fetch]");
  const inventory = JSON.parse(text);
  if (!Array.isArray(inventory)) throw new Error("Expected requirements array");
  console.log(JSON.stringify(await acquireNativeAppleProviders({ requirements: inventory.flatMap((row) => row.requirements || [row]), output: options.get("--output"),
    sourceRoot: options.get("--source-root"), specifications, fetch: options.has("--fetch") })));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
