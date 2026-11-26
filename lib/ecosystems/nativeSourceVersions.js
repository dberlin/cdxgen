import { createHash } from "node:crypto";
import { closeSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { openRegularFile, readRegularTextFile } from "../core/boundedFile.js";
import { applyPurl, parsePurlLoose, tryBuildPurl } from "../inventory/purl.js";
import { nativeSourceIdentity, nativeSourceRepository } from "../inventory/nativeSourceIdentity.js";
import { sourceRevisionOf, sourceRootOf } from "../inventory/sourceRevision.js";
import { expandCmakeVariables, parseCmakeCommands } from "../parsers/cmakeLists.js";
import { nativeProviderReplay } from "./nativeExternalMetadata.js";
import { collectNativeProviders, resolveNativeRequirements } from "./nativeProviderIndex.js";
import { nativeLanguageSourceFacts } from "./nativeRegistryMetadata.js";

const MAX_VERSION_BYTES = 256 * 1024;
const MAX_HEADER_BYTES = 2 * 1024 * 1024;
const literalVersion = (value) => typeof value === "string" && /^\d+(?:\.\d+)*(?:[A-Za-z][0-9A-Za-z.+_~-]*|[-+_~][0-9A-Za-z.+_~-]+)?$/.test(value.trim());
const CMAKE_FETCH_NAMES = new Set(["fetchcontent_declare", "fetchcontent_makeavailable", "externalproject_add", "cpmaddpackage", "cpmfindpackage", "cpmdeclarepackage", "therock_subproject_fetch"]);
const CMAKE_REQUIREMENT_NAMES = new Set(["find_package", "find_dependency", "find_library", "find_program", "find_path", "find_file", "pkg_check_modules", "pkg_search_module"]);
const CMAKE_CONTEXT_NAMES = new Set(["therock_cmake_subproject_declare", "therock_cmake_subproject_provide_package"]);
const CMAKE_OBSERVATION_NAMES = new Set([...CMAKE_FETCH_NAMES, ...CMAKE_REQUIREMENT_NAMES, ...CMAKE_CONTEXT_NAMES]);
const CMAKE_EVALUATED_NAMES = new Set(["project", "get_version", "get_version_from_tag", "rocm_setup_version", "set_property", "set_target_properties", "file", "cmake_language", "unset", "cmake_parse_arguments", "set", "include", "add_subdirectory", "list", "string"]);
const scopedProgramSearch = (args) => args?.includes("HINTS") || args?.includes("PATHS") && args.includes("${CMAKE_MODULE_PATH}");

// A scoped path replay may refine search roots, not the requested executable
// or discovery options. A changed symbolic or external hint is not evidence.
function scopedProgramPathRefinement(before, after, sourceRoot) {
  if (before.length === after.length && before.every((arg, index) => arg === after[index])) return false;
  const fields = (args) => {
    const fixed = [args[0]];
    const roots = [];
    let search;
    for (const arg of args.slice(1)) {
      if (arg === "HINTS" || arg === "PATHS") {
        search = [];
        roots.push(search);
        fixed.push(arg);
      } else if (!search || /^(?:NAMES|NAME|PATH_SUFFIXES|DOC|ENV|REQUIRED|OPTIONAL|NO_\w+|NAMES_PER_DIR|VALIDATOR|REGISTRY_VIEW|ONLY_CMAKE_FIND_ROOT_PATH|CMAKE_FIND_ROOT_PATH_BOTH)$/.test(arg)) {
        search = undefined;
        fixed.push(arg);
      } else search.push(arg);
    }
    return { fixed, roots };
  };
  const old = fields(before);
  const replay = fields(after);
  if (old.fixed.length !== replay.fixed.length || old.fixed.some((arg, index) => arg !== replay.fixed[index])) return false;
  let refined = false;
  for (let index = 0; index < old.roots.length; index++) {
    const original = old.roots[index];
    const evaluated = replay.roots[index];
    if (original.length === evaluated.length && original.every((arg, at) => arg === evaluated[at])) continue;
    const added = evaluated.filter((arg) => !original.includes(arg));
    if (!added.length) return false;
    for (const arg of added) {
      if (!isAbsolute(arg) || /[$;\0[\]]/.test(arg)) return false;
      const rel = relative(resolve(sourceRoot), arg);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
    }
    refined = true;
  }
  return refined;
}

function cmakeHelperArgument(parameters, values, key) {
  if (key === "ARGN") return values.slice(parameters.length).join(";");
  if (key === "ARGC") return String(values.length);
  const positional = key.match(/^ARGV(0|[1-9]\d*)$/);
  if (positional && Number(positional[1]) < values.length) return values[Number(positional[1])];
  const parameter = parameters.lastIndexOf(key);
  return parameter >= 0 ? values[parameter] || "" : undefined;
}

function cmakeHelperInput(called, values, variables, dir, key) {
  return key === "CMAKE_CURRENT_SOURCE_DIR" ? dir : cmakeHelperArgument(called.parameters, values, key) ?? variables.get(key);
}

function cmakeHelperInputPresent(called, values, variables, key) {
  return key === "CMAKE_CURRENT_SOURCE_DIR" || cmakeHelperArgument(called.parameters, values, key) !== undefined || variables.has(key);
}
function cmakeHelperDefinitionsMatch(snapshot, definitions) {
  if (snapshot.size !== definitions.size) return false;
  for (const [name, definition] of snapshot) if (definitions.get(name) !== definition) return false;
  return true;
}

function cmakeHelperIsLocal(definition, definitions, seen = new Set()) {
  if (seen.has(definition)) return true;
  seen.add(definition);
  for (const command of definition.body) {
    if (["function", "macro", "endfunction", "endmacro", "cmake_language"].includes(command.name)) return false;
    if (command.name.endsWith("_setup_version") && command.name !== "rocm_setup_version") return false;
    if (command.name === "file" && (command.args[0]?.includes("$") ||
      ["READ", "STRINGS"].includes(command.args[0]?.toUpperCase()))) return false;
    const called = definitions.get(command.name);
    if (called && !cmakeHelperIsLocal(called, definitions, seen)) return false;
  }
  return true;
}

function cmakeHelperIsData(definition, definitions, seen = new Set()) {
  if (seen.has(definition)) return false;
  seen.add(definition);
  for (const command of definition.body) {
    if (["set", "unset", "string", "list", "if", "elseif", "else", "endif", "message", "block", "endblock"].includes(command.name)) continue;
    if (command.name === "file" && ["READ", "STRINGS"].includes(command.args[0]?.toUpperCase())) continue;
    const called = definitions.get(command.name);
    if (!called || !cmakeHelperIsData(called, definitions, new Set(seen))) return false;
  }
  return true;
}

// Facts about the exact source owner. Configured overrides and dependency
// provider selection are separate from an authoritative source release.
export function nativeOwnedSourceVersionCandidates(name, directory, sourceRoot = directory) {
  const ownerSourceDir = relative(resolve(sourceRoot), resolve(directory)).split("\\").join("/") || ".";
  const candidates = [];
  const versionFile = join(directory, "VERSION");
  const versionText = readRegularTextFile(versionFile, 8 * 1024, sourceRoot);
  if (versionText !== undefined) {
    const lines = versionText.split(/\r?\n/);
    const values = lines.map((text, index) => ({ text: text.trim(), line: index + 1 })).filter(({ text }) => text && !text.startsWith("#"));
    if (values.length === 1 && literalVersion(values[0].text)) {
      candidates.push({ name, version: values[0].text, kind: "owned-version-file",
        source: `${versionFile}:${values[0].line}`, ownerSourceDir, conditions: [], default: true });
    } else {
      const fields = new Map();
      let prefix;
      let valid = true;
      for (let index = 0; index < lines.length; index++) {
        const text = lines[index].trim();
        if (!text) continue;
        const field = text.match(/^(?:#\s*)?((?:[A-Za-z_][A-Za-z0-9_]*_)?VERSION_)?(MAJOR|MINOR|PATCH)\s*(?:[:=]\s*(\d+))?$/i);
        if (!field) { if (!text.startsWith("#")) valid = false; continue; }
        if (text.startsWith("#") && field[3] !== undefined) continue;
        const owner = (field[1] || "").toUpperCase();
        if (prefix !== undefined && prefix !== owner) valid = false;
        prefix = owner;
        const value = field[3] ?? lines[++index]?.trim();
        if (!/^\d+$/.test(value || "") || fields.has(field[2].toUpperCase())) valid = false;
        fields.set(field[2].toUpperCase(), { value, line: index + 1 });
      }
      if (valid && fields.size === 3) {
        const sourceLines = ["MAJOR", "MINOR", "PATCH"].map((key) => fields.get(key).line);
        const prefixName = prefix?.replace(/_?VERSION_$/, "");
        candidates.push({ name: name || prefixName || undefined, version: ["MAJOR", "MINOR", "PATCH"].map((key) => fields.get(key).value).join("."),
          kind: "owned-version-file", source: `${versionFile}:${sourceLines[0]}`, sourceLines, ownerSourceDir, conditions: [], default: true });
      }
    }
  }
  for (const relativeFile of ["configure.ac", "configure.in", "src/configure.ac", "src/configure.in"]) {
    const file = join(directory, relativeFile);
    const text = readRegularTextFile(file, MAX_VERSION_BYTES, sourceRoot);
    if (text === undefined) continue;
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index].trim();
      if (!line || line.startsWith("#") || /^dnl(?:\s|$)/i.test(line) || /^AC_PREREQ\(\s*\[?[\d.]+\]?\s*\)$/.test(line)) continue;
      // Only a literal top-level initializer after comments/AC_PREREQ is
      // supported. Macro bodies, shell substitutions and M4 evaluation are not.
      const init = line.match(/^AC_INIT\(\s*(\[[^\[\]\r\n]*\]|[A-Za-z0-9_.+-]+)\s*,\s*(\[[^\[\]\r\n]*\]|[0-9A-Za-z_.+~-]+)(?:\s*,\s*(?:\[[^\[\]\r\n]*\]|[^(),\r\n]+)){0,3}\s*\)$/);
      const unquote = (value) => value?.replace(/^\[|\]$/g, "").trim();
      const ownedName = unquote(init?.[1]);
      const version = unquote(init?.[2]);
      if (ownedName && !/[${}()]/.test(ownedName) && literalVersion(version)) candidates.push({
        name: ownedName, version, kind: "owned-autoconf-init", source: `${file}:${index + 1}`, ownerSourceDir, conditions: [], default: true,
      });
      break;
    }
  }
  return candidates;
}

// Recognize data-only #define captures; project regexes are never compiled.
function numericHeaderCaptures(pattern, text) {
  const normalized = pattern.replaceAll("[ ]+", " ").replaceAll("[ ]*", "");
  const scalar = normalized.match(/^#define ([A-Za-z_][A-Za-z0-9_]*) \(\[0-9\]\+\)$/);
  const macro = normalized.match(/^#define ([A-Za-z_][A-Za-z0-9_]*) ([A-Za-z_][A-Za-z0-9_]*)\\\((.*)\\\)$/);
  if (!scalar && !macro) return undefined;
  const tokens = macro?.[3].split(",").map((token) => token.trim());
  if (tokens && (tokens.length > 8 || tokens.some((token) =>
    !["[0-9]+", "([0-9]+)"].includes(token) && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(token)))) return undefined;
  const fields = text.split(/\r?\n/).map((line) => line.match(scalar ?
    /^\s*#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)\s+(\d+)\s*(?:\/\/.*)?$/ :
    /^\s*#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)\(\s*([A-Za-z0-9_, \t]+)\s*\)\s*(?:\/\/.*)?$/))
    .filter((field) => field?.[1] === (scalar || macro)[1]);
  if (fields.length !== 1) return { matched: false, captures: [] };
  if (scalar) return { matched: true, captures: [fields[0][2]] };
  const values = fields[0][3].split(",").map((value) => value.trim());
  if (fields[0][2] !== macro[2] || values.length !== tokens.length) return { matched: false, captures: [] };
  const captures = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "[0-9]+" || token === "([0-9]+)") {
      if (!/^\d+$/.test(values[index])) return { matched: false, captures: [] };
      if (token === "([0-9]+)") captures.push(values[index]);
    } else if (token !== values[index]) return { matched: false, captures: [] };
  }
  return { matched: true, captures };
}

function cmakeParentWritesEqual(first, second) {
  if (first === second) return true;
  if ((first?.size || 0) !== (second?.size || 0)) return false;
  for (const [key, value] of first || []) if (!second?.has(key) || second.get(key) !== value) return false;
  return true;
}

function cmakeHelperOutput(called, state, key, caller) {
  return called.macro ? state.localWrites?.has(key) ? state.variables.get(key) : caller.get(key) :
    state.parentWrites?.has(key) ? state.parentWrites.get(key) : caller.get(key);
}

/**
 * Evaluate only bounded, local version declarations, in source order. Values
 * are snapshots, never deferred aliases: unknown inputs cannot be resurrected
 * by a later assignment, file read, include or second expansion pass.
 */
export function cmakeProjectDetails(file, commands, sourceRoot = dirname(resolve(file)), declarationContext) {
  return evaluateCmakeProjectDetails(file, commands, sourceRoot, declarationContext);
}

// Owner queries need context observations, but not fetch/requirement inventories.
// The mode changes record retention only: statement execution, dependencies,
// continuations and budgets remain identical to the public evaluator.
function evaluateCmakeProjectDetails(file, commands, sourceRoot, declarationContext, ownerQuery = false) {
  const declarationsOnly = Boolean(declarationContext?.declarationsOnly);
  const dir = declarationContext?.sourceDir || dirname(resolve(file));
  const authenticatedFiles = declarationContext?.authenticatedFiles || declarationContext?.budget?.authenticatedFiles;
  const readSource = (path, limit) => {
    if (!authenticatedFiles) return readRegularTextFile(path, limit, sourceRoot);
    const text = authenticatedFiles.get(resolve(path));
    return typeof text === "string" && Buffer.byteLength(text) <= limit ? text : undefined;
  };
  let inheritedVariables = declarationContext?.variables;
  let inheritedDefinitions = declarationContext?.definitions;
  let inheritedConditions = declarationContext?.conditions || [];
  let inheritedVersionFiles = [];
  const parentContextMemo = declarationContext?.parentContextMemo || (!declarationsOnly ? new Map() : undefined);
  if (!declarationsOnly && !inheritedVariables && basename(file) === "CMakeLists.txt" && (declarationContext?.parentDepth || 0) < 8) {
    const parentFile = join(dirname(dir), "CMakeLists.txt");
    const inside = relative(resolve(sourceRoot), parentFile);
    if (inside && !inside.startsWith("..")) {
      if (!parentContextMemo.has(parentFile)) {
        const text = readSource(parentFile, MAX_VERSION_BYTES);
        parentContextMemo.set(parentFile, { commands: text === undefined ? [] : parseCmakeCommands(text), prefixes: new Map() });
      }
      const parentScope = parentContextMemo.get(parentFile);
      if (parentScope.commands.length) {
        const parentCommands = parentScope.commands;
        let nesting = 0;
        const guards = [];
        for (const [index, command] of parentCommands.entries()) {
          if (["foreach", "while", "function", "macro", "block"].includes(command.name)) nesting++;
          if (["endforeach", "endwhile", "endfunction", "endmacro", "endblock"].includes(command.name)) nesting--;
          if (command.name === "if") guards.push(`if(${command.args.join(" ")})`);
          if (["else", "elseif"].includes(command.name) && guards.length) guards[guards.length - 1] += `/${command.name}(${command.args.join(" ")})`;
          if (command.name === "endif") guards.pop();
          if (!nesting && command.name === "add_subdirectory" && command.args[0] && !command.args[0].includes("$") && resolve(dirname(parentFile), command.args[0]) === dir) {
            if (!parentScope.prefixes.has(index)) parentScope.prefixes.set(index, evaluateCmakeProjectDetails(parentFile, parentCommands.slice(0, index), sourceRoot, {
              parentDepth: (declarationContext?.parentDepth || 0) + 1, variablesOnly: true, authenticatedFiles, parentContextMemo,
            }, ownerQuery));
            const parent = parentScope.prefixes.get(index);
            if (!parent.activeBranches || parent.activeBranches.some((branch) => branch.state === false)) continue;
            inheritedVariables = parent.variables;
            inheritedDefinitions = parent.definitions;
            inheritedConditions = [...inheritedConditions, ...guards];
            inheritedVersionFiles = [parentFile, ...parent.versionFiles];
            break;
          }
        }
      }
    }
  }
  const initialVariables = new Map(inheritedVariables || []);
  // Bind arguments in the callee's owned snapshot, not in another full copy of
  // the caller's variables that this snapshot would immediately copy again.
  if (declarationContext?.helperArguments) {
    const { parameters, values } = declarationContext.helperArguments;
    for (let index = 0; index < parameters.length; index++) initialVariables.set(parameters[index], values[index] || "");
    initialVariables.set("ARGN", values.slice(parameters.length).join(";"));
    initialVariables.set("ARGC", String(values.length));
    values.forEach((value, index) => initialVariables.set(`ARGV${index}`, value));
  }
  initialVariables.set("CMAKE_CURRENT_SOURCE_DIR", dir);
  const variables = declarationsOnly ? initialVariables : new Map(initialVariables);
  if (declarationContext?.summaryReads) {
    const reads = declarationContext.summaryReads;
    const writes = new Set();
    // Only a cache miss observes reads of the callee's initial snapshot. Local
    // assignments are not dependencies on the caller's previous values.
    Object.defineProperties(variables, {
      get: { value: (key) => {
        if (!writes.has(key)) { reads.add(key); inheritedVariables?.get(key); }
        return Map.prototype.get.call(variables, key);
      } },
      has: { value: (key) => {
        if (!writes.has(key)) { reads.add(key); inheritedVariables?.has(key); }
        return Map.prototype.has.call(variables, key);
      } },
      set: { value: (key, value) => { writes.add(key); return Map.prototype.set.call(variables, key, value); } },
    });
  }
  const sourceBudget = declarationContext?.budget || { paths: 0, commands: 0, includes: 0, activeIncludes: new Set(), depth: 0 };
  const scopedProgramPaths = Boolean(sourceBudget.scopedProgramPaths);
  if (authenticatedFiles) sourceBudget.authenticatedFiles = authenticatedFiles;
  // Cache syntax, never evaluated state: recursive helpers reuse command
  // objects, but their variables, definitions, guards and budgets still differ.
  const commandSyntax = sourceBudget.commandSyntax ||= new WeakMap();
  const neededClosures = sourceBudget.neededClosures ||= new WeakMap();
  const immutableNeeded = sourceBudget.immutableNeeded ||= new WeakSet();
  const helperSummaries = sourceBudget.helperSummaries ||= new WeakMap();
  const summaryPool = sourceBudget.summaryPool ||= { entries: 0, facts: 0 };
  // Fetch records are immutable during evaluation and reused by continuations.
  // Cache their exact structural keys across the shared evaluation budgets.
  const fetchCommandKeys = declarationsOnly ? (sourceBudget.fetchCommandKeys ||= new WeakMap()) : undefined;
  const sourceConditions = inheritedConditions;
  const versionFiles = [...inheritedVersionFiles];
  const fetchCommands = [];
  const appendObservations = (records) => {
    if (!ownerQuery) fetchCommands.push(...records);
    else for (const record of records) if (CMAKE_CONTEXT_NAMES.has(record.name)) fetchCommands.push(record);
  };
  const versionCandidates = [];
  const terminalStates = [];
  let parentWrites = declarationContext?.parentWrites ? new Map(declarationContext.parentWrites) : undefined;
  const localWrites = declarationContext?.trackLocalWrites || declarationContext?.localWrites ? new Set(declarationContext.localWrites) : undefined;
  let declaredProjectName = declarationContext?.projectName;
  // Completed helper summaries are immutable. Borrow their table until a local
  // definition/redefinition needs an owned copy.
  let definitionsOwned = !declarationsOnly || !(inheritedDefinitions instanceof Map);
  let definitions = definitionsOwned ? new Map(inheritedDefinitions) : inheritedDefinitions;
  const pendingDefinitions = [];
  const activeIncludes = new Set();
  let includeCount = 0;
  const commandCount = declarationContext?.blockCommandCost || { value: 0 };
  let exhausted = false;
  let project;
  let finalBranches;
  const conservativeBranches = [];
  let explicitProjectVersion = false;
  const unknown = (key) => `$<unknown:${key}>`;
  const fetchNames = CMAKE_OBSERVATION_NAMES;
  const metadataArguments = ({ name, args }) => {
    if (name === "project") {
      const at = args.findIndex((arg) => arg.toUpperCase() === "VERSION");
      return [args[0], ...(at >= 0 ? [args[at + 1]] : []),
        ...(args[0] && !args[0].includes("$") ? [`\${${args[0].toUpperCase()}_VERSION_SUFFIX}`] : [])].filter(Boolean);
    }
    if (["get_version", "get_version_from_tag"].includes(name)) return args.slice(0, 1);
    if (name === "rocm_setup_version") {
      const at = args.findIndex((arg) => arg.toUpperCase() === "VERSION");
      return at >= 0 ? [args[at + 1]].filter(Boolean) : [];
    }
    if (name === "set" && (args[0] === "PACKAGE_VERSION" || args[0]?.endsWith("_VERSION"))) return args.slice(0, 2);
    const at = args.indexOf(name === "set_property" ? "PROPERTY" : "PROPERTIES");
    if (name === "set_property" && args[0] === "TARGET" && ["VERSION", "SOVERSION"].includes(args[at + 1])) return [args[1], args[at + 2]].filter(Boolean);
    if (name === "set_target_properties" && at >= 0) {
      const fields = [];
      for (let index = at + 1; index < args.length - 1; index += 2) if (["VERSION", "SOVERSION"].includes(args[index])) fields.push(args[index + 1]);
      return fields.length ? [args[0], ...fields] : [];
    }
    return [];
  };
  const metadataCommand = (command) => commandInfo(command).metadata.length > 0;
  // Only branch over data that can reach a source declaration. This is not a
  // configuration interpreter: every fork remains an unselected source choice.
  const outputOf = (command) => {
    if (["set", "unset"].includes(command.name) || scopedProgramPaths && command.name === "get_filename_component") return command.args[0];
    if (command.name === "file" && ["READ", "STRINGS"].includes(command.args[0]?.toUpperCase())) return command.args[2];
    if (command.name === "list" && command.args[0] === "GET") return command.args.at(-1);
    if (command.name === "string") {
      const [mode, operation] = command.args;
      if (mode === "JSON") return command.args[1];
      if (mode === "REGEX") return command.args[operation === "REPLACE" ? 4 : 3];
      if (["APPEND", "PREPEND", "CONCAT"].includes(mode)) return command.args[1];
      if (["TOUPPER", "TOLOWER", "STRIP", "LENGTH", "GENEX_STRIP", "JOIN"].includes(mode)) return command.args[2];
      if (["SUBSTRING", "COMPARE"].includes(mode)) return command.args[4];
      return command.args[3];
    }
  };
  const commandInfo = (command) => {
    let info = commandSyntax.get(command);
    if (!info) {
      const metadata = metadataArguments(command);
      const references = (args) => args.flatMap((arg) => [...arg.matchAll(/\$\{([^{}]+)\}/g)].map((match) => match[1]));
      info = {
        metadata,
        outputs: [outputOf(command), ...(command.name === "string" && command.args[0] === "REGEX" ? ["CMAKE_MATCH_1"] : [])].filter(Boolean),
        sourceInputs: references(fetchNames.has(command.name) ? command.args : metadata),
        inputs: references(command.args),
      };
      commandSyntax.set(command, info);
    }
    return info;
  };
  let inheritedNeeded = declarationContext?.needed || (sourceBudget.emptyNeeded ||= new Set());
  // Only sets produced by this evaluation may be reused by identity. A caller
  // can supply and subsequently mutate its own needed set or iterable.
  if (!immutableNeeded.has(inheritedNeeded)) {
    inheritedNeeded = new Set(inheritedNeeded);
    immutableNeeded.add(inheritedNeeded);
  }
  let closures = neededClosures.get(commands);
  if (!closures) neededClosures.set(commands, closures = new WeakMap());
  let needed = closures.get(inheritedNeeded);
  const outputNeeded = (output) => {
    if (needed.has(output)) return true;
    if (output.includes("${")) for (const key of needed) if (output.includes(`\${${key}}`)) return true;
    return false;
  };
  if (!needed) {
    // Completed dependency closures are immutable. Most recursive helper calls
    // add no inputs, so keep the inherited set's identity instead of cloning it
    // and recomputing the same closure for the next invocation.
    needed = inheritedNeeded instanceof Set ? inheritedNeeded : new Set(inheritedNeeded);
    let owned = false;
    const addNeeded = (input) => {
      if (needed.has(input)) return;
      if (!owned) { needed = new Set(needed); owned = true; }
      needed.add(input);
    };
    for (const command of commands) for (const input of commandInfo(command).sourceInputs) addNeeded(input);
    for (let round = 0; round < 10; round++) {
      const before = needed.size;
      for (const command of commands) {
        const info = commandInfo(command);
        if (!info.outputs.some(outputNeeded)) continue;
        for (const input of info.inputs) addNeeded(input);
        if (command.name === "list" && command.args[0] === "GET" && command.args[1] && !command.args[1].includes("$")) addNeeded(command.args[1]);
      }
      if (before === needed.size) break;
    }
    closures.set(inheritedNeeded, needed);
    immutableNeeded.add(needed);
  }
  const affectsSource = (items) => items.some((command) => fetchNames.has(command.name) || metadataCommand(command) ||
    definitions.has(command.name) || command.name === "cmake_language" && command.args[0] === "CALL" ||
    command.name === "include" || command.name === "file" && ["READ", "STRINGS", "DOWNLOAD"].includes(command.args[0]?.toUpperCase()) ||
    commandInfo(command).outputs.some(outputNeeded));
  // These commands cannot change supported variable/helper state. Anything
  // else, including an unknown command, retains the conservative full fork.
  const declarationOnlyBranch = (items) => items.every((command) =>
    // MATCHES writes CMAKE_MATCH_n even when its body is declaration-only.
    !(["if", "elseif"].includes(command.name) && command.args.some((arg) => arg.toUpperCase() === "MATCHES")) &&
    !definitions.get(command.name)?.outputs.size &&
    (fetchNames.has(command.name) ||
      ["if", "elseif", "else", "endif", "message", "add_library",
        "target_include_directories", "target_link_libraries"].includes(command.name)));
  const expand = (value, listDir, literalOffsets) => {
    if (!value.includes("${")) return value;
    const hadListDir = variables.has("CMAKE_CURRENT_LIST_DIR");
    const previousListDir = variables.get("CMAKE_CURRENT_LIST_DIR");
    variables.set("CMAKE_CURRENT_LIST_DIR", listDir);
    try {
      return expandCmakeVariables(value, variables, literalOffsets);
    } finally {
      if (hadListDir) variables.set("CMAKE_CURRENT_LIST_DIR", previousListDir);
      else variables.delete("CMAKE_CURRENT_LIST_DIR");
    }
  };
  const bind = (key, value) => {
    if (!key || key.includes("$")) return;
    localWrites?.add(key);
    for (const branch of conservativeBranches) if (!branch.writes.has(key)) branch.writes.set(key, { present: variables.has(key), value: variables.get(key) });
    variables.set(key, value.includes("$") ? unknown(key) : value);
    if (key === "PROJECT_VERSION" && project && !explicitProjectVersion) project.version = literalVersion(value) ? value : undefined;
  };
  const condition = (args, listDir, literalOffsets) => {
    // Resolve only values carried by this bounded declaration context. Missing
    // build/environment variables remain unknown, rather than assumed false.
    const and = args.indexOf("AND");
    const or = args.indexOf("OR");
    if (and > 0 || or > 0) {
      const at = or > 0 ? or : and;
      const first = condition(args.slice(0, at), listDir);
      const second = condition(args.slice(at + 1), listDir);
      if (args[at] === "AND") return first === false || second === false ? false : first === true && second === true ? true : undefined;
      return first === true || second === true ? true : first === false && second === false ? false : undefined;
    }
    if (args[0] === "NOT" && args.length > 1) {
      const value = condition(args.slice(1), listDir);
      return value === undefined ? undefined : !value;
    }
    if (args.length === 1) {
      const arg = expand(args[0], listDir, literalOffsets?.[0]);
      const bound = variables.get(arg);
      const value = (bound ?? arg).toUpperCase();
      if (["TRUE", "ON", "YES", "Y", "1"].includes(value)) return true;
      if (["FALSE", "OFF", "NO", "N", "0", "", "IGNORE", "NOTFOUND"].includes(value) || value.endsWith("-NOTFOUND")) return false;
      if (bound !== undefined && !bound.includes("$")) return true;
    }
    const matchArgs = args[0] === "NOT" ? args.slice(1) : args;
    if (matchArgs[0] === "DEFINED" && matchArgs.length === 2) {
      const key = expand(matchArgs[1], listDir);
      if (variables.has(key) && !variables.get(key).includes("$")) return args[0] !== "NOT";
    }
    if (args[1] === "STREQUAL" && args.length === 3) {
      const operand = (arg) => {
        const bound = variables.get(arg);
        const value = bound ?? expand(arg, listDir);
        const literal = !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value) || /^(?:TRUE|FALSE|ON|OFF)$/i.test(value);
        return { value, known: !value.includes("$") && (bound !== undefined || arg.includes("${") || literal) };
      };
      const first = operand(args[0]);
      const second = operand(args[2]);
      if (first.known && second.known) return first.value === second.value;
    }
    if (args[1] === "IN_LIST" && args.length === 3 && variables.has(args[0]) && variables.has(args[2])) {
      const first = variables.get(args[0]);
      const values = variables.get(args[2]);
      if (!first.includes("$") && !values.includes("$")) return values.split(";").includes(first);
    }
    if (matchArgs[1] === "MATCHES" && matchArgs[2]?.replaceAll("\\.", ".") === "^([0-9]+).([0-9]+).([0-9]+)") {
      const value = variables.get(matchArgs[0]) ?? expand(matchArgs[0], listDir, literalOffsets?.[args[0] === "NOT" ? 1 : 0]);
      if (value.includes("$")) return undefined;
      const match = value.match(/^(\d+)\.(\d+)\.(\d+)/);
      for (let index = 1; index <= 3; index++) bind(`CMAKE_MATCH_${index}`, match?.[index] || unknown("capture"));
      return args[0] === "NOT" ? !match : Boolean(match);
    }
    if (matchArgs[1] === "MATCHES" && matchArgs[2]?.startsWith("#define")) {
      const text = variables.get(matchArgs[0]) ?? expand(matchArgs[0], listDir);
      const result = !text.includes("$") && numericHeaderCaptures(matchArgs[2], text);
      for (let index = 1; index <= 9; index++) bind(`CMAKE_MATCH_${index}`, result?.captures?.[index - 1] || unknown("capture"));
      return result ? (args[0] === "NOT" ? !result.matched : result.matched) : undefined;
    }
    // Data-only numeric Make-field capture. Never compile project regexes.
    const field = args[1] === "MATCHES" && args[2]?.match(/^([A-Za-z_][A-Za-z0-9_]*) \*:?= \*\(\[0-9\][*+]\)$/);
    if (field) {
      const text = expand(args[0], listDir, literalOffsets?.[0]);
      if (text.includes("$")) { bind("CMAKE_MATCH_1", unknown("capture")); return undefined; }
      const match = text.split(/\r?\n/).map((line) => line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:?=\s*(\d*)\s*(?:#.*)?$/))
        .find((entry) => entry?.[1] === field[1]);
      bind("CMAKE_MATCH_1", match ? match[2] : unknown("capture"));
      return Boolean(match);
    }
    return undefined;
  };
  const ownedJsonVersion = (component) => {
    const directories = [dir];
    const parent = dirname(dir);
    const parentFile = join(parent, "CMakeLists.txt");
    if (!relative(resolve(sourceRoot), parent).startsWith("..")) {
      const parentText = readSource(parentFile, MAX_VERSION_BYTES);
      if (parentText && parseCmakeCommands(parentText).some((command) => command.name === "add_subdirectory" &&
        command.args[0] && !command.args[0].includes("$") && resolve(parent, command.args[0]) === dir)) directories.push(parent);
    }
    for (const directory of directories) {
      const path = join(directory, "version.json");
      try {
        const metadata = JSON.parse(readSource(path, MAX_VERSION_BYTES) || "{}");
        const version = metadata[`${component}_version`];
        if (literalVersion(version)) return { path, version, parentFile: directory !== dir ? parentFile : undefined };
      } catch { /* Invalid metadata is not an owned version. */ }
    }
  };
  const retainConservativeTail = (currentFile, items, branches = [], context) => {
    if (!items.length || sourceBudget.conservative) return;
    sourceBudget.fallbackTails ||= new Set();
    const key = `${currentFile}:${items[0].line}:${(sourceBudget.invocations || []).join("|")}${context ? `:${context.identity}` : ""}`;
    if (sourceBudget.fallbackTails.has(key)) return;
    sourceBudget.fallbackTails.add(key);
    // These are snapshots proved before the exhausted command, not speculative
    // writes. The conservative continuation still invalidates uncertain writes.
    const local = new Map(context?.variables || variables);
    const fallback = evaluateCmakeProjectDetails(currentFile, items, sourceRoot, {
      declarationsOnly: true, variables: local, definitions: context?.definitions || definitions, needed, sourceDir: dir, projectName: declaredProjectName,
      parentWrites: context?.parentWrites || parentWrites, trackLocalWrites: Boolean(localWrites), localWrites: context?.localWrites || localWrites,
      conditions: [...(context?.conditions || sourceConditions), ...branches.map((branch) => branch.condition), "analysis-budget-exhausted"],
      budget: { paths: 0, commands: 0, includes: 0, activeIncludes: new Set(), depth: 0, conservative: true,
        fallbackTails: sourceBudget.fallbackTails, helperPool: sourceBudget.helperPool,
        fetchCommandKeys, commandSyntax, neededClosures, immutableNeeded, helperSummaries, summaryPool,
        speculative: sourceBudget.speculative, authenticatedFiles,
        scopedProgramPaths,
        invocations: [...(sourceBudget.invocations || [])] },
    }, ownerQuery);
    appendObservations(fallback.fetchCommands);
    versionCandidates.push(...fallback.versionCandidates);
    versionFiles.push(...fallback.versionFiles);
    terminalStates.push(...fallback.terminalStates);
  };
  const evaluate = (items, currentFile, depth = 0, inheritedUnknown = false) => {
    const listDir = dirname(currentFile);
    const branches = (declarationContext?.activeBranches || []).map((branch) => ({ ...branch }));
    let definition;
    let definitionDepth = 0;
    for (let commandIndex = 0; commandIndex < items.length; commandIndex++) {
      const command = items[commandIndex];
      if (++commandCount.value > 20000 || declarationsOnly && ++sourceBudget.commands > (sourceBudget.commandLimit || 40000)) {
        exhausted = true;
        if (declarationsOnly) retainConservativeTail(currentFile, items.slice(commandIndex), branches);
        return;
      }
      const name = command.name;
      if (name === "function" || name === "macro") {
        if (!definitionDepth++) definition = { name: command.args[0]?.toLowerCase(), macro: name === "macro", parameters: command.args.slice(1), outputs: new Set(), parentOutputs: new Set(), body: [],
          sourceFile: currentFile, inactive: branches.some((branch) => branch.state === false), branches: branches.map((branch) => ({ ...branch })) };
        continue;
      }
      if (name === "endfunction" || name === "endmacro") {
        if (--definitionDepth === 0 && definition?.name && !definition.inactive) {
          if (!definitionsOwned) { definitions = new Map(definitions); definitionsOwned = true; }
          definitions.set(definition.name, definition);
          if (declarationsOnly) pendingDefinitions.push({ definition, variables: new Map(variables) });
        }
        continue;
      }
      if (definitionDepth) {
        definition.body.push(command);
        const key = outputOf(command);
        if (key && command.args.includes("PARENT_SCOPE")) definition.parentOutputs.add(key);
        if (key && (definition.macro ? !command.args.includes("PARENT_SCOPE") : command.args.includes("PARENT_SCOPE"))) definition.outputs.add(key);
        continue;
      }
      if (name === "block") {
        let nesting = 1;
        let end = commandIndex + 1;
        for (; end < items.length; end++) {
          if (items[end].name === "block") nesting++;
          if (items[end].name === "endblock" && !--nesting) break;
        }
        const args = command.args;
        let closingCharged = false;
        const propagateAt = args.indexOf("PROPAGATE");
        const propagated = propagateAt >= 0 ? args.slice(propagateAt + 1) : [];
        const scopes = args[0] === "SCOPE_FOR" ? args.slice(1, propagateAt < 0 ? undefined : propagateAt) : ["VARIABLES", "POLICIES"];
        if (scopes.length && scopes.every((scope) => scope === "VARIABLES" || scope === "POLICIES") && !scopes.includes("VARIABLES")) continue;
        if (!branches.some((branch) => branch.state === false)) {
          const supported = end < items.length && scopes.length && scopes.every((scope) => ["VARIABLES", "POLICIES"].includes(scope)) &&
            propagated.every((key) => /^[A-Za-z_]\w*$/.test(key)) && (declarationContext?.blockDepth || 0) < 16;
          if (supported) {
            const local = evaluateCmakeProjectDetails(currentFile, items.slice(commandIndex + 1, end), sourceRoot, {
              declarationsOnly, variablesOnly: !declarationsOnly, variables, definitions, needed, sourceDir: dir, activeBranches: branches,
              projectName: declaredProjectName, authenticatedFiles, parentContextMemo,
              blockDepth: (declarationContext?.blockDepth || 0) + 1, blockCommandCost: commandCount, budget: sourceBudget,
              conditions: [...sourceConditions, ...branches.filter((branch) => branch.state !== true).map((branch) => branch.condition)],
            }, ownerQuery);
            appendObservations(local.fetchCommands);
            versionCandidates.push(...local.versionCandidates);
            versionFiles.push(...local.versionFiles);
            const states = declarationsOnly ? local.terminalStates : [{ variables: local.variables, definitions: local.definitions, parentWrites: local.parentWrites }];
            closingCharged = true;
            const closingExceeded = ++commandCount.value > 20000 || declarationsOnly && ++sourceBudget.commands > (sourceBudget.commandLimit || 40000);
            const different = states.length > 1 && states.some((state) => !cmakeParentWritesEqual(state.parentWrites, states[0].parentWrites) ||
              propagated.some((key) => state.variables.has(key) !== states[0].variables.has(key) || state.variables.get(key) !== states[0].variables.get(key)));
            if (declarationsOnly && different && sourceBudget.paths + states.length <= 64) {
              for (const state of states) {
                sourceBudget.paths++;
                const snapshot = new Map(variables);
                const written = localWrites && new Set(localWrites);
                for (const [key, value] of state.parentWrites || []) {
                  if (value === undefined) snapshot.delete(key); else snapshot.set(key, value);
                  written?.add(key);
                }
                for (const key of propagated) {
                  if (!state.variables.has(key)) snapshot.delete(key); else snapshot.set(key, state.variables.get(key));
                  written?.add(key);
                }
                const context = { variables: snapshot, definitions: state.definitions, parentWrites, localWrites: written, conditions: state.conditions || sourceConditions,
                  identity: JSON.stringify([state.conditions, propagated.map((key) => [key, state.variables.get(key)]), [...(state.parentWrites || [])]]) };
                if (closingExceeded) retainConservativeTail(currentFile, items.slice(end + 1), branches, context);
                else {
                  const tail = evaluateCmakeProjectDetails(currentFile, items.slice(end + 1), sourceRoot, {
                    declarationsOnly: true, ...context, budget: sourceBudget, needed, sourceDir: dir, projectName: declaredProjectName,
                    activeBranches: branches, trackLocalWrites: Boolean(localWrites),
                  }, ownerQuery);
                  appendObservations(tail.fetchCommands);
                  versionCandidates.push(...tail.versionCandidates);
                  versionFiles.push(...tail.versionFiles);
                  terminalStates.push(...tail.terminalStates);
                }
              }
              exhausted ||= closingExceeded;
              return;
            }
            const outward = new Set(states.flatMap((state) => [...(state.parentWrites?.keys() || [])]));
            if (!states.length) for (const item of items.slice(commandIndex + 1, end)) {
              if (!["set", "unset"].includes(item.name) || !item.args.includes("PARENT_SCOPE")) continue;
              const key = expandCmakeVariables(item.args[0], local.variables);
              if (key.includes("$")) {
                for (const key of needed) if (variables.has(key)) outward.add(key);
              } else outward.add(key);
            }
            for (const key of outward) {
              const values = states.map((state) => state.parentWrites?.has(key) ? state.parentWrites.get(key) : variables.get(key));
              if (values.length && values.every((value) => value === undefined)) { variables.delete(key); localWrites?.add(key); }
              else bind(key, values.length && values.every((value) => typeof value === "string" && value === values[0]) ? values[0] : unknown(key));
            }
            for (const key of propagated) {
              const values = states.map((state) => state.variables.get(key));
              if (values.length && values.every((value) => value === undefined)) { variables.delete(key); localWrites?.add(key); }
              else bind(key, values.length && values.every((value) => typeof value === "string" && value === values[0]) ? values[0] : unknown(key));
            }
            if (states.length) {
              definitions = new Map([...states[0].definitions].filter(([key, value]) => states.every((state) => state.definitions.get(key) === value)));
              definitionsOwned = true;
            }
            if (closingExceeded) {
              exhausted = true;
              if (declarationsOnly) retainConservativeTail(currentFile, items.slice(end + 1), branches);
              return;
            }
          } else for (const key of propagated) bind(key, unknown(key));
        }
        if (!closingCharged && end < items.length && (++commandCount.value > 20000 || declarationsOnly && ++sourceBudget.commands > (sourceBudget.commandLimit || 40000))) {
          exhausted = true;
          if (declarationsOnly) retainConservativeTail(currentFile, items.slice(end + 1), branches);
          return;
        }
        commandIndex = end;
        continue;
      }
      if (name === "endblock") continue;
      if (name === "if" || name === "foreach" || name === "while") {
        const outerInactive = branches.some((branch) => branch.state === false);
        const state = name === "if" && !outerInactive ? condition(command.args, listDir, command.literalVariableOffsets) : undefined;
        if (declarationsOnly && !sourceBudget.conservative && !outerInactive && name === "if" && state === undefined) {
          const segments = [];
          let nesting = 0;
          let start = commandIndex + 1;
          let branchCondition = `if(${command.args.join(" ")})`;
          let possible = true;
          let followingPossible = true;
          let end = items.length;
          let hasElse = false;
          for (let at = start; at < items.length; at++) {
            const candidate = items[at];
            if (candidate.name === "if") nesting++;
            else if (candidate.name === "endif") {
              if (nesting) nesting--;
              else { segments.push({ body: items.slice(start, at), condition: branchCondition, possible }); end = at; break; }
            } else if (!nesting && ["else", "elseif"].includes(candidate.name)) {
              segments.push({ body: items.slice(start, at), condition: branchCondition, possible });
              start = at + 1;
              branchCondition += `/${candidate.name}(${candidate.args.join(" ")})`;
              const guard = candidate.name === "elseif" ? condition(candidate.args, listDir) : undefined;
              possible = followingPossible && guard !== false;
              if (guard === true) followingPossible = false;
              if (candidate.name === "else") hasElse = true;
            }
          }
          if (!hasElse) segments.push({ body: [], condition: `not(${command.args.join(" ")})`, possible: followingPossible });
          const available = segments.filter((segment) => segment.possible);
          if (!available.some((segment) => affectsSource(segment.body))) { commandIndex = end; continue; }
          const independent = available.every((segment) => declarationOnlyBranch(segment.body));
          if (sourceBudget.depth >= 12 || sourceBudget.paths + available.length > 64) {
            exhausted = true; retainConservativeTail(currentFile, items.slice(commandIndex), branches); return;
          }
          for (const segment of available) {
            if (sourceBudget.paths >= 64) { exhausted = true; retainConservativeTail(currentFile, items.slice(commandIndex), branches); return; }
            sourceBudget.paths++;
            sourceBudget.depth++;
            const details = evaluateCmakeProjectDetails(currentFile, independent ? segment.body : [...segment.body, ...items.slice(end + 1)], sourceRoot, {
              declarationsOnly: true, variables, definitions, budget: sourceBudget, needed, projectName: declaredProjectName, sourceDir: dir, activeBranches: branches,
              parentWrites, trackLocalWrites: Boolean(localWrites), localWrites,
              conditions: [...sourceConditions, ...branches.filter((branch) => branch.kind !== "if").map((branch) => branch.condition), segment.condition],
            }, ownerQuery);
            appendObservations(details.fetchCommands);
            versionCandidates.push(...details.versionCandidates);
            if (!independent) terminalStates.push(...details.terminalStates);
            sourceBudget.depth--;
          }
          if (independent) { commandIndex = end; continue; }
          return;
        }
        const branch = { state, taken: state, kind: name, condition: `${name}(${command.args.join(" ")})` };
        if (sourceBudget.conservative && name === "if" && state === undefined && !outerInactive) {
          branch.writes = new Map();
          branch.outcomes = [];
          conservativeBranches.push(branch);
        }
        branches.push(branch);
        continue;
      }
      if (name === "else" || name === "elseif") {
        const branch = branches.at(-1);
        if (branch) {
          if (branch.writes) {
            if (branch.state !== false) branch.outcomes.push(new Map([...branch.writes.keys()].map((key) => [key, variables.get(key)])));
            for (const [key, original] of branch.writes) {
              if (original.present) variables.set(key, original.value); else variables.delete(key);
            }
            if (name === "else") branch.hasElse = true;
          }
          if (branch.taken === true) branch.state = false;
          else if (name === "else") branch.state = branch.taken === false ? true : undefined;
          else {
            const state = condition(command.args, listDir, command.literalVariableOffsets);
            branch.state = state === false ? false : branch.taken === false ? state : undefined;
          }
          branch.taken = branch.taken === true || branch.state === true ? true : branch.taken === undefined || branch.state === undefined ? undefined : false;
        }
        continue;
      }
      if (["endif", "endforeach", "endwhile"].includes(name)) {
        const branch = branches.pop();
        if (branch?.writes) {
          if (branch.state !== false) branch.outcomes.push(new Map([...branch.writes.keys()].map((key) => [key, variables.get(key)])));
          if (!branch.hasElse) branch.outcomes.push(new Map([...branch.writes].map(([key, original]) => [key, original.value])));
          conservativeBranches.pop();
          for (const [key, original] of branch.writes) {
            const values = branch.outcomes.map((outcome) => outcome.has(key) ? outcome.get(key) : original.value);
            const value = values[0];
            bind(key, typeof value === "string" && values.every((entry) => entry === value) ? value : unknown(key));
          }
        }
        continue;
      }
      if (branches.some((branch) => branch.state === false)) continue;
      if (sourceBudget.observeProgramPaths && name === "get_filename_component") sourceBudget.sawProgramPath = true;
      // Unsupported commands have no effect in this reader. Keep their command
      // budget accounting and branch analysis, but do not expand large target/
      // source argument lists unless the name resolves to a local helper.
      if (!fetchNames.has(name) && !CMAKE_EVALUATED_NAMES.has(name) && !(scopedProgramPaths && name === "get_filename_component") &&
        !definitions.has(name) && !name.endsWith("_setup_version")) continue;
      const uncertain = inheritedUnknown || branches.some((branch) => branch.state === undefined);
      const args = command.args.map((arg, index) => expand(arg, listDir, command.literalVariableOffsets?.[index]));
      const output = outputOf({ ...command, args });
      const declarationConditions = [...sourceConditions, ...branches.filter((branch) => branch.kind !== "if" || branch.state === undefined).map((branch) => branch.condition)];
      const loopContext = branches.some((branch) => branch.kind !== "if");
      if (name === "project" && args[0] && !args[0].includes("$")) {
        bind("PROJECT_NAME", args[0]);
        bind("PROJECT_SOURCE_DIR", dir);
        bind(`${args[0]}_SOURCE_DIR`, dir);
        if (!variables.has("CMAKE_SOURCE_DIR")) bind("CMAKE_SOURCE_DIR", dir);
      }
      if (declarationsOnly) {
        const recordVersion = (kind, version, owner = declaredProjectName) => {
          if (owner && !owner.includes("$") && literalVersion(version)) versionCandidates.push({
            name: owner, version, kind, source: `${currentFile}:${command.line}`, conditions: declarationConditions,
            ...(["helper-output", "helper-default", "packaging-default"].includes(kind) ? {
              ownerSourceDir: relative(resolve(sourceRoot), resolve(dir)).split("\\").join("/") || ".",
              default: true, ...(versionFiles.length ? { sourceFiles: [...new Set(versionFiles)] } : {}),
            } : {}),
            ...(kind === "packaging-default" ? { variable: args[0] } : {}),
          });
        };
        if (name === "project" && args[0] && !args[0].includes("$")) {
          declaredProjectName = args[0];
          const at = args.findIndex((arg) => arg.toUpperCase() === "VERSION");
          if (at >= 0) {
            const suffix = variables.get(`${declaredProjectName.toUpperCase()}_VERSION_SUFFIX`);
            const version = args[at + 1];
            recordVersion("project", version && suffix && !suffix.includes("$") && !version.endsWith(suffix) ? version + suffix : version);
          }
        } else if (name === "get_version") recordVersion("helper-argument", args[0]);
        else if (name === "get_version_from_tag") recordVersion("helper-default", args[0]);
        else if (name === "set" && command.args.includes("PARENT_SCOPE") && needed.has(args[0])) recordVersion("helper-output", args[1]);
        else if (name === "set" && args[0] === "PACKAGE_VERSION") recordVersion("package-constant", args[1], variables.get("PACKAGE_NAME") || declaredProjectName);
        else if (name === "set" && declaredProjectName && args[0]?.toUpperCase() === `${declaredProjectName.replace(/[-.]/g, "_").toUpperCase()}_VERSION`) recordVersion("project-constant", args[1]);
        else if (name === "set" && declaredProjectName && args[2] === "CACHE" &&
          args[0]?.toUpperCase() === `${declaredProjectName.replace(/[-.]/g, "_").toUpperCase()}_RELEASE_VERSION`) recordVersion("packaging-default", args[1]);
        else if (name === "rocm_setup_version") {
          const at = args.findIndex((arg) => arg.toUpperCase() === "VERSION");
          if (at >= 0) recordVersion("setup-version", args[at + 1]);
        }
        else if (["set_property", "set_target_properties"].includes(name)) {
          const start = args.findIndex((arg) => ["PROPERTY", "PROPERTIES"].includes(arg));
          const owner = name === "set_property" && args[0] === "TARGET" ? args[1] : args[0];
          if (start >= 0) for (let index = start + 1; index < args.length - 1; index += 2) {
            if (["VERSION", "SOVERSION"].includes(args[index])) recordVersion(args[index] === "VERSION" ? "library-version" : "soversion", args[index + 1], owner);
          }
        }
      }
      if (declarationsOnly && fetchNames.has(name)) {
        const flattened = args.flatMap((arg, index) => command.args[index]?.startsWith("${") && command.args[index]?.endsWith("}") &&
          !command.literalVariableOffsets?.[index]?.length ? arg.split(";") : [arg]);
        args.splice(0, args.length, ...flattened);
      }
      if (fetchNames.has(name) && (!ownerQuery || CMAKE_CONTEXT_NAMES.has(name))) {
        fetchCommands.push({ name, args: [...args], declaredArgs: command.args, line: command.line, sourceFile: currentFile,
          ...(uncertain || declarationConditions.length ? { conditional: true } : {}),
          ...(sourceBudget.speculative ? { helperTemplate: true } : {}),
          ...(sourceBudget.invocations?.length ? { helperInvocations: [...sourceBudget.invocations] } : {}),
          ...(declarationConditions.length ? { conditions: declarationConditions } : {}) });
      }
      if (!ownerQuery && declarationsOnly && name === "file" && args[0]?.toUpperCase() === "DOWNLOAD" && /^(?:https?):\/\//.test(args[1] || "")) {
        const expectedHash = args[args.indexOf("EXPECTED_HASH") + 1];
        const expectedMd5 = args[args.indexOf("EXPECTED_MD5") + 1];
        const hash = args.includes("EXPECTED_HASH") ? expectedHash : args.includes("EXPECTED_MD5") ? `MD5=${expectedMd5}` : undefined;
        fetchCommands.push({ name: "file_download", args: [basename(args[1]), "URL", args[1], "SOURCE_FILE", args[2] || "", ...(hash ? ["URL_HASH", hash] : [])], declaredArgs: command.args,
          sourceFile: currentFile, line: command.line, conditional: uncertain || declarationConditions.length > 0, conditions: declarationConditions,
          ...(sourceBudget.speculative ? { helperTemplate: true } : {}),
          ...(sourceBudget.invocations?.length ? { helperInvocations: [...sourceBudget.invocations] } : {}) });
      }
      const helperName = name === "cmake_language" && args[0] === "CALL" ? args[1]?.toLowerCase() : name;
      const helperArgs = name === "cmake_language" && args[0] === "CALL" ? args.slice(2) : args;
      if (definitions.has(helperName)) {
        const called = definitions.get(helperName);
        let keys = [...called.outputs].map((key) => {
          for (let index = 0; index < called.parameters.length; index++) key = key.replaceAll(`\${${called.parameters[index]}}`, helperArgs[index] || "");
          return key;
        });
        // Evaluate closed data helpers, never source commands. Outward values
        // come from executed writes, not the helper's final local environment.
        const dataOnly = cmakeHelperIsData(called, definitions);
        let evaluated;
        const sourceDispatch = called.body.some((item) => fetchNames.has(item.name) ||
          item.name === "cmake_language" && item.args[0] === "CALL" || definitions.has(item.name));
        if (declarationsOnly && !loopContext && (called.parameters.length || sourceDispatch || dataOnly && (keys.some((key) => needed.has(key)) || called.parentOutputs?.size)) &&
          (sourceBudget.helperDepth || 0) < 12) {
          const callConditions = [...declarationConditions, `call(${currentFile}:${command.line})`];
          const callInvocations = [...(sourceBudget.invocations || []), `${currentFile}:${command.line}`];
          const helperDepth = sourceBudget.helperDepth || 0;
          const remaining = (sourceBudget.commandLimit || 40000) - sourceBudget.commands;
          let summaries;
          // In conservative mode a closed helper graph cannot fork or perform
          // input reads. Summaries retain relative observation provenance and
          // replay the exact command cost; truncated evaluations are not cached.
          if (sourceBudget.conservative && called.body.length <= 20000 && remaining >= called.body.length) {
            let cache = helperSummaries.get(called);
            if (!cache || !cmakeHelperDefinitionsMatch(cache.definitions, definitions)) {
              cache = { local: cmakeHelperIsLocal(called, definitions), definitions: new Map(definitions), contexts: new WeakMap() };
              helperSummaries.set(called, cache);
            }
            if (cache.local) {
              summaries = cache.contexts.get(needed);
              if (!summaries) cache.contexts.set(needed, summaries = []);
              for (const summary of summaries) {
                if (summary.dir !== dir || summary.root !== sourceRoot || summary.project !== declaredProjectName ||
                  summary.speculative !== Boolean(sourceBudget.speculative) || summary.depth !== helperDepth ||
                  summary.commands > remaining) continue;
                if (!summary.inputs.every((input) =>
                  cmakeHelperInput(called, helperArgs, variables, dir, input.key) === input.value &&
                  cmakeHelperInputPresent(called, helperArgs, variables, input.key) === input.present)) continue;
                sourceBudget.commands += summary.commands;
                evaluated = {
                  fetchCommands: (ownerQuery ? summary.facts.filter((fact) => CMAKE_CONTEXT_NAMES.has(fact.name)) : summary.facts).map((fact) => ({ ...fact,
                    conditions: [...callConditions, ...fact.conditions],
                    helperInvocations: [...callInvocations, ...fact.helperInvocations] })),
                  versionFiles: [],
                  versionCandidates: summary.candidates.map((candidate) => ({ ...candidate, conditions: [...callConditions, ...candidate.conditions] })),
                  terminalStates: [{ variables: new Map(summary.outputs), conditions: callConditions,
                    parentWrites: summary.parentWrites, localWrites: summary.localWrites }],
                };
                break;
              }
            }
          }
          if (!evaluated) {
            // Limits bound memoization storage, never source analysis/coverage.
            const store = summaries && summaries.length < 64 && summaryPool.entries < 2048 && summaryPool.facts < 65536;
            // Admission and storage limits depend on the complete deduplicated
            // inventory. Build it for cacheable summaries even in owner mode;
            // callers project the resulting records only after caching.
            const summaryReads = store || declarationContext?.summaryReads ? new Set() : undefined;
            const commandsBefore = sourceBudget.commands;
            sourceBudget.helperDepth = helperDepth + 1;
            sourceBudget.invocations ||= [];
            sourceBudget.invocations.push(`${currentFile}:${command.line}`);
            evaluated = evaluateCmakeProjectDetails(called.sourceFile, called.body, sourceRoot, {
              declarationsOnly: true, variables, definitions, budget: sourceBudget, needed, summaryReads,
              helperArguments: { parameters: called.parameters, values: helperArgs },
              sourceDir: dir, projectName: declaredProjectName, conditions: callConditions, trackLocalWrites: called.macro,
            }, ownerQuery && !store);
            sourceBudget.helperDepth--;
            sourceBudget.invocations.pop();
            if (store && evaluated.terminalStates.length === 1 && !evaluated.versionFiles.length &&
              !evaluated.terminalStates[0].activeBranches.length &&
              sourceBudget.commands - commandsBefore <= remaining &&
              summaryPool.facts + evaluated.fetchCommands.length <= 65536 &&
              evaluated.fetchCommands.every((fact) =>
                callConditions.every((value, index) => fact.conditions?.[index] === value) &&
                callInvocations.every((value, index) => fact.helperInvocations?.[index] === value))) {
              const outputs = new Map([...new Set([...keys, ...(evaluated.terminalStates[0].localWrites || [])])]
                .map((key) => [key, evaluated.terminalStates[0].variables.get(key)]));
              summaries.push({
                dir, root: sourceRoot, project: declaredProjectName, speculative: Boolean(sourceBudget.speculative), depth: helperDepth,
                commands: sourceBudget.commands - commandsBefore, outputs,
                parentWrites: evaluated.terminalStates[0].parentWrites, localWrites: evaluated.terminalStates[0].localWrites,
                inputs: [...summaryReads].map((key) => ({ key,
                  value: cmakeHelperInput(called, helperArgs, variables, dir, key),
                  present: cmakeHelperInputPresent(called, helperArgs, variables, key) })),
                facts: evaluated.fetchCommands.map((fact) => ({ ...fact,
                  conditions: fact.conditions.slice(callConditions.length),
                  helperInvocations: fact.helperInvocations.slice(callInvocations.length) })),
                candidates: evaluated.versionCandidates.map((candidate) => ({ ...candidate, conditions: candidate.conditions.slice(callConditions.length) })),
              });
              summaryPool.entries++;
              summaryPool.facts += evaluated.fetchCommands.length;
            }
          }
          appendObservations(evaluated.fetchCommands);
          versionCandidates.push(...evaluated.versionCandidates);
        }
        if (!declarationsOnly && !uncertain && !loopContext && dataOnly &&
          called.branches.every((branch) => branch.state === true) &&
          (keys.some((key) => needed.has(key)) || sourceDispatch || called.parentOutputs?.size)) {
          const local = new Map(variables);
          for (let index = 0; index < called.parameters.length; index++) local.set(called.parameters[index], helperArgs[index] || "");
          evaluated = evaluateCmakeProjectDetails(called.sourceFile, called.body, sourceRoot, {
            declarationsOnly: true, variables: local, needed, sourceDir: dir, projectName: project?.name || declaredProjectName,
            definitions, trackLocalWrites: called.macro,
          }, ownerQuery);
        }
        if (evaluated) keys = [...new Set([...keys, ...evaluated.terminalStates.flatMap((state) =>
          [...(called.macro ? state.localWrites || [] : state.parentWrites?.keys() || [])])])];
        // Preserve branch-specific macro outputs as available alternatives.
        if (declarationsOnly && evaluated?.terminalStates.length > 1 &&
          (keys.some((key) => new Set(evaluated.terminalStates.map((state) => cmakeHelperOutput(called, state, key, variables))).size > 1) ||
            called.macro && evaluated.terminalStates.some((state) => !cmakeParentWritesEqual(state.parentWrites, evaluated.terminalStates[0].parentWrites))) &&
          sourceBudget.paths + evaluated.terminalStates.length <= 64) {
          for (const state of evaluated.terminalStates) {
            sourceBudget.paths++;
            const local = new Map(variables);
            for (const key of keys) {
              const value = cmakeHelperOutput(called, state, key, variables);
              if (value === undefined) local.delete(key); else local.set(key, value);
            }
            const outward = called.macro ? new Map(parentWrites) : parentWrites;
            if (called.macro) for (const [key, value] of state.parentWrites || []) outward.set(key, value);
            const tail = evaluateCmakeProjectDetails(currentFile, items.slice(commandIndex + 1), sourceRoot, {
              declarationsOnly: true, variables: local, definitions, budget: sourceBudget, needed,
              sourceDir: dir, projectName: declaredProjectName, activeBranches: branches, parentWrites: outward,
              trackLocalWrites: Boolean(localWrites), localWrites,
              conditions: state.conditions || declarationConditions,
            }, ownerQuery);
            appendObservations(tail.fetchCommands);
            versionCandidates.push(...tail.versionCandidates);
            versionFiles.push(...tail.versionFiles);
            terminalStates.push(...tail.terminalStates);
          }
          return;
        }
        for (const key of keys) {
          if (evaluated?.terminalStates.length && !evaluated.terminalStates.some((state) => called.macro ? state.localWrites?.has(key) : state.parentWrites?.has(key))) continue;
          const values = evaluated?.terminalStates.map((state) => cmakeHelperOutput(called, state, key, variables));
          if (values?.length && values.every((value) => value === undefined)) { variables.delete(key); localWrites?.add(key); continue; }
          const value = values?.length && values.every((value) => typeof value === "string" && !value.includes("$") && value === values[0]) &&
            (declarationsOnly || literalVersion(values[0])) ? values[0] : unknown(key);
          bind(key, value);
        }
        if (called.macro) {
          const targets = evaluated?.terminalStates.length ? new Set(evaluated.terminalStates.flatMap((state) => [...(state.parentWrites?.keys() || [])])) : new Set(called.parentOutputs);
          for (const key of targets) {
            const values = evaluated?.terminalStates.map((state) => state.parentWrites?.has(key) ? state.parentWrites.get(key) : parentWrites?.get(key));
            parentWrites ||= new Map();
            parentWrites.set(key, values?.length && values.every((value) => value === values[0]) ? values[0] : unknown(key));
          }
        }
        if (evaluated) versionFiles.push(...evaluated.versionFiles);
      }
      if (["set", "unset"].includes(name) && args.includes("PARENT_SCOPE") && args[0] && !args[0].includes("$")) {
        const end = args.indexOf("PARENT_SCOPE");
        const value = name === "unset" || end === 1 ? undefined : args.slice(1, end).join(";");
        parentWrites ||= new Map();
        parentWrites.set(args[0], (uncertain && (!declarationsOnly || sourceBudget.conservative) || declarationsOnly && loopContext) ? unknown(args[0]) :
          value?.includes("$") ? unknown(args[0]) : value);
        continue;
      }
      if (name === "unset") { bind(output, unknown(output)); continue; }
      if ((uncertain && !declarationsOnly || declarationsOnly && loopContext) && output) { bind(output, unknown(output)); continue; }
      if (declarationsOnly && name === "cmake_parse_arguments" && args.length >= 4) {
        const [prefix, optionList, oneList, multiList] = args;
        const options = optionList.split(";").filter(Boolean);
        const singles = oneList.split(";").filter(Boolean);
        const multiples = multiList.split(";").filter(Boolean);
        const keywords = new Set([...options, ...singles, ...multiples]);
        for (const key of options) bind(`${prefix}_${key}`, "FALSE");
        for (const key of [...singles, ...multiples]) bind(`${prefix}_${key}`, "");
        const rest = args.slice(4).flatMap((arg) => arg.split(";"));
        if (rest.some((arg) => arg.includes("$"))) {
          for (const key of [...options, ...singles, ...multiples]) bind(`${prefix}_${key}`, unknown(`${prefix}_${key}`));
          continue;
        }
        for (let index = 0; index < rest.length; index++) {
          const key = rest[index];
          if (options.includes(key)) bind(`${prefix}_${key}`, "TRUE");
          else if (singles.includes(key)) bind(`${prefix}_${key}`, rest[++index] || "");
          else if (multiples.includes(key)) {
            const values = [];
            while (index + 1 < rest.length && !keywords.has(rest[index + 1])) values.push(rest[++index]);
            bind(`${prefix}_${key}`, values.join(";"));
          }
        }
      } else if (name === "set" && args.length) {
        if (args.length <= 2 || ["CACHE", "PARENT_SCOPE"].includes(args[2])) bind(args[0], args[1] || "");
        else if (declarationsOnly) bind(args[0], args.slice(1).join(";"));
        else bind(args[0], unknown(args[0]));
      } else if (scopedProgramPaths && name === "get_filename_component" && args[0] && !args[0].includes("$")) {
        bind(args[0], args.length === 3 && args[2] === "ABSOLUTE" && !args[1].includes("$") ? resolve(dir, args[1]) : unknown(args[0]));
      } else if (name === "include" && args[0]) {
        if (sourceBudget.conservative) {
          // An unexecuted include can overwrite caller variables and helpers.
          // Preserve location facts, not selector values across this boundary.
          for (const key of variables.keys()) if (!["CMAKE_CURRENT_SOURCE_DIR", "CMAKE_CURRENT_LIST_DIR"].includes(key)) bind(key, unknown(key));
          definitions = new Map();
          definitionsOwned = true;
          continue;
        }
        const path = resolve(dir, args[0]);
        if (!path.endsWith(".cmake") && !/^CMakeLists[^/\\]*\.txt$/.test(basename(path))) continue;
        if (args[0].includes("$") || relative(resolve(sourceRoot), path).startsWith("..")) continue;
        if (depth >= 4 || ++includeCount > 32 || activeIncludes.has(path) ||
          declarationsOnly && (++sourceBudget.includes > 64 || sourceBudget.activeIncludes.has(path))) {
          exhausted = true;
          if (declarationsOnly) { retainConservativeTail(currentFile, items.slice(commandIndex + 1), branches); return; }
          continue;
        }
        const text = readSource(path, MAX_VERSION_BYTES);
        if (text === undefined) continue;
        versionFiles.push(path);
        if (declarationsOnly) {
          sourceBudget.activeIncludes.add(path);
          const included = evaluateCmakeProjectDetails(path, parseCmakeCommands(text), sourceRoot, {
            declarationsOnly: true, variables, definitions, budget: sourceBudget, needed, projectName: declaredProjectName, sourceDir: dir, conditions: sourceConditions, activeBranches: branches,
            parentWrites, trackLocalWrites: Boolean(localWrites), localWrites,
          }, ownerQuery);
          sourceBudget.activeIncludes.delete(path);
          appendObservations(included.fetchCommands);
          versionCandidates.push(...included.versionCandidates);
          versionFiles.push(...included.versionFiles);
          if (!included.terminalStates.length) retainConservativeTail(currentFile, items.slice(commandIndex + 1), branches);
          for (const state of included.terminalStates) {
            const tail = evaluateCmakeProjectDetails(currentFile, items.slice(commandIndex + 1), sourceRoot, {
              declarationsOnly: true, ...state, budget: sourceBudget, needed, sourceDir: dir,
            }, ownerQuery);
            appendObservations(tail.fetchCommands);
            versionCandidates.push(...tail.versionCandidates);
            versionFiles.push(...tail.versionFiles);
            terminalStates.push(...tail.terminalStates);
          }
          return;
        }
        activeIncludes.add(path);
        evaluate(parseCmakeCommands(text), path, depth + 1, uncertain);
        activeIncludes.delete(path);
      } else if (declarationsOnly && name === "add_subdirectory" && args[0] && !args[0].includes("$")) {
        if (sourceBudget.conservative) continue;
        const childDir = resolve(dir, args[0]);
        const childFile = join(childDir, "CMakeLists.txt");
        const childRelative = relative(resolve(sourceRoot), childDir);
        if (childRelative.startsWith("..") || (sourceBudget.subdirectoryDepth || 0) >= 8 ||
          (sourceBudget.subdirectories || 0) >= 64 || sourceBudget.activeIncludes.has(childFile)) continue;
        const text = readSource(childFile, MAX_VERSION_BYTES);
        if (text === undefined) continue;
        sourceBudget.subdirectories = (sourceBudget.subdirectories || 0) + 1;
        sourceBudget.subdirectoryDepth = (sourceBudget.subdirectoryDepth || 0) + 1;
        sourceBudget.activeIncludes.add(childFile);
        const child = evaluateCmakeProjectDetails(childFile, parseCmakeCommands(text), sourceRoot, {
          declarationsOnly: true, variables, definitions, budget: sourceBudget, needed,
          sourceDir: childDir, projectName: declaredProjectName, conditions: declarationConditions,
        }, ownerQuery);
        sourceBudget.activeIncludes.delete(childFile);
        sourceBudget.subdirectoryDepth--;
        appendObservations(child.fetchCommands);
        versionCandidates.push(...child.versionCandidates);
        versionFiles.push(...child.versionFiles);
      } else if (name === "file" && args[0]?.toUpperCase() === "READ" && args.length >= 3) {
        // OFFSET, LIMIT and HEX change the bytes consumed by CMake. Until
        // implemented, invalidate their destination rather than read all bytes.
        // CMake READ ignores LIMIT_COUNT (a STRINGS option), not LIMIT.
        if (args.length !== 3 && !(args.length === 5 && args[3] === "LIMIT_COUNT" && /^\d+$/.test(args[4]))) {
          bind(args[2], unknown(args[2]));
          continue;
        }
        const path = resolve(dir, args[1]);
        const rel = relative(resolve(sourceRoot), path);
        const maxBytes = /\.(?:h|hpp)$/i.test(path) ? MAX_HEADER_BYTES : MAX_VERSION_BYTES;
        const text = !args[1].includes("$") && rel && !rel.startsWith("..") ? readSource(path, maxBytes)?.trim() : undefined;
        if (text !== undefined && (literalVersion(text) || /^[0-9a-f]{40,64}$/i.test(text) || /version/i.test(basename(path) + args[2]) || /\.(?:h|hpp|json)$/i.test(path))) {
          bind(args[2], text);
          versionFiles.push(path);
        } else bind(args[2], unknown(args[2]));
      } else if (name === "file" && args[0]?.toUpperCase() === "STRINGS" && args.length >= 3) {
        const path = resolve(dir, args[1]);
        let limit;
        let numeric = false;
        let define;
        let supported = true;
        for (let index = 3; index < args.length; index += 2) {
          if (args[index] === "LIMIT_COUNT" && /^\d+$/.test(args[index + 1] || "") && Number(args[index + 1]) <= 1024) limit = Number(args[index + 1]);
          else if (args[index] === "REGEX" && args[index + 1] === "^[0-9]+") numeric = true;
          else if (args[index] === "REGEX" && /^\^#define [A-Za-z_][A-Za-z0-9_]* $/.test(args[index + 1] || "")) define = args[index + 1].slice(9).trim();
          else supported = false;
        }
        const text = supported && !args[1].includes("$") ? readSource(path, MAX_VERSION_BYTES) : undefined;
        if (text !== undefined) {
          let lines = text.split(/\r?\n/).filter((line) => line && (!numeric || /^\d+/.test(line)) &&
            (!define || line.match(/^\s*#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)\s+/)?.[1] === define));
          if (limit) lines = lines.slice(0, limit);
          bind(args[2], lines.join(";"));
          versionFiles.push(path);
        } else bind(args[2], unknown(args[2]));
      } else if (name === "list" && args[0] === "GET" && args.length === 4 && /^\d+$/.test(args[2])) {
        const value = variables.get(args[1])?.split(";")[Number(args[2])];
        bind(args[3], value === undefined ? unknown(args[3]) : value);
      } else if (name === "string") {
        if (args[0] === "REPLACE" && args.length === 5) bind(args[3], args[4].replaceAll(args[1], args[2]));
        else if (args[0] === "STRIP" && args.length === 3) {
          bind(args[2], args[1].trim());
        } else if (args[0] === "JSON" && args[2] === "GET" && args.length >= 5) {
          try {
            let value = JSON.parse(args[3]);
            for (const key of args.slice(4)) value = value?.[key];
            bind(args[1], typeof value === "string" || typeof value === "number" ? String(value) : unknown(args[1]));
          } catch { bind(args[1], unknown(args[1])); }
        } else if (args[0] === "REGEX" && args[1] === "REPLACE" && args[2] === "(\n|\r)" && args[3] === "" && args.length === 6) {
          bind(args[4], args[5].replace(/[\n\r]/g, ""));
        } else if (args[0] === "REGEX" && args[1] === "MATCH" && args[2]?.replaceAll("\\.", ".") === "^([0-9]+).([0-9]+).([0-9]+)") {
          const input = args.slice(4).join("");
          const unresolved = input.includes("$");
          const match = !unresolved && input.match(/^(\d+)\.(\d+)\.(\d+)/);
          bind(args[3], unresolved ? unknown(args[3]) : match ? match[0] : "");
          bind("CMAKE_MATCH_COUNT", unresolved ? unknown("CMAKE_MATCH_COUNT") : match ? "3" : "0");
          for (let index = 0; index <= 9; index++) bind(`CMAKE_MATCH_${index}`, match?.[index] || unknown("capture"));
        } else if (args[0] === "REGEX" && args[1] === "REPLACE" && args[3] === "" && /^\.\*[A-Za-z_][A-Za-z0-9_]* $/.test(args[2] || "")) {
          const suffix = args[2].slice(2).trim();
          const field = args[5]?.match(/^\s*#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)\s+(\d+)\s*$/);
          bind(args[4], field && (field[1] === suffix || field[1].endsWith(`_${suffix}`)) ? field[2] : unknown(args[4]));
        } else if (args[0] === "REGEX" && ["MATCH", "REPLACE"].includes(args[1]) && args[2]?.includes("#")) {
          // Parse a single literal #define field; never compile source regexes.
          const pattern = args[2].replaceAll("\\.", ".").replaceAll('["]', '"');
          const stanza = pattern.replaceAll("\\n", "\n").split("\n");
          if (args[1] === "MATCH" && stanza.length === 2 && /^#[A-Za-z_][A-Za-z0-9_]*$/.test(stanza[0]) && ["([0-9]*)", "([0-9]+)"].includes(stanza[1])) {
            const lines = (args.at(-1) || "").split(/\r?\n/);
            const matches = [];
            for (let at = 0; at < lines.length - 1; at++) if (lines[at].trim() === stanza[0] && /^\d+$/.test(lines[at + 1].trim())) matches.push(lines[at + 1].trim());
            bind("CMAKE_MATCH_1", matches.length === 1 ? matches[0] : unknown("capture"));
            if (output) bind(output, matches.length === 1 ? `${stanza[0]}\n${matches[0]}` : unknown(output));
            continue;
          }
          const numericField = pattern.match(/^\^?#define\s+([A-Za-z_][A-Za-z0-9_]*)\s+\(\[0-9\]\+\)\$?$/)?.[1];
          const field = numericField || pattern.match(/^\^?#define\s+([A-Za-z_][A-Za-z0-9_]*)\s+"/)?.[1];
          const capture = numericField ? "([0-9]+)" : pattern.slice(pattern.indexOf('"') + 1, pattern.lastIndexOf('"'));
          const supported = Boolean(numericField) || ["([0-9.]+)", '([^"]+)', "([0-9]+)"].includes(capture) && /^"?\$?$/.test(pattern.slice(pattern.lastIndexOf('"') + 1));
          const input = args.at(-1);
          const values = field && input?.split(/\r?\n/).map((line) => line.match(numericField ?
            /^\s*#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)\s+(\d+)\s*(?:\/\/.*)?$/ :
            /^\s*#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)\s+"([^"]+)"\s*(?:\/\/.*)?$/)).filter((entry) => entry?.[1] === field);
          if (supported && values?.length === 1 && literalVersion(values[0][2]) && (capture !== "([0-9]+)" || /^\d+$/.test(values[0][2]))) {
            bind("CMAKE_MATCH_1", values[0][2]);
            bind(output, args[1] === "REPLACE" && args[3] === "\\1" ? values[0][2] : unknown(output));
          } else { bind("CMAKE_MATCH_1", unknown("capture")); if (output) bind(output, unknown(output)); }
        }
        else if (args[0] === "REGEX" && args[1] === "REPLACE" && args[2]?.replaceAll("\\.", ".") === "([0-9]+).([0-9]+).([0-9]+)(.*)" && args[3] === "\\1.\\2.\\3") {
          const match = args[5]?.match(/^(\d+)\.(\d+)\.(\d+)[0-9A-Za-z.+_~-]*$/);
          bind(args[4], match ? match.slice(1, 4).join(".") : unknown(args[4]));
        } else if (output) bind(output, unknown(output));
      } else if (!declarationsOnly && name === "project" && args[0] && !args[0].includes("$") && !project) {
        const at = args.findIndex((arg) => arg.toUpperCase() === "VERSION");
        explicitProjectVersion = at >= 0;
        project = { name: args[0], version: !uncertain && at >= 0 && literalVersion(args[at + 1]) ? args[at + 1] : undefined, source: `${currentFile}:${command.line}` };
        const suffix = variables.get(`${project.name.toUpperCase()}_VERSION_SUFFIX`);
        if (project.version && suffix && !suffix.includes("$") && !project.version.endsWith(suffix)) project.version += suffix;
        bind("PROJECT_VERSION", project.version || "");
      } else if (!declarationsOnly && name === "rocm_setup_version" && project) {
        const at = args.findIndex((arg) => arg.toUpperCase() === "VERSION");
        project.version = !uncertain && at >= 0 && literalVersion(args[at + 1]) ? args[at + 1] : undefined;
        project.source = `${currentFile}:${command.line}`;
      } else if ((declarationsOnly || !project && !uncertain) && name.endsWith("_setup_version") && name !== "rocm_setup_version" && args.length === 1 && !args[0].includes("$")) {
        const metadata = ownedJsonVersion(args[0]);
        if (metadata) {
          bind(`${args[0].toUpperCase()}_VERSION`, loopContext ? unknown("loop-version") : metadata.version);
          versionFiles.push(metadata.path);
          if (metadata.parentFile) versionFiles.push(metadata.parentFile);
          if (declarationsOnly) versionCandidates.push({ name: args[0], version: metadata.version, kind: "owned-json", source: metadata.path, conditions: declarationConditions });
          else project = { name: args[0], version: metadata.version, source: `${currentFile}:${command.line}` };
        }
      }
    }
    // No command mutates this invocation's variable snapshot after evaluation.
    // Continuations copy it on entry; only a borrowed helper table still needs
    // detaching from its caller before the terminal state can outlive the call.
    finalBranches = branches.map((branch) => ({ ...branch }));
    if (declarationsOnly) terminalStates.push({ variables, definitions: definitionsOwned ? definitions : new Map(definitions), conditions: sourceConditions, projectName: declaredProjectName,
      activeBranches: branches.map((branch) => ({ ...branch })), parentWrites: parentWrites ? new Map(parentWrites) : undefined,
      localWrites: localWrites ? new Set(localWrites) : undefined });
  };
  evaluate(commands, resolve(file));
  // Template inspection uses the completed local helper table, so helpers may
  // refer to macros defined later in the same include. Actual calls above still
  // obey source order and carry an explicit invocation lineage.
  for (const pending of pendingDefinitions) {
    if (sourceBudget.conservative) break;
    const definition = pending.definition;
    if (!definition.body.some((command) => fetchNames.has(command.name) || metadataCommand(command) ||
      command.name === "file" && ["READ", "STRINGS", "DOWNLOAD"].includes(command.args[0]?.toUpperCase()))) continue;
    const pool = sourceBudget.helperPool ||= { commands: 0, templates: 0 };
    if (pool.commands >= 40000 || pool.templates >= 64) break;
    const helperBudget = sourceBudget.speculative ? sourceBudget : {
      paths: 0, commands: 0, includes: 0, activeIncludes: sourceBudget.activeIncludes,
      depth: 0, speculative: true, authenticatedFiles, commandLimit: Math.min(8000, 40000 - pool.commands), helperPool: pool, fetchCommandKeys, commandSyntax, neededClosures, immutableNeeded, helperSummaries, summaryPool,
      scopedProgramPaths,
    };
    pool.templates++;
    const local = new Map(pending.variables);
    for (const parameter of definition.parameters) local.set(parameter, unknown(parameter));
    const details = evaluateCmakeProjectDetails(definition.sourceFile, definition.body, sourceRoot, {
      declarationsOnly: true, variables: local, definitions, budget: helperBudget, needed,
      projectName: declaredProjectName, sourceDir: dir, activeBranches: definition.branches,
      conditions: [...sourceConditions, ...definition.branches.map((branch) => branch.condition),
        `${definition.macro ? "macro" : "function"}(${definition.name})`],
    }, ownerQuery);
    appendObservations(details.fetchCommands);
    versionCandidates.push(...details.versionCandidates);
    versionFiles.push(...details.versionFiles);
    if (!sourceBudget.speculative) pool.commands += helperBudget.commands;
  }
  if (exhausted && project) project.version = undefined;
  if (!declarationsOnly) {
    if (declarationContext?.variablesOnly) return { ...project, variables, definitions, fetchCommands: [], versionCandidates: [], versionFiles,
      activeBranches: exhausted ? undefined : finalBranches, parentWrites, localWrites };
    const scopedLines = !ownerQuery && new Set(commands.filter(({ name, args }) =>
      name === "find_program" && scopedProgramSearch(args)).map(({ line }) => line));
    const declarationsContext = { declarationsOnly: true, variables: initialVariables, definitions: inheritedDefinitions, projectName: project?.name, conditions: sourceConditions };
    const baselineBudget = { paths: 0, commands: 0, includes: 0, activeIncludes: new Set(), depth: 0, authenticatedFiles,
      commandSyntax, neededClosures, immutableNeeded, helperSummaries, summaryPool, observeProgramPaths: Boolean(scopedLines?.size) };
    const declarations = evaluateCmakeProjectDetails(file, commands, sourceRoot, { ...declarationsContext, budget: baselineBudget }, ownerQuery);
    const requirements = declarations.fetchCommands.filter((command) => CMAKE_REQUIREMENT_NAMES.has(command.name));
    if (baselineBudget.sawProgramPath) {
      // Reuse the declaration evaluator for the exact program obligations
      // only. Never feed path replay into project versions, fetches, or
      // other requirements; use separate dataflow and summary caches.
      const replay = evaluateCmakeProjectDetails(file, commands, sourceRoot, { ...declarationsContext,
        budget: { paths: 0, commands: 0, includes: 0, activeIncludes: new Set(), depth: 0, authenticatedFiles, scopedProgramPaths: true } }, ownerQuery);
      const sourceFile = resolve(file);
      const inScope = (entry) => !entry.helperTemplate && entry.sourceFile === sourceFile && entry.name === "find_program" && scopedLines.has(entry.line);
      const guardKey = (entry) => JSON.stringify([entry.line, Boolean(entry.conditional), entry.helperInvocations || [], entry.conditions || []]);
      const group = (entries) => {
        const variants = new Map();
        for (const entry of entries) if (inScope(entry)) {
          const key = guardKey(entry);
          if (!variants.has(key)) variants.set(key, []);
          variants.get(key).push(entry);
        }
        return variants;
      };
      const replayVariants = group(replay.fetchCommands);
      const baselineVariants = group(requirements);
      // Added path dataflow can change which branches are forked and when
      // evaluation hits its cap. Never replace a site's baseline guards with
      // those from that different traversal, even when the name is unchanged.
      for (let index = 0; index < requirements.length; index++) {
        const entry = requirements[index];
        if (!inScope(entry)) continue;
        const key = guardKey(entry);
        const evaluated = replayVariants.get(key);
        if (baselineVariants.get(key).length === 1 && evaluated?.length === 1 &&
          scopedProgramPathRefinement(entry.args, evaluated[0].args, sourceRoot)) requirements[index] = evaluated[0];
      }
    }
    if (project?.name && basename(file) === "CMakeLists.txt") {
      declarations.versionCandidates.push(...nativeOwnedSourceVersionCandidates(project.name, dirname(resolve(file)), sourceRoot));
    }
    return { ...project, variables, definitions,
      fetchCommands: declarations.fetchCommands.filter((command) => !CMAKE_REQUIREMENT_NAMES.has(command.name) && !CMAKE_CONTEXT_NAMES.has(command.name)),
      contextCommands: declarations.fetchCommands.filter((command) => CMAKE_CONTEXT_NAMES.has(command.name)),
      requirementCommands: requirements,
      versionCandidates: declarations.versionCandidates,
      versionFiles: [...new Set([...versionFiles, ...declarations.versionFiles])] };
  }
  const uniqueFetchCommands = new Map();
  for (const command of fetchCommands) {
    let key = fetchCommandKeys.get(command);
    if (key === undefined) {
      key = JSON.stringify([command.name, command.sourceFile, command.line, command.args, Boolean(command.conditional),
        Boolean(command.helperTemplate), command.helperInvocations || [], command.conditions || []]);
      fetchCommandKeys.set(command, key);
    }
    uniqueFetchCommands.set(key, command);
  }
  return { variables, fetchCommands: [...uniqueFetchCommands.values()], versionCandidates,
    terminalStates: exhausted ? [] : terminalStates, versionFiles: [...new Set(versionFiles)] };
}

function property(component, name) {
  return component.properties?.find((p) => p.name === name)?.value;
}

function mergeProvenance(target, incoming) {
  target.properties ||= [];
  for (const prop of incoming.properties || []) {
    if (!target.properties.some((p) => p.name === prop.name && p.value === prop.value)) {
      target.properties.push(prop);
    }
  }
  for (const key of ["licenses", "hashes", "externalReferences"]) {
    for (const value of incoming[key] || []) {
      target[key] ||= [];
      if (!target[key].some((existing) => JSON.stringify(existing) === JSON.stringify(value))) target[key].push(value);
    }
  }
  const identities = incoming.evidence?.identity;
  const methods = (Array.isArray(identities) ? identities : [identities]).flatMap((id) => id?.methods || []);
  if (!methods.length) {
    return;
  }
  target.evidence ||= {};
  target.evidence.identity ||= { field: "purl", confidence: 0.8, methods: [] };
  const identity = Array.isArray(target.evidence.identity) ? target.evidence.identity[0] : target.evidence.identity;
  identity.methods ||= [];
  for (const method of methods) {
    if (!identity.methods.some((m) => m.value === method.value)) {
      identity.methods.push(method);
    }
  }
}

function satisfiesCmakeRequirements(component, source) {
  const requirements = (component.properties || []).filter((prop) => prop.name === "cdx:cmake:versionRequirements")
    .flatMap((prop) => prop.value.split("|"));
  if (!requirements.length) return true;
  if (["source-revision", "archive-revision"].includes(property(source, "cdx:version:kind")) ||
    !/^\d+(?:\.\d+){0,3}$/.test(source.version || "")) return false;
  const compare = (a, b) => {
    const first = a.split(".").map(BigInt);
    const second = b.split(".").map(BigInt);
    for (let index = 0; index < Math.max(first.length, second.length); index++) {
      if ((first[index] || 0n) !== (second[index] || 0n)) return (first[index] || 0n) > (second[index] || 0n) ? 1 : -1;
    }
    return 0;
  };
  return requirements.every((requirement) => {
    const match = requirement.trim().match(/^(\d+(?:\.\d+){0,3})(?:\.\.\.(<?)(\d+(?:\.\d+){0,3}))?(?:\s+(EXACT))?$/);
    if (!match || (match[3] && match[4])) return false;
    const lower = compare(source.version, match[1]);
    if (match[4]) return lower === 0;
    if (lower < 0) return false;
    if (!match[3]) return true;
    const upper = compare(source.version, match[3]);
    return match[2] === "<" ? upper < 0 : upper <= 0;
  });
}

// A package export is evidence of an available source alternative, never of the
// provider selected by a consumer. Only inspect the owner's bounded CMake area;
// do not borrow exports or version files from arbitrary neighbouring projects.
function ownedPackageExports(directory, project, scanRoot) {
  const aliases = new Map();
  const conflictingVersions = new Set();
  const variables = new Map([
    ["PROJECT_NAME", project.name], ["CMAKE_PROJECT_NAME", project.name],
    ["PROJECT_VERSION", project.version || ""],
    ["PROJECT_SOURCE_DIR", directory], ["CMAKE_CURRENT_SOURCE_DIR", directory],
    ["PROJECT_BINARY_DIR", directory], ["CMAKE_CURRENT_BINARY_DIR", directory],
  ]);
  const files = [join(directory, "CMakeLists.txt")];
  let entries = 0;
  const visit = (path, depth) => {
    if (depth > 3 || entries > 512) return;
    let children;
    try { children = readdirSync(path, { withFileTypes: true }); } catch { return; }
    for (const child of children) {
      if (++entries > 512) return;
      const file = join(path, child.name);
      if (child.isDirectory()) visit(file, depth + 1);
      else if (child.isFile() && /\.cmake(?:\.in)?$/i.test(child.name)) files.push(file);
    }
  };
  for (const child of ["cmake", "cmake_modules"]) visit(join(directory, child), 0);
  const add = (name, source) => {
    if (/^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/.test(name || "")) aliases.set(name.toLowerCase(), { name, source });
  };
  for (const file of files) {
    const text = readRegularTextFile(file, MAX_VERSION_BYTES, scanRoot);
    if (text === undefined) continue;
    const local = new Map(variables);
    local.set("CMAKE_CURRENT_LIST_DIR", dirname(file));
    let nesting = 0;
    for (const command of parseCmakeCommands(text)) {
      const args = command.args.map((arg) => expandCmakeVariables(arg, local));
      if (["endif", "endfunction", "endmacro", "endforeach", "endwhile"].includes(command.name)) nesting--;
      if (!nesting && command.name === "set" && args.length === 2 && !args[1].includes("$")) local.set(args[0], args[1]);
      if (["configure_package_config_file", "write_basic_package_version_file", "configure_file"].includes(command.name)) {
        const output = args[command.name === "write_basic_package_version_file" ? 0 : 1];
        for (const arg of output ? [output] : []) {
          const match = basename(arg).match(/^(.+?)(?:-config(?:-version)?|-version|Config(?:Version)?)\.cmake(?:\.in)?$/);
          if (match) {
            const at = args.indexOf("VERSION");
            if (command.name === "write_basic_package_version_file" && at >= 0 &&
              literalVersion(args[at + 1]) && args[at + 1] !== project.version) {
              conflictingVersions.add(match[1].toLowerCase());
            }
            add(match[1], `${file}:${command.line}`);
          }
        }
      }
      if (command.name === "rocm_export_targets") add(project.name, `${file}:${command.line}`);
      if (["if", "function", "macro", "foreach", "while"].includes(command.name)) nesting++;
    }
    if (file === files[0]) for (const [key, value] of local) variables.set(key, value);
  }
  return [...aliases.values()].filter((alias) => !conflictingVersions.has(alias.name.toLowerCase()));
}

function ownedRelease(project, directory, scanRoot) {
  const facts = nativeOwnedSourceVersionCandidates(project.name, directory, scanRoot);
  const file = join(directory, "CMakeLists.txt");
  const text = readRegularTextFile(file, MAX_VERSION_BYTES, scanRoot);
  const details = text === undefined ? undefined : cmakeProjectDetails(file, parseCmakeCommands(text), scanRoot, { variablesOnly: true });
  // An explicit, statically evaluated project version wins over a disagreeing
  // auxiliary VERSION file. Conditional helper/packaging defaults never do.
  if (details?.version) return { version: details.version, source: details.source, facts };
  const versions = new Set(facts.map((fact) => fact.version));
  return { ...(versions.size === 1 ? { version: facts[0].version, source: facts[0].source } : {}), facts };
}

function identifyOwnedRelease(project, directory, scanRoot, release, remap) {
  const revisionIdentity = ["source-revision", "archive-revision"].includes(property(project, "cdx:version:kind"));
  if (!release.version) return;
  if (project.version && !revisionIdentity) {
    // The parser may already have found the release. Preserve its identity,
    // but don't discard the independently observed revision needed to prove
    // that a nested executable is built from the same checkout.
    const revision = release.revision;
    if (revision && resolve(revision.root, revision.subpath) === directory &&
      project.version === release.version && !property(project, "cdx:version:sourceRevision")) {
      project.properties.push({ name: "cdx:version:sourceRevision", value: revision.version });
    }
    return;
  }
  const oldRef = project["bom-ref"];
  const revision = release.revision;
  const sourceDir = relative(resolve(scanRoot), directory).split("\\").join("/") || ".";
  const purl = tryBuildPurl({ type: "generic", name: project.name, version: release.version,
    qualifiers: revision?.repository ? { vcs_url: revision.repository } : null,
    // Scan-relative ownership keeps separate vendored copies separate even
    // when their upstream repository and release happen to be identical.
    subpath: sourceDir === "." ? null : sourceDir });
  if (!purl) return;
  project.properties ||= [];
  const sourceRevision = revisionIdentity ? project.version : revision?.version;
  if (sourceRevision) project.properties.push({ name: "cdx:version:sourceRevision", value: sourceRevision });
  if (oldRef) project.properties.push({ name: "cdx:version:sourceIdentity", value: oldRef });
  project.properties = project.properties.filter((p) => p.name !== "cdx:version:kind");
  project.properties.push({ name: "cdx:version:kind", value: "release" },
    { name: "cdx:cmake:versionSource", value: release.source });
  project.version = release.version;
  applyPurl(project, purl);
  if (oldRef && oldRef !== project["bom-ref"]) remap.set(oldRef, project["bom-ref"]);
}

/**
 * Emit source-owned releases and exported package alternatives. A source
 * alternative is not a configured provider: candidate records remain explicitly
 * unselected, and requirements without a supported alternative remain visible.
 */
export function reconcileCmakeSourceProjects(pkgList, projects, dependencies, scanRoot, discoveryProperties = [], options = {}) {
  const remap = new Map();
  const alternatives = new Map();
  const directoryFacts = new Map();
  const sources = [];
  const nameKey = (name) => name?.toLowerCase();
  const mappedRef = (ref) => {
    const seen = new Set();
    while (remap.has(ref) && !seen.has(ref)) { seen.add(ref); ref = remap.get(ref); }
    return ref;
  };
  const addSource = (project, explicitOwner = false) => {
    const sourceDirectory = property(project, "cdx:cmake:sourceDir") || property(project, "cdx:cmake:subprojectDir");
    const projectFile = property(project, "cdx:cmake:projectFile");
    const directory = sourceDirectory ? resolve(scanRoot, sourceDirectory) : projectFile ? dirname(resolve(scanRoot, projectFile)) : undefined;
    if (!directory || !project.name) return;
    const inside = relative(resolve(scanRoot), directory);
    if (inside === ".." || inside.startsWith("../") || inside.startsWith("..\\")) return;
    let release = directoryFacts.get(directory);
    if (!release) {
      release = ownedRelease(project, directory, scanRoot);
      directoryFacts.set(directory, release);
      release.revision = sourceRevisionOf(release.source?.replace(/:\d+$/, "") || join(directory, "CMakeLists.txt"));
    }
    project.properties ||= [];
    for (const candidate of release.facts) {
      const value = JSON.stringify(candidate);
      if (!project.properties.some((entry) => entry.name === "cdx:cmake:versionCandidate" && entry.value === value)) project.properties.push({ name: "cdx:cmake:versionCandidate", value });
    }
    identifyOwnedRelease(project, directory, scanRoot, release, remap);
    const exports = ownedPackageExports(directory, project, scanRoot);
    // AC_INIT names its own released package. An explicit VERSION_<field>
    // owner also supplies identity without guessing from the directory name.
    for (const fact of release.facts) if (fact.kind === "owned-autoconf-init" || explicitOwner) {
      if (fact.name) exports.push({ name: fact.name, source: fact.source });
    }
    sources.push({ project, directory, exports, revision: release.revision });
  };
  for (const project of projects) addSource(project);
  for (const entry of discoveryProperties) {
    if (entry.name !== "cdx:cmake:versionCandidate") continue;
    let fact;
    try { fact = JSON.parse(entry.value); } catch { continue; }
    if (fact.kind !== "owned-version-file" || !fact.name || !fact.ownerSourceDir) continue;
    const directory = resolve(scanRoot, fact.ownerSourceDir);
    if (sources.some((source) => source.directory === directory)) continue;
    // Re-read the bounded owner rather than trusting arbitrary serialized
    // metadata as an authority for identity or release.
    const verified = nativeOwnedSourceVersionCandidates(undefined, directory, scanRoot)
      .find((candidate) => candidate.name === fact.name && candidate.version === fact.version);
    if (!verified) continue;
    addSource({ name: verified.name, type: "library", properties: [
      { name: "cdx:cmake:sourceDir", value: verified.ownerSourceDir },
    ] }, true);
  }
  const emitted = new Map();
  const retain = (component) => {
    const ref = component["bom-ref"];
    if (ref && emitted.has(ref)) mergeProvenance(emitted.get(ref), component);
    else { retained.push(component); if (ref) emitted.set(ref, component); }
  };
  const retained = [];
  for (const pkg of pkgList) {
    const requirementProperties = (pkg.properties || []).filter((p) => p.name === "cdx:build:requirement");
    const records = requirementProperties.map((p) => JSON.parse(p.value));
    if (pkg.version || !records.length || options.nativeDependencyFacts || records.some((r) => r.role !== "software") ||
      property(pkg, "cdx:cmake:depKind") || !pkg.name) {
      retain(pkg);
      continue;
    }
    const unmatched = [];
    const replacements = new Set();
    for (const record of records) {
      record.providerCandidates ||= [];
      for (const provider of record.providerCandidates) if (provider.ref) provider.ref = mappedRef(provider.ref);
      const selected = record.providerCandidates.filter((p) => p.selected && p.ref);
      const candidates = sources.filter(({ project, directory, exports }) => {
        if (!project.version || ["source-revision", "archive-revision"].includes(property(project, "cdx:version:kind"))) return false;
        if (selected.length) return selected.some((p) => p.ref === project["bom-ref"]);
        if (exports.some((alias) => nameKey(alias.name) === nameKey(record.requestedName || pkg.name))) return true;
        // A project can name itself in its own examples/tests without exporting
        // a package. Scope that evidence to this exact owner, not a global name.
        const file = record.file && resolve(scanRoot, record.file);
        const inside = file && relative(directory, file);
        return nameKey(project.name) === nameKey(record.requestedName || pkg.name) &&
          inside && inside !== ".." && !inside.startsWith("../") && !inside.startsWith("..\\");
      }).filter(({ project }) => satisfiesCmakeRequirements({
        properties: record.constraints ? [{ name: "cdx:cmake:versionRequirements", value: record.constraints }] : [],
      }, project));
      if (!candidates.length) { unmatched.push(record); continue; }
      const components = new Map();
      for (const { project, directory, exports, revision } of candidates) {
        const selectedProvider = selected.some((p) => p.ref === project["bom-ref"]);
        let component = project;
        if (!selectedProvider) {
          const sourceDir = relative(resolve(scanRoot), directory).split("\\").join("/") || ".";
          const purl = tryBuildPurl({ type: "generic", name: pkg.name, version: project.version,
            qualifiers: revision?.repository ? { vcs_url: revision.repository } : null,
            subpath: sourceDir === "." ? null : sourceDir });
          if (!purl) continue;
          component = { ...project, name: pkg.name, properties: [...(project.properties || [])] };
          applyPurl(component, purl);
          if (projects.includes(project)) component.properties.push({ name: "cdx:cmake:sourceProjectRef", value: project["bom-ref"] });
          const alias = exports.find((alias) => nameKey(alias.name) === nameKey(record.requestedName || pkg.name));
          if (alias) component.properties.push({ name: "cdx:cmake:packageExport", value: alias.source });
        }
        if (components.has(component["bom-ref"])) mergeProvenance(components.get(component["bom-ref"]), component);
        else components.set(component["bom-ref"], component);
      }
      if (!components.size) { unmatched.push(record); continue; }
      // Keep unrelated declarations as provenance, but replace stale source
      // candidates with refs to the actual emitted release alternatives.
      record.providerCandidates = record.providerCandidates.filter((p) =>
        !["source-project", "source-submodule"].includes(p.kind) || p.selected);
      for (const component of components.values()) if (!record.providerCandidates.some((p) => p.ref === component["bom-ref"])) {
        record.providerCandidates.push({ kind: "source-project", name: component.name, ref: component["bom-ref"],
          sourceDir: property(component, "cdx:cmake:sourceDir") || property(component, "cdx:cmake:subprojectDir"),
          selected: false });
      }
      for (const component of components.values()) {
        const incoming = { ...pkg, properties: (pkg.properties || []).filter((p) => p.name !== "cdx:build:requirement") };
        mergeProvenance(component, incoming);
        const value = JSON.stringify(record);
        if (!component.properties.some((p) => p.name === "cdx:build:requirement" && p.value === value)) component.properties.push({ name: "cdx:build:requirement", value });
        const via = selected.length ? "source-project" : "source-candidate";
        if (!component.properties.some((p) => p.name === "cdx:cmake:resolvedVia" && p.value === via)) component.properties.push({ name: "cdx:cmake:resolvedVia", value: via });
        retain(component);
        replacements.add(component["bom-ref"]);
      }
    }
    if (unmatched.length) {
      pkg.properties = (pkg.properties || []).filter((p) => p.name !== "cdx:build:requirement")
        .concat(unmatched.map((record) => ({ name: "cdx:build:requirement", value: JSON.stringify(record) })));
      retain(pkg);
      replacements.add(pkg["bom-ref"]);
    }
    if (replacements.size) alternatives.set(pkg["bom-ref"], [...replacements]);
  }
  const mappedRefs = (ref) => {
    ref = mappedRef(ref);
    return alternatives.get(ref) || [ref];
  };
  // Embedded provider references must follow the same identity changes as the
  // dependency graph, including unmatched requirements retained above.
  for (const component of [...projects, ...retained]) for (const prop of component.properties || []) {
    if (prop.name !== "cdx:build:requirement") continue;
    const record = JSON.parse(prop.value);
    for (const provider of record.providerCandidates || []) if (provider.ref) provider.ref = mappedRef(provider.ref);
    prop.value = JSON.stringify(record);
  }
  const graph = new Map();
  for (const entry of dependencies || []) for (const ref of mappedRefs(entry.ref)) {
    const merged = graph.get(ref) || { ...entry, ref, dependsOn: [] };
    merged.dependsOn = [...new Set([...merged.dependsOn, ...(entry.dependsOn || []).flatMap(mappedRefs)])].filter((dep) => dep !== ref);
    if (entry.provides) merged.provides = [...new Set([...(merged.provides || []), ...entry.provides.flatMap(mappedRefs)])];
    graph.set(ref, merged);
  }
  return { pkgList: retained, dependencies: [...graph.values()], remap, alternatives };
}

function nativeIndexedSourceOwners(pkgList, scanRoot, options) {
  const sourceFacts = [];
  const sourceTexts = new Map();
  const replacements = new Map();
  const projectOrigins = new Map();
  const root = resolve(scanRoot);
  const contains = (directory, file) => {
    const path = relative(directory, file);
    return path !== ".." && !path.startsWith("../") && !path.startsWith("..\\");
  };
  const directoryOf = (component) => {
    const sourceDir = property(component, "cdx:cmake:sourceDir") || property(component, "cdx:cmake:subprojectDir") || property(component, "cdx:meson:sourceDir");
    const file = property(component, "cdx:cmake:projectFile") || property(component, "cdx:meson:projectFile") ||
      property(component, "SrcPath")?.match(/(?:^|[/\\])(?:CMakeLists\.txt|meson\.build)$/)?.input;
    return sourceDir ? resolve(root, sourceDir) : file ? dirname(resolve(root, file)) : component === options.parentComponent ? root : undefined;
  };
  for (const component of [...pkgList, ...(options.parentComponent ? [options.parentComponent] : [])]) {
    if (!component.version || !component["bom-ref"] || component.type === "file") continue;
    if (property(component, "cdx:native:providerIdentity") || property(component, "cdx:native:providerEvidence") ||
      ["installed-provider-metadata", "cached-provider-metadata"].includes(property(component, "cdx:native:resolvedVia"))) continue;
    const directory = directoryOf(component);
    if (directory && contains(root, directory)) {
      let conditions = [];
      try {
        const value = JSON.parse(property(component, "cdx:cmake:conditions") || "[]");
        if (Array.isArray(value) && value.every((condition) => typeof condition === "string")) conditions = value;
      } catch { /* Malformed caller metadata does not establish a condition. */ }
      sourceFacts.push({ component, directory, conditions, scopeDirectory: sourceRootOf(join(directory, "CMakeLists.txt")) || directory });
    }
  }
  const projects = (options.nativeSourceProjects || []).map((component) => ({ ...component, properties: [...(component.properties || [])] }));
  const projectFiles = new Set(projects.map((component) => property(component, "cdx:cmake:projectFile") || property(component, "cdx:meson:projectFile"))
    .filter(Boolean).map((file) => resolve(root, file)));
  const manifests = (options.nativeSourceManifests || []).map((file) => resolve(root, file));
  const readManifest = (file) => {
    if (!sourceTexts.has(file)) sourceTexts.set(file, readRegularTextFile(file, MAX_VERSION_BYTES, root));
    return sourceTexts.get(file);
  };
  const projectEvaluations = new Map();
  const configuredEvaluations = new Map();
  const parentContextMemo = new Map();
  const contextInputHashes = new Map();
  const evaluateProject = (file, text, context) => {
    const key = `${file}\0${context?.key || ""}`;
    if (!projectEvaluations.has(key)) {
      // Explicit nonempty caller guards affect provenance, not evaluation.
      // Keep unconfigured/unguarded calls separate: they can inherit parent
      // scope and differ in conditional-observation flags.
      const conditions = context?.conditions;
      const bindings = context?.variables instanceof Map ? [...context.variables] : undefined;
      const inputKey = conditions?.length && conditions.every((value) => typeof value === "string") &&
        bindings?.every(([name, value]) => typeof name === "string" && typeof value === "string")
        ? JSON.stringify([file, bindings]) : undefined;
      const cached = inputKey && configuredEvaluations.get(inputKey);
      let details;
      if (cached) {
        details = structuredClone(cached.details);
        const rebased = new Map();
        for (const record of [...details.contextCommands, ...details.versionCandidates]) {
          if (!record.conditions?.length) continue;
          if (!rebased.has(record.conditions)) {
            rebased.set(record.conditions, [...conditions, ...record.conditions.slice(cached.conditions.length)]);
          }
          record.conditions = rebased.get(record.conditions);
        }
      } else {
        details = evaluateCmakeProjectDetails(file, parseCmakeCommands(text), root,
          { parentContextMemo, ...(context ? { variables: context.variables, conditions } : {}) }, true);
        // Owner discovery consumes version/context facts, not declaration
        // inventories or helper definitions.
        delete details.fetchCommands;
        delete details.requirementCommands;
        delete details.definitions;
        if (inputKey && [...details.contextCommands, ...details.versionCandidates].every((record) =>
          !record.conditions?.length || conditions.every((value, index) => record.conditions[index] === value))) {
          configuredEvaluations.set(inputKey, { details: structuredClone(details), conditions: [...conditions] });
        }
      }
      projectEvaluations.set(key, details);
    }
    return projectEvaluations.get(key);
  };
  const configuredContexts = new Map();
  const projectContexts = new WeakMap();
  for (const file of manifests) {
    if (basename(file) !== "CMakeLists.txt" || !contains(root, file)) continue;
    const text = readManifest(file);
    if (text === undefined || !/\b(?:project|therock_cmake_subproject_declare)\s*\(/i.test(text)) continue;
    const declarationDetails = evaluateProject(file, text);
    for (const command of declarationDetails.contextCommands || []) {
      if (command.name !== "therock_cmake_subproject_declare" || command.helperTemplate) continue;
      const at = command.args.indexOf("EXTERNAL_SOURCE_DIR");
      const path = at >= 0 && command.args[at + 1];
      if (!path || path.includes("$")) continue;
      const directory = resolve(dirname(command.sourceFile), path);
      if (!contains(root, directory)) continue;
      const variables = new Map();
      for (const arg of command.args) {
        const definition = arg.match(/^-D([A-Za-z_][A-Za-z0-9_]*)(?::[A-Za-z_]+)?=(.*)$/s);
        if (definition && !definition[2].includes("$")) variables.set(definition[1], definition[2]);
      }
      const key = JSON.stringify([directory, [...variables], command.conditions || []]);
      const inputs = [];
      for (const input of declarationDetails.versionFiles) {
        if (!contextInputHashes.has(input)) {
          const text = readManifest(input);
          contextInputHashes.set(input, text === undefined ? undefined : createHash("sha256").update(text).digest("hex"));
        }
        const sha256 = contextInputHashes.get(input);
        if (sha256) inputs.push({ path: input, sha256 });
      }
      configuredContexts.set(key, { key, directory, variables, inputs, conditions: command.conditions || [], source: `${command.sourceFile}:${command.line}` });
    }
  }
  for (const file of manifests) {
    if (basename(file) !== "CMakeLists.txt" || !contains(root, file)) continue;
    const text = readManifest(file);
    if (text === undefined || !/\bproject\s*\(/i.test(text)) continue;
    const contexts = [...configuredContexts.values()].filter((context) => contains(context.directory, file));
    const nearest = contexts.length ? Math.max(...contexts.map((context) => context.directory.length)) : 0;
    const activeContexts = contexts.length ? contexts.filter((context) => context.directory.length === nearest) : [undefined];
    // Reuse only within this file's original context order; registration and
    // every context-specific result remain distinct.
    configuredEvaluations.clear();
    let details;
    for (const context of activeContexts) {
      details = evaluateProject(file, text, context);
      const declared = details.versionCandidates?.filter((candidate) => candidate.kind === "project" &&
        candidate.source && dirname(candidate.source.replace(/:\d+$/, "")) === dirname(file) &&
        !candidate.conditions?.some((condition) => /^(?:function|macro)\(/.test(condition)) &&
        /^[A-Za-z_][A-Za-z0-9_.+-]*$/.test(candidate.name || "")) || [];
      for (const candidate of declared) {
        if (projects.some((project) => project.name === candidate.name && project.version === candidate.version &&
          property(project, "cdx:cmake:projectFile") === relative(root, file).split("\\").join("/") && projectContexts.get(project)?.key === context?.key)) continue;
        const project = { name: candidate.name, version: candidate.version, type: "library", properties: [
          { name: "cdx:cmake:projectFile", value: relative(root, file).split("\\").join("/") },
          { name: "cdx:cmake:versionSource", value: candidate.source },
          ...(candidate.conditions?.length ? [{ name: "cdx:cmake:conditions", value: JSON.stringify(candidate.conditions) }] : []),
          ...(context ? [{ name: "cdx:native:sourceContext", value: JSON.stringify({ source: context.source, conditions: context.conditions, arguments: [...context.variables], inputs: context.inputs }) }] : []),
        ] };
        if (context) projectContexts.set(project, context);
        projects.push(project);
      }
    }
    if (projectFiles.has(file) || !details.name) continue;
    projects.push({ name: details.name, type: "library", properties: [
      { name: "cdx:cmake:projectFile", value: relative(root, file).split("\\").join("/") },
    ] });
    projectFiles.add(file);
  }
  const revisions = sourceFacts.filter(({ component }) => ["source-revision", "archive-revision"].includes(property(component, "cdx:version:kind")))
    .sort((first, second) => second.directory.length - first.directory.length);
  const seenDirectories = new Set();
  for (const project of projects) {
    const directory = directoryOf(project);
    const declaredFile = property(project, "cdx:cmake:projectFile") || property(project, "cdx:meson:projectFile");
    if (!directory || !declaredFile || !contains(root, directory)) continue;
    const file = resolve(root, declaredFile);
    const text = readManifest(file);
    if (text === undefined) continue;
    let details;
    if (basename(file) === "CMakeLists.txt") {
      details = evaluateProject(file, text, projectContexts.get(project));
      const ownCandidate = details.versionCandidates?.find((candidate) => candidate.kind === "project" &&
        candidate.name === project.name && (!project.version || candidate.version === project.version) &&
        candidate.source && dirname(candidate.source.replace(/:\d+$/, "")) === dirname(file) &&
        !candidate.conditions?.some((condition) => /^(?:function|macro)\(/.test(condition)));
      if (details.name?.toLowerCase() !== project.name?.toLowerCase() && !ownCandidate) continue;
      if (ownCandidate) details = { ...details, name: ownCandidate.name, version: ownCandidate.version, source: ownCandidate.source };
    } else {
      const name = text.match(/\bproject\s*\(\s*(['"])([^'"]+)\1/)?.[2];
      if (name !== project.name) continue;
    }
    const ownRelease = details?.version || (project.version && !["source-revision", "archive-revision"].includes(property(project, "cdx:version:kind")) ? project.version : undefined);
    const context = projectContexts.get(project);
    // A scoped executable may carry a release only when that release was
    // independently derived from this checkout. Configured versions can
    // borrow external cache values, so anchor their matching default instead.
    const defaultRelease = context && details ? evaluateProject(file, text) : details;
    const releaseInputs = ownRelease && defaultRelease?.name?.toLowerCase() === project.name?.toLowerCase() &&
      defaultRelease?.version === ownRelease && defaultRelease.source
      ? [defaultRelease.source.replace(/:\d+$/, ""), ...defaultRelease.versionFiles] : undefined;
    const ownerKey = JSON.stringify([directory, project.name, ownRelease || project.version, context?.key]);
    if (seenDirectories.has(ownerKey)) continue;
    seenDirectories.add(ownerKey);
    const existing = sourceFacts.filter((fact) => fact.directory === directory && fact.component.name === project.name);
    const matching = existing.find(({ component }) => component.version === ownRelease &&
      !["source-revision", "archive-revision"].includes(property(component, "cdx:version:kind")));
    if (existing.length && (!ownRelease || matching)) {
      if (matching && releaseInputs) matching.releaseInputs ||= releaseInputs;
      if (context && matching) {
        mergeProvenance(matching.component, { properties: (project.properties || []).filter((entry) => entry.name === "cdx:native:sourceContext" || entry.name === "cdx:cmake:conditions") });
        sourceFacts.push({ ...matching, variables: details?.variables, contextKey: context.key, conditions: context.conditions });
      }
      continue;
    }
    const ancestor = revisions.find((fact) => contains(fact.directory, file));
    const actualRoot = sourceRootOf(file);
    const ancestorRoot = ancestor && sourceRootOf(join(ancestor.directory, "CMakeLists.txt"));
    const revisionOwner = ancestor && (!actualRoot || actualRoot === ancestorRoot) ? ancestor : undefined;
    const version = ownRelease || project.version || revisionOwner?.component.version;
    if (!version) continue;
    const kind = ownRelease ? "release" : property(project, "cdx:version:kind") || property(revisionOwner?.component || {}, "cdx:version:kind");
    if (!ownRelease && !["source-revision", "archive-revision"].includes(kind)) continue;
    const parsed = parsePurlLoose(project.purl || revisionOwner?.component.purl || revisionOwner?.component["bom-ref"]);
    const repository = parsed?.qualifiers?.vcs_url || (parsed?.type === "github" && parsed.namespace ? `https://github.com/${parsed.namespace}/${parsed.name}` : undefined);
    const sourceDir = relative(root, directory).split("\\").join("/") || ".";
    const purl = tryBuildPurl({ type: "generic", name: project.name, version,
      qualifiers: repository ? { vcs_url: repository } : null, subpath: sourceDir === "." ? null : sourceDir });
    if (!purl) continue;
    const component = { ...project, type: "library", version, properties: (project.properties || []).filter((entry) => entry.name !== "cdx:version:kind") };
    component.properties.push({ name: "cdx:version:kind", value: kind }, { name: "cdx:cmake:sourceDir", value: sourceDir });
    if (details?.version) component.properties.push({ name: "cdx:cmake:versionSource", value: details.source });
    if (revisionOwner) {
      component.properties.push({ name: "cdx:version:sourceIdentity", value: revisionOwner.component["bom-ref"] });
      if (ownRelease) component.properties.push({ name: "cdx:version:sourceRevision", value: revisionOwner.component.version });
    }
    const oldRef = project["bom-ref"];
    applyPurl(component, purl);
    if (oldRef && oldRef !== component["bom-ref"]) projectOrigins.set(oldRef, component);
    if (ownRelease) for (const fact of existing.filter(({ component }) => ["source-revision", "archive-revision"].includes(property(component, "cdx:version:kind")))) {
      replacements.set(fact.component["bom-ref"], component);
      const at = sourceFacts.indexOf(fact);
      if (at >= 0) sourceFacts.splice(at, 1);
    }
    sourceFacts.push({ component, directory, variables: details?.variables, contextKey: projectContexts.get(project)?.key,
      conditions: property(project, "cdx:cmake:conditions") ? JSON.parse(property(project, "cdx:cmake:conditions")) : [],
      releaseInputs,
      scopeDirectory: actualRoot || revisionOwner?.scopeDirectory || directory });
  }
  const cachedSourceFacts = [];
  const cachedStandaloneSources = new Map();
  const cache = options.nativeSourceCache || process.env.CDXGEN_NATIVE_SOURCE_CACHE;
  const cachedSelectors = new Map();
  const cachedOwners = new Map();
  if (cache) for (const component of pkgList) {
    if (!component.version || !component["bom-ref"]) continue;
    for (const entry of component.properties || []) {
      if (entry.name !== "cdx:build:requirement") continue;
      let requirement;
      try { requirement = JSON.parse(entry.value); } catch { continue; }
      if (requirement.role !== "source-declaration" || !requirement.source?.gitRepository || requirement.source.helperTemplate ||
        !requirement.providerCandidates?.some((candidate) => candidate.ref === component["bom-ref"])) continue;
      const sourceFile = resolve(root, requirement.file);
      const declared = { gitRepository: requirement.source.gitRepository, gitTag: requirement.source.gitTag,
        gitTagDefault: requirement.source.gitTagDefault, gitTagExplicit: requirement.source.gitTagExplicit,
        gitTagExpression: requirement.source.gitTagExpression, sourceDir: requirement.source.sourceDir };
      const selectorKey = JSON.stringify([declared.gitRepository, declared.gitTag, declared.gitTagDefault, declared.gitTagExplicit,
        declared.gitTagExpression,
        declared.sourceDir ? resolve(dirname(sourceFile), declared.sourceDir) : null]);
      if (!cachedSelectors.has(selectorKey)) cachedSelectors.set(selectorKey, nativeSourceIdentity(declared, sourceFile, cache, root));
      const identity = cachedSelectors.get(selectorKey);
      if (!identity?.sourceTexts || contains(root, identity.directory) ||
        component.version.replace(/^v(?=\d)/, "") !== identity.version?.replace(/^v(?=\d)/, "")) continue;
      const ownerKey = `${component["bom-ref"]}\0${identity.directory}`;
      if (requirement.source.standaloneCmake && requirement.command === "external-project" &&
        requirement.providerCandidates.some((candidate) => candidate.kind === "declared-source" && !candidate.selected && candidate.ref === component["bom-ref"])) {
        const parsed = parsePurlLoose(component.purl || component["bom-ref"]);
        const repository = parsed?.type === "github" && parsed.namespace && nativeSourceRepository(`https://github.com/${parsed.namespace}/${parsed.name}`);
        if (repository && repository === identity.selectorEvidence?.repository) {
          const key = `${ownerKey}\0${identity.selectorEvidence.selector}`;
          if (!cachedStandaloneSources.has(key)) cachedStandaloneSources.set(key, { component, identity, requirements: [] });
          cachedStandaloneSources.get(key).requirements.push(requirement);
        }
      }
      const existingFact = cachedOwners.get(ownerKey);
      const helperFetch = requirement.command === "fetch" && requirement.source.madeAvailable && requirement.source.helperInvocations?.length &&
        requirement.providerCandidates.some((candidate) => candidate.kind === "declared-source" && !candidate.selected && candidate.ref === component["bom-ref"]);
      if (existingFact) {
        if (helperFetch && existingFact.identity === identity) existingFact.helperFetchDeclarations.push(requirement);
        continue;
      }
      const evidence = JSON.stringify(identity.selectorEvidence);
      component.properties ||= [];
      if (!component.properties.some((property) => property.name === "cdx:source:cacheEvidence" && property.value === evidence)) component.properties.push({ name: "cdx:source:cacheEvidence", value: evidence });
      const fact = { component, directory: identity.directory, identity, conditions: requirement.conditions || [],
        helperFetchDeclarations: helperFetch ? [requirement] : [] };
      cachedOwners.set(ownerKey, fact);
      cachedSourceFacts.push(fact);
    }
  }
  return { sourceFacts, cachedSourceFacts, cachedStandaloneSources, sourceTexts, replacements, projectOrigins };
}

function nativeSourceLanguageOwners(occurrences, scanRoot, options, sourceTexts) {
  if (!options.nativeLanguageManifests?.length) return [];
  const wanted = new Set();
  for (const { requirement } of occurrences) {
    if (requirement.role !== "tool" || requirement.command !== "find_program") continue;
    for (const name of requirement.alternatives || [requirement.requestedName]) wanted.add(name);
  }
  if (!wanted.size) return [];
  const root = resolve(scanRoot);
  const read = (path) => {
    if (!sourceTexts.has(path)) sourceTexts.set(path, readRegularTextFile(path, MAX_VERSION_BYTES, root));
    return sourceTexts.get(path);
  };
  const has = (path) => {
    const file = openRegularFile(path, root);
    if (!file) return false;
    closeSync(file.fd);
    return true;
  };
  const owners = [];
  const manifests = new Set(options.nativeLanguageManifests.map((path) => resolve(root, path)));
  for (const file of manifests) {
    const local = relative(root, file);
    if (isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`)) continue;
    const language = basename(file) === "Cargo.toml" ? "cargo" : basename(file) === "pyproject.toml" ? "pypi" : undefined;
    if (!language) continue;
    const text = read(file);
    // Source ownership is a declared script/binary, not a package-name lookup.
    // Cargo autobins need no [[bin]] stanza, but PEP 621 scripts are explicit.
    if (text === undefined || language === "pypi" && !text.includes("scripts")) continue;
    const facts = nativeLanguageSourceFacts(file, text, { root, read, has, wanted });
    if (!facts?.version) continue;
    const exports = facts.exports.filter((entry) => entry.kind === "tool" && wanted.has(entry.name));
    if (!exports.length) continue;
    const purl = tryBuildPurl({ type: language, name: facts.name, version: facts.version });
    if (!purl) continue;
    const directory = dirname(file);
    const id = createHash("sha256").update(file).digest("hex").slice(0, 24);
    const component = { name: facts.name, version: facts.version, type: "library", purl,
      "bom-ref": `${decodeURIComponent(purl)}#native-source-${id}`,
      properties: [{ name: "SrcPath", value: file },
        { name: "cdx:native:sourceInstance", value: id },
        { name: "cdx:version:kind", value: "source-project" },
        { name: "cdx:version:source", value: facts.versionSource }],
    };
    owners.push({ component, directory, scopeDirectory: directory, declaredExports: exports });
  }
  return owners;
}

// Same identity contract as the CLI's nativeAcquisitionRequirementKey, not
// the graph component ref (which can represent several distinct calls).
function nativeSourceOccurrenceKey(requirement) {
  const { providerCandidates: _candidates, enclosingConditions: _enclosing, evaluationCoverage: _coverage, ...identity } = requirement;
  return JSON.stringify(identity);
}

function fetchedConfigOrigin(requirement, ref) {
  return JSON.stringify([requirement.file, requirement.line, requirement.command, requirement.requestedName,
    requirement.source.gitRepository, ref]);
}

// A project name or generated config-version filename alone is not a
// config export. Bind only literal installed config files authenticated by
// the same source selector receipt as the concrete FetchContent invocation.
function authenticatedFetchedConfigs(exports, name, identity) {
  const expected = [`${name.toLowerCase()}config.cmake`, `${name.toLowerCase()}-config.cmake`];
  const result = [];
  for (const entry of exports) {
    if (entry.kind !== "cmake-package" || !entry.global || entry.name.toLowerCase() !== name.toLowerCase()) continue;
    const location = /^(.+):(\d+)$/.exec(entry.source);
    if (!location) continue;
    const text = identity.sourceTexts.get(location[1]);
    if (text === undefined) continue;
    const install = parseCmakeCommands(text).find((command) => command.line === Number(location[2]) && command.name === "install");
    if (install?.args[0] !== "FILES" || install.args.includes("RENAME")) continue;
    const at = install.args.indexOf("DESTINATION");
    if (at < 0) continue;
    for (const argument of install.args.slice(1, at)) {
      if (!expected.includes(basename(argument).toLowerCase()) || argument.includes("$") || isAbsolute(argument)) continue;
      const config = resolve(dirname(location[1]), argument);
      const body = identity.sourceTexts.get(config);
      if (!body || !parseCmakeCommands(body).length) continue;
      result.push({ ...entry, source: `${config}:1`, installationSource: entry.source, sourceDeclared: true,
        materialUnknown: true, interfaceVersionUnknown: true });
    }
  }
  return result;
}

function collectFetchedConfigCandidates(fact, provider, byOrigin) {
  if (!fact.helperFetchDeclarations.length || provider.ref !== fact.component["bom-ref"]) return;
  const parsed = parsePurlLoose(fact.component.purl || provider.ref);
  const repository = parsed?.type === "github" && parsed.namespace && nativeSourceRepository(`https://github.com/${parsed.namespace}/${parsed.name}`);
  if (!repository || repository !== fact.identity.selectorEvidence?.repository) return;
  const byName = new Map();
  for (const requirement of fact.helperFetchDeclarations) {
    const name = requirement.requestedName;
    if (!byName.has(name)) byName.set(name, authenticatedFetchedConfigs(provider.exports, name, fact.identity));
    const exports = byName.get(name);
    if (!exports.length) continue;
    const key = fetchedConfigOrigin(requirement, provider.ref);
    if (!byOrigin.has(key)) byOrigin.set(key, new Map());
    const candidate = { kind: "source-export", name: fact.component.name, ref: provider.ref, selected: false,
      compatibility: "unknown", conditions: requirement.conditions, exports };
    byOrigin.get(key).set(JSON.stringify(candidate), candidate);
  }
}

function attachFetchedTemplateConfigs(updatedRequirements, byOrigin) {
  if (!byOrigin.size) return;
  for (const [key, requirement] of [...updatedRequirements]) {
    if (!requirement.source?.helperTemplate || !requirement.source.madeAvailable) continue;
    const exports = requirement.providerCandidates.flatMap((candidate) => candidate.kind === "declared-source" && !candidate.selected ?
      [...(byOrigin.get(fetchedConfigOrigin(requirement, candidate.ref))?.values() || [])] : []);
    if (!exports.length) continue;
    const updated = { ...requirement, providerCandidates: [...requirement.providerCandidates, ...exports] };
    updatedRequirements.set(key, updated);
    // The attached template already carries originalBomRef, unlike its
    // original occurrence in the parent metadata. Update both identities.
    updatedRequirements.set(nativeSourceOccurrenceKey(requirement), updated);
  }
}

function nativeSourceTemplateDeclarations(components, scanRoot, refMap, occurrenceRemapOverrides, updatedRequirements) {
  const templates = new Map();
  const origins = new Map();
  const origin = ({ file, line, command, source }) => {
    if (!file || !line || !source?.gitRepository) return undefined;
    try {
      const repository = new URL(source.gitRepository);
      repository.pathname = repository.pathname.replace(/\/+$/, "").replace(/\.git$/, "");
      return JSON.stringify([resolve(scanRoot, file), line, command, repository.href]);
    } catch { return undefined; }
  };
  for (const component of components) {
    if (component.version || !component["bom-ref"]) continue;
    for (const entry of component.properties || []) {
      if (entry.name !== "cdx:build:requirement" || !entry.value.includes('"helperTemplate"')) continue;
      let requirement;
      try { requirement = JSON.parse(entry.value); } catch { continue; }
      if (requirement.role !== "source-declaration" || !requirement.source?.helperTemplate || !requirement.source.gitTagExpression) continue;
      const key = origin(requirement);
      if (!key) continue;
      if (!origins.has(key)) origins.set(key, new Map());
      if (!templates.has(component)) templates.set(component, []);
      templates.get(component).push({ entry, requirement, key });
    }
  }
  if (!templates.size) return components;
  for (const component of components) {
    if (!component.version || !component["bom-ref"]) continue;
    for (const entry of component.properties || []) {
      if (entry.name !== "cdx:build:requirement" || !entry.value.includes('"helperInvocations"')) continue;
      let requirement;
      try { requirement = JSON.parse(entry.value); } catch { continue; }
      if (requirement.role !== "source-declaration" || requirement.source?.helperTemplate || !requirement.source?.gitTag ||
        !requirement.source.helperInvocations?.length || !requirement.providerCandidates?.some((candidate) => candidate.ref === component["bom-ref"])) continue;
      origins.get(origin(requirement))?.set(component["bom-ref"], component);
    }
  }
  const removed = new Set();
  const linked = new Map();
  for (const [component, declarations] of templates) {
    const originalBomRef = component["bom-ref"];
    const moved = new Set();
    const replacements = linked.get(originalBomRef) || new Set();
    for (const { entry, requirement, key } of declarations) {
      const owners = origins.get(key);
      if (!owners.size) continue;
      const candidates = (requirement.providerCandidates || []).filter((candidate) => candidate.ref !== originalBomRef && !owners.has(candidate.ref));
      for (const ref of owners.keys()) candidates.push({ kind: "declared-source", ref, selected: false });
      const identity = nativeSourceOccurrenceKey(requirement);
      const updated = { ...requirement, originalBomRef: requirement.originalBomRef || originalBomRef, providerCandidates: candidates };
      updatedRequirements.set(identity, updated);
      const value = JSON.stringify(updated);
      for (const [ref, owner] of owners) {
        if (!owner.properties.some((property) => property.name === "cdx:build:requirement" && property.value === value)) {
          owner.properties.push({ name: "cdx:build:requirement", value });
        }
        replacements.add(ref);
      }
      moved.add(entry);
    }
    if (!moved.size) continue;
    // Unknown actual invocations and unrelated lineage stay on the original
    // ref; removing a non-invocation template never removes an actual call.
    component.properties = component.properties.filter((entry) => !moved.has(entry));
    if (!component.properties.some((entry) => entry.name === "cdx:build:requirement")) removed.add(component);
    linked.set(originalBomRef, replacements);
  }
  for (const component of components) if (!removed.has(component)) {
    const ref = component["bom-ref"];
    linked.get(ref)?.add(ref);
  }
  for (const [ref, replacements] of linked) {
    refMap.set(ref, [...replacements]);
    if (replacements.has(ref)) occurrenceRemapOverrides.set(ref, [ref]);
  }
  return removed.size ? components.filter((component) => !removed.has(component)) : components;
}

/**
 * Final source-provider pass. Call only after every source owner has been
 * materialized in pkgList (and after observed/configured providers). A refMap
 * value is an array because one declaration can have several real releases and
 * a residual unresolved occurrence. Dependency edges are already rewritten.
 */
export function reconcileNativeSourceProviders(pkgList, dependencies, scanRoot, options = {}) {
  const owners = nativeIndexedSourceOwners(pkgList, scanRoot, options);
  const sourceAliases = new Map([...owners.replacements, ...owners.projectOrigins].map(([ref, component]) => [ref, component["bom-ref"]]));
  const refMap = new Map([...owners.replacements].map(([ref, component]) => [ref, [component["bom-ref"]]]));
  const occurrenceRemapOverrides = new Map();
  const updatedRequirements = new Map();
  const effectivePackages = nativeSourceTemplateDeclarations(
    pkgList.map((component) => owners.replacements.get(component["bom-ref"]) || component),
    scanRoot, refMap, occurrenceRemapOverrides, updatedRequirements,
  );
  const occurrences = [];
  for (const component of effectivePackages) {
    if (component.version || component.type === "file") continue;
    for (const entry of component.properties || []) if (entry.name === "cdx:build:requirement") {
      let requirement;
      try { requirement = JSON.parse(entry.value); } catch { continue; }
      if (["software", "tool"].includes(requirement.role)) occurrences.push({ component, requirement });
    }
  }
  const localProgramLookups = new Map();
  const scopedProgramLookups = new Map();
  if (!options.providerIndex) for (const { requirement } of occurrences) {
    if (requirement.command !== "find_program" || !requirement.file || !Number.isInteger(requirement.line)) continue;
    const file = resolve(scanRoot, requirement.file);
    const declared = requirement.declaredArguments || requirement.arguments;
    if (scopedProgramSearch(declared)) {
      if (!scopedProgramLookups.has(file)) scopedProgramLookups.set(file, new Map());
      const lines = scopedProgramLookups.get(file);
      if (!lines.has(requirement.line)) lines.set(requirement.line, []);
      lines.get(requirement.line).push(requirement);
    }
    if (!requirement.definition || !requirement.arguments?.includes("PATHS") ||
      !requirement.arguments.some((argument) => argument.startsWith("${CMAKE_CURRENT_SOURCE_DIR}/"))) continue;
    if (!localProgramLookups.has(file)) localProgramLookups.set(file, new Map());
    const lines = localProgramLookups.get(file);
    if (!lines.has(requirement.line)) lines.set(requirement.line, []);
    lines.get(requirement.line).push(requirement);
  }
  if (!options.providerIndex) owners.sourceFacts.push(...nativeSourceLanguageOwners(occurrences, scanRoot, options, owners.sourceTexts));
  const providerIndex = options.providerIndex || collectNativeProviders(owners.sourceFacts, {
    scanRoot, nativeSourceManifests: options.nativeSourceManifests, sourceTexts: owners.sourceTexts, sourceAliases,
    localProgramLookups,
    nativeOwnerEvaluationCache: options.nativeOwnerEvaluationCache,
    scopedProgramLookups,
    nativeScopedReceipt: options.nativeScopedReceipt,
    [nativeProviderReplay]: options[nativeProviderReplay],
    availableProviders: effectivePackages.filter((component) => property(component, "cdx:native:providerIdentity") && property(component, "cdx:native:providerEvidence")),
  });
  const fetchedConfigs = new Map();
  if (!options.providerIndex) for (const fact of owners.cachedSourceFacts) {
    const cachedIndex = collectNativeProviders([fact], { scanRoot: fact.directory,
      nativeSourceManifests: fact.identity.manifestFiles, sourceTexts: fact.identity.sourceTexts, sourceTextsOnly: true });
    for (const provider of cachedIndex.providers) {
      for (const entry of provider.exports) entry.sourceSelector = fact.identity.selectorEvidence;
      collectFetchedConfigCandidates(fact, provider, fetchedConfigs);
      providerIndex.providers.push(provider);
    }
    for (const [key, entries] of cachedIndex.byExport) {
      if (!providerIndex.byExport.has(key)) providerIndex.byExport.set(key, []);
      providerIndex.byExport.get(key).push(...entries);
    }
    providerIndex.diagnostics.push(...cachedIndex.diagnostics);
    for (const directory of cachedIndex.independentDirectories) providerIndex.independentDirectories.add(directory);
  }
  attachFetchedTemplateConfigs(updatedRequirements, fetchedConfigs);
  if (!options.providerIndex) for (const { component, identity, requirements } of owners.cachedStandaloneSources.values()) {
    // The consumer and the separately configured project do not share
    // variables. Keep the source guards on the contract, not on its owner.
    const index = collectNativeProviders([{
      component: { ...component, properties: [...component.properties] },
      directory: identity.directory, standaloneCmake: true,
    }], { scanRoot: identity.directory, nativeSourceManifests: identity.manifestFiles, sourceTexts: identity.sourceTexts, sourceTextsOnly: true });
    for (const provider of index.providers) {
      const exports = provider.exports.filter((entry) => entry.kind === "cmake-config-install-contract")
        .map((entry) => ({ ...entry, sourceSelector: identity.selectorEvidence }));
      if (!exports.length) continue;
      const candidate = { kind: "source-export", name: component.name, ref: provider.ref, selected: false, compatibility: "unknown", exports };
      for (const requirement of requirements) {
        const providerCandidates = requirement.providerCandidates.filter((entry) => entry.kind !== "source-export" || entry.ref !== candidate.ref);
        updatedRequirements.set(nativeSourceOccurrenceKey(requirement), { ...requirement, providerCandidates: [...providerCandidates, candidate] });
      }
    }
  }
  const { bindings, unresolved } = resolveNativeRequirements(occurrences.map((entry) => entry.requirement), providerIndex);
  const bound = new Map();
  const providersByRef = new Map(providerIndex.providers.map((provider) => [provider.ref, provider]));
  // These are metadata-only observations. Only the provider index's existing
  // authenticated executable rule can contribute a candidate; no software
  // placeholder or acquisition request is created for an OS diagnostic.
  if (options.nativeDiagnosticRequirements?.length) {
    const diagnostics = options.nativeDiagnosticRequirements.filter((entry) => entry.role === "diagnostic-probe" && entry.command === "find_program");
    const observed = resolveNativeRequirements(diagnostics, providerIndex);
    for (const { requirement, candidates } of [...observed.bindings, ...observed.unresolved]) {
      const providerCandidates = [...(requirement.providerCandidates || [])];
      for (const { ref, compatibility, exports } of candidates) {
        const provider = providersByRef.get(ref);
        if (!provider || providerCandidates.some((candidate) => candidate.ref === ref)) continue;
        providerCandidates.push({ kind: "available-export", name: provider.component.name, ref, selected: false, compatibility, exports });
      }
      if (providerCandidates.length !== (requirement.providerCandidates?.length || 0)) {
        updatedRequirements.set(nativeSourceOccurrenceKey(requirement), { ...requirement, providerCandidates });
      }
    }
  }
  const ownerBindings = [];
  for (const record of bindings) {
    // A compatible candidate must not erase other evidenced alternatives
    // whose compatibility can only be determined by configuring the build.
    const alternatives = record.candidates.length === record.providers.length ? [] : record.candidates.flatMap((candidate) => {
      const provider = candidate.compatibility === "unknown" && providersByRef.get(candidate.ref);
      return provider ? [{ ...provider, exports: candidate.exports, compatibility: candidate.compatibility }] : [];
    });
    const binding = alternatives.length ? { ...record, providers: [...record.providers, ...alternatives] } : record;
    bound.set(record.requirement, binding);
    ownerBindings.push(binding);
  }
  for (const record of unresolved) {
    const providers = record.candidates.flatMap((candidate) => {
      const provider = providersByRef.get(candidate.ref);
      return provider ? [{ ...provider, exports: candidate.exports, compatibility: candidate.compatibility }] : [];
    });
    if (!providers.length) continue;
    const binding = { ...record, providers };
    bound.set(record.requirement, binding);
    ownerBindings.push(binding);
  }
  const byComponent = new Map();
  for (const occurrence of occurrences) {
    if (!byComponent.has(occurrence.component)) byComponent.set(occurrence.component, []);
    byComponent.get(occurrence.component).push(occurrence.requirement);
  }
  const retained = [];
  for (const component of effectivePackages) {
    const requirements = byComponent.get(component);
    if (!requirements) { retained.push(component); continue; }
    const replacements = new Set((refMap.get(component["bom-ref"]) || []).filter((ref) => ref !== component["bom-ref"]));
    const unmatched = new Set();
    let provenance;
    for (const requirement of requirements) {
      const binding = bound.get(requirement);
      if (!binding) { unmatched.add(requirement); continue; }
      const helper = binding.providers.every((provider) => provider.exports.every((entry) => entry.kind === "build-helper"));
      const record = { ...requirement, originalBomRef: requirement.originalBomRef || component["bom-ref"],
        ...(helper ? { role: "build-helper", originalRole: requirement.role } : {}),
        providerCandidates: [...(requirement.providerCandidates || [])] };
      for (const provider of binding.providers) {
        const candidate = { kind: provider.directory ? "source-export" : "available-export", name: provider.component.name, ref: provider.ref,
          ...(provider.directory ? { sourceDir: relative(resolve(scanRoot), provider.directory).split("\\").join("/") || "." } : {}),
          selected: false, compatibility: provider.compatibility || binding.compatibility, conditions: provider.conditions,
          exports: provider.exports };
        if (!record.providerCandidates.some((entry) => entry.ref === candidate.ref && entry.kind === candidate.kind)) record.providerCandidates.push(candidate);
      }
      const value = JSON.stringify(record);
      provenance ||= { ...component, properties: (component.properties || []).filter((entry) =>
        !["cdx:build:requirement", "cdx:cmake:sourceDir", "cdx:cmake:subprojectDir", "cdx:cmake:projectFile", "cdx:meson:sourceDir", "cdx:meson:projectFile"].includes(entry.name)) };
      for (const provider of binding.providers) {
        const target = provider.component;
        mergeProvenance(target, provenance);
        if (!target.properties.some((entry) => entry.name === "cdx:build:requirement" && entry.value === value)) target.properties.push({ name: "cdx:build:requirement", value });
        if (!target.properties.some((entry) => entry.name === "cdx:native:resolvedVia" && entry.value === "source-export-index")) target.properties.push({ name: "cdx:native:resolvedVia", value: "source-export-index" });
        replacements.add(provider.ref);
      }
    }
    const otherRecords = (component.properties || []).filter((entry) => {
      if (entry.name !== "cdx:build:requirement") return false;
      try { return !["software", "tool"].includes(JSON.parse(entry.value).role); } catch { return true; }
    });
    if (unmatched.size || otherRecords.length) {
      component.properties = (component.properties || []).filter((entry) => entry.name !== "cdx:build:requirement")
        .concat(otherRecords, [...unmatched].map((requirement) => ({ name: "cdx:build:requirement", value: JSON.stringify(requirement) })));
      retained.push(component);
      replacements.add(component["bom-ref"]);
    }
    if (replacements.size) {
      if (replacements.size !== 1 || !replacements.has(component["bom-ref"])) refMap.set(component["bom-ref"], [...replacements]);
    } else retained.push(component);
  }
  const parentRefs = options.parentComponent ? [options.parentComponent["bom-ref"],
    owners.replacements.get(options.parentComponent["bom-ref"])?.["bom-ref"]].filter(Boolean) : [];
  const emittedRefs = new Set([...retained.map((component) => component["bom-ref"]), ...parentRefs]);
  for (const fact of owners.sourceFacts) {
    if (emittedRefs.has(fact.component["bom-ref"])) continue;
    retained.push(fact.component);
    emittedRefs.add(fact.component["bom-ref"]);
  }
  for (const binding of ownerBindings) for (const provider of binding.providers) {
    for (const component of [provider.component, provider.ownerComponent].filter(Boolean)) {
      const ref = component["bom-ref"];
      if (emittedRefs.has(ref)) continue;
      retained.push(component);
      emittedRefs.add(ref);
    }
  }
  for (const [oldRef, component] of owners.projectOrigins) if (emittedRefs.has(component["bom-ref"])) refMap.set(oldRef, [component["bom-ref"]]);
  const refs = (ref) => refMap.get(ref) || [ref];
  const graph = new Map();
  for (const entry of dependencies || []) for (const ref of refs(entry.ref)) {
    const target = graph.get(ref) || { ...entry, ref, dependsOn: [] };
    target.dependsOn = [...new Set([...target.dependsOn, ...(entry.dependsOn || []).flatMap(refs)])].filter((dep) => dep !== ref);
    if (entry.provides) target.provides = [...new Set([...(target.provides || []), ...entry.provides.flatMap(refs)])].filter((dep) => dep !== ref);
    graph.set(ref, target);
  }
  const materialized = new Map([...owners.replacements, ...owners.projectOrigins].filter(([_ref, component]) => emittedRefs.has(component["bom-ref"])));
  const rewriteParent = (component) => {
    const replacement = materialized.get(component["bom-ref"]);
    const result = replacement ? { ...component, ...replacement } : { ...component };
    if (component.components) result.components = component.components.map(rewriteParent);
    return result;
  };
  const parentComponent = options.parentComponent && rewriteParent(options.parentComponent);
  // Attachment fans out one requirement to its candidate owners. Rewrite
  // each exact serialized input once, not once per attachment.
  const rewrittenRequirements = new Map();
  for (const component of [...retained, ...(parentComponent ? [parentComponent] : [])]) for (const entry of component.properties || []) {
    if (entry.name !== "cdx:build:requirement") continue;
    const original = entry.value;
    const cached = rewrittenRequirements.get(original);
    if (cached !== undefined) { entry.value = cached; continue; }
    let record;
    try { record = JSON.parse(original); } catch { continue; }
    const updated = (record.source?.helperTemplate || record.source?.standaloneCmake || record.role === "diagnostic-probe") &&
      updatedRequirements.get(nativeSourceOccurrenceKey(record));
    if (updated) record = { ...updated };
    if (record.providerCandidates) record.providerCandidates = record.providerCandidates.flatMap((candidate) =>
      candidate.ref ? (occurrenceRemapOverrides.get(candidate.ref) || refs(candidate.ref)).map((ref) => ({ ...candidate, ref })) : [candidate]);
    const rewritten = JSON.stringify(record);
    const value = rewritten === original ? original : rewritten;
    rewrittenRequirements.set(original, value);
    entry.value = value;
  }
  return { pkgList: retained, dependencies: [...graph.values()], refMap, occurrenceRemapOverrides, updatedRequirements, bindings, unresolved, providerIndex,
    ...(parentComponent ? { parentComponent } : {}) };
}
