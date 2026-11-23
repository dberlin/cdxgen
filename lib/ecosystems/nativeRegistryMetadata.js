import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { parseToml } from "../core/toml.js";
import { expandCmakeVariables, parseCmakeCommands } from "../parsers/cmakeLists.js";

const literal = (value) => typeof value === "string" && !/[\$@]/.test(value);
const name = (value) => typeof value === "string" && /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/.test(value);
const inside = (directory, file) => { const path = relative(directory, file); return !isAbsolute(path) && path !== ".." && !path.startsWith("../") && !path.startsWith("..\\"); };

const LANGUAGE_METADATA_BYTES = 256 * 1024;
const languageVersion = (value) => typeof value === "string" && /^\d+(?:\.\d+)*(?:[+_.!~\-]?[A-Za-z0-9]+(?:[+_.!~\-][A-Za-z0-9]+)*)?$/.test(value);
const safeSourcePath = (value) => typeof value === "string" && /^(?:\.\/)?[A-Za-z0-9_.+-]+(?:\/[A-Za-z0-9_.+-]+)*$/.test(value) &&
  !value.split("/").some((segment, index) => segment === ".." || segment === "." && index > 0);
const languageMetadata = (text) => {
  if (typeof text !== "string" || Buffer.byteLength(text) > LANGUAGE_METADATA_BYTES) return undefined;
  try { return parseToml(text); } catch { return undefined; }
};

function workspacePathMatches(pattern, member) {
  if (typeof pattern !== "string" || pattern.length > 512 ||
    !/^(?:\.\/)?(?:[A-Za-z0-9_.+-]+|\*)(?:\/(?:[A-Za-z0-9_.+-]+|\*))*\/?$/.test(pattern)) return false;
  const wanted = pattern.replace(/^\.\//, "").replace(/\/$/, "").split("/");
  return wanted.length === member.length && wanted.every((segment, index) => segment === "*" || segment === member[index]);
}

function cargoWorkspaceRelease(metadata, file, root, read) {
  const dir = dirname(file);
  const requested = metadata.package?.workspace;
  if (requested !== undefined && (typeof requested !== "string" || !/^(?:\.\.\/)*[A-Za-z0-9_./-]*$/.test(requested))) return undefined;
  const selected = requested === undefined ? undefined : resolve(dir, requested);
  if (selected && !inside(root, selected)) return undefined;
  let candidate = selected || dir;
  for (let depth = 0; depth <= 8 && inside(root, candidate); depth++) {
    const workspaceFile = join(candidate, "Cargo.toml");
    const workspace = (workspaceFile === file ? metadata : languageMetadata(read(workspaceFile)))?.workspace;
    if (workspace) {
      const member = relative(candidate, dir).split("\\").join("/").split("/");
      if (candidate !== dir && (!Array.isArray(workspace.members) || workspace.members.length > 256 ||
        !workspace.members.some((entry) => workspacePathMatches(entry, member)) ||
        Array.isArray(workspace.exclude) && (workspace.exclude.length > 256 || workspace.exclude.some((entry) => workspacePathMatches(entry, member))))) return undefined;
      const version = workspace.package?.version;
      return languageVersion(version) ? { version, versionSource: workspaceFile } : undefined;
    }
    if (selected || candidate === root || candidate === dirname(candidate)) break;
    candidate = dirname(candidate);
  }
  return undefined;
}

/** Read an already discovered language declaration; callers own the bounded
 * source/receipt inventory and no language code is imported or executed. */
export function nativeLanguageSourceFacts(file, text, { root = dirname(file), read = () => undefined, has = () => false, hasFiles, wanted } = {}) {
  file = resolve(file);
  root = resolve(root);
  if (!inside(root, file)) return undefined;
  const language = basename(file);
  if (language !== "Cargo.toml" && language !== "pyproject.toml") return undefined;
  const metadata = languageMetadata(text);
  if (!metadata) return undefined;
  const owner = language === "Cargo.toml" ? metadata.package : metadata.project;
  if (!name(owner?.name)) return undefined;
  const exports = [];
  const add = (kind, identity, line, extra = {}) => {
    if (!name(identity) || wanted && !wanted.has(identity)) return;
    exports.push({ kind, name: identity, source: `${file}:${line || 1}`, conditions: [], global: true,
      materialUnknown: true, interfaceVersionUnknown: true, ...(kind === "tool" ? { executableUnknown: true } : {}), ...extra });
  };
  const positions = { bins: [], scripts: new Map() };
  let section;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const heading = line.match(/^\s*(\[\[?[^\]]+\]\]?)\s*(?:#.*)?$/)?.[1];
    if (heading) section = heading;
    if (heading === "[[bin]]") positions.bins.push(index + 1);
    if (heading === "[lib]") positions.lib = index + 1;
    if (section === "[project.scripts]") {
      const key = line.match(/^\s*(?:([A-Za-z0-9_-]+)|['"]([A-Za-z0-9_.+-]+)['"])\s*=/);
      if (key && !positions.scripts.has(key[1] || key[2])) positions.scripts.set(key[1] || key[2], index + 1);
    }
  }
  if (language === "pyproject.toml") {
    if (typeof owner.scripts === "object" && owner.scripts !== null && !Array.isArray(owner.scripts)) {
      for (const [identity, entryPoint] of Object.entries(owner.scripts).slice(0, 256)) {
        if (typeof entryPoint === "string" && /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*:[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(entryPoint)) {
          add("tool", identity, positions.scripts.get(identity), { entryPoint });
        }
      }
    }
  } else {
    const directory = dirname(file);
    const resolvedPaths = (paths) => paths.filter(safeSourcePath).map((path) => resolve(directory, path));
    const pending = [];
    const binaries = Array.isArray(metadata.bin) ? metadata.bin.slice(0, 256) : [];
    const declared = new Set();
    for (const [index, bin] of binaries.entries()) {
      if (!name(bin?.name) || wanted && !wanted.has(bin.name)) continue;
      declared.add(bin.name);
      const paths = bin.path === undefined ? [
        ...(bin.name === owner.name ? ["src/main.rs"] : []), `src/bin/${bin.name}.rs`, `src/bin/${bin.name}/main.rs`,
      ] : [bin.path];
      const features = bin["required-features"] ?? [];
      if (!Array.isArray(features) || features.length > 64 || !features.every(name)) continue;
      pending.push({ kind: "tool", identity: bin.name, line: positions.bins[index], paths: resolvedPaths(paths),
        extra: { conditions: features.map((feature) => `cargo-feature:${feature}`) } });
    }
    if (owner.autobins !== false) {
      for (const identity of wanted || [owner.name]) {
        if (!name(identity) || declared.has(identity)) continue;
        const paths = [...(identity === owner.name ? ["src/main.rs"] : []),
          `src/bin/${identity}.rs`, `src/bin/${identity}/main.rs`];
        pending.push({ kind: "tool", identity, paths: resolvedPaths(paths) });
      }
    }
    if (!wanted && metadata.lib?.["proc-macro"] === true) {
      pending.push({ kind: "target", identity: metadata.lib.name || owner.name.replaceAll("-", "_"), line: positions.lib,
        paths: resolvedPaths([metadata.lib.path ?? "src/lib.rs"]), extra: { materialType: "rust-proc-macro", global: false } });
    }
    const verified = hasFiles && pending.length ? hasFiles([...new Set(pending.flatMap(({ paths }) => paths))]) : undefined;
    for (const { kind, identity, line, paths, extra } of pending) {
      const artifact = paths.find(verified ? (path) => verified.has(path) : has);
      if (artifact) add(kind, identity, line, { ...extra, artifact });
    }
  }
  const release = languageVersion(owner.version) ? { version: owner.version, versionSource: file } :
    language === "Cargo.toml" && owner.version?.workspace === true && (!wanted || exports.length) ?
      cargoWorkspaceRelease(metadata, file, root, read) : undefined;
  return { name: owner.name, source: file, ...release, exports };
}

/** Interpret registry metadata declarations only. No command, configure, build,
 * source mutation or arbitrary file access is performed. Includes are restricted
 * to the caller's already authenticated metadata map. */
export function nativeRegistryRecipeFacts(record, recipe, files = new Map(), recipePath = "/registry/portfile.cmake") {
  const version = record["version-semver"] || record.version || record["version-date"] || record["version-string"];
  const exports = []; const artifacts = []; const definitions = new Map();
  const usedFiles = new Set(); const active = new Set();
  let count = 0;
  const add = (kind, identity, source, conditions = [], caseInsensitive = false) => {
    if (!name(identity)) return;
    if (!exports.some((e) => e.kind === kind && e.name === identity && JSON.stringify(e.conditions) === JSON.stringify(conditions))) exports.push({ kind, name: identity, source, conditions: [...conditions], ...(kind === "pkg-config" ? { interfaceVersionUnknown: true } : {}), ...(caseInsensitive ? { caseInsensitive: true } : {}) });
  };
  const exportFile = (path, source, conditions) => {
    if (!literal(path)) return;
    const file = basename(path);
    const config = /^(.+?)(?:Config(?:Version)?|-config(?:-version)?)\.cmake(?:\.in)?$/.exec(file);
    if (config && !file.startsWith("Find")) add("cmake-package", config[1], source, conditions, /-config/.test(file));
    const pc = /^(.+)\.pc(?:\.in)?$/.exec(file);
    if (pc) add("pkg-config", pc[1], source, conditions);
  };
  const initial = new Map([["VERSION", version], ["PORT", record.name], ["CURRENT_PACKAGES_DIR", "/__native_packages__"],
    ["CURRENT_INSTALLED_DIR", "/__native_installed__"], ["CMAKE_CURRENT_LIST_DIR", dirname(recipePath)],
    ["CURRENT_PORT_DIR", dirname(recipePath)]]);
  const evaluate = (commands, env, file, inherited = [], depth = 0) => {
    if (depth > 12 || count > 20000) return;
    const guards = [...inherited];
    for (let at = 0; at < commands.length; at++) {
      if (++count > 20000) return;
      const command = commands[at];
      const args = command.args.flatMap((value, index) => {
        const expanded = expandCmakeVariables(value, env, command.literalVariableOffsets?.[index]);
        return value.startsWith("${") && !command.literalVariableOffsets?.[index]?.length ? expanded.split(";") : [expanded];
      });
      const source = `${file}:${command.line}`;
      if (["function", "macro"].includes(command.name)) {
        let level = 1; let end = at + 1;
        for (; end < commands.length; end++) {
          if (["function", "macro"].includes(commands[end].name)) level++;
          if (["endfunction", "endmacro"].includes(commands[end].name) && !--level) break;
        }
        if (name(args[0])) definitions.set(args[0].toLowerCase(), { parameters: args.slice(1), commands: commands.slice(at + 1, end), file, macro: command.name === "macro" });
        at = end; continue;
      }
      if (command.name === "foreach") {
        let level = 1; let end = at + 1;
        for (; end < commands.length; end++) {
          if (commands[end].name === "foreach") level++;
          if (commands[end].name === "endforeach" && !--level) break;
        }
        let values = [];
        if (args[1] === "IN" && args[2] === "LISTS") values = args.slice(3).flatMap((key) => (env.get(key) || "").split(";"));
        else if (args[1] === "IN" && args[2] === "ITEMS") values = args.slice(3);
        else if (args[1] !== "RANGE") values = args.slice(1);
        if (name(args[0])) for (const value of values.filter(literal).slice(0, 128)) {
          const local = new Map(env); local.set(args[0], value);
          evaluate(commands.slice(at + 1, end), local, file, guards, depth + 1);
        }
        at = end; continue;
      }
      if (command.name === "if") { guards.push(`if(${command.args.join(" ")})`); continue; }
      if (["else", "elseif"].includes(command.name)) { if (guards.length > inherited.length) guards[guards.length - 1] += `/${command.name}(${command.args.join(" ")})`; continue; }
      if (command.name === "endif") { if (guards.length > inherited.length) guards.pop(); continue; }
      if (command.name === "set" && name(args[0])) {
        const end = args.findIndex((arg) => ["CACHE", "PARENT_SCOPE"].includes(arg));
        const value = args.slice(1, end > 0 ? end : undefined).join(";");
        if (literal(value)) env.set(args[0], value); else env.delete(args[0]);
      } else if (command.name === "unset" && name(args[0])) env.delete(args[0]);
      else if (command.name === "list" && args[0] === "APPEND" && name(args[1])) {
        const values = [...(env.get(args[1]) || "").split(";").filter(Boolean), ...args.slice(2)];
        if (values.every(literal)) env.set(args[1], values.join(";")); else env.delete(args[1]);
      } else if (command.name === "string" && ["TOUPPER", "TOLOWER"].includes(args[0]) && literal(args[1]) && name(args[2])) env.set(args[2], args[0] === "TOUPPER" ? args[1].toUpperCase() : args[1].toLowerCase());
      else if (command.name === "string" && args[0] === "REPLACE" && args.length === 5 && args.slice(1).every(literal)) env.set(args[3], args[4].replaceAll(args[1], args[2]));
      else if (command.name === "include" && literal(args[0])) {
        const included = resolve(dirname(file), args[0]);
        const text = files.get(included) ?? files.get(`${included}.cmake`);
        const path = files.has(included) ? included : `${included}.cmake`;
        if (text !== undefined && !active.has(path)) {
          usedFiles.add(path); active.add(path);
          const local = new Map(env); local.set("CMAKE_CURRENT_LIST_DIR", dirname(path));
          evaluate(parseCmakeCommands(text), local, path, guards, depth + 1);
          for (const [key, value] of local) if (key !== "CMAKE_CURRENT_LIST_DIR") env.set(key, value);
          active.delete(path);
        }
      } else if (definitions.has(command.name)) {
        const definition = definitions.get(command.name); const local = new Map(env);
        definition.parameters.forEach((parameter, index) => local.set(parameter, args[index] || ""));
        local.set("ARGN", args.slice(definition.parameters.length).join(";")); local.set("ARGV", args.join(";"));
        args.forEach((arg, index) => local.set(`ARGV${index}`, arg));
        evaluate(definition.commands, local, definition.file, guards, depth + 1);
        if (definition.macro) for (const [key, value] of local) env.set(key, value);
      }
      if (/^vcpkg_(?:from_(?:github|gitlab|bitbucket|sourceforge|git)|download_distfile)$/.test(command.name)) {
        const shaAt = args.indexOf("SHA512"); const refAt = args.indexOf("REF");
        const sha512 = shaAt >= 0 ? args[shaAt + 1] : undefined; const revision = refAt >= 0 ? args[refAt + 1] : undefined;
        if (/^[a-f0-9]{128}$/i.test(sha512 || "") && !/^0+$/.test(sha512) || command.name === "vcpkg_from_git" && /^[a-f0-9]{40,64}$/i.test(revision || "")) {
          const artifact = { command: command.name, arguments: args, source, conditions: [...guards],
            ...(/^[a-f0-9]{128}$/i.test(sha512 || "") ? { sha512 } : {}), ...(literal(revision) ? { revision } : {}) };
          if (!artifacts.some((a) => JSON.stringify(a) === JSON.stringify(artifact))) artifacts.push(artifact);
        }
      }
      if (command.name === "vcpkg_cmake_config_fixup") {
        const packageAt = args.indexOf("PACKAGE_NAME"); const pathAt = args.indexOf("CONFIG_PATH");
        if (packageAt >= 0) add("cmake-package", args[packageAt + 1], source, guards, true);
        else add("cmake-package", record.name, source, guards, true);
        if (pathAt >= 0 && literal(args[pathAt + 1]) && !["lib", "lib64", "share", "cmake", "debug"].includes(basename(args[pathAt + 1]))) add("cmake-package", basename(args[pathAt + 1]), source, guards, true);
      }
      // Installed config/pc filenames in fixups, copies and generation commands
      // are concrete export evidence even when their upstream templates are not local.
      if (!["find_package", "find_dependency"].includes(command.name)) for (const arg of args) {
        if (literal(arg) && (arg.includes("/__native_packages__/") || ["configure_file", "configure_package_config_file", "install"].includes(command.name))) exportFile(arg, source, guards);
      }
    }
  };
  evaluate(parseCmakeCommands(recipe), initial, recipePath);
  return { artifacts, exports, usedFiles: [...usedFiles] };
}

/** Literal scalar/version formatting only; never evaluate Meson expressions. */
export function nativeMesonTemplateVersions(texts) {
  const values = new Map(); const conflicts = new Set(); const configured = new Map();
  const bind = (key, value) => {
    if (conflicts.has(key)) return;
    if (values.has(key) && values.get(key) !== value) { values.delete(key); conflicts.add(key); return; }
    values.set(key, value);
  };
  const sources = texts.map((text) => text.replace(/#[^\n]*/g, ""));
  for (const source of sources) for (const match of source.matchAll(/^\s*([A-Za-z_]\w*)\s*=\s*(?:(['"])([^'"\r\n]*)\2|(\d+))\s*$/gm)) bind(match[1], match[3] ?? match[4]);
  for (let round = 0; round < 8; round++) {
    for (const source of sources) for (const match of source.matchAll(/^\s*([A-Za-z_]\w*)\s*=\s*(['"])([^'"]*)\2\.format\(\s*([A-Za-z0-9_,\s]+)\)/gm)) {
      const args = match[4].split(",").map((arg) => arg.trim());
      if (!args.every((arg) => values.has(arg))) continue;
      const version = match[3].replace(/@(\d+)@/g, (all, at) => values.get(args[Number(at)]) ?? all);
      if (/^\d+(?:\.\d+)*$/.test(version)) bind(match[1], version);
    }
  }
  for (const source of sources) for (const match of source.matchAll(/\b[A-Za-z_]\w*\.set\(\s*['"]([A-Za-z_]\w*)['"]\s*,\s*([A-Za-z_]\w*)\s*\)/g)) {
    const version = values.get(match[2]);
    if (/^\d+(?:\.\d+)*$/.test(version || "")) {
      if (configured.has(match[1]) && configured.get(match[1]) !== version) configured.set(match[1], undefined);
      else if (!configured.has(match[1])) configured.set(match[1], version);
    }
  }
  return new Map([...configured].filter(([, version]) => version !== undefined));
}
// Parse only balanced calls and literal strings, never evaluate Meson code.
export function nativeMesonExports(text, file, directory, add) {
  const clean = text.replace(/#[^\n]*/g, "");
  const pkgconfigNames = new Set([...clean.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*import\(\s*['"]pkgconfig['"]\s*\)/g)].map((match) => match[1]));
  const rustNames = new Set([...clean.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*import\(\s*['"]rust['"]\s*\)/g)].map((match) => match[1]));
  const localLibraries = new Set();
  const localProcMacros = new Set();
  const localIncludes = new Set();
  const localDependencies = new Set();
  const calls = /\b(project|library|shared_library|static_library|both_libraries|executable|declare_dependency|include_directories|meson\.override_dependency|[A-Za-z_][A-Za-z0-9_]*\.(?:generate|proc_macro))\s*\(/g;
  let lineStart = 0;
  let lineNumber = 1;
  const branches = [];
  for (let match; (match = calls.exec(clean));) {
    let end = calls.lastIndex;
    let nesting = 1;
    let quote;
    for (; end < clean.length && nesting; end++) {
      const c = clean[end];
      if (quote) { if (c === "\\") end++; else if (c === quote) quote = undefined; }
      else if (c === "'" || c === '"') quote = c;
      else if (c === "(") nesting++;
      else if (c === ")") nesting--;
    }
    if (nesting) continue;
    const args = clean.slice(calls.lastIndex, end - 1);
    const literal = args.match(/^\s*(['"])([^'"]+)\1\s*(?:,|$)/)?.[2];
    for (let endOfLine; (endOfLine = clean.indexOf("\n", lineStart)) >= 0 && endOfLine < match.index;) {
      const line = clean.slice(lineStart, endOfLine).trim();
      if (/^(if|foreach)\s+/.test(line)) branches.push(line);
      else if (/^(endif|endforeach)\b/.test(line)) branches.pop();
      else if (/^(else|elif)\b/.test(line) && branches.length) branches[branches.length - 1] += `/${line}`;
      lineStart = endOfLine + 1;
      lineNumber++;
    }
    const source = `${file}:${lineNumber}`;
    const assigned = clean.slice(lineStart, match.index).match(/^\s*([A-Za-z_]\w*)\s*=\s*$/)?.[1];
    const conditions = [...branches];
    if (match[1] === "project") add("meson", literal, source, conditions, false);
    else if (match[1] === "include_directories") {
      if (assigned && literal && inside(directory, resolve(dirname(file), literal))) localIncludes.add(assigned);
    } else if (match[1] === "declare_dependency") {
      const linked = args.match(/\blink_with\s*:\s*(\[[^\]]*\]|[A-Za-z_][A-Za-z0-9_]*)\s*(?:,|$)/)?.[1];
      const links = linked?.startsWith("[") ? linked.slice(1, -1).split(",").map((value) => value.trim()).filter(Boolean) : linked ? [linked] : [];
      const includes = args.match(/\binclude_directories\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:,|$)/)?.[1];
      if (assigned && (links.length && links.every((name) => localLibraries.has(name) || localProcMacros.has(name)) || localIncludes.has(includes))) {
        localDependencies.add(assigned);
        if (links.length && links.every((name) => localProcMacros.has(name))) add("meson", assigned, source, conditions, false);
      }
    } else if (match[1] === "meson.override_dependency") {
      const dependency = args.match(/^\s*(['"])[^'"]+\1\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:,|$)/)?.[2];
      if (localDependencies.has(dependency)) add("meson", literal, source, conditions);
    }
    else if (match[1].endsWith(".generate")) {
      if (!pkgconfigNames.has(match[1].slice(0, -9))) continue;
      const filebase = args.match(/\bfilebase\s*:\s*(['"])([^'"]+)\1\s*(?:,|$)/)?.[2];
      // pkgconfig.generate's name is display metadata, not the .pc identity.
      const library = args.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:,|$)/)?.[1];
      if (filebase && localLibraries.has(library)) add("pkg-config", filebase, source, conditions);
    } else if (literal) {
      if (match[1].endsWith(".proc_macro")) {
        if (!rustNames.has(match[1].slice(0, -11))) continue;
        if (assigned) localProcMacros.add(assigned);
        add("target", literal, source, conditions, false, undefined, { materialType: "rust-proc-macro", materialUnknown: true, interfaceVersionUnknown: true });
      } else if (match[1] === "executable") {
        add("tool", literal, source, conditions, /\binstall\s*:\s*true\b/.test(args), undefined,
          { materialUnknown: true, interfaceVersionUnknown: true });
      } else {
        if (assigned) localLibraries.add(assigned);
        add("library", literal, source, conditions, /\binstall\s*:\s*true\b/.test(args));
      }
    }
    calls.lastIndex = end;
  }
}

/** Derive source-only exports from the caller's hash-verified archive members.
 * This deliberately consumes no filesystem paths beyond the supplied byte map. */
export function nativeMesonSourceExports(record, files, sourceArchives = new Map()) {
  const exports = [];
  const hashes = new Map();
  const hash = (file) => {
    if (!hashes.has(file)) hashes.set(file, createHash("sha256").update(files.get(file)).digest("hex"));
    return hashes.get(file);
  };
  for (const [inventory, contents] of files) {
    if (basename(inventory) !== "archive-manifest.json") continue;
    let members;
    try { members = JSON.parse(contents).members; } catch { continue; }
    if (!Array.isArray(members) || members.length > 100000) continue;
    const listed = new Set(members.filter((member) => typeof member === "string" && !member.startsWith("/") && !member.split("/").includes("..")));
    const archive = dirname(inventory);
    for (const [file, text] of files) {
      const manifestKind = basename(file);
      if (!["meson.build", "Cargo.toml", "pyproject.toml"].includes(manifestKind) || !inside(archive, file)) continue;
      const member = relative(archive, file).split("\\").join("/");
      if (!listed.has(member)) continue;
      const root = member.split("/")[0];
      const proof = sourceArchives.get(inventory);
      const provenance = () => ({ sourceSha256: hash(file), archiveManifest: inventory, archiveManifestSha256: hash(inventory),
        ...(proof ? { sourceArchive: { ...proof } } : {}) });
      if (manifestKind !== "meson.build") {
        // A nested independent crate/distribution isn't the registry port.
        if (!proof || manifestKind === "Cargo.toml" && typeof proof.regularMembers !== "function" ||
          member !== `${root}/${manifestKind}` && member !== manifestKind) continue;
        const scope = dirname(file);
        const facts = nativeLanguageSourceFacts(file, text, {
          root: scope, read: (path) => listed.has(relative(archive, path).split("\\").join("/")) ? files.get(path) : undefined,
          hasFiles: manifestKind === "Cargo.toml" ? (paths) => {
            const membersByPath = paths.map((path) => [relative(archive, path).split("\\").join("/"), path]);
            const confirmed = proof.regularMembers(membersByPath.map(([member]) => member));
            return new Set(membersByPath.filter(([member]) => confirmed.has(member)).map(([, path]) => path));
          } : undefined,
        });
        const version = record["version-semver"] || record.version || record["version-date"] || record["version-string"];
        if (facts?.name !== record.name || !facts?.version || facts.version !== version) continue;
        for (const entry of facts.exports) exports.push({ ...entry, ...provenance() });
        continue;
      }
      if (!listed.has(`${root}/meson.build`)) continue;
      const rootFile = files.get(join(archive, root, "meson.build"));
      const project = rootFile?.replace(/#[^\n]*/g, "").match(/\bproject\s*\(\s*(['"])([^'"]+)\1/);
      if (!project || project[2].toLowerCase() !== record.name.toLowerCase()) continue;
      let parent = dirname(member).split("\\").join("/");
      let independent = false;
      while (parent && parent !== root) {
        const meson = `${parent}/meson.build`;
        const cmake = `${parent}/CMakeLists.txt`;
        const mesonText = files.get(join(archive, meson));
        const cmakeText = files.get(join(archive, cmake));
        if (listed.has(meson) && (mesonText === undefined || /^\s*project\s*\(/m.test(mesonText.replace(/#[^\n]*/g, ""))) ||
          listed.has(cmake) && (cmakeText === undefined || parseCmakeCommands(cmakeText).some((command) => command.name === "project"))) { independent = true; break; }
        parent = parent.includes("/") ? parent.slice(0, parent.lastIndexOf("/")) : "";
      }
      if (independent) continue;
      nativeMesonExports(text, file, join(archive, root), (kind, identity, source, conditions, global) => {
        if (!["library", "tool"].includes(kind) || !name(identity) || !global || kind === "tool" && !proof) return;
        exports.push({ kind, name: identity, source, conditions, global, materialUnknown: true, interfaceVersionUnknown: true,
          ...(kind === "tool" ? { executableUnknown: true } : {}), ...provenance() });
      });
    }
  }
  return exports;
}
