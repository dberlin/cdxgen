import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  hasUnboundMesonVersionInputs,
  parseMesonIntrospection,
} from "../parsers/mesonIntrospection.js";
import {
  NATIVE_FACTS_FORMAT,
  nativeFactsHash,
  nativeFileFingerprint,
  nativeSourceInputPaths,
} from "./nativeDependencyFacts.js";

const posix = (path) => path.split(sep).join("/");
const within = (root, file) => {
  const rel = relative(root, file);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
};
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 3600000,
    maxBuffer: 128 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0)
    throw new Error(
      `${command} configure/capture failed (${result.status}): ${result.error?.message || result.stderr || result.stdout}`,
    );
  return result.stdout;
};

// Every path component is opened relative to an already-open directory. The
// kernel rejects symlinks in the component being opened; no check/write race.
const openDirectoryNoFollow = (path, create = false) => {
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let fd = openSync("/", flags);
  try {
    for (const component of resolve(path).split(sep).filter(Boolean)) {
      const entry = `/proc/self/fd/${fd}/${component}`;
      if (create) {
        try { mkdirSync(entry, { mode: 0o700 }); }
        catch (error) { if (error.code !== "EEXIST") throw error; }
      }
      const next = openSync(entry, flags);
      closeSync(fd);
      fd = next;
    }
    return fd;
  } catch (error) { closeSync(fd); throw error; }
};
const ensureDirectoryNoFollow = (path) => {
  const fd = openDirectoryNoFollow(path, true);
  try { return realpathSync(`/proc/self/fd/${fd}`); }
  finally { closeSync(fd); }
};
const publishFacts = (context, content) => {
  const directory = context.outputDirectory;
  const name = basename(context.output);
  const temporary = `/proc/self/fd/${directory}/.cdxgen-facts-${randomUUID()}`;
  let fd;
  try {
    if (!name || name === "." || name === "..") throw new Error("Invalid facts filename");
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT |
      constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, content);
    fsyncSync(fd);
    // rename replaces a destination symlink itself, never its target. Both
    // entries are anchored in the same open directory, including inside builds.
    renameSync(temporary, `/proc/self/fd/${directory}/${name}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
};

const runIsolated = (context, command, args) => {
  // Configure executes project code. Enforce read-only sources and no network
  // rather than trusting build scripts or wrap-lock behavior to stay read-only.
  const temporary = join(context.captureRoot, "tmp");
  const packageCache = join(context.captureRoot, "packagecache");
  // These directories were created before project execution, beneath the
  // protected sibling evidence root. Never mkdir through child-controlled paths.
  // Bind root entries separately: recursive '/' remounting includes proc's
  // network-namespace mounts and fails on kernels with per-netns proc flags.
  const mounts = [];
  for (const entry of readdirSync("/", { withFileTypes: true })) {
    if (["dev", "proc", "sys"].includes(entry.name)) continue;
    const path = `/${entry.name}`;
    if (entry.isSymbolicLink())
      mounts.push("--symlink", readlinkSync(path), path);
    else mounts.push("--ro-bind", path, path);
  }
  return run("bwrap", [
    "--die-with-parent",
    "--unshare-net",
    "--unshare-pid",
    ...mounts,
    "--dev",
    "/dev",
    "--dir",
    "/proc",
    "--bind",
    context.buildRoot,
    context.buildRoot,
    "--ro-bind",
    context.captureRoot,
    context.captureRoot,
    ...context.writableEvidence.flatMap((file) => ["--bind", file, file]),
    "--bind",
    temporary,
    temporary,
    "--bind",
    packageCache,
    packageCache,
    "--ro-bind",
    context.sourceRoot,
    context.sourceRoot,
    "--chdir",
    context.buildRoot,
    "--setenv",
    "TMPDIR",
    temporary,
    "--setenv",
    "MESON_PACKAGE_CACHE_DIR",
    packageCache,
    "--",
    command,
    ...args,
  ]);
};
const prepare = ({ sourceRoot, buildRoot, output }, tool) => {
  sourceRoot = realpathSync(sourceRoot);
  buildRoot = resolve(buildRoot);
  output = resolve(output);
  if (within(sourceRoot, buildRoot) || within(sourceRoot, output))
    throw new Error("Capture outputs must be outside the source root");
  // A new configure directory prevents accidental mutation of the user's build.
  if (existsSync(buildRoot) && readdirSync(buildRoot).length)
    throw new Error(
      "Capture requires an empty, source-external build directory",
    );
  buildRoot = ensureDirectoryNoFollow(buildRoot);
  if (within(sourceRoot, realpathSync(buildRoot)))
    throw new Error("Capture build resolves inside source root");
  ensureDirectoryNoFollow(dirname(output));
  if (within(sourceRoot, realpathSync(dirname(output))))
    throw new Error("Capture output resolves inside source root");
  if (existsSync(output) && within(sourceRoot, realpathSync(output)))
    throw new Error("Capture output resolves inside source root");
  const parent = openDirectoryNoFollow(dirname(buildRoot));
  let captureRoot;
  try {
    captureRoot = realpathSync(mkdtempSync(`/proc/self/fd/${parent}/.cdxgen-native-`));
  } finally { closeSync(parent); }
  mkdirSync(join(captureRoot, "tmp"), { mode: 0o700 });
  mkdirSync(join(captureRoot, "packagecache"), { mode: 0o700 });
  const initialInputs = nativeSourceInputPaths(sourceRoot, tool).map(
    nativeFileFingerprint,
  );
  // Anchor publication before configure can rename a build-owned ancestor.
  const outputDirectory = openDirectoryNoFollow(dirname(output));
  return {
    sourceRoot,
    buildRoot: realpathSync(buildRoot),
    output,
    outputDirectory,
    captureRoot,
    initialInputs,
    writableEvidence: [],
    rawEvidence: {},
  };
};
const fingerprints = (files) =>
  [...new Set(files.filter(Boolean).map((file) => resolve(file)))]
    .sort()
    .map(nativeFileFingerprint);
const finish = (context, configuration, records, inputs, evidence) => {
  if (
    JSON.stringify(
      nativeSourceInputPaths(context.sourceRoot, configuration.tool),
    ) !== JSON.stringify(context.initialInputs.map((f) => f.path))
  )
    throw new Error(
      "Configure changed source input inventory; refusing capture",
    );
  for (const initial of context.initialInputs) {
    if (nativeFileFingerprint(initial.path).sha256 !== initial.sha256)
      throw new Error("Configure changed source inputs; refusing capture");
  }
  const observations = join(context.captureRoot, "observations.json");
  writeFileSync(observations, JSON.stringify(records, null, 2));
  configuration.id = nativeFactsHash(JSON.stringify(configuration));
  const facts = {
    format: NATIVE_FACTS_FORMAT,
    configuration,
    sourceInputs: context.initialInputs.map((f) => f.path),
    providerTrees: context.providerTrees || [],
    inputs: fingerprints([
      ...context.initialInputs.map((f) => f.path),
      ...(context.providerTrees || []).flatMap((tree) => tree.files),
      ...inputs,
    ]),
    evidence: fingerprints([...evidence, observations]),
    capture: {
      kind: `${configuration.tool}-configure-observations-v1`,
      path: observations,
      ...context.rawEvidence,
    },
    records,
  };
  publishFacts(context, `${JSON.stringify(facts, null, 2)}\n`);
  return facts;
};

/**
 * Explicit, source-read-only, network-isolated configure operation. Requires
 * bubblewrap and an installed CMake; the normal facts consumer never calls it.
 * @param {{sourceRoot:string,buildRoot:string,output:string,
 * configureArgs?:string[],command?:string}} options
 * @returns {import("./nativeDependencyFacts.js").NativeDependencyFacts}
 */
export function captureCmakeDependencyFacts(options) {
  const context = prepare(options, "cmake");
  try {
  const { sourceRoot, buildRoot, captureRoot } = context;
  const hook = join(captureRoot, "capture.cmake");
  const rawOutput = join(captureRoot, "find-package.jsonl");
  const traceFile = join(captureRoot, "trace.jsonl");
  context.writableEvidence = [rawOutput, traceFile, join(captureRoot, "uninstrumented-trace.jsonl")];
  for (const file of context.writableEvidence) writeFileSync(file, "", { flag: "wx" });
  context.rawEvidence = { traceFile, rawOutput };
  copyFileSync(
    fileURLToPath(new URL("./nativeDependencyCapture.cmake", import.meta.url)),
    hook,
  );
  if (
    (options.configureArgs || []).some((arg) =>
      /CDX_NATIVE_CAPTURE_OUTPUT|^--trace|^-S$|^-B$/.test(arg),
    )
  )
    throw new Error("Configure arguments conflict with capture isolation");
  const baselineFile = join(captureRoot, "uninstrumented-trace.jsonl");
  const baseArgs = [
    "-S",
    sourceRoot,
    "-B",
    buildRoot,
    ...(options.configureArgs || []),
  ];
  const baselineLog = runIsolated(context, options.command || "cmake", [
    ...baseArgs,
    "--trace-expand",
    "--trace-format=json-v1",
    `--trace-redirect=${baselineFile}`,
  ]);
  const parseTrace = (file) =>
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const baseline = parseTrace(baselineFile);
  // Preserve the effective native value after presets, -C and typed -D values
  // have been processed. The observer must run after every real initializer.
  const initializerEntry = readFileSync(
    join(buildRoot, "CMakeCache.txt"),
    "utf8",
  )
    .split(/\r?\n/)
    .find((line) => line.startsWith("CMAKE_PROJECT_TOP_LEVEL_INCLUDES:"));
  const effectiveInitializers = initializerEntry
    ? initializerEntry.slice(initializerEntry.indexOf("=") + 1)
    : "";
  const observerIncludes = effectiveInitializers
    ? `${effectiveInitializers};${hook}`
    : hook;
  const hasCustomDiscovery = baseline.some(
    (event) =>
      ["macro", "function"].includes(event.cmd) &&
      event.args?.[0]?.toLowerCase() === "find_package",
  );
  let trace;
  if (hasCustomDiscovery) {
    // Do not inject an overload into projects that already overload discovery:
    // CMake's underscore alias is not stackable, and changing it is unsound.
    copyFileSync(baselineFile, traceFile);
    trace = baseline;
    writeFileSync(join(captureRoot, "configure.log"), baselineLog);
  } else {
    const stdout = runIsolated(context, options.command || "cmake", [
      ...baseArgs,
      `-DCMAKE_PROJECT_TOP_LEVEL_INCLUDES=${observerIncludes}`,
      `-DCDX_NATIVE_CAPTURE_OUTPUT=${rawOutput}`,
      "--trace-expand",
      "--trace-format=json-v1",
      `--trace-redirect=${traceFile}`,
    ]);
    writeFileSync(join(captureRoot, "configure.log"), stdout);
    trace = parseTrace(traceFile);
  }
  writeFileSync(join(captureRoot, "uninstrumented-configure.log"), baselineLog);
  const pending = [];
  const observations = [];
  let customDiscovery = hasCustomDiscovery;
  for (const event of trace) {
    if (
      ["macro", "function"].includes(event.cmd) &&
      event.args?.[0]?.toLowerCase() === "find_package" &&
      event.file !== hook
    )
      customDiscovery = true;
    if (
      event.cmd === "find_package" &&
      event.file &&
      within(sourceRoot, resolve(event.file))
    )
      pending.push(event);
    if (event.cmd === "execute_process")
      for (const call of pending) call.unsupportedVersionInput = true;
    if (
      event.cmd === "file" &&
      event.args?.[0] === "APPEND" &&
      event.args[1] === rawOutput
    ) {
      const raw = JSON.parse(event.args[2]);
      const index = pending.findLastIndex(
        (call) =>
          call.args[0] === raw.name &&
          resolve(call.file) === resolve(raw.consumer),
      );
      if (index < 0) continue;
      const [call] = pending.splice(index, 1);
      const nativeArgs = raw.arguments.split(";");
      // Expanded arguments must still agree with the actual invocation. Lists
      // that cannot be forwarded losslessly by the macro remain unsupported.
      const argumentSafe =
        !call.unsupportedVersionInput &&
        JSON.stringify(call.args) === JSON.stringify(nativeArgs);
      const config =
        raw.config && existsSync(raw.config)
          ? realpathSync(raw.config)
          : undefined;
      const found = ["1", "ON", "YES", "TRUE", "Y"].includes(
        raw.found.toUpperCase(),
      );
      observations.push({
        consumer: {
          file: posix(relative(sourceRoot, call.file)),
          line: call.line,
          command: "find_package",
        },
        request: {
          name: raw.name,
          constraints: /^\d/.test(call.args[1] || "")
            ? `${call.args[1]}${call.args.includes("EXACT") ? " EXACT" : ""}`
            : "",
          arguments: call.args,
        },
        applicability:
          !argumentSafe || (found && !config)
            ? "unknown"
            : found
              ? "selected"
              : "not-found",
        provider: {
          name: raw.name,
          ...(config ? { config, source: dirname(config) } : {}),
          configuration: buildRoot,
          artifacts: [],
        },
        ...(found && config && raw.version && !raw.version.includes("${")
          ? { observedVersion: { value: raw.version, kind: "release" } }
          : {}),
        evidence: config
          ? [config, traceFile, rawOutput]
          : [traceFile, rawOutput],
      });
    }
  }
  if (hasCustomDiscovery) {
    for (const call of baseline.filter(
      (event) =>
        event.cmd === "find_package" &&
        event.file &&
        within(sourceRoot, resolve(event.file)),
    )) {
      observations.push({
        consumer: {
          file: posix(relative(sourceRoot, call.file)),
          line: call.line,
          command: "find_package",
        },
        request: {
          name: call.args[0],
          constraints: /^\d/.test(call.args[1] || "")
            ? `${call.args[1]}${call.args.includes("EXACT") ? " EXACT" : ""}`
            : "",
          arguments: call.args,
        },
        applicability: "unknown",
        provider: {
          name: call.args[0],
          configuration: buildRoot,
          artifacts: [],
        },
        evidence: [baselineFile],
      });
    }
  }
  let providerSelectionUnchanged = !customDiscovery;
  for (const record of observations.filter(
    (row) => row.applicability === "selected",
  )) {
    const matchingCalls = baseline.flatMap((call, index) =>
      call.cmd === "find_package" &&
      call.file &&
      posix(relative(sourceRoot, call.file)) === record.consumer.file &&
      call.line === record.consumer.line &&
      JSON.stringify(call.args) === JSON.stringify(record.request.arguments)
        ? [index]
        : [],
    );
    const selectedBefore = matchingCalls.some((index) => {
      const call = baseline[index];
      for (let next = index + 1; next < baseline.length; next++) {
        const event = baseline[next];
        if (event.frame <= call.frame) break;
        if (event.file && resolve(event.file) === record.provider.config)
          return true;
      }
      return false;
    });
    if (!selectedBefore) {
      providerSelectionUnchanged = false;
      record.applicability = "unknown";
      delete record.observedVersion;
    }
  }
  if (!existsSync(rawOutput)) writeFileSync(rawOutput, "");
  if (customDiscovery)
    for (const record of observations) {
      record.applicability = "unknown";
      delete record.observedVersion;
    }
  const cacheFile = join(buildRoot, "CMakeCache.txt");
  const cache = Object.fromEntries(
    readFileSync(cacheFile, "utf8")
      .split(/\r?\n/)
      .flatMap((line) => {
        const match = /^([^#/:][^:]*):[^=]+=(.*)$/.exec(line);
        return match ? [[match[1], match[2]]] : [];
      }),
  );
  const targetProfile = Object.fromEntries(
    [
      "CMAKE_BUILD_TYPE",
      "CMAKE_CONFIGURATION_TYPES",
      "CMAKE_SYSTEM_NAME",
      "CMAKE_SYSTEM_PROCESSOR",
      "CMAKE_SYSROOT",
      "CMAKE_TOOLCHAIN_FILE",
      "CMAKE_C_COMPILER",
      "CMAKE_CXX_COMPILER",
      "CMAKE_C_COMPILER_TARGET",
      "CMAKE_CXX_COMPILER_TARGET",
      "CMAKE_FIND_ROOT_PATH",
    ].map((key) => [key, cache[key] || ""]),
  );
  const loadedScripts = [...baseline, ...trace].flatMap((event) =>
    event.file && existsSync(event.file) && statSync(event.file).isFile()
      ? [event.file]
      : [],
  );
  const readInputs = [];
  let unresolvedRead = false;
  for (const event of [...baseline, ...trace]) {
    const input =
      event.cmd === "file" &&
      ["READ", "STRINGS", "SHA256", "SHA512", "MD5"].includes(event.args?.[0])
        ? event.args[1]
        : event.cmd === "configure_file"
          ? event.args?.[0]
          : undefined;
    if (!input) continue;
    // Expanded traces do not expose the native current-source/current-binary
    // directory for arbitrary scripts/functions. Never guess relative inputs
    // from the script directory or a top-level decoy.
    if (!isAbsolute(input) || !existsSync(input) || !statSync(input).isFile()) {
      unresolvedRead = true;
      continue;
    }
    readInputs.push(input);
  }
  if (unresolvedRead)
    for (const record of observations) {
      record.applicability = "unknown";
      delete record.observedVersion;
    }
  return finish(
    context,
    {
      tool: "cmake",
      sourceRoot,
      buildRoot,
      cacheFile,
      targetProfile,
      providerSelectionUnchanged,
      configureArguments: options.configureArgs || [],
    },
    observations,
    [cacheFile, ...loadedScripts, ...readInputs],
    [
      hook,
      rawOutput,
      traceFile,
      baselineFile,
      join(captureRoot, "configure.log"),
      join(captureRoot, "uninstrumented-configure.log"),
    ],
  );
  } finally {
    closeSync(context.outputDirectory);
  }
}

/**
 * Configure source-read-only, offline Meson projects and retain introspection.
 * @param {{sourceRoot:string,buildRoot:string,output:string,
 * configureArgs?:string[],command?:string}} options
 * @returns {import("./nativeDependencyFacts.js").NativeDependencyFacts}
 */
export function captureMesonDependencyFacts(options) {
  const context = prepare(options, "meson");
  try {
  const { sourceRoot, buildRoot, captureRoot } = context;
  if (
    (options.configureArgs || []).some((arg) => arg.startsWith("--wrap-mode"))
  )
    throw new Error("Meson capture requires --wrap-mode=nodownload");
  runIsolated(context, options.command || "meson", [
    "setup",
    buildRoot,
    sourceRoot,
    "--wrap-mode=nodownload",
    "--backend=none",
    ...(options.configureArgs || []),
  ]);
  const infoRoot = join(buildRoot, "meson-info");
  const readInfo = (name) =>
    JSON.parse(readFileSync(join(infoRoot, `intro-${name}.json`), "utf8"));
  const astFiles = [];
  const astPaths = {};
  const astEvidence = [];
  for (const input of context.initialInputs) {
    if (!input.path.endsWith("meson.build")) continue;
    const ast = runIsolated(context, options.command || "meson", [
      "introspect",
      "--ast",
      input.path,
    ]);
    const astPath = join(
      captureRoot,
      `ast-${nativeFactsHash(input.path).slice(0, 16)}.json`,
    );
    writeFileSync(astPath, ast);
    astPaths[posix(relative(sourceRoot, input.path))] = astPath;
    astEvidence.push(astPath);
    astFiles.push([posix(relative(sourceRoot, input.path)), JSON.parse(ast)]);
  }
  const logFile = join(buildRoot, "meson-logs", "meson-log.txt");
  const infoFiles = [
    "dependencies",
    "projectinfo",
    "buildoptions",
    "machines",
    "buildsystem_files",
  ].map((name) => join(infoRoot, `intro-${name}.json`));
  const parsed = parseMesonIntrospection({
    project: readInfo("projectinfo"),
    dependencies: readInfo("dependencies"),
    options: readInfo("buildoptions"),
    machines: readInfo("machines"),
    astFiles,
    log: readFileSync(logFile, "utf8"),
    sourceRoot,
    buildRoot,
  });
  context.providerTrees = [
    ...new Set(
      parsed.records
        .filter(
          (record) =>
            record.applicability === "selected" && record.provider.source,
        )
        .map((record) => record.provider.source),
    ),
  ].map((root) => ({ root, files: nativeSourceInputPaths(root, "all") }));
  for (const record of parsed.records) {
    const provider = context.providerTrees.find(
      (tree) => tree.root === record.provider.source,
    );
    if (
      provider &&
      hasUnboundMesonVersionInputs(astFiles, sourceRoot, provider)
    ) {
      record.applicability = "unknown";
      delete record.observedVersion;
    }
    record.evidence = [logFile, ...infoFiles];
    if (record.provider.source)
      record.evidence.push(join(record.provider.source, "meson.build"));
  }
  const cacheFile = join(buildRoot, "meson-private", "coredata.dat");
  context.rawEvidence = { astFiles: astPaths };
  return finish(
    context,
    {
      tool: "meson",
      sourceRoot,
      buildRoot,
      cacheFile,
      targetProfile: parsed.targetProfile,
      configureArguments: options.configureArgs || [],
    },
    parsed.records,
    [cacheFile, ...readInfo("buildsystem_files")],
    [logFile, ...infoFiles, join(infoRoot, "meson-info.json"), ...astEvidence],
  );
  } finally {
    closeSync(context.outputDirectory);
  }
}
