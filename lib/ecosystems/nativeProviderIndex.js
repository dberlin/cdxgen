import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, readdirSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { openRegularFile, readRegularTextFile } from "../core/boundedFile.js";
import { expandCmakeVariables, parseCmakeCommands } from "../parsers/cmakeLists.js";
import { execGitMetadata } from "../inventory/envcontext.js";
import { parsePurlLoose } from "../inventory/purl.js";
import { sourceRevisionOf } from "../inventory/sourceRevision.js";
import { loadNativeExternalMetadata, nativeFinderToolNames, nativeObservedProviderEvidence, nativeProviderPlatformAccepts, nativeProviderReplay } from "./nativeExternalMetadata.js";
import { nativeOwnerDigest } from "./nativeOwnerCache.js";
import { canonicalOwnerScanRoot, captureOwnerReads, validateOwnerReads } from "./nativeOwnerObservations.js";
import { nativeMesonExports } from "./nativeRegistryMetadata.js";
import { nativeConfiguredReceiptProviders, nativeFinderReceiptEntry, nativeScopedOccurrenceKey, readNativeScopedReceipts } from "./nativeScopedReceipts.js";

const MAX_METADATA_BYTES = 512 * 1024;
const identity = (name) => typeof name === "string" && /^[A-Za-z0-9_][A-Za-z0-9_.:+-]*$/.test(name);
const inside = (directory, file) => { const path = relative(directory, file); return !isAbsolute(path) && path !== ".." && !path.startsWith("../") && !path.startsWith("..\\"); };
const key = (kind, name) => `${kind}:${kind === "cmake-package" ? name.toLowerCase() : name}`;
const programSearchControls = /^(?:HINTS|PATHS|PATH_SUFFIXES|ENV|VALIDATOR|REGISTRY_VIEW|NO_(?:DEFAULT_PATH|PACKAGE_ROOT_PATH|CMAKE_PATH|CMAKE_ENVIRONMENT_PATH|SYSTEM_ENVIRONMENT_PATH|CMAKE_SYSTEM_PATH|CMAKE_INSTALL_PREFIX|CMAKE_FIND_ROOT_PATH)|ONLY_CMAKE_FIND_ROOT_PATH|CMAKE_FIND_ROOT_PATH_BOTH)$/;
// Only this collection path can mark a normalized export as a live executable
// observation. Archive member lists and source declarations are not lookups.
const observedExecutableExports = new WeakSet();
const authenticatedProgramPaths = new WeakMap();
const signedLibraryPaths = new WeakMap();
const signedPackageConfigs = new WeakSet();
const scopedProgramExports = new WeakMap();
const scopedConfiguredExports = new WeakMap();

function isObservedExecutable(entry, receipt) {
  if (entry.kind !== "tool" || !isAbsolute(entry.file || "") || entry.executableUnknown || entry.materialUnknown) return false;
  const provenance = entry.provenance;
  if (receipt.kind === "installed-package-file") return entry.observedLookup === entry.name &&
    isAbsolute(receipt.providedFilePath || "") && provenance?.path === receipt.providedFilePath &&
    provenance.ownershipSha256 === receipt.metadataSha256;
  if (receipt.kind === "installed-python-distribution") return entry.executablePath === entry.file &&
    /^[a-f0-9]{64}$/.test(entry.executableSha256 || "") && entry.executableSha256 === provenance?.executableSha256;
  return entry.file === receipt.path && provenance?.path === entry.file &&
    isAbsolute(provenance.realPath || "") && /^[a-f0-9]{64}$/.test(provenance.observationSha256 || "");
}
const safeMember = (name) => typeof name === "string" && /^[A-Za-z0-9_][A-Za-z0-9_./+-]*$/.test(name) &&
  name.split("/").every((part) => part !== "." && part !== ".." && part !== "");
// This internal value is not a filesystem path and cannot occur in a
// standalone source file (which is rejected if it contains a NUL).
const standaloneBinaryRoot = "\0$<standalone-cmake-binary>";
const standaloneBinaryPrefix = `${standaloneBinaryRoot}/`;
function standaloneConfigFile(value, relativeTo) {
  if (!value || !/(?:-config|Config)\.cmake$/.test(value)) return;
  const path = value.startsWith(standaloneBinaryPrefix) ? value.slice(standaloneBinaryPrefix.length) :
    relativeTo && (relativeTo === standaloneBinaryRoot || relativeTo.startsWith(standaloneBinaryPrefix)) && safeMember(value) ?
      relativeTo === standaloneBinaryRoot ? value : `${relativeTo.slice(standaloneBinaryPrefix.length)}/${value}` : undefined;
  if (safeMember(path)) return path;
}
const installControls = new Set(["TYPE", "DESTINATION", "PERMISSIONS", "CONFIGURATIONS", "COMPONENT", "RENAME", "OPTIONAL", "EXCLUDE_FROM_ALL"]);
const packageFindControls = new Set(["CONFIGS", "HINTS", "PATHS", "PATH_SUFFIXES", "COMPONENTS", "OPTIONAL_COMPONENTS", "CONFIG", "NO_MODULE", "MODULE", "REQUIRED", "QUIET", "REGISTRY_VIEW", "GLOBAL", "BYPASS_PROVIDER"]);
const libraryFindControls = new Set(["HINTS", "PATHS", "PATH_SUFFIXES", "DOC", "REQUIRED", "OPTIONAL", "NO_DEFAULT_PATH", "NO_CACHE", "NAMES_PER_DIR"]);
const finderCommands = new Set(["find_library", "find_path", "find_file", "find_program", "pkg_check_modules", "pkg_search_module"]);
const findContractControls = new Set(["FOUND_VAR", "VERSION_VAR", "HANDLE_COMPONENTS", "CONFIG_MODE", "REASON_FAILURE_MESSAGE", "FAIL_MESSAGE", "NAME_MISMATCHED", "HANDLE_VERSION_RANGE"]);

function providerFindRequirements(name, commands) {
  const required = new Set();
  const delegated = new Set();
  const checks = [];
  const versionVariables = new Set();
  const found = `${name}_found`.toLowerCase();
  let depth = 0;
  let complex = false;
  const branches = [];
  for (const { name: command, args } of commands) {
    if (command === "function" || command === "macro") { depth++; continue; }
    if (command === "endfunction" || command === "endmacro") { depth--; continue; }
    if (depth) continue;
    if (command === "if" || command === "elseif") {
      if (command === "elseif") branches.pop();
      branches.push(args);
    } else if (command === "else") {
      if (branches.length) branches[branches.length - 1] = [];
    } else if (command === "endif") {
      branches.pop();
    } else if (command === "find_package" && identity(args[0]) && args[0] !== "PkgConfig" && args[0].toLowerCase() !== name.toLowerCase()) {
      delegated.add(args[0]);
    } else if (command === "find_package_handle_standard_args" && args[0]?.toLowerCase() === name.toLowerCase()) {
      const version = args[args.indexOf("VERSION_VAR") + 1];
      if (args.includes("VERSION_VAR") && identity(version)) versionVariables.add(version);
      const at = args.indexOf("REQUIRED_VARS");
      for (const term of args.slice(at >= 0 ? at + 1 : args[1] === "DEFAULT_MSG" ? 2 : args.length)) {
        if (findContractControls.has(term)) break;
        if (identity(term)) required.add(term);
      }
    } else if (command === "set" && args[0]?.toLowerCase() === found) {
      const guard = branches.at(-1);
      if (/^(?:TRUE|ON|1)$/i.test(args[1] || "") && guard?.length > 1 &&
        guard.every((term, at) => at % 2 === 0 ? /^[A-Za-z_][A-Za-z0-9_]*$/.test(term) : term === "AND")) {
        for (let at = 0; at < guard.length; at += 2) required.add(guard[at]);
      } else if (/^(?:FALSE|OFF|0)$/i.test(args[1] || "") && guard?.length === 2 && guard[0] === "NOT" && identity(guard[1])) {
        required.add(guard[1]);
      }
    } else if (/^check_(?:(?:cxx|c)_|include_file)/.test(command)) {
      complex = true;
      if (identity(args[1])) checks.push({ command, variable: args[1] });
    }
  }
  return { required: [...required], delegated: [...delegated], versionVariables: [...versionVariables], checks, complex };
}
const copyOperations = new Set(["copy", "copy_if_different", "create_symlink", "$<provider-copy-operation>"]);
const targetFile = (value) => /^\$<TARGET_FILE(?:_NAME)?:([A-Za-z0-9_][A-Za-z0-9_.:+-]*)>$/.exec(value)?.[1];
const cmakeCommand = (value) => /^(?:\$\{CMAKE_COMMAND\}|\$<unknown:CMAKE_COMMAND>|cmake(?:\.exe)?)$/i.test(value || "");
const literalToolOutput = (value) => typeof value === "string" && value
  .replace(/(?:\$\{CMAKE_EXECUTABLE_SUFFIX\}|\$<unknown:CMAKE_EXECUTABLE_SUFFIX>)$/, "");
const programPermissions = (args, at) => at >= 0 &&
  args.slice(at + 1).some((arg, index, values) => /^(?:OWNER|GROUP|WORLD)_EXECUTE$/.test(arg) &&
    !values.slice(0, index).some((value) => installControls.has(value)));

// Compare unexpanded build paths as symbols, not as files. They can link two
// declarations in one owner, but must never be passed to a filesystem reader.
function providerGeneratedPath(value, base, owner) {
  if (!value || /[\\;\0]/.test(value)) return;
  if (!value.includes("$")) {
    const path = resolve(base, value);
    if (inside(owner, path)) return path;
    return;
  }
  const pattern = /^(?:\$\{PROJECT_BINARY_DIR\}|\$<unknown:PROJECT_BINARY_DIR>)(?:\/(?:[A-Za-z0-9_.+-]+|\$\{CMAKE_INSTALL_[A-Z]+DIR\}|\$<unknown:CMAKE_INSTALL_[A-Z]+DIR>))+$/;
  if (pattern.test(value) && !value.split("/").some((part) => part === ".." || part === ".")) return value;
}
const prop = (component, name) => component.properties?.find((entry) => entry.name === name)?.value;

function providerGlobMatches(text, pattern) {
  let at = 0;
  let token = 0;
  let star = -1;
  let retry = 0;
  while (at < text.length) {
    if (pattern[token] === "?" || pattern[token] === text[at]) { at++; token++; }
    else if (pattern[token] === "*") { star = token++; retry = at; }
    else if (star >= 0) { token = star + 1; at = ++retry; }
    else return false;
  }
  while (pattern[token] === "*") token++;
  return token === pattern.length;
}

// A tiny bounded filter language, never execution of project-supplied regexes.
function providerInstallPattern(text, regex) {
  if (typeof text !== "string" || text.length > 512 || text.includes("$") && !text.endsWith("$")) return undefined;
  if (!regex) return /^[A-Za-z0-9_./*?-]+$/.test(text) ? text : undefined;
  let pattern = text.startsWith("^") ? "" : "*";
  for (let at = text.startsWith("^") ? 1 : 0; at < text.length; at++) {
    const char = text[at];
    if (char === "$" && at === text.length - 1) return pattern;
    if (char === "." && text[at + 1] === "*") { pattern += "*"; at++; }
    else if (char === ".") pattern += "?";
    else if (char === "\\" && text[at + 1] === ".") { pattern += "."; at++; }
    else if (/[A-Za-z0-9_/-]/.test(char)) pattern += char;
    else return undefined;
  }
  return `${pattern}*`;
}

function compatibleOwnerConditions(owner, exported) {
  if (!owner?.length || !exported?.length) return true;
  for (const [conditions, other] of [[owner || [], exported || []], [exported || [], owner || []]]) {
    for (let at = 0; at < conditions.length; at++) {
      const condition = conditions[at];
      if (!condition.startsWith("any([") || !condition.endsWith(")")) continue;
      let alternatives;
      try { alternatives = JSON.parse(condition.slice(4, -1)); } catch { continue; }
      if (!Array.isArray(alternatives) || !alternatives.every((path) => Array.isArray(path) && path.every((guard) => typeof guard === "string"))) continue;
      const remaining = [...conditions.slice(0, at), ...conditions.slice(at + 1)];
      return alternatives.some((path) => compatibleOwnerConditions([...remaining, ...path], other));
    }
  }
  const branch = (condition) => /^(if\([^]*?\))((?:\/(?:else|elseif)\([^]*\))*)$/.exec(condition);
  for (const first of owner || []) for (const second of exported || []) {
    const left = branch(first);
    const right = branch(second);
    if (left && right && left[1] === right[1] && left[2] !== right[2]) return false;
    if (first.startsWith("not(") && second === `if(${first.slice(4, -1)})` ||
      second.startsWith("not(") && first === `if(${second.slice(4, -1)})`) return false;
  }
  return true;
}

// Lower literal suffix/list/read dataflow in reachable custom Find helpers.
// This exposes available file owners only; filesystem existence, parsing and
// the remaining FPHSA conjunction stay explicitly unverified.
function providerDataFileSearches(commands, required) {
  if (!required.length || !commands.some((command) => command.name === "file" && command.args[0] === "READ")) return [];
  const definitions = new Map();
  const records = [];
  const stack = [];
  for (const command of commands) {
    if (["function", "macro"].includes(command.name)) {
      const name = command.args[0]?.toLowerCase();
      definitions.set(name, { parameters: command.args.slice(1), parent: stack.at(-1) || "", macro: command.name === "macro" });
      stack.push(name);
    } else if (["endfunction", "endmacro"].includes(command.name)) stack.pop();
    else records.push({ command, parent: stack.at(-1) || "" });
  }
  const reachable = new Set([""]);
  for (let round = 0; round < 16; round++) {
    const size = reachable.size;
    for (const { command, parent } of records) if (reachable.has(parent) && definitions.has(command.name) &&
      reachable.has(definitions.get(command.name).parent)) reachable.add(command.name);
    if (size === reachable.size) break;
  }
  const active = records.filter((record) => reachable.has(record.parent));
  const reads = new Set();
  for (const { command, parent } of active) if (command.name === "file" && command.args[0] === "READ") {
    const variable = command.args[1]?.match(/^\$\{([A-Za-z_]\w*)\}$/)?.[1];
    const parameter = definitions.get(parent)?.parameters.indexOf(variable);
    if (parameter >= 0) {
      for (const call of active) if (call.command.name === parent) {
        const input = call.command.args[parameter]?.match(/^\$\{([A-Za-z_]\w*)\}$/)?.[1];
        if (input) reads.add(input);
      }
    } else if (!parent && variable) reads.add(variable);
  }
  const result = [];
  const byScope = new Map();
  for (const record of active) {
    if (!byScope.has(record.parent)) byScope.set(record.parent, []);
    byScope.get(record.parent).push(record.command);
  }
  let steps = 0;
  let exhausted = false;
  const visit = (parent, literals, callers = []) => {
    const loops = [];
    for (const command of byScope.get(parent) || []) {
      if (++steps > 20000) { exhausted = true; return; }
      const definition = definitions.get(command.name);
      if (definition && callers.length < 16 && !callers.includes(command.name)) {
        const local = definition.macro ? literals : new Map(literals);
        definition.parameters.forEach((parameter, at) => {
          const argument = command.args[at] || "";
          const variable = argument.match(/^\$\{([A-Za-z_]\w*)\}$/)?.[1];
          const value = variable ? literals.get(variable) : /^[A-Za-z0-9_.+-]+$/.test(argument) ? [argument] : undefined;
          if (value) local.set(parameter, value);
          else local.delete(parameter);
        });
        visit(command.name, local, [...callers, command.name]);
      }
      if (command.name === "set") {
        const values = command.args.slice(1);
        if (values.length && values.every((arg) => /^[A-Za-z0-9_.+-]+$/.test(arg)) && !values.includes("CACHE") && !values.includes("PARENT_SCOPE")) literals.set(command.args[0], values);
        else literals.delete(command.args[0]);
      }
      if (command.name === "unset") literals.delete(command.args[0]);
      if (command.name === "foreach") {
        const list = command.args[1]?.match(/^\$\{([A-Za-z_]\w*)\}$/)?.[1];
        loops.push({ variable: command.args[0], values: command.args.length === 2 ? literals.get(list) : undefined });
      }
      if (command.name === "endforeach") { loops.pop(); continue; }
      if (command.name !== "set" || !reads.has(command.args[0])) continue;
      const suffix = command.args[1]?.match(/\/([A-Za-z0-9_.+-]+)\/\$\{([A-Za-z_]\w*)\}$/);
      const loop = suffix && [...loops].reverse().find((loop) => loop.variable === suffix[2]);
      if (!loop?.values || suffix[1] === "..") continue;
      const destinations = active.filter(({ command: item, parent: scope }) => scope === parent && item.name === "set" && required.includes(item.args[0]) && item.args[1] === `\${${command.args[0]}}`).map(({ command: item }) => item.args[0]);
      for (const destination of destinations) result.push({ destination, names: loop.values.map((name) => `${suffix[1]}/${name}`), line: command.line });
    }
  };
  visit("", new Map());
  if (exhausted) return [];
  return result;
}

// Bounded lexical read/replace/write dataflow. Quoted data and uninvoked
// functions cannot provide executable evidence; no PowerShell is executed.
function literalPsMesonTransform(script) {
  if (script.length > MAX_METADATA_BYTES) return undefined;
  const strings = [];
  const tokens = [];
  for (let at = 0; at < script.length;) {
    if (tokens.length > 20000) return undefined;
    const rest = script.slice(at);
    if (rest.startsWith("<#")) {
      const end = script.indexOf("#>", at + 2);
      if (end < 0) return undefined;
      at = end + 2;
    } else if (rest[0] === "#") {
      const end = script.indexOf("\n", at);
      at = end < 0 ? script.length : end;
    } else if (/^@['"]\r?\n/.test(rest)) {
      const quote = rest[1];
      const start = at + rest.match(/^@['"]\r?\n/)[0].length;
      const end = script.indexOf(`\n${quote}@`, start);
      if (end < 0) return undefined;
      tokens.push(`§${strings.push({ value: script.slice(start, end).replaceAll("\r\n", "\n").replace(/\r$/, ""), interpolate: quote === '"' }) - 1}`);
      at = end + 3;
    } else if (rest[0] === "'" || rest[0] === '"') {
      const quote = rest[0];
      let value = "";
      let closed = false;
      at++;
      while (at < script.length) {
        const char = script[at++];
        if (char === quote) {
          if (script[at] === quote) { value += quote; at++; continue; }
          closed = true;
          break;
        }
        if (char === "`" && quote === '"') {
          const escaped = script[at++];
          if (!["r", "n", "t", "`", '"'].includes(escaped)) return undefined;
          value += ({ r: "\r", n: "\n", t: "\t" })[escaped] ?? escaped;
        } else value += char;
      }
      if (!closed) return undefined;
      tokens.push(`§${strings.push({ value, interpolate: quote === '"' }) - 1}`);
    } else if (rest[0] === "\n" || rest[0] === ";") { tokens.push("\n"); at++; }
    else if (/\s/.test(rest[0])) at++;
    else {
      const word = rest.match(/^(?:\$[A-Za-z_]\w*|[A-Za-z_][\w-]*|-\w+|\d+)/)?.[0];
      tokens.push(word ? word.toLowerCase() : rest[0]);
      at += word?.length || 1;
    }
  }
  const statements = (input) => {
    const result = [];
    let current = [];
    let nesting = 0;
    for (const token of input) {
      if (["(", "[", "{"].includes(token)) nesting++;
      if ([")", "]", "}"].includes(token)) nesting--;
      if (nesting < 0 || nesting > 32) return undefined;
      if (token === "\n" && !nesting && current.at(-1) !== "|") {
        if (current.length) result.push(current);
        current = [];
      } else if (token !== "\n" || nesting && current.at(-1) !== "|") current.push(token);
    }
    if (nesting) return undefined;
    if (current.length) result.push(current);
    return result;
  };
  const flat = (input) => input.filter((token) => token !== "\n");
  const signature = (input) => flat(input).map((token) => token.startsWith("§") ? JSON.stringify(strings[Number(token.slice(1))].value) : token).join(" ");
  const values = new Map();
  const helpers = new Map();
  const writes = new Map();
  let parameter;
  let packageName;
  let discoveryVariable;
  const literal = (input) => {
    const parts = [];
    for (let at = 0; at < input.length; at += 2) {
      if (at && input[at - 1] !== "+") return undefined;
      const token = input[at];
      const record = token?.startsWith("§") ? strings[Number(token.slice(1))] : undefined;
      const value = record ? record.interpolate && record.value.includes("$") ? undefined : record.value : values.get(token);
      if (typeof value !== "string") return undefined;
      parts.push(value);
    }
    return parts.join("");
  };
  const run = (input, conditionalPrefix) => {
    const sequence = statements(input);
    if (!sequence) return false;
    for (const raw of sequence) {
      const row = flat(raw);
      if (!row.length) continue;
      if (row[0] === "param") {
        const variables = row.filter((token) => /^\$[a-z_]\w*$/.test(token) && !["$true", "$false"].includes(token));
        if (parameter || variables.length !== 1) return false;
        parameter = variables[0];
        continue;
      }
      if (row[0] === "function") {
        const open = row.indexOf("{");
        if (open < 0 || row.at(-1) !== "}") return false;
        const name = row[1];
        const parameters = row.slice(2, open).filter((token) => token.startsWith("$"));
        const body = signature(row.slice(open + 1, -1));
        const normalizer = parameters.length === 1 && body === `return ${parameters[0]} . replace ( "\\r\\n" , "\\n" )`;
        const local = row[open + 1];
        const writer = parameters.length === 2 && local?.startsWith("$") && body === `${local} = new-object system . text . utf8encoding ( $false ) [ system . io . file ] : : writealltext ( ${parameters[0]} , ${parameters[1]} , ${local} )`;
        helpers.set(name, helpers.has(name) ? undefined : normalizer ? "normalize" : writer ? "write" : undefined);
        continue;
      }
      if (row[0] === "if") {
        const open = row.indexOf("{");
        if (open < 0 || row.at(-1) !== "}") return false;
        const condition = row.slice(1, open).join(" ");
        if (condition === "( $false )") continue;
        const contains = condition.match(/^\( (\$[a-z_]\w*) \. contains \( (\$[a-z_]\w*) \) \)$/);
        if (contains && typeof values.get(contains[2]) === "string") {
          if (!run(raw.slice(raw.indexOf("{") + 1, -1), { variable: contains[1], prefix: values.get(contains[2]) })) return false;
          continue;
        }
        const checks = statements(raw.slice(raw.indexOf("{") + 1, -1));
        if (checks?.every((line) => ["write-error", "exit"].includes(flat(line)[0]))) continue;
        return false;
      }
      if (["write-host", "write-error"].includes(row[0])) continue;
      if (row[0]?.startsWith("$") && row[1] === "=") {
        const destination = row[0];
        const rhs = row.slice(2);
        const discovery = rhs.join(" ").match(/^get-childitem -path (§\d+) -directory(?: -erroraction silentlycontinue)? \| where-object \{ \$_ \. name -match (§\d+) \} \| select-object -first 1$/);
        if (discovery) {
          const pathToken = strings[Number(discovery[1].slice(1))];
          const path = pathToken.interpolate && pathToken.value.toLowerCase();
          const pattern = strings[Number(discovery[2].slice(1))].value.match(/^\^([A-Za-z0-9_.+-]+)-\[0-9\]$/);
          if (!parameter || path !== `${parameter}/subprojects` || !pattern || discoveryVariable) return false;
          discoveryVariable = destination;
          packageName = pattern[1];
          values.set(destination, { directory: true });
          continue;
        }
        const string = rhs.length === 1 && rhs[0].startsWith("§") ? strings[Number(rhs[0].slice(1))] : undefined;
        const path = string?.interpolate && string.value.match(/^\$\(\$([A-Za-z_]\w*)\.FullName\)\/([^"$\n]+)$/i);
        if (path) {
          if (`$${path[1].toLowerCase()}` !== discoveryVariable || path[2].split("/").some((part) => !part || part === "..")) return false;
          values.set(destination, { path: path[2] });
          continue;
        }
        const read = rhs.join(" ").match(/^([a-z_][\w-]*) \( get-content (\$[a-z_]\w*) -raw \)$/);
        if (read) {
          const target = values.get(read[2]);
          if (helpers.get(read[1]) !== "normalize" || !target?.path) return false;
          values.set(destination, { path: target.path, replacements: writes.get(target.path) || [] });
          continue;
        }
        if (helpers.get(rhs[0]) === "normalize") {
          const text = literal(rhs.slice(1));
          if (text === undefined) return false;
          values.set(destination, text.replaceAll("\r\n", "\n"));
          continue;
        }
        const replacement = rhs.join(" ").match(/^(\$[a-z_]\w*) \. replace \(/);
        if (replacement) {
          const content = values.get(replacement[1]);
          const comma = rhs.indexOf(",");
          if (!content?.replacements || comma < 0 || rhs.at(-1) !== ")") return false;
          const old = literal(rhs.slice(4, comma));
          const next = literal(rhs.slice(comma + 1, -1));
          if (!old || next === undefined || conditionalPrefix && (conditionalPrefix.variable !== destination || !old.startsWith(conditionalPrefix.prefix))) return false;
          values.set(destination, { path: content.path, replacements: [...content.replacements, [old, next]] });
          continue;
        }
        if (conditionalPrefix) return false;
        const text = literal(rhs);
        const alias = rhs.length === 1 ? values.get(rhs[0]) : undefined;
        if (text !== undefined) values.set(destination, text);
        else if (alias !== undefined) values.set(destination, alias);
        else return false;
        continue;
      }
      if (helpers.get(row[0]) === "write" && row.length === 3) {
        const target = values.get(row[1]);
        const content = values.get(row[2]);
        if (!target?.path || content?.path !== target.path || !content.replacements || conditionalPrefix) return false;
        writes.set(target.path, content.replacements);
        continue;
      }
      return false;
    }
    return true;
  };
  if (!run(tokens)) return undefined;
  const output = [...writes].filter(([member, replacements]) => member.endsWith("/meson.build") && replacements.length);
  return packageName && output.length === 1 ? { packageName, member: output[0][0], replacements: output[0][1] } : undefined;
}

const providerCommands = new Set(["add_library", "llvm_add_library", "add_executable", "add_llvm_executable", "add_custom_command", "install", "export", "set_target_properties", "set_property",
  "find_library", "find_path", "find_file", "find_program", "configure_file", "configure_package_config_file",
  "write_basic_package_version_file", "rocm_export_targets"]);

const compilerInvocation = (command) => command.name === "execute_process" && command.args[0] === "COMMAND" &&
  /^\$\{CMAKE_(?:C|CXX)_COMPILER\}$/.test(command.args[1] || "");
const producerControl = new Set(["project", "set", "unset", "if", "elseif", "else", "endif", "return"]);
const opaqueProducerScopes = new Set(["function", "macro", "foreach", "while", "block"]);
const producerCopy = (name, args) => name === "add_custom_command" && args[0] === "OUTPUT" && args.includes("DEPENDS") && args.includes("copy");

// Project-local dataflow for a direct compiler-and-copy pair. An independent
// child's helpers, includes, targets and package exports never enter this view.
function projectProducerCommandsOf(commands) {
  if (!commands.some(compilerInvocation) || !commands.some(({ name, args }) => producerCopy(name, args))) return;
  const projection = [];
  let opaqueDepth = 0;
  let project = false;
  for (const command of commands) {
    const { name, args } = command;
    if (opaqueProducerScopes.has(name)) { opaqueDepth++; continue; }
    if (name.startsWith("end") && opaqueProducerScopes.has(name.slice(3))) { opaqueDepth--; continue; }
    if (opaqueDepth) continue;
    if (name === "project") {
      if (project || args.includes("VERSION")) return;
      project = true;
    }
    if (producerControl.has(name) || compilerInvocation(command) || producerCopy(name, args)) projection.push(command);
  }
  if (project) return projection;
}

function directSourceChild(directory, child) {
  try {
    return !existsSync(join(child, ".git")) && realpathSync(child) === join(realpathSync(directory), basename(child));
  } catch { return false; }
}

function providerSourceRevision(component) {
  const revision = ["source-revision", "archive-revision"].includes(prop(component, "cdx:version:kind"))
    ? component.version : prop(component, "cdx:version:sourceRevision");
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(revision || "") ? revision : undefined;
}

function producerBlobMatches(file, root, expected) {
  const opened = openRegularFile(file, root);
  if (!opened) return false;
  try {
    if (opened.size > MAX_METADATA_BYTES) return false;
    const hash = createHash(expected.length === 40 ? "sha1" : "sha256").update(`blob ${opened.size}\0`);
    const buffer = Buffer.allocUnsafe(Math.min(opened.size, 64 * 1024));
    for (let offset = 0; offset < opened.size;) {
      const size = readSync(opened.fd, buffer, 0, Math.min(buffer.length, opened.size - offset), offset);
      if (size <= 0) return false;
      hash.update(buffer.subarray(0, size));
      offset += size;
    }
    return hash.digest("hex") === expected;
  } catch { return false; } finally { closeSync(opened.fd); }
}

function providerInitialBindings(fact) {
  const name = fact.component.name;
  const version = fact.component.version;
  return [
    ...(fact.variables || []),
    ...(fact.standaloneCmake ? [] : [["PROJECT_NAME", name], ["CMAKE_PROJECT_NAME", name]]),
    ["PROJECT_VERSION", ["source-revision", "archive-revision"].includes(prop(fact.component, "cdx:version:kind")) ? "$<unknown:PROJECT_VERSION>" : version],
    ["PROJECT_SOURCE_DIR", fact.directory], ["CMAKE_SOURCE_DIR", fact.directory], ["PROJECT_BINARY_DIR", fact.directory],
  ];
}

function providerEvaluationSeed(fact) {
  // Looking ahead must not consume a one-shot binding iterable.
  if (fact.variables && !Array.isArray(fact.variables) && !(fact.variables instanceof Map)) return;
  const variables = new Map(providerInitialBindings(fact));
  const active = new Set();
  const encode = (value) => {
    if (value === undefined) return ["undefined"];
    if (value === null) return ["null"];
    const type = typeof value;
    if (["string", "boolean"].includes(type)) return [type, value];
    if (type === "number") return Number.isFinite(value) ? [type, Object.is(value, -0) ? "-0" : value] : undefined;
    if (type !== "object" || active.has(value) ||
      !Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return;
    active.add(value);
    const children = Array.isArray(value) ? value.map(encode) : Object.entries(value).map(([key, entry]) => {
      const encoded = encode(entry);
      return encoded === undefined ? undefined : [key, encoded];
    });
    active.delete(value);
    return children.some((entry) => entry === undefined) ? undefined : [Array.isArray(value) ? "array" : "object", children];
  };
  // Key only evaluator inputs, never occurrence identity or provenance.
  // Typed ordered bindings retain present-undefined and insertion order.
  const encoded = encode([fact.directory, fact.scopeDirectory || fact.directory, fact.contractFiles,
    fact.component.name, fact.component.version, prop(fact.component, "cdx:version:kind"), providerSourceRevision(fact.component), [...variables]]);
  return encoded === undefined ? undefined : { key: JSON.stringify(encoded), variables };
}

// Evaluator-local snapshots share bindings until a write. This is deliberately
// not a general Map: callers only iterate stable snapshots or delete the current
// key, and no environment escapes provider collection.
class ProviderEnvironment {
  #values;
  #shared = false;
  #undefinedCount = 0;
  #readObservers;
  constructor(values) {
    if (values instanceof ProviderEnvironment) {
      this.#values = values.#values;
      this.#undefinedCount = values.#undefinedCount;
      this.#shared = values.#shared = true;
      this.#readObservers = values.#readObservers;
    } else {
      this.#values = new Map(values);
      for (const value of this.#values.values()) if (value === undefined) this.#undefinedCount++;
    }
  }
  // Snapshots can restore an inherited binding after a branch-local write.
  // Observe its provenance by value/presence, not a monotonically growing
  // "written keys" set, which would miss that restored caller dependency.
  #observe(key) {
    const observers = this.#readObservers;
    if (!observers) return;
    const latest = observers[observers.length - 1];
    // Every frame in this list belongs to the same effect epoch. Once an
    // observed effect rejects those invocations, their reads cannot contribute
    // to any stored summary, including through restored branch snapshots.
    if (latest.revision !== latest.state.revision) { this.#readObservers = undefined; return; }
    for (const observer of observers) {
      if (!observer.inputs.has(key) && this.#values.get(key) === observer.initial.get(key) &&
        this.#values.has(key) === observer.initial.has(key)) {
        observer.inputs.set(key, { key, value: observer.initial.get(key), present: observer.initial.has(key) });
      }
    }
  }
  observeReads(inputs, state) {
    // Retain the initial snapshot only during evaluation. Stored summaries
    // contain the projected input records, never this complete environment.
    this.#shared = true;
    const observers = this.#readObservers;
    const latest = observers?.[observers.length - 1];
    // A fresh pure child remains cacheable after an enclosing invocation has
    // become effectful, but must not inherit that invocation's dead observers.
    this.#readObservers = [...(latest?.state === state && latest.revision === state.revision ? observers : []),
      { initial: this.#values, inputs, state, revision: state.revision }];
  }
  matchesInputs(inputs) {
    return inputs.every((input) => this.#values.has(input.key) === input.present && this.#values.get(input.key) === input.value);
  }
  observeInputs(inputs) {
    for (const input of inputs) this.#observe(input.key);
  }
  get(key) { this.#observe(key); return this.#values.get(key); }
  has(key) { this.#observe(key); return this.#values.has(key); }
  // Join bookkeeping is not a source read. Unchanged bindings are observed
  // only if subsequent source evaluation actually consumes them.
  hasBinding(key) { return this.#values.has(key); }
  mergeUnchangedBinding(key, outcomes) {
    const value = this.#values.get(key);
    const present = this.#values.has(key);
    for (const outcome of outcomes) {
      if (outcome.#values.get(key) !== value || outcome.#values.has(key) !== present) return false;
    }
    if (value === undefined) {
      // Cleanup itself depends on the input being undefined. Keep that read:
      // a later invocation with a defined value must not reuse this outcome.
      this.#observe(key);
      this.delete(key);
    }
    return true;
  }
  keys() { return this.#values.keys(); }
  [Symbol.iterator]() { return this.#values[Symbol.iterator](); }
  sharesBindings(other) { return this.#values === other.#values; }
  removeUndefined() {
    if (!this.#undefinedCount) return;
    for (const key of this.#values.keys()) if (this.#values.get(key) === undefined) this.delete(key);
  }
  set(key, value) {
    if (this.#values.has(key) && this.#values.get(key) === value) return this;
    if (this.#shared) { this.#values = new Map(this.#values); this.#shared = false; }
    if (this.#values.has(key) && this.#values.get(key) === undefined) this.#undefinedCount--;
    if (value === undefined) this.#undefinedCount++;
    this.#values.set(key, value);
    return this;
  }
  delete(key) {
    if (!this.#values.has(key)) return false;
    if (this.#shared) { this.#values = new Map(this.#values); this.#shared = false; }
    if (this.#values.get(key) === undefined) this.#undefinedCount--;
    return this.#values.delete(key);
  }
  restore(snapshot) {
    this.#values = snapshot.#values;
    this.#undefinedCount = snapshot.#undefinedCount;
    this.#shared = snapshot.#shared = true;
  }
}

function providerCondition(args, env, raw = args, quoted = [], standaloneCmake = false) {
  const atOr = args.indexOf("OR");
  const atAnd = args.indexOf("AND");
  const at = atOr > 0 ? atOr : atAnd;
  if (at > 0) {
    const first = providerCondition(args.slice(0, at), env, raw.slice(0, at), quoted.slice(0, at), standaloneCmake);
    const second = providerCondition(args.slice(at + 1), env, raw.slice(at + 1), quoted.slice(at + 1), standaloneCmake);
    return args[at] === "AND" ? first === false || second === false ? false : first === true && second === true ? true : undefined :
      first === true || second === true ? true : first === false && second === false ? false : undefined;
  }
  if (args[0] === "NOT") { const value = providerCondition(args.slice(1), env, raw.slice(1), quoted.slice(1), standaloneCmake); return value === undefined ? undefined : !value; }
  const value = (at) => quoted[at] ? args[at] : env.get(args[at]) ?? args[at];
  if (args.length === 1) {
    if (/^[+-]?\d+$/.test(args[0])) return Number(args[0]) !== 0;
    const text = value(0)?.toUpperCase();
    if (["FALSE", "OFF", "NO", "0", "", "NOTFOUND"].includes(text) || text?.endsWith("-NOTFOUND")) return false;
    if (["TRUE", "ON", "YES", "1"].includes(text)) return true;
    if (!quoted[0] && env.has(args[0]) && text !== undefined && !text.includes("$")) return true;
  }
  if (args.length === 3 && ["STREQUAL", "MATCHES"].includes(args[1])) {
    const operand = (at) => {
      const patternOperand = args[1] === "MATCHES" && at === 2;
      const text = patternOperand ? args[at] : value(at);
      const rawArg = raw[at] ?? args[at];
      const bound = env.get(rawArg);
      const literal = quoted[at] || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(text) || /^(?:TRUE|FALSE|ON|OFF)$/i.test(text);
      const unresolved = args[1] === "MATCHES" && at === 2 ? /\$(?:\{|<|ENV\{|CACHE\{)/.test(text) : text.includes("$");
      return { text, known: !unresolved && (patternOperand || bound !== undefined || rawArg.includes("${") || literal) };
    };
    const first = operand(0);
    const second = operand(2);
    if (first.known && second.known) {
      if (args[1] === "STREQUAL") return first.text === second.text;
      const pattern = providerInstallPattern(second.text, true);
      if (pattern !== undefined) return providerGlobMatches(first.text, pattern);
    }
  }
  if (args.length === 3 && ["GREATER", "LESS", "EQUAL", "GREATER_EQUAL", "LESS_EQUAL"].includes(args[1]) &&
    /^-?\d+$/.test(value(0)) && /^-?\d+$/.test(value(2))) {
    const first = Number(value(0));
    const second = Number(value(2));
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(second)) return undefined;
    return args[1] === "GREATER" ? first > second : args[1] === "LESS" ? first < second :
      args[1] === "EQUAL" ? first === second : args[1] === "GREATER_EQUAL" ? first >= second : first <= second;
  }
  if (args.length === 3 && args[1] === "IN_LIST") {
    const item = value(0);
    const list = env.get(args[2]);
    const knownItem = quoted[0] || env.has(args[0]) || raw[0]?.includes("${") ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(item);
    if (knownItem && typeof list === "string" && !/[$\\[\]]/.test(list) && !item.includes("$")) {
      return list !== "" && list.split(";").includes(item);
    }
  }
  if (args[0] === "DEFINED" && typeof env.get(args[1]) === "string") return !env.get(args[1]).includes("$");
  if (standaloneCmake && args.length === 2 && args[0] === "DEFINED" &&
    ["PROJECT_NAME", "CMAKE_PROJECT_NAME"].includes(args[1]) && !env.has(args[1])) return false;
}

// A template has no call-site variables. Only literal conditions can rule
// out a lexical arm here; an invoked helper uses the normal evaluator.
function* reachableTemplateProgramLookups(body, scoped = false) {
  const branches = [];
  const variables = new Map();
  let nested = 0;
  let loopDepth = 0;
  const returnFromArm = () => {
    const arm = branches.at(-1);
    if (arm) arm.returned = true;
    return !arm;
  };
  for (const command of body) {
    const { name, args } = command;
    if (name === "function" || name === "macro") { nested++; continue; }
    if (name === "endfunction" || name === "endmacro") { nested--; continue; }
    if (nested) continue;
    // Only the scoped proof path needs conservative template control flow.
    if (scoped) {
      if (name === "foreach" || name === "while") { loopDepth++; continue; }
      if (name === "endforeach" || name === "endwhile") { loopDepth--; continue; }
      // A lexical helper can still continue after a zero-trip loop.
      if (loopDepth) continue;
    }
    if (name === "if") {
      const state = providerCondition(args, variables, args, command.quotedArguments);
      branches.push({ dead: state === false, exhausted: state === true });
    } else if (name === "elseif" || name === "else") {
      const branch = branches.at(-1);
      if (!branch) return;
      if (scoped) branch.fallthrough ||= !branch.dead && !branch.returned;
      const state = branch.exhausted ? false : name === "else" ? true : providerCondition(args, variables, args, command.quotedArguments);
      branch.dead = state === false;
      if (scoped) branch.returned = false;
      branch.exhausted ||= state === true;
    } else if (name === "endif") {
      const branch = branches.pop();
      if (scoped && branch?.exhausted && !branch.fallthrough && (branch.dead || branch.returned) && returnFromArm()) return;
    } else if (!branches.some((branch) => branch.dead || scoped && branch.returned)) {
      if (scoped && name === "return" && returnFromArm()) return;
      if (name === "find_program" && (args.includes("PATHS") || scoped && args.includes("HINTS"))) yield command;
    }
  }
}

function scopedProgramPaths(args, scanRoot) {
  const roots = new Set();
  const suffixes = new Set();
  let field;
  for (const arg of args.slice(1)) {
    if (["HINTS", "PATHS", "PATH_SUFFIXES"].includes(arg)) field = arg;
    else if (programSearchControls.test(arg) || libraryFindControls.has(arg)) field = undefined;
    else if (field === "PATH_SUFFIXES") {
      if (safeMember(arg)) suffixes.add(arg);
    } else if (field && isAbsolute(arg) && !/[$;\0[\]]/.test(arg) && inside(scanRoot, arg)) roots.add(resolve(arg));
    if (roots.size > 16 || suffixes.size > 8) return [];
  }
  return [...roots].flatMap((root) => [root, ...Array.from(suffixes, (suffix) => join(root, suffix))]);
}

const scopedLookupProjection = new Set(["function", "endfunction", "macro", "endmacro", "if", "elseif", "else", "endif",
  "foreach", "endforeach", "while", "endwhile", "block", "endblock", "get_filename_component", "list", "set", "unset", "return", "find_program"]);
const sameProgramInputs = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);

function stableTemplateProgramBindings(lookup, body, parameters) {
  const names = new Set(lookup.args.flatMap((arg) => Array.from(arg.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g), (match) => match[1])));
  if (!names.size) return true;
  if (parameters.some((name) => names.has(name)) ||
    [...names].some((name) => /^(?:ARGC|ARGN|ARGV\d*|CMAKE_CURRENT_LIST_DIR)$/.test(name))) return false;
  for (const command of body) {
    if (command === lookup) break;
    // A template uses definition-site source bindings only if the body
    // does not replace those bindings before this lookup.
    if (!scopedLookupProjection.has(command.name) && !["string", "cmake_parse_arguments", "message"].includes(command.name)) return false;
    if (["set", "unset", "get_filename_component", "foreach"].includes(command.name) &&
      (names.has(command.args[0]) || command.args[0]?.includes("$"))) return false;
    if (["list", "string", "cmake_parse_arguments"].includes(command.name) &&
      command.args.some((arg) => names.has(arg) || command.name === "cmake_parse_arguments" &&
        [...names].some((name) => name.startsWith(`${arg}_`)))) return false;
  }
  return true;
}

function providerPcVersion(text, variables, cmakeDollars = false) {
  const configured = text.replace(/@([A-Za-z_][A-Za-z0-9_]*)@/g, (_match, name) => variables.get(name) ?? `$<unknown:${name}>`);
  const source = cmakeDollars ? expandCmakeVariables(configured, variables) : configured;
  const fields = new Map();
  for (const line of source.split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (field) fields.set(field[1], field[2]);
  }
  let version = source.match(/^Version:\s*(\S+)\s*$/m)?.[1];
  if (!version) return undefined;
  for (let round = 0; round < 16 && version.includes("${"); round++) {
    const next = version.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => fields.get(name) ?? `$<unknown:${name}>`);
    if (next === version) break;
    version = next;
  }
  return /^\d+(?:\.\d+)*(?:[A-Za-z][0-9A-Za-z.+_~-]*|[-+_~][0-9A-Za-z.+_~-]+)?$/.test(version) ? version : undefined;
}

// Every helper registration/redefinition invalidates cached slices, including
// same-sized definition graphs. Keep the owner/context identity as well as its
// mutation revision; inspecting a slice must not snapshot the entire graph.
class ProviderDefinitions extends Map {
  revision = 0;
  set(name, definition) {
    if (!this.has(name) || this.get(name) !== definition) {
      super.set(name, definition);
      this.revision++;
    }
    return this;
  }
  delete(name) {
    const removed = super.delete(name);
    if (removed) this.revision++;
    return removed;
  }
  clear() {
    if (this.size) {
      super.clear();
      this.revision++;
    }
  }
}

function providerDefinitionsMatch(snapshot, definitions) {
  return snapshot?.definitions === definitions && snapshot.revision === definitions.revision;
}

/** Backward metadata slice of an invoked helper, not a general CMake runtime.
 * Source lists, compiler checks and target options cannot create exports and
 * must not consume the entire owner's target-discovery budget. */
function providerHelperSlice(definition, definitions, store = true) {
  if (definition.providerSlice && providerDefinitionsMatch(definition.providerDefinitions, definitions)) return definition.providerSlice;
  const reachesExport = (candidate, seen = new Set()) => {
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    return candidate.body.some((command) => providerCommands.has(command.name) || command.name === "return" || command.name === "cmake_language" && command.args[0] === "CALL" || ["set", "unset"].includes(command.name) && command.args.includes("PARENT_SCOPE") ||
      definitions.has(command.name) && reachesExport(definitions.get(command.name), seen));
  };
  const selected = new Set();
  const needed = new Set();
  const needArgs = (args) => { for (const arg of args) for (const match of arg.matchAll(/\$\{([^{}]+)\}/g)) needed.add(match[1]); };
  const needCondition = (args) => {
    needArgs(args);
    for (const arg of args) if (identity(arg)) needed.add(arg);
  };
  for (const [index, command] of definition.body.entries()) {
    if (providerCommands.has(command.name) || command.name === "return" || command.name === "cmake_language" && command.args[0] === "CALL" || ["set", "unset"].includes(command.name) && command.args.includes("PARENT_SCOPE") ||
      definitions.has(command.name) && reachesExport(definitions.get(command.name))) {
      selected.add(index);
      // A target's implementation source list does not name its export.
      needArgs(command.name === "add_library" || command.name === "add_executable" ? command.args.slice(0, 3) : command.args);
      if (command.name === "return" && command.args[0] === "PROPAGATE") {
        for (const name of command.args.slice(1)) if (identity(name)) needed.add(name);
      }
    }
  }
  for (let round = 0; round < 16; round++) {
    const before = selected.size + needed.size;
    for (const [index, command] of definition.body.entries()) {
      const output = command.name === "set" || command.name === "unset" ||
        command.name === "get_filename_component" && definition.scopedPathDataflow ? command.args[0] :
        command.name === "string" ? ["TOLOWER", "TOUPPER", "STRIP"].includes(command.args[0]) ? command.args[2] :
          command.args[0] === "REGEX" ? command.args[command.args[1] === "REPLACE" ? 4 : 3] : command.args[0] === "FIND" ? command.args[3] : undefined :
          command.name === "list" ? command.args[0] === "LENGTH" ? command.args[2] : command.args[0] === "GET" ? command.args.at(-1) :
            ["APPEND", "PREPEND", "INSERT", "REMOVE_AT", "REMOVE_ITEM", "REMOVE_DUPLICATES"].includes(command.args[0]) ? command.args[1] : undefined : undefined;
      if (output && needed.has(output) || command.name === "cmake_parse_arguments" && [...needed].some((name) => name.startsWith(`${command.args[0]}_`))) {
        selected.add(index);
        needArgs(command.args);
        if (command.name === "list" && ["GET", "LENGTH"].includes(command.args[0])) needed.add(command.args[1]);
      }
    }
    const stack = [];
    for (const [index, command] of definition.body.entries()) {
      if (["if", "foreach", "while", "block"].includes(command.name)) stack.push({ index, selected: false });
      if (selected.has(index)) for (const block of stack) block.selected = true;
      if (["else", "elseif"].includes(command.name) && stack.length) stack.at(-1).branches ||= [];
      if (["else", "elseif"].includes(command.name) && stack.length) stack.at(-1).branches.push(index);
      if (["endif", "endforeach", "endwhile", "endblock"].includes(command.name)) {
        const block = stack.pop();
        if (!block?.selected) continue;
        selected.add(block.index); selected.add(index);
        for (const branch of block.branches || []) {
          selected.add(branch);
          if (definition.body[branch].name === "elseif") needCondition(definition.body[branch].args);
        }
        const opener = definition.body[block.index];
        needCondition(opener.args);
        if (opener.name === "foreach" && opener.args[1] === "IN" && opener.args[2] === "LISTS") for (const arg of opener.args.slice(3)) needed.add(arg);
      }
    }
    if (before === selected.size + needed.size) break;
  }
  const slice = definition.body.filter((_command, index) => selected.has(index));
  if (store) {
    definition.providerSlice = slice;
    definition.providerDefinitions = { definitions, revision: definitions.revision };
  }
  return slice;
}

// Classify the existing metadata slice, not arbitrary source commands. A
// non-target set_property is a no-op in this reader; treating it as an export
// can otherwise keep an exponentially recursive, effect-free helper graph alive.
// Do not warm transitive slice caches while inspecting unexecuted helper paths.
function providerHelperHasEffects(definition, definitions, seen = new Set()) {
  if (seen.has(definition)) return false;
  seen.add(definition);
  const slice = providerHelperSlice(definition, definitions, false);
  if (slice.length > 20000) return true; // Preserve local budget diagnostics.
  let branches = 0;
  for (const command of slice) {
    const name = command.name;
    if (name === "if") branches++;
    if (name === "endif" && --branches < 0) return true;
    if (["else", "elseif"].includes(name) && !branches) return true;
    if (name === "set_property") {
      if (command.args[0] === "TARGET" || command.args[0]?.includes("$")) return true;
      continue;
    }
    if (providerCommands.has(name) || name === "return" || name === "cmake_language" && command.args[0] === "CALL" || ["set", "unset"].includes(name) && command.args.includes("PARENT_SCOPE") ||
      ["project", "include", "add_subdirectory", "function", "macro", "endfunction", "endmacro"].includes(name)) return true;
    const called = definitions.get(name);
    if (called && providerHelperHasEffects(called, definitions, seen)) return true;
  }
  return branches !== 0;
}

function validOwnerEffect(result) {
  const object = (value) => value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
  const text = (value) => typeof value === "string";
  const items = (value, test) => Array.isArray(value) && value.every(test);
  const strings = (value) => items(value, text);
  const fields = (row, keys) => object(row) && keys.every((key) => text(row[key]));
  const pair = (row, right) => Array.isArray(row) && row.length === 2 && text(row[0]) && right(row[1]);
  if (!object(result) || !Number.isSafeInteger(result.commandCount) || result.commandCount < 100000 ||
    !Number.isSafeInteger(result.fileCount) || result.fileCount < 0 || !object(result.effects)) return false;
  const effects = result.effects;
  return items(result.exports, (row) => fields(row, ["kind", "name", "source", "ownerDir"]) && strings(row.conditions) && typeof row.global === "boolean") &&
    items(result.projectDeclarations, (row) => fields(row, ["name", "source"]) && strings(row.conditions)) &&
    items(effects.findDefinitions, (row) => pair(row, text)) &&
    items(effects.findContracts, (row) => pair(row, (contract) => fields(contract, ["source"]) && strings(contract.required) &&
      items(contract.checks, (check) => fields(check, ["command", "variable"])) && strings(contract.versionVariables))) &&
    items(effects.findModules, (row) => fields(row, ["name", "source", "moduleFile", "directory", "destination"]) && row.builtinModule === undefined &&
      strings(row.conditions) && strings(row.libraries) && ["headers", "programs", "pkgConfig", "dataFiles"].every((key) => row[key] === undefined || strings(row[key]))) &&
    items(effects.compilerChecks, (row) => fields(row, ["name", "source", "directory"]) && strings(row.capabilities)) &&
    items(effects.wraps, (row) => fields(row, ["directory", "ownerDirectory", "file"]) && items(row.aliases, (alias) => fields(alias, ["name", "source"]))) &&
    items(effects.diagnostics, (row) => fields(row, ["directory", "reason"]));
}

/** Source facts must identify a versioned owner, not a dependency with a similar
 * name. Files are read at most once per collection; no requirement traverses a
 * source tree. Export entries retain their exact declaration span and owner. */
export function collectNativeProviders(sourceFacts, resolutionInputs = {}) {
  const scanRoot = resolve(resolutionInputs.scanRoot || ".");
  const owners = sourceFacts.filter((fact) => fact.component?.version && fact.component?.["bom-ref"] && fact.directory)
    .map((fact) => ({ ...fact, directory: resolve(fact.directory) })).filter((fact) => inside(scanRoot, fact.directory));
  const ownerDirs = new Set(owners.filter((fact) => !Array.isArray(fact.declaredExports)).map((fact) => fact.directory));
  const ownerScopes = new Map();
  for (const fact of owners) {
    const scope = fact.scopeDirectory || fact.directory;
    const previous = ownerScopes.get(fact.directory);
    ownerScopes.set(fact.directory, previous === undefined || previous === scope ? scope : null);
  }
  const independentDirectories = new Set(owners.map((fact) => fact.directory));
  let independentRevision = 0;
  const markIndependent = (directory) => {
    if (!independentDirectories.has(directory)) {
      independentDirectories.add(directory);
      independentRevision++;
    }
  };
  const files = new Map();
  let ownerReads;
  const listOwnerDirectory = (path) => {
    let entries;
    try { entries = readdirSync(path, { withFileTypes: true }); }
    catch (error) { ownerReads?.directory(path, undefined, error); throw error; }
    ownerReads?.directory(path, entries);
    return entries;
  };
  const builtinContexts = [];
  for (const component of resolutionInputs.availableProviders || []) {
    const observed = nativeObservedProviderEvidence(component);
    if (!observed || observed.version !== component.version || (observed.packageName || observed.name) !== component.name ||
      JSON.stringify(observed) !== prop(component, "cdx:native:providerEvidence")) continue;
    let exported;
    try { exported = JSON.parse(prop(component, "cdx:native:providerExports")); } catch { continue; }
    if (!Array.isArray(exported)) continue;
    const contractFiles = [];
    for (const entry of observed.exports || []) {
      if (entry.kind !== "capability" || entry.name !== "cmake-find-module" || !identity(entry.moduleName) ||
        typeof entry.root !== "string" || typeof entry.file !== "string" || inside(scanRoot, entry.root) ||
        resolve(entry.file) !== join(resolve(entry.root), "Modules", `Find${entry.moduleName}.cmake`) ||
        entry.toolPath !== observed.path || entry.toolReportSha256 !== observed.toolReport?.sha256 ||
        entry.toolReportScriptSha256 !== observed.toolReport?.scriptSha256 ||
        observed.toolReport?.root !== entry.root || observed.toolReport?.version !== observed.version ||
        !/^[a-f0-9]{64}$/.test(entry.sha256 || "") ||
        !exported.some((candidate) => JSON.stringify(candidate) === JSON.stringify(entry))) continue;
      const text = readRegularTextFile(entry.file, MAX_METADATA_BYTES, entry.root);
      if (text === undefined || createHash("sha256").update(text).digest("hex") !== entry.sha256) continue;
      files.set(entry.file, text);
      contractFiles.push({ ...entry });
    }
    if (contractFiles.length) builtinContexts.push({ directory: scanRoot, component, contractFiles,
      contextKey: `observed-cmake-contract:${component["bom-ref"]}:${observed.toolReport.sha256}` });
  }
  const metadata = (file) => {
    file = resolve(file);
    if (!files.has(file)) files.set(file, resolutionInputs.sourceTexts?.has(file) ? resolutionInputs.sourceTexts.get(file) :
      resolutionInputs.sourceTextsOnly ? undefined : readRegularTextFile(file, MAX_METADATA_BYTES, scanRoot));
    const text = files.get(file);
    ownerReads?.capture("text", file, text);
    return text;
  };
  const commandCache = new Map();
  const producerProjections = new Map();
  const producerRevisions = new Map();
  const revisionOfProducerFile = (file) => {
    if (!producerRevisions.has(file)) producerRevisions.set(file, sourceRevisionOf(file));
    return producerRevisions.get(file);
  };
  const producerMembers = new Map();
  const memberAtRevision = (file, revision) => {
    const member = relative(revision.root, file).split("\\").join("/");
    const id = JSON.stringify([revision.root, revision.version, member]);
    if (!producerMembers.has(id)) {
      const tree = execGitMetadata(revision.root, ["--literal-pathspecs", "ls-tree", "-z", revision.version, "--", member]);
      const output = tree.stdout?.toString() || "";
      const blob = tree.status === 0 && /^(100(?:644|755)) blob ([a-f0-9]{40}|[a-f0-9]{64})\t/.exec(output);
      // Compare bounded raw bytes, not a clean-filter or an index/stat shortcut.
      producerMembers.set(id, blob && output.slice(blob[0].length) === `${member}\0` &&
        producerBlobMatches(file, revision.root, blob[2]) ? blob[1] : undefined);
    }
    return producerMembers.get(id);
  };
  const scopedLookups = resolutionInputs.scopedProgramLookups;
  const scopedFilesByOwner = new Map();
  const crossScopeTargets = new Map();
  for (const file of scopedLookups?.keys() || []) {
    if (!inside(scanRoot, file)) continue;
    let foundOwner = false;
    for (let parent = dirname(file); inside(scanRoot, parent); parent = dirname(parent)) {
      if (ownerDirs.has(parent)) {
        if (foundOwner) {
          if (!Array.isArray(resolutionInputs.nativeSourceManifests)) break;
          if (!crossScopeTargets.has(parent)) crossScopeTargets.set(parent, new Set());
          crossScopeTargets.get(parent).add(file);
        } else {
          foundOwner = true;
          if (!scopedFilesByOwner.has(parent)) scopedFilesByOwner.set(parent, []);
          scopedFilesByOwner.get(parent).push(file);
        }
      }
      if (parent === scanRoot || parent === dirname(parent)) break;
    }
  }
  const scopedCandidates = new Map();
  const scopedProjectOwners = new Map();
  const recordScopedPrograms = (file, command, args, guards, invocations, definition, crossOwner = false) => {
    const records = scopedLookups?.get(file)?.get(command.line);
    if (!records) return;
    ownerReads?.block("scoped-program-lookup");
    const roots = scopedProgramPaths(args, scanRoot);
    if (!roots.length) return;
    const names = libraryRequestNames({ command: "find_program",
      requestedName: args.includes("NAMES") || args.includes("NAME") ? undefined : args[1], arguments: args }).filter(safeMember);
    if (!names.length || names.length > 8) return;
    const source = `${file}:${command.line}`;
    const includeInputs = crossOwner ? guards.filter((condition) => condition.startsWith("include("))
      .map((condition) => condition.slice(8, -1).replace(/:\d+$/, "")) : undefined;
    if (crossOwner && !includeInputs.length) return;
    for (const record of records) {
      const raw = record.declaredArguments || record.arguments;
      const calls = record.helperInvocations || [];
      if (!Array.isArray(record.arguments) || definition !== undefined && record.definition !== definition ||
        !Array.isArray(raw) || !sameProgramInputs(raw, command.args) || !sameProgramInputs(calls, invocations)) continue;
      // A lexical source declaration can still contain symbolic paths. A
      // captured call or a concretely evaluated variant must agree exactly.
      if (!sameProgramInputs(record.arguments, args) && (calls.length || !sameProgramInputs(record.arguments, raw))) continue;
      // Only a path named by the lookup is a possible source export. This
      // is not a statement that CMake used it ahead of environment/PATH.
      for (const member of names) for (const root of roots) {
        const path = resolve(root, member);
        const conditions = [...new Set([...(record.conditions || []), ...guards])];
        const candidate = { member, path, source, file, conditions, arguments: record.arguments, invocations: calls, includeInputs };
        // Repeated includes of an identical helper in the same guarded
        // source context do not create distinct executable proofs.
        const id = JSON.stringify([member, path, source, conditions.filter((condition) => !condition.startsWith("include(")), record.arguments, calls, includeInputs]);
        if (!scopedCandidates.has(id)) scopedCandidates.set(id, candidate);
      }
    }
  };
  const commandsOf = (file) => {
    if (!commandCache.has(file)) commandCache.set(file, parseCmakeCommands(metadata(file)));
    else if (ownerReads) {
      const path = resolve(file);
      ownerReads.capture("text", path, files.get(path));
    }
    return commandCache.get(file);
  };
  const manifests = Array.isArray(resolutionInputs.nativeSourceManifests) ?
    [...new Set(resolutionInputs.nativeSourceManifests.map((file) => resolve(scanRoot, file)).filter((file) => inside(scanRoot, file)))] : undefined;
  const scopedIncludesByOwner = new Map();
  if (manifests && crossScopeTargets.size && !resolutionInputs.sourceTextsOnly) {
    const indexed = new Set(manifests);
    for (const [directory, targets] of crossScopeTargets) {
      const reached = new Set();
      const visited = new Set();
      let commandBudget = 4096;
      const follow = (file, depth) => {
        if (!indexed.has(file)) return;
        if (targets.has(file)) reached.add(file);
        if (reached.size === targets.size || depth >= 8 || visited.size >= 32 || visited.has(file)) return;
        visited.add(file);
        for (const { name, args } of commandsOf(file)) {
          if (reached.size === targets.size || commandBudget-- <= 0) return;
          if (name !== "include" || !args[0]?.endsWith(".cmake")) continue;
          const declared = args[0];
          const prefix = "${CMAKE_CURRENT_LIST_DIR}/";
          const fromList = declared.startsWith(prefix);
          const token = fromList ? declared.slice(prefix.length) : declared;
          if (/[$;\0\\]/.test(token)) continue;
          const next = resolve(dirname(file), token);
          // This only activates path dataflow. Actual include resolution,
          // call reachability and guards remain authoritative.
          const child = indexed.has(next) || fromList ? next : resolve(directory, token);
          if (inside(directory, child)) follow(child, depth + 1);
        }
      };
      follow(join(directory, "CMakeLists.txt"), 0);
      if (reached.size) scopedIncludesByOwner.set(directory, reached);
    }
  }
  const modulesByName = new Map();
  const manifestsByOwner = new Map();
  // Find modules describe the consumer, not the software provider. Record
  // their lexical project even when that project has no own version.
  const localHeaderModules = new Map();
  const localFindDefinitions = new Map();
  let evaluationWrites;
  const rememberFindDefinition = (name, directory) => {
    const module = name.toLowerCase();
    if (!localFindDefinitions.has(module)) localFindDefinitions.set(module, new Set());
    localFindDefinitions.get(module).add(directory);
    evaluationWrites?.findDefinitions.push([module, directory]);
  };
  if (manifests) {
    const boundaries = new Set(ownerDirs);
    for (const file of manifests) {
      if (basename(file) === "CMakeLists.txt" && commandsOf(file).some((command) => command.name === "project")) boundaries.add(dirname(file));
      if (basename(file) === "meson.build" && /^\s*project\s*\(/m.test(metadata(file) || "")) boundaries.add(dirname(file));
      if (file.endsWith(".cmake")) {
        const name = basename(file);
        if (!modulesByName.has(name)) modulesByName.set(name, []);
        modulesByName.get(name).push(file);
      }
    }
    const orderedBoundaries = [...boundaries].sort((a, b) => b.length - a.length);
    const boundaryKey = process.platform === "win32" ? (path) => path.toLowerCase() : (path) => path;
    const boundaryByPath = new Map();
    for (const directory of orderedBoundaries) {
      const key = boundaryKey(directory);
      if (!boundaryByPath.has(key)) boundaryByPath.set(key, directory);
    }
    const nearestBoundary = (file) => {
      const visited = [];
      let path = file;
      let owner;
      for (;;) {
        const key = boundaryKey(path);
        if (boundaryByPath.has(key)) { owner = boundaryByPath.get(key); break; }
        visited.push(key);
        const parent = dirname(path);
        if (parent === path) break;
        path = parent;
      }
      for (const key of visited) boundaryByPath.set(key, owner);
      return owner;
    };
    for (const directory of boundaries) markIndependent(directory);
    for (const file of manifests) {
      const owner = nearestBoundary(file);
      const module = basename(file).match(/^Find(.+)\.cmake$/);
      if (module) rememberFindDefinition(module[1], owner || scanRoot);
      if (module && owner) localHeaderModules.set(file, { name: module[1], directory: owner });
      if (!owner || !ownerDirs.has(owner)) continue;
      if (!manifestsByOwner.has(owner)) manifestsByOwner.set(owner, []);
      manifestsByOwner.get(owner).push(file);
    }
  }
  const findModules = [];
  const findContracts = new Map();
  const compilerChecks = [];
  const wraps = [];
  const stagedTransforms = [];
  const stagedKeys = new Set();
  const providers = [];
  const registerProvider = (provider) => {
    providers.push(provider);
    for (const entry of provider.exports) {
      const exportKey = key(entry.kind, entry.name);
      if (!byExport.has(exportKey)) byExport.set(exportKey, []);
      byExport.get(exportKey).push({ provider, export: entry });
    }
  };
  const byExport = new Map();
  const diagnostics = [];
  const byDirectory = new Map();
  // Language declarations are supplied by the confined source-manifest
  // reader, not by external provider properties. They do not re-evaluate a
  // CMake project or borrow that project's version in the same directory.
  for (const { component, directory, conditions, declaredExports } of owners) {
    if (!Array.isArray(declaredExports)) continue;
    const exports = [];
    for (const entry of declaredExports) {
      if (!(entry.kind === "tool" ? safeMember(entry.name) : entry.kind === "target" && identity(entry.name)) ||
        typeof entry.source !== "string" || !inside(directory, resolve(directory, entry.source.replace(/:\d+$/, ""))) ||
        !compatibleOwnerConditions(conditions, entry.conditions)) continue;
      exports.push({ ...entry, ownerDir: directory, global: entry.kind === "tool" && entry.global !== false,
        conditions: entry.conditions || [], ...(entry.kind === "tool" ? { executableUnknown: true, interfaceVersionUnknown: true } : {}) });
    }
    if (!exports.length) continue;
    registerProvider({ ref: component["bom-ref"], component, packageIdentity: component.purl || component["bom-ref"], version: component.version,
      versionKind: prop(component, "cdx:version:kind") || "release", sourceIdentity: prop(component, "cdx:source:identity") || directory,
      directory, exports, conditions: conditions || [], provenance: exports.map((entry) => entry.source) });
  }
  for (const fact of [...owners, ...builtinContexts]) {
    if (Array.isArray(fact.declaredExports)) continue;
    const context = JSON.stringify([fact.directory, fact.contextKey || ""]);
    if (!byDirectory.has(context)) byDirectory.set(context, []);
    byDirectory.get(context).push(fact);
  }
  // Reuse is local to this collection and only retained for future exact
  // inputs. Keep original context/fact order; this is not owner deduplication.
  const evaluationSeeds = new Map();
  const evaluationUses = new Map();
  const evaluationResults = new Map();
  const capability = resolutionInputs.nativeOwnerEvaluationCache;
  const persistent = capability?.store && typeof capability.semantics === "string" && capability.semantics &&
    resolutionInputs.nativeProviderContextReuse !== false && manifests && !resolutionInputs.sourceTextsOnly &&
    canonicalOwnerScanRoot(scanRoot) ? capability : undefined;
  const storeConfig = persistent && nativeOwnerDigest([persistent.semantics, scanRoot, process.cwd(), process.platform,
    process.arch, process.versions, manifests, ownerDirs, ownerScopes, modulesByName, resolutionInputs.localProgramLookups]);
  let stateRevision = -1;
  let stateDigest;
  let persistentAttempts = 0;
  const persistentDecision = (directory, decision, reason, commands) => {
    persistent.onDecision?.({ directory, decision, reason, commands });
  };
  if (resolutionInputs.nativeProviderContextReuse !== false) {
    const directoryUses = new Map();
    for (const facts of byDirectory.values()) directoryUses.set(facts[0].directory, (directoryUses.get(facts[0].directory) || 0) + 1);
    for (const facts of byDirectory.values()) {
      const directory = facts[0].directory;
      // Scoped lookups can reuse an evaluation only after a run that
      // adds no scoped candidates. Their collector-wide set is append-only.
      if (directoryUses.get(directory) < 2) continue;
      const seed = providerEvaluationSeed(facts[0]);
      if (!seed) continue;
      evaluationSeeds.set(facts, seed);
      evaluationUses.set(seed.key, (evaluationUses.get(seed.key) || 0) + 1);
    }
  }
  for (const facts of byDirectory.values()) {
    const directory = facts[0].directory;
    const contractFiles = facts[0].contractFiles;
    const standaloneCmake = facts[0].standaloneCmake;
    const scopedOwnerFiles = contractFiles || resolutionInputs.sourceTextsOnly ? undefined : scopedFilesByOwner.get(directory);
    const scopedIncludeFiles = contractFiles ? undefined : scopedIncludesByOwner.get(directory);
    const scopedPathDataflow = Boolean(scopedOwnerFiles || scopedIncludeFiles);
    let commandCount = 0;
    let commandLimit = 80000;
    let fileCount = 0;
    const evaluationSeed = evaluationSeeds.get(facts);
    evaluationSeeds.delete(facts);
    const remainingUses = evaluationSeed ? evaluationUses.get(evaluationSeed.key) - 1 : 0;
    if (evaluationSeed) {
      if (remainingUses) evaluationUses.set(evaluationSeed.key, remainingUses);
      else evaluationUses.delete(evaluationSeed.key);
    }
    const cached = evaluationSeed && evaluationResults.get(evaluationSeed.key);
    const inProcessHit = cached && cached.independentRevision === independentRevision;
    let diskKey;
    let diskEffect;
    // Scoped candidates are proved afresh after all owners register; they
    // are not part of an evaluation replay effect.
    if (!inProcessHit && storeConfig && !contractFiles && !standaloneCmake && !scopedPathDataflow && persistentAttempts < 64) {
      const assigned = manifestsByOwner.get(directory) || [];
      let cmakeLists = 0;
      for (const file of assigned) if (basename(file) === "CMakeLists.txt" && ++cmakeLists === 32) break;
      if (cmakeLists >= 32) {
        const seed = evaluationSeed || providerEvaluationSeed(facts[0]);
        if (seed) {
          persistentAttempts++;
          if (stateRevision !== independentRevision) {
            stateRevision = independentRevision;
            stateDigest = nativeOwnerDigest(independentDirectories);
          }
          if (stateDigest) diskKey = nativeOwnerDigest([storeConfig, seed.key, stateDigest, assigned,
            facts.some(({ component }) => providerSourceRevision(component))]);
        }
      }
      if (diskKey) {
        const record = persistent.store.read(diskKey);
        const effect = record?.effect;
        const observed = validOwnerEffect(effect) && validateOwnerReads(scanRoot, directory, record.reads, files, resolutionInputs.sourceTexts);
        if (observed) {
          for (const [file, text] of observed) files.set(file, text);
          diskEffect = effect;
          persistentDecision(directory, "hit", undefined, effect.commandCount);
        } else persistentDecision(directory, "miss", record ? "changed-witness" : "no-record");
      }
    }
    if (inProcessHit || diskEffect) {
      const evaluation = diskEffect || structuredClone(cached.result);
      commandCount = evaluation.commandCount;
      fileCount = evaluation.fileCount;
      for (const [name, owner] of evaluation.effects.findDefinitions) rememberFindDefinition(name, owner);
      for (const [file, contract] of evaluation.effects.findContracts) findContracts.set(file, contract);
      // Replay only this owner's writes. Interleaved owners keep their own
      // contracts/definitions, and append-only emissions retain context order.
      for (const [destination, values] of [[findModules, evaluation.effects.findModules], [compilerChecks, evaluation.effects.compilerChecks],
        [wraps, evaluation.effects.wraps], [diagnostics, evaluation.effects.diagnostics]]) {
        for (const value of values) destination.push(value);
      }
      if (diskEffect && remainingUses) evaluationResults.set(evaluationSeed.key, { independentRevision, result: structuredClone(evaluation) });
      if (evaluationSeed && !remainingUses) evaluationResults.delete(evaluationSeed.key);
      registerOwnerFacts(evaluation.exports, evaluation.projectDeclarations);
      continue;
    }
    if (cached) evaluationResults.delete(evaluationSeed.key);
    if (diskKey) ownerReads = captureOwnerReads(scanRoot, directory);
    const evaluationStart = evaluationSeed && remainingUses || diskKey ? {
      independentRevision, stages: stagedTransforms.length, stagedKeys: stagedKeys.size,
      scopedCandidates: scopedCandidates.size,
      findModules: findModules.length, compilerChecks: compilerChecks.length, wraps: wraps.length, diagnostics: diagnostics.length,
    } : undefined;
    evaluationWrites = evaluationStart ? { findDefinitions: [], findContracts: [] } : undefined;
    const builtinFiles = new Map((contractFiles || []).map((entry) => [entry.file, entry]));
    // Repeated component aliases of the same source owner share metadata work.
    const exports = [];
    const exportKeys = new Set();
    const configInterfaces = new Map();
    const configDeclarations = standaloneCmake ? new Map() : undefined;
    const configInstalls = standaloneCmake ? [] : undefined;
    const add = (kind, name, source, conditions = [], global = true, exportedVersion, attributes = {}) => {
      if (kind === "tool" ? !safeMember(name) : ["header-file", "data-file"].includes(kind) ?
        typeof name !== "string" || !/^[A-Za-z0-9_.][A-Za-z0-9_./+-]*$/.test(name) || name.split("/").includes("..") : !identity(name)) return;
      const entry = { kind, name, source, ownerDir: directory, conditions: [...conditions], global,
        ...(exportedVersion ? { interfaceVersion: exportedVersion } : {}), ...attributes };
      const entryKey = JSON.stringify(entry);
      if (!exportKeys.has(entryKey)) {
        exportKeys.add(entryKey);
        exports.push(entry);
      }
    };
    const targets = new Map();
    const executables = new Map();
    const executableAliases = new Map();
    const importedExecutables = new Map();
    const exportSets = new Map();
    const definitions = new ProviderDefinitions();
    let externalAddLLVM;
    const visitedScopedLookups = new Set();
    const scopedInvocations = scopedLookups?.size ? [] : undefined;
    let scopedReplay = false;
    const installPayloadFiles = new Map();
    const generatedFiles = new Map();
    const generatedInstalls = [];
    const programInstalls = [];
    const headerInstalls = [];
    const executableCopies = [];
    const fileCopies = [];
    const compiledPrograms = new Map();
    const producerReplays = [];
    let producerReplay;
    const sourceAlternatives = [];
    const configuredPrograms = [];
    const localPrograms = [];
    let templateDefinitions;
    const recordLocalPrograms = (args, source, guards, output, sourceDirectory) => {
      const paths = [];
      for (let at = args.indexOf("PATHS") + 1; at < args.length && paths.length < 16; at++) {
        const arg = args[at];
        if (libraryFindControls.has(arg) || programSearchControls.test(arg)) break;
        if (sourceDirectory) {
          const child = /^\$\{CMAKE_CURRENT_SOURCE_DIR\}\/(.+)$/.exec(arg)?.[1];
          if (safeMember(child)) paths.push(resolve(sourceDirectory, child));
        } else if (isAbsolute(arg) && !arg.includes("$") && inside(directory, arg)) paths.push(arg);
      }
      if (paths.length) for (const member of libraryRequestNames({ command: "find_program",
        requestedName: args.includes("NAMES") || args.includes("NAME") ? undefined : args[1], arguments: args }).filter(safeMember)) {
        for (const path of paths) output.push({ member, path: resolve(path, member), source, conditions: guards });
      }
    };
    const filenameAlternatives = [];
    const listAlternatives = [];
    let installedEntries = 0;
    let helperSummaries = new WeakMap();
    let summaryCount = 0;
    let summaryRevision = definitions.revision;
    const observableState = { revision: 0 };
    const active = new Set();
    const uncertainCalls = new Map();
    const projectDeclarations = [];
    let activeFindModule;
    let activeFindFile;
    let activeFindScope;
    const visitedManifests = new Set();
    const scopeDirectory = facts[0].scopeDirectory || directory;
    const hasSourceRevision = facts.some(({ component }) => providerSourceRevision(component));
    const outputBranches = [];
    const writeOutputs = (item, outputs) => {
      for (const branch of outputBranches) if (!branch.targetInitial.has(item)) branch.targetInitial.set(item, item.outputNames);
      item.outputNames = outputs;
    };
    const saveOutputs = (branch) => {
      const condition = branch.knownTrue ? "" : branch.condition;
      if (!branch.targetInitial.size) return condition;
      const snapshot = new Map([...branch.targetInitial.keys()].map((item) => [item, item.outputNames]));
      snapshot.condition = condition;
      return snapshot;
    };
    const saveGenerated = (branch, condition = branch.condition) => new Map([...branch.generatedInitial].map(([path, original]) =>
      [path, (generatedFiles.get(path) || original).map((entry) => ({ ...entry,
        conditions: branch.knownTrue ? entry.conditions : [...new Set([...entry.conditions, condition])] }))]));
    const initial = new ProviderEnvironment(evaluationSeed?.variables || providerInitialBindings(facts[0]));
    const target = (name, source, conditions, kind) => {
      let declarations = targets.get(name);
      if (!declarations) targets.set(name, declarations = []);
      let item = declarations.find((entry) => entry.source === source && entry.kind === kind);
      if (!item) {
        item = { name, source, kind, conditions, aliases: [], properties: new Map(), outputNames: [], installs: [] };
        declarations.push(item);
      }
      return item;
    };
    const exportConfig = (output, source, conditions, input, env, cmakeDollars = false) => {
      const match = basename(output || "").match(/^(.+?)(?:-config(?:-version)?|Config(?:Version)?)\.cmake(?:\.in)?$/);
      if (match) add("cmake-package", match[1], source, conditions);
      if (match && input && !input.includes("$") && /(?:ConfigVersion|-config-version)\.cmake$/.test(basename(input))) {
        const path = resolve(env.get("CMAKE_CURRENT_SOURCE_DIR") || directory, input);
        const text = metadata(path);
        if (text !== undefined) {
          const local = new Map(env);
          let declared;
          let declaredSource = `${path}:1`;
          for (const command of parseCmakeCommands(text)) {
            if (["if", "function", "macro", "foreach", "while"].includes(command.name)) break;
            if (command.name !== "set" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(command.args[0] || "")) continue;
            const value = command.args.slice(1).map((arg) => expandCmakeVariables(arg, local)).join(";");
            local.set(command.args[0], value);
            if (command.args[0] === "PACKAGE_VERSION") { declared = value; declaredSource = `${path}:${command.line}`; }
          }
          const name = match[1].toLowerCase();
          if (!configInterfaces.has(name)) configInterfaces.set(name, []);
          configInterfaces.get(name).push({ conditions, interfaceVersionSource: declaredSource, compatibilityMode: "CustomConfigVersion",
            ...(/^\d+(?:\.\d+)*$/.test(declared || "") ? { interfaceVersion: declared } : { interfaceVersionUnknown: true }) });
        }
      }
      const pc = basename(output || "").match(/^(.+)\.pc(?:\.in)?$/);
      if (!pc || !input || input.includes("$")) return;
      const path = resolve(env.get("CMAKE_CURRENT_SOURCE_DIR") || directory, input);
      const text = metadata(path);
      const declared = text !== undefined && providerPcVersion(text, env, cmakeDollars);
      if (declared) add("pkg-config", pc[1], `${path}:${text.slice(0, text.indexOf("Version:")).split("\n").length}`, conditions, true, declared);
    };
    const evaluate = (commands, file, variables, conditions = [], depth = 0, parentWrites = new Map(), uncertain = false, commandOffset = 0, argumentBindings) => {
      if (depth > 16 || commandCount > commandLimit) return;
      const env = variables;
      const crossOwnerLookup = scopedIncludeFiles?.has(file) || false;
      const scopedFile = scopedOwnerFiles?.includes(file) || crossOwnerLookup ? scopedLookups.get(file) : undefined;
      env.set("CMAKE_CURRENT_LIST_DIR", dirname(file));
      const expandArgs = (command, provenance) => command.args.flatMap((arg, index) => {
        let substituted = arg;
        let literalOffsets = command.literalVariableOffsets?.[index];
        if (argumentBindings && arg.includes("${")) {
          substitutions: for (const [key, replacement] of argumentBindings) {
            const reference = `\${${key}}`;
            let from = 0;
            let at;
            while ((at = substituted.indexOf(reference, from)) >= 0) {
              if (literalOffsets?.includes(at)) { from = at + reference.length; continue; }
              const delta = replacement.length - reference.length;
              if (substituted.length + delta > MAX_METADATA_BYTES) {
                substituted = "$<unknown:macro-expansion>";
                literalOffsets = undefined;
                break substitutions;
              }
              substituted = substituted.slice(0, at) + replacement + substituted.slice(at + reference.length);
              if (literalOffsets) literalOffsets = literalOffsets.map((offset) => offset > at ? offset + delta : offset);
              from = at + replacement.length;
            }
          }
        }
        const value = expandCmakeVariables(substituted, env, literalOffsets);
        const values = !(command.name === "cmake_parse_arguments" && index < 4) &&
          !command.quotedArguments?.[index] && !command.literalVariableOffsets?.[index]?.length && arg.startsWith("${") ? value.split(";") : [value];
        if (provenance) for (let at = 0; at < values.length; at++) {
          provenance.raw.push(arg);
          provenance.quoted.push(Boolean(command.quotedArguments?.[index]));
        }
        return values;
      });
      const branches = [];
      let continuationGuards = [];
      let returnedStates;
      let propagated;
      const flowResult = (returned = false) => ({
        returned, conditions: returned ? undefined : continuationGuards, states: returnedStates, propagated,
      });
      const saveContinuation = (branch) => {
        branch.outputs.push(new ProviderEnvironment(env));
        branch.outputGuards.push(branch.knownTrue ? continuationGuards : [...continuationGuards, branch.condition]);
      };
      const terminatePath = (capture = true) => {
        if (capture) (returnedStates ||= []).push(new ProviderEnvironment(env));
        for (const branch of branches) branch.hasReturn = true;
        const branch = branches.at(-1);
        if (!branch) return true;
        branch.targetStates.push(saveOutputs(branch));
        branch.generatedStates.push(saveGenerated(branch));
        branch.inactive = true;
        return false;
      };
      const carryFlow = (flow) => {
        if (!flow) return 0;
        if (flow.conditions?.length || flow.states?.length) {
          for (const branch of branches) branch.hasReturn = true;
        }
        if (flow.conditions?.length) continuationGuards = [...new Set([...continuationGuards, ...flow.conditions])];
        if (flow.states?.length) (returnedStates ||= []).push(...flow.states);
        if (flow.propagated) for (const [key, value] of flow.propagated) {
          const output = uncertain || continuationGuards.length || branches.some((branch) => !branch.knownTrue) ? `$<unknown:${key}>` : value;
          parentWrites.set(key, output);
          (propagated ||= new Map()).set(key, output);
        }
        return flow.returned ? terminatePath(false) ? 2 : 1 : 0;
      };
      for (let index = 0; index < commands.length; index++) {
        const command = commands[index];
        commandCount++;
        if (index + commandOffset > 20000 || commandCount > commandLimit) { diagnostics.push({ directory, file, reason: "command-budget" }); return; }
        let name = command.name;
        const conditionProvenance = name === "if" || name === "elseif" ? { raw: [], quoted: [] } : undefined;
        let args = name === "elseif" ? [] : expandArgs(command, conditionProvenance);
        const source = `${file}:${command.line}`;
        if (["function", "macro"].includes(name)) {
          let nesting = 1;
          let end = index + 1;
          for (; end < commands.length; end++) {
            if (["function", "macro"].includes(commands[end].name)) nesting++;
            if (["endfunction", "endmacro"].includes(commands[end].name) && !--nesting) break;
          }
          if (!branches.some((branch) => branch.inactive)) {
            const body = commands.slice(index + 1, end);
            const definitionGuards = [...conditions, ...continuationGuards, ...branches.filter((branch) => !branch.knownTrue).map((branch) => branch.condition)];
            const definition = { parameters: args.slice(1), body, file, macro: name === "macro", argumentBindings, conditions: definitionGuards };
            if (scopedPathDataflow) definition.scopedPathDataflow = true;
            if (!scopedReplay) definitions.set(args[0]?.toLowerCase(), definition);
            const lookups = scopedReplay ? undefined : resolutionInputs.localProgramLookups?.get(file);
            if ((lookups || scopedFile) && inside(directory, file)) {
              const signature = `${name}(${command.args.join(" ")})`;
              // A declared but uncalled helper establishes availability in
              // this source scope, not the location CMake will select.
              if (scopedFile && !crossOwnerLookup) for (const lookup of reachableTemplateProgramLookups(body, true)) {
                if (scopedFile.has(lookup.line) && stableTemplateProgramBindings(lookup, body, definition.parameters)) {
                  (definition.scopedPrograms ||= []).push([file, lookup, expandArgs(lookup), definitionGuards, [], signature]);
                }
              }
              if (lookups) for (const lookup of reachableTemplateProgramLookups(body)) {
                if (scopedFile?.has(lookup.line)) continue;
                for (const record of lookups.get(lookup.line) || []) if (record.definition === signature) {
                  recordLocalPrograms(lookup.args, `${file}:${lookup.line}`, [...new Set([...definitionGuards, ...record.conditions])],
                    definition.localPrograms ||= [], env.get("CMAKE_CURRENT_SOURCE_DIR") || directory);
                }
              }
              if (definition.localPrograms?.length || definition.scopedPrograms?.length) (templateDefinitions ||= []).push(definition);
            }
          }
          index = end;
          continue;
        }
        if (name === "if") {
          const state = providerCondition(args, env, conditionProvenance.raw, conditionProvenance.quoted, standaloneCmake);
          const branch = { env: new ProviderEnvironment(env), outputs: [], outputGuards: [], entryGuards: continuationGuards,
            condition: `if(${command.args.join(" ")})`, inactive: state === false,
            knownTrue: state === true, takenTrue: state === true, hadUnknown: state === undefined,
            targetInitial: new Map(), targetStates: [], generatedInitial: new Map(), generatedStates: [] };
          branches.push(branch);
          outputBranches.push(branch);
          continue;
        }
        if (["else", "elseif"].includes(name)) {
          const branch = branches.at(-1);
          if (branch) {
            if (!branch.inactive) { saveContinuation(branch); branch.targetStates.push(saveOutputs(branch)); }
            if (!branch.inactive) branch.generatedStates.push(saveGenerated(branch));
            for (const [path, original] of branch.generatedInitial) generatedFiles.set(path, original);
            for (const [item, outputs] of branch.targetInitial) item.outputNames = outputs;
            env.restore(branch.env);
            continuationGuards = branch.entryGuards;
            branch.condition = `${branch.condition}/${name}(${command.args.join(" ")})`;
            const state = branch.takenTrue ? false : name === "else" ? true :
              providerCondition(expandArgs(command, conditionProvenance), env, conditionProvenance.raw, conditionProvenance.quoted, standaloneCmake);
            branch.inactive = state === false;
            branch.knownTrue = state === true && !branch.hadUnknown;
            branch.takenTrue ||= state === true;
            branch.hadUnknown ||= state === undefined;
            branch.hasElse = name === "else";
          }
          continue;
        }
        if (name === "endif") {
          const branch = branches.pop();
          // A stray closer touches the caller's shared stack. Reject it even
          // when that stack is currently empty: a later invocation may pop a
          // real caller frame, so an empty-stack no-op is not a pure summary.
          if (!branch) observableState.revision++;
          outputBranches.pop();
          if (branch) {
            // A sole current outcome needs no snapshot or value rewrite, but
            // the normal merge still removes explicitly undefined bindings.
            const onlyCurrentBranch = !branch.hasReturn && !branch.inactive && branch.outputs.length === 0 &&
              (branch.hasElse || branch.takenTrue);
            if (onlyCurrentBranch) env.removeUndefined();
            if (!branch.inactive) {
              if (!onlyCurrentBranch) saveContinuation(branch);
              branch.targetStates.push(saveOutputs(branch));
              branch.generatedStates.push(saveGenerated(branch));
            }
            if (!branch.hasElse && !branch.takenTrue) {
              branch.outputs.push(branch.env);
              branch.outputGuards.push([...branch.entryGuards, `${branch.condition}/else()`]);
              branch.targetStates.push(`${branch.condition}/else()`);
            }
            if (!branch.hasElse && !branch.takenTrue) {
              branch.generatedStates.push(new Map([...branch.generatedInitial].map(([path, original]) => [path,
                original.map((entry) => ({ ...entry, conditions: [...new Set([...entry.conditions, `${branch.condition}/else()`])] }))])));
            }
            for (const [path] of branch.generatedInitial) {
              const variants = new Map();
              for (const state of branch.generatedStates) for (const entry of state.get(path) || []) variants.set(JSON.stringify(entry), entry);
              generatedFiles.set(path, [...variants.values()]);
            }
            for (const [item, original] of branch.targetInitial) {
              const outputs = [];
              const seen = new Set();
              for (const state of branch.targetStates) {
                const unchanged = typeof state === "string";
                const condition = unchanged ? state : state.condition;
                for (let output of (unchanged ? original : state.get(item) || original)) {
                  if (item.installs && condition && !output.conditions.includes(condition)) {
                    if (!compatibleOwnerConditions(output.conditions, [condition])) continue;
                    output = { ...output, conditions: [...output.conditions, condition] };
                  }
                  const key = JSON.stringify(output);
                  if (!seen.has(key)) {
                    seen.add(key);
                    outputs.push(output);
                  }
                }
              }
              item.outputNames = outputs;
            }
            if (branch.hasReturn) {
              if (!branch.outputs.length) {
                if (terminatePath(false)) return flowResult(true);
                continue;
              }
              const alternatives = [...new Map(branch.outputGuards.map((guards) => [JSON.stringify(guards), guards])).values()];
              continuationGuards = alternatives.length === 1 ? alternatives[0] :
                [...branch.entryGuards, `any(${JSON.stringify(alternatives)})`];
              env.restore(branch.outputs[0]);
            }
            if (branch.outputs.length && branch.outputs.every((state) => env.sharesBindings(state))) {
              env.removeUndefined();
              continue;
            }
            // Visit each branch key once without flattening every environment
            // into temporary arrays and a Set. Branch snapshots stay immutable.
            for (let at = 0; at < branch.outputs.length; at++) {
              for (const k of branch.outputs[at].keys()) {
                let seen = false;
                for (let prior = 0; prior < at; prior++) {
                  if (branch.outputs[prior].hasBinding(k)) { seen = true; break; }
                }
                if (seen) continue;
                if (env.mergeUnchangedBinding(k, branch.outputs)) continue;
                let value = branch.outputs[0].get(k);
                for (let other = 1; other < branch.outputs.length; other++) {
                  if (branch.outputs[other].get(k) === value) continue;
                  const target = targetFile(value);
                  const stem = typeof value === "string" && value.replace(/\.(?:cmd|py|exe)$/, "");
                  if (target && branch.outputs.every((state) => targetFile(state.get(k)) === target)) {
                    value = `$<TARGET_FILE:${target}>`;
                  } else if (copyOperations.has(value) && branch.outputs.every((state) => copyOperations.has(state.get(k)))) {
                    value = "$<provider-copy-operation>";
                  } else if (identity(stem) && filenameAlternatives.length < 128 && branch.outputs.length <= 4 &&
                    branch.outputs.every((state) => [stem, `${stem}.cmd`, `${stem}.py`, `${stem}.exe`].includes(state.get(k)))) {
                    const id = filenameAlternatives.push(branch.outputs.map((state, index) => ({
                      name: state.get(k), conditions: branch.outputGuards[index],
                    }))) - 1;
                    value = `$<provider-filename:${id}>`;
                  } else if (sourceAlternatives.length < 128 && branch.outputs.length <= 4 &&
                    branch.outputs.some((state) => typeof state.get(k) === "string" && isAbsolute(state.get(k)) && /\.(?:c|cc|cpp|cxx)$/.test(state.get(k)))) {
                    const id = sourceAlternatives.push(branch.outputs.map((state, index) => ({
                      path: state.get(k), conditions: branch.outputGuards[index],
                    }))) - 1;
                    value = `$<provider-source-path:${id}>`;
                  } else if (listAlternatives.length < 128 && branch.outputs.length <= 4 &&
                    branch.outputs.some((state) => typeof state.get(k) === "string" && state.get(k).length <= 256 &&
                      state.get(k).includes(";") && state.get(k).split(";").every(identity))) {
                    const id = listAlternatives.push(branch.outputs.map((state, index) => ({
                      value: state.get(k), conditions: branch.outputGuards[index],
                    }))) - 1;
                    value = `$<provider-list:${id}>`;
                  } else value = `$<unknown:${k}>`;
                  break;
                }
                if (value === undefined) env.delete(k);
                else env.set(k, value);
              }
            }
          }
          continue;
        }
        if (branches.some((branch) => branch.inactive)) continue;
        if (name === "cmake_language" && args[0] === "CALL") {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(args[1] || "")) {
            diagnostics.push({ directory, file, source, reason: "dynamic-call-unknown" });
            continue;
          }
          name = args[1].toLowerCase();
          args = args.slice(2);
        }
        const guards = [...conditions, ...continuationGuards, ...branches.filter((branch) => !branch.knownTrue).map((branch) => branch.condition)];
        if (name === "find_program" && command.name === name && scopedFile?.has(command.line)) {
          const moduleSearch = activeFindFile === file && command.args.includes("${CMAKE_MODULE_PATH}");
          if (!moduleSearch || env.get("CMAKE_MODULE_PATH")?.split(";").some((path) => isAbsolute(path) && resolve(path) === dirname(file))) {
            // A different call site can have different scoped obligations
            // even when no proof could be emitted at this call site.
            observableState.revision++;
            recordScopedPrograms(file, command, args, guards, scopedInvocations || [], undefined, crossOwnerLookup);
          }
        }
        // Reject supported non-variable reads/mutations, even when deduplicated
        // or yielding no export. Finder commands only observe state inside an
        // active Find module; elsewhere they fall through to a source-defined
        // helper (whose effects are guarded transitively), or remain no-ops.
        if (providerCommands.has(name) && (activeFindModule || !["find_library", "find_path", "find_file", "find_program"].includes(name)) ||
          ["project", "include", "add_subdirectory", "add_custom_target", "add_custom_command"].includes(name) ||
          name === "file" && args[0] === "WRITE" ||
          ["set", "unset"].includes(name) && args.includes("CACHE")) observableState.revision++;
        if (name === "return") {
          if (args[0] === "PROPAGATE") for (const key of args.slice(1)) {
            if (identity(key)) {
              const value = uncertain || continuationGuards.length || branches.some((branch) => !branch.knownTrue) ? `$<unknown:${key}>` : env.get(key);
              parentWrites.set(key, value);
              (propagated ||= new Map()).set(key, value);
            }
          }
          if (terminatePath()) return flowResult(true);
          continue;
        }
        if (name === "block") {
          let nesting = 1;
          let end = index + 1;
          for (; end < commands.length; end++) {
            if (commands[end].name === "block") nesting++;
            else if (commands[end].name === "endblock" && !--nesting) break;
          }
          const scoped = !args.includes("SCOPE_FOR") || args.slice(args.indexOf("SCOPE_FOR") + 1, args.indexOf("PROPAGATE") >= 0 ? args.indexOf("PROPAGATE") : undefined).includes("VARIABLES");
          const local = scoped ? new ProviderEnvironment(env) : env;
          const writes = scoped ? new Map() : parentWrites;
          const flow = evaluate(commands.slice(index + 1, end), file, local, guards, depth + 1, writes,
            uncertain || Boolean(continuationGuards.length) || branches.some((branch) => !branch.knownTrue), commandOffset + index + 1, argumentBindings);
          if (scoped) {
            for (const [key, value] of writes) value === undefined ? env.delete(key) : env.set(key, value);
            const at = args.indexOf("PROPAGATE");
            for (const key of at >= 0 ? args.slice(at + 1) : []) local.has(key) ? env.set(key, local.get(key)) : env.delete(key);
            if (flow?.states) flow.states = flow.states.map((state) => {
              const outer = new ProviderEnvironment(env);
              for (const key of at >= 0 ? args.slice(at + 1) : []) state.has(key) ? outer.set(key, state.get(key)) : outer.delete(key);
              return outer;
            });
          }
          if (carryFlow(flow) === 2) return flowResult(true);
          commandCount++;
          if (end + commandOffset > 20000 || commandCount > commandLimit) { diagnostics.push({ directory, file, reason: "command-budget" }); return; }
          index = end;
          continue;
        }
        if (name === "foreach") {
          let nesting = 1;
          let end = index + 1;
          for (; end < commands.length; end++) {
            if (commands[end].name === "foreach") nesting++;
            else if (commands[end].name === "endforeach" && !--nesting) break;
          }
          const values = args[1] === "IN" && args[2] === "LISTS" ?
            args.slice(3).flatMap((name) => {
              const value = env.get(name);
              return value === "" ? [] : (value ?? `$<unknown:${name}>`).split(";");
            }) :
            args.slice(args[1] === "IN" && args[2] === "ITEMS" ? 3 : 1);
          let visitedUnknown = false;
          const body = commands.slice(index + 1, end);
          const unknown = `$<unknown:${args[0]}>`;
          const iterations = values.length <= 128 ? values : [unknown];
          let guarded;
          if (!command.quotedArguments?.includes(true) && iterations.some((value) => value.startsWith("$<provider-list:"))) {
            guarded = iterations.flatMap((value) => {
              const id = /^\$<provider-list:(\d+)>$/.exec(value)?.[1];
              if (id === undefined) return [{ value, conditions: [] }];
              return (listAlternatives[Number(id)] || []).flatMap((choice) => {
                if (choice.value === "") return [];
                const list = choice.value?.length <= 256 && choice.value.split(";").every(identity) ? choice.value.split(";") : [unknown];
                return list.map((value) => ({ value, conditions: choice.conditions }));
              });
            });
            if (guarded.length > 128) guarded = [{ value: unknown, conditions: [] }];
          }
          for (let at = 0; at < (guarded || iterations).length; at++) {
            const value = guarded ? guarded[at].value : iterations[at];
            const choices = guarded?.[at].conditions || [];
            const known = !value.includes("$");
            if (!known && visitedUnknown) continue;
            visitedUnknown ||= !known;
            if (!compatibleOwnerConditions(choices, guards)) continue;
            const local = new ProviderEnvironment(env);
            local.set(args[0], value);
            let flow = evaluate(body, file, local, [...guards, ...continuationGuards, ...choices, `foreach(${args[0]} ${known ? value : "unknown"})`], depth + 1,
              parentWrites, uncertain || Boolean(continuationGuards.length || choices.length) || !known || branches.some((branch) => !branch.knownTrue), 0, argumentBindings);
            if (flow?.states) for (const state of flow.states) {
              if (env.has(args[0])) state.set(args[0], env.get(args[0]));
              else state.delete(args[0]);
            }
            if ((!known || choices.length) && flow) {
              const paths = [[...continuationGuards, `foreach(${args[0]} zero)`]];
              if (!flow.returned) paths.push([...continuationGuards, ...(flow.conditions || []), `foreach(${args[0]} unknown)`]);
              flow = { ...flow, returned: false, conditions: paths.length === 1 ? paths[0] : [`any(${JSON.stringify(paths)})`] };
            }
            const control = carryFlow(flow);
            if (control === 2) return flowResult(true);
            if (control === 1) break;
          }
          index = end;
          continue;
        }
        if (name === "cmake_parse_arguments" && args.length >= 4) {
          const [prefix, optionsText, singlesText, multiplesText] = args;
          const options = optionsText.split(";").filter(Boolean);
          const singles = singlesText.split(";").filter(Boolean);
          const multiples = multiplesText.split(";").filter(Boolean);
          const keywords = new Set([...options, ...singles, ...multiples]);
          const rest = args.slice(4).flatMap((arg) => arg.split(";").filter(Boolean));
          for (const option of options) env.set(`${prefix}_${option}`, "FALSE");
          for (const option of [...singles, ...multiples]) env.set(`${prefix}_${option}`, "");
          if (rest.some((arg) => arg.includes("$"))) {
            for (const option of [...options, ...singles, ...multiples]) {
              env.set(`${prefix}_${option}`, options.includes(option) && rest.includes(option) ? "TRUE" : `$<unknown:${prefix}_${option}>`);
            }
            env.set(`${prefix}_UNPARSED_ARGUMENTS`, `$<unknown:${prefix}_UNPARSED_ARGUMENTS>`);
            continue;
          }
          const unparsed = [];
          for (let at = 0; at < rest.length; at++) {
            const option = rest[at];
            if (options.includes(option)) env.set(`${prefix}_${option}`, "TRUE");
            else if (singles.includes(option)) {
              if (at + 1 < rest.length && !keywords.has(rest[at + 1])) env.set(`${prefix}_${option}`, rest[++at]);
            } else if (multiples.includes(option)) {
              const values = [];
              while (at + 1 < rest.length && !keywords.has(rest[at + 1])) values.push(rest[++at]);
              if (values.length) {
                const previous = env.get(`${prefix}_${option}`);
                env.set(`${prefix}_${option}`, (previous ? `${previous};` : "") + values.join(";"));
              }
            } else unparsed.push(option);
          }
          env.set(`${prefix}_UNPARSED_ARGUMENTS`, unparsed.join(";"));
          continue;
        }
        if (name === "list" && ["APPEND", "PREPEND", "INSERT"].includes(args[0]) && args[1]) {
          const previous = (env.get(args[1]) || "").split(";").filter(Boolean);
          const values = args.slice(args[0] === "INSERT" ? 3 : 2);
          if (args[0] === "INSERT" && /^\d+$/.test(args[2])) previous.splice(Number(args[2]), 0, ...values);
          else if (args[0] === "PREPEND") previous.unshift(...values);
          else previous.push(...values);
          env.set(args[1], previous.join(";"));
          continue;
        }
        if (name === "list" && ["REMOVE_AT", "REMOVE_ITEM", "REMOVE_DUPLICATES"].includes(args[0]) && args[1]) {
          const value = env.get(args[1]);
          if (value === undefined || value.includes("$") || args.slice(2).some((arg) => arg.includes("$"))) {
            env.set(args[1], `$<unknown:${args[1]}>`);
            continue;
          }
          const values = value ? value.split(";") : [];
          if (args[0] === "REMOVE_AT") {
            const indices = args.slice(2).map((arg) => /^-?\d+$/.test(arg) ? Number(arg) : NaN)
              .map((index) => index < 0 ? values.length + index : index);
            if (indices.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= values.length)) {
              env.set(args[1], `$<unknown:${args[1]}>`);
              continue;
            }
            const removed = new Set(indices);
            env.set(args[1], values.filter((_item, index) => !removed.has(index)).join(";"));
          } else if (args[0] === "REMOVE_ITEM") {
            const removed = new Set(args.slice(2));
            env.set(args[1], values.filter((item) => !removed.has(item)).join(";"));
          } else env.set(args[1], [...new Set(values)].join(";"));
          continue;
        }
        if (name === "list" && args[0] === "LENGTH" && args.length === 3) {
          const value = env.get(args[1]);
          env.set(args[2], value === undefined || value.includes("$") ? `$<unknown:${args[2]}>` : String(value ? value.split(";").length : 0));
          continue;
        }
        if (name === "list" && args[0] === "GET" && args.length === 4 && /^\d+$/.test(args[2])) {
          const value = env.get(args[1]);
          env.set(args[3], value === undefined || value.includes("$") ? `$<unknown:${args[3]}>` : value.split(";")[Number(args[2])] ?? `$<unknown:${args[3]}>`);
          continue;
        }
        if (name === "string" && args[0] === "REGEX" && args[1] === "REPLACE" && args.length >= 6) {
          const pattern = args[2];
          const fromStart = pattern.startsWith("^");
          const atEnd = pattern.endsWith("$");
          const literal = pattern.slice(fromStart ? 1 : 0, atEnd ? -1 : undefined);
          const replacement = args[3];
          const input = args.slice(5).join("");
          if ((!fromStart && !atEnd) || !/^[A-Za-z0-9_ -]+$/.test(literal) || replacement.includes("\\") ||
            replacement.includes("$") || input.includes("$") || input.length + replacement.length > MAX_METADATA_BYTES) {
            env.set(args[4], `$<unknown:${args[4]}>`);
            continue;
          }
          const matches = fromStart && atEnd ? input === literal : fromStart ? input.startsWith(literal) : input.endsWith(literal);
          // CMP0186 changes repeated start-anchor searches. Without a proved
          // policy, retain uncertainty only where OLD and NEW can differ.
          if (matches && fromStart && !atEnd && input.slice(literal.length).startsWith(literal) && replacement !== literal) {
            env.set(args[4], `$<unknown:${args[4]}>`);
            continue;
          }
          env.set(args[4], !matches ? input : fromStart ? replacement + input.slice(literal.length) : input.slice(0, -literal.length) + replacement);
          continue;
        }
        if (name === "string" && args[0] === "REGEX" && args[1] === "MATCHALL" && ["[0123456789]+", "[0-9]+"].includes(args[2]) && args.length === 5) {
          env.set(args[3], args[4].includes("$") ? `$<unknown:${args[3]}>` : (args[4].match(/\d+/g) || []).join(";"));
          continue;
        }
        if (["set", "unset"].includes(name) && args[0] && args.includes("PARENT_SCOPE")) {
          const value = name === "unset" ? undefined : args.slice(1, args.indexOf("PARENT_SCOPE")).join(";");
          parentWrites.set(args[0], uncertain || continuationGuards.length || branches.some((branch) => !branch.knownTrue) ? `$<unknown:${args[0]}>` : value);
          continue;
        }
        if (name === "set" && args[0]) env.set(args[0], args.slice(1, args.findIndex((arg) => ["CACHE", "PARENT_SCOPE"].includes(arg)) > 0 ? args.findIndex((arg) => ["CACHE", "PARENT_SCOPE"].includes(arg)) : undefined).join(";"));
        else if (name === "unset" && args[0]) env.delete(args[0]);
        else if (scopedPathDataflow && name === "get_filename_component" && identity(args[0])) {
          const base = env.get("CMAKE_CURRENT_SOURCE_DIR");
          env.set(args[0], args.length === 3 && args[2] === "ABSOLUTE" && !args[1].includes("$") &&
            (isAbsolute(args[1]) || isAbsolute(base || "")) ? resolve(base || directory, args[1]) : `$<unknown:${args[0]}>`);
        } else if (name === "string" && ["TOLOWER", "TOUPPER"].includes(args[0]) && args.length === 3) env.set(args[2], args[0] === "TOLOWER" ? args[1].toLowerCase() : args[1].toUpperCase());
        else if (name === "project" && identity(args[0])) {
          env.set("PROJECT_NAME", args[0]);
          if (standaloneCmake && !env.has("CMAKE_PROJECT_NAME")) env.set("CMAKE_PROJECT_NAME", args[0]);
          const projectSource = env.get("CMAKE_CURRENT_SOURCE_DIR") || directory;
          // The file evaluator uses source-shaped paths to correlate generated
          // files; that model cannot attest actual project binary directories.
          const projectBinary = "$<unknown:PROJECT_BINARY_DIR>";
          env.set("PROJECT_SOURCE_DIR", projectSource);
          env.set("PROJECT_BINARY_DIR", projectBinary);
          env.set(`${args[0]}_SOURCE_DIR`, projectSource);
          env.set(`${args[0]}_BINARY_DIR`, projectBinary);
          const versionAt = args.indexOf("VERSION");
          if (versionAt >= 0) {
            env.set("PROJECT_VERSION", args[versionAt + 1]);
            if (dirname(file) === directory) env.set("CMAKE_PROJECT_VERSION", args[versionAt + 1]);
          }
          if (dirname(file) === directory) projectDeclarations.push({ name: args[0], source, conditions: guards });
          if (!producerReplay) add("cmake-package", args[0], source, guards, false);
        } else if (name === "include" && args[0] && !args[0].includes("$")) {
          const currentSource = env.get("CMAKE_CURRENT_SOURCE_DIR") || dirname(file);
          const modulePaths = (env.get("CMAKE_MODULE_PATH") || "").split(";").filter((path) => path && !path.includes("$"));
          let candidates;
          if (standaloneCmake) {
            // An explicit file or declared module search path is reachable;
            // a coincidentally unique name elsewhere in the snapshot is not.
            candidates = /\.cmake$|[\\/]/i.test(args[0]) || /^CMakeLists[^/\\]*\.txt$/.test(args[0]) ?
              [resolve(currentSource, args[0])] :
              modulePaths.filter(isAbsolute).map((path) => resolve(path, `${args[0]}.cmake`));
          } else {
            candidates = [resolve(dirname(file), args[0]), resolve(directory, args[0]), resolve(directory, "cmake", `${args[0]}.cmake`),
              ...modulePaths.map((path) => resolve(path, `${args[0]}.cmake`))];
            const indexed = modulesByName.get(`${basename(args[0]).replace(/\.cmake$/, "")}.cmake`) || [];
            const scoped = indexed.filter((candidate) => inside(scopeDirectory, candidate));
            if (scoped.length === 1) candidates.push(scoped[0]);
          }
          let reached = false;
          for (const candidate of candidates) if ((candidate.endsWith(".cmake") || /^CMakeLists[^/\\]*\.txt$/.test(basename(candidate))) && inside(scanRoot, candidate) && metadata(candidate) !== undefined) {
            reached = true;
            visitCmake(candidate, env, [...guards, `include(${source})`], depth + 1, parentWrites, uncertain || branches.some((branch) => !branch.knownTrue),
              standaloneCmake ? false : undefined);
            break;
          }
          // AddLLVM's public target wrappers preserve the explicitly declared
          // output identity. If the imported module cannot be read, retain
          // only the guarded declaration, never an installed artifact.
          if (!reached && args[0] === "AddLLVM" && !args.includes("OPTIONAL")) (externalAddLLVM ||= []).push({ source, conditions: guards });
        } else if (name === "add_subdirectory" && args[0] && !args[0].includes("$")) {
          // With an explicit alternate binary directory its mapping cannot be
          // inferred from the source path. Do not certify that form here.
          if (standaloneCmake && (!safeMember(args[0]) || args.slice(1).some((arg) => arg !== "EXCLUDE_FROM_ALL" && arg !== "SYSTEM"))) continue;
          const child = resolve(env.get("CMAKE_CURRENT_SOURCE_DIR") || dirname(file), args[0]);
          const childFile = join(child, "CMakeLists.txt");
          const text = inside(directory, child) && metadata(childFile);
          if (text !== undefined && text !== false) {
            const independent = ownerDirs.has(child) || commandsOf(childFile).some((item) => item.name === "project");
            if (independent) {
              markIndependent(child);
              // The parent literally enters this direct child. Don't assign
              // its source root to the child's standalone presentation.
              const childScope = ownerScopes.get(child);
              if (manifests && hasSourceRevision && dirname(child) === directory && env.get("CMAKE_SOURCE_DIR") === directory &&
                (childScope === undefined || childScope === scopeDirectory)) {
                ownerReads?.block("producer-projection");
                if (!producerProjections.has(childFile)) {
                  const projection = projectProducerCommandsOf(commandsOf(childFile));
                  producerProjections.set(childFile, projection &&
                    (resolutionInputs.sourceTextsOnly ? childScope === scopeDirectory : directSourceChild(directory, child)) ? projection : undefined);
                }
                const projection = producerProjections.get(childFile);
                if (projection && producerReplays.length >= 16) {
                  diagnostics.push({ directory, source, reason: "subdirectory-producer-budget" });
                  continue;
                }
                if (projection) {
                  const local = new ProviderEnvironment(env);
                  local.set("CMAKE_CURRENT_SOURCE_DIR", child);
                  local.set("CMAKE_CURRENT_BINARY_DIR", child);
                  producerReplay = { source, file, childFile, compiledPrograms: new Map(), fileCopies: [] };
                  const outputDepth = outputBranches.length;
                  evaluate(projection, childFile, local, guards, depth + 1, new Map(), true);
                  outputBranches.length = Math.min(outputBranches.length, outputDepth);
                  producerReplays.push(producerReplay);
                  producerReplay = undefined;
                }
              }
            } else {
              const writes = new Map();
              visitCmake(childFile, new ProviderEnvironment(env), guards, depth + 1, writes, uncertain || branches.some((branch) => !branch.knownTrue));
              for (const [key, value] of writes) value === undefined ? env.delete(key) : env.set(key, value);
            }
          }
        } else if (activeFindModule && finderCommands.has(name)) {
          const pkg = name.startsWith("pkg_");
          const at = args.findIndex((arg) => ["NAME", "NAMES"].includes(arg));
          const names = [];
          for (const arg of args.slice(at >= 0 ? at + 1 : 1)) {
            if (pkg && ["REQUIRED", "QUIET", "IMPORTED_TARGET", "GLOBAL", "NO_CMAKE_PATH", "NO_CMAKE_ENVIRONMENT_PATH"].includes(arg)) continue;
            if (libraryFindControls.has(arg) || programSearchControls.test(arg)) break;
            const member = pkg ? arg.match(/^([A-Za-z0-9_][A-Za-z0-9_.+-]*)(?:[<>=].*)?$/)?.[1] : arg;
            if (name === "find_library" || pkg ? identity(member) : safeMember(member)) names.push(member);
            if (!pkg && at < 0) break; // remaining arguments are positional paths
          }
          if (names.length) findModules.push({ name: activeFindModule, moduleFile: activeFindFile, builtinModule: builtinFiles.get(activeFindFile),
            directory, source, destination: args[0], conditions: guards, scopeDirectory: activeFindScope,
            searchUnknown: pkg || args.some((arg) => programSearchControls.test(arg) || arg.includes("$")) || at < 0 && args.length > 2,
            libraries: name === "find_library" ? names : [], programs: name === "find_program" ? names : [],
            ...(name === "find_library" ? { librarySearchArgs: args } : {}),
            headers: ["find_path", "find_file"].includes(name) ? names : [], pkgConfig: pkg ? names : [] });
        } else if (!scopedReplay && name === "find_program" && args.includes("PATHS") && !scopedFile?.has(command.line) && !resolutionInputs.sourceTextsOnly) {
          const count = localPrograms.length;
          recordLocalPrograms(args, source, guards, localPrograms);
          if (localPrograms.length !== count) observableState.revision++;
        } else if (name === "add_library" && identity(args[0])) {
          if (args[1] === "ALIAS" && identity(args[2])) {
            for (const item of targets.get(args[2]) || []) if (compatibleOwnerConditions(item.conditions, guards)) {
              item.aliases.push({ name: args[0], source, conditions: guards });
            }
          } else if (!args.includes("IMPORTED")) {
            const kind = args.find((arg) => ["INTERFACE", "OBJECT", "SHARED", "STATIC", "MODULE"].includes(arg));
            const item = target(args[0], source, guards, kind);
            writeOutputs(item, ["INTERFACE", "OBJECT"].includes(kind) ? [] : [{ value: item.name, conditions: guards,
              ...(!kind && providerCondition(["BUILD_SHARED_LIBS"], env) !== true ? { archiveDefaultPossible: true } : {}) }]);
          }
        } else if (name === "llvm_add_library" && !definitions.has(name) && identity(args[0]) &&
          args.includes("STATIC") && !args.some((arg) => ["SHARED", "MODULE", "OBJECT", "INTERFACE", "IMPORTED", "ALIAS"].includes(arg)) &&
          externalAddLLVM?.some((entry) => compatibleOwnerConditions(entry.conditions, guards))) {
          const item = target(args[0], source, guards, "STATIC");
          writeOutputs(item, externalAddLLVM.filter((entry) => compatibleOwnerConditions(entry.conditions, guards))
            .map((entry) => ({ value: args[0], conditions: [...new Set([...entry.conditions, ...guards])], wrapperSource: entry.source })));
        } else if (name === "add_executable" && identity(args[0]) && args[1] === "ALIAS" && identity(args[2]) &&
          (executables.has(args[2]) || importedExecutables.has(args[2]))) {
          if (!executableAliases.has(args[0])) executableAliases.set(args[0], []);
          executableAliases.get(args[0]).push({ target: args[2], source, conditions: guards });
        } else if (name === "add_executable" && identity(args[0]) && args[1] === "IMPORTED") {
          if (!importedExecutables.has(args[0])) importedExecutables.set(args[0], []);
          importedExecutables.get(args[0]).push({ conditions: guards, locations: [] });
        } else if ((name === "add_executable" || name === "add_llvm_executable" && !definitions.has(name) &&
          externalAddLLVM?.some((entry) => compatibleOwnerConditions(entry.conditions, guards))) &&
          identity(args[0]) && args[1] !== "ALIAS" && !args.includes("IMPORTED")) {
          const targetName = args[0];
          let declarations = executables.get(targetName);
          if (!declarations) executables.set(targetName, declarations = []);
          let item = declarations.find((entry) => entry.source === source);
          if (!item) {
            item = { source, outputNames: [], installs: [] };
            declarations.push(item);
          }
          if (name === "add_executable") writeOutputs(item, [{ value: targetName, conditions: guards }]);
          else writeOutputs(item, externalAddLLVM.filter((entry) => compatibleOwnerConditions(entry.conditions, guards))
            .map((entry) => ({ value: targetName, conditions: [...new Set([...entry.conditions, ...guards])], wrapperSource: entry.source })));
        } else if (["set_target_properties", "set_property"].includes(name)) {
          const at = args.indexOf(name === "set_property" ? "PROPERTY" : "PROPERTIES");
          const names = name === "set_property" ? args[0] === "TARGET" ? args.slice(1, at) : [] : args.slice(0, at);
          if (at >= 0) for (const n of names) {
            const libraries = targets.get(n);
            const tools = executables.get(n);
            const imported = importedExecutables.get(n);
            if (!libraries && !tools && !imported) continue;
            for (let atProperty = at + 1; atProperty < args.length - 1; atProperty += 2) {
              const property = args[atProperty];
              const value = args[atProperty + 1];
              if (imported && /^IMPORTED_LOCATION(?:_[A-Z0-9_]+)?$/.test(property) && isAbsolute(value) && !value.includes("$") && inside(directory, value)) {
                for (const item of imported) if (compatibleOwnerConditions(item.conditions, guards)) {
                  item.locations.push({ path: value, source, conditions: [...new Set([...item.conditions, ...guards,
                    ...(property === "IMPORTED_LOCATION" ? [] : [`target-property(${property})`])])] });
                }
              }
              for (const item of libraries || []) {
                if (!compatibleOwnerConditions(item.conditions, guards)) continue;
                item.properties.set(property, value);
                const field = { OUTPUT_NAME: "value", ARCHIVE_OUTPUT_NAME: "archive", LIBRARY_OUTPUT_NAME: "library",
                  RUNTIME_OUTPUT_NAME: "runtime", PREFIX: "prefix", SUFFIX: "suffix" }[property];
                if (field) writeOutputs(item, item.outputNames.map((output) => compatibleOwnerConditions(output.conditions, guards) ?
                  { ...output, [field]: value, conditions: [...new Set([...output.conditions, ...guards])] } : output));
              }
              const field = property === "OUTPUT_NAME" ? "value" : property === "RUNTIME_OUTPUT_NAME" ? "runtime" :
                property === "PREFIX" ? "prefix" : property === "SUFFIX" ? "suffix" : undefined;
              if (field && tools) for (const executable of tools) writeOutputs(executable, executable.outputNames.map((output) =>
                compatibleOwnerConditions(output.conditions, guards) ?
                  { ...output, [field]: value, conditions: [...new Set([...output.conditions, ...guards])] } : output));
            }
          }
        } else if (name === "install" && args[0] === "TARGETS") {
          const stop = args.findIndex((arg, at) => at > 0 && ["EXPORT", "DESTINATION", "RUNTIME", "LIBRARY", "ARCHIVE", "INCLUDES", "PUBLIC_HEADER", "PRIVATE_HEADER", "OBJECTS", "FILE_SET"].includes(arg));
          const names = args.slice(1, stop < 0 ? undefined : stop);
          const exportAt = args.indexOf("EXPORT");
          const archive = args.some((arg, at) => arg === "ARCHIVE" && args[at + 1] === "DESTINATION" && args[at + 2] && !args[at + 2].includes("$"));
          for (const n of names) {
            for (const item of targets.get(n) || []) item.installs.push({ source, conditions: guards, ...(archive ? { archive: true } : {}) });
            for (const tool of executables.get(n) || []) tool.installs.push({ source, conditions: guards });
          }
          if (exportAt >= 0) exportSets.set(args[exportAt + 1], [...(exportSets.get(args[exportAt + 1]) || []), ...names]);
        } else if (name === "install" && args[0] === "EXPORT") {
          const namespace = args.includes("NAMESPACE") ? args[args.indexOf("NAMESPACE") + 1] : "";
          for (const n of exportSets.get(args[1]) || []) for (const item of targets.get(n) || []) {
            for (const install of item.installs) {
              if (!compatibleOwnerConditions(item.conditions, install.conditions) ||
                !compatibleOwnerConditions([...item.conditions, ...install.conditions], guards)) continue;
              add("target", `${namespace}${item.properties.get("EXPORT_NAME") || n}`, source, [...new Set([...item.conditions, ...install.conditions, ...guards])]);
            }
          }
        } else if (name === "rocm_export_targets") {
          const nameAt = args.indexOf("NAME");
          add("cmake-package", nameAt >= 0 ? args[nameAt + 1] : env.get("PROJECT_NAME")?.toLowerCase(), source, guards);
          const at = args.indexOf("TARGETS");
          if (at >= 0) for (const n of args.slice(at + 1)) {
            if (["NAME", "NAMESPACE", "DEPENDS", "STATIC_DEPENDS", "INCLUDE", "EXPORT"].includes(n)) break;
            const matching = targets.get(n) || [...targets.values()].flat().filter((target) => target.aliases.some((alias) => alias.name === n));
            for (const item of matching) if (compatibleOwnerConditions(item.conditions, guards)) {
              item.installs.push({ source, conditions: guards });
              add("target", n, source, [...new Set([...item.conditions, ...guards])]);
            }
          }
        } else if (name === "file" && args[0] === "WRITE" && args[1] && !args[1].includes("$")) {
          const path = resolve(env.get("CMAKE_CURRENT_BINARY_DIR") || directory, args[1]);
          if (!inside(directory, path)) continue;
          const content = args.slice(2).some((arg) => arg.includes("$")) ? undefined : args.slice(2).join("");
          for (const branch of outputBranches) if (!branch.generatedInitial.has(path)) branch.generatedInitial.set(path, generatedFiles.get(path) || []);
          generatedFiles.set(path, [{ content, source, conditions: guards }]);
        } else if (name === "file" && args[0] === "TO_NATIVE_PATH" && args.length === 3) {
          env.set(args[2], args[1]);
        } else if (name === "execute_process" && args[0] === "COMMAND" && compilerInvocation(command) &&
          !args.slice(1).some((arg) => ["COMMAND", "-E", "-S", "-c", "-shared"].includes(arg))) {
          const at = args.indexOf("-o");
          const output = at > 2 && providerGeneratedPath(args[at + 1], env.get("CMAKE_CURRENT_BINARY_DIR") || directory, directory);
          if (!output) continue;
          const marker = /^\$<provider-source-path:(\d+)>$/.exec(args[2]);
          const sources = marker ? sourceAlternatives[Number(marker[1])] || [] : [{ path: args[2], conditions: [] }];
          for (const material of sources) {
            if (!material.path || material.path.includes("$") || !/\.(?:c|cc|cpp|cxx)$/.test(material.path) ||
              !compatibleOwnerConditions(material.conditions, guards)) continue;
            const path = resolve(env.get("CMAKE_CURRENT_SOURCE_DIR") || dirname(file), material.path);
            if (!inside(directory, path)) continue;
            const outputs = producerReplay?.compiledPrograms || compiledPrograms;
            if (!outputs.has(output)) outputs.set(output, []);
            outputs.get(output).push({ path, source, conditions: [...new Set([...guards, ...material.conditions])] });
            observableState.revision++;
          }
        } else if (["add_custom_target", "add_custom_command"].includes(name)) {
          // For a custom alias the source must be a known executable target,
          // and the literal destination must be a declared output or a
          // post-build action for that exact target. No command is executed.
          if (name === "add_custom_command") {
            const output = args[0] === "OUTPUT" ? args[1] : undefined;
            const postBuild = args[0] === "TARGET" && args[2] === "POST_BUILD" ? args[1] : undefined;
            for (let at = args.indexOf("COMMAND"); at >= 0; at = args.indexOf("COMMAND", at + 1)) {
              if (!cmakeCommand(args[at + 1]) || args[at + 2] !== "-E" || !copyOperations.has(args[at + 3])) continue;
              const target = targetFile(args[at + 4]);
              const destination = args[at + 5];
              if (!destination || output !== destination && (!target || target !== postBuild)) continue;
              const filename = literalToolOutput(basename(destination));
              if (!safeMember(filename)) continue;
              const base = env.get("CMAKE_CURRENT_BINARY_DIR") || directory;
              const path = providerGeneratedPath(literalToolOutput(destination), base, directory);
              if (!path && !destination.includes("$")) continue;
              if (!target) {
                const input = providerGeneratedPath(args[at + 4], base, directory);
                const depends = args.indexOf("DEPENDS");
                if (input && path && depends >= 0 && args.slice(depends + 1).includes(args[at + 4])) {
                  (producerReplay?.fileCopies || fileCopies).push({ input, path, filename, source, conditions: guards });
                }
                continue;
              }
              if (producerReplay) continue;
              const local = path && !path.includes("$") && inside(base, path) ? relative(base, path).replace(/\\/g, "/") : undefined;
              executableCopies.push({ target, filename, local, source, conditions: guards, hasPlatformSuffix: filename !== basename(destination) });
            }
          }
          if (producerReplay) continue;
          const copies = new Map();
          for (let at = 0; at < args.length; at++) {
            if (args[at] === "copy_directory" && args[at - 1] === "-E" && args[at + 1] && args[at + 2] && !args[at + 1].includes("$") && !args[at + 2].includes("$")) copies.set(resolve(directory, args[at + 2]), resolve(directory, args[at + 1]));
            if (args[at] === "cmd" && args[at + 1] === "/c") {
              const copy = args[at + 2]?.match(/^xcopy "([^"]+)" "([^"]+)" (?:\/[EIYCH] ?)+$/i);
              if (copy) copies.set(resolve(directory, copy[2]), resolve(directory, copy[1]));
            }
            if (!/^(?:powershell|pwsh)(?:\.exe)?$/i.test(basename(args[at]))) continue;
            const end = args.indexOf("COMMAND", at + 1);
            const invocation = args.slice(at + 1, end < 0 ? undefined : end);
            const fileAt = invocation.indexOf("-File");
            const scriptPath = fileAt >= 0 && invocation[fileAt + 1];
            const argument = fileAt >= 0 && invocation[fileAt + 2];
            if (!scriptPath || !argument || invocation.length !== fileAt + 3 || scriptPath.includes("$") || argument.includes("$")) continue;
            const scriptFile = resolve(directory, scriptPath);
            if (!inside(scanRoot, scriptFile)) continue;
            const script = metadata(scriptFile);
            const parsed = script !== undefined && literalPsMesonTransform(script);
            if (!parsed) continue;
            const input = resolve(directory, argument);
            const sourceDirectory = copies.get(input) || input;
            if (sourceDirectory.includes("$") || !inside(scanRoot, sourceDirectory)) continue;
            const wrapFile = join(sourceDirectory, "subprojects", `${parsed.packageName}.wrap`);
            const wrap = metadata(wrapFile);
            const wrapDirectory = wrap?.match(/^directory\s*=\s*([A-Za-z0-9_.+-]+)\s*$/m)?.[1];
            const archiveSha256 = wrap?.match(/^source_hash\s*=\s*([a-f0-9]{64})\s*$/im)?.[1].toLowerCase();
            const sourceUrl = wrap?.match(/^source_url\s*=\s*(https:\/\/\S+)\s*$/m)?.[1];
            if (!wrapDirectory || !archiveSha256 || !sourceUrl) continue;
            const id = JSON.stringify([scriptFile, sourceDirectory, guards]);
            ownerReads?.block("staging-dedup");
            if (stagedKeys.has(id)) continue;
            stagedKeys.add(id);
            stagedTransforms.push({ ...parsed, scriptFile, scriptSha256: createHash("sha256").update(script).digest("hex"),
              wrapFile, wrapDirectory, archiveSha256, sourceUrl, source, conditions: guards });
          }
        } else if (["configure_package_config_file", "configure_file", "write_basic_package_version_file"].includes(name)) {
          const output = args[name === "write_basic_package_version_file" ? 0 : 1];
          const versionAt = args.indexOf("VERSION");
          exportConfig(output, source, guards, args[0], env, name === "configure_file" && !args.includes("@ONLY"));
          if (configDeclarations && name === "configure_package_config_file" && args.includes("INSTALL_DESTINATION")) {
            const path = standaloneConfigFile(output, env.get("CMAKE_CURRENT_BINARY_DIR"));
            if (path) {
              if (!configDeclarations.has(path)) configDeclarations.set(path, []);
              configDeclarations.get(path).push({ source, guards });
            }
          }
          if (name === "configure_file" && args[0] && !args[0].includes("$")) {
            const path = providerGeneratedPath(output, env.get("CMAKE_CURRENT_BINARY_DIR") || dirname(file), directory);
            const programInput = resolve(env.get("CMAKE_CURRENT_SOURCE_DIR") || dirname(file), args[0]);
            if (inside(directory, programInput) && args[0].endsWith(".in") && typeof output === "string") {
              const name = basename(output);
              const variant = /^\$<provider-filename:(\d+)>$/.exec(name);
              for (const candidate of variant ? filenameAlternatives[Number(variant[1])] || [] : [{ name, conditions: [] }]) {
                if (safeMember(candidate.name) && compatibleOwnerConditions(candidate.conditions, guards)) {
                  configuredPrograms.push({ ...candidate, path, input: programInput, source, conditions: [...new Set([...candidate.conditions, ...guards])] });
                }
              }
            }
            if (path && inside(directory, programInput)) {
              for (const branch of outputBranches) if (!branch.generatedInitial.has(path)) branch.generatedInitial.set(path, generatedFiles.get(path) || []);
              generatedFiles.set(path, [{ programInput, source, conditions: guards }]);
            }
          }
          if (name === "write_basic_package_version_file" && versionAt >= 0) {
            const packageName = basename(output || "").match(/^(.+?)(?:-config-version|ConfigVersion)\.cmake$/)?.[1];
            const declared = args[versionAt + 1];
            const modeAt = args.indexOf("COMPATIBILITY");
            if (packageName && /^\d+(?:\.\d+)*$/.test(declared || "")) {
              const k = packageName.toLowerCase();
              const evidence = { interfaceVersion: declared, interfaceVersionSource: source,
                compatibilityMode: modeAt >= 0 ? args[modeAt + 1] : "AnyNewerVersion" };
              if (!configInterfaces.has(k)) configInterfaces.set(k, []);
              configInterfaces.get(k).push({ ...evidence, conditions: guards });
            } else if (packageName) {
              const k = packageName.toLowerCase();
              if (!configInterfaces.has(k)) configInterfaces.set(k, []);
              configInterfaces.get(k).push({ interfaceVersionUnknown: true, interfaceVersionSource: source, conditions: guards,
                compatibilityMode: modeAt >= 0 ? args[modeAt + 1] : "AnyNewerVersion" });
            }
          }
        } else if (name === "install" && (args[0] === "PROGRAMS" || args[0] === "FILES" && programPermissions(args, args.indexOf("PERMISSIONS")))) {
          const stop = args.findIndex((arg, at) => at > 0 && installControls.has(arg));
          const members = args.slice(1, stop < 0 ? undefined : stop);
          const renameAt = args.indexOf("RENAME");
          const rename = renameAt >= 0 ? args[renameAt + 1] : undefined;
          const permissionsAt = args.indexOf("PERMISSIONS");
          const destination = args[args.indexOf("DESTINATION") + 1]?.replace(/^\.\//, "");
          if (renameAt >= 0 && (members.length !== 1 || !identity(rename))) continue;
          if (permissionsAt >= 0 && !programPermissions(args, permissionsAt)) continue;
          for (const member of members) {
            const path = providerGeneratedPath(member, env.get("CMAKE_CURRENT_SOURCE_DIR") || dirname(file), directory);
            if (!path) continue;
            const name = rename || basename(path);
            programInstalls.push({ path, name, source, conditions: guards, relativeName: destination && `${destination}/${name}` });
          }
        } else if (name === "install" && args[0] === "FILES") {
          const destinationAt = args.indexOf("DESTINATION");
          const destination = destinationAt >= 0 ? args[destinationAt + 1] : undefined;
          for (const arg of args.slice(1)) {
            if (installControls.has(arg)) break;
            exportConfig(arg, source, guards, arg, env);
            if (configInstalls && destination && !destination.includes("\0") && !args.includes("RENAME")) {
              // In install(FILES) a relative argument belongs to the source
              // tree, unlike configure_package_config_file's relative output.
              const path = standaloneConfigFile(arg);
              if (path) configInstalls.push({ path, source, guards, destination });
            }
            if (destination && /\.(?:h|hh|hpp|hxx|cuh)$/.test(arg) && !arg.includes("$")) {
              const path = resolve(env.get("CMAKE_CURRENT_SOURCE_DIR") || dirname(file), arg);
              const renameAt = args.indexOf("RENAME");
              const name = renameAt >= 0 ? args[renameAt + 1] : basename(arg);
              const include = destination.split("/");
              const includeAt = include.lastIndexOf("include");
              const installedName = includeAt >= 0 ? [...include.slice(includeAt + 1), name].join("/") : name;
              if (inside(directory, path) && safeMember(installedName)) headerInstalls.push({ path, name, installedName, source, conditions: guards });
            }
            if (!destination || destination.includes("$") || arg.includes("$")) continue;
            const path = resolve(env.get("CMAKE_CURRENT_BINARY_DIR") || directory, arg);
            const renameAt = args.indexOf("RENAME");
            const name = `${destination}/${renameAt >= 0 ? args[renameAt + 1] : basename(arg)}`.replace(/^\.\//, "");
            generatedInstalls.push({ path, name, source, conditions: [...guards] });
          }
        } else if (name === "install" && args[0] === "DIRECTORY") {
          const controls = new Set(["DESTINATION", "FILE_PERMISSIONS", "DIRECTORY_PERMISSIONS", "USE_SOURCE_PERMISSIONS", "OPTIONAL", "MESSAGE_NEVER", "CONFIGURATIONS", "COMPONENT", "EXCLUDE_FROM_ALL", "FILES_MATCHING", "PATTERN", "REGEX"]);
          const filters = [];
          for (let at = 1; at < args.length - 1; at++) if (["PATTERN", "REGEX"].includes(args[at])) {
            const regex = args[at] === "REGEX";
            const pattern = providerInstallPattern(args[++at], regex);
            filters.push({ pattern, regex, exclude: args[at + 1] === "EXCLUDE" });
          }
          if (filters.some((filter) => filter.pattern === undefined)) {
            diagnostics.push({ directory, source, reason: "unsupported-install-filter" });
            continue;
          }
          for (const payload of args.slice(1)) {
            if (controls.has(payload)) break;
            if (!payload || payload.includes("$")) continue;
            const path = resolve(env.get("CMAKE_CURRENT_SOURCE_DIR") || dirname(file), payload);
            if (!inside(directory, path)) continue;
            let installed = installPayloadFiles.get(path);
            if (!installed) {
              installed = manifests ? (manifestsByOwner.get(directory) || []).filter((candidate) => inside(path, candidate)) : [];
              // Source manifest lists describe build scripts, not all installed
              // headers. Authenticated cache records, in contrast, are closed
              // member sets and must never gain filesystem-adjacent payloads.
              if (!resolutionInputs.sourceTextsOnly) {
                const found = new Set(installed);
                const visit = (parent, depth = 0) => {
                  if (depth > 16 || installedEntries >= 20000) return;
                  let children;
                  try { children = listOwnerDirectory(parent); } catch { return; }
                  for (const child of children) {
                    if (++installedEntries > 20000) { diagnostics.push({ directory, source, reason: "install-payload-budget" }); return; }
                    const candidate = join(parent, child.name);
                    if (independentDirectories.has(candidate) && candidate !== directory) continue;
                    if (child.isDirectory()) visit(candidate, depth + 1);
                    else if (child.isFile() && /(?:\.(?:h|hh|hpp|hxx|cuh)|(?:Config|-config)(?:Version|-version)?\.cmake(?:\.in)?|\.pc(?:\.in)?)$/.test(child.name) && !found.has(candidate)) {
                      found.add(candidate);
                      installed.push(candidate);
                    }
                  }
                };
                visit(path);
              }
              installPayloadFiles.set(path, installed);
            }
            for (const candidate of installed) {
              const local = relative(path, candidate).split("\\").join("/");
              const matches = (filter) => filter.regex || filter.pattern.includes("/") ? providerGlobMatches(local, filter.pattern) :
                local.split("/").some((part) => providerGlobMatches(part, filter.pattern));
              if (filters.some((filter) => filter.exclude && matches(filter))) continue;
              if (args.includes("FILES_MATCHING") && !filters.some((filter) => !filter.exclude && matches(filter))) continue;
              exportConfig(candidate, `${candidate}:1`, [...guards, `install(${source})`], candidate, env);
              if (/\.(?:h|hh|hpp|hxx|cuh)$/.test(candidate)) {
                const destination = args[args.indexOf("DESTINATION") + 1] || "";
                const includeAt = destination.split("/").lastIndexOf("include");
                const prefix = includeAt >= 0 ? destination.split("/").slice(includeAt + 1) : [];
                const installedName = [...prefix, ...(!/[\\/]$/.test(payload) ? [basename(path)] : []), local].filter(Boolean).join("/");
                const evidence = { materialUnknown: true, installationSource: source };
                add("header-file", installedName, `${candidate}:1`, guards, true, undefined, evidence);
                add("header-file", basename(candidate), `${candidate}:1`, guards, true, undefined, evidence);
              }
            }
          }
        } else if (!scopedReplay && definitions.has(name)) {
          const definition = definitions.get(name);
          if ((definition.localPrograms?.length || definition.scopedPrograms?.length) && !definition.invoked) {
            definition.invoked = true;
            observableState.revision++;
          }
          const speculative = manifests && guards.length > 0 && args.some((arg) => /\$\{|\$<unknown:|\$<provider-/.test(arg));
          const priorCallCount = speculative ? uncertainCalls.get(definition) || 0 : 0;
          if (priorCallCount >= 2) {
            diagnostics.push({ directory, file, source, reason: "dynamic-helper-recursion" });
            continue;
          }
          const slice = providerHelperSlice(definition, definitions);
          // Macros modify caller variables and direct PARENT_SCOPE writes
          // escape functions. Unindexed scans also retain their budget effects.
          if (manifests && !definition.macro &&
            !definition.body.some((item) => ["set", "unset"].includes(item.name) && item.args.includes("PARENT_SCOPE")) &&
            !providerHelperHasEffects(definition, definitions)) continue;
          // Macro arguments are substitutions, not bindings in the caller's
          // variable scope. Ordinary function arguments are local variables.
          const local = definition.macro ? env : new ProviderEnvironment(env);
          let bindings = definition.argumentBindings;
          if (definition.macro) {
            const own = definition.parameters.map((parameter, at) => [parameter, args[at] || ""]);
            own.push(["ARGC", String(args.length)], ["ARGN", args.slice(definition.parameters.length).join(";")], ["ARGV", args.join(";")]);
            args.forEach((value, index) => own.push([`ARGV${index}`, value]));
            // Apply captured definition-site substitutions before this call's
            // substitutions, without intercepting later indirect variable reads.
            bindings = bindings ? [...bindings, ...own] : own;
          } else {
            definition.parameters.forEach((parameter, at) => local.set(parameter, args[at] || ""));
            local.set("ARGN", args.slice(definition.parameters.length).join(";"));
            local.set("ARGV", args.join(";"));
            local.set("ARGC", String(args.length));
            args.forEach((value, index) => local.set(`ARGV${index}`, value));
          }
          const writes = definition.macro ? parentWrites : new Map();
          // Function PARENT_SCOPE writes return into this guarded caller path;
          // its branch join handles uncertainty. Macro writes escape that path.
          const callUncertain = uncertain || Boolean(continuationGuards.length) || branches.some((branch) => !branch.knownTrue);
          // Only parent writes escape an ordinary function; its local flow and
          // returned environments need not be retained. Macros still execute
          // normally, including their caller-local and parent-scope writes.
          // Their enclosing function is admitted only if the same transitive
          // observable-state and definition-revision guards remain unchanged.
          let summaries;
          if (!definition.macro && resolutionInputs.nativeProviderMemoization !== false) {
            // Every stored summary belongs to one definition-graph revision.
            // Old revisions cannot be reused, so they must not consume the
            // current generation's storage allowance.
            if (summaryRevision !== definitions.revision) {
              helperSummaries = new WeakMap();
              summaryCount = 0;
              summaryRevision = definitions.revision;
            }
            summaries = helperSummaries.get(definition);
            if (!summaries) helperSummaries.set(definition, summaries = []);
          }
          let reused = false;
          if (summaries) for (const summary of summaries) {
            if (summary.depth !== depth || summary.uncertain !== callUncertain ||
              summary.file !== file ||
              summary.findModule !== activeFindModule || summary.findFile !== activeFindFile ||
              summary.bindings !== bindings || summary.args.length !== args.length ||
              summary.args.some((value, index) => value !== args[index]) ||
              summary.active.length !== active.size || summary.active.some((path) => !active.has(path)) ||
              commandCount + summary.commands > commandLimit ||
              !local.matchesInputs(summary.inputs)) continue;
            local.observeInputs(summary.inputs);
            commandCount += summary.commands;
            for (const [key, value] of summary.writes) writes.set(key, value);
            reused = true;
            break;
          }
          let flow;
          if (!reused) {
            const store = summaries && summaries.length < 64 && summaryCount < 2048;
            const inputs = store ? new Map() : undefined;
            if (inputs) local.observeReads(inputs, observableState);
            const beforeCommands = commandCount;
            const beforeDiagnostics = diagnostics.length;
            const beforeDefinitions = definitions.revision;
            const beforeObservable = observableState.revision;
            const beforeBranchDepth = outputBranches.length;
            const beforeBranch = outputBranches.at(-1);
            if (speculative) uncertainCalls.set(definition, priorCallCount + 1);
            scopedInvocations?.push(source);
            try {
              flow = evaluate(slice, definition.file, local,
                [...guards, ...(definition.conditions || []), `call(${source})`], depth + 1, writes,
                definition.macro && callUncertain, 0, bindings);
            } finally {
              scopedInvocations?.pop();
            }
            if (speculative) {
              if (priorCallCount) uncertainCalls.set(definition, priorCallCount);
              else uncertainCalls.delete(definition);
            }
            // Nested calls may fill the pool after the initial store check.
            if (store && summaries.length < 64 && summaryCount < 2048 &&
              diagnostics.length === beforeDiagnostics && definitions.revision === beforeDefinitions &&
              observableState.revision === beforeObservable && outputBranches.length === beforeBranchDepth &&
              outputBranches.at(-1) === beforeBranch) {
              summaries.push({ depth, uncertain: callUncertain, file,
                findModule: activeFindModule, findFile: activeFindFile, bindings, args: [...args], active: [...active],
                inputs: [...inputs.values()], writes: [...writes], commands: commandCount - beforeCommands });
              summaryCount++;
            }
          }
          if (definition.macro) {
            if (carryFlow(flow) === 2) return flowResult(true);
          } else for (const [key, value] of writes) value === undefined ? env.delete(key) : env.set(key, value);
        }
      }
      if (continuationGuards.length || returnedStates || propagated) return flowResult();
    };
    const visitCmake = (file, inherited, conditions = [], depth = 0, parentWrites = new Map(), uncertain = false,
      directoryScope = basename(file) === "CMakeLists.txt") => {
      if (active.has(file) || !manifests && ++fileCount > 2048 || !inside(scanRoot, file) && !builtinFiles.has(file) ||
        basename(file) === "CMakeLists.txt" && !inside(directory, file)) return;
      const text = metadata(file);
      if (manifests && depth === 0) commandLimit = commandCount + 80000;
      if (text === undefined || standaloneCmake && text.includes("\0")) return;
      active.add(file);
      if (basename(file) === "CMakeLists.txt") visitedManifests.add(file);
      const env = inherited;
      const oldList = env.get("CMAKE_CURRENT_LIST_DIR");
      const oldSource = env.get("CMAKE_CURRENT_SOURCE_DIR");
      const oldBinary = env.get("CMAKE_CURRENT_BINARY_DIR");
      const outputDepth = outputBranches.length;
      if (directoryScope) {
        const sourceDir = dirname(file);
        env.set("CMAKE_CURRENT_SOURCE_DIR", sourceDir);
        const child = standaloneCmake && relative(directory, sourceDir).replaceAll("\\", "/");
        env.set("CMAKE_CURRENT_BINARY_DIR", standaloneCmake ? child ? `${standaloneBinaryPrefix}${child}` : standaloneBinaryRoot : sourceDir);
      }
      if (scopedLookups?.has(file)) visitedScopedLookups.add(file);
      const flow = evaluate(commandsOf(file), file, env, conditions, depth, parentWrites, uncertain);
      // An over-budget traversal can exit with incomplete conditional frames.
      outputBranches.length = Math.min(outputBranches.length, outputDepth);
      if (flow?.states?.length) {
        const states = flow.returned ? flow.states : [...flow.states, new ProviderEnvironment(env)];
        env.restore(states[0]);
        const keys = new Set(states.flatMap((state) => [...state.keys()]));
        for (const key of keys) {
          const value = states[0].get(key);
          if (!states.every((state) => state.get(key) === value)) env.set(key, `$<unknown:${key}>`);
          else if (value === undefined) env.delete(key);
          else env.set(key, value);
        }
      }
      env.set("CMAKE_CURRENT_LIST_DIR", oldList || directory);
      env.set("CMAKE_CURRENT_SOURCE_DIR", oldSource || directory);
      if (oldBinary === undefined) env.delete("CMAKE_CURRENT_BINARY_DIR");
      else env.set("CMAKE_CURRENT_BINARY_DIR", oldBinary);
      active.delete(file);
    };
    if (!contractFiles) visitCmake(join(directory, "CMakeLists.txt"), initial);
    for (const file of contractFiles || standaloneCmake ? [] : manifestsByOwner.get(directory) || []) if (basename(file) === "CMakeLists.txt" && !visitedManifests.has(file)) {
      visitCmake(file, new ProviderEnvironment(initial), ["source-manifest-available"], 0);
    }
    for (const file of scopedOwnerFiles || []) {
      if (visitedScopedLookups.has(file) || !file.endsWith(".cmake")) continue;
      if (/^Find.+\.cmake$/.test(basename(file))) continue; // Replayed by the existing Find collector.
      const commands = commandsOf(file);
      const locals = new ProviderEnvironment([["CMAKE_CURRENT_LIST_DIR", dirname(file)]]);
      // Unreached helper definitions can establish a source-default path.
      // Replay only local path declarations and lexical control; never run
      // included code, subprocesses, or package/install logic here.
      const declarations = commands.filter(({ name }) => scopedLookupProjection.has(name));
      for (const { name, args } of declarations) if (name === "get_filename_component" && args.length === 3 && args[2] === "ABSOLUTE" &&
        args[1].startsWith("${CMAKE_CURRENT_LIST_DIR}/")) locals.set(args[0], `$<unknown:${args[0]}>`);
      const depth = outputBranches.length;
      scopedReplay = true;
      try {
        evaluate(declarations, file, locals, ["source-lookup-available"]);
      } finally {
        scopedReplay = false;
        outputBranches.length = Math.min(outputBranches.length, depth);
      }
    }
    // These contracts describe source recipes, not finder satisfaction or
    // materialized configs. Their evidence kind is not a package export key.
    if (configInstalls) for (const install of configInstalls) {
      const name = basename(install.path).match(/^(.+?)(?:-config|Config)\.cmake$/)?.[1];
      if (!name) continue;
      for (const generated of configDeclarations.get(install.path) || []) {
        if (!compatibleOwnerConditions(generated.guards, install.guards)) continue;
        add("cmake-config-install-contract", name, generated.source, [...new Set([...generated.guards, ...install.guards])], false,
          undefined, { sourceDeclared: true, materialUnknown: true, interfaceVersionUnknown: true,
            installationSource: install.source, installDestination: install.destination });
      }
    }
    // Install rules name files, not snapshots of their bytes at declaration
    // time. Resolve generated payloads only after this owner is configured.
    for (const install of generatedInstalls) for (const generated of generatedFiles.get(install.path) || []) {
      if (generated.programInput || !compatibleOwnerConditions(install.conditions, generated.conditions)) continue;
      const full = generated.content?.trim();
      const version = full?.match(/^(?:\d+:)?(\d+\.\d+\.\d+)[0-9A-Za-z.+_~:-]*$/)?.[1];
      add("data-file", install.name, generated.source, [...new Set([...generated.conditions, ...install.conditions])], true, version, {
        materialUnknown: true, interfaceVersionUnknown: !version, installationSource: install.source,
        ...(version ? { generatedVersion: full, generatedSha256: createHash("sha256").update(generated.content).digest("hex") } : {}),
      });
    }
    const verifiedPayloads = new Map();
    const ownedPayload = (path) => {
      if (path.includes("$")) return undefined;
      if (verifiedPayloads.has(path)) return verifiedPayloads.get(path);
      let real = path;
      if (!resolutionInputs.sourceTextsOnly) {
        try { real = realpathSync(path); } catch (error) {
          real = undefined;
          if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") ownerReads?.block("unclassified-realpath");
        }
        ownerReads?.capture("realpath", path, real);
      }
      let owned = Boolean(real && inside(directory, real));
      if (owned) for (let parent = dirname(real); parent !== directory; parent = dirname(parent)) {
        if (independentDirectories.has(parent) || parent === dirname(parent)) { owned = false; break; }
      }
      let prefix;
      if (owned && resolutionInputs.sourceTextsOnly) prefix = metadata(path)?.slice(0, 256);
      else if (owned) {
        // Install declarations need member existence and, for script-only
        // inferences, a tiny header. A large script is not build metadata.
        const opened = openRegularFile(path, directory);
        if (opened) {
          try {
            const bytes = Buffer.allocUnsafe(Math.min(256, opened.size));
            prefix = bytes.toString("utf8", 0, readSync(opened.fd, bytes, 0, bytes.length, 0));
          } catch { /* unreadable material */ } finally { closeSync(opened.fd); }
        }
        ownerReads?.capture("payload", path, prefix);
      }
      verifiedPayloads.set(path, prefix);
      return prefix;
    };
    for (const header of headerInstalls) {
      if (ownedPayload(header.path) === undefined) continue;
      const evidence = { materialUnknown: true, installationSource: header.source };
      add("header-file", header.installedName, `${header.path}:1`, header.conditions, true, undefined, evidence);
      if (header.installedName !== header.name) add("header-file", header.name, `${header.path}:1`, header.conditions, true, undefined, evidence);
    }
    const installedProgramPaths = new Set(programInstalls.map((entry) => entry.path));
    for (const configured of configuredPrograms) {
      if (installedProgramPaths.has(configured.path)) continue;
      const text = ownedPayload(configured.input);
      if (!text?.startsWith("#!") && !(configured.name.endsWith(".cmd") && /^\s*@?echo\s+off\b/i.test(text || ""))) continue;
      add("tool", configured.name, configured.source, configured.conditions, true, undefined,
        { executableUnknown: true, templateSource: configured.input });
    }
    const publishLocalProgram = (local) => {
      if (!ownedPayload(local.path)?.startsWith("#!")) return;
      try {
        if (process.platform !== "win32") {
          const mode = lstatSync(local.path).mode & 0o111;
          ownerReads?.capture("mode", local.path, mode);
          if (!mode) return;
        }
      } catch { ownerReads?.block("unclassified-mode"); return; }
      add("tool", local.member, `${local.path}:1`, local.conditions, false, undefined, { executableUnknown: true, lookupSource: local.source });
    };
    for (const local of localPrograms) publishLocalProgram(local);
    for (const definition of templateDefinitions || []) if (!definition.invoked) {
      for (const local of definition.localPrograms || []) publishLocalProgram(local);
      for (const lookup of definition.scopedPrograms || []) recordScopedPrograms(...lookup);
    }
    const publishCompiledCopies = (copies, programs, replay) => {
      for (const copy of copies) for (const compiled of programs.get(copy.input) || []) {
        if (ownedPayload(compiled.path) === undefined || !compatibleOwnerConditions(compiled.conditions, copy.conditions)) continue;
        let sourceRevision;
        // A release/revision on the parent is not proof of the actual child
        // declaration or compiler input. Verify the three exact members once.
        // Authenticated archive collection already restricts all three reads
        // to its verified member set rather than the neighboring filesystem.
        if (replay && !resolutionInputs.sourceTextsOnly) {
          const parent = revisionOfProducerFile(replay.file);
          if (!parent || !memberAtRevision(replay.file, parent) || !memberAtRevision(replay.childFile, parent) ||
            !memberAtRevision(compiled.path, parent)) continue;
          sourceRevision = parent.version;
        }
        add("tool", copy.filename, `${compiled.path}:1`, [...new Set([...compiled.conditions, ...copy.conditions])], true, undefined,
          { executableUnknown: true, compilerSource: compiled.source, executableCopySource: copy.source,
            ...(replay ? { subdirectoryReplaySource: replay.source } : {}), ...(sourceRevision ? { sourceRevision } : {}) });
      }
    };
    publishCompiledCopies(fileCopies, compiledPrograms);
    for (const replay of producerReplays) publishCompiledCopies(replay.fileCopies, replay.compiledPrograms, replay);
    for (const copy of fileCopies) {
      if (!installedProgramPaths.has(copy.path) || ownedPayload(copy.input) === undefined) continue;
      // A file copy can feed an executable install; a plain data copy does
      // not independently prove a build tool.
      if (!generatedFiles.has(copy.path)) generatedFiles.set(copy.path, []);
      generatedFiles.get(copy.path).push({ programInput: copy.input, source: copy.source, conditions: copy.conditions });
    }
    for (const install of programInstalls) {
      const generated = generatedFiles.get(install.path);
      const evidence = { executableUnknown: true, installationSource: install.source };
      const publish = (source, guards) => {
        add("tool", install.name, source, guards, true, undefined, evidence);
        if (install.relativeName && install.relativeName !== install.name) {
          add("tool", install.relativeName, source, guards, true, undefined, evidence);
        }
      };
      if (ownedPayload(install.path) !== undefined) publish(`${install.path}:1`, install.conditions);
      for (const candidate of generated || []) {
        if (!compatibleOwnerConditions(install.conditions, candidate.conditions) ||
          !(candidate.programInput ? ownedPayload(candidate.programInput) !== undefined : candidate.content !== undefined)) continue;
        publish(candidate.source, [...new Set([...candidate.conditions, ...install.conditions])]);
      }
    }
    for (const copy of executableCopies) {
      const publish = (source, conditions, attributes = {}) => {
        if (!compatibleOwnerConditions(conditions, copy.conditions)) return;
        const guards = [...new Set([...conditions, ...copy.conditions])];
        const evidence = { executableUnknown: true, executableCopySource: copy.source, ...attributes };
        add("tool", copy.filename, source, guards, true, undefined, evidence);
        if (copy.hasPlatformSuffix && nativeProviderPlatformAccepts({ platform: "win32" }, { conditions: guards })) {
          add("tool", `${copy.filename}.exe`, source, guards, true, undefined, { ...evidence, artifactPlatform: "win32" });
        }
        if (copy.local && copy.local !== copy.filename) add("tool", copy.local, source, guards, true, undefined, evidence);
      };
      const emitTarget = (name, alias) => {
        const aliasGuards = alias?.conditions || [];
        const evidence = alias ? { executableAliasSource: alias.source } : undefined;
        for (const item of executables.get(name) || []) for (const output of item.outputNames) {
          if (!compatibleOwnerConditions(output.conditions, aliasGuards)) continue;
          publish(item.source, [...output.conditions, ...aliasGuards], evidence);
        }
        for (const item of importedExecutables.get(name) || []) for (const location of item.locations) {
          if (!compatibleOwnerConditions(location.conditions, aliasGuards) || !ownedPayload(location.path)?.startsWith("#!")) continue;
          publish(`${location.path}:1`, [...location.conditions, ...aliasGuards], { ...evidence, importedLocationSource: location.source });
        }
      };
      emitTarget(copy.target);
      for (const alias of executableAliases.get(copy.target) || []) emitTarget(alias.target, alias);
    }
    for (const declarations of executables.values()) for (const item of declarations) {
      for (const output of item.outputNames) {
        const name = `${output.prefix ?? ""}${output.runtime ?? output.value}${output.suffix ?? ""}`;
        for (const install of item.installs) {
          if (!compatibleOwnerConditions(output.conditions, install.conditions)) continue;
          const conditions = [...new Set([...output.conditions, ...install.conditions])];
          const evidence = { executableUnknown: true, installationSource: install.source,
            ...(output.wrapperSource ? { wrapperSource: output.wrapperSource } : {}) };
          add("tool", name, item.source, conditions, true, undefined, evidence);
          if (output.suffix === undefined && !name.endsWith(".exe") && nativeProviderPlatformAccepts({ platform: "win32" }, { conditions })) {
            add("tool", `${name}.exe`, item.source, conditions, true, undefined,
              { ...evidence, artifactPlatform: "win32" });
          }
        }
      }
    }
    for (const declarations of targets.values()) for (const item of declarations) {
      const installs = item.installs.filter((install) => compatibleOwnerConditions(item.conditions, install.conditions));
      for (const install of installs.length ? installs : [{ source: item.source, conditions: [] }]) {
        const combine = (guards) => [...new Set([...guards, ...install.conditions])];
        const installed = installs.length > 0;
        add("target", item.name, item.source, combine(item.conditions), installed);
        for (const alias of item.aliases) if (compatibleOwnerConditions(alias.conditions, install.conditions)) {
          add("target", alias.name, alias.source, combine(alias.conditions), installed);
        }
        for (const output of item.outputNames) {
          if (!compatibleOwnerConditions(output.conditions, install.conditions)) continue;
          const guards = combine(output.conditions);
          const linkage = item.kind === "STATIC" ? "static" : ["SHARED", "MODULE"].includes(item.kind) ? "shared" : undefined;
          const attributes = { sourceDeclared: true, ...(linkage ? { linkage } : {}),
            ...(output.wrapperSource ? { materialUnknown: true, wrapperSource: output.wrapperSource } : {}) };
          const value = (linkage === "static" ? output.archive : linkage === "shared" ? output.library : undefined) ?? output.value;
          add("library", value, install.source, guards, installed, undefined, attributes);
          const prefix = output.prefix ?? "lib";
          if (output.suffix !== undefined) add("library", `${prefix}${value}${output.suffix}`, install.source, guards, installed, undefined, attributes);
          else if (linkage === "static") {
            add("library", `${prefix}${value}.a`, install.source, [...guards, "if(NOT WIN32)"], installed, undefined, attributes);
          } else if (linkage === "shared") {
            add("library", `${prefix}${value}.so`, install.source, [...guards, "platform(ELF)"], installed, undefined, attributes);
            add("library", `${prefix}${value}.dylib`, install.source, [...guards, "if(APPLE)"], installed, undefined,
              { ...attributes, artifactPlatform: "darwin" });
          } else {
            if (output.archiveDefaultPossible && install.archive) {
              // An untyped add_library follows BUILD_SHARED_LIBS. A literal
              // archive installation supplies an available static alternative,
              // not evidence that the default or configured linkage was chosen.
              add("library", `${prefix}${output.archive ?? value}.a`, install.source,
                [...guards, "if(NOT BUILD_SHARED_LIBS)", "if(NOT WIN32)"], installed, undefined,
                { ...attributes, linkage: "static", materialUnknown: true });
            }
            if (output.prefix !== undefined) add("library", `${prefix}${value}`, install.source, guards, installed, undefined, attributes);
          }
        }
        for (const [name, value] of item.properties) if (/^(?:OUTPUT_NAME|LIBRARY_OUTPUT_NAME|ARCHIVE_OUTPUT_NAME)_[A-Z0-9_]+$/.test(name)) {
          add("library", value, install.source, [...combine(item.conditions), `target-property(${name})`], installed, undefined, { sourceDeclared: true });
        }
      }
    }
    const shippedPackage = !contractFiles && identity(facts[0].component.name) ? facts[0].component.name : undefined;
    const shippedName = shippedPackage?.toLowerCase();
    const shippedConfig = shippedName && `${shippedName}config.cmake`;
    const shippedDashConfig = shippedName && `${shippedName}-config.cmake`;
    const collectMetadata = (file) => {
      const name = basename(file);
      if (shippedName && name.endsWith(".cmake")) {
        const lower = name.toLowerCase();
        if ((lower === shippedConfig || lower === shippedDashConfig) &&
          relative(directory, dirname(file)).split("\\").join("/").toLowerCase() === `lib/cmake/${shippedName}`) {
          if (ownedPayload(file) !== undefined && commandsOf(file).length) {
            add("cmake-package", shippedPackage, `${file}:1`, ["source-package-config"], true, undefined,
              { sourceDeclared: true, materialUnknown: true, interfaceVersionUnknown: true });
          }
          return;
        }
      }
      if (!/\.(?:pc(?:\.in)?|wrap)$/.test(name) && !/^Find.+\.cmake$/.test(name) && name !== "meson.build") return;
      const text = metadata(file);
      if (text === undefined) return;
      if (name.endsWith(".wrap") && basename(dirname(file)) === "subprojects") {
        let section = "";
        let sourceDir = name.slice(0, -5);
        const aliases = [];
        for (const [index, line] of text.split(/\r?\n/).entries()) {
          const heading = line.trim().match(/^\[([^\]]+)\]$/);
          if (heading) { section = heading[1]; continue; }
          const field = line.trim().match(/^([A-Za-z0-9_.+-]+)\s*=\s*(.+)$/);
          if (!field) continue;
          if (["wrap-file", "wrap-git"].includes(section) && field[1] === "directory") sourceDir = field[2].trim();
          if (section === "provide" && field[1] !== "program_names") {
            const names = field[1] === "dependency_names" ? field[2].split(",").map((name) => name.trim()) : [field[1]];
            const dependencyVariable = field[1] !== "dependency_names" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(field[2].trim()) ? field[2].trim() : undefined;
            for (const alias of names) if (identity(alias)) aliases.push({ name: alias, source: `${file}:${index + 1}`, dependencyVariable });
          }
        }
        const ownerDirectory = resolve(dirname(file), sourceDir);
        if (inside(scanRoot, ownerDirectory)) wraps.push({ directory, ownerDirectory, aliases, file });
      } else if (/^Find.+\.cmake$/.test(name)) {
        const previous = activeFindModule;
        const previousFile = activeFindFile;
        const previousScope = activeFindScope;
        activeFindScope = !builtinFiles.has(file) && scopeDirectory !== directory && scopeDirectory !== scanRoot &&
          (modulesByName.get(name) || []).filter((candidate) => inside(scopeDirectory, candidate)).length === 1 ? scopeDirectory : undefined;
        activeFindFile = file;
        if (!builtinFiles.has(file)) rememberFindDefinition(name.slice(4, -6), directory);
        activeFindModule = name.slice(4, -6);
        visitCmake(file, new ProviderEnvironment(initial), ["find-module-available"], 0);
        const commands = commandsOf(file);
        const capabilities = new Set();
        for (const command of commands) {
          if (/^check_cxx_(?:source_compiles|source_runs|compiler_flag)$/.test(command.name)) capabilities.add("cxx-compiler");
          if (/^check_c_(?:source_compiles|source_runs|compiler_flag)$/.test(command.name)) capabilities.add("c-compiler");
        }
        if (capabilities.size && !commands.some((command) => ["find_library", "find_path", "find_file", "find_program"].includes(command.name))) compilerChecks.push({ name: activeFindModule, directory, source: `${file}:1`, capabilities: [...capabilities] });
        const { required, delegated, complex, checks, versionVariables } = providerFindRequirements(activeFindModule, commands);
        if (required.length || complex) {
          const contract = { required, source: `${file}:1`, complex, checks, versionVariables };
          findContracts.set(file, contract);
          evaluationWrites?.findContracts.push([file, contract]);
        }
        const dataSearches = providerDataFileSearches(commands, required);
        for (const search of dataSearches) findModules.push({ name: activeFindModule, moduleFile: file, builtinModule: builtinFiles.get(file),
          directory, source: `${file}:${search.line}`, destination: search.destination, scopeDirectory: activeFindScope,
          conditions: ["custom-data-file-predicate-unevaluated"], libraries: [], headers: [], programs: [], dataFiles: search.names });
        const nativeMaterials = commands.some((command) => ["find_library", "find_path", "find_file", "pkg_check_modules", "pkg_search_module"].includes(command.name));
        if (!dataSearches.length && !nativeMaterials && (delegated.length ||
          !commands.some((command) => command.name === "find_program") &&
          commands.some((command) => ["function", "macro", "find_package", "find_package_handle_standard_args"].includes(command.name)))) {
          add("build-helper", activeFindModule, `${file}:1`, ["bundled-find-module", "helper-predicates-unevaluated"], false,
            undefined, { requiredVariables: required, delegatedPackages: delegated, interfaceVersionUnknown: true });
        }
        activeFindModule = previous;
        activeFindScope = previousScope;
        activeFindFile = previousFile;
      } else if (/\.pc(?:\.in)?$/.test(name)) {
        const declared = providerPcVersion(text, initial);
        if (declared) add("pkg-config", name.replace(/\.pc(?:\.in)?$/, ""), `${file}:${text.slice(0, text.indexOf("Version:")).split("\n").length}`, [], true, declared);
      } else nativeMesonExports(text, file, directory, add);
    };
    if (contractFiles) {
      for (const entry of contractFiles) collectMetadata(entry.file);
    } else if (manifests) {
      for (const file of manifestsByOwner.get(directory) || []) collectMetadata(file);
      // Wrap declarations live immediately under the owner's subprojects area;
      // inspecting it does not require a second recursive source traversal.
      try { for (const child of listOwnerDirectory(join(directory, "subprojects"))) {
        if (child.isFile() && child.name.endsWith(".wrap")) collectMetadata(join(directory, "subprojects", child.name));
      } } catch { /* No local Meson wraps. */ }
    } else {
      let entries = 0;
      const walk = (path, depth = 0) => {
        if (depth > 16 || entries > 20000) return;
        let children;
        try { children = readdirSync(path, { withFileTypes: true }); } catch { return; }
        for (const child of children) {
          if (++entries > 20000) { diagnostics.push({ directory, reason: "metadata-budget" }); return; }
          const file = join(path, child.name);
          if (child.isDirectory()) {
            if ([".git", ".svn", "node_modules", "build", "_build", "dist", ".cache"].includes(child.name) || ownerDirs.has(file)) continue;
            const cmake = metadata(join(file, "CMakeLists.txt"));
            const meson = metadata(join(file, "meson.build"));
            if (cmake && commandsOf(join(file, "CMakeLists.txt")).some((command) => command.name === "project") || meson && /^\s*project\s*\(/m.test(meson)) { markIndependent(file); continue; }
            walk(file, depth + 1);
          } else if (child.isFile()) collectMetadata(file);
        }
      };
      walk(directory);
    }
    for (let at = exports.length - 1; at >= 0; at--) {
      const entry = exports[at];
      if (entry.conditions.includes("source-package-config")) continue;
      const interfaces = entry.kind === "cmake-package" && configInterfaces.get(entry.name.toLowerCase());
      if (!interfaces?.length) continue;
      const compatible = interfaces.filter((evidence) => compatibleOwnerConditions(entry.conditions, evidence.conditions));
      if (compatible.length) exports.splice(at, 1, ...compatible.map((evidence) => ({ ...entry, ...evidence,
        conditions: [...new Set([...entry.conditions, ...evidence.conditions])] })));
      else exports[at] = { ...entry, interfaceVersionUnknown: true };
    }
    const writes = evaluationWrites;
    evaluationWrites = undefined;
    const observed = ownerReads;
    ownerReads = undefined;
    // Boundary discovery can change a later install's input. New staging
    // effects depend on global dedup state. Either case evaluates normally
    // until a repeat reaches a stable, effect-free cache boundary. Scoped
    // recipe candidates are also collector-wide, and are verified after all
    // owner contexts have registered.
    if (evaluationStart && evaluationStart.independentRevision === independentRevision &&
      evaluationStart.stages === stagedTransforms.length && evaluationStart.stagedKeys === stagedKeys.size &&
      evaluationStart.scopedCandidates === scopedCandidates.size &&
      !active.size && !outputBranches.length) {
      const result = {
        exports, projectDeclarations, commandCount, fileCount,
        effects: {
          findModules: findModules.slice(evaluationStart.findModules),
          compilerChecks: compilerChecks.slice(evaluationStart.compilerChecks),
          wraps: wraps.slice(evaluationStart.wraps),
          diagnostics: diagnostics.slice(evaluationStart.diagnostics),
          findDefinitions: writes.findDefinitions, findContracts: writes.findContracts,
        },
      };
      if (evaluationSeed && remainingUses) evaluationResults.set(evaluationSeed.key, { independentRevision, result: structuredClone(result) });
      if (diskKey && commandCount >= 100000) {
        const stored = !observed.reason && persistent.store.write(diskKey, { reads: observed.reads, effect: result });
        persistentDecision(directory, stored ? "stored" : "skipped", observed.reason || (!stored ? "store-rejected" : undefined), commandCount);
      }
    } else if (diskKey) persistentDecision(directory, "skipped", observed?.reason || "ordered-state-changed", commandCount);
    registerOwnerFacts(exports, projectDeclarations);
    function registerOwnerFacts(exports, projectDeclarations) {
      for (const fact of facts) {
        if (contractFiles) continue;
        const component = fact.component;
        const revision = providerSourceRevision(component);
        const ownedExports = [];
        for (const entry of exports) if (compatibleOwnerConditions(fact.conditions, entry.conditions)) {
          if (!entry.subdirectoryReplaySource) ownedExports.push(entry);
          else if (revision && (entry.sourceRevision === revision || resolutionInputs.sourceTextsOnly)) ownedExports.push({ ...entry, sourceRevision: revision });
        }
        const parsed = parsePurlLoose(component.purl || component["bom-ref"]);
        const repository = parsed?.qualifiers?.vcs_url || (parsed?.type === "github" && parsed.namespace ? `https://github.com/${parsed.namespace}/${parsed.name}` : undefined);
        const packageExports = ownedExports.filter((entry) => entry.global && ["cmake-package", "pkg-config"].includes(entry.kind));
        const declaredNames = new Set(projectDeclarations.map((entry) => entry.name.toLowerCase()));
        const packageAliases = packageExports.filter((entry) => declaredNames.has(entry.name.toLowerCase()));
        const aliasNames = new Set(packageAliases.map((entry) => entry.name.toLowerCase()));
        component.properties ||= [];
        if (declaredNames.size === 1 && aliasNames.size === 1) {
          const alias = packageAliases[0];
          const declaration = projectDeclarations.find((entry) => entry.name.toLowerCase() === alias.name.toLowerCase());
          const value = JSON.stringify({ schema: 1, name: alias.name, source: declaration.source, exportSource: alias.source,
            ...(repository ? { repository } : {}) });
          if (!component.properties.some((entry) => entry.name === "cdx:native:packageIdentity" && entry.value === value)) component.properties.push({ name: "cdx:native:packageIdentity", value });
        }
        if (packageExports.length) {
          const value = JSON.stringify(packageExports);
          if (!component.properties.some((entry) => entry.name === "cdx:native:providerExports" && entry.value === value)) component.properties.push({ name: "cdx:native:providerExports", value });
        }
        const provider = { ref: component["bom-ref"], component, packageIdentity: component.purl || component["bom-ref"], version: component.version,
          versionKind: prop(component, "cdx:version:kind") || "release", sourceIdentity: prop(component, "cdx:source:identity") || directory,
          directory, exports: ownedExports, conditions: fact.conditions || [], provenance: ownedExports.map((entry) => entry.source) };
        if (scopedLookups?.size && declaredNames.has(component.name?.toLowerCase())) scopedProjectOwners.set(provider, fact.releaseInputs);
        registerProvider(provider);
      }
    }
  }
  if (scopedCandidates.size) {
    const providersByDirectory = new Map();
    for (const provider of scopedProjectOwners.keys()) {
      if (!providersByDirectory.has(provider.directory)) providersByDirectory.set(provider.directory, []);
      providersByDirectory.get(provider.directory).push(provider);
    }
    for (const local of scopedCandidates.values()) {
      let directory = dirname(local.path);
      while (!independentDirectories.has(directory) && directory !== scanRoot && directory !== dirname(directory)) directory = dirname(directory);
      const owners = providersByDirectory.get(directory);
      if (!owners) continue;
      try {
        const stat = lstatSync(local.path);
        if (!stat.isFile() || process.platform !== "win32" && !(stat.mode & 0o111)) continue;
      } catch { continue; }
      const opened = openRegularFile(local.path, directory);
      if (!opened) continue;
      let script;
      try {
        const header = Buffer.allocUnsafe(2);
        script = readSync(opened.fd, header, 0, 2, 0) === 2 && header[0] === 35 && header[1] === 33;
      } catch { /* An unreadable file is not executable evidence. */ } finally { closeSync(opened.fd); }
      if (!script) continue;
      const revision = revisionOfProducerFile(local.file);
      if (!revision || !inside(revision.root, local.path) || !memberAtRevision(local.file, revision) ||
        memberAtRevision(local.path, revision) !== "100755" || !memberAtRevision(join(directory, "CMakeLists.txt"), revision)) continue;
      if (local.includeInputs?.some((input) => !inside(revision.root, input) || !memberAtRevision(input, revision))) continue;
      const source = `${local.path}:1`;
      const exportKey = key("tool", local.member);
      for (const provider of owners) {
        const expected = providerSourceRevision(provider.component);
        if (expected && expected !== revision.version || !compatibleOwnerConditions(provider.conditions, local.conditions)) continue;
        if (["source-revision", "archive-revision"].includes(provider.versionKind)) {
          if (expected !== revision.version) continue;
        } else {
          // The script and lookup can be unchanged even when a separately
          // read VERSION file or a release-defining include is not in HEAD.
          const inputs = scopedProjectOwners.get(provider);
          if (!inputs?.length || !inputs.every((input) => inside(revision.root, input) && memberAtRevision(input, revision))) continue;
        }
        const entry = { kind: "tool", name: local.member, source, ownerDir: directory, conditions: local.conditions,
          global: false, executableUnknown: true, lookupSource: local.source, sourceRevision: revision.version };
        scopedProgramExports.set(entry, { arguments: local.arguments, invocations: local.invocations });
        provider.exports.push(entry);
        provider.provenance.push(source);
        if (!byExport.has(exportKey)) byExport.set(exportKey, []);
        byExport.get(exportKey).push({ provider, export: entry });
      }
    }
  }
  const authenticatedManifests = new Map();
  // Authentication remains exact JSON identity, including property order.
  // Cache only this collection's authenticated export arrays; normal and
  // explicitly unknown claims have different permitted serialized records.
  const authenticatedExportSerializations = new Map();
  const matchesAuthenticatedExport = (originals, entry) => {
    let variants = authenticatedExportSerializations.get(originals);
    if (!variants) {
      variants = [];
      authenticatedExportSerializations.set(originals, variants);
    }
    const variant = entry.interfaceVersionUnknown === true ? 1 : 0;
    let serialized = variants[variant];
    if (!serialized) {
      serialized = new Set();
      for (const original of originals) serialized.add(JSON.stringify({
        ...original, ...(variant ? { interfaceVersionUnknown: true } : {}),
      }));
      variants[variant] = serialized;
    }
    return serialized.has(JSON.stringify(entry));
  };
  const verifiedAvailable = new Map();
  const registerAvailable = (component, { authenticated, valid, provenance }) => registerProvider({
    ref: component["bom-ref"], component, packageIdentity: component.purl || component["bom-ref"],
    version: component.version, versionKind: prop(component, "cdx:version:kind") || "release",
    interfaceVersionUnknown: authenticated.interfaceVersionUnknown === true || ["package-manifest", "installed-package-file"].includes(authenticated.kind),
    platform: authenticated.platform, arch: authenticated.arch,
    exports: valid, conditions: authenticated.conditions || [], provenance,
  });
  for (const component of resolutionInputs.availableProviders || []) {
    const evidenceValue = prop(component, "cdx:native:providerEvidence");
    if (!component.version || !component["bom-ref"] || !prop(component, "cdx:native:providerIdentity") || !evidenceValue) continue;
    const exportValue = prop(component, "cdx:native:providerExports") || "[]";
    const previous = verifiedAvailable.get(component["bom-ref"]);
    // Reuse verified disk claims for exact bytes and the same owner. A
    // process-local observation still needs its own private receipt.
    if (previous && previous.evidenceValue === evidenceValue && previous.exportValue === exportValue &&
      previous.authenticated.version === component.version && (previous.authenticated.packageName || previous.authenticated.name) === component.name) {
      registerAvailable(component, previous);
      continue;
    }
    let evidence;
    let exports;
    try {
      evidence = JSON.parse(evidenceValue);
      exports = JSON.parse(exportValue);
    } catch { continue; }
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence) || !Array.isArray(exports)) continue;
    let authenticated;
    let liveObservation = false;
    if (typeof evidence.manifestPath === "string" && typeof evidence.metadataPath === "string") {
      if (!authenticatedManifests.has(evidence.manifestPath)) {
        const records = loadNativeExternalMetadata({ nativeProviderMetadata: [evidence.manifestPath],
          [nativeProviderReplay]: resolutionInputs[nativeProviderReplay] });
        const variants = new Map();
        for (const record of records) {
          if (!variants.has(record.metadataPath)) variants.set(record.metadataPath, []);
          variants.get(record.metadataPath).push(record);
        }
        authenticatedManifests.set(evidence.manifestPath, variants);
      }
      authenticated = authenticatedManifests.get(evidence.manifestPath).get(evidence.metadataPath)?.find((record) => {
        const changedInterface = record.comparisonVersion !== evidence.comparisonVersion;
        if (changedInterface && !record.exports.some((entry) => entry.interfaceVersion === evidence.comparisonVersion)) return false;
        const expected = changedInterface ? { ...record, comparisonVersion: evidence.comparisonVersion } : record;
        return JSON.stringify(expected) === JSON.stringify(evidence);
      });
    } else {
      const observed = nativeObservedProviderEvidence(component);
      if (observed && JSON.stringify(observed) === JSON.stringify(evidence)) {
        authenticated = observed;
        liveObservation = true;
      }
    }
    if (!authenticated || authenticated.version !== component.version ||
      (authenticated.packageName || authenticated.name) !== component.name ||
      authenticated.kind !== evidence.kind || authenticated.name !== evidence.name ||
      authenticated.metadataSha256 !== evidence.metadataSha256 || authenticated.manifestSha256 !== evidence.manifestSha256) continue;
    const valid = exports.filter((entry) => ["header-file", "library", "target", "pkg-config", "cmake-package", "meson", "tool", "capability"].includes(entry.kind) &&
      typeof entry.name === "string" && (entry.kind === "header-file" ? /^[A-Za-z0-9_][A-Za-z0-9_./+-]*$/.test(entry.name) && !entry.name.split("/").includes("..") :
        entry.kind === "tool" && (authenticated.repositoryEvidence || authenticated.kind === "provider-snapshot" && entry.sourceDeclared === true) ?
          safeMember(entry.name) : identity(entry.name)) &&
      typeof entry.source === "string" && entry.source.length > 0 &&
      matchesAuthenticatedExport(authenticated.exports, entry)).map((entry) => ({ ...entry,
      global: entry.global !== false, ownerRef: component["bom-ref"], conditions: entry.conditions || [] }));
    if (!valid.length) continue;
    if (["package-manifest", "installed-package-file"].includes(authenticated.kind)) {
      for (const entry of valid) {
        if (typeof entry.file !== "string" || !entry.file.startsWith("/")) continue;
        if (entry.kind === "tool") authenticatedProgramPaths.set(entry, Boolean(authenticated.repositoryEvidence));
        if (entry.kind === "library" && authenticated.repositoryEvidence) signedLibraryPaths.set(entry, authenticated);
        if (entry.kind === "cmake-package" && authenticated.repositoryEvidence) signedPackageConfigs.add(entry);
      }
    }
    if (liveObservation) {
      for (const entry of valid) if (isObservedExecutable(entry, authenticated)) observedExecutableExports.add(entry);
    }
    const verified = { evidenceValue, exportValue, authenticated, valid, provenance: valid.map((entry) => entry.source) };
    if (typeof evidence.manifestPath === "string" && typeof evidence.metadataPath === "string") {
      verifiedAvailable.set(component["bom-ref"], verified);
    }
    registerAvailable(component, verified);
  }
  const stagedPayloads = new Map();
  const stagedProcessed = new Set();
  for (const stage of stagedTransforms) for (const provider of providers) {
    const original = provider.exports;
    for (const entry of original) {
      if (entry.kind !== "library" || !entry.sourceSha256 || entry.sourceArchive?.sha256 !== stage.archiveSha256) continue;
      const file = entry.source?.replace(/:\d+$/, "");
      if (!file?.split("\\").join("/").endsWith(`/${stage.wrapDirectory}/${stage.member}`)) continue;
      const observation = JSON.stringify([stage.scriptFile, stage.wrapFile, file, entry.sourceSha256, provider.ref]);
      if (stagedProcessed.has(observation)) continue;
      stagedProcessed.add(observation);
      const id = `${file}\0${entry.sourceSha256}`;
      if (!stagedPayloads.has(id)) {
        const text = readRegularTextFile(file, MAX_METADATA_BYTES);
        stagedPayloads.set(id, text !== undefined && createHash("sha256").update(text).digest("hex") === entry.sourceSha256 ? text : undefined);
      }
      const text = stagedPayloads.get(id);
      if (text === undefined) continue;
      let transformed = text.replaceAll("\r\n", "\n");
      for (const [old, next] of stage.replacements) transformed = transformed.replaceAll(old, next);
      if (transformed === text.replaceAll("\r\n", "\n")) continue;
      nativeMesonExports(transformed, file, dirname(file), (kind, name, source, conditions, global) => {
        if (kind !== "library" || !global || !identity(name) || original.some((exp) => exp.kind === kind && exp.name === name)) return;
        const derived = { ...entry, name, source, materialUnknown: true, interfaceVersionUnknown: true,
          transformationSource: stage.scriptFile, transformationSha256: stage.scriptSha256,
          transformationInvocation: stage.source, sourceWrap: stage.wrapFile, sourceUrl: stage.sourceUrl,
          transformedSourceSha256: createHash("sha256").update(transformed).digest("hex"),
          conditions: [...new Set([...(entry.conditions || []), ...conditions, ...stage.conditions, "staged-transformation-unexecuted"])] };
        if (provider.exports === original) provider.exports = original.slice();
        provider.exports.push(derived);
        const exportKey = key(kind, name);
        if (!byExport.has(exportKey)) byExport.set(exportKey, []);
        byExport.get(exportKey).push({ provider, export: derived });
      });
    }
  }
  const wrapOwners = new Map(wraps.map((wrap) => [wrap.ownerDirectory, []]));
  if (wrapOwners.size) for (const provider of providers) wrapOwners.get(provider.directory)?.push(provider);
  for (const wrap of wraps) for (const provider of wrapOwners.get(wrap.ownerDirectory)) {
    for (const alias of wrap.aliases) {
      const entry = { kind: "meson", name: alias.name, source: alias.source, ownerDir: provider.directory,
        global: true, consumerDirectory: wrap.directory, conditions: ["local-wrap-provide"], mesonWrap: wrap.file,
        ...(alias.dependencyVariable ? { dependencyVariable: alias.dependencyVariable } : {}) };
      provider.exports.push(entry);
      const exportKey = key(entry.kind, entry.name);
      if (!byExport.has(exportKey)) byExport.set(exportKey, []);
      byExport.get(exportKey).push({ provider, export: entry });
    }
  }
  for (const check of compilerChecks) for (const capability of check.capabilities) {
    for (const match of byExport.get(key("capability", capability)) || []) {
      if (!match.export.global) continue;
      const exportKey = key("cmake-package", check.name);
      if (!byExport.has(exportKey)) byExport.set(exportKey, []);
      byExport.get(exportKey).push({ provider: match.provider, export: { ...match.export,
        kind: "cmake-package", name: check.name, via: check.source, consumerDirectory: check.directory,
        interfaceVersion: undefined, interfaceVersionUnknown: true,
        predicateStatus: "unknown", predicateSource: check.source,
        conditions: [...(match.export.conditions || []), "compiler-feature-unevaluated"] } });
    }
  }
  // Recover literal header lookups in unversioned consumer projects without
  // assigning a release to the consumer or assuming its configure succeeded.
  // The regular evaluator has richer information where it ran successfully.
  const evaluatedHeaderModules = new Set(findModules.filter((module) => module.headers?.length).map((module) => module.moduleFile));
  const revisionProviders = new Map();
  for (const provider of providers) {
    if (provider.versionKind !== "source-revision" || !provider.directory) continue;
    const id = `${provider.directory}\0${provider.version}`;
    if (!revisionProviders.has(id)) revisionProviders.set(id, []);
    revisionProviders.get(id).push(provider);
  }
  const producerManifests = new Map();
  if (!resolutionInputs.sourceTextsOnly && revisionProviders.size) for (const file of manifests || []) {
    if (basename(file) !== "CMakeLists.txt") continue;
    const tail = basename(dirname(file));
    if (!producerManifests.has(tail)) producerManifests.set(tail, []);
    producerManifests.get(tail).push(file);
  }
  const sourceSelectorEntries = new Set();
  const addSourceSelector = (provider, entry) => {
    const id = JSON.stringify([provider.ref, entry]);
    if (sourceSelectorEntries.has(id)) return;
    sourceSelectorEntries.add(id);
    const exportKey = key(entry.kind, entry.name);
    if (!byExport.has(exportKey)) byExport.set(exportKey, []);
    byExport.get(exportKey).push({ provider, export: entry });
  };
  function* lexicalSourceCommands(commands) {
    const branches = [];
    let depth = 0;
    for (const command of commands) {
      const { name, args } = command;
      if (name === "function" || name === "macro") { depth++; continue; }
      if (name === "endfunction" || name === "endmacro") { depth--; continue; }
      if (depth) continue;
      if (name === "if") branches.push(`if(${args.join(" ")})`);
      else if (name === "elseif" && branches.length) branches[branches.length - 1] += `/elseif(${args.join(" ")})`;
      else if (name === "else" && branches.length) branches[branches.length - 1] += "/else()";
      else if (name === "endif") branches.pop();
      else if (!branches.some((branch) => /^if\((?:FALSE|OFF|0)\)$/i.test(branch) || /^if\((?:TRUE|ON|1)\)\//i.test(branch))) {
        yield { ...command, conditions: [...branches] };
      }
    }
  }
  const bundledReceipts = new Map();
  let bundledBytesRemaining = 128 * 1024 * 1024;
  function bundledLibraryEvidence(path, revision) {
    if (bundledReceipts.has(path)) return bundledReceipts.get(path);
    bundledReceipts.set(path, undefined);
    // DVC's checked-in single-file receipt records the content that belongs
    // to this source revision; verify actual bytes and retain their SHA-256.
    const receipt = `${path}.dvc`;
    if (!existsSync(receipt) || !memberAtRevision(receipt, revision)) return;
    const text = metadata(receipt);
    const fields = /^outs:\r?\n- md5: ([a-f0-9]{32})\r?\n  size: (\d+)\r?\n  hash: md5\r?\n  path: ([A-Za-z0-9_.+-]+)\r?\n?$/.exec(text || "");
    if (!fields || fields[3] !== basename(path)) return;
    const size = Number(fields[2]);
    if (!Number.isSafeInteger(size) || size <= 0 || size > bundledBytesRemaining) return;
    const opened = openRegularFile(path, revision.root);
    if (!opened) return;
    try {
      if (opened.size !== size) return;
      bundledBytesRemaining -= size;
      const md5 = createHash("md5");
      const sha256 = createHash("sha256");
      const bytes = Buffer.allocUnsafe(Math.min(size, 64 * 1024));
      for (let offset = 0; offset < size;) {
        const count = readSync(opened.fd, bytes, 0, Math.min(bytes.length, size - offset), offset);
        if (count <= 0) return;
        const chunk = bytes.subarray(0, count);
        md5.update(chunk);
        sha256.update(chunk);
        offset += count;
      }
      if (md5.digest("hex") !== fields[1]) return;
      const evidence = { path, receipt, size, md5: fields[1], sha256: sha256.digest("hex") };
      bundledReceipts.set(path, evidence);
      return evidence;
    } catch { return; } finally { closeSync(opened.fd); }
  }
  for (const [file, module] of localHeaderModules) {
    const commands = commandsOf(file);
    if (!commands.some(({ name }) => name === "find_path")) continue;
    const paths = new Map();
    const headers = new Map();
    const fallbacks = [];
    const selectors = [];
    for (const { name, args, line, conditions: branches } of lexicalSourceCommands(commands)) {
      if (name === "find_path" && identity(args[0])) {
        const members = [];
        const named = args[1] === "NAMES" || args[1] === "NAME";
        for (const member of args.slice(named ? 2 : 1)) {
          if (!safeMember(member) || libraryFindControls.has(member) || programSearchControls.test(member)) break;
          members.push(member);
          if (!named) break;
        }
        if (!members.length) continue;
        const roots = new Set();
        const suffixes = [];
        let section;
        for (const arg of args.slice(named ? 2 : 1)) {
          if (libraryFindControls.has(arg) || programSearchControls.test(arg)) { section = arg; continue; }
          if (section === "PATH_SUFFIXES" && safeMember(arg)) suffixes.push(arg);
          else if (["PATHS", "HINTS"].includes(section)) {
            const tail = /^\$\{(?:CMAKE_SOURCE_DIR|PROJECT_SOURCE_DIR|CMAKE_CURRENT_LIST_DIR|CMAKE_CURRENT_SOURCE_DIR)\}\/(?:[A-Za-z0-9_.+-]+\/)*([A-Za-z0-9_+-][A-Za-z0-9_.+-]*)$/.exec(arg)?.[1];
            if (tail) roots.add(tail);
          }
        }
        headers.set(args[0], { members, line, roots, suffixes, conditions: [...branches] });
        if (!evaluatedHeaderModules.has(file)) findModules.push({ ...module, moduleFile: file,
          source: `${file}:${line}`, destination: args[0], searchUnknown: true,
          conditions: ["find-module-available", ...branches], libraries: [], headers: members, programs: [], pkgConfig: [] });
      } else if (name === "set" && identity(args[0])) {
        const path = /^\$\{PROJECT_SOURCE_DIR\}\/(.+)$/.exec(args[1] || "")?.[1];
        const reference = /^\$\{([A-Za-z0-9_]+)\}$/.exec(args[1] || "")?.[1];
        if (branches.length && headers.has(args[0])) {
          const base = path && safeMember(path) ? path : paths.get(reference);
          if (base) fallbacks.push({ destination: args[0], base, line, conditions: [...branches] });
        }
        // Only unconditional literal roots are eligible to flow through a
        // variable; no last-write-wins inference across unknown branches.
        if (path && safeMember(path) && !branches.length) paths.set(args[0], path);
        else paths.delete(args[0]);
      } else if (name === "add_subdirectory") {
        const route = /^\$\{([A-Za-z0-9_]+)\}((?:\/[A-Za-z0-9_.+-]+)+)$/.exec(args[0] || "");
        if (route && headers.has(route[1])) selectors.push({ destination: route[1], suffix: route[2], line, conditions: [...branches] });
      }
    }
    if (!findContracts.has(file)) {
      const { required, checks, versionVariables } = providerFindRequirements(module.name, commands);
      if (required.length) findContracts.set(file, { required, checks, versionVariables, source: `${file}:1`, complex: true });
    }
    if (resolutionInputs.sourceTextsOnly || (!fallbacks.length && !selectors.length) || !revisionProviders.size) continue;
    const revision = revisionOfProducerFile(file);
    if (!revision || !memberAtRevision(file, revision)) continue;
    const sourceOwners = revisionProviders.get(`${revision.root}\0${revision.version}`) || [];
    if (!sourceOwners.length) continue;
    for (const fallback of fallbacks) for (const member of headers.get(fallback.destination).members) {
      const path = join(module.directory, fallback.base, member);
      if (revisionOfProducerFile(path)?.root !== revision.root || !memberAtRevision(path, revision)) continue;
      // The header belongs to the tracked repository, not an independently
      // released library named after the custom Find module.
      for (const provider of sourceOwners) {
        const entry = { kind: "cmake-package", name: module.name, source: `${path}:1`,
          ownerDir: provider.directory, global: false, consumerDirectory: module.directory,
          via: `${file}:${headers.get(fallback.destination).line}`, fallbackSource: `${file}:${fallback.line}`,
          scopedSourceSelector: true, sourceRevision: revision.version, interfaceVersionUnknown: true,
          predicateStatus: "unknown", conditions: ["find-module-available", ...fallback.conditions] };
        addSourceSelector(provider, entry);
      }
    }
    // Recover exact relative source-tree selectors, without treating the
    // unresolved CMake search roots as observations of an original build.
    for (const selector of selectors) {
      const header = headers.get(selector.destination);
      for (const root of header.roots) for (const suffix of header.suffixes) {
        const headerRelative = `${root}/${suffix}`;
        const producerRelative = posix.normalize(`${headerRelative}${selector.suffix}`);
        if (!safeMember(producerRelative)) continue;
        for (const producerFile of producerManifests.get(posix.basename(producerRelative)) || []) {
          const producerDirectory = dirname(producerFile);
          if (!inside(revision.root, producerDirectory)) continue;
          const path = relative(revision.root, producerDirectory).split("\\").join("/");
          if (path !== producerRelative && !path.endsWith(`/${producerRelative}`)) continue;
          const base = path.slice(0, path.length - producerRelative.length);
          const producerRevision = revisionOfProducerFile(producerFile);
          if (producerRevision?.root !== revision.root || !memberAtRevision(producerFile, revision)) continue;
          for (const member of header.members) {
            const headerFile = join(revision.root, base, headerRelative, member);
            if (revisionOfProducerFile(headerFile)?.root !== revision.root || !memberAtRevision(headerFile, revision)) continue;
            const producerCommands = [...lexicalSourceCommands(commandsOf(producerFile))];
            const declarations = producerCommands.filter(({ name, args }) => name === "add_library" && identity(args[0]) &&
              ["STATIC", "SHARED", "INTERFACE", "OBJECT", "MODULE"].includes(args[1]) && !args.includes("IMPORTED"));
            if (!declarations.length) continue;
            const bundledByTarget = new Map();
            for (const command of producerCommands) {
              if (command.name !== "target_link_libraries" || !declarations.some(({ args }) => args[0] === command.args[0])) continue;
              const target = command.args[0];
              if (!bundledByTarget.has(target)) bundledByTarget.set(target, { inputs: [], verified: [] });
              const bundle = bundledByTarget.get(target);
              for (const arg of command.args.slice(1)) {
                const member = /^\$\{CMAKE_CURRENT_SOURCE_DIR\}\/(.+\.(?:a|lib|so|dylib|dll))$/i.exec(arg)?.[1];
                if (!safeMember(member)) continue;
                const path = join(producerDirectory, member);
                const source = `${producerFile}:${command.line}`;
                bundle.inputs.push({ path, source, conditions: command.conditions });
                const verified = bundledLibraryEvidence(path, revision);
                if (verified) bundle.verified.push({ ...verified, source, conditions: command.conditions });
              }
            }
            const conditions = [...new Set(["find-module-available", ...header.conditions, ...selector.conditions, "source-selector-root-unevaluated"])];
            for (const provider of sourceOwners) for (const declaration of declarations) {
              const target = declaration.args[0];
              const bundle = bundledByTarget.get(target);
              const targetConditions = [...new Set([...conditions, ...declaration.conditions])];
              const evidence = { ownerDir: provider.directory, global: false, scopedSourceSelector: true,
                sourceRevision: revision.version, interfaceVersionUnknown: true, predicateStatus: "unknown",
                sourceDeclared: true, materialUnknown: true, headerSource: `${headerFile}:1`,
                subdirectoryReplaySource: `${file}:${selector.line}`, sourceSelectorTarget: target,
                sourceSelectorPathSuffix: headerRelative, sourceSelectorSubdirectorySuffix: selector.suffix,
                conditions: targetConditions };
              if (bundle?.inputs.length) evidence.bundledLibraryInputs = bundle.inputs;
              if (bundle?.verified.length) evidence.bundledLibraryEvidence = bundle.verified;
              addSourceSelector(provider, { ...evidence, kind: "cmake-package", name: module.name,
                source: `${producerFile}:${declaration.line}`, via: `${file}:${header.line}`, consumerDirectory: module.directory });
              // The exact default archive basename is a source declaration,
              // not evidence of its output path or materialization.
              if (declaration.args[1] !== "STATIC" || producerCommands.some(({ name, args }) =>
                ["set_target_properties", "set_property", "set"].includes(name) && args.some((arg) =>
                  /^(?:(?:ARCHIVE_)?OUTPUT_NAME(?:_[A-Z0-9_]+)?|PREFIX|SUFFIX|CMAKE_STATIC_LIBRARY_(?:PREFIX|SUFFIX))$/.test(arg)))) continue;
              addSourceSelector(provider, { ...evidence, kind: "library", name: `lib${target}.a`,
                source: `${producerFile}:${declaration.line}`, linkage: "static", consumerDirectory: revision.root,
                conditions: [...targetConditions, "if(NOT WIN32)"] });
            }
          }
        }
      }
    }
  }
  const searchesByModule = new Map();
  for (const search of findModules) {
    if (!findContracts.has(search.moduleFile)) continue;
    let byDestination = searchesByModule.get(search.moduleFile);
    if (!byDestination) searchesByModule.set(search.moduleFile, byDestination = new Map());
    let searches = byDestination.get(search.destination);
    if (!searches) byDestination.set(search.destination, searches = []);
    searches.push(search);
  }
  const predicates = new Map();
  const finderOccurrences = new Map();
  for (const module of findModules) {
    const contract = findContracts.get(module.moduleFile);
    if (!contract) continue;
    let predicate = predicates.get(module.moduleFile);
    if (!predicate) {
      const byDestination = searchesByModule.get(module.moduleFile);
      const groups = contract.required.map((destination) => {
        const alternatives = new Map();
        for (const search of byDestination?.get(destination) || []) {
          for (const [kind, names] of finderMembers(search)) for (const name of names) {
            alternatives.set(key(kind, name), { kind, name });
          }
        }
        return { destination, alternatives: [...alternatives.values()] };
      });
      const evidence = { requiredArtifacts: groups, predicateSource: contract.source,
        ...(contract.checks.length ? { compilePredicates: contract.checks } : {}),
        ...(contract.versionVariables.length ? { versionVariables: contract.versionVariables } : {}) };
      predicate = { groups, contract, evidence };
      predicates.set(module.moduleFile, predicate);
    }
    if (module.libraries.length && predicate.groups.some((group) => group.destination === module.destination)) {
      finderOccurrences.set(module.source, predicate);
    }
  }
  for (const module of findModules) {
    let search;
    for (const [kind, names] of finderMembers(module)) for (const name of names) {
      for (const match of byExport.get(key(kind, name)) || []) {
        if (!match.export.global || !nativeProviderPlatformAccepts(match.provider, module)) continue;
        const signedLibrary = signedLibraryPaths.get(match.export);
        if (signedLibrary && module.librarySearchArgs && !matchesSignedLibraryDirectory(match.export.file, signedLibrary.arch,
          search ||= programSearchPaths(module.librarySearchArgs))) continue;
        const predicate = predicates.get(module.moduleFile);
        const complete = !signedLibrary && (!predicate || finderComplete(predicate, match, byExport));
        const exportKey = key("cmake-package", module.name);
        if (!byExport.has(exportKey)) byExport.set(exportKey, []);
        byExport.get(exportKey).push({ provider: match.provider, export: { ...match.export,
          kind: "cmake-package", name: module.name, via: module.source, consumerDirectory: module.directory,
          ...(module.scopeDirectory ? { consumerScopeDirectory: module.scopeDirectory } : {}),
          ...(module.builtinModule ? { builtinModule: module.builtinModule } : {}),
          ...(kind === "header-file" && !match.export.interfaceVersion ? { interfaceVersionUnknown: true } : {}),
          ...predicate?.evidence,
          ...(!complete || module.searchUnknown ? { predicateStatus: "unknown" } : predicate ? { predicateStatus: "satisfied" } : {}),
          conditions: [...(match.export.conditions || []), ...(module.conditions || [])] } });
      }
    }
  }
  // Receipt exports are added after finder synthesis: they never authorize
  // a generic alias, transitive finder, or another consumer's lookup.
  if (resolutionInputs.nativeScopedReceipt) for (const provider of nativeConfiguredReceiptProviders(resolutionInputs.nativeScopedReceipt, scanRoot)) {
    for (const [entry, occurrenceKey] of provider.occurrenceKeys) scopedConfiguredExports.set(entry, occurrenceKey);
    registerProvider(provider);
  }
  if (resolutionInputs.nativeScopedReceipt) {
    const receipts = readNativeScopedReceipts(resolutionInputs.nativeScopedReceipt, scanRoot).filter((receipt) => receipt.lookup.kind === "finder-owner");
    const byRef = new Map(providers.map((provider) => [provider.ref, provider]));
    for (const receipt of receipts) for (const [ref, { authenticated }] of verifiedAvailable) {
      const provider = byRef.get(ref);
      const entry = provider && nativeFinderReceiptEntry(receipt, authenticated);
      if (!entry) continue;
      scopedConfiguredExports.set(entry, nativeScopedOccurrenceKey(receipt.occurrence));
      const exportKey = key(entry.kind, entry.name);
      if (!byExport.has(exportKey)) byExport.set(exportKey, []);
      byExport.get(exportKey).push({ provider, export: entry });
    }
  }
  return { providers, byExport, findModules, finderOccurrences, localFindDefinitions, independentDirectories,
    sourceAliases: resolutionInputs.sourceAliases || new Map(), scanRoot, diagnostics, metadataFilesRead: files.size };
}

function finderMembers(search) {
  return [["library", search.libraries], ["header-file", search.headers || []], ["tool", search.programs || []],
    ["data-file", search.dataFiles || []], ["pkg-config", search.pkgConfig || []]];
}

function finderComplete(predicate, match, byExport) {
  return !predicate.contract.complex && predicate.groups.every((group) => group.alternatives.some((alternative) =>
    (byExport.get(key(alternative.kind, alternative.name)) || []).some((candidate) =>
      candidate.provider === match.provider && candidate.export.global && !candidate.export.materialUnknown && !candidate.export.executableUnknown &&
      !signedLibraryPaths.has(candidate.export) &&
      candidate.export.material !== "stub" && compatibleOwnerConditions(candidate.export.conditions, match.export.conditions))));
}

function requirementToolContract(requirement) {
  if (!["find_package", "find_dependency"].includes(requirement.command) ||
    requirement.arguments?.some((argument) => ["CONFIG", "NO_MODULE"].includes(argument))) return undefined;
  const name = requirement.requestedName;
  if (["Python", "Python3", "Python2", "PythonInterp", "PythonLibs", "PythonLibsNew"].includes(name)) {
    const args = requirement.arguments || [];
    const at = args.indexOf("COMPONENTS");
    const components = at < 0 ? [name.startsWith("PythonLibs") ? "Development" : "Interpreter"] : [];
    if (at >= 0) for (const component of args.slice(at + 1)) {
      if (["OPTIONAL_COMPONENTS", "REQUIRED", "QUIET", "HINTS", "PATHS"].includes(component)) break;
      components.push(component);
    }
    const required = components.flatMap((component) => component === "Interpreter" ? ["python-interpreter"] :
      component === "Development" ? ["python-development-module", "python-development-embed"] :
      component === "Development.Module" ? ["python-development-module"] :
      component === "Development.Embed" ? ["python-development-embed"] :
      component === "Development.SABIModule" ? ["python-development-sabi"] :
      component === "NumPy" ? ["python-numpy"] : ["unknown-python-component"]);
    return { major: name === "Python3" ? 3 : name === "Python2" ? 2 : undefined, required,
      names: ["python-interpreter", ...required], binaries: name === "Python3" ? ["python3"] : name === "Python2" ? ["python2"] : ["python", "python3", "python2"] };
  }
  const binaries = nativeFinderToolNames(requirement);
  if (binaries.length) return { binaries, names: [], required: [] };
  const binary = name === "Pytest" ? "pytest" : name === "Sphinx" ? "sphinx-build" : undefined;
  return binary ? { binaries: [binary], names: [], required: [] } : undefined;
}

function requirementKinds(requirement) {
  if (["find_package", "find_dependency"].includes(requirement.command)) return ["cmake-package", "build-helper"];
  if (["find_library", "find_static_library", "find_shared_library"].includes(requirement.command)) return ["library"];
  if (requirement.command === "find_program") return ["tool"];
  if (requirement.command === "dependency") return mesonMethodKinds("auto");
  return ["target", "library"];
}

function mesonMethodKinds(method) {
  if (method === "auto") return ["meson", "pkg-config", "cmake-package"];
  if (method === "pkg-config") return ["meson", "pkg-config"];
  if (method === "cmake") return ["meson", "cmake-package"];
  return [];
}

function requirementQueries(requirement, names) {
  if (requirement.command !== "dependency") return requirementKinds(requirement).flatMap((kind) => names.map((name) => ({ kind, name })));
  const methodArg = requirement.arguments?.find((arg) => /^\s*method\s*:/.test(arg));
  const literal = methodArg?.match(/^\s*method\s*:\s*(['"])([^'"]+)\1\s*$/)?.[2];
  const methods = literal || !methodArg && !requirement.mesonOptions?.method ? [{ value: literal || "auto" }] :
    requirement.mesonOptions?.method?.alternatives || [];
  return methods.flatMap(({ value, conditions }) => {
    const queries = mesonMethodKinds(value).flatMap((kind) => names.map((name) => ({ kind, name, conditions })));
    // Meson's LLVM dependency implements this backend using llvm-config.
    // The executable must actually be exported; its source release is not
    // an observation of supported llvm-config modules, version or selection.
    if (value === "config-tool" && names.includes("llvm")) queries.push({ kind: "tool", name: "llvm-config", conditions, configTool: true });
    return queries;
  });
}

function compatibleVersion(requirement, provider, conditions) {
  const option = requirement.command === "dependency" && requirement.mesonOptions?.version;
  if (!option?.alternatives?.length) return option ? "unknown" : nativeProviderCompatibility(requirement, provider);
  if (option.appends?.length) return "unknown";
  const alternatives = option.alternatives.filter((entry) => compatibleOwnerConditions(conditions, entry.conditions));
  if (!alternatives.length) return "unknown";
  let first;
  for (const { value } of alternatives) {
    const result = typeof value === "string" || Array.isArray(value) ?
      nativeProviderCompatibility({ ...requirement, constraints: Array.isArray(value) ? JSON.stringify(value) : value }, provider) : "unknown";
    if (first !== undefined && first !== result) return "unknown";
    first = result;
  }
  return first;
}

/** A revision is an exact source version, never proof of a numeric release. */
export function nativeProviderCompatibility(requirement, provider) {
  const constraint = requirement.constraints?.trim();
  if (!constraint) return "satisfied";
  if (provider.interfaceVersionUnknown) return "unknown";
  if (["source-revision", "archive-revision"].includes(provider.versionKind) || !/^v?\d+(?:\.\d+){0,3}$/.test(provider.version || "")) return "unknown";
  if (provider.compatibilityMode && provider.compatibilityMode !== "AnyNewerVersion") {
    const requested = constraint.match(/^(?:>=?\s*)?(\d+(?:\.\d+)*)(?:\s+EXACT)?$/)?.[1];
    if (!requested) return "unknown";
    const actual = provider.version.replace(/^v/, "").split(".").map(BigInt);
    const wanted = requested.split(".").map(BigInt);
    if (provider.compatibilityMode === "ExactVersion" && (actual.length !== wanted.length || actual.some((part, at) => part !== wanted[at]))) return "violated";
    if (["SameMajorVersion", "SameMinorVersion"].includes(provider.compatibilityMode) && actual[0] !== wanted[0]) return "violated";
    if (provider.compatibilityMode === "SameMinorVersion" && (actual[1] || 0n) !== (wanted[1] || 0n)) return "violated";
    if (!["ExactVersion", "SameMajorVersion", "SameMinorVersion"].includes(provider.compatibilityMode)) return "unknown";
  }
  const compare = (a, b) => {
    const x = a.replace(/^v/, "").split(".").map(BigInt);
    const y = b.replace(/^v/, "").split(".").map(BigInt);
    for (let index = 0; index < Math.max(x.length, y.length); index++) {
      if ((x[index] || 0n) !== (y[index] || 0n)) return (x[index] || 0n) > (y[index] || 0n) ? 1 : -1;
    }
    return 0;
  };
  let constraints;
  if (constraint.startsWith("[")) { try { constraints = JSON.parse(constraint); } catch { return "unknown"; } }
  else constraints = constraint.split("|");
  if (!Array.isArray(constraints) || constraints.some((entry) => typeof entry !== "string")) return "unknown";
  let unknown = false;
  for (const entry of constraints) {
    if (requirement.command === "dependency" && /^\d+(?:\.\d+){0,3}$/.test(entry.trim())) {
      if (compare(provider.version, entry.trim()) !== 0) return "violated";
      continue;
    }
    const cmake = entry.trim().match(/^(\d+(?:\.\d+){0,3})(?:\.\.\.(<?)(\d+(?:\.\d+){0,3}))?(?:\s+(EXACT))?$/);
    if (cmake) {
      const lower = compare(provider.version, cmake[1]);
      if (cmake[4] ? lower !== 0 : lower < 0) return "violated";
      if (cmake[3]) { const upper = compare(provider.version, cmake[3]); if (cmake[2] === "<" ? upper >= 0 : upper > 0) return "violated"; }
      continue;
    }
    const meson = entry.trim().match(/^(>=|<=|!=|==|=|>|<)\s*(\d+(?:\.\d+){0,3})$/);
    if (!meson) { unknown = true; continue; }
    const result = compare(provider.version, meson[2]);
    if (!({ ">=": result >= 0, "<=": result <= 0, "!=": result !== 0, "==": result === 0, "=": result === 0, ">": result > 0, "<": result < 0 })[meson[1]]) return "violated";
  }
  return unknown ? "unknown" : "satisfied";
}

// Signed distribution paths describe package membership, not the runtime PATH.
const distributionProgramRoots = new Set(["/usr/bin", "/usr/sbin", "/bin", "/sbin"]);
// Debian target architecture is authenticated with the archive index. A
// multiarch tuple is a default only immediately beneath a native lib root.
const distributionLibraryRoots = ["/lib", "/usr/lib", "/usr/local/lib", "/usr/X11R6/lib", "/usr/pkg/lib", "/opt/lib"];
const distributionLibraryTuples = new Map([
  ["x64", "x86_64-linux-gnu"], ["arm64", "aarch64-linux-gnu"], ["ia32", "i386-linux-gnu"],
  ["arm", "arm-linux-gnueabihf"], ["ppc64", "powerpc64le-linux-gnu"], ["s390x", "s390x-linux-gnu"], ["riscv64", "riscv64-linux-gnu"],
]);
const libraryRootsByArch = new Map([...distributionLibraryTuples].map(([arch, tuple]) => [arch,
  new Set([...distributionLibraryRoots, ...distributionLibraryRoots.map((root) => `${root}/${tuple}`),
    ...distributionLibraryRoots.map((root) => `${root}${["ia32", "arm"].includes(arch) ? 32 : 64}`)])]));
const defaultLibraryRoots = new Set(distributionLibraryRoots);
const librarySearchCommands = new Set(["find_library", "find_static_library", "find_shared_library"]);

const defaultProgramSearch = { restricted: false };
const suppressedProgramSearches = new Map([
  ["NO_PACKAGE_ROOT_PATH", 1], ["NO_CMAKE_PATH", 2], ["NO_CMAKE_ENVIRONMENT_PATH", 4],
  ["NO_SYSTEM_ENVIRONMENT_PATH", 8], ["NO_CMAKE_SYSTEM_PATH", 16],
]);
function programSearchPaths(args) {
  if (args.length <= 2) return defaultProgramSearch;
  let roots, suffixes;
  let suppressed = 0;
  let restricted = false;
  let unknownRoot = false;
  let unknownSuffix = false;
  let rerooted = false;
  let field = args.includes("NAMES", 1) || args.includes("NAME", 1) ? undefined : "PATHS";
  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    if (arg === "HINTS" || arg === "PATHS" || arg === "PATH_SUFFIXES") field = arg;
    else if (arg === "ENV" && (field === "PATHS" || field === "HINTS")) {
      unknownRoot = true;
      i++;
    } else if (programSearchControls.test(arg) || libraryFindControls.has(arg)) {
      suppressed |= suppressedProgramSearches.get(arg) || 0;
      if (arg === "NO_DEFAULT_PATH") restricted = true;
      if (arg === "ONLY_CMAKE_FIND_ROOT_PATH" || arg === "CMAKE_FIND_ROOT_PATH_BOTH") rerooted = true;
      else if (arg === "NO_CMAKE_FIND_ROOT_PATH") rerooted = false;
      if (arg === "DOC" || arg === "VALIDATOR" || arg === "REGISTRY_VIEW") i++;
      field = undefined;
    } else if (arg === "NAMES" || arg === "NAME") {
      field = undefined;
    } else if (field === "PATH_SUFFIXES") {
      if (safeMember(arg)) (suffixes ||= new Set()).add(arg);
      else if (arg !== ".") unknownSuffix = true;
    } else if (field) {
      if (arg.startsWith("/") && !/[$;\\[\]]/.test(arg)) (roots ||= new Set()).add(posix.resolve(arg));
      else unknownRoot = true;
    }
  }
  restricted ||= suppressed === 31;
  const unknown = unknownRoot || unknownSuffix && (!restricted || Boolean(roots));
  if (!restricted && !unknown && !rerooted && !roots && !suffixes) return defaultProgramSearch;
  return { roots, suffixes, restricted, unknown, rerooted };
}

function matchesSearchRoot(directory, { roots, restricted, rerooted }, defaultRoots) {
  if (roots?.has(directory) || !restricted && defaultRoots.has(directory)) return true;
  if (!rerooted) return false;
  // A CMake root can prepend a directory, but cannot change the requested tail.
  for (let at = directory.indexOf("/", 1); at >= 0; at = directory.indexOf("/", at + 1)) {
    const tail = directory.slice(at);
    if (roots?.has(tail) || !restricted && defaultRoots.has(tail)) return true;
  }
  return roots?.has("/") === true;
}

function matchesSearchDirectory(directory, search, defaultRoots) {
  if (search.unknown || matchesSearchRoot(directory, search, defaultRoots)) return true;
  if (!search.suffixes) return false;
  // Compare only decompositions of this candidate, not every root × suffix.
  for (let at = directory.lastIndexOf("/"); at >= 0; at = directory.lastIndexOf("/", at - 1)) {
    if (search.suffixes.has(directory.slice(at + 1)) && matchesSearchRoot(directory.slice(0, at) || "/", search, defaultRoots)) return true;
    if (at === 0) break;
  }
  return false;
}

function matchesSignedLibraryDirectory(file, arch, search) {
  // Filename aliases from signed membership are only candidates. In
  // particular, a project can replace CMAKE_FIND_LIBRARY_SUFFIXES; without
  // its evaluated state, neither reject nor satisfy a SONAME by convention.
  return matchesSearchDirectory(posix.dirname(file), search, libraryRootsByArch.get(arch) || defaultLibraryRoots);
}

/** Resolve every occurrence independently, keeping all evidenced alternatives.
 * Explicitly installed/config exports can be available across owners; private
 * build targets and bare project declarations cannot escape their own owner. */
export function resolveNativeRequirements(requirements, providerIndex) {
  const bindings = [];
  const unresolved = [];
  const exportKeys = new WeakMap();
  const nearestDirectories = new Map();
  const selectorRevisions = new Map();
  const selectorRevisionOf = (file) => {
    if (!selectorRevisions.has(file)) selectorRevisions.set(file, sourceRevisionOf(file));
    return selectorRevisions.get(file);
  };
  const ownerDirectoryOf = (file) => {
    let cursor = dirname(file);
    const visited = [];
    while (!nearestDirectories.has(cursor) && !providerIndex.independentDirectories.has(cursor)) {
      visited.push(cursor);
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    const owner = nearestDirectories.get(cursor) || (providerIndex.independentDirectories.has(cursor) ? cursor : undefined);
    for (const directory of visited) nearestDirectories.set(directory, owner);
    return owner;
  };
  const exportKey = (entry) => {
    let serialized = exportKeys.get(entry);
    if (serialized === undefined) { serialized = JSON.stringify(entry); exportKeys.set(entry, serialized); }
    return serialized;
  };
  for (const requirement of requirements) {
    const file = requirement.file && resolve(providerIndex.scanRoot, requirement.file);
    const selected = requirement.providerCandidates?.filter((candidate) => candidate.selected && candidate.ref) || [];
    const candidates = new Map();
    const diagnostic = requirement.role === "diagnostic-probe" && requirement.command === "find_program";
    if (requirement.role && !diagnostic && !["software", "tool"].includes(requirement.role)) continue;
    const packageLookup = ["find_package", "find_dependency"].includes(requirement.command);
    const names = packageLookup || ["find_library", "find_static_library", "find_shared_library", "find_program"].includes(requirement.command) ?
      libraryRequestNames(requirement, packageLookup) : requirement.alternatives?.length ? requirement.alternatives : [requirement.requestedName];
    const tool = requirementToolContract(requirement);
    const queries = requirementQueries(requirement, names);
    if (tool) {
      queries.push(...tool.names.map((name) => ({ kind: "capability", name })), ...tool.binaries.map((name) => ({ kind: "tool", name })));
    }
    const args = requirement.arguments || [];
    let programSearch;
    const libraryLookup = librarySearchCommands.has(requirement.command);
    const unknownSearch = (packageLookup || ["find_library", "find_static_library", "find_shared_library", "find_program"].includes(requirement.command)) &&
      args.some((arg) => programSearchControls.test(arg) || !tool && ["COMPONENTS", "OPTIONAL_COMPONENTS"].includes(arg) || /\$\{|\$<unknown:/.test(arg));
    const unknownProgramSearch = requirement.command === "find_program" && (args.some((arg) => programSearchControls.test(arg)) ||
      args.length > 2 && !args.includes("NAMES") && !args.includes("NAME") && args.slice(2).some((arg) => !["REQUIRED", "OPTIONAL", "NO_CACHE"].includes(arg)));
    const finder = file && providerIndex.finderOccurrences?.get(`${file}:${requirement.line}`);
    for (const { kind, name, conditions, configTool } of queries) {
      if (!name) continue;
      for (const match of providerIndex.byExport.get(key(kind, name)) || []) {
        if (diagnostic && !observedExecutableExports.has(match.export)) continue;
        if (requirement.command === "find_program") {
          const signed = authenticatedProgramPaths.get(match.export);
          if (signed !== undefined) {
            programSearch ||= programSearchPaths(args);
            const path = match.export.file;
            if (signed) {
              const slash = path.length - name.length - 1;
              if (path[slash] !== "/" || !path.endsWith(name) ||
                !matchesSearchDirectory(path.slice(0, slash) || "/", programSearch, distributionProgramRoots)) continue;
            } else if (programSearch.restricted && !matchesSearchDirectory(posix.dirname(path), programSearch, distributionProgramRoots)) continue;
          }
        }
        const signedLibrary = libraryLookup && signedLibraryPaths.get(match.export);
        if (signedLibrary && !matchesSignedLibraryDirectory(match.export.file, signedLibrary.arch, programSearch ||= programSearchPaths(args))) continue;
        const { provider } = match;
        const fallback = match.export.mesonWrap && requirement.providerCandidates?.find((candidate) => candidate.kind === "local-wrap" &&
          (!candidate.ref || candidate.ref === provider.ref || providerIndex.sourceAliases?.get(candidate.ref) === provider.ref) &&
          candidate.source?.file && resolve(providerIndex.scanRoot, candidate.source.file) === match.export.mesonWrap);
        const dependencyVariable = fallback?.dependencyVariable || match.export.dependencyVariable;
        const wrapUnknown = Boolean(match.export.mesonWrap && (fallback || dependencyVariable && !provider.exports.some((entry) =>
          entry.kind === "meson" && !entry.mesonWrap && entry.name === dependencyVariable && !entry.materialUnknown)));
        const fallbackOption = match.export.mesonWrap && requirement.mesonOptions?.fallback;
        if (!fallbackOption?.unresolved && fallbackOption?.alternatives?.length === 1 &&
          (fallbackOption.alternatives[0].value === false ||
            Array.isArray(fallbackOption.alternatives[0].value) && !fallbackOption.alternatives[0].value.length)) continue;
        const finderStatus = finder && kind === "library" ? finderComplete(finder, match, providerIndex.byExport) ? "satisfied" : "unknown" : undefined;
        const entry = conditions?.length || configTool || fallback || finderStatus ? { ...match.export,
          ...(finderStatus ? { ...finder.evidence, predicateStatus: finderStatus } : {}),
          ...(conditions?.length || fallback?.conditions?.length ? { requirementConditions: [...new Set([...(conditions || []), ...(fallback?.conditions || [])])] } : {}),
          ...(dependencyVariable ? { dependencyVariable } : {}),
          ...(configTool ? { interfaceVersionUnknown: true } : {}) } : match.export;
        if (tool?.major) {
          const major = entry.pythonMajor ?? (entry.interfaceVersion && Number(entry.interfaceVersion.split(".")[0]));
          if (major !== undefined && major !== tool.major) continue;
        }
        if (!nativeProviderPlatformAccepts(provider, requirement) ||
          entry.artifactPlatform && !nativeProviderPlatformAccepts({ platform: entry.artifactPlatform }, requirement) ||
          entry.conditions?.includes("platform(ELF)") && !nativeProviderPlatformAccepts({ platform: "linux" }, requirement) ||
          entry.conditions?.includes("if(NOT WIN32)") && !compatibleOwnerConditions(["not(WIN32)"], requirement.conditions)) continue;
        if (packageLookup) {
          if (args.some((arg) => ["CONFIG", "NO_MODULE", "NAMES", "CONFIGS"].includes(arg)) && (entry.via || entry.kind === "build-helper")) continue;
          if (args.includes("MODULE") && !entry.via && entry.kind !== "build-helper") continue;
        }
        if (selected.length && !selected.some((candidate) => candidate.ref === provider.ref || providerIndex.sourceAliases?.get(candidate.ref) === provider.ref)) continue;
        const localModules = packageLookup ? providerIndex.localFindDefinitions?.get(name.toLowerCase()) : undefined;
        const localFinder = file && localModules && [...localModules].some((directory) => inside(directory, file));
        const outsideFinder = entry.consumerDirectory && (!file || !inside(entry.consumerDirectory, file));
        if (outsideFinder && (!file || !entry.consumerScopeDirectory || !inside(entry.consumerScopeDirectory, file) || localFinder)) continue;
        if (entry.builtinModule && localFinder) continue;
        const scoped = scopedProgramExports.get(match.export);
        if (scoped && (requirement.command !== "find_program" || !sameProgramInputs(scoped.arguments, args) ||
          !sameProgramInputs(scoped.invocations, requirement.helperInvocations || []))) continue;
        const configured = scopedConfiguredExports.get(match.export);
        if (configured !== undefined && (requirement.providerCandidates?.some((candidate) => candidate.selected) ||
          configured !== nativeScopedOccurrenceKey(requirement))) continue;
        if (entry.scopedSourceSelector) {
          const revision = file && selectorRevisionOf(file);
          if (outsideFinder || revision?.root !== entry.ownerDir || revision.version !== entry.sourceRevision) continue;
        } else if (!entry.global && !scoped && configured === undefined && (!file || ownerDirectoryOf(file) !== provider.directory)) continue;
        if (!entry.global && entry.lookupSource &&
          (entry.lookupSource !== `${file}:${requirement.line}` || !compatibleOwnerConditions(requirement.conditions, entry.conditions))) continue;
        const apiProvider = entry.interfaceVersion ? { ...provider, version: entry.interfaceVersion, versionKind: "interface-version", interfaceVersionUnknown: false, compatibilityMode: entry.compatibilityMode } : provider;
        const missingComponent = tool?.required.some((name) => !provider.exports.some((exp) => exp.kind === "capability" && exp.name === name &&
          !exp.materialUnknown && !exp.executableUnknown));
        const neededLinkage = requirement.command === "find_static_library" ? "static" : requirement.command === "find_shared_library" ? "shared" : undefined;
        const linkage = neededLinkage && (entry.linkage || artifactLinkage(entry.name) || artifactLinkage(entry.file));
        const version = configTool || entry.interfaceVersionUnknown && requirement.constraints?.trim() ? "unknown" :
          compatibleVersion(requirement, apiProvider, conditions);
        const uncertain = diagnostic || signedLibrary || entry.kind === "cmake-package" && signedPackageConfigs.has(match.export) ||
          entry.kind === "build-helper" || entry.predicateStatus === "unknown" || unknownSearch || unknownProgramSearch || missingComponent ||
          entry.materialUnknown || entry.executableUnknown || entry.material === "stub" || conditions?.length || outsideFinder || wrapUnknown ||
          neededLinkage && (!linkage || entry.sourceDeclared) || requirement.mesonOptions?.modules || requirement.mesonOptions?.optional_modules;
        const compatibility = version === "violated" || neededLinkage && linkage && neededLinkage !== linkage ? "violated" : uncertain ? "unknown" : version;
        if (!candidates.has(provider.ref)) candidates.set(provider.ref, { provider, exports: [], compatibility });
        const candidate = candidates.get(provider.ref);
        if (compatibility === "satisfied" || candidate.compatibility === "violated" && compatibility === "unknown") candidate.compatibility = compatibility;
        if (!candidate.exports.length) candidate.exports.push(entry);
        else if (candidate.exports[0] !== entry) {
          const seen = candidate.exportKeys ||= new Set([exportKey(candidate.exports[0])]);
          const serialized = exportKey(entry);
          if (!seen.has(serialized)) { seen.add(serialized); candidate.exports.push(entry); }
        }
      }
    }
    if (diagnostic && !candidates.size) continue;
    const all = [...candidates.values()];
    const compatible = all.filter((candidate) => candidate.compatibility === "satisfied");
    const record = { requirement, candidates: all.map((candidate) => ({ ref: candidate.provider.ref, compatibility: candidate.compatibility, exports: candidate.exports })) };
    if (compatible.length) bindings.push({ ...record, providerRefs: compatible.map((candidate) => candidate.provider.ref), providers: compatible.map((candidate) => ({ ...candidate.provider, exports: candidate.exports })), compatibility: "satisfied" });
    else unresolved.push({ ...record, compatibility: all.length && all.every((candidate) => candidate.compatibility === "violated") ? "violated" : "unknown" });
  }
  return { bindings, unresolved };
}

function artifactLinkage(name) {
  if (/\.a$/i.test(name || "")) return "static";
  if (/\.(?:so(?:\.\d+)*|dylib|dll)$/i.test(name || "")) return "shared";
}

function libraryRequestNames(requirement, packageLookup) {
  const args = requirement.arguments || [];
  const at = args.findIndex((arg) => arg === "NAMES" || !packageLookup && arg === "NAME");
  const names = packageLookup && at >= 0 ? [] : [requirement.requestedName, ...(requirement.alternatives || [])];
  if (at >= 0) for (const arg of args.slice(at + 1)) {
    if ((packageLookup ? packageFindControls : libraryFindControls).has(arg) || programSearchControls.test(arg)) break;
    if (requirement.command === "find_program" ? safeMember(arg) : identity(arg)) names.push(arg);
  }
  return [...new Set(names)];
}
