import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { coerce, satisfies } from "semver";

import { readRegularTextFile } from "../lib/core/boundedFile.js";
import { nativeVcpkgProvider, nativeWrapProvider } from "../lib/ecosystems/nativeExternalMetadata.js";
import { acquireNativeProviderSourceMetadata } from "./native-provider-artifacts.js";
import { fetchNativeAcquisitionBytes, nativeAcquisitionRemaining } from "./native-acquisition-policy.js";

const hash = (text) => createHash("sha256").update(text).digest("hex");
const namePattern = /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/;
const releasePattern = /^(\d[0-9A-Za-z.+_~-]*)-(\d+)$/;

/** All descendant writes stay in the canonical external cache. Existing links
 * are refused before mkdir/open, including destination-file symlinks. */
export function nativeProviderCacheWriter(output, sourceRoot) {
  const target = resolve(output);
  const source = sourceRoot && realpathSync(resolve(sourceRoot));
  const inside = (root, path) => { const rel = relative(root, path); return !rel || !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`); };
  let ancestor = target;
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
  const prospective = resolve(realpathSync(ancestor), relative(ancestor, target));
  if (source && inside(source, prospective)) throw new Error("Provider cache must be outside source root");
  mkdirSync(target, { recursive: true });
  const root = realpathSync(target);
  const destination = (path) => {
    if (typeof path !== "string" || isAbsolute(path)) throw new Error("Cache destinations must be relative");
    const file = resolve(root, path);
    if (!inside(root, file) || source && inside(source, file)) throw new Error("Unsafe provider cache destination");
    return file;
  };
  const directory = (path) => {
    const dir = destination(path);
    let current = root;
    for (const part of relative(root, dir).split(sep).filter(Boolean)) {
      current = join(current, part);
      if (source && inside(source, current)) throw new Error("Cache destination enters source root");
      let stats;
      try { stats = lstatSync(current); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (stats?.isSymbolicLink() || stats && !stats.isDirectory()) throw new Error("Unsafe provider cache directory");
      if (!stats) mkdirSync(current);
      if (!inside(root, realpathSync(current))) throw new Error("Cache directory escapes output root");
    }
    return dir;
  };
  const guardedFile = (path) => {
    const file = destination(path);
    directory(relative(root, dirname(file)));
    let stats;
    try { stats = lstatSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (stats && !stats.isFile()) throw new Error("Unsafe provider cache file");
    return file;
  };
  return {
    mkdir: directory,
    // Streaming callers must open this guarded canonical path with
    // O_EXCL|O_NOFOLLOW for new temporaries, and guard both paths before rename.
    file: guardedFile,
    write(path, content) {
      const file = guardedFile(path);
      const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW || 0), 0o600);
      try { writeFileSync(fd, content); } finally { closeSync(fd); }
    },
  };
}

function accepts(recipeVersion, requirement) {
  const version = coerce(releasePattern.exec(recipeVersion)?.[1]);
  if (!version) return false;
  let constraint = (requirement.constraints || "").trim();
  if (!constraint) return true;
  if (/^\d+(?:\.\d+)* EXACT$/.test(constraint)) constraint = `=${constraint.replace(/ EXACT$/, "")}`;
  else if (/^\d+(?:\.\d+)*$/.test(constraint)) constraint = `${["find_package", "find_dependency"].includes(requirement.command) ? ">=" : "="}${constraint}`;
  // Do not interpret build-language expressions as numeric constraints.
  if (!/^(?:>=|<=|==|!=|>|<|=)?\s*\d+(?:\.\d+)*$/.test(constraint)) return false;
  if (constraint.startsWith("!=")) return !satisfies(version, `=${constraint.slice(2)}`);
  return satisfies(version, constraint.replace(/^==/, "="));
}

/** Freeze actual concrete releases, never synthesize a release from a minimum. */
export function selectNativeProviderRecipes(catalog, requirements) {
  const needed = new Map();
  for (const requirement of requirements) {
    const names = new Set((requirement.providerCandidates || []).filter((c) => c.kind === "wrapdb-catalog" && namePattern.test(c.name || "")).map((c) => c.name));
    if (["dependency", "pkg_check_modules", "pkg_search_module"].includes(requirement.command)) {
      for (const [name, record] of Object.entries(catalog)) if (record.dependency_names?.includes(requirement.requestedName)) names.add(name);
    }
    for (const name of names) {
      if (!catalog[name]) continue;
      const entries = needed.get(name) || []; entries.push(requirement); needed.set(name, entries);
    }
  }
  const selected = [];
  for (const [name, entries] of [...needed].sort(([a], [b]) => a.localeCompare(b))) {
    const versions = (catalog[name].versions || []).filter((v) => typeof v === "string" && releasePattern.test(v));
    const chosen = new Set(versions.slice(0, 1));
    for (const requirement of entries) {
      const compatible = versions.find((version) => accepts(version, requirement));
      if (compatible) chosen.add(compatible);
    }
    for (const recipeVersion of chosen) selected.push({ name, recipeVersion, selected: false,
      requestedNames: [...new Set(entries.map((r) => r.requestedName))] });
  }
  return selected;
}

async function boundedFetch(url, maxBytes, deadline, allowedHosts) {
  return (await fetchNativeAcquisitionBytes(url, { maximum: maxBytes, deadline, allowedHosts })).bytes.toString("utf8");
}

/** Reusable orchestration; requests come directly from discovery, not a ledger. */
export async function acquireNativeProviders({ requirements, output: destination, sourceRoot, fetch: network = false, registryRevision, allowedHosts, catalog: catalogFile, seedCache, expandRecipes = true, sourceMetadata = true, deadline = Date.now() + 10 * 60 * 1000 }) {
  deadline = Math.min(deadline, Date.now() + 10 * 60 * 1000);
  nativeAcquisitionRemaining(deadline);
  const values = new Map([["--output", destination], ["--source-root", sourceRoot], ["--registry-revision", registryRevision], ["--seed-cache", seedCache]]);
  if (network) values.set("--fetch", true);
  if (registryRevision) values.set("--vcpkg", true);
  if (expandRecipes) values.set("--expand-recipes", true);
  if (sourceMetadata) values.set("--source-metadata", true);
  const output = resolve(values.get("--output"));
  const seed = values.get("--seed-cache") && resolve(values.get("--seed-cache"));
  const cached = (path, cap) => readRegularTextFile(join(output, path), cap) ?? (seed ? readRegularTextFile(join(seed, path), cap) : undefined);
  const source = values.get("--source-root") && realpathSync(resolve(values.get("--source-root")));
  if (source) {
    let parent = output;
    while (!existsSync(parent) && dirname(parent) !== parent) parent = dirname(parent);
    const resolvedOutput = resolve(realpathSync(parent), relative(parent, output));
    const rel = relative(source, resolvedOutput);
    if (!rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))) throw new Error("Provider cache must be outside source root");
  }
  const writer = nativeProviderCacheWriter(output, source);
  const catalogUrl = "https://wrapdb.mesonbuild.com/v2/releases.json";
  let catalogText;
  if (catalogFile) catalogText = readRegularTextFile(resolve(catalogFile), 4 * 1024 * 1024);
  else catalogText = cached("releases.json", 4 * 1024 * 1024);
  if (!catalogText && network) catalogText = await boundedFetch(catalogUrl, 4 * 1024 * 1024, deadline, allowedHosts);
  if (!catalogText) catalogText = "{}";
  const catalog = JSON.parse(catalogText);
  const selections = selectNativeProviderRecipes(catalog, requirements);
  writer.mkdir("recipes");
  writer.write("releases.json", catalogText);
  const providers = []; const inaccessible = []; const rejected = [];
  // Four package records at a time; every metadata/source request is bounded.
  for (let i = 0; i < selections.length; i += 4) {
    await Promise.all(selections.slice(i, i + 4).map(async (selection) => {
      const { name, recipeVersion } = selection;
      const url = `https://wrapdb.mesonbuild.com/v2/${name}_${recipeVersion}/${name}.wrap`;
      const path = `recipes/${name}_${recipeVersion}.wrap`;
      try {
        let recipe = cached(path, 1024 * 1024);
        if (!recipe && network) recipe = await boundedFetch(url, 1024 * 1024, deadline, allowedHosts);
        const provider = recipe && nativeWrapProvider(recipe, name);
        if (!provider || provider.recipeVersion !== recipeVersion) throw new Error("Missing or invalid concrete recipe/version/source hash/exports");
        writer.write(path, recipe);
        providers.push({ name, acquisitionUrl: url, catalogPath: "releases.json", catalogSha256: hash(catalogText),
          metadata: { path, format: "wrap", sha256: hash(recipe) } });
      } catch (error) { inaccessible.push({ ...selection, url, prerequisite: error.message }); }
    }));
  }
  if (values.has("--vcpkg")) {
    let revision = values.get("--registry-revision");
    // Registry context must be an explicit immutable operator/source revision.
    // Do not turn an unversioned requirement into an invented latest release.
    if (!/^[a-f0-9]{40}$/i.test(revision || "")) throw new Error("Registry acquisition requires a concrete --registry-revision or explicit --fetch");
    const base = `https://raw.githubusercontent.com/microsoft/vcpkg/${revision}`;
    const baselinePath = join(output, `vcpkg-baseline-${revision}.json`);
    let baselineText = cached(`vcpkg-baseline-${revision}.json`, 4 * 1024 * 1024);
    if (!baselineText && network) baselineText = await boundedFetch(`${base}/versions/baseline.json`, 4 * 1024 * 1024, deadline, allowedHosts);
    if (!baselineText) throw new Error("Missing frozen registry baseline");
    const baseline = JSON.parse(baselineText).default;
    writer.write(relative(output, baselinePath), baselineText);
    const names = [...new Set(requirements.filter((r) => ["find_package", "find_dependency", "dependency"].includes(r.command))
      .map((r) => r.requestedName?.toLowerCase()).filter((name) => namePattern.test(name || "") && baseline[name]))].sort();
    const treePath = `vcpkg-tree-${revision}.json`;
    let treeText = values.has("--expand-recipes") && cached(treePath, 8 * 1024 * 1024);
    if (values.has("--expand-recipes") && !treeText && network) treeText = await boundedFetch(`https://api.github.com/repos/microsoft/vcpkg/git/trees/${revision}?recursive=1`, 8 * 1024 * 1024, deadline, allowedHosts);
    const registryFiles = new Map();
    if (treeText) {
      const tree = JSON.parse(treeText);
      if (tree.truncated) throw new Error("Incomplete registry tree metadata");
      writer.write(treePath, treeText);
      for (const item of tree.tree || []) {
        const match = /^ports\/([^/]+)\/(.+\.(?:cmake|in|pc)|usage|vcpkg\.json)$/.exec(item.path);
        if (item.type !== "blob" || !match || item.size > 1024 * 1024) continue;
        const files = registryFiles.get(match[1]) || []; files.push(match[2]); registryFiles.set(match[1], files);
      }
    }
    const acquired = new Map();
    const getRegistryFile = (port, file, optional = false) => {
      const path = `vcpkg/${revision}/${port}/${file}`;
      if (acquired.has(path)) return acquired.get(path);
      const pending = (async () => {
        let content = cached(path, 1024 * 1024);
        if (content === undefined && values.has("--fetch")) {
          try { content = await boundedFetch(`${base}/ports/${port}/${file}`, 1024 * 1024, deadline, allowedHosts); }
          catch (error) { if (optional && /HTTP 404$/.test(error.message)) return undefined; throw error; }
        }
        if (content === undefined) { if (optional) return undefined; throw new Error(`Missing ${port}/${file}`); }
        writer.write(path, content);
        return { content, descriptor: { path, sha256: hash(content) } };
      })();
      acquired.set(path, pending); return pending;
    };
    for (let i = 0; i < names.length; i += 4) {
      await Promise.all(names.slice(i, i + 4).map(async (name) => {
        const prefix = `vcpkg/${revision}/${name}`;
        writer.mkdir(prefix);
        const get = (file, optional = false) => getRegistryFile(name, file, optional);
        try {
          const [metadata, recipe, usage] = await Promise.all([get("vcpkg.json"), get("portfile.cmake"), get("usage", true)]);
          const supplemental = []; const seenPorts = new Set();
          const collectFiles = async (port, depth = 0) => {
            if (depth > 4 || seenPorts.has(port) || !namePattern.test(port)) return;
            seenPorts.add(port);
            const files = (registryFiles.get(port) || []).filter((file) => port !== name || !["vcpkg.json", "portfile.cmake", "usage"].includes(file)).slice(0, 128);
            for (let at = 0; at < files.length; at += 4) {
              const entries = await Promise.all(files.slice(at, at + 4).map((file) => getRegistryFile(port, file)));
              supplemental.push(...entries);
            }
            const texts = port === name ? [recipe.content, ...supplemental.map((item) => item.content)] : supplemental.map((item) => item.content);
            for (const text of texts) for (const match of text.matchAll(/\$\{CMAKE_CURRENT_LIST_DIR\}\/\.\.\/([A-Za-z0-9_.+-]+)\/[^"'\s)]+/g)) await collectFiles(match[1], depth + 1);
          };
          if (values.has("--expand-recipes")) await collectFiles(name);
          const record = JSON.parse(metadata.content);
          let provider = nativeVcpkgProvider(metadata.content, recipe.content, usage?.content,
            new Map(supplemental.map((item) => [join(output, item.descriptor.path), item.content])), join(output, recipe.descriptor.path));
          if (!provider && values.has("--source-metadata")) {
            const acquired = await acquireNativeProviderSourceMetadata({ record, recipe: recipe.content, usage: usage?.content,
              files: new Map(supplemental.map((item) => [join(output, item.descriptor.path), item.content])),
              recipePath: join(output, recipe.descriptor.path), output, writer, fetch: network, deadline, allowedHosts });
            supplemental.push(...acquired.metadata);
            inaccessible.push(...acquired.failures);
            provider = nativeVcpkgProvider(metadata.content, recipe.content, usage?.content,
              new Map(supplemental.map((item) => [join(output, item.descriptor.path), item.content])), join(output, recipe.descriptor.path));
          }
          if (!provider) throw new Error("Recipe lacks a concrete source artifact/version or an evidenced CMake export (SDK/meta ports intentionally excluded)");
          const declared = record["version-semver"] || record.version || record["version-date"] || record["version-string"];
          if (declared !== baseline[name].baseline || (record["port-version"] || 0) !== baseline[name]["port-version"]) throw new Error("Registry package does not match frozen baseline");
          providers.push({ name, registryRevision: revision, acquisitionUrl: `${base}/ports/${name}/vcpkg.json`,
            metadata: { ...metadata.descriptor, format: "vcpkg-json" }, recipe: recipe.descriptor,
            ...(usage ? { usage: usage.descriptor } : {}), ...(supplemental.length ? { supplemental: supplemental.map((item) => item.descriptor) } : {}) });
        } catch (error) {
          const failures = /^(?:Recipe lacks|Registry package does not match)/.test(error.message) ? rejected : inaccessible;
          failures.push({ name, registryRevision: revision, url: `${base}/ports/${name}/vcpkg.json`, prerequisite: error.message, selected: false });
        }
      }));
    }
  }
  providers.sort((a, b) => a.metadata.path.localeCompare(b.metadata.path));
  writer.write("native-providers.json", `${JSON.stringify({ schema: 1, catalog: { url: catalogUrl, path: "releases.json", sha256: hash(catalogText) }, providers }, null, 2)}\n`);
  writer.write("inaccessible.json", `${JSON.stringify(inaccessible, null, 2)}\n`);
  writer.write("rejected-recipes.json", `${JSON.stringify(rejected, null, 2)}\n`);
  return { manifestPath: join(output, "native-providers.json"), inaccessible, rejected, providers: providers.length };
}

async function main(args) {
  const values = new Map();
  for (let i = 0; i < args.length; i++) {
    if (["--fetch", "--vcpkg", "--expand-recipes", "--source-metadata"].includes(args[i])) values.set(args[i], true);
    else if (["--requirements", "--output", "--source-root", "--catalog", "--registry-revision", "--seed-cache"].includes(args[i]) && args[i + 1]) values.set(args[i], args[++i]);
    else throw new Error(`Unknown or incomplete argument ${args[i]}`);
  }
  const text = values.get("--requirements") && readRegularTextFile(resolve(values.get("--requirements")), 32 * 1024 * 1024);
  if (!text || !values.get("--output")) throw new Error("Use --requirements ARRAY.json --output EXTERNAL_CACHE [--source-root SOURCE] [--fetch]");
  const inventory = JSON.parse(text);
  if (!Array.isArray(inventory)) throw new Error("Expected requirements array");
  const result = await acquireNativeProviders({ requirements: inventory.flatMap((row) => row.requirements || [row]), output: values.get("--output"),
    sourceRoot: values.get("--source-root"), fetch: values.has("--fetch"), registryRevision: values.get("--registry-revision"),
    catalog: values.get("--catalog"), seedCache: values.get("--seed-cache"), expandRecipes: values.has("--expand-recipes"), sourceMetadata: values.has("--source-metadata") });
  console.log(JSON.stringify(result));
  if (result.inaccessible.length) process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
