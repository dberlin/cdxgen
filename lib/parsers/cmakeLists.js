/**
 * Pure parser for CMake language files (`CMakeLists.txt`, `*.cmake`).
 *
 * `parseCmakeCommands` splits a file into command invocations the way CMake
 * reads it: command names are case-insensitive, an invocation may span several
 * lines, and arguments may be quoted, bracketed (`[[...]]`) or interleaved with
 * comments. `cmakeFetchDependencies` reads the commands that download a
 * dependency at configure time: `FetchContent_Declare`, `ExternalProject_Add`
 * and the CPM.cmake `CPMAddPackage` family.
 *
 * This module is layer 1 (text in, data out): no filesystem or subprocess
 * access. `lib/ecosystems/parsers-misc.js` turns the facts into components.
 */

/**
 * Length of the bracket opener (`[[`, `[=[`, `[==[`, ...) at `text[start]`, or 0.
 *
 * @param {string} text CMake source
 * @param {number} start Index of a `[`
 * @returns {number} Opener length including both brackets, or 0
 */
function bracketOpenLength(text, start) {
  if (text[start] !== "[") {
    return 0;
  }
  let i = start + 1;
  while (text[i] === "=") {
    i++;
  }
  return text[i] === "[" ? i - start + 1 : 0;
}

/**
 * Index just past the bracket closer matching an opener of `openLength`.
 *
 * @param {string} text CMake source
 * @param {number} contentStart First index after the opener
 * @param {number} openLength Opener length (`[==[` is 4)
 * @returns {number} Index after the closer, or the text length when unclosed
 */
function bracketCloseEnd(text, contentStart, openLength) {
  const closer = `]${"=".repeat(openLength - 2)}]`;
  const end = text.indexOf(closer, contentStart);
  return end === -1 ? text.length : end + closer.length;
}

/**
 * Index of the end of the comment starting at `text[start]` (a `#`).
 *
 * @param {string} text CMake source
 * @param {number} start Index of the `#`
 * @returns {number} Index of the first character after the comment
 */
function skipComment(text, start) {
  const openLength = bracketOpenLength(text, start + 1);
  if (openLength) {
    return bracketCloseEnd(text, start + 1 + openLength, openLength);
  }
  const eol = text.indexOf("\n", start);
  return eol === -1 ? text.length : eol;
}

function isIdentifierStart(c) {
  return (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_";
}

function isIdentifierPart(c) {
  return isIdentifierStart(c) || (c >= "0" && c <= "9");
}

function isSpace(c) {
  return c === " " || c === "\t" || c === "\r" || c === "\n";
}

/**
 * Split CMake source into command invocations.
 *
 * @param {string} text Contents of a CMake file
 * @returns {{name: string, args: string[], line: number, literalVariableOffsets?: Array<number[]|undefined>, quotedArguments?: boolean[]}[]} Invocations in
 *   source order. `name` is lower-cased; `args` have their quotes and bracket
 *   delimiters removed; `line` is the 1-based line of the command name.
 *   `literalVariableOffsets` is indexed by argument and records dollar signs
 *   protected by escaping or bracket syntax, not other references in that arg.
 *   `quotedArguments` identifies quote/bracket-delimited arguments whose
 *   expansion remains one argument rather than splitting on semicolons.
 */
export function parseCmakeCommands(text) {
  const commands = [];
  if (!text || typeof text !== "string") {
    return commands;
  }
  let line = 1;
  let i = 0;
  const advanceTo = (end) => {
    for (let k = i; k < end; k++) {
      if (text[k] === "\n") {
        line++;
      }
    }
    i = end;
  };
  while (i < text.length) {
    const c = text[i];
    if (c === "#") {
      advanceTo(skipComment(text, i));
      continue;
    }
    if (!isIdentifierStart(c) || (i > 0 && isIdentifierPart(text[i - 1]))) {
      advanceTo(i + 1);
      continue;
    }
    let end = i;
    while (end < text.length && isIdentifierPart(text[end])) {
      end++;
    }
    const name = text.slice(i, end).toLowerCase();
    const commandLine = line;
    let open = end;
    while (text[open] === " " || text[open] === "\t") {
      open++;
    }
    if (text[open] !== "(") {
      advanceTo(end);
      continue;
    }
    advanceTo(open + 1);
    const args = [];
    let literalVariableOffsets;
    let quotedArguments;
    let depth = 1;
    let current = "";
    let hasToken = false;
    let currentLiteralOffsets;
    let currentQuoted = false;
    const flush = () => {
      if (hasToken) {
        if (currentLiteralOffsets?.length) {
          literalVariableOffsets ||= [];
          literalVariableOffsets[args.length] = currentLiteralOffsets;
        }
        if (currentQuoted) {
          quotedArguments ||= [];
          quotedArguments[args.length] = true;
        }
        args.push(current);
      }
      current = "";
      hasToken = false;
      currentLiteralOffsets = undefined;
      currentQuoted = false;
    };
    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (ch === "\\" && i + 1 < text.length) {
        const escaped = text[i + 1];
        if (escaped === "\n" || (escaped === "\r" && text[i + 2] === "\n")) {
          advanceTo(i + (escaped === "\r" ? 3 : 2));
          continue;
        }
        if (escaped === "$" && text[i + 2] === "{") {
          currentLiteralOffsets ||= [];
          currentLiteralOffsets.push(current.length);
        }
        current += escaped === "n" ? "\n" : escaped === "r" ? "\r" : escaped === "t" ? "\t" : escaped;
        hasToken = true;
        advanceTo(i + 2);
        continue;
      }
      if (ch === "#") {
        flush();
        advanceTo(skipComment(text, i));
        continue;
      }
      if (ch === '"') {
        if (!hasToken) currentQuoted = true;
        let k = i + 1;
        let value = "";
        while (k < text.length && text[k] !== '"') {
          if (text[k] === "\\" && k + 1 < text.length) {
            if (text[k + 1] === "$" && text[k + 2] === "{") {
              currentLiteralOffsets ||= [];
              currentLiteralOffsets.push(current.length + value.length);
            }
            const escaped = text[k + 1];
            // Unlike identity escapes, quoted \; encodes itself for later
            // list interpretation. Unquoted decoding remains separate above.
            value += escaped === ";" ? "\\;" : escaped === "n" ? "\n" : escaped === "r" ? "\r" : escaped === "t" ? "\t" : escaped;
            k += 2;
            continue;
          }
          value += text[k];
          k++;
        }
        current += value;
        hasToken = true;
        advanceTo(Math.min(k + 1, text.length));
        continue;
      }
      const openLength = bracketOpenLength(text, i);
      if (openLength && !hasToken) {
        currentQuoted = true;
        const contentStart = i + openLength;
        const closeEnd = bracketCloseEnd(text, contentStart, openLength);
        const contentEnd = Math.max(contentStart, closeEnd - openLength);
        current += text.slice(contentStart, contentEnd);
        for (let offset = current.indexOf("${"); offset >= 0; offset = current.indexOf("${", offset + 2)) {
          currentLiteralOffsets ||= [];
          currentLiteralOffsets.push(offset);
        }
        hasToken = true;
        advanceTo(closeEnd);
        continue;
      }
      if (ch === "(") {
        depth++;
      } else if (ch === ")") {
        depth--;
        if (depth === 0) {
          flush();
          advanceTo(i + 1);
          break;
        }
      }
      if (isSpace(ch)) {
        flush();
      } else {
        current += ch;
        hasToken = true;
      }
      advanceTo(i + 1);
    }
    const command = { name, args, line: commandLine };
    if (literalVariableOffsets) command.literalVariableOffsets = literalVariableOffsets;
    if (quotedArguments) command.quotedArguments = quotedArguments;
    commands.push(command);
  }
  return commands;
}

// Upper bound on an expanded value; a set() chain that doubles a variable can
// otherwise grow it beyond the maximum string length.
const MAX_EXPANDED_LENGTH = 65536;

/**
 * Replace `${VAR}` references with the values of simple `set()` calls. A
 * reference to an unknown variable is left in place, so callers can tell a
 * resolved value from an unresolved one. Expansion stops at the previous
 * round once the text would exceed 64 KiB.
 *
 * @param {string} value Argument text
 * @param {Map<string,string>} variables Known variable values
 * @param {number[]} [literalOffsets] Literal dollar-sign offsets within this argument
 * @returns {string} The expanded text
 */
export function expandCmakeVariables(value, variables, literalOffsets) {
  if (literalOffsets?.length) {
    let result = "";
    let from = 0;
    for (const offset of literalOffsets) {
      const expanded = expandCmakeVariables(value.slice(from, offset), variables);
      if (result.length + expanded.length + 1 > MAX_EXPANDED_LENGTH) return value;
      result += expanded + value[offset];
      from = offset + 1;
    }
    const expanded = expandCmakeVariables(value.slice(from), variables);
    return result.length + expanded.length > MAX_EXPANDED_LENGTH ? value : result + expanded;
  }
  let result = value;
  for (let round = 0; round < 10 && result.includes("${"); round++) {
    let length = result.length;
    const next = result.replace(/\$\{([^${}]+)\}/g, (reference, key) => {
      const replacement = variables.get(key);
      if (replacement === undefined || length + replacement.length > MAX_EXPANDED_LENGTH) return reference;
      length += replacement.length - reference.length;
      return replacement;
    });
    if (next === result || next.length > MAX_EXPANDED_LENGTH) break;
    result = next;
  }
  return result;
}

/**
 * The variables a file sets to a single value: `set(FOO_VERSION 1.2.3)` and
 * `set(FOO_VERSION "1.2.3" CACHE STRING "...")`. Later definitions win.
 *
 * @param {{name: string, args: string[], literalVariableOffsets?: Array<number[]|undefined>}[]} commands Parsed commands
 * @returns {Map<string,string>} Variable values
 */
export function cmakeSetVariables(commands) {
  const variables = new Map();
  let definitions = 0;
  for (const command of commands) {
    if (command.name === "function" || command.name === "macro") { definitions++; continue; }
    if (command.name === "endfunction" || command.name === "endmacro") { definitions--; continue; }
    if (definitions) continue;
    if (command.name === "string" && command.args[0]?.toUpperCase() === "REPLACE" && command.args.length === 5) {
      const [, from, to, output, input] = command.args;
      const value = expandCmakeVariables(input, variables, command.literalVariableOffsets?.[4]);
      if (!value.includes("$")) variables.set(output, value.replaceAll(from, to));
      continue;
    }
    if (command.name !== "set" || command.args.length < 2) {
      continue;
    }
    const [key, value, ...rest] = command.args;
    if (
      rest.length === 0 ||
      rest[0] === "CACHE" ||
      rest[0] === "PARENT_SCOPE"
    ) {
      // An appending set(FOO "${FOO} ...") of an undefined FOO starts from an
      // empty value in CMake; dropping the self-reference also keeps it from
      // being substituted into itself on every later expansion round.
      const expandedKey = expandCmakeVariables(key, variables, command.literalVariableOffsets?.[0]);
      const expandedValue = expandCmakeVariables(value, variables, command.literalVariableOffsets?.[1]);
      const snapshot = command.literalVariableOffsets?.[1]?.length ? expandedValue : expandedValue.replaceAll(`\${${key}}`, "");
      variables.set(expandedKey, snapshot.includes("$") ? `$<unknown:${expandedKey}>` : snapshot);
    }
  }
  return variables;
}

/**
 * The value following `keyword` in a keyword-style argument list, skipping the
 * leading positional arguments.
 *
 * @param {string[]} args Command arguments
 * @param {string} keyword Keyword to look up, e.g. `GIT_TAG`
 * @param {number} from First index that may hold a keyword
 * @returns {string|undefined} The value, or undefined when absent
 */
function keywordValue(args, keyword, from) {
  for (let i = from; i < args.length - 1; i++) {
    if (args[i] === keyword) {
      return args[i + 1];
    }
  }
  return undefined;
}

const HOST_SHORTHANDS = {
  gh: "https://github.com/",
  gl: "https://gitlab.com/",
  bb: "https://bitbucket.org/",
};

/**
 * Read a CPM.cmake shorthand such as `gh:fmtlib/fmt#7.1.3`,
 * `gh:nlohmann/json@3.11.2` or `https://example.com/x.git@1.0#v1.0`.
 *
 * @param {string} spec The single CPMAddPackage argument
 * @returns {{name: string, gitRepository?: string, url?: string, gitTag?: string, version?: string}|undefined}
 */
function parseCpmShorthand(spec) {
  let rest = spec;
  let gitTag;
  let version;
  const hash = rest.lastIndexOf("#");
  if (hash !== -1) {
    gitTag = rest.slice(hash + 1);
    rest = rest.slice(0, hash);
  }
  const colon = rest.indexOf(":");
  const scheme = colon === -1 ? "" : rest.slice(0, colon);
  let repository;
  if (HOST_SHORTHANDS[scheme]) {
    let path = rest.slice(colon + 1);
    const at = path.lastIndexOf("@");
    if (at !== -1) {
      version = path.slice(at + 1);
      path = path.slice(0, at);
    }
    repository = `${HOST_SHORTHANDS[scheme]}${path}`;
  } else if (scheme === "https" || scheme === "http") {
    const lastSlash = rest.lastIndexOf("/");
    const at = rest.lastIndexOf("@");
    if (at > lastSlash) {
      version = rest.slice(at + 1);
      rest = rest.slice(0, at);
    }
    repository = rest;
  } else {
    return undefined;
  }
  const name = repository
    .split("/")
    .filter(Boolean)
    .pop()
    ?.replace(/\.git$/, "");
  if (!name) {
    return undefined;
  }
  return {
    name,
    gitRepository: repository,
    gitTag: gitTag || (version ? `v${version}` : undefined),
    version,
  };
}

const EXTERNAL_PROJECT_DIR_OPTIONS = new Set(["PREFIX", "TMP_DIR", "STAMP_DIR", "LOG_DIR", "DOWNLOAD_DIR", "SOURCE_DIR", "BINARY_DIR", "INSTALL_DIR"]);
const EXTERNAL_PROJECT_COMMAND_OPTIONS = new Set(["DOWNLOAD_COMMAND", "UPDATE_COMMAND", "PATCH_COMMAND", "CONFIGURE_COMMAND", "BUILD_COMMAND", "INSTALL_COMMAND", "TEST_COMMAND"]);

// The ExternalProject Git backend documents `master` when GIT_TAG is absent.
// Do not apply this rule to wrappers or an opaque forwarded option list.
function externalProjectGitDefault(command, repository) {
  if (command.name !== "externalproject_add" || command.helperTemplate || command.helperInvocations?.length ||
    !/^https?:\/\/[^\s$;]+$/i.test(repository || "")) return false;
  const { args, declaredArgs = args } = command;
  // An explicit DOWNLOAD_COMMAND (even an empty one) overrides Git download.
  if (["GIT_TAG", "DOWNLOAD_COMMAND"].some((option) => args.includes(option, 1) || declaredArgs.includes(option, 1))) return false;
  // A directory value, a single executable reference used as a command, or
  // a literal `-Dkey=` prefix is not an arbitrary options passthrough.
  return args.every((arg, index) => index === 0 || !arg.includes("$") ||
    EXTERNAL_PROJECT_DIR_OPTIONS.has(args[index - 1]) ||
    EXTERNAL_PROJECT_COMMAND_OPTIONS.has(args[index - 1]) && /^\$\{[A-Za-z_]\w*_EXECUTABLE\}$/.test(arg) ||
    /^-D[A-Za-z_][\w:]*=/.test(arg));
}

// This is positive evidence for the default independent CMake configure, not
// a guess based on the absence of CONFIGURE_COMMAND in an opaque option list.
function externalProjectStandaloneCmake(command, repository) {
  if (command.name !== "externalproject_add" || command.helperTemplate || command.helperInvocations?.length ||
    !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/i.test(repository || "")) return false;
  const { args, declaredArgs } = command;
  if (!declaredArgs || declaredArgs.length !== args.length || !/^[A-Za-z0-9_.+-]+$/.test(declaredArgs[0])) return false;
  const seen = new Set();
  const safePrefix = /^(?:\$\{CMAKE_CURRENT_BINARY_DIR\}|<INSTALL_DIR>|[A-Za-z0-9_./+-]+)(?:\/[A-Za-z0-9_.+-]+)*$/;
  for (let at = 1; at < args.length;) {
    const option = declaredArgs[at++];
    if (seen.has(option) || option !== args[at - 1]) return false;
    seen.add(option);
    const value = declaredArgs[at++];
    if (!value || args[at - 1]?.includes(";")) return false;
    if (option === "GIT_REPOSITORY" && value === repository ||
      option === "GIT_TAG" && value === args[at - 1] && /^[A-Za-z0-9_][A-Za-z0-9_./+-]*$/.test(value) ||
      option === "PREFIX" && safePrefix.test(value) ||
      option === "TIMEOUT" && /^\d+(?:\.\d+)?$/.test(value) ||
      option === "LOG_DOWNLOAD" && /^(?:ON|OFF|[01]|TRUE|FALSE)$/.test(value) ||
      option === "CMAKE_ARGS" && value.startsWith("-DCMAKE_INSTALL_PREFIX=") && safePrefix.test(value.slice("-DCMAKE_INSTALL_PREFIX=".length))) continue;
    const evaluated = args[at - 1];
    if (option === "UPDATE_COMMAND" && value === "${GIT_EXECUTABLE}" &&
      (evaluated === value || /^(?:(?:\/|[A-Za-z]:[\\/])(?:[A-Za-z0-9_.+-]+[\\/])*)?git(?:\.exe)?$/i.test(evaluated)) &&
      declaredArgs[at] === "pull" && args[at] === "pull") {
      at++;
      continue;
    }
    if (option !== "BUILD_COMMAND" && option !== "INSTALL_COMMAND" || !/^[a-z0-9_./+-]+$/.test(value)) return false;
    while (/^[a-z0-9_./+-]+$/.test(declaredArgs[at] || "")) at++;
  }
  return seen.has("GIT_REPOSITORY");
}

/**
 * The dependencies a CMake file downloads at configure time.
 *
 * `FetchContent_Declare(<name> ...)` and `ExternalProject_Add(<name> ...)` are
 * read for `GIT_REPOSITORY`/`GIT_TAG` and `URL`/`URL_HASH`/`URL_MD5`.
 * `CPMAddPackage`, `CPMFindPackage` and `CPMDeclarePackage` are read in both
 * the shorthand form and the keyword form (`NAME`, `VERSION`,
 * `GITHUB_REPOSITORY`, `GITLAB_REPOSITORY`, `BITBUCKET_REPOSITORY`,
 * `GIT_REPOSITORY`, `GIT_TAG`, `URL`, `URL_HASH`). `${VAR}` references are
 * expanded in command order. Callers evaluating local includes may supply
 * declaration-time expanded commands; those arguments are never replayed.
 *
 * @param {string} text Contents of a CMake file
 * @param {Object[]} [evaluatedCommands] Commands already expanded at declaration time
 * @returns {{kind: string, name: string, declaredName: string, line: number, gitRepository?: string, gitTag?: string, url?: string, urlHash?: string, version?: string, madeAvailable: boolean}[]}
 *   `kind` is `fetch`, `external-project` or `cpm`; `madeAvailable` is true
 *   when a `FetchContent_MakeAvailable` in the same file names the dependency.
 */
export function cmakeFetchDependencies(text, evaluatedCommands) {
  const variables = new Map();
  const commands = evaluatedCommands || parseCmakeCommands(text).map((command) => {
    const args = command.args.map((value, index) => expandCmakeVariables(value, variables, command.literalVariableOffsets?.[index]));
    if (command.name === "set") {
      const [key, value = "", ...rest] = args;
      if (key) variables.set(key, (!rest.length || ["CACHE", "PARENT_SCOPE"].includes(rest[0])) && !value.includes("$") ? value : `$<unknown:${key}>`);
    } else if (command.name === "unset" && args[0]) variables.delete(args[0]);
    return { ...command, args, ...(command.name === "externalproject_add" ? { declaredArgs: command.args } : {}) };
  });
  const madeAvailable = new Set();
  for (const command of commands) {
    if (command.name === "fetchcontent_makeavailable") {
      for (const arg of command.args) {
        madeAvailable.add(arg.toLowerCase());
      }
    }
  }
  const deps = [];
  for (const command of commands) {
    const args = command.args;
    let dep;
    if (
      (command.name === "fetchcontent_declare" ||
        ["externalproject_add", "therock_subproject_fetch", "file_download"].includes(command.name)) &&
      args.length
    ) {
      const url = keywordValue(args, "URL", 1);
      const md5 = keywordValue(args, "URL_MD5", 1);
      dep = {
        kind:
          command.name === "fetchcontent_declare"
            ? "fetch"
            : "external-project",
        name: args[0],
        gitRepository: keywordValue(args, "GIT_REPOSITORY", 1),
        gitTag: keywordValue(args, "GIT_TAG", 1),
        url: url?.split(";")[0],
        urlHash: keywordValue(args, "URL_HASH", 1) || (md5 && `MD5=${md5}`),
        sourceDir: keywordValue(args, "SOURCE_DIR", 1),
        downloadDestination: keywordValue(args, "SOURCE_FILE", 1),
      };
      if (externalProjectGitDefault(command, dep.gitRepository)) dep.gitTagDefault = "cmake-master";
      if (externalProjectStandaloneCmake(command, dep.gitRepository)) dep.standaloneCmake = true;
      if (command.name === "externalproject_add" && !dep.gitTag &&
        (args.includes("GIT_TAG", 1) || command.declaredArgs?.includes("GIT_TAG", 1))) dep.gitTagExplicit = true;
      if (command.name === "therock_subproject_fetch") dep.kind = "external-project";
      if (command.name === "file_download") dep.kind = "file-download";
    } else if (command.name === "file" && args[0]?.toUpperCase() === "DOWNLOAD" && args[1]) {
      const md5 = keywordValue(args, "EXPECTED_MD5", 3);
      let name;
      try { name = new URL(args[1]).pathname.split("/").filter(Boolean).at(-1); } catch { continue; }
      dep = { kind: "file-download", name, url: args[1], downloadDestination: args[2],
        urlHash: keywordValue(args, "EXPECTED_HASH", 3) || (md5 && `MD5=${md5}`) };
    } else if (
      command.name === "cpmaddpackage" ||
      command.name === "cpmfindpackage" ||
      command.name === "cpmdeclarepackage"
    ) {
      const positional = command.name === "cpmdeclarepackage" ? 1 : 0;
      if (args.length === positional + 1) {
        const shorthand = parseCpmShorthand(args[positional]);
        if (shorthand) {
          dep = {
            kind: "cpm",
            ...shorthand,
            name: positional ? args[0] : shorthand.name,
          };
        }
      } else if (args.length > positional) {
        const name = positional ? args[0] : keywordValue(args, "NAME", 0);
        const version = keywordValue(args, "VERSION", positional);
        const github = keywordValue(args, "GITHUB_REPOSITORY", positional);
        const gitlab = keywordValue(args, "GITLAB_REPOSITORY", positional);
        const bitbucket = keywordValue(
          args,
          "BITBUCKET_REPOSITORY",
          positional,
        );
        const hosted =
          (github && `${HOST_SHORTHANDS.gh}${github}`) ||
          (gitlab && `${HOST_SHORTHANDS.gl}${gitlab}`) ||
          (bitbucket && `${HOST_SHORTHANDS.bb}${bitbucket}`);
        const gitRepository =
          hosted || keywordValue(args, "GIT_REPOSITORY", positional);
        const url = keywordValue(args, "URL", positional);
        const derivedName =
          name ||
          (gitRepository || url)
            ?.split("/")
            .filter(Boolean)
            .pop()
            ?.replace(/\.git$/, "");
        if (derivedName) {
          dep = {
            kind: "cpm",
            name: derivedName,
            gitRepository,
            gitTag:
              keywordValue(args, "GIT_TAG", positional) ||
              (gitRepository && version ? `v${version}` : undefined),
            url,
            urlHash: keywordValue(args, "URL_HASH", positional),
            version,
          };
        }
      }
    }
    if (!dep || (!dep.gitRepository && !dep.url && (!dep.sourceDir || dep.sourceDir.includes("$")))) continue;
    let candidates = [dep];
    // A dynamic URL override does not erase explicitly listed fallback URLs.
    // These are declarations, never evidence that a fallback was selected.
    if (!dep.gitRepository && dep.url?.includes("$")) {
      const fallbackUrls = [];
      for (const arg of args.slice(args.indexOf("URL") + 1)) {
        if (!arg.includes("$") && !/^(?:https?|ftp):\/\//.test(arg)) break;
        for (const url of arg.split(";")) {
          if (!url.includes("$") && /^(?:https?|ftp):\/\//.test(url)) fallbackUrls.push(url);
        }
      }
      candidates = fallbackUrls.map((url) => ({ ...dep, url, sourceRole: "literal-fallback", unresolvedUrlOverride: true }));
    }
    for (const candidate of candidates) {
      candidate.declaredName = candidate.kind === "cpm" ? dep.name : command.declaredArgs?.[0] || (command.name === "file" ? command.args[0] : dep.name);
      const unresolvedName = !candidate.name || candidate.name.includes("$");
      if (unresolvedName) {
        const location = candidate.gitRepository || candidate.url;
        if (!location || location.includes("$")) continue;
        try {
          const url = new URL(location);
          if (!["https:", "http:", "ftp:"].includes(url.protocol)) continue;
          candidate.name = url.pathname.split("/").filter(Boolean).at(-1)?.replace(/\.git$/, "");
        } catch { continue; }
      }
      if (!candidate.name || candidate.name.includes("$") || candidate.name.includes("@")) continue;
      if (command.conditional || unresolvedName) candidate.conditional = true;
      if (command.conditions) candidate.conditions = command.conditions;
      if (command.helperTemplate) candidate.helperTemplate = true;
      if (command.helperInvocations) candidate.helperInvocations = command.helperInvocations;
      for (const key of Object.keys(candidate)) {
        if (candidate[key] === undefined || candidate[key] === "") delete candidate[key];
      }
      candidate.line = command.line;
      if (command.sourceFile) candidate.sourceFile = command.sourceFile;
      candidate.madeAvailable = madeAvailable.has(candidate.name.toLowerCase());
      deps.push(candidate);
    }
  }
  return deps;
}
