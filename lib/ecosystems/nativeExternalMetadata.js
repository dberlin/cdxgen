import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdtempSync, readSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";

import { hashRegularFile, openRegularFile, readRegularTextFile } from "../core/boundedFile.js";
import { parseCmakeCommands } from "../parsers/cmakeLists.js";
import { nativeFactsHash } from "./nativeDependencyFacts.js";
import { nativeMesonSourceExports, nativeMesonTemplateVersions, nativeRegistryRecipeFacts } from "./nativeRegistryMetadata.js";

const inside = (root, file) => {
  const rel = relative(root, file);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
};
const validName = (value) => typeof value === "string" && /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/.test(value);
const validVersion = (value) => typeof value === "string" && /^\d[0-9A-Za-z.+_:~\-]*$/.test(value);
const validProgram = (value) => typeof value === "string" &&
  value.length <= 255 && value.split("/").every(validName);
const programKeywords = new Set(["HINTS", "PATHS", "PATH_SUFFIXES", "NAMES_PER_DIR", "DOC", "NO_CACHE", "REQUIRED", "OPTIONAL",
  "NO_DEFAULT_PATH", "NO_PACKAGE_ROOT_PATH", "NO_CMAKE_PATH", "NO_CMAKE_ENVIRONMENT_PATH", "NO_SYSTEM_ENVIRONMENT_PATH",
  "NO_CMAKE_SYSTEM_PATH", "NO_CMAKE_INSTALL_PREFIX", "CMAKE_FIND_ROOT_PATH_BOTH", "ONLY_CMAKE_FIND_ROOT_PATH",
  "NO_CMAKE_FIND_ROOT_PATH", "REGISTRY_VIEW", "ENV", "VALIDATOR"]);

/** The short CMake signature has one name followed by positional paths. */
export function nativeProgramNames(requirement) {
  if (requirement.command !== "find_program") return [];
  const args = requirement.arguments || [];
  const start = args.findIndex((value, i) => i > 0 && (value === "NAMES" || value === "NAME"));
  const names = [];
  if (start < 0) {
    const name = args.length > 1 ? args[1] : requirement.requestedName;
    if (validProgram(name) && !programKeywords.has(name)) names.push(name);
  } else for (const value of args.slice(start + 1)) {
    if (programKeywords.has(value)) break;
    if (validProgram(value)) names.push(value);
  }
  return [...new Set(names)];
}

/** Executable-bearing CMake finder contracts, not package-name inference.
 * A matching file/entry point proves an available owner, not that the finder
 * version probe, companion files, or configured search will succeed. */
export function nativeFinderToolNames(requirement) {
  if (!["find_package", "find_dependency"].includes(requirement.command) ||
    requirement.arguments?.some((argument) => ["CONFIG", "NO_MODULE", "NAMES", "CONFIGS"].includes(argument))) return [];
  return requirement.requestedName === "Cython" ? ["cython", "cython3", "cython.bat"] :
    requirement.requestedName === "SWIG" ? ["swig"] : [];
}
const observedProviderEvidence = new WeakMap();
const observedProviderSymbol = Symbol("native-observed-provider");
/** Scan-local receipt observations; operator/project data cannot inject this key. */
export const nativeProviderReplay = Symbol("native-provider-replay");

// Only the bounded installed observer can mint a descriptor. Object spreads
// preserve this private symbol; JSON/replay deliberately cannot authorize it.
export function bindNativeObservedProvider(component, provider) {
  if (observedProviderEvidence.has(provider)) component[observedProviderSymbol] = provider;
}

export function nativeObservedProviderEvidence(component) {
  const descriptor = component[observedProviderSymbol];
  const evidence = descriptor && observedProviderEvidence.get(descriptor);
  return evidence ? JSON.parse(evidence) : undefined;
}

/** Installed metadata observations use the same non-serializable receipt as file owners. */
export function nativeInstalledToolObserver(root, executable, run, options = {}) {
  const observations = new Map();
  let distributionOwners;
  const authenticate = (provider) => {
    observedProviderEvidence.set(provider, JSON.stringify(provider));
    return provider;
  };
  const textFile = (path, maximum = 1024 * 1024) => {
    try {
      const real = realpathSync(path);
      return !inside(root, real) ? readRegularTextFile(real, maximum) : undefined;
    } catch { return undefined; }
  };
  const tool = (name, args, pattern, packageName = name, capabilities = [], outputStream = "stdout") => {
    const path = executable(name);
    const output = run(path, args, outputStream);
    const match = output?.match(pattern);
    if (!path || !match) return undefined;
    const version = match[1];
    let realPath;
    try { realPath = realpathSync(path); } catch { return undefined; }
    const provenance = { path, realPath, observationSha256: nativeFactsHash(JSON.stringify([path, realPath, args, output, outputStream])) };
    return { kind: "tool", name, packageName, version, path, realPath, args, output, outputStream,
      platform: process.platform, arch: process.arch,
      exports: [{ kind: "tool", name, file: path, source: path, interfaceVersion: version, provenance },
        ...capabilities.map((name) => ({ kind: "capability", name, source: path, interfaceVersion: version, provenance }))] };
  };
  const python = (name) => {
    const args = name === "python2" ? ["-E", "-s", "-S", "-c", "import sys; print('.'.join(map(str, sys.version_info[:3])))"] :
      ["-I", "-S", "-c", "import sys; print('.'.join(map(str, sys.version_info[:3])))"];
    const provider = tool(name, args, /^(\d+\.\d+\.\d+)$/, name);
    if (!provider || name === "python2" && !provider.version.startsWith("2.") || name === "python3" && !provider.version.startsWith("3.")) return undefined;
    const pythonMajor = Number(provider.version.split(".")[0]);
    const provenance = provider.exports[0].provenance;
    provider.exports.push({ kind: "capability", name: "python-interpreter", source: provider.path,
      interfaceVersion: provider.version, pythonMajor, provenance });
    if (pythonMajor < 3) return provider;
    const code = "import sys,json,sysconfig,struct; print(json.dumps({'version':'.'.join(map(str,sys.version_info[:3])),'include':sysconfig.get_path('include'),'platinclude':sysconfig.get_path('platinclude'),'libdir':sysconfig.get_config_var('LIBDIR'),'library':sysconfig.get_config_var('LDLIBRARY'),'staticLibrary':sysconfig.get_config_var('LIBRARY'),'soabi':sysconfig.get_config_var('SOABI'),'pointerSize':struct.calcsize('P'),'debug':sysconfig.get_config_var('Py_DEBUG')}))";
    const sysconfigArgs = ["-I", "-S", "-c", code];
    const output = run(provider.path, sysconfigArgs);
    let details;
    try { details = JSON.parse(output); } catch { return provider; }
    if (details?.version !== provider.version || ![4, 8].includes(details.pointerSize) ||
      ![0, 1, false, true].includes(details.debug) || typeof details.soabi !== "string" ||
      !/^[A-Za-z0-9_.+-]+$/.test(details.soabi)) return provider;
    provider.sysconfig = { args: sysconfigArgs, output };
    const include = details.include;
    if (typeof include !== "string" || !isAbsolute(include)) return provider;
    const headerPath = join(include, "Python.h");
    const header = textFile(headerPath);
    const patchlevelPath = join(include, "patchlevel.h");
    const patchlevel = textFile(patchlevelPath);
    if (header === undefined || /^\s*#\s*define\s+PY_VERSION\s+"([^"]+)"/m.exec(patchlevel || "")?.[1] !== provider.version) return provider;
    const abi = { pythonMajor, soabi: details.soabi, pointerSize: details.pointerSize, debug: Boolean(details.debug), headerPath,
      interfaceVersion: provider.version, source: headerPath,
      provenance: { path: headerPath, sha256: nativeFactsHash(header), patchlevelPath, patchlevelSha256: nativeFactsHash(patchlevel),
        observationSha256: nativeFactsHash(output) } };
    provider.exports.push({ kind: "header-file", name: "Python.h", file: headerPath, ...abi });
    const pyconfig = textFile(join(include, "pyconfig.h"));
    const pointerSize = /^\s*#\s*define\s+SIZEOF_VOID_P\s+(\d+)/m.exec(pyconfig || "")?.[1];
    const headerDebug = /^\s*#\s*define\s+Py_DEBUG\s+1\b/m.test(pyconfig || "") ? true :
      /(?:#\s*undef\s+Py_DEBUG|#\s*define\s+Py_DEBUG\s+0\b)/m.test(pyconfig || "") ? false : undefined;
    const headerFreeThreaded = /^\s*#\s*define\s+Py_GIL_DISABLED\s+1\b/m.test(pyconfig || "");
    const soabi = /^cpython-(\d+)([dmut]*)(?:-|$)/.exec(details.soabi);
    const headerAbiKnown = Number(pointerSize) === details.pointerSize && headerDebug === Boolean(details.debug) &&
      soabi?.[1] === provider.version.split(".").slice(0, 2).join("") &&
      soabi[2].includes("d") === headerDebug && soabi[2].includes("t") === headerFreeThreaded;
    provider.exports.push({ kind: "capability", name: "python-development-module", ...abi, materialUnknown: !headerAbiKnown });
    const freeThreaded = headerFreeThreaded || soabi?.[2].includes("t");
    if (pyconfig !== undefined && /\bPy_LIMITED_API\b/.test(header) && headerAbiKnown && !freeThreaded) {
      provider.exports.push({ kind: "capability", name: "python-development-sabi", ...abi,
        provenance: { ...abi.provenance, pyconfigSha256: nativeFactsHash(pyconfig) } });
    }
    if (typeof details.libdir === "string" && isAbsolute(details.libdir)) {
      for (const library of [details.library, details.staticLibrary]) {
        if (typeof library !== "string" || basename(library) !== library ||
          !library.includes(`python${provider.version.split(".").slice(0, 2).join(".")}`)) continue;
        const libraryPath = join(details.libdir, library);
        try {
          const real = realpathSync(libraryPath);
          if (inside(root, real) || !statSync(real).isFile()) continue;
          const entries = nativePackageFileExports([libraryPath]).filter((entry) => entry.kind === "library");
          provider.exports.push(...entries.map((entry) => ({ ...entry, ...abi, source: libraryPath, libraryPath: real, materialUnknown: true })));
          provider.exports.push({ kind: "capability", name: "python-development-embed", ...abi, libraryPath: real, materialUnknown: true });
          break;
        } catch { /* Sysconfig's library name alone does not prove material. */ }
      }
    }
    return provider;
  };
  const distributions = () => {
    const site = options.nativeProbeSite ?? process.env.CDXGEN_NATIVE_PROBE_SITE;
    if (typeof site !== "string" || !isAbsolute(site)) return [];
    let directory;
    let entries;
    try { directory = realpathSync(site); entries = readdirSync(directory, { withFileTypes: true }); } catch { return []; }
    if (entries.length > 20000) return [];
    const providers = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.endsWith(".dist-info")) continue;
      const metadataPath = join(directory, entry.name, "METADATA");
      const metadata = readRegularTextFile(metadataPath, 1024 * 1024, directory);
      if (metadata === undefined) continue;
      const name = /^Name:\s*([^\r\n]+)$/m.exec(metadata)?.[1]?.trim();
      const version = /^Version:\s*([^\r\n]+)$/m.exec(metadata)?.[1]?.trim();
      if (!validName(name) || !validVersion(version)) continue;
      const entryPointsPath = join(directory, entry.name, "entry_points.txt");
      const entryPoints = readRegularTextFile(entryPointsPath, 256 * 1024, directory);
      const scripts = iniSections(entryPoints || "").get("console_scripts");
      const recordPath = join(directory, entry.name, "RECORD");
      const record = readRegularTextFile(recordPath, 4 * 1024 * 1024, directory);
      const libraryDirectory = dirname(directory);
      const environment = /^python\d+(?:\.\d+)+$/.test(basename(libraryDirectory)) &&
        /^(?:lib|lib64)$/.test(basename(dirname(libraryDirectory))) ? dirname(dirname(libraryDirectory)) :
        /^lib$/i.test(basename(libraryDirectory)) ? dirname(libraryDirectory) : undefined;
      const exports = [];
      for (const [binary, target] of scripts || []) {
        if (!validName(binary) || !/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*:[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:\s*\[[A-Za-z0-9_, -]+\])?$/.test(target)) continue;
        const versionedTools = { pytest: ["pytest", "py.test"], sphinx: ["sphinx-build", "sphinx-build2"], cython: ["cython", "cython3"] };
        const ownsToolVersion = versionedTools[name.toLowerCase().replaceAll("_", "-")]?.includes(binary) &&
          target.split(/[.:]/, 1)[0].toLowerCase() === name.toLowerCase().replaceAll("-", "_");
        let executableMaterial;
        if (record !== undefined && environment) for (const line of record.split(/\r?\n/)) {
          const fields = /^([^,"\r\n]+),sha256=([A-Za-z0-9_-]{43}),(\d+)$/.exec(line);
          if (!fields) continue;
          const path = resolve(directory, fields[1]);
          if (![binary, `${binary}.exe`].includes(basename(path)) ||
            ![join(environment, "bin"), join(environment, "Scripts")].includes(dirname(path))) continue;
          const sha256 = hashRegularFile(path, 1024 * 1024, environment);
          try {
            const stat = statSync(path);
            if (sha256 && Buffer.from(sha256, "hex").toString("base64url") === fields[2] && stat.size === Number(fields[3]) &&
              (process.platform === "win32" || (stat.mode & 0o111) !== 0)) {
              executableMaterial = { executablePath: path, file: path, executableUnknown: false, executableSha256: sha256,
                recordPath, recordSha256: nativeFactsHash(record) };
              break;
            }
          } catch { /* Unavailable/tampered script does not erase the distribution owner. */ }
        }
        exports.push({ kind: "tool", name: binary,
          ...(ownsToolVersion ? { interfaceVersion: version } : { interfaceVersionUnknown: true }),
          declaredEntryPoint: true, executableUnknown: true,
          ...executableMaterial, source: entryPointsPath,
          provenance: { path: entryPointsPath, sha256: nativeFactsHash(entryPoints), metadataPath, metadataSha256: nativeFactsHash(metadata),
            ...(executableMaterial ? { executablePath: executableMaterial.executablePath, executableSha256: executableMaterial.executableSha256,
              recordPath, recordSha256: executableMaterial.recordSha256 } : {}) } });
      }
      if (!exports.length) continue;
      providers.push({ kind: "installed-python-distribution", name, packageName: name, version, metadataPath,
        metadataSha256: nativeFactsHash(metadata), entryPointsPath, entryPointsSha256: nativeFactsHash(entryPoints),
        platform: process.platform, arch: process.arch, exports });
    }
    return providers;
  };
  return (identity) => {
    const key = `${identity.kind}:${identity.packageName || identity.name}${identity.kind === "cmake-modules" ? `:${JSON.stringify(identity.moduleNames)}` : ""}`;
    if (observations.has(key)) return observations.get(key);
    const found = [];
    if (["distribution", "program"].includes(identity.kind)) {
      if (!distributionOwners) {
        distributionOwners = { distribution: new Map(), program: new Map() };
        const add = (index, name, provider) => {
          let providers = index.get(name);
          if (!providers) index.set(name, providers = []);
          providers.push(provider);
        };
        for (const provider of distributions()) {
          authenticate(provider);
          add(distributionOwners.distribution, provider.name.toLowerCase().replaceAll("_", "-"), provider);
          for (const entry of provider.exports) if (entry.kind === "tool") add(distributionOwners.program, entry.name, provider);
        }
      }
      const name = identity.kind === "program" ? identity.name : identity.name.toLowerCase().replaceAll("_", "-");
      found.push(...(distributionOwners[identity.kind].get(name) || []));
    } else if (identity.kind === "cmake-modules") {
      const names = [...new Set((Array.isArray(identity.moduleNames) ? identity.moduleNames : []).filter(validName))].sort().slice(0, 4096);
      const provider = names.length ? tool("cmake", ["--version"], /^cmake version (\d+(?:\.\d+)+(?:[-+][A-Za-z0-9.-]+)?)(?:\r?\n[\s\S]*)?$/, "CMake") : undefined;
      if (provider) {
        let temporary;
        try {
          const parent = realpathSync(tmpdir());
          if (!inside(root, parent)) {
            temporary = mkdtempSync(join(parent, "cdx-native-cmake-"));
            const script = 'message(STATUS "CMAKE_ROOT \\"${CMAKE_ROOT}\\"")\nmessage(STATUS "CMAKE_VERSION \\"${CMAKE_VERSION}\\"")\n';
            const scriptPath = join(temporary, "installation-report.cmake");
            writeFileSync(scriptPath, script, { flag: "wx", mode: 0o600 });
            const output = run(provider.path, ["-P", scriptPath], "stdout", temporary);
            const report = /^-- CMAKE_ROOT "([^"\r\n]+)"\r?\n-- CMAKE_VERSION "([^"\r\n]+)"$/.exec(output || "");
            if (report && isAbsolute(report[1]) && report[2] === provider.version) {
              const cmakeRoot = realpathSync(report[1]);
              if (!inside(root, cmakeRoot) && statSync(cmakeRoot).isDirectory()) {
                const toolReportSha256 = nativeFactsHash(output);
                const toolReportScriptSha256 = nativeFactsHash(script);
                provider.toolReport = { args: ["-P", "<private-probe-script>"], root: cmakeRoot, version: report[2],
                  sha256: toolReportSha256, scriptSha256: toolReportScriptSha256 };
                for (const moduleName of names) {
                  const file = join(cmakeRoot, "Modules", `Find${moduleName}.cmake`);
                  const content = readRegularTextFile(file, 1024 * 1024, cmakeRoot);
                  if (content === undefined) continue;
                  const sha256 = nativeFactsHash(content);
                  provider.exports.push({ kind: "capability", name: "cmake-find-module", moduleName, file, root: cmakeRoot,
                    sha256, source: file, toolPath: provider.path, toolReportSha256, toolReportScriptSha256,
                    provenance: { path: file, sha256, toolPath: provider.path, toolReportSha256, toolReportScriptSha256 } });
                }
                if (provider.exports.some((entry) => entry.name === "cmake-find-module")) found.push(authenticate(provider));
              }
            }
          }
        } catch { /* A failed installed-tool report cannot authorize a source-local or invented module. */ }
        finally { if (temporary) rmSync(temporary, { recursive: true, force: true }); }
      }
    } else if (identity.kind === "pkg-config") {
      const path = executable("pkg-config");
      const version = run(path, ["--modversion", identity.name]);
      const directory = run(path, ["--variable=pcfiledir", identity.name]);
      if (validVersion(version) && directory && isAbsolute(directory)) {
        try {
          const metadataPath = realpathSync(join(directory, `${identity.name}.pc`));
          const content = textFile(metadataPath);
          if (content !== undefined) {
            const metadataSha256 = nativeFactsHash(content);
            found.push(authenticate({ kind: "pkg-config", name: identity.name, version, path, metadataPath, metadataSha256,
              args: ["--modversion", identity.name], output: version, platform: process.platform, arch: process.arch,
              exports: [{ kind: "pkg-config", name: identity.name, source: metadataPath, interfaceVersion: version,
                provenance: { path: metadataPath, sha256: metadataSha256 } }] }));
          }
        } catch { /* Source-local or unavailable .pc files do not prove installed metadata. */ }
      }
    } else if (identity.kind === "compiler") {
      const byArtifact = new Map();
      for (const [binary, capability] of [["c++", "cxx-compiler"], ["g++", "cxx-compiler"], ["clang++", "cxx-compiler"], ["cc", "c-compiler"], ["gcc", "c-compiler"], ["clang", "c-compiler"]]) {
        const provider = tool(binary, ["--version"], /^(?:(?:c\+\+|g\+\+|cc|gcc) \([^\r\n]+\)|(?:Apple )?clang version)\s+(\d+(?:\.\d+)+)(?:[^\r\n]*(?:\r?\n[\s\S]*)?)$/, binary, [capability]);
        if (!provider) continue;
        const key = JSON.stringify([provider.realPath, provider.version]);
        const existing = byArtifact.get(key);
        if (existing) {
          for (const entry of provider.exports) if (!existing.exports.some((candidate) =>
            candidate.kind === entry.kind && candidate.name === entry.name && candidate.source === entry.source)) existing.exports.push(entry);
        } else byArtifact.set(key, provider);
      }
      found.push(...[...byArtifact.values()].map(authenticate));
    } else if (identity.kind === "python") {
      const names = identity.name === "Python2" ? ["python2"] : identity.name === "PythonInterp" ? ["python3", "python", "python2"] : ["python3", "python"];
      const seen = new Set();
      for (const name of names) {
        if (seen.has(executable(name))) continue;
        const provider = python(name);
        if (provider && !(identity.name === "Python3" && !provider.version.startsWith("3.")) && !seen.has(provider.path)) {
          seen.add(provider.path); found.push(authenticate(provider));
        }
      }
    } else if (identity.kind === "tool") {
      const spec = identity.spec;
      for (const name of identity.packageName === "OCaml" ? [] : [spec[0], ...(spec[3] || [])]) {
        const provider = tool(name, spec[1], spec[2], identity.packageName || name, [], spec[4] || "stdout");
        if (provider) found.push(authenticate(provider));
      }
      if (identity.packageName === "OCaml") {
        const path = executable("ocamlfind");
        const version = run(path, ["ocamlc", "-version"]);
        const stdlib = run(path, ["ocamlc", "-where"]);
        try {
          if (path && /^\d+(?:\.\d+)+$/.test(version || "") && isAbsolute(stdlib) && !inside(root, realpathSync(stdlib)) && statSync(stdlib).isDirectory()) {
            const provenance = { path, observationSha256: nativeFactsHash(JSON.stringify([version, stdlib])) };
            found.push(authenticate({ kind: "tool", name: "ocamlfind", packageName: "OCaml", version, path, stdlibPath: stdlib,
              args: [["ocamlc", "-version"], ["ocamlc", "-where"]], output: [version, stdlib], platform: process.platform, arch: process.arch,
              exports: [{ kind: "tool", name: "ocamlfind", source: path, interfaceVersionUnknown: true, provenance },
                { kind: "capability", name: "ocaml-compiler", source: path, interfaceVersion: version, stdlibPath: stdlib, provenance }] }));
          }
        } catch { /* A version without the actual standard-library path is incomplete. */ }
      }
    }
    observations.set(key, found);
    return found;
  };
}

/** Literal file-list exports, not fuzzy package-name normalization. */
export function nativePackageFileExports(files) {
  const exports = [];
  const seen = new Set();
  const add = (kind, name, file, details = {}) => {
    const valid = kind === "tool" ? validProgram(name) : kind === "header-file" ?
      /^[A-Za-z0-9_][A-Za-z0-9_./+-]*$/.test(name) && !name.split("/").includes("..") : validName(name);
    if (!valid) return;
    const key = `${kind}\0${name}\0${file}`;
    if (seen.has(key)) return;
    seen.add(key);
    exports.push({ kind, name, file, ...details });
  };
  for (const path of (Array.isArray(files) ? files : []).slice(0, 100000)) {
    if (typeof path !== "string") continue;
    const file = basename(path);
    if (file.endsWith(".pc")) add("pkg-config", file.slice(0, -3), path);
    const cmake = /^(.*?)(?:Config|-config)\.cmake$/.exec(file);
    if (cmake) add("cmake-package", cmake[1], path);
    const include = path.replaceAll("\\", "/").match(/(?:^|\/)include\/(.+\.(?:h|hpp|hxx))$/);
    if (include) add("header-file", include[1], path);
    const windowsLibrary = /^(.+)\.[Ll][Ii][Bb]$/.exec(file);
    const library = /^(?:lib)?(.+?)(?:\.so(?:\.\d+)*|(?:\.\d+)*\.dylib|\.a|\.dll)$/.exec(file) || windowsLibrary;
    if (library) {
      const material = /(?:^|[\\/])stubs(?:[\\/]|$)/i.test(path) ? "stub" :
        file.endsWith(".a") ? "static" : windowsLibrary ? "windows-library" : "shared";
      const details = { material, filename: file };
      add("library", file, path, details);
      add("library", library[1], path, details);
      if (windowsLibrary) {
        add("library", file.toLowerCase(), path, details);
        add("library", windowsLibrary[1].toLowerCase(), path, details);
        if (windowsLibrary[1].startsWith("lib")) add("library", windowsLibrary[1].slice(3), path, details);
      }
      if (!windowsLibrary && file.startsWith("lib")) add("library", `lib${library[1]}`, path, details);
      if (material !== "stub" && library[1] === "pthread") add("capability", "threads", path);
      if (material !== "stub" && ["gomp", "omp", "iomp5", "vcomp"].includes(library[1])) add("capability", "openmp", path);
    }
    const program = /(?:^|[\\/])(?:s?bin|libexec)[\\/](.+)$/.exec(path)?.[1]?.replaceAll("\\", "/");
    if (program) {
      const details = { interfaceVersionUnknown: true, executableUnknown: true };
      add("tool", program, path, details);
      if (/\.exe$/i.test(program)) add("tool", program.slice(0, -4), path, details);
    }
    const framework = /(?:^|\/)([^/]+)\.framework(?:\/|$)/.exec(path);
    if (framework) add("framework", framework[1], path);
  }
  return exports;
}

function iniSections(text) {
  const sections = new Map();
  let section;
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) { section = header[1]; if (!sections.has(section)) sections.set(section, new Map()); continue; }
    const entry = /^\s*([^#;=]+?)\s*=\s*(.*?)\s*$/.exec(line);
    if (section && entry) sections.get(section).set(entry[1], entry[2]);
  }
  return sections;
}

/** A WrapDB release is identified by its explicit recipe version, never a filename. */
export function nativeWrapProvider(text, name) {
  const sections = iniSections(text);
  const wrap = sections.get("wrap-file");
  const recipeVersion = wrap?.get("wrapdb_version");
  const release = /^(\d[0-9A-Za-z.+_~-]*)-(\d+)$/.exec(recipeVersion || "");
  const sourceSha256 = wrap?.get("source_hash");
  const sourceUrl = wrap?.get("source_url");
  if (!validName(name) || !release || !/^[a-fA-F0-9]{64}$/.test(sourceSha256 || "") || !/^https:\/\//.test(sourceUrl || "")) return undefined;
  const provided = sections.get("provide");
  const exports = [];
  for (const [key, value] of provided || []) {
    if (key === "dependency_names") {
      for (const entry of value.split(",").map((s) => s.trim()).filter(validName)) exports.push({ kind: "pkg-config", name: entry });
    } else if (key !== "program_names" && validName(key)) exports.push({ kind: "pkg-config", name: key });
  }
  if (!exports.length) return undefined;
  return { kind: "wrapdb-recipe", name, packageName: name, version: release[1], comparisonVersion: release[1],
    recipeVersion, sourceUrl, sourceSha256: sourceSha256.toLowerCase(),
    ...(wrap.get("patch_hash") ? { patchSha256: wrap.get("patch_hash"), patchUrl: wrap.get("patch_url") } : {}), exports };
}

/** Registry package releases require a pinned source recipe and actual exports. */
export function nativeVcpkgProvider(text, recipe, usage = "", files = new Map(), recipePath, options = {}) {
  let record;
  try { record = JSON.parse(text); } catch { return undefined; }
  if (!record || typeof record !== "object" || Array.isArray(record)) return undefined;
  const version = record["version-semver"] || record.version || record["version-date"] || record["version-string"];
  if (!validName(record.name) || !validVersion(version) || /^0(?:\.0)*$/.test(version)) return undefined;
  const facts = nativeRegistryRecipeFacts(record, recipe, files, recipePath);
  const { artifacts, exports } = facts;
  if (!artifacts.length) return undefined; // SDK-discovery/meta ports are not runtime versions.
  const add = (name) => { if (validName(name) && !exports.some((e) => e.kind === "cmake-package" && e.name === name)) exports.push({ kind: "cmake-package", name }); };
  for (const command of parseCmakeCommands(usage)) if (command.name === "find_package" &&
    command.args[0]?.toLowerCase() === record.name.toLowerCase()) add(command.args[0]);
  const archiveMembers = new Map();
  for (const [path, content] of files) if (basename(path) === "archive-manifest.json") {
    try { const archive = JSON.parse(content); if (Array.isArray(archive.members)) archiveMembers.set(dirname(path), new Set(archive.members)); } catch { /* Not source archive ownership evidence. */ }
  }
  const mesonVersions = nativeMesonTemplateVersions([...files].filter(([path]) => basename(path) === "meson.build").map(([, content]) => content));
  for (const [file, content] of files) {
    if (!file.includes(`${sep}source-metadata${sep}`)) continue;
    const pc = /^(.+)\.pc\.in$/.exec(basename(file));
    const declared = /^\s*Version:\s*(.+?)\s*$/m.exec(content)?.[1];
    const substitution = /^@([A-Za-z_]\w*)@$/.exec(declared || "");
    const interfaceVersion = /^\d+(?:\.\d+)*$/.test(declared || "") ? declared : mesonVersions.get(substitution?.[1]);
    if (pc && (substitution || interfaceVersion)) {
      const archive = [...archiveMembers].find(([directory]) => inside(directory, file));
      if (!archive) continue;
      const member = relative(archive[0], file).split(sep).join("/");
      const root = member.split("/")[0];
      let directory = member.slice(0, member.lastIndexOf("/"));
      let independent = false;
      while (directory && directory !== root) {
        const cmakeFile = join(archive[0], directory, "CMakeLists.txt");
        const mesonFile = join(archive[0], directory, "meson.build");
        const cmake = files.get(cmakeFile); const meson = files.get(mesonFile);
        const cmakeOwner = cmake === undefined ? archive[1].has(`${directory}/CMakeLists.txt`) :
          parseCmakeCommands(cmake).some((command) => command.name === "project" && command.args[0]?.toLowerCase() !== record.name.toLowerCase());
        const mesonOwner = meson === undefined ? archive[1].has(`${directory}/meson.build`) :
          /^\s*project\s*\(/m.test(meson.replace(/#[^\n]*/g, ""));
        if (cmakeOwner || mesonOwner || ["configure", "configure.ac", "configure.in", "package.json"].some((name) => archive[1].has(`${directory}/${name}`))) { independent = true; break; }
        directory = directory.includes("/") ? directory.slice(0, directory.lastIndexOf("/")) : "";
      }
      if (independent) continue; // e.g. Python's embedded zlib/libffi are not Python releases.
      if (!exports.some((e) => e.kind === "pkg-config" && e.name === pc[1])) exports.push({ kind: "pkg-config", name: pc[1], source: file, conditions: [],
        ...(interfaceVersion ? { interfaceVersion } : {}), interfaceVersionUnknown: !interfaceVersion });
    }
    if (/\.(?:h|hpp)$/.test(file) && validName(basename(file))) exports.push({ kind: "header-file", name: basename(file), source: file, headerPath: file, conditions: [], global: true });
  }
  const sourceArchives = nativeAuthenticatedSourceArchives(files, artifacts, options.metadataRoot, options.archiveVerification);
  exports.push(...nativeMesonSourceExports(record, files, sourceArchives));
  if (!exports.length) return undefined;
  return { kind: "vcpkg-recipe", name: record.name, packageName: record.name, version, comparisonVersion: version,
    portVersion: record["port-version"] || 0, exports, artifacts,
    conditions: record.supports ? [`vcpkg-supports:${record.supports}`] : [] };
}

function nativeAuthenticatedSourceArchives(files, artifacts, root, verified = new Map()) {
  const identities = new Map();
  if (typeof root !== "string" || !isAbsolute(root)) return identities;
  for (const [inventoryPath, content] of files) {
    if (basename(inventoryPath) !== "archive-manifest.json") continue;
    let inventory;
    try { inventory = JSON.parse(content); } catch { continue; }
    const sha512 = inventory?.sourceSha512;
    if (typeof inventory?.archivePath !== "string" || !/^[a-f0-9]{128}$/i.test(sha512 || "") ||
      !Array.isArray(inventory.members) || inventory.members.length > 100000 ||
      !artifacts.some((artifact) => artifact.sha512?.toLowerCase() === sha512.toLowerCase())) continue;
    const path = resolve(root, inventory.archivePath);
    if (!inside(root, path)) continue;
    const key = `source-digests:${path}:${sha512.toLowerCase()}`;
    if (!verified.has(key)) {
      const actual512 = hashRegularFile(path, 768 * 1024 * 1024, root, "sha512");
      const sha256 = actual512 === sha512.toLowerCase() ? hashRegularFile(path, 768 * 1024 * 1024, root) : undefined;
      verified.set(key, sha256 ? { path, sha512: actual512, sha256 } : undefined);
      if (sha256) verified.set(`${path}:${sha256}`, true);
    }
    const identity = verified.get(key);
    if (!identity) continue;
    const archive = nativeArchiveReader({ artifact: inventory.archivePath, sha256: identity.sha256, files: inventory.members }, root, verified);
    if (!archive) continue;
    const members = new Set(inventory.members);
    const sources = [];
    let matching = true;
    for (const [file, source] of files) {
      if (file === inventoryPath || !inside(dirname(inventoryPath), file)) continue;
      const member = relative(dirname(inventoryPath), file).split(sep).join("/");
      if (!members.has(member)) { matching = false; break; }
      sources.push({ member, source });
    }
    if (!matching || !sources.length) continue;
    archive.prepare(sources.map(({ member }) => member));
    if (sources.some(({ member, source }) => archive.facts(member)?.materialSha256 !== nativeFactsHash(source))) continue;
    const urls = (Array.isArray(inventory.acquisitionUrls) ? inventory.acquisitionUrls : []).filter((value) => {
      try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; } catch { return false; }
    });
    const archiveIdentity = { ...identity, urls };
    Object.defineProperty(archiveIdentity, "regularMembers", { value: (requested) => {
      const listed = [...new Set(requested)].filter((member) => members.has(member));
      archive.prepare(listed);
      return new Set(listed.filter((member) => archive.facts(member)?.materialSha256));
    } });
    identities.set(inventoryPath, archiveIdentity);
  }
  return identities;
}

const archiveMaterialCache = new Map();
const safeArchiveMember = (member) => typeof member === "string" && /^[A-Za-z0-9_.][A-Za-z0-9_./+@ -]*$/.test(member) &&
  !member.startsWith("/") && !member.split("/").includes("..");

/** Inspect only the bounded ZIP directory/local headers; never infer member type or size from concatenated unzip output. */
function nativeZipMemberIndex(path, root, maximum = 2 * 1024 * 1024, wheel = false, deadline = Infinity) {
  const opened = openRegularFile(path, root);
  if (!opened) return undefined;
  try {
    const read = (size, position) => {
      const bytes = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const count = readSync(opened.fd, bytes, offset, size - offset, position + offset);
        if (!count) return undefined;
        offset += count;
      }
      return bytes;
    };
    if (opened.size < 22) return undefined;
    const tailSize = Math.min(opened.size, 65557);
    const tail = read(tailSize, opened.size - tailSize);
    if (!tail) return undefined;
    let end = -1;
    for (let offset = tail.length - 22; offset >= 0; offset--) if (tail.readUInt32LE(offset) === 0x06054b50 &&
      offset + 22 + tail.readUInt16LE(offset + 20) === tail.length) { end = offset; break; }
    if (end < 0 || tail.readUInt16LE(end + 4) !== 0 || tail.readUInt16LE(end + 6) !== 0) return undefined;
    const count = tail.readUInt16LE(end + 10);
    const size = tail.readUInt32LE(end + 12);
    const position = tail.readUInt32LE(end + 16);
    // ZIP64 and multi-volume metadata need an independently supported decoder.
    if (count === 0xffff || count !== tail.readUInt16LE(end + 8) || size > 8 * 1024 * 1024 ||
      position + size !== opened.size - tailSize + end) return undefined;
    const directory = read(size, position);
    if (!directory) return undefined;
    const entries = new Map();
    let offset = 0;
    for (let index = 0; index < count; index++) {
      if ((index & 255) === 0 && Date.now() >= deadline) return undefined;
      if (offset + 46 > directory.length || directory.readUInt32LE(offset) !== 0x02014b50) return undefined;
      const nameSize = directory.readUInt16LE(offset + 28);
      const extraSize = directory.readUInt16LE(offset + 30);
      const commentSize = directory.readUInt16LE(offset + 32);
      const length = 46 + nameSize + extraSize + commentSize;
      if (offset + length > directory.length || directory.readUInt16LE(offset + 34) !== 0) return undefined;
      const flags = directory.readUInt16LE(offset + 8);
      const nameBytes = directory.subarray(offset + 46, offset + 46 + nameSize);
      if (!(flags & 0x800) && nameBytes.some((byte) => byte > 0x7f)) return undefined;
      const name = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(nameBytes);
      const system = directory[offset + 5];
      const attributes = directory.readUInt32LE(offset + 38);
      const mode = (attributes >>> 16) & 0xf000;
      // Wheel builders using ZIP writestr may emit Unix permission bits
      // without S_IFREG. This is a normal wheel file, not a symlink/device.
      const regular = system === 3 ? mode === 0x8000 || wheel && mode === 0 && !(attributes & 0x10) && !name.endsWith("/") :
        [0, 10, 14].includes(system) && !(attributes & 0x10) && [0, 0x8000].includes(mode);
      const record = { name, size: directory.readUInt32LE(offset + 24), regular: regular && !(flags & 1),
        flags, method: directory.readUInt16LE(offset + 10), compressedSize: directory.readUInt32LE(offset + 20),
        localOffset: directory.readUInt32LE(offset + 42), nameBytes };
      if (entries.has(name)) entries.set(name, undefined);
      else entries.set(name, record);
      offset += length;
    }
    if (offset !== directory.length) return undefined;
    for (const [name, record] of entries) {
      if (Date.now() >= deadline) return undefined;
      if (!record?.regular || record.size <= 0 || record.size > maximum) { entries.set(name, undefined); continue; }
      if (record.localOffset + 30 > position) { entries.set(name, undefined); continue; }
      const local = read(30, record.localOffset);
      if (!local || local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== record.flags ||
        local.readUInt16LE(8) !== record.method || local.readUInt16LE(26) !== record.nameBytes.length ||
        record.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28) + record.compressedSize > position) {
        entries.set(name, undefined); continue;
      }
      const localName = read(record.nameBytes.length, record.localOffset + 30);
      if (!localName?.equals(record.nameBytes)) entries.set(name, undefined);
    }
    return entries;
  } catch { return undefined; }
  finally { closeSync(opened.fd); }
}

export const nativePythonDistributionName = (name) => typeof name === "string" &&
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(name) ? name.toLowerCase().replace(/[-_.]+/g, "-") : undefined;

export function nativePythonWheelTarget(filename) {
  const tag = /-([A-Za-z0-9_.]+)\.whl$/.exec(filename)?.[1];
  if (tag === "any") return { platform: "any" };
  if (tag === "win32") return { platform: "win32", arch: "ia32" };
  let platform; let arch;
  for (const part of tag?.split(".") || []) {
    const p = /^win_/.test(part) ? "win32" : /^macosx_/.test(part) ? "darwin" : /^(?:linux|manylinux\w*|musllinux\w*)_/.test(part) ? "linux" : undefined;
    const a = /(?:x86_64|amd64)$/.test(part) ? "x64" : /(?:aarch64|arm64)$/.test(part) ? "arm64" : /(?:i686|i386)$/.test(part) ? "ia32" : undefined;
    if (!p || !a || platform && (platform !== p || arch !== a)) return undefined;
    platform = p; arch = a;
  }
  return platform && arch ? { platform, arch } : undefined;
}

/** An explicit MLIR-AIE release and wheel tag, never an inferred latest build. */
export function nativeMlirAieWheelIdentity(selector) {
  const match = /^(\d+\.\d+\.\d+):(cp\d{2,3})-\2t?-([A-Za-z0-9_.]+)$/.exec(selector || "");
  if (!match) return undefined;
  const [, version] = match;
  const filename = `mlir_aie-${selector.replace(":", "-")}.whl`;
  const target = nativePythonWheelTarget(filename);
  if (!target?.arch) return undefined;
  const repository = "https://github.com/Xilinx/mlir-aie";
  return { name: "mlir-aie", version, filename, ...target, repository,
    releaseUrl: `https://api.github.com/repos/Xilinx/mlir-aie/releases/tags/v${version}`,
    url: `${repository}/releases/download/v${version}/${filename}` };
}

/** Authenticate artifact coordinates against the official release asset list. */
export function nativeMlirAieWheelAsset(release, identity) {
  const { version, filename, url } = identity;
  if (release?.tag_name !== `v${version}` || release.draft !== false || release.prerelease !== false ||
    !/^https:\/\/api\.github\.com\/repos\/Xilinx\/mlir-aie\/releases\/\d+$/.test(release.url || "") ||
    !Array.isArray(release.assets)) return undefined;
  const matching = release.assets.filter((asset) => asset?.name === filename);
  if (matching.length !== 1) return undefined;
  const [asset] = matching;
  const sha256 = /^sha256:([a-f0-9]{64})$/.exec(asset.digest || "")?.[1];
  if (asset.browser_download_url !== url || asset.state !== "uploaded" || !sha256 ||
    !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 320 * 1024 * 1024) return undefined;
  return { sha256, size: asset.size };
}

/** Only a digest-verified wheel can prove a distribution's executable exports.
 * A console entry point declares an install-time launcher; a `.data/scripts`
 * member is a shipped script or binary. Neither is an observed installation.
 */
export function nativePythonWheelProvider(path, root, identity, verified = new Map(), deadline = Date.now() + 10000, archiveLimit = 64 * 1024 * 1024) {
  const { name, version, sha256, platform, arch, url } = identity;
  if (!nativePythonDistributionName(name) || !/^(?:\d+!)?\d[0-9A-Za-z.+_~-]*$/.test(version || "") || !/^[a-f0-9]{64}$/.test(sha256 || "") ||
    !path.endsWith(".whl")) return undefined;
  const key = `${path}:${sha256}`;
  if (Date.now() >= deadline) return undefined;
  if (!verified.has(key)) verified.set(key, nativeTimedDigest(path, root, archiveLimit, deadline) === sha256);
  if (!verified.get(key)) return undefined;
  const index = nativeZipMemberIndex(path, root, 128 * 1024 * 1024, true, deadline);
  if (!index) return undefined;
  const metadataMembers = [...index.keys()].filter((member) => /^[A-Za-z0-9_.+-]+\.dist-info\/METADATA$/.test(member));
  if (metadataMembers.length !== 1) return undefined;
  const metadataPath = metadataMembers[0];
  const prefix = metadataPath.slice(0, -"/METADATA".length);
  const recordPath = `${prefix}/RECORD`;
  const entryPointPath = `${prefix}/entry_points.txt`;
  const readMember = (member, maximum = 2 * 1024 * 1024) => {
    const entry = index.get(member); const remaining = deadline - Date.now();
    if (!entry || entry.size > maximum || remaining <= 0) return undefined;
    const result = spawnSync("/usr/bin/unzip", ["-p", path, member], { cwd: tmpdir(), env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      timeout: Math.min(3000, remaining), maxBuffer: maximum, windowsHide: true });
    if (result.status === 0 && result.stdout.length === entry.size) return result.stdout;
    return undefined;
  };
  const record = readMember(recordPath);
  if (!record) return undefined;
  const records = new Map();
  for (const line of record.toString("utf8").split(/\r?\n/)) {
    const fields = /^(?:"((?:[^"]|"")*)"|([^,"]+)),sha256=([A-Za-z0-9_-]{43}),(\d+)$/.exec(line);
    if (!fields) continue;
    const member = fields[1]?.replaceAll('""', '"') ?? fields[2];
    records.set(member, records.has(member) ? undefined : { hash: fields[3], size: Number(fields[4]) });
  }
  const recorded = (member, maximum) => {
    const expected = records.get(member);
    if (!expected || index.get(member)?.size !== expected.size) return undefined;
    const bytes = readMember(member, maximum);
    if (bytes && Buffer.from(nativeFactsHash(bytes), "hex").toString("base64url") === expected.hash) return bytes;
    return undefined;
  };
  const readRecordedText = (member) => {
    const bytes = recorded(member);
    return bytes && !bytes.includes(0) ? bytes.toString("utf8") : undefined;
  };
  const header = readRecordedText(metadataPath)?.split(/\r?\n\r?\n/, 1)[0];
  if (!header) return undefined;
  const names = [...header.matchAll(/^Name:[ \t]*(\S+)[ \t]*\r?$/gmi)];
  const versions = [...header.matchAll(/^Version:[ \t]*(\S+)[ \t]*\r?$/gmi)];
  if (names.length !== 1 || versions.length !== 1 || nativePythonDistributionName(names[0][1]) !== nativePythonDistributionName(name) ||
    versions[0][1] !== version) return undefined;
  const data = prefix.replace(/\.dist-info$/, ".data");
  const provenance = { path, sha256, url, metadataMember: metadataPath, recordMember: recordPath };
  const exports = [];
  const add = (binary, entry) => {
    if (!validName(binary)) return;
    exports.push({ kind: "tool", name: binary, interfaceVersionUnknown: true, executableUnknown: true, ...entry });
  };
  const entryPoints = readRecordedText(entryPointPath);
  if (entryPoints) for (const [binary, target] of iniSections(entryPoints).get("console_scripts") || []) {
    if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*:[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:\s*\[[A-Za-z0-9_, -]+\])?$/.test(target)) continue;
    add(binary, { declaredEntryPoint: true, entryPointTarget: target, file: entryPointPath, provenance });
  }
  const scripts = `${data}/scripts/`;
  let scriptBudget = 128 * 1024 * 1024;
  for (const [member, entry] of index) {
    if (!entry || !member.startsWith(scripts)) continue;
    const binary = member.slice(scripts.length);
    if (!validName(binary) || records.get(member)?.size !== entry.size || entry.size > Math.min(scriptBudget, 64 * 1024 * 1024)) continue;
    scriptBudget -= entry.size;
    if (!recorded(member, entry.size + 1)) continue;
    add(binary, { file: member, provenance });
    if (/\.exe$/i.test(binary)) add(binary.slice(0, -4), { file: member, provenance });
  }
  const dependencies = [...new Set([...header.matchAll(/^Requires-Dist:[ \t]*([A-Za-z0-9][A-Za-z0-9_.-]*)(?:\s*\([^;\r\n]*\)|\s*[<>=!~][^;\r\n]*)?[ \t]*\r?$/gmi)]
    .map((entry) => nativePythonDistributionName(entry[1])).filter(Boolean))];
  return { kind: "pypi-wheel", name: names[0][1], packageName: names[0][1], version, platform, arch, dependencies,
    versionKind: "release", exports, conditions: ["Public wheel available, not installed or selected"] };
}

function nativeArchiveReader(inventory, directory, verified = new Map(), operationDeadline = Infinity) {
  if (typeof inventory?.artifact !== "string" || !/^[a-f0-9]{64}$/i.test(inventory.sha256 || "") ||
    !Array.isArray(inventory.files) || inventory.files.length > 100000) return undefined;
  const path = resolve(directory, inventory.artifact);
  if (!inside(directory, path) || !/\.(?:tar(?:\.(?:xz|gz|bz2|zst))?|zip)$/.test(path)) return undefined;
  const verificationKey = `${path}:${inventory.sha256.toLowerCase()}`;
  if (!verified.has(verificationKey)) verified.set(verificationKey,
    nativeTimedDigest(path, directory, 768 * 1024 * 1024, operationDeadline) === inventory.sha256.toLowerCase());
  if (!verified.get(verificationKey)) return undefined;
  const zipped = path.endsWith(".zip");
  let executable;
  for (const system of ["/usr/bin", "/bin"]) {
    try {
      const candidate = realpathSync(join(system, zipped ? "unzip" : "tar"));
      if (!inside(directory, candidate) && statSync(candidate).isFile()) { executable = candidate; break; }
    } catch { /* Optional local archive utilities need not be installed. */ }
  }
  if (!executable) return undefined;
  const execute = (args, maximum, timeout = 3000, raw = false) => {
    const remaining = Math.min(timeout, operationDeadline - Date.now());
    if (remaining <= 0) return { status: null };
    return spawnSync(executable, args, { cwd: tmpdir(), env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      encoding: raw ? undefined : "utf8", timeout: remaining, maxBuffer: maximum, windowsHide: true });
  };
  const run = (args, maximum) => {
    const result = execute(args, maximum);
    return result.status === 0 ? result.stdout : undefined;
  };
  const key = `${path}:${inventory.sha256}`;
  let cache = archiveMaterialCache.get(key);
  if (!cache) {
    if (archiveMaterialCache.size >= 32) archiveMaterialCache.delete(archiveMaterialCache.keys().next().value);
    cache = new Map(); archiveMaterialCache.set(key, cache);
  }
  const attempted = new Set();
  // Unknown/non-GNU tar implementations retain owner inventory, not unframed material.
  const prepare = (members) => {
    if (zipped) return;
    const pending = [...new Set(members)].filter((member) => safeArchiveMember(member) &&
      !cache.has(`member:${member}`) && !attempted.has(member));
    if (!pending.length) return;
    // Preserve the original aggregate three-second/member allowance across
    // listing and extraction, rather than repeatedly decompressing a payload.
    const deadline = Math.min(operationDeadline, Date.now() + pending.length * 3000);
    const remaining = () => Math.max(1, deadline - Date.now());
    const capabilityKey = `tar-capability:${executable}`;
    if (!verified.has(capabilityKey)) {
      const version = execute(["--version"], 16384, remaining());
      const banner = `${version.stdout || ""}\n${version.stderr || ""}`;
      verified.set(capabilityKey, version.status === 0 && /^tar \(GNU tar\)/.test(banner) ? "gnu" :
        /(?:^|\n)(?:bsdtar|BusyBox)\b/.test(banner) ||
        version.status !== 0 && /(?:unrecognized|unknown|illegal).*option/i.test(banner) ? "unsupported" : "unknown");
    }
    const capability = verified.get(capabilityKey);
    if (capability === "unsupported") return;
    for (const member of pending) attempted.add(member);
    if (capability !== "gnu" || Date.now() >= deadline) return;
    if (!cache.has("tar-index")) {
      const listing = execute(["-tvf", path, "--numeric-owner", "--full-time", "--quoting-style=literal"], 8 * 1024 * 1024, remaining());
      if (listing.status !== 0) return;
      const records = [];
      for (const line of listing.stdout.split(/\r?\n/).filter(Boolean)) {
        const match = /^([-dlhcbps])[rwxStTs-]{9}[.+@]?\s+\d+\/\d+\s+(\d+)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:\s+[+-]\d{4})? (.+)$/.exec(line);
        if (!match || !Number.isSafeInteger(Number(match[2]))) return;
        const name = match[1] === "l" ? match[3].split(" -> ", 1)[0] :
          match[1] === "h" ? match[3].split(" link to ", 1)[0] : match[3];
        records.push({ name, size: Number(match[2]), regular: match[1] === "-" });
      }
      if (records.length > 100000) return;
      cache.set("tar-index", records);
    }
    const records = cache.get("tar-index");
    const counts = new Map();
    for (const record of records) counts.set(record.name, (counts.get(record.name) || 0) + 1);
    const wanted = new Set(pending);
    const selected = [];
    for (const member of pending) {
      if (counts.get(member) !== 1) cache.set(`member:${member}`, undefined);
    }
    for (const record of records) {
      if (!wanted.has(record.name) || counts.get(record.name) !== 1) continue;
      if (!record.regular || record.size <= 0 || record.size > 2 * 1024 * 1024) cache.set(`member:${record.name}`, undefined);
      else selected.push(record);
    }
    const groups = [];
    let group = [];
    let size = 0;
    for (const record of selected) {
      if (size + record.size > 8 * 1024 * 1024) { groups.push(group); group = []; size = 0; }
      group.push(record); size += record.size;
    }
    if (group.length) groups.push(group);
    for (const batch of groups) {
      if (Date.now() >= deadline) break;
      const output = execute(["-xOf", path, "--", ...batch.map((record) => record.name)], 8 * 1024 * 1024, remaining(), true);
      const bytes = output.stdout;
      if (output.status !== 0 || !Buffer.isBuffer(bytes) || bytes.length !== batch.reduce((total, record) => total + record.size, 0)) continue;
      let offset = 0;
      for (const record of batch) {
        const content = bytes.subarray(offset, offset + record.size);
        offset += record.size;
        if (content.includes(0)) continue;
        let text;
        try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content); } catch { continue; }
        cache.set(`member:${record.name}`, nativeMaterialFacts(text, record.name));
      }
    }
  };
  return { path, sha256: inventory.sha256.toLowerCase(),
    prepare,
    files: () => {
      if (!cache.has("listing")) {
        const listing = run(zipped ? ["-Z1", path] : ["-tf", path], 8 * 1024 * 1024);
        cache.set("listing", listing === undefined ? undefined : listing.split(/\r?\n/).filter(Boolean));
      }
      return cache.get("listing");
    },
    facts: (member) => {
      if (!safeArchiveMember(member)) return undefined;
      const memberKey = `member:${member}`;
      if (!cache.has(memberKey)) {
        if (!zipped) { prepare([member]); return cache.get(memberKey); }
        if (!cache.has("zip-index") && Date.now() < operationDeadline) {
          const index = nativeZipMemberIndex(path, directory, undefined, false, operationDeadline);
          if (Date.now() < operationDeadline) cache.set("zip-index", index);
        }
        const record = cache.get("zip-index")?.get(member);
        if (!record) return undefined;
        const output = execute(["-p", path, member], 2 * 1024 * 1024, 3000, true);
        const bytes = output.stdout;
        if (output.status === 0 && Buffer.isBuffer(bytes) && bytes.length === record.size && !bytes.includes(0)) {
          let content;
          try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return undefined; }
          cache.set(memberKey, nativeMaterialFacts(content, member));
        }
      }
      return cache.get(memberKey);
    } };
}

function nativeMaterialFacts(content, file) {
  const result = { materialSha256: nativeFactsHash(content) };
  if (/\.(?:h|hpp|hxx)$/.test(file)) {
    const headerDefines = {};
    for (const match of content.matchAll(/^\s*#\s*define\s+([A-Za-z_]\w*)[ \t]+([^\r\n]+)$/gm)) {
      const value = match[2].replace(/\s*\/\*.*|\s*\/\/.*/g, "").trim();
      if (/^(?:0x[0-9a-f]+|\d+(?:\.\d+)*|"(?:[^"\\]|\\.)*")$/i.test(value) && value.length <= 256) headerDefines[match[1]] = value;
      if (Object.keys(headerDefines).length >= 128) break;
    }
    result.headerDefines = headerDefines;
  } else if (file.endsWith(".pc")) {
    const version = /^Version:\s*([^\r\n]+)$/m.exec(content)?.[1]?.trim();
    if (validVersion(version)) result.interfaceVersion = version;
    else result.interfaceVersionUnknown = true;
  } else if (file.endsWith(".cmake")) {
    const version = parseCmakeCommands(content).find((command) => command.name === "set" && command.args[0] === "PACKAGE_VERSION")?.args[1];
    if (validVersion(version)) result.interfaceVersion = version;
  }
  return result;
}

function nativeSnapshotMaterials(exports, records, directory, verified, deadline) {
  for (const record of records) {
    if (record.member) {
      for (const entry of exports) if (entry.file === record.member) Object.assign(entry,
        nativeMaterialFacts(record.content, record.member), { source: record.path,
          provenance: { path: record.path, sha256: record.sha256, member: record.member } });
      continue;
    }
    let inventory;
    try { inventory = JSON.parse(record.content); } catch { continue; }
    if (!exports.some((entry) => entry.file && /\.(?:h|hpp|hxx|pc|cmake)$/.test(entry.file))) continue;
    const archive = nativeArchiveReader(inventory, directory, verified, deadline);
    if (!archive) continue;
    const members = [...new Set(exports.filter((entry) => entry.file && /\.(?:h|hpp|hxx|pc|cmake)$/.test(entry.file) &&
      inventory.files.includes(entry.file) && !/(?:^|\/)(?:samples?|examples?)\//.test(entry.file)).map((entry) => entry.file))].slice(0, 128);
    archive.prepare(members);
    for (const member of members) {
      const facts = archive.facts(member);
      if (!facts) continue;
      for (const entry of exports) if (entry.file === member) Object.assign(entry, facts, {
        source: `${archive.path}#${member}`,
        provenance: { path: archive.path, sha256: archive.sha256, member, inventoryPath: record.path, inventorySha256: record.sha256 } });
    }
  }
}

function nativeTimedDigest(path, root, maximum, deadline, start = 0, length) {
  const opened = openRegularFile(path, root);
  if (!opened) return undefined;
  try {
    const size = length ?? opened.size;
    if (size <= 0 || size > maximum || start + size > opened.size) return undefined;
    const bytes = Buffer.allocUnsafe(Math.min(65536, size));
    const digest = createHash("sha256");
    for (let at = 0; at < size;) {
      if (Date.now() >= deadline) return undefined;
      const count = readSync(opened.fd, bytes, 0, Math.min(size - at, bytes.length), start + at);
      if (!count) return undefined;
      digest.update(bytes.subarray(0, count)); at += count;
    }
    return digest.digest("hex");
  } catch { return undefined; } finally { closeSync(opened.fd); }
}

function nativeDebArchivalDataRange(path, directory, requested, deadline) {
  const opened = openRegularFile(path, directory);
  if (!opened) return undefined;
  try {
    const magic = Buffer.alloc(8); const header = Buffer.alloc(60);
    if (readSync(opened.fd, magic, 0, 8, 0) !== 8 || magic.toString() !== "!<arch>\n") return undefined;
    for (let at = 8; at + 60 <= opened.size && Date.now() < deadline;) {
      if (readSync(opened.fd, header, 0, 60, at) !== 60 || header.subarray(58).toString() !== "`\n") return undefined;
      const size = Number(header.subarray(48, 58).toString().trim());
      const name = header.subarray(0, 16).toString().trim().replace(/\/$/, "");
      if (!Number.isSafeInteger(size) || size < 0 || at + 60 + size > opened.size) return undefined;
      if (name === requested) return { start: at + 60, size };
      at += 60 + size + size % 2;
    }
  } catch { return undefined; } finally { closeSync(opened.fd); }
  return undefined;
}

// NVIDIA publishes this APT archive signing fingerprint independently of
// package metadata. The key id in the URL alone is not a trust anchor.
const nvidiaAptFingerprint = "EB693B3035CD5710E231E123A4B469963BF863CC";
export function nativeNvidiaAptReleaseIndex(release, keyring, cwd, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return undefined;
  const result = spawnSync("/usr/bin/gpgv", ["--keyring", keyring, "--status-fd", "2", "--output", "-"], {
    input: release, cwd, env: { PATH: "/usr/bin:/bin", HOME: cwd, GNUPGHOME: cwd, LANG: "C", LC_ALL: "C" },
    encoding: "utf8", timeout: Math.min(3000, remaining), maxBuffer: 2 * 1024 * 1024, windowsHide: true,
  });
  if (result.status !== 0 || !result.stderr.split(/\r?\n/).some((line) => line.startsWith("[GNUPG:] VALIDSIG ") &&
    line.split(" ").at(-1) === nvidiaAptFingerprint)) return undefined;
  const table = /^SHA256:\r?\n((?:[ \t][^\n]*\n)+)/m.exec(result.stdout)?.[1];
  const rows = [...(table || "").matchAll(/^\s+([a-f0-9]{64})\s+(\d+)\s+Packages\.gz\s*$/gm)];
  if (rows.length !== 1) return undefined;
  const size = Number(rows[0][2]);
  if (!Number.isSafeInteger(size) || size <= 0 || size > 8 * 1024 * 1024) return undefined;
  return { sha256: rows[0][1], size };
}

export function nativeNvidiaAptKeyBytes(armor) {
  const base64 = /^-----BEGIN PGP PUBLIC KEY BLOCK-----\r?\n(?:[A-Za-z][A-Za-z -]*:[^\r\n]*\r?\n)*\r?\n((?:[A-Za-z0-9+/=]+\r?\n)+)-----END PGP PUBLIC KEY BLOCK-----\s*$/.exec(armor)?.[1];
  if (!base64) return undefined;
  const body = base64.split(/\r?\n/).filter((line) => line && !line.startsWith("=")).join("");
  const bytes = Buffer.from(body, "base64");
  return bytes.length > 0 && bytes.length < 32768 ? bytes : undefined;
}

function nativeVerifiedCudaInventory(record, materials, directory, verified, deadline) {
  const supplied = (name) => typeof name === "string" ? materials.find((entry) => basename(entry.path) === name) : undefined;
  const inventoryRecord = supplied(record.verifiedInventory);
  let inventory;
  try { inventory = JSON.parse(inventoryRecord?.content || "null"); } catch { return undefined; }
  if (!inventory || inventory.schema !== 1 || typeof inventory.artifact !== "string" ||
    !/^artifacts\/[A-Za-z0-9_.+~\-]+\.(?:tar(?:\.(?:xz|gz|zst|bz2))?|zip)$/.test(inventory.artifact) ||
    !/^[a-f0-9]{64}$/.test(inventory.sha256 || "") || !Array.isArray(inventory.files) || inventory.files.length > 100000 ||
    !Array.isArray(record.files) || record.files.length > 100000) return undefined;
  const path = resolve(directory, inventory.artifact);
  const maximum = 768 * 1024 * 1024;
  const digestKey = `${path}:${inventory.sha256}`;
  if (!verified.has(digestKey)) verified.set(digestKey, nativeTimedDigest(path, directory, maximum, deadline) === inventory.sha256);
  if (!verified.get(digestKey)) return undefined;
  if (inventory.packageArtifact) {
    if (record.platform !== "linux" || record.arch !== "x64" ||
      inventory.repositoryUrl !== "https://developer.download.nvidia.com/compute/cuda/repos/ubuntu1804/x86_64/Packages.gz" ||
      inventory.repositoryPath !== "nvidia-ubuntu1804-x86_64-Packages.gz" ||
      !/^[a-f0-9]{64}$/.test(inventory.repositorySha256 || "") || !/^artifacts\/[A-Za-z0-9_.+~\-]+\.deb$/.test(inventory.packageArtifact) ||
      !/^[a-f0-9]{64}$/.test(inventory.packageSha256 || "")) return undefined;
    const release = supplied(inventory.releasePath);
    if (!release || inventory.releasePath !== "nvidia-ubuntu1804-x86_64.InRelease" ||
      inventory.keyringPath !== "nvidia-3bf863cc.gpg" || !/^[a-f0-9]{64}$/.test(inventory.keyringSha256 || "")) return undefined;
    const keyring = resolve(directory, inventory.keyringPath);
    const signatureKey = `cuda-signature:${release.path}:${release.sha256}:${inventory.keyringSha256}`;
    if (!verified.has(signatureKey)) verified.set(signatureKey,
      nativeTimedDigest(keyring, directory, 32768, deadline) === inventory.keyringSha256 ?
        nativeNvidiaAptReleaseIndex(release.content, keyring, directory, deadline) : undefined);
    const signedIndex = verified.get(signatureKey);
    if (signedIndex?.sha256 !== inventory.repositorySha256) return undefined;
    const immediate = supplied(inventory.stanzaPath)?.content;
    if (!immediate || !immediate.split("\n").includes(`Package: ${record.name}`) ||
      !immediate.split("\n").includes(`Version: ${record.version}`) ||
      !immediate.split("\n").includes(`SHA256: ${inventory.packageSha256}`) ||
      !immediate.split("\n").some((line) => line.replace(/^Filename: (?:\.\/)?/, "") === basename(inventory.packageArtifact))) return undefined;
    const indexPath = resolve(directory, inventory.repositoryPath);
    const indexKey = `cuda-index:${indexPath}:${inventory.repositorySha256}`;
    if (!verified.has(indexKey)) {
      let data;
      const opened = openRegularFile(indexPath, directory);
      if (opened) try {
        if (opened.size === signedIndex.size && Date.now() < deadline) {
          const bytes = Buffer.alloc(opened.size);
          if (readSync(opened.fd, bytes, 0, bytes.length, 0) === bytes.length && nativeFactsHash(bytes) === inventory.repositorySha256) {
            data = `\n\n${gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 }).toString("utf8").trim()}\n\n`;
          }
        }
      } catch { /* A damaged index cannot verify a package stanza. */ } finally { closeSync(opened.fd); }
      verified.set(indexKey, data);
    }
    if (!verified.get(indexKey)?.includes(`\n\n${immediate.trim()}\n\n`)) return undefined;
    const packagePath = resolve(directory, inventory.packageArtifact);
    const packageKey = `${packagePath}:${inventory.packageSha256}`;
    if (!verified.has(packageKey)) verified.set(packageKey, nativeTimedDigest(packagePath, directory, maximum, deadline) === inventory.packageSha256);
    const base = `${basename(packagePath)}.`;
    const archive = basename(path);
    if (!verified.get(packageKey) || !archive.startsWith(base)) return undefined;
    const range = nativeDebArchivalDataRange(packagePath, directory, archive.slice(base.length), deadline);
    if (!range || nativeTimedDigest(packagePath, directory, maximum, deadline, range.start, range.size) !== inventory.sha256) return undefined;
  } else {
    const published = supplied(inventory.vendorManifest)?.content;
    try {
      const component = JSON.parse(published)[record.name];
      const platform = component?.[inventory.platformKey];
      const file = inventory.variant ? platform?.[inventory.variant] : platform;
      if (!/^(?:linux|windows)-(?:x86_64|aarch64|sbsa)$/.test(inventory.platformKey || "") ||
        record.platform !== (inventory.platformKey.startsWith("windows-") ? "win32" : "linux") ||
        record.arch !== (inventory.platformKey.endsWith("x86_64") ? "x64" : "arm64")) return undefined;
      if (!file || component.version !== record.version || file.sha256 !== inventory.sha256 ||
        file.relative_path !== inventory.relativePath || Number(file.size) !== inventory.size ||
        basename(inventory.relativePath) !== basename(path)) return undefined;
    } catch { return undefined; }
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0) return undefined;
  const listingKey = `verified-listing:${digestKey}`;
  if (!verified.has(listingKey)) {
    const zipped = path.endsWith(".zip");
    const result = spawnSync(zipped ? "/usr/bin/unzip" : "/usr/bin/tar", [zipped ? "-Z1" : "-tf", path], {
      cwd: tmpdir(), env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      encoding: "utf8", timeout: Math.min(30000, remaining), maxBuffer: 8 * 1024 * 1024, windowsHide: true,
    });
    verified.set(listingKey, result.status === 0 ? result.stdout.split(/\r?\n/).filter(Boolean) : undefined);
  }
  const files = verified.get(listingKey);
  if (!files || files.length !== inventory.files.length || files.some((value, i) => value !== inventory.files[i])) return undefined;
  const counts = new Map();
  for (const file of files) counts.set(file, (counts.get(file) || 0) + 1);
  if (record.files.some((file) => counts.get(file) !== 1 || !safeArchiveMember(file))) return undefined;
  return { path, sha256: inventory.sha256, inventoryPath: inventoryRecord.path, inventorySha256: inventoryRecord.sha256,
    ...(inventory.packageSha256 ? { packageSha256: inventory.packageSha256 } : {}) };
}

/** Explicit acquisition snapshots retain original immutable metadata/build files. */
export function nativeSnapshotProvider(text, directory, verified = new Map(), deadline = Date.now() + 60000) {
  let record;
  try { record = JSON.parse(text); } catch { return undefined; }
  if (!record || record.schema !== 1 || !validName(record.name) ||
    !["release", "source-revision"].includes(record.versionKind)) return undefined;
  if (record.versionKind === "release" ? !validVersion(record.version) : !/^[a-f0-9]{40,64}$/i.test(record.version || "")) return undefined;
  if (record.versionKind === "source-revision" && typeof record.repository !== "string") return undefined;
  if (record.repository) {
    try { const url = new URL(record.repository); if (url.protocol !== "https:" || url.username || url.password) return undefined; }
    catch { return undefined; }
  }
  if (!Array.isArray(record.evidence) || !record.evidence.length || record.evidence.length > 512) return undefined;
  const evidence = [];
  const materialRecords = [];
  for (const descriptor of record.evidence) {
    if (!descriptor || typeof descriptor.path !== "string" || !/^[a-f0-9]{64}$/i.test(descriptor.sha256 || "")) return undefined;
    const path = resolve(directory, descriptor.path);
    if (!inside(directory, path)) return undefined;
    const content = readRegularTextFile(path, 8 * 1024 * 1024, directory);
    if (content === undefined || nativeFactsHash(content) !== descriptor.sha256.toLowerCase()) return undefined;
    evidence.push({ path, sha256: nativeFactsHash(content) });
    materialRecords.push({ path, sha256: descriptor.sha256.toLowerCase(), content,
      ...(typeof descriptor.member === "string" ? { member: descriptor.member } : {}) });
  }
  const inventory = record.verifiedInventory ? nativeVerifiedCudaInventory(record, materialRecords, directory, verified, deadline) : undefined;
  if (record.verifiedInventory && !inventory) return undefined;
  const exports = nativePackageFileExports(record.files);
  for (const exp of (!inventory && Array.isArray(record.exports) ? record.exports : []).slice(0, 4096)) {
    const validExportName = exp?.kind === "header-file" ? typeof exp.name === "string" && /^[A-Za-z0-9_][A-Za-z0-9_./+-]*$/.test(exp.name) && !exp.name.split("/").includes("..") :
      exp?.kind === "tool" && exp.sourceDeclared === true ? validProgram(exp.name) : validName(exp?.name);
    if (exp && ["library", "cmake-package", "pkg-config", "meson-dependency", "capability", "framework", "header-file", "tool"].includes(exp.kind) && validExportName &&
      !exports.some((entry) => entry.kind === exp.kind && entry.name === exp.name)) exports.push({
        kind: exp.kind, name: exp.name,
        ...(validVersion(exp.interfaceVersion) ? { interfaceVersion: exp.interfaceVersion } : {}),
        ...(exp.interfaceVersionUnknown === true ? { interfaceVersionUnknown: true } : {}),
        // A static build/install declaration proves an available owner, not
        // the existence, executable mode or ABI of the configured output.
        ...(exp.sourceDeclared === true ? { sourceDeclared: true,
          ...(exp.kind === "tool" ? { executableUnknown: true } : { materialUnknown: true }) } : {}),
      });
  }
  // Apple SDK snapshots attest the actual stub, not a configured CMake
  // search or an API compatibility level. Keep its SDK-relative path and
  // linker version separate from the SDK release and actual installation.
  let sdk;
  if (record.versionSource === "tbd-current-version" && /^[A-Za-z][A-Za-z0-9_.-]+\.sdk$/.test(record.sdk?.directory || "") &&
    typeof record.installName === "string" && /^\/(?:System\/Library\/(?:Frameworks|PrivateFrameworks)\/|usr\/lib\/)[A-Za-z0-9_.+/-]+$/.test(record.installName) &&
    !record.installName.split("/").includes("..") && /^[a-f0-9]{40}$/.test(record.sdk.revision || "")) {
    const file = `${record.installName.replace(/\.dylib$/, "")}.tbd`;
    const member = materialRecords.find((entry) => entry.path.split(sep).join("/").endsWith(`/${record.sdk.directory}${file}`));
    if (member) {
      sdk = record.sdk;
      const framework = /^(\/System\/Library\/(?:Frameworks|PrivateFrameworks))\/([^/]+)\.framework\//.exec(file);
      const details = { file, sdkPath: file, installName: record.installName, material: "stub", interfaceVersionUnknown: true,
        provenance: { path: member.path, sha256: member.sha256 } };
      for (const entry of exports) if (entry.kind === "framework" || entry.kind === "library") Object.assign(entry, details);
      if (framework && exports.some((entry) => entry.kind === "framework" && entry.name === framework[2])) {
        exports.push({ kind: "library", name: framework[2], ...details, sdkSearchDirectory: framework[1] });
      }
    }
  }
  nativeSnapshotMaterials(exports, materialRecords, directory, verified, deadline);
  if (inventory) for (const entry of exports) entry.provenance ||= { ...inventory, member: entry.file };
  if (!exports.length) return undefined;
  return { kind: "provider-snapshot", name: record.name, packageName: record.name, version: record.version,
    versionKind: record.versionKind, ...(record.repository ? { repository: record.repository } : {}),
    platform: record.platform, arch: record.arch, exports, evidence,
    ...(sdk ? { sdk, installName: record.installName, versionSource: record.versionSource, targets: record.targets || [] } : {}),
    ...(inventory ? { verifiedInventory: inventory } : {}),
    ...(record.interfaceVersionUnknown === true ? { interfaceVersionUnknown: true } : {}),
    conditions: Array.isArray(record.conditions) ? record.conditions : [] };
}

/** A literal SDK-root-relative finder path must not be substituted with a
 * same-named framework from another SDK directory. The root itself remains
 * unselected and unknown. */
export function nativeSdkExportAccepts(entry, requirement) {
  if (!entry.sdkPath || requirement.command !== "find_library") return true;
  const roots = (requirement.arguments || []).flatMap((argument) =>
    typeof argument === "string" && /^\$\{CMAKE_OSX_SYSROOT\}\/[A-Za-z0-9_.+/-]+$/.test(argument) ?
      [argument.slice("${CMAKE_OSX_SYSROOT}".length).replace(/\/$/, "")] : []);
  return !roots.length || roots.includes(entry.sdkSearchDirectory || dirname(entry.sdkPath));
}

/** Reject only definite platform contradictions; retain unevaluated build conditions. */
export function nativeProviderPlatformAccepts(provider, requirement) {
  if (!provider.platform || provider.platform === "any") return true;
  for (const condition of requirement.conditions || []) {
    if (typeof condition !== "string") continue;
    const branch = /^(.*?)\/else(?:\(\))?$/.exec(condition.trim());
    const expression = (branch ? branch[1] : condition.trim()).replace(/^if\(CMAKE_SYSTEM_NAME STREQUAL (?:Windows|Darwin|Linux|Android|iOS|watchOS)\)\/elseif(?=\(CMAKE_SYSTEM_NAME STREQUAL )/, "if");
    const platformOption = /^if\s+(not\s+)?with_platform_(android|macos|windows)$/.exec(expression);
    if (platformOption) {
      const platform = platformOption[2] === "macos" ? "darwin" : platformOption[2] === "windows" ? "win32" : "android";
      if ((provider.platform === platform) === (!platformOption[1] !== Boolean(branch))) continue;
      return false;
    }
    const embedded = /^if\(\s*(NOT\s+)?APPLE_EMBEDDED(?:\s+STREQUAL\s+["']?(ios|watchos|tvos)["']?)?\s*\)$/.exec(expression);
    if (embedded) {
      const platform = provider.platform.replace(/-simulator$/, "");
      const applies = embedded[2] ? platform === embedded[2] : ["ios", "watchos", "tvos"].includes(platform);
      if (applies !== (!embedded[1] !== Boolean(branch))) return false;
      continue;
    }
    const match = /^if\s*\(?\s*(NOT\s+|not\s+)?(WIN32|WINDOWS|APPLE|ANDROID|UNIX|LINUX)\s*\)?(\/else\(\))?$/i.exec(condition.trim());
    if (match) {
      const token = match[2].toUpperCase();
      const applies = token === "WIN32" || token === "WINDOWS" ? provider.platform === "win32" : token === "APPLE" ? ["darwin", "ios", "watchos", "tvos", "ios-simulator", "watchos-simulator", "tvos-simulator"].includes(provider.platform) : token === "ANDROID" ? provider.platform === "android" : token === "LINUX" ? provider.platform === "linux" : !["win32"].includes(provider.platform);
      if ((match[1] ? !applies : applies) === !match[3]) continue;
      return false;
    }
    // Only a complete supported expression establishes a contradiction. A
    // comparison embedded in an OR/elif expression remains unknown.
    const cmake = /^if\s*\(?\s*(NOT\s+)?CMAKE_SYSTEM_NAME\s+STREQUAL\s+["']?(Windows|Darwin|Linux|Android|iOS|watchOS)["']?\s*\)?$/i.exec(expression);
    if (cmake) {
      const names = { windows: "win32", darwin: "darwin", linux: "linux", android: "android", ios: "ios", watchos: "watchos" };
      if ((provider.platform === names[cmake[2].toLowerCase()]) !== (!cmake[1] !== Boolean(branch))) return false;
      continue;
    }
    const meson = /^if\s+(not\s+)?(?:\(\s*)?(?:host_machine|target_machine)\.system\(\)\s*(==|!=)\s*['"](windows|darwin|linux|android)['"]\s*\)?$/.exec(expression);
    if (meson) {
      const expected = meson[3] === "windows" ? "win32" : meson[3];
      const positive = (meson[2] === "==") !== Boolean(meson[1]) !== Boolean(branch);
      if ((provider.platform === expected) !== positive) return false;
    }
  }
  return true;
}

function nativeProviderArchiveKeys(provider) {
  const keys = [];
  for (const descriptor of provider.evidence || []) {
    const content = readRegularTextFile(descriptor.path, 8 * 1024 * 1024);
    if (content === undefined || nativeFactsHash(content) !== descriptor.sha256) continue;
    let inventory;
    try { inventory = JSON.parse(content); } catch { continue; }
    if (typeof inventory?.artifact !== "string" || !/^[a-f0-9]{64}$/i.test(inventory.sha256 || "")) continue;
    const path = resolve(dirname(provider.metadataPath || descriptor.path), inventory.artifact);
    keys.push(JSON.stringify([provider.name, provider.version, provider.platform, provider.arch, path, inventory.sha256.toLowerCase()]));
  }
  return keys;
}

/** Recover cached sibling assets from authenticated release descriptors, never by a requested-name/version table. */
function nativeCachedSiblingProviders(snapshot, known, verified) {
  const result = [];
  for (const descriptor of snapshot.evidence || []) {
    const content = readRegularTextFile(descriptor.path, 8 * 1024 * 1024);
    if (content === undefined || nativeFactsHash(content) !== descriptor.sha256) continue;
    let release;
    try { release = JSON.parse(content); } catch { continue; }
    if (!release || typeof release !== "object" || Array.isArray(release)) continue;
    const directory = dirname(descriptor.path);
    for (const [name, entry] of Object.entries(release).slice(0, 4096)) {
      if (!validName(name) || !validVersion(entry?.version)) continue;
      for (const [platformKey, value] of Object.entries(entry)) {
        const platform = platformKey.startsWith("linux-") ? "linux" : platformKey.startsWith("windows-") ? "win32" : undefined;
        const arch = platformKey.endsWith("x86_64") ? "x64" : /(?:aarch64|sbsa)$/.test(platformKey) ? "arm64" : undefined;
        if (!platform || !arch || !value || typeof value !== "object") continue;
        const assets = value.relative_path ? [value] : Object.values(value);
        for (const asset of assets.slice(0, 16)) {
          if (typeof asset?.relative_path !== "string" || !safeArchiveMember(asset.relative_path) ||
            !/^[a-f0-9]{64}$/i.test(asset.sha256 || "")) continue;
          const inventoryPath = join(directory, `${basename(asset.relative_path)}.files.json`);
          const inventoryText = readRegularTextFile(inventoryPath, 8 * 1024 * 1024, directory);
          let inventory;
          try { inventory = JSON.parse(inventoryText); } catch { continue; }
          if (inventory?.sha256 !== asset.sha256 || Number(inventory.size) !== Number(asset.size)) continue;
          if (typeof inventory.artifact !== "string") continue;
          const key = JSON.stringify([name, entry.version, platform, arch, resolve(directory, inventory.artifact), asset.sha256.toLowerCase()]);
          if (known.has(key)) continue;
          const archive = nativeArchiveReader(inventory, directory, verified);
          const actual = archive?.files();
          if (!actual || actual.length !== inventory.files.length || actual.some((member, index) => member !== inventory.files[index])) continue;
          const record = { schema: 1, name, versionKind: "release", version: entry.version, platform, arch, files: actual,
            evidence: [{ path: basename(descriptor.path), sha256: descriptor.sha256 },
              { path: basename(inventoryPath), sha256: nativeFactsHash(inventoryText) }] };
          const provider = nativeSnapshotProvider(JSON.stringify(record), directory, verified);
          if (!provider) continue;
          result.push({ ...provider, metadataPath: inventoryPath, metadataSha256: nativeFactsHash(inventoryText),
            discoveryEvidence: { path: descriptor.path, sha256: descriptor.sha256, asset: asset.relative_path, artifactSha256: asset.sha256 } });
          known.add(key);
        }
      }
    }
  }
  return result;
}

/** Hash-verified, explicitly supplied metadata; no network and no mutable registry lookup. */
export function loadNativeExternalMetadata(options = {}) {
  const configured = options.nativeProviderMetadata ?? process.env.CDXGEN_NATIVE_PROVIDER_METADATA;
  const paths = Array.isArray(configured) ? configured : typeof configured === "string" ? configured.split(delimiter) : [];
  const providers = [];
  const replay = options[nativeProviderReplay];
  const archiveVerification = replay?.archiveVerification || new Map();
  for (const manifestPath of paths.slice(0, 32)) {
    if (typeof manifestPath !== "string" || !isAbsolute(manifestPath)) continue;
    const prepared = replay?.prepared.get(manifestPath);
    if (prepared) { providers.push(...prepared); continue; }
    const start = providers.length;
    const manifestText = readRegularTextFile(manifestPath, 8 * 1024 * 1024);
    if (!manifestText) continue;
    let manifest;
    try { manifest = JSON.parse(manifestText); } catch { continue; }
    if (!manifest || manifest.schema !== 1 || !Array.isArray(manifest.providers)) continue;
    const root = dirname(manifestPath);
    const manifestSha256 = nativeFactsHash(manifestText);
    const repositoryEvidence = new Map();
    const snapshots = [];
    for (const entry of manifest.providers.slice(0, 4096)) {
      if (replay?.verifying.has(manifestPath) && Date.now() >= replay.deadline) break;
      const metadata = entry?.metadata;
      if (!metadata || typeof metadata.path !== "string" || !/^[a-f0-9]{64}$/i.test(metadata.sha256 || "")) continue;
      const metadataPath = resolve(root, metadata.path);
      if (!inside(root, metadataPath)) continue;
      const text = readRegularTextFile(metadataPath, 8 * 1024 * 1024, root);
      if (text === undefined || nativeFactsHash(text) !== metadata.sha256.toLowerCase()) continue;
      let provider;
      if (metadata.format === "wrap") {
        provider = nativeWrapProvider(text, entry.name);
        if (provider && typeof entry.catalogPath === "string" && /^[a-f0-9]{64}$/i.test(entry.catalogSha256 || "")) {
          const catalogPath = resolve(root, entry.catalogPath);
          if (inside(root, catalogPath)) {
            const catalogText = readRegularTextFile(catalogPath, 4 * 1024 * 1024, root);
            if (catalogText !== undefined && nativeFactsHash(catalogText) === entry.catalogSha256.toLowerCase()) {
              try {
                const release = JSON.parse(catalogText)[provider.name];
                if (release?.versions?.includes(provider.recipeVersion) &&
                  provider.exports.some((exp) => release.dependency_names?.includes(exp.name))) {
                  provider = { ...provider, catalogVerified: true, catalogPath, catalogSha256: entry.catalogSha256 };
                }
              } catch { /* An invalid catalog cannot authorize a build-package alias. */ }
            }
          }
        }
      }
      else if (metadata.format === "provider-snapshot") provider = nativeSnapshotProvider(text, dirname(metadataPath), archiveVerification, replay?.deadline);
      else if (metadata.format === "pypi-wheel") {
        let record;
        try { record = JSON.parse(text); } catch { continue; }
        if (record?.schema !== 1 || !/^artifacts\/[a-f0-9]{64}\.whl$/.test(record.artifact || "") ||
          record.artifact !== `artifacts/${record.sha256}.whl` || !/^[a-f0-9]{64}$/.test(record.projectSha256 || "") ||
          !/^https:\/\/files\.pythonhosted\.org\/packages\/[A-Za-z0-9_./+-]+\.whl$/.test(record.url || "")) continue;
        const project = nativePythonDistributionName(record.name);
        if (!project || !/^(?:\d+!)?\d[0-9A-Za-z.+_~-]*$/.test(record.version || "")) continue;
        const projectUrl = `https://pypi.org/pypi/${encodeURIComponent(project)}`;
        const pinned = record.projectUrl === `${projectUrl}/${encodeURIComponent(record.version)}/json`;
        if (!pinned && record.projectUrl !== `${projectUrl}/json`) continue;
        const filename = record.url.split("/").at(-1);
        const platform = nativePythonWheelTarget(filename);
        if (!platform || platform.platform !== record.platform || platform.arch !== record.arch) continue;
        const projectPath = resolve(root, "projects", `${project}${pinned ? `@${record.version}` : ""}.json`);
        const projectKey = `${projectPath}:${record.projectSha256}`;
        if (!archiveVerification.has(projectKey)) {
          let authority;
          const bytes = readRegularTextFile(projectPath, 16 * 1024 * 1024, root);
          try { if (bytes && nativeFactsHash(bytes) === record.projectSha256) authority = JSON.parse(bytes); } catch {}
          archiveVerification.set(projectKey, authority);
        }
        const authority = archiveVerification.get(projectKey);
        if (nativePythonDistributionName(authority?.info?.name) !== project || authority?.info?.version !== record.version ||
          !Array.isArray(authority.urls) || !authority.urls.some((asset) => asset?.filename === filename && asset.url === record.url &&
            asset.packagetype === "bdist_wheel" && !asset.yanked && asset.digests?.sha256 === record.sha256)) continue;
        provider = nativePythonWheelProvider(resolve(root, record.artifact), root, record, archiveVerification, replay?.deadline);
        if (provider) provider.registry = { url: record.projectUrl, sha256: record.projectSha256 };
      } else if (metadata.format === "mlir-aie-wheel") {
        let record;
        try { record = JSON.parse(text); } catch { continue; }
        if (record?.schema !== 1 || !/^[a-f0-9]{64}$/.test(record.releaseSha256 || "")) continue;
        const identity = nativeMlirAieWheelIdentity(record.selector);
        if (!identity) continue;
        const releasePath = resolve(root, "releases", `${nativeFactsHash(record.selector)}.json`);
        const releaseText = readRegularTextFile(releasePath, 2 * 1024 * 1024, root);
        if (!releaseText || nativeFactsHash(releaseText) !== record.releaseSha256) continue;
        let release;
        try { release = JSON.parse(releaseText); } catch { continue; }
        const asset = nativeMlirAieWheelAsset(release, identity);
        if (!asset) continue;
        const wheel = resolve(root, "artifacts", `${asset.sha256}.whl`);
        const parsed = nativePythonWheelProvider(wheel, root, { ...identity, sha256: asset.sha256 }, archiveVerification, replay?.deadline, asset.size);
        if (parsed) provider = { ...parsed, kind: "github-wheel", repository: identity.repository,
          exports: parsed.exports.filter((entry) => entry.name === "aie-hsaco"),
          registry: { url: identity.releaseUrl, path: releasePath, sha256: record.releaseSha256 },
          conditions: [...parsed.conditions, `Exact wheel: ${identity.filename}`] };
      }
      else if (metadata.format === "vcpkg-json") {
        const verified = (descriptor) => {
          if (!descriptor || typeof descriptor.path !== "string" || !/^[a-f0-9]{64}$/i.test(descriptor.sha256 || "")) return undefined;
          const path = resolve(root, descriptor.path);
          if (!inside(root, path)) return undefined;
          const content = readRegularTextFile(path, 1024 * 1024, root);
          return content !== undefined && nativeFactsHash(content) === descriptor.sha256.toLowerCase() ? { path, content, sha256: descriptor.sha256 } : undefined;
        };
        const recipe = verified(entry.recipe); const usage = entry.usage && verified(entry.usage);
        if (!recipe || entry.usage && !usage || !/^[a-f0-9]{40,64}$/i.test(entry.registryRevision || "")) continue;
        const supplemental = (Array.isArray(entry.supplemental) ? entry.supplemental : []).slice(0, 256).map(verified);
        if (supplemental.some((file) => !file)) continue;
        provider = nativeVcpkgProvider(text, recipe.content, usage?.content, new Map(supplemental.map((file) => [file.path, file.content])), recipe.path,
          { metadataRoot: root, archiveVerification });
        if (provider) provider = { ...provider, recipePath: recipe.path, recipeSha256: recipe.sha256,
          ...(usage ? { usagePath: usage.path, usageSha256: usage.sha256 } : {}), registryRevision: entry.registryRevision,
          supplemental: supplemental.map(({ path, sha256 }) => ({ path, sha256 })) };
      }
      else if (metadata.format === "rpm-json") {
        let record;
        try { record = JSON.parse(text); } catch { continue; }
        if (!record || typeof record !== "object" || Array.isArray(record)) continue;
        if (!validName(record.name) || !validVersion(record.version) || !validVersion(record.release) || !Array.isArray(record.files)) continue;
        const epoch = record.epoch && String(record.epoch) !== "0" ? `${record.epoch}:` : "";
        if (epoch && !/^\d+:$/.test(epoch)) continue;
        provider = { kind: "package-manifest", packageManager: "rpm", packageName: record.name, name: record.name,
          version: `${epoch}${record.version}-${record.release}`, comparisonVersion: record.version,
          arch: record.arch, exports: nativePackageFileExports(record.files) };
      } else if (metadata.format === "dpkg-status") {
        const fields = new Map([...text.matchAll(/^([A-Za-z0-9-]+):[ \t]*(.*)$/gm)].map((m) => [m[1], m[2].trim()]));
        const packageName = fields.get("Package"); const version = fields.get("Version");
        if (!validName(packageName) || !validVersion(version) || !Array.isArray(entry.files)) continue;
        // The file list is separately authenticated, not caller-asserted exports.
        const fileEvidence = entry.files[0];
        if (!fileEvidence || typeof fileEvidence.path !== "string" || !/^[a-f0-9]{64}$/i.test(fileEvidence.sha256 || "")) continue;
        const filePath = resolve(root, fileEvidence.path);
        if (!inside(root, filePath)) continue;
        const filesText = readRegularTextFile(filePath, 8 * 1024 * 1024, root);
        if (filesText === undefined || nativeFactsHash(filesText) !== fileEvidence.sha256.toLowerCase()) continue;
        let repository;
        if (entry.repositoryEvidence) {
          if (replay?.debian.get(manifestPath) !== manifestSha256) continue;
          const descriptor = entry.repositoryEvidence;
          if (!/^[a-f0-9]{64}$/.test(descriptor.sha256 || "") || typeof descriptor.path !== "string") continue;
          const path = resolve(root, descriptor.path);
          if (!inside(root, path)) continue;
          const key = `${path}:${descriptor.sha256}`;
          if (!repositoryEvidence.has(key)) {
            let accepted;
            const bytes = readRegularTextFile(path, 16384, root);
            if (bytes !== undefined && nativeFactsHash(bytes) === descriptor.sha256) try {
              const evidence = JSON.parse(bytes);
              if (/^[a-f0-9]{64}$/.test(evidence.releaseSha256 || "")) accepted = { ...evidence, path, sha256: descriptor.sha256 };
            } catch { /* Invalid signed-index evidence is not an installed status record. */ }
            repositoryEvidence.set(key, accepted);
          }
          repository = repositoryEvidence.get(key);
          if (!repository) continue;
        }
        provider = { kind: "package-manifest", packageManager: "dpkg", name: packageName, packageName, version,
          comparisonVersion: version.replace(/^\d+:/, "").replace(/-[^-]*$/, ""), arch: repository ? entry.targetArch : fields.get("Architecture"),
          ...(repository ? { repositoryEvidence: repository, packageFilename: fields.get("Filename"), packageSha256: fields.get("SHA256") } : {}),
          exports: nativePackageFileExports(filesText.split(/\r?\n/)), fileListPath: filePath, fileListSha256: fileEvidence.sha256 };
      }
      if (!provider?.exports.length) continue;
      if (provider.kind === "provider-snapshot") snapshots.push(provider);
      const metadataSha256 = metadata.sha256.toLowerCase();
      const provenance = { path: provider.fileListPath || metadataPath, sha256: provider.fileListSha256 || metadataSha256,
        metadataPath, metadataSha256, manifestPath, manifestSha256 };
      providers.push({ ...provider, ...(entry.platform ? { platform: entry.platform } : {}),
        metadataPath, metadataSha256, manifestPath, manifestSha256: provenance.manifestSha256,
        exports: provider.exports.map((exp) => ({ ...exp,
          source: exp.source || `${provenance.path}${exp.file ? `#${exp.file}` : ""}`,
          provenance: { ...provenance, ...(exp.provenance || {}), ...(exp.file ? { member: exp.file } : {}) } })),
        ...(Array.isArray(entry.conditions) ? { conditions: entry.conditions } : {}) });
    }
    const accepted = providers.length - start;
    const known = new Set(providers.flatMap(nativeProviderArchiveKeys));
    for (const snapshot of snapshots) for (const provider of nativeCachedSiblingProviders(snapshot, known, archiveVerification)) {
      const provenance = { path: provider.metadataPath, sha256: provider.metadataSha256,
        metadataPath: provider.metadataPath, metadataSha256: provider.metadataSha256,
        manifestPath, manifestSha256, discoveryEvidence: provider.discoveryEvidence };
      providers.push({ ...provider, manifestPath, manifestSha256: provenance.manifestSha256,
        exports: provider.exports.map((entry) => ({ ...entry,
          source: entry.source || `${provider.metadataPath}${entry.file ? `#${entry.file}` : ""}`,
          provenance: { ...provenance, ...(entry.provenance || {}), ...(entry.file ? { member: entry.file } : {}) } })) });
    }
    if (replay) {
      replay.status.set(manifestPath, { accepted, expected: manifest.providers.length });
      replay.prepared.set(manifestPath, providers.slice(start));
    }
  }
  return providers;
}

/** Read-only runtime ownership, with the caller's bounded/credential-free runner. */
export function nativeInstalledLibraryObserver(root, executable, run) {
  let libraries;
  const owners = new Map();
  let compilerDirectories;
  const compilerSearch = () => {
    if (compilerDirectories) return compilerDirectories;
    compilerDirectories = [];
    const seen = new Set();
    for (const name of ["cc", "gcc", "clang", "c++", "g++", "clang++"]) {
      const path = executable(name);
      if (!path) continue;
      let real;
      try { real = realpathSync(path); } catch { continue; }
      if (seen.has(path) || inside(root, real)) continue;
      seen.add(path);
      const args = ["-print-search-dirs"];
      const output = run(path, args);
      const rows = typeof output === "string" ? [...output.matchAll(/^libraries:\s*=(.*)\r?$/gm)] : [];
      if (rows.length !== 1) continue;
      const observationSha256 = nativeFactsHash(JSON.stringify([path, real, args, output]));
      for (const directory of [...new Set(rows[0][1].trim().split(delimiter))].slice(0, 64)) {
        if (!isAbsolute(directory)) continue;
        try {
          const searchRoot = realpathSync(directory);
          if (inside(root, searchRoot) || !statSync(searchRoot).isDirectory()) continue;
          compilerDirectories.push({ path, realPath: real, args, output, searchRoot, observationSha256 });
        } catch { /* A search entry is not proof that a compiler runtime is installed. */ }
      }
    }
    return compilerDirectories;
  };
  const index = () => {
    if (libraries) return libraries;
    libraries = new Map();
    const add = (path) => {
      if (!isAbsolute(path)) return;
      try {
        const real = realpathSync(path);
        if (inside(root, real) || !statSync(real).isFile()) return;
        for (const exp of nativePackageFileExports([path]).filter((e) => ["library", "cmake-package"].includes(e.kind))) {
          const key = `${exp.kind}:${exp.name}`;
          const paths = libraries.get(key) || [];
          if (!paths.some((p) => p.real === real)) paths.push({ real, path });
          libraries.set(key, paths);
          if (exp.kind === "cmake-package" && basename(path).endsWith("-config.cmake")) libraries.set(`cmake-fold:${exp.name.toLowerCase()}`, paths);
        }
      } catch { /* Not an installed library. */ }
    };
    const cache = run(executable("ldconfig"), ["-p"]);
    for (const match of (cache || "").matchAll(/=>\s*(\/[^\r\n]+)$/gm)) add(match[1].trim());
    const dirs = new Set(["/lib", "/lib64", "/usr/lib", "/usr/lib64", "/usr/local/lib", ...[...libraries.values()].flat().map((p) => dirname(p.path))]);
    for (const dir of [...dirs].slice(0, 64)) {
      try {
        if (inside(root, realpathSync(dir))) continue;
        const entries = readdirSync(dir, { withFileTypes: true });
        if (entries.length > 20000) continue;
        for (const entry of entries) if ((entry.isFile() || entry.isSymbolicLink()) && /\.(?:a|so(?:\.\d+)*|dylib|lib)$/.test(entry.name)) add(join(dir, entry.name));
      } catch { /* A missing system directory is normal. */ }
    }
    const scanDeadline = Date.now() + 15000;
    let scannedDirectories = 0;
    const scanConfigs = (dir, depth = 0) => {
      if (depth > 2 || scannedDirectories++ >= 4096 || Date.now() >= scanDeadline) return;
      try {
        if (inside(root, realpathSync(dir))) return;
        const entries = readdirSync(dir, { withFileTypes: true });
        if (entries.length > 5000) return;
        for (const entry of entries) {
          if (entry.isDirectory()) scanConfigs(join(dir, entry.name), depth + 1);
          else if ((entry.isFile() || entry.isSymbolicLink()) && /(?:Config|-config)\.cmake$/.test(entry.name)) add(join(dir, entry.name));
        }
      } catch { /* The platform need not install CMake package metadata. */ }
    };
    for (const dir of [...dirs].slice(0, 64)) scanConfigs(join(dir, "cmake"));
    for (const share of ["/usr/share", "/usr/local/share"]) {
      try {
        const entries = readdirSync(share, { withFileTypes: true });
        for (const entry of entries.slice(0, 5000)) if (entry.isDirectory()) scanConfigs(join(share, entry.name, "cmake"));
      } catch { /* No shared package metadata. */ }
    }
    return libraries;
  };
  const own = ({ real, path }) => {
    if (owners.has(real)) return owners.get(real);
    const found = [];
    const rpm = executable("rpm");
    if (rpm) {
      const args = ["-qf", real, "--qf", "%{NAME}\t%{EPOCHNUM}\t%{VERSION}\t%{RELEASE}\t%{ARCH}\n"];
      const output = run(rpm, args);
      for (const line of (output || "").split("\n")) {
        const [name, epoch, version, release, arch] = line.split("\t");
        if (!validName(name) || !/^\d+$/.test(epoch || "") || !validVersion(version) || !validVersion(release)) continue;
        found.push({ kind: "installed-package-file", packageManager: "rpm", packageName: name, name,
          version: `${epoch !== "0" ? `${epoch}:` : ""}${version}-${release}`, comparisonVersion: version,
          arch, platform: process.platform, providedFilePath: real,
          ...(nativePackageFileExports([path]).some((e) => e.kind === "library") ? { libraryPath: real } : {}),
          queriedPath: path, path: rpm, args, output,
          metadataSha256: nativeFactsHash(output), exports: nativePackageFileExports([path]) });
      }
    }
    if (!found.length) {
      const dpkg = executable("dpkg-query");
      for (const candidate of [...new Set([path, real])]) {
        const ownershipArgs = ["-S", candidate];
        const ownership = run(dpkg, ownershipArgs);
        const packageNames = [];
        for (const line of (ownership || "").split("\n")) {
          const match = /^(.*): (\/.*)$/.exec(line);
          if (match && match[2] === candidate) for (const name of match[1].split(", ")) if (/^[A-Za-z0-9][A-Za-z0-9+.:_-]*$/.test(name)) packageNames.push(name);
        }
        for (const packageName of packageNames.slice(0, 8)) {
          const args = ["-W", "-f=${binary:Package}\t${Version}\t${Architecture}\t${Status}\n", packageName];
          const output = run(dpkg, args);
          const fields = output?.split("\t");
          if (!fields || fields.length !== 4 || fields[0] !== packageName || !validVersion(fields[1]) || fields[3] !== "install ok installed") continue;
          found.push({ kind: "installed-package-file", packageManager: "dpkg",
            packageName: fields[0].replace(/:[^:]+$/, ""), binaryPackageName: fields[0], name: fields[0].replace(/:[^:]+$/, ""),
            version: fields[1], comparisonVersion: fields[1].replace(/^\d+:/, "").replace(/-[^-]*$/, ""),
            arch: fields[2], platform: process.platform, providedFilePath: real,
            ...(nativePackageFileExports([path]).some((e) => e.kind === "library") ? { libraryPath: real } : {}),
            queriedPath: candidate, path: dpkg, args, output,
            ownershipArgs, ownershipOutput: ownership, metadataSha256: nativeFactsHash(`${ownership}\n${output}`), exports: nativePackageFileExports([path]) });
        }
        if (found.length) break;
      }
    }
    owners.set(real, found);
    for (const provider of found) {
      provider.exports = provider.exports.map((entry) => {
        const content = entry.kind === "header-file" ? readRegularTextFile(real, 2 * 1024 * 1024) : undefined;
        return { ...entry, ...(content === undefined ? {} : nativeMaterialFacts(content, path)), source: provider.queriedPath,
          provenance: { path: provider.providedFilePath, ownershipSha256: provider.metadataSha256,
            ...(content === undefined ? {} : { sha256: nativeFactsHash(content) }) } };
      });
      observedProviderEvidence.set(provider, JSON.stringify(provider));
    }
    return found;
  };
  const alias = (owner, entry) => {
    const content = entry.kind === "header-file" ? readRegularTextFile(owner.providedFilePath, 2 * 1024 * 1024) : undefined;
    const exported = { ...entry, source: entry.file, ...(content === undefined ? {} : nativeMaterialFacts(content, entry.file)),
      provenance: { path: owner.providedFilePath, ownershipSha256: owner.metadataSha256,
        ...(content === undefined ? {} : { sha256: nativeFactsHash(content) }) } };
    const provider = { ...owner, exports: [...owner.exports, exported] };
    observedProviderEvidence.set(provider, JSON.stringify(provider));
    return provider;
  };
  return (names, kind = "library", roots = []) => {
    const results = [];
    if (kind === "header-file") {
      const directories = [...roots, "/usr/include", "/usr/local/include"];
      for (const base of ["/usr/include", "/usr/local/include"]) {
        try {
          const entries = readdirSync(base, { withFileTypes: true });
          if (entries.length <= 20000) for (const entry of entries) {
            if (entry.isDirectory() && /^[A-Za-z0-9_-]+-linux-gnu$/.test(entry.name)) directories.push(join(base, entry.name));
          }
        } catch { /* Include layouts are platform-specific. */ }
      }
      for (const name of names.slice(0, 256)) {
        if (typeof name !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_./+-]*$/.test(name) || name.split("/").includes("..")) continue;
        for (const directory of [...new Set(directories)].slice(0, 64)) {
          if (!isAbsolute(directory)) continue;
          const path = join(directory, name);
          try {
            const real = realpathSync(path);
            if (!inside(root, real) && statSync(real).isFile()) for (const owner of own({ path, real })) {
              results.push(alias(owner, { kind: "header-file", name, file: path, headerPath: real, searchRoot: directory }));
            }
          } catch { /* A header not present at an observed search root stays unavailable. */ }
        }
      }
      return results;
    }
    if (kind === "tool") {
      for (const name of names) {
        const path = executable(name);
        if (!path) continue;
        try {
          for (const owner of own({ path, real: realpathSync(path) })) {
            results.push(alias(owner, { kind: "tool", name, file: path, observedLookup: name, interfaceVersionUnknown: true }));
          }
        } catch { /* Missing installed tool. */ }
      }
      return results;
    }
    for (const name of names) for (const file of [
      ...(index().get(`${kind}:${name}`) || []),
      ...(kind === "cmake-package" ? index().get(`cmake-fold:${name.toLowerCase()}`) || [] : []),
    ]) {
      for (const owner of own(file)) if (!results.some((p) => p.packageName === owner.packageName && p.version === owner.version && p.providedFilePath === owner.providedFilePath)) results.push(owner);
    }
    if (kind === "library") for (const name of names.slice(0, 256)) {
      if (!validName(name)) continue;
      const filenames = /\.(?:a|so(?:\.\d+)*|dylib|lib)$/.test(name) ? [name] :
        [`lib${name}.a`, `lib${name}.so`, `lib${name}.dylib`, `${name}.lib`];
      for (const compiler of compilerSearch()) for (const filename of filenames) {
        const path = join(compiler.searchRoot, filename);
        try {
          const real = realpathSync(path);
          if (inside(root, real) || !statSync(real).isFile()) continue;
          for (const owner of own({ path, real })) {
            const provider = { ...owner, exports: owner.exports.map((entry) => ({
              ...entry, compilerSearch: compiler, materialUnknown: true,
            })) };
            observedProviderEvidence.set(provider, JSON.stringify(provider));
            if (!results.some((candidate) => candidate.packageName === provider.packageName && candidate.version === provider.version &&
              candidate.providedFilePath === real && candidate.exports.some((entry) => entry.compilerSearch?.path === compiler.path))) results.push(provider);
          }
        } catch { /* Only the exact requested installed runtime material can supply an owner. */ }
      }
    }
    return results;
  };
}
