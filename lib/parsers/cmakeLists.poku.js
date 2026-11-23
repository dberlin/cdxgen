import { assert, describe, it } from "poku";

import {
  cmakeFetchDependencies,
  cmakeSetVariables,
  expandCmakeVariables,
  parseCmakeCommands,
} from "./cmakeLists.js";

describe("parseCmakeCommands()", () => {
  it("expands ordinary references while preserving escaped and bracket references in each argument", () => {
    const command = parseCmakeCommands(String.raw`message("${"${V}"}-\${LABEL}-${"${V}"}" [[${"${V}"}]] ${"${V}"} "\${LABEL}")`)[0];
    const values = new Map([["V", "1.2.3"], ["LABEL", "9.9.9"]]);
    assert.deepStrictEqual(command.args.map((arg, index) => expandCmakeVariables(arg, values, command.literalVariableOffsets?.[index])),
      ["1.2.3-${LABEL}-1.2.3", "${V}", "1.2.3", "${LABEL}"]);
    const deps = cmakeFetchDependencies(String.raw`set(TAG 1.2.3)
set(LABEL 9.9.9)
FetchContent_Declare(example GIT_REPOSITORY https://github.com/acme/example.git GIT_TAG v${"${TAG}"} PATCH_COMMAND echo \${LABEL})`);
    assert.strictEqual(deps[0].gitTag, "v1.2.3");
    const literal = cmakeFetchDependencies(String.raw`set(TAG 9.9.9)
set(ALIAS \${TAG})
FetchContent_Declare(example GIT_REPOSITORY https://github.com/acme/example.git GIT_TAG ${"${ALIAS}"})`);
    assert.ok(literal[0].gitTag.includes("$"), "literal references bound through an alias must not become numeric pins");
    const bindings = cmakeSetVariables(parseCmakeCommands(String.raw`set(TAG 9.9.9)
set(TAG \${TAG})`));
    assert.ok(bindings.get("TAG").includes("$"), "literal self references cannot be cleared or rebound as numeric versions");
  });

  it("preserves quoted semicolon escapes without changing unquoted decoding or literal reference offsets", () => {
    const commands = parseCmakeCommands(String.raw`set(QUOTED "a\;b\;c;")
set(UNQUOTED a\;b\;c)
set(BRACKET [[a\;b\;c;]])
set(REFERENCES "a\;b-\${LABEL}-${"${V}"}")`);
    assert.deepStrictEqual(commands.map((command) => command.args), [
      ["QUOTED", "a\\;b\\;c;"],
      ["UNQUOTED", "a;b;c"],
      ["BRACKET", "a\\;b\\;c;"],
      ["REFERENCES", "a\\;b-${LABEL}-${V}"],
    ]);
    const references = commands[3];
    assert.strictEqual(expandCmakeVariables(references.args[1], new Map([["LABEL", "not-literal"], ["V", "1.2.3"]]),
      references.literalVariableOffsets?.[1]), "a\\;b-${LABEL}-1.2.3");
  });

  it("handles unquoted escaped quotes and punctuation without swallowing later commands", () => {
    const commands = parseCmakeCommands(String.raw`set(ESCAPED a\"b a\(b\) a\#b a\ b)
add_custom_target(coverage COMMAND test --gtest_filter=\"value\")
find_package(Python3 COMPONENTS Interpreter)
#[[ find_package(DocumentationOnly 9.0) ]]
`);
    assert.deepStrictEqual(commands.map((c) => c.name), ["set", "add_custom_target", "find_package"]);
    assert.deepStrictEqual(commands[0].args, ["ESCAPED", 'a"b', "a(b)", "a#b", "a b"]);
    assert.deepStrictEqual(commands[1].args, ["coverage", "COMMAND", "test", '--gtest_filter="value"']);
    assert.deepStrictEqual(commands[2].args, ["Python3", "COMPONENTS", "Interpreter"]);
    assert.strictEqual(commands[2].line, 3);
    assert.deepStrictEqual(parseCmakeCommands("set(V a\\\nb)")[0].args, ["V", "ab"]);
  });

  it("reads multi-line, mixed-case invocations with quotes, brackets and comments", () => {
    const commands = parseCmakeCommands(`
# a comment with find_package(NotThis)
PROJECT(demo VERSION 1.2 LANGUAGES CXX)
#[[ a bracket comment
find_package(AlsoNotThis)
]]
FetchContent_Declare(
  googletest # trailing comment
  GIT_REPOSITORY "https://github.com/google/googletest.git"
  GIT_TAG        [=[v1.14.0]=]
)
message(STATUS "a (paren) and a \\"quote\\"")
if(WIN32 AND (MSVC OR CLANG))
endif()
`);
    assert.deepStrictEqual(
      commands.map((c) => [c.name, c.args, c.line]),
      [
        ["project", ["demo", "VERSION", "1.2", "LANGUAGES", "CXX"], 3],
        [
          "fetchcontent_declare",
          [
            "googletest",
            "GIT_REPOSITORY",
            "https://github.com/google/googletest.git",
            "GIT_TAG",
            "v1.14.0",
          ],
          7,
        ],
        ["message", ["STATUS", 'a (paren) and a "quote"'], 12],
        ["if", ["WIN32", "AND", "(MSVC", "OR", "CLANG)"], 13],
        ["endif", [], 14],
      ],
    );
  });

  it("returns nothing for empty or non-string input", () => {
    assert.deepStrictEqual(parseCmakeCommands(""), []);
    assert.deepStrictEqual(parseCmakeCommands(undefined), []);
  });
});

describe("CMake variables", () => {
  it("expands simple set() values and leaves unknown references alone", () => {
    const variables = cmakeSetVariables(
      parseCmakeCommands(`
set(FMT_MAJOR 10)
set(FMT_VERSION "\${FMT_MAJOR}.2.1" CACHE STRING "fmt version")
set(LIST_VAR a b c)
`),
    );
    assert.strictEqual(variables.get("FMT_VERSION"), "10.2.1");
    assert.strictEqual(variables.has("LIST_VAR"), false);
    assert.strictEqual(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: CMake variable references
      expandCmakeVariables("v${FMT_VERSION}-${UNKNOWN}", variables),
      // biome-ignore lint/suspicious/noTemplateCurlyInString: CMake variable references
      "v10.2.1-${UNKNOWN}",
    );
  });

  it("keeps appending set() calls of an undefined variable linear", () => {
    const appends = Array.from(
      { length: 40 },
      (_, n) => `set(C_FLAGS "\${C_FLAGS} -W${n}")`,
    ).join("\n");
    const variables = cmakeSetVariables(parseCmakeCommands(appends));
    assert.strictEqual(
      variables.get("C_FLAGS"),
      Array.from({ length: 40 }, (_, n) => ` -W${n}`).join(""),
    );
  });

  it("bounds the expansion of a doubling set() chain", () => {
    const doublings = Array.from(
      { length: 40 },
      () => `set(BIG "\${BIG}\${BIG}")`,
    ).join("\n");
    const variables = cmakeSetVariables(
      parseCmakeCommands(`set(BIG x)\n${doublings}`),
    );
    assert.ok(variables.get("BIG").length <= 2 * 65536 + 2);
  });
});

describe("cmakeFetchDependencies()", () => {
  it("keeps a generated scheduler name separate from its concrete repository identity", () => {
    const [dep] = cmakeFetchDependencies("ExternalProject_Add(${SCHEDULER} GIT_REPOSITORY https://github.com/acme/widget.git GIT_TAG main)");
    assert.equal(dep.declaredName, "${SCHEDULER}");
    assert.equal(dep.name, "widget");
    assert.equal(dep.gitRepository, "https://github.com/acme/widget.git");
  });
  it("reads FetchContent, ExternalProject and CPM dependencies", () => {
    const deps = cmakeFetchDependencies(`
include(FetchContent)
set(JSON_TAG v3.11.3)
FetchContent_Declare(json GIT_REPOSITORY https://github.com/nlohmann/json.git GIT_TAG \${JSON_TAG})
fetchcontent_declare(
  zlib
  URL https://zlib.net/zlib-1.3.1.tar.gz;https://mirror.example/zlib-1.3.1.tar.gz
  URL_HASH SHA256=9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23
)
FetchContent_MakeAvailable(json zlib)
ExternalProject_Add(pthreadpool
  URL https://github.com/Maratyszcza/pthreadpool/archive/4fe0e1e183925bf8cfa6aae24237e724a96479b8.zip
  URL_MD5 0123456789abcdef0123456789abcdef
)
CPMAddPackage("gh:fmtlib/fmt#10.2.1")
CPMAddPackage("gh:gabime/spdlog@1.13.0")
CPMAddPackage(NAME cxxopts GITHUB_REPOSITORY jarro2783/cxxopts VERSION 3.1.1)
CPMAddPackage(NAME doctest GIT_REPOSITORY https://github.com/doctest/doctest.git GIT_TAG v2.4.11)
CPMDeclarePackage(Catch2 GITLAB_REPOSITORY group/catch2 GIT_TAG abc123)
`);
    assert.deepStrictEqual(
      deps.map(({ line: _line, declaredName: _declaredName, ...rest }) => rest),
      [
        {
          kind: "fetch",
          name: "json",
          gitRepository: "https://github.com/nlohmann/json.git",
          gitTag: "v3.11.3",
          madeAvailable: true,
        },
        {
          kind: "fetch",
          name: "zlib",
          url: "https://zlib.net/zlib-1.3.1.tar.gz",
          urlHash:
            "SHA256=9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23",
          madeAvailable: true,
        },
        {
          kind: "external-project",
          name: "pthreadpool",
          url: "https://github.com/Maratyszcza/pthreadpool/archive/4fe0e1e183925bf8cfa6aae24237e724a96479b8.zip",
          urlHash: "MD5=0123456789abcdef0123456789abcdef",
          madeAvailable: false,
        },
        {
          kind: "cpm",
          name: "fmt",
          gitRepository: "https://github.com/fmtlib/fmt",
          gitTag: "10.2.1",
          madeAvailable: false,
        },
        {
          kind: "cpm",
          name: "spdlog",
          gitRepository: "https://github.com/gabime/spdlog",
          gitTag: "v1.13.0",
          version: "1.13.0",
          madeAvailable: false,
        },
        {
          kind: "cpm",
          name: "cxxopts",
          gitRepository: "https://github.com/jarro2783/cxxopts",
          gitTag: "v3.1.1",
          version: "3.1.1",
          madeAvailable: false,
        },
        {
          kind: "cpm",
          name: "doctest",
          gitRepository: "https://github.com/doctest/doctest.git",
          gitTag: "v2.4.11",
          madeAvailable: false,
        },
        {
          kind: "cpm",
          name: "Catch2",
          gitRepository: "https://gitlab.com/group/catch2",
          gitTag: "abc123",
          madeAvailable: false,
        },
      ],
    );
  });

  it("preserves standalone file download checksum and destination facts", () => {
    const deps = cmakeFetchDependencies(`
file(DOWNLOAD https://example.org/archive.zip \${CMAKE_CURRENT_BINARY_DIR}/archive.zip EXPECTED_HASH SHA256=${"a".repeat(64)})
file(DOWNLOAD https://example.org/data.trace data.trace EXPECTED_MD5 ${"b".repeat(32)})
`);
    assert.strictEqual(deps[0].kind, "file-download");
    assert.strictEqual(deps[0].urlHash, `SHA256=${"a".repeat(64)}`);
    assert.strictEqual(deps[0].downloadDestination, "${CMAKE_CURRENT_BINARY_DIR}/archive.zip");
    assert.strictEqual(deps[1].urlHash, `MD5=${"b".repeat(32)}`);
    assert.strictEqual(deps[1].declaredName, "DOWNLOAD");
  });

  it("distinguishes omitted from unresolved explicit Git selectors", () => {
    const deps = cmakeFetchDependencies(`
FetchContent_Declare(omitted GIT_REPOSITORY https://example.org/source.git)
FetchContent_Declare(explicit GIT_REPOSITORY https://example.org/source.git GIT_TAG \${GIT_TAG})
`);
    assert.strictEqual(deps[0].gitTag, undefined);
    assert.strictEqual(deps[1].gitTag, "${GIT_TAG}");
  });

  it("records the ExternalProject master default only for a proved omitted option", () => {
    const repository = "GIT_REPOSITORY https://example.org/source.git";
    const deps = cmakeFetchDependencies(`
ExternalProject_Add(omitted PREFIX \${CMAKE_CURRENT_BINARY_DIR} ${repository}
  UPDATE_COMMAND \${GIT_EXECUTABLE} pull CMAKE_ARGS "-DCMAKE_INSTALL_PREFIX=\${CMAKE_CURRENT_BINARY_DIR}/tpl")
ExternalProject_Add(empty ${repository} GIT_TAG "")
ExternalProject_Add(dynamic ${repository} GIT_TAG \${TAG})
ExternalProject_Add(forwarded ${repository} \${MORE_OPTIONS})
therock_subproject_fetch(wrapper ${repository})
ExternalProject_Add(disabled ${repository} DOWNLOAD_COMMAND "" UPDATE_COMMAND "")
ExternalProject_Add(custom ${repository} DOWNLOAD_COMMAND unpack-material)
`);
    assert.deepEqual(deps.map(({ name, gitTag, gitTagDefault, gitTagExplicit }) =>
      [name, gitTag, gitTagDefault, gitTagExplicit]), [
      ["omitted", undefined, "cmake-master", undefined],
      ["empty", undefined, undefined, true],
      ["dynamic", "${TAG}", undefined, undefined],
      ["forwarded", undefined, undefined, undefined],
      ["wrapper", undefined, undefined, undefined],
      ["disabled", undefined, undefined, undefined],
      ["custom", undefined, undefined, undefined],
    ]);
  });

  it("keeps an unresolved tag as written and skips nameless declarations", () => {
    const deps = cmakeFetchDependencies(`
FetchContent_Declare(lib GIT_REPOSITORY https://example.com/lib.git GIT_TAG \${LIB_TAG})
FetchContent_Declare()
CPMAddPackage("not-a-shorthand")
`);
    assert.deepStrictEqual(
      deps.map((d) => [d.name, d.gitTag]),
      // biome-ignore lint/suspicious/noTemplateCurlyInString: CMake variable reference
      [["lib", "${LIB_TAG}"]],
    );
  });
});
