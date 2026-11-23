import { spawnSync } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { readRegularTextFile } from "../core/boundedFile.js";
import { applyPurl, tryBuildPurl } from "../inventory/purl.js";
import { parseCmakeCommands } from "../parsers/cmakeLists.js";
import { nativeFactsHash } from "./nativeDependencyFacts.js";
import {
  bindNativeObservedProvider,
  loadNativeExternalMetadata,
  nativeInstalledLibraryObserver,
  nativeInstalledToolObserver,
  nativeProviderPlatformAccepts,
  nativeProgramNames,
  nativePythonDistributionName,
} from "./nativeExternalMetadata.js";

// Explicit CMake Find-module/package identities, not normalized-name guesses.
const cmakePcModules = new Map([
  ["ZLIB", "zlib"], ["zlib", "zlib"], ["OpenSSL", "openssl"],
  ["LibElf", "libelf"], ["LibELF", "libelf"], ["ELF", "libelf"],
  ["Libunwind", "libunwind"], ["LibUnwind", "libunwind"],
  ["LibDRM", "libdrm"], ["LibXml2", "libxml-2.0"],
  ["LibLZMA", "liblzma"], ["ZSTD", "libzstd"], ["zstd", "libzstd"],
  ["FFI", "libffi"], ["CURL", "libcurl"], ["EXPAT", "expat"],
  ["BZip2", "bzip2"], ["SQLite3", "sqlite3"], ["LibEdit", "libedit"],
]);
const llvmToolVersion = /^LLVM \([^()\r\n]+\):\r?\n[ \t]*LLVM version (\d+(?:\.\d+)+)(?:\r?\n[\s\S]*)?$/;
const tools = new Map([
  ["Python3", ["python3", ["-I", "-S", "-c", "import sys; print('.'.join(map(str, sys.version_info[:3])))"], /^(\d+\.\d+\.\d+)$/]],
  ["Python", ["python3", ["-I", "-S", "-c", "import sys; print('.'.join(map(str, sys.version_info[:3])))"], /^(\d+\.\d+\.\d+)$/]],
  ["Git", ["git", ["--version"], /^git version (\d+(?:\.\d+)+)(?:\s.*)?$/]],
  ["Perl", ["perl", ["-e", "printf '%vd', $^V"], /^(\d+(?:\.\d+)+)$/]],
  ["PkgConfig", ["pkg-config", ["--version"], /^(\d+(?:\.\d+)+)$/]],
  ["FLEX", ["flex", ["--version"], /^flex (\d+(?:\.\d+)+)$/]],
  ["BISON", ["bison", ["--version"], /^bison \(GNU Bison\) (\d+(?:\.\d+)+)(?:\r?\n[\s\S]*)?$/]],
  ["Doxygen", ["doxygen", ["--version"], /^(\d+(?:\.\d+)+)$/]],
  ["LLVMAr", ["llvm-ar", ["--version"], llvmToolVersion]],
  ["LLVMNm", ["llvm-nm", ["--version"], /^llvm-nm, compatible with GNU nm\r?\nLLVM \([^()\r\n]+\):\r?\n[ \t]*LLVM version (\d+(?:\.\d+)+)(?:\r?\n[\s\S]*)?$/]],
  ["LLVMRanLib", ["llvm-ranlib", ["--version"], llvmToolVersion]],
  ["Sphinx", ["sphinx-build", ["--version"], /^sphinx-build (\d+(?:\.\d+)+)$/, ["sphinx-build2"]]],
  ["Cython", ["cython", ["--version"], /^(?:Cython|cython) version (\d+(?:\.\d+)+)$/, ["cython3"], "stdout-or-stderr"]],
  ["OCaml", ["ocamlfind", ["ocamlc", "-version"], /^(\d+(?:\.\d+)+)$/]],
  ["Gcov", ["gcov", ["--version"], /^gcov \([^\r\n]+\) (\d+(?:\.\d+)+)(?:[^\r\n]*(?:\r?\n[\s\S]*)?)$/]],
  ["GCOV", ["gcov", ["--version"], /^gcov \([^\r\n]+\) (\d+(?:\.\d+)+)(?:[^\r\n]*(?:\r?\n[\s\S]*)?)$/]],
]);
const inside = (root, file) => {
  const rel = relative(root, file);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
};
const finderKeywords = new Set(["NAMES", "NAMES_PER_DIR", "HINTS", "PATHS", "PATH_SUFFIXES", "DOC", "NO_CACHE", "REQUIRED", "OPTIONAL", "NO_DEFAULT_PATH", "NO_PACKAGE_ROOT_PATH", "NO_CMAKE_PATH", "NO_CMAKE_ENVIRONMENT_PATH", "NO_SYSTEM_ENVIRONMENT_PATH", "NO_CMAKE_SYSTEM_PATH", "NO_CMAKE_INSTALL_PREFIX", "CMAKE_FIND_ROOT_PATH_BOTH", "ONLY_CMAKE_FIND_ROOT_PATH", "NO_CMAKE_FIND_ROOT_PATH", "ENV", "VALIDATOR"]);
const validModule = (name) => typeof name === "string" && /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/.test(name);

function constraintsAccept(version, raw, command) {
  let parts;
  const text = (raw || "").trim();
  if (text.startsWith("[")) {
    // Meson stores literal lists; do not evaluate build-language expressions.
    if (!/^\[\s*(['"])[^'"\\]*\1(?:\s*,\s*(['"])[^'"\\]*\2)*\s*\]$/.test(text)) return false;
    parts = [...text.matchAll(/['"]([^'"]*)['"]/g)].map((m) => m[1]);
  } else parts = [text];
  const compare = (requested) => {
    if (!/^\d+(?:\.\d+)*$/.test(version)) return undefined;
    const a = version.split(".").map(Number);
    const b = requested.split(".").map(Number);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0) ? 1 : -1;
    }
    return 0;
  };
  return parts.every((part) => {
    if (!part) return true;
    const range = /^(\d+(?:\.\d+)*)\.\.\.(<)?(\d+(?:\.\d+)*)$/.exec(part);
    if (range) {
      const low = compare(range[1]); const high = compare(range[3]);
      return low !== undefined && high !== undefined && low >= 0 && (range[2] ? high < 0 : high <= 0);
    }
    const match = /^(>=|<=|==|!=|>|<|=)?\s*(\d+(?:\.\d+)*)( EXACT)?$/.exec(part.trim());
    if (!match) return false;
    const c = compare(match[2]);
    if (c === undefined) return false;
    const op = match[3] ? "==" : match[1] || (["find_package", "find_dependency"].includes(command) ? ">=" : "==");
    return op === ">=" ? c >= 0 : op === "<=" ? c <= 0 : op === ">" ? c > 0 : op === "<" ? c < 0 : op === "!=" ? c !== 0 : c === 0;
  });
}

function requirementIdentity(requirement) {
  if (requirement.role !== "software" && !(requirement.role === "tool" && requirement.command === "find_program")) return undefined;
  const name = requirement.requestedName;
  const args = requirement.arguments || [];
  // Unknown controls/roots are predicates, not a reason to discard a literal owner identity.
  if (requirement.providerCandidates?.some((p) => p.selected)) return undefined;
  if (requirement.command === "find_program") {
    const names = nativeProgramNames(requirement);
    return names.length ? { kind: "program", name, toolNames: names, identityVia: "cmake-find_program-output" } : undefined;
  }
  if (typeof name !== "string" || /\$\{|\$<|@[A-Za-z_]/.test(name)) return undefined;
  if (requirement.command === "dependency" && name === "appleframeworks") {
    const method = args.find((arg) => /^method\s*:/.test(arg));
    if (method && !/^method\s*:\s*['"](?:auto|extraframework)['"]$/.test(method.trim())) return undefined;
    if (requirement.constraints) return undefined; // No aggregate framework release exists.
    const modules = args.find((arg) => /^modules\s*:/.test(arg));
    if (!modules || !/^modules\s*:\s*(?:\[\s*['"][A-Za-z0-9_.+-]+['"](?:\s*,\s*['"][A-Za-z0-9_.+-]+['"])*\s*\]|['"][A-Za-z0-9_.+-]+['"])\s*$/.test(modules)) return undefined;
    const names = [...modules.matchAll(/['"]([A-Za-z0-9_.+-]+)['"]/g)].map((match) => match[1]);
    return { kind: "framework-set", name, frameworkNames: [...new Set(names)], identityVia: "meson-apple-framework-modules" };
  }
  const capability = name.toLowerCase();
  if ((["find_package", "dependency"].includes(requirement.command)) &&
    ["threads", "openmp"].includes(capability)) {
    // An OpenMP API level is not the runtime package's release number.
    if (requirement.constraints) return undefined;
    return { kind: "capability", name: capability, libraryNames: capability === "threads" ? ["pthread"] : ["gomp", "omp", "iomp5", "vcomp"], identityVia: `${requirement.command}:runtime-capability` };
  }
  if (requirement.command === "find_library" && validModule(name)) {
    const names = [];
    let collecting = !args.includes("NAMES");
    for (const arg of args.slice(1)) {
      if (arg === "NAMES") { collecting = true; continue; }
      if (finderKeywords.has(arg)) { collecting = false; continue; }
      if (collecting && validModule(arg)) names.push(arg);
    }
    return names.length ? { kind: "library", name, libraryNames: [...new Set(names)], identityVia: "cmake-find_library-output" } : undefined;
  }
  if (["find_package", "find_dependency"].includes(requirement.command)) {
    if (["Python", "Python3", "Python2", "PythonInterp", "PythonLibs", "PythonLibsNew"].includes(name)) {
      return { kind: "python", name, identityVia: `cmake-python-interface:${name}` };
    }
    if (name === "Pytest") return { kind: "distribution", name: "pytest", identityVia: "cmake-pytest-tool" };
    const siteTools = { LATEX: ["latex", "pdflatex", "xelatex", "lualatex", "bibtex", "makeindex", "dvips", "dvipdf", "dvipdfmx", "ps2pdf"],
      TAU: ["tau_cxx.sh"], UPCXX: ["upcxx-meta"] };
    if (siteTools[name]) return { kind: "site-tool", name, toolNames: siteTools[name], identityVia: `cmake-site-tool:${name}` };
    if (args.some((arg) => ["CONFIG", "NO_MODULE"].includes(arg))) return { kind: "cmake-package", name, identityVia: `cmake-config-package:${name}` };
    const tool = tools.get(name);
    if (tool) {
      return { kind: "tool", name: tool[0], spec: tool, packageName: name, identityVia: `cmake-package:${name}` };
    }
    const module = cmakePcModules.get(name);
    return module ? { kind: "pkg-config", name: module, packageName: name, identityVia: `cmake-package:${name}` } :
      { kind: "cmake-package", name, identityVia: `cmake-package:${name}` };
  }
  if (requirement.command === "dependency" && validModule(name)) {
    // Explicit methods remain authoritative. Cached SDK exports can prove an
    // actual framework without pretending a pkg-config module was installed.
    const method = args.find((a) => /^method\s*:/.test(a));
    if (method && /^method\s*:\s*['"]extraframework['"]$/.test(method.trim())) return { kind: "framework", name, identityVia: "meson-extra-framework" };
    if (method && !/^method\s*:\s*['"](?:auto|pkg-config)['"]$/.test(method.trim())) return undefined;
    return { kind: "pkg-config", name, allowFramework: !method || /^method\s*:\s*['"]auto['"]$/.test(method.trim()), identityVia: "meson-dependency" };
  }
  if (["pkg_check_modules", "pkg_search_module"].includes(requirement.command) && validModule(name)) {
    // The parser must retain the actual declared module, not a result prefix.
    if (!args.some((a, index) => index > 0 && a.replace(/(?:>=|<=|=|>|<).*$/, "") === name)) return undefined;
    return { kind: "pkg-config", name, identityVia: requirement.command };
  }
  return undefined;
}

function nativeHeaderSearch(command) {
  const names = [];
  const roots = [];
  const keywords = new Set(["NAMES", "HINTS", "PATHS", "PATH_SUFFIXES", "DOC", "ENV", "NO_DEFAULT_PATH", "NO_CACHE", "REQUIRED", "OPTIONAL",
    "NO_CMAKE_PATH", "NO_CMAKE_ENVIRONMENT_PATH", "NO_SYSTEM_ENVIRONMENT_PATH", "NO_CMAKE_SYSTEM_PATH", "NO_PACKAGE_ROOT_PATH"]);
  let mode = "names";
  for (const argument of command.args.slice(1)) {
    if (keywords.has(argument)) { mode = argument === "NAMES" ? "names" : ["HINTS", "PATHS"].includes(argument) ? "roots" : ""; continue; }
    if (mode === "names" && /^[A-Za-z0-9_][A-Za-z0-9_./+-]*$/.test(argument) && !argument.split("/").includes("..")) names.push(argument);
    else if (mode === "roots" && isAbsolute(argument)) roots.push(argument);
  }
  return { names: [...new Set(names)], roots: [...new Set(roots)] };
}

/**
 * Read explicit hash-verified cached metadata independently of host execution.
 * Host observations require BOTH opt-ins; no configure, install or source writes.
 * Available alternatives are not evidence of selection by an original build.
 * Returned ref arrays preserve unmatched callsites when requirements are split.
 */
export function resolveNativeAvailableProviders(sourceRoot, pkgList, dependencies = [], options = {}) {
  const remap = new Map();
  const unchanged = { pkgList, dependencies, remap, observedProviders: 0 };
  const probesEnabled = options.introspect === true && options.nativeVersionProbes === true;
  if (!probesEnabled && !(options.nativeProviderMetadata ?? process.env.CDXGEN_NATIVE_PROVIDER_METADATA)) return unchanged;
  let root;
  try { root = realpathSync(sourceRoot); } catch { return unchanged; }
  const deadline = Date.now() + 60000;
  // Provider probes need only executable lookup, platform essentials and the
  // explicit pkg-config search context. Never forward credentials, loader
  // overrides, language startup options or unrelated ambient configuration.
  const env = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "PKG_CONFIG_PATH", "PKG_CONFIG_LIBDIR", "PKG_CONFIG_SYSROOT_DIR"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  // pkg-config otherwise prefers foo-uninstalled.pc over the installed
  // foo.pc whose path and contents we retain as provider evidence.
  env.PKG_CONFIG_DISABLE_UNINSTALLED = "1";
  const safePaths = (value) => (value || "").split(delimiter).filter((p) => {
    if (!isAbsolute(p)) return false;
    try { return !inside(root, realpathSync(p)); } catch { return false; }
  }).join(delimiter);
  env.PATH = safePaths(env.PATH);
  for (const key of ["PKG_CONFIG_PATH", "PKG_CONFIG_LIBDIR"]) {
    if (env[key] !== undefined) env[key] = safePaths(env[key]);
  }
  const configuration = {
    kind: "available-host-environment", selected: false,
    platform: process.platform, arch: process.arch,
    pkgConfigPath: env.PKG_CONFIG_PATH || "", pkgConfigLibdir: env.PKG_CONFIG_LIBDIR ?? null,
    pkgConfigSysroot: env.PKG_CONFIG_SYSROOT_DIR || "",
    pkgConfigDisableUninstalled: true,
  };
  const configurationJson = JSON.stringify(configuration);
  const configurationId = nativeFactsHash(configurationJson);
  const executableCache = new Map();
  const executable = (name) => {
    if (executableCache.has(name)) return executableCache.get(name);
    let found;
    for (const dir of env.PATH.split(delimiter).filter(Boolean)) {
      try {
        const candidate = join(dir, name);
        const real = realpathSync(candidate);
        accessSync(real, constants.X_OK);
        if (!inside(root, real) && statSync(real).isFile()) { found = candidate; break; }
      } catch { /* An unavailable PATH entry is not a provider. */ }
    }
    executableCache.set(name, found);
    return found;
  };
  const probeOutputs = new Map();
  const run = (path, args, outputStream = "stdout", cwd = tmpdir()) => {
    if (!probesEnabled || !path) return undefined;
    const key = JSON.stringify([path, args, outputStream, cwd]);
    if (probeOutputs.has(key)) return probeOutputs.get(key);
    if (Date.now() >= deadline) return undefined;
    const r = spawnSync(path, args, { cwd, env, encoding: "utf8", timeout: Math.min(3000, Math.max(1, deadline - Date.now())), maxBuffer: 1024 * 1024, windowsHide: true });
    const stdout = (r.stdout || "").trim();
    const output = r.status === 0 ? outputStream === "stdout-or-stderr" ? stdout || (r.stderr || "").trim() : stdout : undefined;
    probeOutputs.set(key, output);
    return output;
  };
  const builtinNames = new Set();
  for (const component of pkgList) for (const property of component.properties || []) {
    if (property.name !== "cdx:build:requirement") continue;
    try {
      const requirement = JSON.parse(property.value);
      if (["find_package", "find_dependency"].includes(requirement.command) && validModule(requirement.requestedName) &&
        !requirement.arguments?.some((argument) => ["CONFIG", "NO_MODULE"].includes(argument))) builtinNames.add(requirement.requestedName);
    } catch { /* Malformed occurrences do not authorize installed module discovery. */ }
  }
  const installedTools = probesEnabled ? nativeInstalledToolObserver(root, executable, run, options) : () => [];
  // Collect installed observations before cached payload interpretation while
  // retaining the unchanged host-probe deadline and authentic receipts.
  const builtinOwners = installedTools({ kind: "cmake-modules", name: "installed", moduleNames: [...builtinNames] });
  const observations = new Map();
  const cachedProviders = [];
  const installedLibraries = probesEnabled ? nativeInstalledLibraryObserver(root, executable, run) : () => [];
  const observedOwners = new Map();
  const providerEvidence = new WeakMap();
  const evidenceOf = (provider) => {
    let evidence = providerEvidence.get(provider);
    if (evidence === undefined) {
      evidence = JSON.stringify(provider);
      providerEvidence.set(provider, evidence);
    }
    return evidence;
  };
  // Preserve the identity input bytes without reserializing the descriptor.
  const identityOf = (contextId, evidence) => nativeFactsHash(`[${JSON.stringify(contextId)},${evidence}]`);
  const rememberOwners = (providers) => {
    for (const provider of providers) observedOwners.set(evidenceOf(provider), provider);
    return providers;
  };
  const observe = (identity) => {
    const key = `${identity.kind}:${identity.name}`;
    if (observations.has(key)) return observations.get(key);
    let observation;
    if (identity.kind === "tool") {
      const providers = installedTools(identity);
      rememberOwners(providers);
      observation = providers[0];
      const distribution = { Sphinx: "Sphinx", Cython: "Cython" }[identity.packageName];
      if (distribution) rememberOwners(installedTools({ kind: "distribution", name: distribution }));
    } else if (identity.kind === "pkg-config") {
      const providers = installedTools(identity);
      rememberOwners(providers);
      observation = providers[0];
    }
    observations.set(key, observation);
    return observation;
  };
  const hostObservations = new Map();
  const hostIdentity = (identity) => JSON.stringify([identity.kind, identity.name, identity.packageName || "",
    identity.libraryNames || identity.toolNames || []]);
  const observeHost = (identity) => {
    const key = hostIdentity(identity);
    if (hostObservations.has(key)) return hostObservations.get(key);
    const providers = ["python", "distribution"].includes(identity.kind) ? installedTools(identity) :
      ["site-tool", "program"].includes(identity.kind) ? [
        ...installedLibraries(identity.toolNames, "tool"),
        ...identity.toolNames.flatMap((name) => installedTools({ kind: "program", name })),
      ] : [observe(identity)].filter(Boolean);
    rememberOwners(providers);
    if (["library", "capability"].includes(identity.kind)) providers.push(...installedLibraries(identity.libraryNames));
    if (identity.kind === "cmake-package" || identity.kind === "pkg-config" && identity.packageName) {
      providers.push(...installedLibraries([identity.packageName || identity.name], "cmake-package"));
    }
    hostObservations.set(key, providers);
    return providers;
  };
  const comparisonVariants = new WeakMap();
  const available = (identity, requirement) => {
    if (identity.kind === "framework-set") {
      const providers = cachedProviders.filter((provider) => nativeProviderPlatformAccepts(provider, requirement) &&
        provider.exports.some((entry) => entry.kind === "framework" && identity.frameworkNames.includes(entry.name)));
      const platforms = new Set(providers.map((provider) => provider.platform || "unknown"));
      const complete = new Set([...platforms].filter((platform) => identity.frameworkNames.every((name) =>
        providers.some((provider) => (provider.platform || "unknown") === platform &&
          provider.exports.some((entry) => entry.kind === "framework" && entry.name === name)))));
      return providers.filter((provider) => complete.has(provider.platform || "unknown"));
    }
    const cached = cachedProviders.filter((provider) => {
      if (!nativeProviderPlatformAccepts(provider, requirement)) return false;
      if (provider.exports.some((exp) =>
        identity.kind === "python" && ["python2", "python3"].includes(provider.name) && provider.kind === "vcpkg-recipe" ||
        identity.kind === "program" && exp.kind === "tool" && identity.toolNames.includes(exp.name) ||
        exp.kind === identity.kind && (exp.name === identity.name ||
          exp.kind === "cmake-package" && exp.caseInsensitive && exp.name.toLowerCase() === identity.name.toLowerCase() ||
          identity.kind === "library" && identity.libraryNames.includes(exp.name)) ||
        identity.kind === "pkg-config" && identity.packageName && exp.kind === "cmake-package" && (exp.name === identity.packageName ||
          exp.caseInsensitive && exp.name.toLowerCase() === identity.packageName.toLowerCase()) ||
        requirement.command === "dependency" && exp.kind === "meson-dependency" && exp.name === requirement.requestedName ||
        exp.kind === "framework" && (requirement.command === "dependency" && identity.allowFramework && exp.name === requirement.requestedName ||
          identity.kind === "library" && identity.libraryNames.includes(exp.name)))) return true;
      // The parser's explicit catalog candidate connects case-sensitive build
      // package identities to a concrete recipe; no new name guessing here.
      return provider.kind === "wrapdb-recipe" && provider.catalogVerified && requirement.providerCandidates?.some((candidate) =>
        candidate.kind === "wrapdb-catalog" && candidate.name === provider.name);
    });
    cached.push(...(hostObservations.get(hostIdentity(identity)) || []));
    if (["python", "program"].includes(identity.kind)) rememberOwners(cached);
    return cached.filter((provider) => nativeProviderPlatformAccepts(provider, requirement)).map((provider) => {
      const metadata = identity.kind === "pkg-config" && provider.exports?.find((entry) =>
        entry.kind === "pkg-config" && entry.name === identity.name && entry.interfaceVersion);
      const version = metadata?.interfaceVersion;
      if (!version || version === (provider.comparisonVersion || provider.version)) return provider;
      let variants = comparisonVariants.get(provider);
      if (!variants) comparisonVariants.set(provider, variants = new Map());
      // A comparison-only descriptor has never inherited the base receipt.
      if (!variants.has(version)) variants.set(version, { ...provider, comparisonVersion: version });
      return variants.get(version);
    });
  };
  const programObservations = new Map();
  const observeProgram = (requirement, names) => {
    if (!probesEnabled || !nativeProviderPlatformAccepts({ platform: process.platform }, requirement)) return;
    for (const name of names) {
      if (!programObservations.has(name)) programObservations.set(name, [
        ...installedLibraries([name], "tool"), ...installedTools({ kind: "program", name }),
      ]);
      rememberOwners(programObservations.get(name).filter((provider) => nativeProviderPlatformAccepts(provider, requirement)));
    }
  };
  for (const component of pkgList) {
    const sourceCandidate = component.version && component.properties?.some((property) =>
      property.name === "cdx:cmake:resolvedVia" && property.value === "source-candidate");
    if (component.version && !sourceCandidate) continue;
    for (const property of component.properties || []) {
      if (property.name !== "cdx:build:requirement") continue;
      try {
        const requirement = JSON.parse(property.value);
        if (requirement.requestedName?.toLowerCase() !== component.name?.toLowerCase()) continue;
        const identity = requirementIdentity(requirement);
        if (identity) {
          if (identity.kind === "program" && requirement.role === "tool") {
            // Observe a host lookup once; cached owners use export demand below.
            observeProgram(requirement, identity.toolNames);
            continue;
          }
          const providers = observeHost(identity);
          if (["library", "capability"].includes(identity.kind)) {
            rememberOwners(providers.filter((provider) => nativeProviderPlatformAccepts(provider, requirement)));
          }
        }
      } catch { /* Unknown/malformed identities cannot authorize extra host probes. */ }
    }
  }
  if (probesEnabled) for (const requirement of options.nativeDiagnosticRequirements || []) {
    if (requirement.role === "diagnostic-probe" && requirement.command === "find_program" &&
      !requirement.providerCandidates?.some((candidate) => candidate.selected)) {
      observeProgram(requirement, nativeProgramNames(requirement));
    }
  }
  const compilerScopes = new Map();
  const requestedPrograms = new Map();
  const moduleInventory = Array.isArray(options.nativeSourceManifests) ? new Map() : undefined;
  for (const file of moduleInventory ? options.nativeSourceManifests : []) {
    if (typeof file !== "string") continue;
    const path = resolve(root, file);
    if (!inside(root, path) || !/^Find.+\.cmake$/.test(basename(path))) continue;
    if (!moduleInventory.has(basename(path))) moduleInventory.set(basename(path), []);
    moduleInventory.get(basename(path)).push(path);
  }
  const builtinModules = new Map();
  for (const provider of rememberOwners(builtinOwners)) for (const entry of provider.exports || []) {
    if (entry.kind === "capability" && entry.name === "cmake-find-module") builtinModules.set(entry.file, entry);
  }
  const moduleObservations = new Map();
  for (const component of pkgList) for (const property of component.properties || []) {
    if (property.name !== "cdx:build:requirement") continue;
    let requirement;
    try { requirement = JSON.parse(property.value); } catch { continue; }
    if (!["find_package", "find_dependency"].includes(requirement.command) || !validModule(requirement.requestedName)) continue;
    const key = JSON.stringify([requirement.file, requirement.requestedName]);
    if (!compilerScopes.has(key)) {
      const candidates = [...(moduleInventory?.get(`Find${requirement.requestedName}.cmake`) || [])];
      if (!moduleInventory) {
        let directory = dirname(join(root, requirement.file || "CMakeLists.txt"));
        for (let depth = 0; depth < 24 && inside(root, directory); depth++, directory = dirname(directory)) {
          for (const location of ["", "cmake", "cmake/Modules", "cmake/modules", "Modules"]) {
            candidates.push(join(directory, location, `Find${requirement.requestedName}.cmake`));
          }
          if (directory === root) break;
        }
      }
      for (const entry of builtinModules.values()) if (entry.moduleName === requirement.requestedName) candidates.push(entry.file);
      const found = { compiler: false, programs: new Set(), libraries: new Set(), headers: [] };
      for (const path of candidates) {
        if (!moduleObservations.has(path)) {
          const builtin = builtinModules.get(path);
          const text = readRegularTextFile(path, 1024 * 1024, builtin?.root || root);
          const commands = text === undefined || builtin && nativeFactsHash(text) !== builtin.sha256 ? [] : parseCmakeCommands(text);
          moduleObservations.set(path, {
            compiler: commands.some((command) => ["check_cxx_source_compiles", "check_cxx_compiler_flag", "check_c_source_compiles", "check_c_compiler_flag"].includes(command.name)),
            programs: commands.filter((command) => command.name === "find_program").flatMap((command) =>
              requirementIdentity({ role: "software", command: "find_program", requestedName: command.args[0], arguments: command.args })?.toolNames || []),
            libraries: commands.filter((command) => command.name === "find_library").flatMap((command) =>
              requirementIdentity({ role: "software", command: "find_library", requestedName: command.args[0], arguments: command.args })?.libraryNames || []),
            headers: commands.filter((command) => ["find_path", "find_file"].includes(command.name)).map(nativeHeaderSearch),
          });
        }
        const observation = moduleObservations.get(path);
        found.compiler ||= observation.compiler;
        for (const name of observation.programs) found.programs.add(name);
        for (const name of observation.libraries) found.libraries.add(name);
        found.headers.push(...observation.headers);
      }
      compilerScopes.set(key, found);
    }
    const observation = compilerScopes.get(key);
    const rememberScopedOwners = (providers) => rememberOwners(providers.filter((provider) =>
      nativeProviderPlatformAccepts(provider, requirement)));
    if (observation?.compiler) rememberScopedOwners(installedTools({ kind: "compiler", name: "host" }));
    for (const name of observation?.programs || []) {
      rememberScopedOwners(installedTools({ kind: "program", name }));
      rememberScopedOwners(installedLibraries([name], "tool"));
      if (!requestedPrograms.has(name)) requestedPrograms.set(name, []);
      requestedPrograms.get(name).push(requirement);
    }
    if (observation) {
      rememberScopedOwners(installedLibraries([...observation.libraries]));
      for (const search of observation.headers) rememberScopedOwners(installedLibraries(search.names, "header-file", search.roots));
    }
  }
  // All request- and source/builtin-Find-derived host observations are now
  // cached. Metadata-only discoveries below never execute additional probes.
  cachedProviders.push(...loadNativeExternalMetadata(options));
  for (const [name, requirements] of requestedPrograms) rememberOwners(cachedProviders.filter((provider) =>
    provider.exports.some((entry) => entry.kind === "tool" && entry.name === name) &&
    requirements.some((requirement) => nativeProviderPlatformAccepts(provider, requirement))));
  const output = [];
  const materializedMetadata = new Set();
  const preservedSourceRefs = new Set();
  const materializedProviders = new Set();
  const sourceIdentityProperties = new Set(["cdx:cmake:resolvedVia", "cdx:cmake:sourceDir", "cdx:cmake:subprojectDir",
    "cdx:cmake:sourceProjectRef", "cdx:cmake:packageExport", "cdx:version:sourceRevision", "cdx:version:sourceIdentity"]);
  const matchedPayloads = new WeakMap();
  const matchedPayloadOf = (provider) => {
    let payload = matchedPayloads.get(provider);
    if (!payload) {
      const context = provider.metadataPath && provider.manifestPath ? {
        kind: "available-cached-metadata", selected: false, platform: provider.platform || null,
        arch: provider.arch || null, manifestPath: provider.manifestPath, manifestSha256: provider.manifestSha256,
        conditions: provider.conditions || [],
      } : configuration;
      const contextJson = context === configuration ? configurationJson : JSON.stringify(context);
      const contextId = context === configuration ? configurationId : nativeFactsHash(contextJson);
      const evidence = evidenceOf(provider);
      const identity = identityOf(contextId, evidence);
      const exportsJson = provider.exports && JSON.stringify(provider.exports.map((entry) =>
        ["package-manifest", "installed-package-file"].includes(provider.kind) || entry.kind === "framework" ? { ...entry, interfaceVersionUnknown: true } : entry));
      payload = { contextJson, contextId, evidence, identity, exportsJson };
      matchedPayloads.set(provider, payload);
    }
    return payload;
  };
  let observedProviders = 0;
  for (const component of pkgList) {
    const properties = component.properties || [];
    const sourceCandidate = Boolean(component.version && properties.some((property) =>
      property.name === "cdx:cmake:resolvedVia" && property.value === "source-candidate"));
    if (component.version && !sourceCandidate) { output.push(component); continue; }
    const requirementProperties = properties.filter((p) => p.name === "cdx:build:requirement");
    const unbound = [];
    const matched = new Map();
    for (const property of requirementProperties) {
      let requirement;
      try { requirement = JSON.parse(property.value); } catch { unbound.push(property); continue; }
      // Project metadata also carries requirements. A consumer must never
      // inherit the version of a dependency mentioned in its properties.
      if (typeof requirement.requestedName !== "string" ||
        requirement.requestedName.toLowerCase() !== component.name?.toLowerCase()) {
        unbound.push(property);
        continue;
      }
      if (requirement.role === "tool" && requirement.command === "find_program") { unbound.push(property); continue; }
      const identity = requirementIdentity(requirement);
      const providers = identity ? available(identity, requirement).filter((provider) =>
        !["python", "distribution", "site-tool", "program"].includes(identity.kind) &&
        !(requirement.arguments || []).some((argument) => /\$\{|\$<|@[A-Za-z_]/.test(argument) || ["HINTS", "PATHS", "NO_DEFAULT_PATH"].includes(argument)) &&
        !(identity.kind === "library" && provider.exports?.some((entry) => entry.kind === "library" &&
          identity.libraryNames.includes(entry.name) && entry.materialUnknown === true)) &&
        !(identity.kind === "library" && provider.exports?.some((entry) => entry.kind === "library" &&
          identity.libraryNames.includes(entry.name) && entry.material === "stub") &&
          !provider.exports.some((entry) => entry.kind === "library" && identity.libraryNames.includes(entry.name) && entry.material !== "stub")) &&
        !(provider.versionKind === "source-revision" && (requirement.constraints || "").trim()) &&
        !(["package-manifest", "installed-package-file"].includes(provider.kind) && (requirement.constraints || "").trim()) &&
        !((requirement.constraints || "").trim() && provider.exports?.some((entry) => entry.kind === "framework")) &&
        !(identity.kind === "pkg-config" && (requirement.constraints || "").trim() &&
          provider.exports?.some((entry) => entry.kind === "pkg-config" && entry.name === identity.name && entry.interfaceVersionUnknown)) &&
        constraintsAccept(provider.comparisonVersion || provider.version, requirement.constraints, requirement.command)) : [];
      if (!providers.length) { unbound.push(property); continue; }
      for (const provider of providers) {
        const key = evidenceOf(provider);
        let group = matched.get(key);
        if (!group) matched.set(key, group = { provider, entries: [] });
        group.entries.push({ requirement, identity });
      }
    }
    if (!matched.size) { output.push(component); continue; }
    const refs = [];
    if (sourceCandidate) {
      output.push(component); refs.push(component["bom-ref"]);
      preservedSourceRefs.add(component["bom-ref"]);
    } else if (unbound.length) {
      output.push({ ...component, properties: [...properties.filter((p) => p.name !== "cdx:build:requirement"), ...unbound] });
      refs.push(component["bom-ref"]);
    }
    for (const { provider, entries } of matched.values()) {
      const name = provider.packageName || component.name;
      const purl = tryBuildPurl({ type: "generic", namespace: sourceCandidate ? null : component.group || null, name, version: provider.version,
        qualifiers: provider.repository ? { vcs_url: provider.repository } : null });
      if (!purl) { if (!refs.includes(component["bom-ref"])) { output.push(component); refs.push(component["bom-ref"]); } continue; }
      const { contextJson, contextId: providerConfigurationId, evidence, identity: providerIdentity, exportsJson } = matchedPayloadOf(provider);
      const ref = `${decodeURIComponent(purl)}#available-native-${providerIdentity.slice(0, 20)}`;
      const candidate = { kind: "available-environment-provider", name: provider.name, ref, configuration: providerConfigurationId, selected: false, compatibility: "satisfied" };
      const copy = { ...component, name, version: provider.version,
        ...(sourceCandidate ? { group: undefined, description: undefined,
          externalReferences: (component.externalReferences || []).filter((reference) => reference.type !== "vcs") } : {}),
        ...(provider.repository ? { externalReferences: [
          ...(component.externalReferences || []).filter((reference) => reference.type !== "vcs"),
          { type: "vcs", url: provider.repository },
        ] } : {}),
        properties: [
        ...properties.filter((p) => !["cdx:build:requirement", "cdx:version:kind"].includes(p.name) &&
          !(sourceCandidate && sourceIdentityProperties.has(p.name))),
        ...entries.map(({ requirement, identity }) => ({ name: "cdx:build:requirement", value: JSON.stringify({ ...requirement,
          providerCandidates: [...(requirement.providerCandidates || []), { ...candidate, identityVia: identity.identityVia }] }) })),
        { name: "cdx:version:kind", value: provider.versionKind || "release" },
        ...(provider.versionKind === "source-revision" ? [{ name: "cdx:version:sourceRevision", value: provider.version }] : []),
        { name: "cdx:native:resolvedVia", value: provider.manifestPath ? "cached-provider-metadata" : "installed-provider-metadata" },
        { name: "cdx:native:providerIdentity", value: providerIdentity },
        { name: "cdx:native:configuration", value: providerConfigurationId },
        { name: "cdx:native:configurationContext", value: contextJson },
        { name: "cdx:native:providerEvidence", value: evidence },
        ...(provider.exports ? [{ name: "cdx:native:providerExports", value: exportsJson }] : []),
        { name: "cdx:native:selection", value: "available-not-selected" },
      ] };
      applyPurl(copy, purl);
      copy["bom-ref"] = ref;
      bindNativeObservedProvider(copy, provider);
      output.push(copy); refs.push(ref); observedProviders++;
      materializedProviders.add(evidence);
      if (provider.metadataPath) materializedMetadata.add(provider.metadataPath);
    }
    if (component["bom-ref"]) remap.set(component["bom-ref"], [...new Set(refs)]);
  }
  const demandedExports = new Map();
  const demand = (kind, name, requirement) => {
    if (!name) return;
    if (!demandedExports.has(kind)) demandedExports.set(kind, new Map());
    const names = demandedExports.get(kind);
    const key = kind === "cmake-package" ? name.toLowerCase() : name;
    if (!names.has(key)) names.set(key, []);
    names.get(key).push(requirement);
  };
  for (const component of pkgList) for (const property of component.properties || []) {
    if (property.name !== "cdx:build:requirement") continue;
    try {
      const requirement = JSON.parse(property.value);
      const identity = requirementIdentity(requirement);
      if (identity) {
        if (identity.toolNames) for (const name of identity.toolNames) demand("tool", name, requirement);
        else if (identity.kind === "capability") demand("capability", identity.name, requirement);
        else for (const name of identity.libraryNames || [identity.name]) demand(identity.kind, name, requirement);
        if (identity.kind === "pkg-config" && requirement.command === "dependency") demand("meson-dependency", identity.name, requirement);
        if (identity.packageName) demand("cmake-package", identity.packageName, requirement);
      } else if (requirement.role === "software" && ["find_package", "find_dependency"].includes(requirement.command) &&
        validModule(requirement.requestedName) && requirement.arguments?.some((arg) => ["CONFIG", "NO_MODULE"].includes(arg))) {
        demand("cmake-package", requirement.requestedName, requirement);
      }
    } catch { /* Malformed requirements cannot authorize owner materialization. */ }
  }
  // Queried header/module owners may need the final Find-module bridge. Keep
  // them available without consuming or inventing a package requirement.
  for (const provider of new Set([...cachedProviders, ...observedOwners.values()])) {
    const header = provider.exports.some((entry) => entry.kind === "header-file");
    const queriedModule = provider.exports.some((entry) => entry.kind === "pkg-config") &&
      pkgList.some((component) => !component.version && component.name?.toLowerCase() === provider.name.toLowerCase());
    const queriedExport = provider.exports.some((entry) =>
      demandedExports.get(entry.kind)?.get(entry.kind === "cmake-package" ? entry.name.toLowerCase() : entry.name)?.some((requirement) => nativeProviderPlatformAccepts(provider, requirement)));
    if ((!header && !queriedModule && !queriedExport && (!observedOwners.size || !observedOwners.has(evidenceOf(provider)))) ||
      provider.metadataPath && materializedMetadata.has(provider.metadataPath)) continue;
    const evidence = evidenceOf(provider);
    if (materializedProviders.has(evidence)) continue;
    const python = ["pypi-wheel", "installed-python-distribution"].includes(provider.kind);
    const name = provider.packageName || provider.name;
    const purl = tryBuildPurl({ type: python ? "pypi" : "generic", name: python ? nativePythonDistributionName(name) : name, version: provider.version,
      qualifiers: provider.repository ? { vcs_url: provider.repository } : null });
    if (!purl) continue;
    const context = provider.manifestPath ? { kind: "available-cached-metadata", selected: false, platform: provider.platform || null,
      arch: provider.arch || null, manifestPath: provider.manifestPath, manifestSha256: provider.manifestSha256, conditions: provider.conditions || [] } : configuration;
    const contextJson = context === configuration ? configurationJson : JSON.stringify(context);
    const contextId = context === configuration ? configurationId : nativeFactsHash(contextJson);
    const identity = identityOf(contextId, evidence);
    const component = { type: "library", name: provider.packageName || provider.name, version: provider.version,
      ...(provider.repository ? { externalReferences: [{ type: "vcs", url: provider.repository }] } : {}),
      properties: [
        { name: "cdx:version:kind", value: provider.versionKind || "release" },
        { name: "cdx:native:resolvedVia", value: provider.manifestPath ? "cached-provider-metadata" : "installed-provider-metadata" },
        { name: "cdx:native:providerIdentity", value: identity },
        { name: "cdx:native:configuration", value: contextId },
        { name: "cdx:native:configurationContext", value: contextJson },
        { name: "cdx:native:providerEvidence", value: evidence },
        { name: "cdx:native:providerExports", value: JSON.stringify(provider.exports) },
        { name: "cdx:native:selection", value: "available-not-selected" },
      ] };
    applyPurl(component, purl);
    component["bom-ref"] = `${decodeURIComponent(purl)}#available-native-${identity.slice(0, 20)}`;
    output.push(component); observedProviders++;
    bindNativeObservedProvider(component, provider);
    materializedProviders.add(evidence);
    if (provider.metadataPath) materializedMetadata.add(provider.metadataPath);
  }
  const refsOf = (ref) => remap.get(ref) || [ref];
  const edges = dependencies.flatMap((edge) => (preservedSourceRefs.has(edge.ref) ? [edge.ref] : refsOf(edge.ref)).map((ref) => ({
    ...edge, ref, dependsOn: [...new Set((edge.dependsOn || []).flatMap(refsOf))],
    ...(edge.provides ? { provides: [...new Set(edge.provides.flatMap(refsOf))] } : {}),
  })));
  return { pkgList: output, dependencies: edges, remap, observedProviders };
}
