import { createHash } from "node:crypto";
import { join, relative } from "node:path";

import { hashRegularFile, readRegularTextFile } from "../lib/core/boundedFile.js";
import { nativeProgramNames, nativeProviderPlatformAccepts, nativePythonDistributionName, nativePythonWheelProvider, nativePythonWheelTarget } from "../lib/ecosystems/nativeExternalMetadata.js";
import { fetchNativeAcquisitionBytes, nativeAcquisitionUrl } from "./native-acquisition-policy.js";
import { nativeProviderCacheWriter } from "./native-provider-cache.js";

const API = "https://pypi.org/pypi/";
const FILES = "https://files.pythonhosted.org/";
const MAX_WHEEL = 64 * 1024 * 1024;
const MAX_PROJECTS = 160;
const TARGETS = ["darwin", "linux", "win32"];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function nativePyPiAllowed(allowedHosts) {
  try { nativeAcquisitionUrl(API, allowedHosts); nativeAcquisitionUrl(FILES, allowedHosts); return true; }
  catch { return false; }
}

export function nativePyPiQueryPlan(requirements) {
  const names = new Map(); const prefixes = new Map(); const programs = new Map();
  const add = (index, candidate, program) => {
    if (!candidate) return;
    if (!index.has(candidate)) index.set(candidate, new Set());
    index.get(candidate).add(program);
  };
  for (const requirement of requirements) for (const program of nativeProgramNames(requirement)) {
    const search = program.replace(/\.exe$/i, "");
    const distribution = nativePythonDistributionName(search);
    if (!distribution || distribution.length > 80) continue;
    const targets = TARGETS.filter((platform) => nativeProviderPlatformAccepts({ platform }, requirement));
    if (!targets.length) continue;
    if (!programs.has(program)) programs.set(program, new Set());
    programs.get(program).add(targets.join(","));
    // Exact queries first; stripping a final suffix supplies only a search key
    // (e.g. a distribution that also declares *-build). It never proves ownership.
    add(names, distribution, program);
    if (distribution.includes("-")) add(prefixes, distribution.slice(0, distribution.lastIndexOf("-")), program);
  }
  const projects = new Map(names);
  for (const [candidate, exports] of prefixes) for (const name of exports) add(projects, candidate, name);
  return { programs: [...programs.keys()].sort(), targets: Object.fromEntries([...programs].map(([name, guards]) => [name, [...guards].sort()])),
    projects: [...projects].slice(0, MAX_PROJECTS).map(([name, exports]) => [name, [...exports].sort()]),
    limitReached: projects.size > MAX_PROJECTS };
}


/** PyPI has no public console-script reverse index. Only bounded literal
 * candidate queries are made, and only wheel inventory authorizes a match. */
export async function acquireNativePyPiProviders({ plan, retained = [], output, manifestName = "native-provider-metadata.json", sourceRoot, fetch: network = false, allowedHosts, deadline }) {
  const writer = nativeProviderCacheWriter(output, sourceRoot);
  const memberships = new Set(); const providers = new Map(); const rejected = new Map();
  const projects = new Map();
  let metadataBudget = 64 * 1024 * 1024; let wheelBudget = 128 * 1024 * 1024; let followups = 16;
  if (!network) throw new Error("Public wheel acquisition requires explicit fetch permission");
  const observe = (platform, exports, name) => {
    if (!exports.some((entry) => entry.name === name)) return false;
    let relevant = false;
    for (const allowed of plan.targets[name]) if (platform === "any" || allowed.split(",").includes(platform)) {
      memberships.add(`${name}:${allowed}`); relevant = true;
    }
    return relevant;
  };
  const covered = (name) => plan.targets[name].every((allowed) => memberships.has(`${name}:${allowed}`));
  for (const provider of retained) {
    if (!plan.programs.filter((name) => observe(provider.platform, provider.exports, name)).length) continue;
    const path = relative(output, provider.metadataPath);
    const sha256 = /^records\/([a-f0-9]{64})\.json$/.exec(path)?.[1];
    if (sha256) providers.set(sha256, { metadata: { path, format: "pypi-wheel", sha256: provider.metadataSha256 } });
  }
  const projectDemands = new Map(plan.projects);
  const inspect = async (project) => {
    const projectUrl = `${API}${encodeURIComponent(project)}/json`;
    const maximum = Math.min(metadataBudget, 16 * 1024 * 1024);
    if (maximum <= 0) throw new Error("PyPI project metadata byte budget exceeded");
    const metadataPath = `projects/${project}.json`;
    const pinPath = `projects/${project}.sha256`;
    const expected = readRegularTextFile(join(output, pinPath), 128, output)?.trim();
    let metadata = expected && readRegularTextFile(join(output, metadataPath), maximum, output);
    let fetched = false;
    if (!metadata || hash(metadata) !== expected) {
      metadataBudget -= maximum;
      const { bytes } = await fetchNativeAcquisitionBytes(projectUrl, { allowedHosts, deadline, maximum }).catch((error) => {
        if (/HTTP \d{3}$/.test(error.message)) metadataBudget += maximum;
        throw error;
      });
      metadataBudget += maximum - bytes.length;
      metadata = bytes.toString("utf8");
      fetched = true;
    } else metadataBudget -= Buffer.byteLength(metadata);
    const document = JSON.parse(metadata);
    const { name, version } = document.info || {};
    if (nativePythonDistributionName(name) !== project || !/^(?:\d+!)?\d[0-9A-Za-z.+_~-]*$/.test(version || "")) throw new Error("PyPI owner identity does not match queried distribution");
    const candidates = [];
    const dependencies = new Set();
    const projectSha256 = hash(metadata);
    if (fetched) {
      writer.write(metadataPath, metadata);
      writer.write(pinPath, `${projectSha256}\n`);
    }
    const requested = projectDemands.get(project) || plan.programs;
    const guards = requested.flatMap((name) => plan.targets[name]);
    const restricted = new Set(guards.filter((guard) => guard !== TARGETS.join(",")).flatMap((guard) => guard.split(",")));
    const fallback = guards.includes(TARGETS.join(","));
    const targets = new Map();
    for (const asset of (Array.isArray(document.urls) ? document.urls : []).slice(0, 256)) {
      if (asset.yanked || asset.packagetype !== "bdist_wheel" || !/^[A-Za-z0-9_.+-]+\.whl$/.test(asset.filename || "") ||
        !/^[a-f0-9]{64}$/.test(asset.digests?.sha256 || "") || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_WHEEL) continue;
      const target = nativePythonWheelTarget(asset.filename);
      if (!target || typeof asset.url !== "string" || !asset.url.startsWith(FILES) ||
        !/^\/packages\/[A-Za-z0-9_./+-]+\.whl$/.test(new URL(asset.url).pathname) || new URL(asset.url).search ||
        new URL(asset.url).pathname.split("/").at(-1) !== asset.filename) continue;
      const key = `${target.platform}:${target.arch || ""}`;
      if (!targets.has(key) || targets.get(key).asset.size > asset.size) targets.set(key, { target, asset });
    }
    const universal = targets.get("any:");
    const ranked = [...targets.values()].sort((a, b) => Number(b.target.arch === process.arch) - Number(a.target.arch === process.arch) ||
      Number(b.target.platform === process.platform) - Number(a.target.platform === process.platform) || a.asset.filename.localeCompare(b.asset.filename));
    const assets = universal ? [universal] : restricted.size ?
      [...restricted].map((platform) => ranked.find((entry) => entry.target.platform === platform)).filter(Boolean) : ranked.slice(0, 2);
    if (!assets.length && fallback) assets.push(...ranked.slice(0, 2));
    if (!assets.length) throw new Error("No bounded, platform-identifiable wheel is published for the returned release");
    let error;
    for (const { target, asset } of assets) {
      const sha256 = asset.digests.sha256;
      const path = `artifacts/${sha256}.whl`;
      const absolutePath = join(output, path);
      try {
        if (hashRegularFile(absolutePath, MAX_WHEEL, output) !== sha256) {
          if (asset.size > wheelBudget) throw new Error("PyPI wheel download byte budget exceeded");
          wheelBudget -= asset.size;
          const { bytes } = await fetchNativeAcquisitionBytes(asset.url, { allowedHosts, deadline, maximum: asset.size });
          if (bytes.length !== asset.size || hash(bytes) !== sha256) throw new Error("PyPI wheel size or SHA256 mismatch");
          writer.write(path, bytes);
        }
        const identity = { name, version, sha256, ...target, url: asset.url };
        const provider = nativePythonWheelProvider(absolutePath, output, identity, new Map([[`${absolutePath}:${sha256}`, true]]), deadline);
        if (!provider) throw new Error("Wheel identity or RECORD does not authenticate the published distribution");
        for (const dependency of provider.dependencies) dependencies.add(dependency);
        const descriptor = JSON.stringify({ schema: 1, ...identity, artifact: path, projectUrl, projectSha256 });
        candidates.push({ exports: provider.exports, platform: provider.platform, descriptor, sha256 });
      } catch (failure) { error ||= failure.message; }
    }
    return { candidates, dependencies, error };
  };
  const getProject = (name) => {
    if (!projects.has(name)) projects.set(name, inspect(name).catch((error) => ({ error: error.message })));
    return projects.get(name);
  };
  const match = (result, requested) => {
    if (result.error && !/HTTP 404$/.test(result.error)) for (const name of requested) rejected.set(name, result.error);
    for (const { exports, platform, descriptor, sha256 } of result.candidates || []) {
      if (!requested.filter((program) => observe(platform, exports, program)).length) continue;
      if (providers.has(sha256)) continue;
      const path = `records/${sha256}.json`;
      writer.write(path, descriptor);
      providers.set(sha256, { metadata: { path, format: "pypi-wheel", sha256: hash(descriptor) } });
    }
  };
  // A transition distribution can point to one real owner. The dependency
  // declared in verified wheel METADATA supplies only a candidate; the
  // dependency's own wheel must independently attest to the searched export.
  const follow = [];
  for (let at = 0; at < plan.projects.length && Date.now() < deadline; at += 4) {
    const batch = plan.projects.slice(at, at + 4).map(([project, names]) => [project, retained.length ? names.filter((name) => !covered(name)) : names])
      .filter(([, names]) => names.length);
    const results = await Promise.all(batch.map(([name]) => getProject(name)));
    for (const [index, result] of results.entries()) {
      const [project, requested] = batch[index];
      match(result, requested);
      if (result.dependencies?.size === 1) {
        const [candidate] = result.dependencies;
        if (candidate !== project) follow.push([candidate, requested]);
      }
    }
  }
  for (const [project, requested] of follow) {
    const pending = requested.filter((name) => !covered(name));
    if (!pending.length || Date.now() >= deadline) continue;
    if (!projects.has(project) && followups-- <= 0) continue;
    match(await getProject(project), pending);
  }
  const manifestPath = join(output, manifestName);
  writer.write(manifestName, JSON.stringify({ schema: 1, providers: [...providers.values()].sort((a, b) => a.metadata.path.localeCompare(b.metadata.path)) }));
  const missing = plan.programs.filter((name) => !covered(name)).map((name) => ({ requestedName: name,
    prerequisite: rejected.get(name) ||
      (plan.limitReached ? "No exact console-script membership in bounded PyPI candidates; project-query limit reached" : "No exact console-script membership in bounded PyPI candidates") }));
  return { manifestPath, providers: providers.size, missing };
}
