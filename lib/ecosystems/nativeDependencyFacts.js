import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { applyPurl, tryBuildPurl } from "../inventory/purl.js";
import {
  hasUnboundMesonVersionInputs,
  parseMesonIntrospection,
} from "../parsers/mesonIntrospection.js";

/**
 * @typedef {{path:string, realPath:string, sha256:string}} NativeFileFingerprint
 * @typedef {{tool:"cmake"|"meson", sourceRoot:string, buildRoot:string,
 * cacheFile:string, targetProfile:object, configureArguments:string[],
 * providerSelectionUnchanged?:boolean, id:string}} NativeDependencyConfiguration
 * @typedef {{consumer:{file:string,line:number,command:string},
 * request:{name:string,constraints:string,arguments:string[]},
 * applicability:"selected"|"not-found"|"disabled"|"unknown",
 * provider:{name:string,configuration:string,config?:string,source?:string,
 * type?:string,artifacts:string[]},
 * observedVersion?:{value:string,kind:"release"|"source-revision"|"archive-revision"},
 * evidence:string[]}} NativeDependencyRecord
 * @typedef {{format:"native-dependency-resolution-v1",
 * configuration:NativeDependencyConfiguration, sourceInputs:string[],
 * providerTrees:{root:string,files:string[]}[], inputs:NativeFileFingerprint[],
 * evidence:NativeFileFingerprint[], capture:{kind:string,path:string,
 * traceFile?:string,rawOutput?:string,astFiles?:Record<string,string>},
 * records:NativeDependencyRecord[]}} NativeDependencyFacts
 */

export const NATIVE_FACTS_FORMAT = "native-dependency-resolution-v1";
export const nativeFactsHash = (value) =>
  createHash("sha256").update(value).digest("hex");
export const nativeFileFingerprint = (path) => ({
  path: resolve(path),
  realPath: realpathSync(path),
  sha256: nativeFactsHash(readFileSync(path)),
});
const stable = (value) => JSON.stringify(value);
const samePath = (a, b) => realpathSync(a) === realpathSync(b);
const within = (root, file) => {
  const rel = relative(root, file);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
};

/** Build-language input inventory, including dormant declarations. */
export function nativeSourceInputPaths(sourceRoot, tool) {
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (
        [".git", "node_modules", ".venv"].includes(entry.name) ||
        entry.isSymbolicLink()
      )
        continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (
        entry.isFile() &&
        (tool === "all" ||
          (tool === "cmake"
            ? entry.name === "CMakeLists.txt" ||
              entry.name.endsWith(".cmake") ||
              entry.name === "CMakePresets.json"
            : ["meson.build", "meson.options", "meson_options.txt"].includes(
                entry.name,
              ) || entry.name.endsWith(".wrap")))
      )
        files.push(path);
    }
  };
  visit(sourceRoot);
  return files.sort();
}

// Normalized records are not an override table: selected values must agree
// with the hashed native tool output, even if somebody rehashes observations.
function selectedFactsMatchRawCapture(facts, fingerprints) {
  const selected = facts.records.filter(
    (row) => row.applicability === "selected",
  );
  if (!selected.length) return true;
  const readEvidence = (path) => {
    if (!fingerprints.has(realpathSync(path)))
      throw new Error("unbound-raw-evidence");
    return readFileSync(path, "utf8");
  };
  const { sourceRoot, buildRoot, tool } = facts.configuration;
  if (tool === "cmake") {
    if (!facts.configuration.providerSelectionUnchanged) return false;
    const { rawOutput, traceFile } = facts.capture;
    readEvidence(rawOutput);
    const trace = readEvidence(traceFile)
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const pending = [];
    const observations = [];
    for (const event of trace) {
      if (
        event.cmd === "find_package" &&
        event.file &&
        within(sourceRoot, resolve(event.file))
      )
        pending.push(event);
      if (event.cmd === "execute_process")
        for (const call of pending) call.unsupported = true;
      if (
        event.cmd !== "file" ||
        event.args?.[0] !== "APPEND" ||
        event.args[1] !== rawOutput
      )
        continue;
      const raw = JSON.parse(event.args[2]);
      const index = pending.findLastIndex(
        (call) =>
          call.args[0] === raw.name &&
          resolve(call.file) === resolve(raw.consumer),
      );
      if (index < 0) continue;
      const [call] = pending.splice(index, 1);
      observations.push({ raw, call });
    }
    return selected.every((row) =>
      observations.some(
        ({ raw, call }) =>
          !call.unsupported &&
          relative(sourceRoot, call.file).split(sep).join("/") ===
            row.consumer.file &&
          call.line === row.consumer.line &&
          row.consumer.command === "find_package" &&
          raw.name === row.request.name &&
          stable(call.args) === stable(row.request.arguments) &&
          stable(call.args) === stable(raw.arguments.split(";")) &&
          row.request.constraints ===
            (/^\d/.test(call.args[1] || "")
              ? `${call.args[1]}${call.args.includes("EXACT") ? " EXACT" : ""}`
              : "") &&
          ["1", "ON", "YES", "TRUE", "Y"].includes(raw.found.toUpperCase()) &&
          stable(row.provider) ===
            stable({
              name: raw.name,
              config: realpathSync(raw.config),
              source: dirname(realpathSync(raw.config)),
              configuration: buildRoot,
              artifacts: [],
            }) &&
          (!row.observedVersion ||
            (row.observedVersion.kind === "release" &&
              row.observedVersion.value === raw.version)),
      ),
    );
  }
  const info = (name) =>
    JSON.parse(
      readEvidence(join(buildRoot, "meson-info", `intro-${name}.json`)),
    );
  const astFiles = facts.sourceInputs
    .filter((file) => file.endsWith("meson.build"))
    .map((file) => [
      relative(sourceRoot, file).split(sep).join("/"),
      JSON.parse(
        readEvidence(
          facts.capture.astFiles[relative(sourceRoot, file).split(sep).join("/")],
        ),
      ),
    ]);
  const parsed = parseMesonIntrospection({
    project: info("projectinfo"),
    dependencies: info("dependencies"),
    options: info("buildoptions"),
    machines: info("machines"),
    astFiles,
    log: readEvidence(join(buildRoot, "meson-logs", "meson-log.txt")),
    sourceRoot,
    buildRoot,
  });
  const core = ({ evidence: _evidence, ...row }) => stable(row);
  return selected.every((row) => {
    const provider = facts.providerTrees?.find(
      (tree) => tree.root === row.provider.source,
    );
    return (
      provider &&
      !hasUnboundMesonVersionInputs(astFiles, sourceRoot, provider) &&
      parsed.records.some(
        (raw) => raw.applicability === "selected" && core(raw) === core(row),
      )
    );
  });
}

/**
 * Read only: importing facts never configures, downloads, installs or probes.
 * @param {string} path
 * @param {string} sourceRoot
 * @param {{cmakeCache?:string,nativeDependencyTargetProfile?:object}} [options]
 * @returns {(NativeDependencyFacts & {valid:true,diagnostics:string[]}) |
 * {valid:false,records:[],diagnostics:string[]}}
 */
export function readNativeDependencyFacts(path, sourceRoot, options = {}) {
  const invalid = (reason) => ({
    valid: false,
    records: [],
    diagnostics: [reason],
  });
  try {
    const facts = JSON.parse(readFileSync(path, "utf8"));
    if (
      facts.format !== NATIVE_FACTS_FORMAT ||
      !["cmake", "meson"].includes(facts.configuration?.tool)
    )
      return invalid("unsupported-facts-format");
    const config = facts.configuration;
    if (!samePath(sourceRoot, config.sourceRoot))
      return invalid("foreign-source-root");
    if (!config.buildRoot || within(config.sourceRoot, config.buildRoot))
      return invalid("in-source-build-evidence");
    if (config.id !== nativeFactsHash(stable({ ...config, id: undefined })))
      return invalid("configuration-identity-mismatch");
    if (
      options.cmakeCache &&
      (config.tool !== "cmake" ||
        !samePath(options.cmakeCache, config.cacheFile))
    )
      return invalid("foreign-configuration");
    if (
      options.nativeDependencyTargetProfile &&
      stable(options.nativeDependencyTargetProfile) !==
        stable(config.targetProfile)
    )
      return invalid("foreign-target-profile");
    if (
      !Array.isArray(facts.inputs) ||
      !facts.inputs.length ||
      !Array.isArray(facts.evidence) ||
      !facts.evidence.length
    )
      return invalid("missing-fingerprints");
    if (
      stable(facts.sourceInputs) !==
      stable(nativeSourceInputPaths(config.sourceRoot, config.tool))
    )
      return invalid("changed-source-input-inventory");
    for (const tree of facts.providerTrees || []) {
      if (
        !within(config.sourceRoot, realpathSync(tree.root)) ||
        stable(tree.files) !== stable(nativeSourceInputPaths(tree.root, "all"))
      )
        return invalid("changed-provider-source-inventory");
    }
    const fingerprints = new Map();
    for (const fingerprint of [...facts.inputs, ...facts.evidence]) {
      if (
        !fingerprint.path ||
        !fingerprint.realPath ||
        realpathSync(fingerprint.path) !== fingerprint.realPath ||
        !/^[a-f0-9]{64}$/.test(fingerprint.sha256) ||
        !statSync(fingerprint.path).isFile() ||
        nativeFactsHash(readFileSync(fingerprint.path)) !== fingerprint.sha256
      )
        return invalid("stale-input-or-evidence");
      fingerprints.set(realpathSync(fingerprint.path), fingerprint.sha256);
    }
    if (!fingerprints.has(realpathSync(config.cacheFile)))
      return invalid("unbound-configuration");
    const capture = facts.capture;
    if (
      !capture ||
      capture.kind !== `${config.tool}-configure-observations-v1` ||
      !fingerprints.has(realpathSync(capture.path))
    )
      return invalid("missing-machine-observations");
    const observations = JSON.parse(readFileSync(capture.path, "utf8"));
    if (stable(observations) !== stable(facts.records))
      return invalid("records-differ-from-capture");
    for (const row of facts.records) {
      if (
        !row.consumer ||
        !Number.isInteger(row.consumer.line) ||
        row.consumer.line < 1 ||
        !row.request?.name ||
        !Array.isArray(row.request.arguments) ||
        typeof row.request.constraints !== "string"
      )
        return invalid("invalid-callsite");
      const consumer = resolve(config.sourceRoot, row.consumer.file);
      if (
        !within(config.sourceRoot, consumer) ||
        !fingerprints.has(realpathSync(consumer))
      )
        return invalid("unbound-consumer");
      if (
        !["selected", "not-found", "disabled", "unknown"].includes(
          row.applicability,
        )
      )
        return invalid("invalid-applicability");
      if (
        row.observedVersion &&
        (!row.observedVersion.value ||
          !["release", "source-revision", "archive-revision"].includes(
            row.observedVersion.kind,
          ) ||
          row.observedVersion.value.includes("${"))
      )
        return invalid("invalid-observed-version");
      if (
        row.observedVersion?.kind.endsWith("revision") &&
        !/^[a-f0-9]{7,64}$/i.test(row.observedVersion.value)
      )
        return invalid("mutable-selector-not-version");
      if (
        row.applicability === "selected" &&
        (!row.provider?.name ||
          !row.evidence?.length ||
          row.evidence.some((file) => !fingerprints.has(realpathSync(file))))
      )
        return invalid("unbound-provider");
    }
    if (!selectedFactsMatchRawCapture(facts, fingerprints))
      return invalid("records-differ-from-native-tool-output");
    return { ...facts, valid: true, diagnostics: [] };
  } catch {
    return invalid("unreadable-or-invalid-facts");
  }
}

function constraintParts(value) {
  const constraint = value.trim();
  if (!constraint.startsWith("[")) return [constraint];
  if (!constraint.endsWith("]")) return undefined;
  const tokens = constraint
    .slice(1, -1)
    .split(",")
    .map((token) => token.trim());
  const parts = [];
  for (const token of tokens) {
    const quote = token[0];
    if (
      !["'", '"'].includes(quote) ||
      token.at(-1) !== quote ||
      token.length < 2
    )
      return undefined;
    const part = token.slice(1, -1);
    if (part.includes(quote) || part.includes("\\")) return undefined;
    parts.push(part.trim());
  }
  return parts.length ? parts : undefined;
}
const constraintKey = (value) => {
  const parts = constraintParts(value);
  return parts
    ? stable(parts.map((part) => part.replace(/\s+/g, "")).sort())
    : undefined;
};

function versionSatisfies(observed, constraint, command) {
  if (
    !observed ||
    !["release", "source-revision", "archive-revision"].includes(observed.kind)
  )
    return false;
  if (observed.kind !== "release")
    return !constraint && /^[a-f0-9]{7,64}$/i.test(observed.value);
  if (!constraint) return true;
  if (constraint.startsWith("[")) {
    const parts = constraintParts(constraint);
    return (
      !!parts &&
      parts.every((part) => versionSatisfies(observed, part, command))
    );
  }
  const compare = (requested) => {
    if (
      !/^\d+(?:\.\d+)*$/.test(requested) ||
      !/^\d+(?:\.\d+)*$/.test(observed.value)
    )
      return undefined;
    const left = observed.value.split(".").map(Number);
    const right = requested.split(".").map(Number);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      if ((left[i] || 0) !== (right[i] || 0))
        return (left[i] || 0) > (right[i] || 0) ? 1 : -1;
    }
    return 0;
  };
  const range = /^(\d+(?:\.\d+)*)\.\.\.(<)?(\d+(?:\.\d+)*)$/.exec(constraint);
  if (range) {
    const lower = compare(range[1]);
    const upper = compare(range[3]);
    return (
      lower !== undefined &&
      upper !== undefined &&
      lower >= 0 &&
      (range[2] ? upper < 0 : upper <= 0)
    );
  }
  const match = /^(>=|<=|==|!=|>|<|=)?\s*(\d+(?:\.\d+)*)( EXACT)?$/.exec(
    constraint,
  );
  if (!match) return false;
  const result = compare(match[2]);
  if (result === undefined) return false;
  const operator = match[3]
    ? "=="
    : match[1] || (command === "dependency" ? "==" : ">=");
  return operator === ">="
    ? result >= 0
    : operator === "<="
      ? result <= 0
      : operator === ">"
        ? result > 0
        : operator === "<"
          ? result < 0
          : operator === "!="
            ? result !== 0
            : result === 0;
}

/**
 * Exact executed callsites only; a cache-wide package name is never a key.
 * @param {ReturnType<typeof readNativeDependencyFacts>} facts
 * @param {{requestedName:string,file:string,line:number,command:string,role:string,
 * constraints?:string}} requirement
 * @returns {NativeDependencyRecord|undefined}
 */
export function resolveNativeRequirement(facts, requirement) {
  if (!facts?.valid || !requirement || requirement.role !== "software")
    return undefined;
  const constraints = constraintKey(requirement.constraints || "");
  if (constraints === undefined) return undefined;
  // CMake traces carry the expanded ordered argv. Two calls through a macro
  // can share name, source line and version but search different CONFIG names,
  // paths or component sets. Never project one observation onto the other.
  const argumentsMatch = (row) => requirement.command !== "find_package" || !requirement.arguments ||
    Array.isArray(row.request.arguments) && row.request.arguments.length === requirement.arguments.length &&
    row.request.arguments.every((arg, index) => arg === requirement.arguments[index]);
  const matches = facts.records.filter(
    (row) =>
      row.consumer.file === requirement.file &&
      row.consumer.line === requirement.line &&
      row.consumer.command === requirement.command &&
      row.request.name === requirement.requestedName &&
      constraintKey(row.request.constraints) === constraints &&
      argumentsMatch(row),
  );
  if (
    !matches.length ||
    matches.some(
      (row) =>
        row.applicability !== "selected" ||
        !versionSatisfies(
          row.observedVersion,
          requirement.constraints || "",
          requirement.command,
        ),
    )
  )
    return undefined;
  const identities = new Set(
    matches.map((row) => stable([row.provider, row.observedVersion])),
  );
  return identities.size === 1 ? matches[0] : undefined;
}

/**
 * Mutate only unambiguous requirement components and rewrite every graph edge.
 * @param {object[]} components
 * @param {{ref:string,dependsOn?:string[],provides?:string[]}[]} dependencies
 * @param {ReturnType<typeof readNativeDependencyFacts>} facts
 * @returns {number} Number of unambiguously selected requirement components
 */
export function applyNativeDependencyFacts(components, dependencies, facts) {
  if (!facts?.valid) return 0;
  const replacements = new Map();
  const refCounts = new Map();
  for (const component of components) {
    const ref = component["bom-ref"];
    refCounts.set(ref, (refCounts.get(ref) || 0) + 1);
  }
  let count = 0;
  for (const component of components) {
    if (refCounts.get(component["bom-ref"]) !== 1) continue;
    const requirements = (component.properties || [])
      .filter((p) => p.name === "cdx:build:requirement")
      .flatMap((p) => {
        try {
          return [JSON.parse(p.value)];
        } catch {
          return [];
        }
      });
    if (!requirements.length || requirements.some((r) => r.role !== "software"))
      continue;
    const records = requirements.map((r) => resolveNativeRequirement(facts, r));
    if (records.some((r) => !r)) continue;
    if (
      new Set(records.map((r) => stable([r.provider, r.observedVersion])))
        .size !== 1
    )
      continue;
    const record = records[0];
    const oldRef = component["bom-ref"];
    const version = record.observedVersion.value;
    const providerIdentity = nativeFactsHash(stable(record.provider));
    const purl = tryBuildPurl({
      type: "generic",
      namespace: component.group || null,
      name: component.name,
      version,
    });
    if (!purl) continue;
    component.version = version;
    applyPurl(component, purl);
    const providerInstance = nativeFactsHash(
      stable([facts.configuration.id, providerIdentity]),
    );
    component["bom-ref"] =
      `${component["bom-ref"]}#native-provider-${providerInstance}`;
    component.properties = (component.properties || []).filter(
      (p) => p.name !== "cdx:version:kind",
    );
    component.properties.push(
      { name: "cdx:version:kind", value: record.observedVersion.kind },
      { name: "cdx:native:configuration", value: facts.configuration.id },
      { name: "cdx:native:provider", value: record.provider.name },
    );
    component.properties.push(
      { name: "cdx:native:resolvedVia", value: NATIVE_FACTS_FORMAT },
      { name: "cdx:native:providerInstance", value: providerInstance },
      { name: "cdx:native:providerIdentity", value: providerIdentity },
    );
    for (const property of component.properties.filter(
      (p) => p.name === "cdx:build:requirement",
    )) {
      const requirement = JSON.parse(property.value);
      requirement.providerCandidates = [
        ...(requirement.providerCandidates || []).map((candidate) => ({
          ...candidate,
          selected: false,
        })),
        {
          kind: "configured-provider",
          name: record.provider.name,
          ref: component["bom-ref"],
          configuration: facts.configuration.id,
          selected: true,
        },
      ];
      property.value = JSON.stringify(requirement);
    }
    if (oldRef) replacements.set(oldRef, component["bom-ref"]);
    count++;
  }
  for (const edge of dependencies || []) {
    edge.ref = replacements.get(edge.ref) || edge.ref;
    if (edge.dependsOn)
      edge.dependsOn = [
        ...new Set(edge.dependsOn.map((ref) => replacements.get(ref) || ref)),
      ];
    if (edge.provides)
      edge.provides = [
        ...new Set(edge.provides.map((ref) => replacements.get(ref) || ref)),
      ];
  }
  return count;
}
