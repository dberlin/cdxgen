import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { readRegularTextFile } from "../core/boundedFile.js";
import { expandCmakeVariables, parseCmakeCommands } from "../parsers/cmakeLists.js";
import { parsePurlLoose } from "../inventory/purl.js";
import { loadNativeExternalMetadata, nativeObservedProviderEvidence, nativeProviderPlatformAccepts } from "./nativeExternalMetadata.js";
import { nativeMesonExports } from "./nativeRegistryMetadata.js";

const MAX_METADATA_BYTES = 512 * 1024;
const identity = (name) => typeof name === "string" && /^[A-Za-z0-9_][A-Za-z0-9_.:+-]*$/.test(name);
const inside = (directory, file) => { const path = relative(directory, file); return path !== ".." && !path.startsWith("../") && !path.startsWith("..\\"); };
const key = (kind, name) => `${kind}:${kind === "cmake-package" ? name.toLowerCase() : name}`;
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

const providerCommands = new Set(["add_library", "install", "export", "set_target_properties", "set_property", "find_library", "find_path", "find_file", "find_program",
  "configure_file", "configure_package_config_file", "write_basic_package_version_file", "rocm_export_targets"]);

function providerInitialBindings(fact) {
  const name = fact.component.name;
  const version = fact.component.version;
  return [
    ...(fact.variables || []),
    ["PROJECT_NAME", name], ["CMAKE_PROJECT_NAME", name],
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
    fact.component.name, fact.component.version, prop(fact.component, "cdx:version:kind"), [...variables]]);
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

function providerCondition(args, env, raw = args, quoted = []) {
  const atOr = args.indexOf("OR");
  const atAnd = args.indexOf("AND");
  const at = atOr > 0 ? atOr : atAnd;
  if (at > 0) {
    const first = providerCondition(args.slice(0, at), env, raw.slice(0, at), quoted.slice(0, at));
    const second = providerCondition(args.slice(at + 1), env, raw.slice(at + 1), quoted.slice(at + 1));
    return args[at] === "AND" ? first === false || second === false ? false : first === true && second === true ? true : undefined :
      first === true || second === true ? true : first === false && second === false ? false : undefined;
  }
  if (args[0] === "NOT") { const value = providerCondition(args.slice(1), env, raw.slice(1), quoted.slice(1)); return value === undefined ? undefined : !value; }
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
  if (args[0] === "DEFINED" && typeof env.get(args[1]) === "string") return !env.get(args[1]).includes("$");
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
  for (const [index, command] of definition.body.entries()) {
    if (providerCommands.has(command.name) || command.name === "return" || command.name === "cmake_language" && command.args[0] === "CALL" || ["set", "unset"].includes(command.name) && command.args.includes("PARENT_SCOPE") ||
      definitions.has(command.name) && reachesExport(definitions.get(command.name))) {
      selected.add(index);
      // add_library source file lists do not affect its exported identity.
      needArgs(command.name === "add_library" ? command.args.slice(0, 3) : command.args);
      if (command.name === "return" && command.args[0] === "PROPAGATE") {
        for (const name of command.args.slice(1)) if (identity(name)) needed.add(name);
      }
    }
  }
  for (let round = 0; round < 16; round++) {
    const before = selected.size + needed.size;
    for (const [index, command] of definition.body.entries()) {
      const output = command.name === "set" || command.name === "unset" ? command.args[0] :
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
        for (const branch of block.branches || []) selected.add(branch);
        const opener = definition.body[block.index];
        needArgs(opener.args);
        if (opener.name === "foreach" && opener.args[1] === "IN" && opener.args[2] === "LISTS") for (const arg of opener.args.slice(3)) needed.add(arg);
        for (const arg of opener.args) if (identity(arg)) needed.add(arg);
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

/** Source facts must identify a versioned owner, not a dependency with a similar
 * name. Files are read at most once per collection; no requirement traverses a
 * source tree. Export entries retain their exact declaration span and owner. */
export function collectNativeProviders(sourceFacts, resolutionInputs = {}) {
  const scanRoot = resolve(resolutionInputs.scanRoot || ".");
  const owners = sourceFacts.filter((fact) => fact.component?.version && fact.component?.["bom-ref"] && fact.directory)
    .map((fact) => ({ ...fact, directory: resolve(fact.directory) })).filter((fact) => inside(scanRoot, fact.directory));
  const ownerDirs = new Set(owners.map((fact) => fact.directory));
  const independentDirectories = new Set(ownerDirs);
  let independentRevision = 0;
  const markIndependent = (directory) => {
    if (!independentDirectories.has(directory)) {
      independentDirectories.add(directory);
      independentRevision++;
    }
  };
  const files = new Map();
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
    return files.get(file);
  };
  const commandCache = new Map();
  const commandsOf = (file) => {
    if (!commandCache.has(file)) commandCache.set(file, parseCmakeCommands(metadata(file)));
    return commandCache.get(file);
  };
  const manifests = Array.isArray(resolutionInputs.nativeSourceManifests) ?
    [...new Set(resolutionInputs.nativeSourceManifests.map((file) => resolve(scanRoot, file)).filter((file) => inside(scanRoot, file)))] : undefined;
  const modulesByName = new Map();
  const manifestsByOwner = new Map();
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
  for (const fact of [...owners, ...builtinContexts]) {
    const context = JSON.stringify([fact.directory, fact.contextKey || ""]);
    if (!byDirectory.has(context)) byDirectory.set(context, []);
    byDirectory.get(context).push(fact);
  }
  // Reuse is local to this collection and only retained for future exact
  // inputs. Keep original context/fact order; this is not owner deduplication.
  const evaluationSeeds = new Map();
  const evaluationUses = new Map();
  const evaluationResults = new Map();
  if (resolutionInputs.nativeProviderContextReuse !== false) {
    const directoryUses = new Map();
    for (const facts of byDirectory.values()) directoryUses.set(facts[0].directory, (directoryUses.get(facts[0].directory) || 0) + 1);
    for (const facts of byDirectory.values()) {
      if (directoryUses.get(facts[0].directory) < 2) continue;
      const seed = providerEvaluationSeed(facts[0]);
      if (!seed) continue;
      evaluationSeeds.set(facts, seed);
      evaluationUses.set(seed.key, (evaluationUses.get(seed.key) || 0) + 1);
    }
  }
  for (const facts of byDirectory.values()) {
    const directory = facts[0].directory;
    const contractFiles = facts[0].contractFiles;
    let commandCount = 0;
    let fileCount = 0;
    const evaluationSeed = evaluationSeeds.get(facts);
    evaluationSeeds.delete(facts);
    const remainingUses = evaluationSeed ? evaluationUses.get(evaluationSeed.key) - 1 : 0;
    if (evaluationSeed) {
      if (remainingUses) evaluationUses.set(evaluationSeed.key, remainingUses);
      else evaluationUses.delete(evaluationSeed.key);
    }
    const cached = evaluationSeed && evaluationResults.get(evaluationSeed.key);
    if (cached && cached.independentRevision === independentRevision) {
      const evaluation = structuredClone(cached.result);
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
      if (!remainingUses) evaluationResults.delete(evaluationSeed.key);
      registerOwnerFacts(evaluation.exports, evaluation.projectDeclarations);
      continue;
    }
    if (cached) evaluationResults.delete(evaluationSeed.key);
    const evaluationStart = evaluationSeed && remainingUses ? {
      independentRevision, stages: stagedTransforms.length, stagedKeys: stagedKeys.size,
      findModules: findModules.length, compilerChecks: compilerChecks.length, wraps: wraps.length, diagnostics: diagnostics.length,
    } : undefined;
    evaluationWrites = evaluationStart ? { findDefinitions: [], findContracts: [] } : undefined;
    const builtinFiles = new Map((contractFiles || []).map((entry) => [entry.file, entry]));
    // Repeated component aliases of the same source owner share metadata work.
    const exports = [];
    const exportKeys = new Set();
    const configInterfaces = new Map();
    const add = (kind, name, source, conditions = [], global = true, exportedVersion, attributes = {}) => {
      if (["header-file", "data-file"].includes(kind) ? typeof name !== "string" || !/^[A-Za-z0-9_.][A-Za-z0-9_./+-]*$/.test(name) || name.split("/").includes("..") : !identity(name)) return;
      const entry = { kind, name, source, ownerDir: directory, conditions: [...conditions], global,
        ...(exportedVersion ? { interfaceVersion: exportedVersion } : {}), ...attributes };
      const entryKey = JSON.stringify(entry);
      if (!exportKeys.has(entryKey)) {
        exportKeys.add(entryKey);
        exports.push(entry);
      }
    };
    const targets = new Map();
    const exportSets = new Map();
    const definitions = new ProviderDefinitions();
    const installPayloadFiles = new Map();
    const generatedFiles = new Map();
    const generatedInstalls = [];
    let installedEntries = 0;
    let helperSummaries = new WeakMap();
    let summaryCount = 0;
    let summaryRevision = definitions.revision;
    const observableState = { revision: 0 };
    const active = new Set();
    const projectDeclarations = [];
    let activeFindModule;
    let activeFindFile;
    const visitedManifests = new Set();
    const scopeDirectory = facts[0].scopeDirectory || directory;
    const outputBranches = [];
    const writeOutputs = (item, outputs) => {
      for (const branch of outputBranches) if (!branch.targetInitial.has(item.name)) branch.targetInitial.set(item.name, item.outputNames);
      item.outputNames = outputs;
    };
    const saveOutputs = (branch) => new Map([...branch.targetInitial.keys()].map((name) => [name, targets.get(name).outputNames]));
    const saveGenerated = (branch, condition = branch.condition) => new Map([...branch.generatedInitial].map(([path, original]) =>
      [path, (generatedFiles.get(path) || original).map((entry) => ({ ...entry,
        conditions: branch.knownTrue ? entry.conditions : [...new Set([...entry.conditions, condition])] }))]));
    const initial = new ProviderEnvironment(evaluationSeed?.variables || providerInitialBindings(facts[0]));
    const target = (name, source, conditions) => {
      if (!identity(name)) return undefined;
      if (!targets.has(name)) targets.set(name, { name, source, conditions: [...conditions], aliases: [], properties: new Map(), outputNames: [], installed: false });
      return targets.get(name);
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
      if (depth > 16 || !manifests && commandCount > 80000) return;
      const env = variables;
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
        if (index + commandOffset > 20000 || !manifests && commandCount > 80000) { diagnostics.push({ directory, file, reason: "command-budget" }); return; }
        let name = command.name;
        const conditionProvenance = name === "if" || name === "elseif" ? { raw: [], quoted: [] } : undefined;
        let args = expandArgs(command, conditionProvenance);
        const source = `${file}:${command.line}`;
        if (["function", "macro"].includes(name)) {
          let nesting = 1;
          let end = index + 1;
          for (; end < commands.length; end++) {
            if (["function", "macro"].includes(commands[end].name)) nesting++;
            if (["endfunction", "endmacro"].includes(commands[end].name) && !--nesting) break;
          }
          if (!branches.some((branch) => branch.inactive)) definitions.set(args[0]?.toLowerCase(), {
            parameters: args.slice(1), body: commands.slice(index + 1, end), file, macro: name === "macro", argumentBindings,
            conditions: [...conditions, ...continuationGuards, ...branches.filter((branch) => !branch.knownTrue).map((branch) => branch.condition)] });
          index = end;
          continue;
        }
        if (name === "if") {
          const state = providerCondition(args, env, conditionProvenance.raw, conditionProvenance.quoted);
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
            for (const [name, outputs] of branch.targetInitial) targets.get(name).outputNames = outputs;
            env.restore(branch.env);
            continuationGuards = branch.entryGuards;
            branch.condition = `${branch.condition}/${name}(${command.args.join(" ")})`;
            const state = branch.takenTrue ? false : name === "else" ? true : providerCondition(args, env, conditionProvenance.raw, conditionProvenance.quoted);
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
              branch.targetStates.push(branch.targetInitial);
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
            for (const [name, original] of branch.targetInitial) {
              const outputs = [];
              const seen = new Set();
              for (const state of branch.targetStates) {
                for (const output of state.get(name) || original) {
                  const key = JSON.stringify(output);
                  if (!seen.has(key)) {
                    seen.add(key);
                    outputs.push(output);
                  }
                }
              }
              targets.get(name).outputNames = outputs;
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
                  if (branch.outputs[other].get(k) !== value) {
                    value = `$<unknown:${k}>`;
                    break;
                  }
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
          if (end + commandOffset > 20000 || !manifests && commandCount > 80000) { diagnostics.push({ directory, file, reason: "command-budget" }); return; }
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
          const known = values.length <= 128 && values.every((value) => !value.includes("$"));
          for (const value of known ? values : [`$<unknown:${args[0]}>`]) {
            const local = new ProviderEnvironment(env);
            local.set(args[0], value);
            let flow = evaluate(commands.slice(index + 1, end), file, local, [...guards, ...continuationGuards, `foreach(${args[0]} ${known ? value : "unknown"})`], depth + 1,
              parentWrites, uncertain || Boolean(continuationGuards.length) || !known || branches.some((branch) => !branch.knownTrue), 0, argumentBindings);
            if (flow?.states) for (const state of flow.states) {
              if (env.has(args[0])) state.set(args[0], env.get(args[0]));
              else state.delete(args[0]);
            }
            if (!known && flow) {
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
            for (const option of [...options, ...singles, ...multiples]) env.set(`${prefix}_${option}`, `$<unknown:${prefix}_${option}>`);
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
        else if (name === "string" && ["TOLOWER", "TOUPPER"].includes(args[0]) && args.length === 3) env.set(args[2], args[0] === "TOLOWER" ? args[1].toLowerCase() : args[1].toUpperCase());
        else if (name === "project" && identity(args[0])) {
          env.set("PROJECT_NAME", args[0]);
          const versionAt = args.indexOf("VERSION");
          if (versionAt >= 0) env.set("PROJECT_VERSION", args[versionAt + 1]);
          if (dirname(file) === directory) projectDeclarations.push({ name: args[0], source, conditions: guards });
          add("cmake-package", args[0], source, guards, false);
        } else if (name === "include" && args[0] && !args[0].includes("$")) {
          const candidates = [resolve(dirname(file), args[0]), resolve(directory, args[0]), resolve(directory, "cmake", `${args[0]}.cmake`),
            ...(env.get("CMAKE_MODULE_PATH") || "").split(";").filter((path) => path && !path.includes("$")).map((path) => resolve(path, `${args[0]}.cmake`))];
          const indexed = modulesByName.get(`${basename(args[0]).replace(/\.cmake$/, "")}.cmake`) || [];
          const scoped = indexed.filter((candidate) => inside(scopeDirectory, candidate));
          if (scoped.length === 1) candidates.push(scoped[0]);
          else if (!scoped.length && indexed.length === 1) candidates.push(indexed[0]);
          for (const candidate of candidates) if ((candidate.endsWith(".cmake") || /^CMakeLists[^/\\]*\.txt$/.test(basename(candidate))) && inside(scanRoot, candidate) && metadata(candidate) !== undefined) { visitCmake(candidate, env, [...guards, `include(${source})`], depth + 1, parentWrites, uncertain || branches.some((branch) => !branch.knownTrue)); break; }
        } else if (name === "add_subdirectory" && args[0] && !args[0].includes("$")) {
          const child = resolve(env.get("CMAKE_CURRENT_SOURCE_DIR") || dirname(file), args[0]);
          const childFile = join(child, "CMakeLists.txt");
          const text = inside(directory, child) && metadata(childFile);
          if (text !== undefined && text !== false) {
            if (ownerDirs.has(child) || parseCmakeCommands(text).some((item) => item.name === "project")) markIndependent(child);
            else {
              const writes = new Map();
              visitCmake(childFile, new ProviderEnvironment(env), guards, depth + 1, writes, uncertain || branches.some((branch) => !branch.knownTrue));
              for (const [key, value] of writes) value === undefined ? env.delete(key) : env.set(key, value);
            }
          }
        } else if (activeFindModule && ["find_library", "find_path", "find_file", "find_program"].includes(name)) {
          const at = args.findIndex((arg) => ["NAME", "NAMES"].includes(arg));
          const names = [];
          for (const arg of args.slice(at >= 0 ? at + 1 : 1)) {
            if (["HINTS", "PATHS", "PATH_SUFFIXES", "DOC", "REQUIRED", "NO_DEFAULT_PATH", "NO_CACHE", "NAMES_PER_DIR"].includes(arg)) break;
            const valid = name === "find_library" ? identity(arg) : /^[A-Za-z0-9_][A-Za-z0-9_./+-]*$/.test(arg) && !arg.split("/").includes("..");
            if (valid) names.push(arg);
          }
          if (names.length) findModules.push({ name: activeFindModule, moduleFile: activeFindFile, builtinModule: builtinFiles.get(activeFindFile), directory, source, destination: args[0], conditions: guards,
            libraries: name === "find_library" ? names : [], programs: name === "find_program" ? names : [],
            headers: ["find_path", "find_file"].includes(name) ? names : [] });
        } else if (name === "add_library" && identity(args[0])) {
          if (args[1] === "ALIAS" && identity(args[2])) targets.get(args[2])?.aliases.push({ name: args[0], source, conditions: guards });
          else if (!args.includes("IMPORTED")) {
            const item = target(args[0], source, guards);
            item.kind = args.find((arg) => ["INTERFACE", "OBJECT", "SHARED", "STATIC", "MODULE"].includes(arg));
            writeOutputs(item, ["INTERFACE", "OBJECT"].includes(item.kind) ? [] : [{ value: item.name, conditions: guards }]);
          }
        } else if (["set_target_properties", "set_property"].includes(name)) {
          const at = args.indexOf(name === "set_property" ? "PROPERTY" : "PROPERTIES");
          const names = name === "set_property" ? args[0] === "TARGET" ? args.slice(1, at) : [] : args.slice(0, at);
          if (at >= 0) for (const n of names) {
            const item = targets.get(n);
            if (!item) continue;
            for (let atProperty = at + 1; atProperty < args.length - 1; atProperty += 2) {
              item.properties.set(args[atProperty], args[atProperty + 1]);
              if (args[atProperty] === "OUTPUT_NAME") writeOutputs(item, item.outputNames.map((output) => ({
                value: args[atProperty + 1], conditions: [...new Set([...output.conditions, ...guards])],
              })));
            }
          }
        } else if (name === "install" && args[0] === "TARGETS") {
          const stop = args.findIndex((arg, at) => at > 0 && ["EXPORT", "DESTINATION", "RUNTIME", "LIBRARY", "ARCHIVE", "INCLUDES", "PUBLIC_HEADER", "PRIVATE_HEADER", "OBJECTS", "FILE_SET"].includes(arg));
          const names = args.slice(1, stop < 0 ? undefined : stop);
          const exportAt = args.indexOf("EXPORT");
          for (const n of names) {
            const item = targets.get(n);
            if (item) { item.installed = true; item.installSource = source; item.installConditions = guards; }
          }
          if (exportAt >= 0) exportSets.set(args[exportAt + 1], [...(exportSets.get(args[exportAt + 1]) || []), ...names]);
        } else if (name === "install" && args[0] === "EXPORT") {
          const namespace = args[args.indexOf("NAMESPACE") + 1];
          for (const n of exportSets.get(args[1]) || []) {
            const item = targets.get(n);
            if (item && args.includes("NAMESPACE")) add("target", `${namespace}${item.properties.get("EXPORT_NAME") || n}`, source, guards);
          }
        } else if (name === "rocm_export_targets") {
          const nameAt = args.indexOf("NAME");
          add("cmake-package", nameAt >= 0 ? args[nameAt + 1] : env.get("PROJECT_NAME")?.toLowerCase(), source, guards);
          const at = args.indexOf("TARGETS");
          if (at >= 0) for (const n of args.slice(at + 1)) {
            if (["NAME", "NAMESPACE", "DEPENDS", "STATIC_DEPENDS", "INCLUDE", "EXPORT"].includes(n)) break;
            const item = targets.get(n) || [...targets.values()].find((target) => target.aliases.some((alias) => alias.name === n));
            if (item) { item.installed = true; item.installSource = source; item.installConditions = guards; }
            if (item) add("target", n, source, guards);
          }
        } else if (name === "file" && args[0] === "WRITE" && args[1] && !args[1].includes("$")) {
          const path = resolve(env.get("CMAKE_CURRENT_BINARY_DIR") || directory, args[1]);
          if (!inside(directory, path)) continue;
          const content = args.slice(2).some((arg) => arg.includes("$")) ? undefined : args.slice(2).join("");
          for (const branch of outputBranches) if (!branch.generatedInitial.has(path)) branch.generatedInitial.set(path, generatedFiles.get(path) || []);
          generatedFiles.set(path, [{ content, source, conditions: guards }]);
        } else if (name === "file" && args[0] === "TO_NATIVE_PATH" && args.length === 3) {
          env.set(args[2], args[1]);
        } else if (["add_custom_target", "add_custom_command"].includes(name)) {
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
            if (stagedKeys.has(id)) continue;
            stagedKeys.add(id);
            stagedTransforms.push({ ...parsed, scriptFile, scriptSha256: createHash("sha256").update(script).digest("hex"),
              wrapFile, wrapDirectory, archiveSha256, sourceUrl, source, conditions: guards });
          }
        } else if (["configure_package_config_file", "configure_file", "write_basic_package_version_file"].includes(name)) {
          const output = args[name === "write_basic_package_version_file" ? 0 : 1];
          const versionAt = args.indexOf("VERSION");
          exportConfig(output, source, guards, args[0], env, name === "configure_file" && !args.includes("@ONLY"));
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
        } else if (name === "install" && args[0] === "FILES") {
          const destinationAt = args.indexOf("DESTINATION");
          const destination = destinationAt >= 0 ? args[destinationAt + 1] : undefined;
          for (const arg of args.slice(1)) {
            if (["DESTINATION", "COMPONENT", "RENAME"].includes(arg)) break;
            exportConfig(arg, source, guards, arg, env);
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
            if (payload.includes("$")) continue;
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
                  try { children = readdirSync(parent, { withFileTypes: true }); } catch { return; }
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
        } else if (definitions.has(name)) {
          const definition = definitions.get(name);
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
              !manifests && commandCount + summary.commands > 80000 ||
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
            flow = evaluate(slice, definition.file, local,
              [...guards, ...(definition.conditions || []), `call(${source})`], depth + 1, writes,
              definition.macro && callUncertain, 0, bindings);
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
    const visitCmake = (file, inherited, conditions = [], depth = 0, parentWrites = new Map(), uncertain = false) => {
      if (active.has(file) || !manifests && ++fileCount > 2048 || !inside(scanRoot, file) && !builtinFiles.has(file) ||
        basename(file) === "CMakeLists.txt" && !inside(directory, file)) return;
      const text = metadata(file);
      if (text === undefined) return;
      active.add(file);
      if (basename(file) === "CMakeLists.txt") visitedManifests.add(file);
      const env = inherited;
      const oldList = env.get("CMAKE_CURRENT_LIST_DIR");
      const oldSource = env.get("CMAKE_CURRENT_SOURCE_DIR");
      if (basename(file) === "CMakeLists.txt") {
        env.set("CMAKE_CURRENT_SOURCE_DIR", dirname(file));
        env.set("CMAKE_CURRENT_BINARY_DIR", dirname(file));
      }
      const flow = evaluate(commandsOf(file), file, env, conditions, depth, parentWrites, uncertain);
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
      active.delete(file);
    };
    if (!contractFiles) visitCmake(join(directory, "CMakeLists.txt"), initial);
    for (const file of contractFiles ? [] : manifestsByOwner.get(directory) || []) if (basename(file) === "CMakeLists.txt" && !visitedManifests.has(file)) {
      visitCmake(file, new ProviderEnvironment(initial), ["source-manifest-available"], 0);
    }
    // Install rules name files, not snapshots of their bytes at declaration
    // time. Resolve generated payloads only after this owner is configured.
    for (const install of generatedInstalls) for (const generated of generatedFiles.get(install.path) || []) {
      if (!compatibleOwnerConditions(install.conditions, generated.conditions)) continue;
      const full = generated.content?.trim();
      const version = full?.match(/^(?:\d+:)?(\d+\.\d+\.\d+)[0-9A-Za-z.+_~:-]*$/)?.[1];
      add("data-file", install.name, generated.source, [...new Set([...generated.conditions, ...install.conditions])], true, version, {
        materialUnknown: true, interfaceVersionUnknown: !version, installationSource: install.source,
        ...(version ? { generatedVersion: full, generatedSha256: createHash("sha256").update(generated.content).digest("hex") } : {}),
      });
    }
    for (const item of targets.values()) {
      add("target", item.name, item.source, item.conditions, item.installed);
      for (const alias of item.aliases) add("target", alias.name, alias.source, alias.conditions, item.installed);
      for (const output of item.outputNames) {
        const guards = [...new Set([...output.conditions, ...(item.installConditions || [])])];
        add("library", output.value, item.installSource || item.source, guards, item.installed);
        const prefix = item.properties.get("PREFIX");
        const suffix = item.properties.get("SUFFIX");
        if (item.kind === "STATIC") add("library", `${prefix ?? "lib"}${output.value}${suffix ?? ".a"}`, item.installSource || item.source, guards, item.installed);
        else if (["SHARED", "MODULE"].includes(item.kind)) add("library", `${prefix ?? "lib"}${output.value}${suffix ?? ".so"}`, item.installSource || item.source,
          suffix === undefined ? [...guards, "platform(ELF)"] : guards, item.installed);
        else if (prefix !== undefined || suffix !== undefined) add("library", `${prefix ?? "lib"}${output.value}${suffix ?? ""}`, item.installSource || item.source, guards, item.installed);
      }
      for (const [name, value] of item.properties) if (/^(?:OUTPUT_NAME|LIBRARY_OUTPUT_NAME|ARCHIVE_OUTPUT_NAME)_[A-Z0-9_]+$/.test(name)) {
        add("library", value, item.installSource || item.source, [...(item.installConditions || item.conditions), `target-property(${name})`], item.installed);
      }
    }
    const collectMetadata = (file) => {
      const name = basename(file);
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
            for (const alias of names) if (identity(alias)) aliases.push({ name: alias, source: `${file}:${index + 1}` });
          }
        }
        const ownerDirectory = resolve(dirname(file), sourceDir);
        if (inside(scanRoot, ownerDirectory)) wraps.push({ directory, ownerDirectory, aliases });
      } else if (/^Find.+\.cmake$/.test(name)) {
        const previous = activeFindModule;
        const previousFile = activeFindFile;
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
        const required = [];
        for (const command of commands) if (command.name === "find_package_handle_standard_args") {
          const at = command.args.indexOf("REQUIRED_VARS");
          if (at >= 0) for (const arg of command.args.slice(at + 1)) {
            if (["VERSION_VAR", "HANDLE_COMPONENTS", "CONFIG_MODE", "REASON_FAILURE_MESSAGE", "FAIL_MESSAGE", "NAME_MISMATCHED", "HANDLE_VERSION_RANGE"].includes(arg)) break;
            required.push(arg);
          }
          else if (command.args[1] === "DEFAULT_MSG") required.push(...command.args.slice(2));
        }
        if (required.length) {
          const contract = { required, source: `${file}:1` };
          findContracts.set(file, contract);
          evaluationWrites?.findContracts.push([file, contract]);
        }
        const dataSearches = providerDataFileSearches(commands, required);
        for (const search of dataSearches) findModules.push({ name: activeFindModule, moduleFile: file, builtinModule: builtinFiles.get(file), directory, source: `${file}:${search.line}`, destination: search.destination,
          conditions: ["custom-data-file-predicate-unevaluated"], libraries: [], headers: [], programs: [], dataFiles: search.names });
        if (!dataSearches.length && !commands.some((command) => ["find_library", "find_path", "find_file", "find_program"].includes(command.name)) &&
          commands.some((command) => ["function", "macro", "find_package", "find_package_handle_standard_args"].includes(command.name))) {
          add("build-helper", activeFindModule, `${file}:1`, ["bundled-find-module", "helper-predicates-unevaluated"], false);
        }
        activeFindModule = previous;
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
      try { for (const child of readdirSync(join(directory, "subprojects"), { withFileTypes: true })) {
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
      const interfaces = entry.kind === "cmake-package" && configInterfaces.get(entry.name.toLowerCase());
      if (!interfaces?.length) continue;
      exports.splice(at, 1, ...interfaces.map((evidence) => ({ ...entry, ...evidence,
        conditions: [...new Set([...entry.conditions, ...evidence.conditions])] })));
    }
    const writes = evaluationWrites;
    evaluationWrites = undefined;
    // Boundary discovery can change a later install's input. New staging
    // effects depend on global dedup state. Either case evaluates normally
    // until a repeat reaches a stable, effect-free cache boundary.
    if (evaluationStart && evaluationStart.independentRevision === independentRevision &&
      evaluationStart.stages === stagedTransforms.length && evaluationStart.stagedKeys === stagedKeys.size &&
      !active.size && !outputBranches.length) {
      evaluationResults.set(evaluationSeed.key, { independentRevision, result: structuredClone({
        exports, projectDeclarations, commandCount, fileCount,
        effects: {
          findModules: findModules.slice(evaluationStart.findModules),
          compilerChecks: compilerChecks.slice(evaluationStart.compilerChecks),
          wraps: wraps.slice(evaluationStart.wraps),
          diagnostics: diagnostics.slice(evaluationStart.diagnostics),
          findDefinitions: writes.findDefinitions, findContracts: writes.findContracts,
        },
      }) });
    }
    registerOwnerFacts(exports, projectDeclarations);
    function registerOwnerFacts(exports, projectDeclarations) {
      for (const fact of facts) {
        if (contractFiles) continue;
        const component = fact.component;
        const ownedExports = exports.filter((entry) => compatibleOwnerConditions(fact.conditions, entry.conditions));
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
        registerProvider({ ref: component["bom-ref"], component, packageIdentity: component.purl || component["bom-ref"], version: component.version,
          versionKind: prop(component, "cdx:version:kind") || "release", sourceIdentity: prop(component, "cdx:source:identity") || directory,
          directory, exports: ownedExports, conditions: fact.conditions || [], provenance: ownedExports.map((entry) => entry.source) });
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
  for (const component of resolutionInputs.availableProviders || []) {
    if (!component.version || !component["bom-ref"] || !prop(component, "cdx:native:providerIdentity") || !prop(component, "cdx:native:providerEvidence")) continue;
    let evidence;
    let exports;
    try {
      evidence = JSON.parse(prop(component, "cdx:native:providerEvidence"));
      exports = JSON.parse(prop(component, "cdx:native:providerExports") || "[]");
    } catch { continue; }
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence) || !Array.isArray(exports)) continue;
    let authenticated;
    if (typeof evidence.manifestPath === "string" && typeof evidence.metadataPath === "string") {
      if (!authenticatedManifests.has(evidence.manifestPath)) {
        const records = loadNativeExternalMetadata({ nativeProviderMetadata: [evidence.manifestPath] });
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
      if (observed && JSON.stringify(observed) === JSON.stringify(evidence)) authenticated = observed;
    }
    if (!authenticated || authenticated.version !== component.version ||
      (authenticated.packageName || authenticated.name) !== component.name ||
      authenticated.kind !== evidence.kind || authenticated.name !== evidence.name ||
      authenticated.metadataSha256 !== evidence.metadataSha256 || authenticated.manifestSha256 !== evidence.manifestSha256) continue;
    const valid = exports.filter((entry) => ["header-file", "library", "target", "pkg-config", "cmake-package", "meson", "tool", "capability"].includes(entry.kind) &&
      typeof entry.name === "string" && (entry.kind === "header-file" ? /^[A-Za-z0-9_][A-Za-z0-9_./+-]*$/.test(entry.name) && !entry.name.split("/").includes("..") : identity(entry.name)) &&
      typeof entry.source === "string" && entry.source.length > 0 &&
      matchesAuthenticatedExport(authenticated.exports, entry)).map((entry) => ({ ...entry,
      global: entry.global !== false, ownerRef: component["bom-ref"], conditions: entry.conditions || [] }));
    if (!valid.length) continue;
    registerProvider({ ref: component["bom-ref"], component, packageIdentity: component.purl || component["bom-ref"],
      version: component.version, versionKind: prop(component, "cdx:version:kind") || "release",
      interfaceVersionUnknown: authenticated.interfaceVersionUnknown === true || ["package-manifest", "installed-package-file"].includes(evidence.kind),
      platform: authenticated.platform, arch: authenticated.arch,
      exports: valid, conditions: authenticated.conditions || [], provenance: valid.map((entry) => entry.source) });
  }
  const stagedPayloads = new Map();
  const stagedProcessed = new Set();
  for (const stage of stagedTransforms) for (const provider of providers) {
    const original = [...provider.exports];
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
        provider.exports.push(derived);
        const exportKey = key(kind, name);
        if (!byExport.has(exportKey)) byExport.set(exportKey, []);
        byExport.get(exportKey).push({ provider, export: derived });
      });
    }
  }
  for (const wrap of wraps) for (const provider of providers) {
    if (provider.directory !== wrap.ownerDirectory) continue;
    for (const alias of wrap.aliases) {
      const entry = { kind: "meson", name: alias.name, source: alias.source, ownerDir: provider.directory,
        global: true, consumerDirectory: wrap.directory, conditions: ["local-wrap-provide"] };
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
  for (const module of findModules) for (const [kind, names] of [["library", module.libraries], ["header-file", module.headers || []], ["tool", module.programs || []], ["data-file", module.dataFiles || []]]) for (const name of names) {
    for (const match of byExport.get(key(kind, name)) || []) {
      if (!match.export.global) continue;
      const contract = findContracts.get(module.moduleFile);
      const groups = contract?.required.map((destination) => {
        const searches = findModules.filter((search) => search.moduleFile === module.moduleFile && search.destination === destination);
        return { destination, alternatives: searches.flatMap((search) => [
          ...search.libraries.map((name) => ({ kind: "library", name })),
          ...(search.headers || []).map((name) => ({ kind: "header-file", name })),
          ...(search.programs || []).map((name) => ({ kind: "tool", name })),
          ...(search.dataFiles || []).map((name) => ({ kind: "data-file", name })),
        ]) };
      });
      const complete = !groups || groups.every((group) => group.alternatives.some((alternative) =>
        (byExport.get(key(alternative.kind, alternative.name)) || []).some((candidate) => candidate.export.global)));
      const exportKey = key("cmake-package", module.name);
      if (!byExport.has(exportKey)) byExport.set(exportKey, []);
      byExport.get(exportKey).push({ provider: match.provider, export: { ...match.export,
        kind: "cmake-package", name: module.name, via: module.source, consumerDirectory: module.directory,
        ...(module.builtinModule ? { builtinModule: module.builtinModule } : {}),
        ...(groups ? { requiredArtifacts: groups, predicateStatus: complete ? "satisfied" : "unknown", predicateSource: contract.source } : {}),
        conditions: [...(match.export.conditions || []), ...(module.conditions || [])] } });
    }
  }
  return { providers, byExport, findModules, localFindDefinitions, independentDirectories, sourceAliases: resolutionInputs.sourceAliases || new Map(), scanRoot, diagnostics, metadataFilesRead: files.size };
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
  const binary = name === "Pytest" ? "pytest" : name === "Cython" ? "cython" : name === "Sphinx" ? "sphinx-build" : undefined;
  return binary ? { binaries: [binary], names: [], required: [] } : undefined;
}

function requirementKinds(requirement) {
  if (["find_package", "find_dependency"].includes(requirement.command)) return ["cmake-package", "build-helper"];
  if (["find_library", "find_static_library", "find_shared_library"].includes(requirement.command)) return ["library"];
  if (requirement.command === "find_program") return ["tool"];
  if (requirement.command === "dependency") {
    const methodArg = (requirement.arguments || []).find((arg) => /^\s*method\s*:/.test(arg));
    if (!methodArg) return ["meson", "pkg-config", "cmake-package"];
    const method = methodArg.match(/^\s*method\s*:\s*(['"])([^'"]+)\1\s*$/)?.[2];
    if (method === "auto") return ["meson", "pkg-config", "cmake-package"];
    if (method === "pkg-config") return ["meson", "pkg-config"];
    if (method === "cmake") return ["meson", "cmake-package"];
    return [];
  }
  return ["target", "library"];
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

/** Resolve every occurrence independently, keeping all evidenced alternatives.
 * Explicitly installed/config exports can be available across owners; private
 * build targets and bare project declarations cannot escape their own owner. */
export function resolveNativeRequirements(requirements, providerIndex) {
  const bindings = [];
  const unresolved = [];
  for (const requirement of requirements) {
    const file = requirement.file && resolve(providerIndex.scanRoot, requirement.file);
    const selected = requirement.providerCandidates?.filter((candidate) => candidate.selected && candidate.ref) || [];
    const candidates = new Map();
    if (requirement.role && !["software", "tool"].includes(requirement.role)) continue;
    const names = ["find_library", "find_program"].includes(requirement.command) ? libraryRequestNames(requirement) :
      requirement.alternatives?.length ? requirement.alternatives : [requirement.requestedName];
    const tool = requirementToolContract(requirement);
    const queries = requirementKinds(requirement).flatMap((kind) => names.map((name) => ({ kind, name })));
    if (tool) {
      queries.push(...tool.names.map((name) => ({ kind: "capability", name })), ...tool.binaries.map((name) => ({ kind: "tool", name })));
    }
    for (const { kind, name } of queries) {
      if (!name) continue;
      for (const match of providerIndex.byExport.get(key(kind, name)) || []) {
        const { provider, export: entry } = match;
        if (tool?.major) {
          const major = entry.pythonMajor ?? (entry.interfaceVersion && Number(entry.interfaceVersion.split(".")[0]));
          if (major !== undefined && major !== tool.major) continue;
        }
        const args = requirement.arguments || [];
        if (!nativeProviderPlatformAccepts(provider, requirement) ||
          entry.conditions?.includes("platform(ELF)") && !nativeProviderPlatformAccepts({ platform: "linux" }, requirement)) continue;
        if (["find_package", "find_dependency"].includes(requirement.command)) {
          if (args.some((arg) => ["CONFIG", "NO_MODULE"].includes(arg)) && (entry.via || entry.kind === "build-helper")) continue;
          if (args.includes("MODULE") && !entry.via && entry.kind !== "build-helper") continue;
        }
        if (selected.length && !selected.some((candidate) => candidate.ref === provider.ref || providerIndex.sourceAliases?.get(candidate.ref) === provider.ref)) continue;
        if (entry.consumerDirectory && (!file || !inside(entry.consumerDirectory, file))) continue;
        if (entry.builtinModule && file && [...(providerIndex.localFindDefinitions?.get(name.toLowerCase()) || [])].some((directory) => inside(directory, file))) continue;
        if (!entry.global && (!file || !inside(provider.directory, file))) continue;
        // An independent nested project is not a member of its ancestor owner.
        if (!entry.global && [...providerIndex.independentDirectories].some((directory) => directory !== provider.directory && inside(provider.directory, directory) && inside(directory, file))) continue;
        const apiProvider = entry.interfaceVersion ? { ...provider, version: entry.interfaceVersion, versionKind: "interface-version", interfaceVersionUnknown: false, compatibilityMode: entry.compatibilityMode } : provider;
        const unknownSearch = ["find_package", "find_dependency", "find_library", "find_program"].includes(requirement.command) &&
          args.some((arg) => ["HINTS", "PATHS", "NO_DEFAULT_PATH", ...(tool ? [] : ["COMPONENTS", "OPTIONAL_COMPONENTS"])].includes(arg) || /\$\{|\$<unknown:/.test(arg));
        const missingComponent = tool?.required.some((name) => !provider.exports.some((exp) => exp.kind === "capability" && exp.name === name &&
          !exp.materialUnknown && !exp.executableUnknown));
        const compatibility = entry.kind === "build-helper" || entry.predicateStatus === "unknown" || unknownSearch || missingComponent ||
          entry.materialUnknown || entry.executableUnknown || entry.material === "stub" ||
          entry.interfaceVersionUnknown && requirement.constraints?.trim() ? "unknown" : nativeProviderCompatibility(requirement, apiProvider);
        if (!candidates.has(provider.ref)) candidates.set(provider.ref, { provider, exports: [], compatibility });
        const candidate = candidates.get(provider.ref);
        if (compatibility === "satisfied" || candidate.compatibility === "violated" && compatibility === "unknown") candidate.compatibility = compatibility;
        candidate.exports.push(entry);
      }
    }
    const all = [...candidates.values()];
    const compatible = all.filter((candidate) => candidate.compatibility === "satisfied");
    const record = { requirement, candidates: all.map((candidate) => ({ ref: candidate.provider.ref, compatibility: candidate.compatibility, exports: candidate.exports })) };
    if (compatible.length) bindings.push({ ...record, providerRefs: compatible.map((candidate) => candidate.provider.ref), providers: compatible.map((candidate) => ({ ...candidate.provider, exports: candidate.exports })), compatibility: "satisfied" });
    else unresolved.push({ ...record, compatibility: all.length && all.every((candidate) => candidate.compatibility === "violated") ? "violated" : "unknown" });
  }
  return { bindings, unresolved };
}

function libraryRequestNames(requirement) {
  const names = [requirement.requestedName];
  const args = requirement.arguments || [];
  const at = args.findIndex((arg) => ["NAME", "NAMES"].includes(arg));
  if (at >= 0) for (const arg of args.slice(at + 1)) {
    if (["HINTS", "PATHS", "PATH_SUFFIXES", "DOC", "REQUIRED", "OPTIONAL", "NO_DEFAULT_PATH", "NO_CACHE", "NAMES_PER_DIR"].includes(arg)) break;
    if (identity(arg)) names.push(arg);
  }
  return [...new Set(names)];
}
