import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";

import { assert, it } from "poku";

import { nativeDownloadCacheKey } from "./nativeDownloadSources.js";

import {
  classifySwiftDependencyScopes,
  collectSwiftProductionTargets,
  isSwiftTestTarget,
  parseSwiftJsonTreeObject,
  parseXmakeRequiresLock,
  readMesonWraps,
} from "./parsers-misc.js";
import {
  parseBitbucketPipelinesFile,
  parseCabalData,
  parseCloudBuildData,
  parseCmakeDotFile,
  parseCmakeLikeFile,
  parseColliderLockData,
  parseComposerJson,
  parseComposerLock,
  parseConanData,
  parseConanLockData,
  parseContainerFile,
  parseContainerSpecData,
  parseCUsageSlice,
  parseFlakeLock,
  parseFlakeNix,
  parseGitHubWorkflowData,
  parseHelmYamlData,
  parseMakeDFile,
  parseMixLockData,
  parseOpenapiSpecData,
  parsePrivadoFile,
  parsePubLockData,
  parsePubYamlData,
  parseSwiftJsonTree,
  parseSwiftResolved,
} from "./utils.js";

it("parse pub lock", async () => {
  assert.deepStrictEqual(await parsePubLockData(null), []);
  const ret_val = await parsePubLockData(
    readFileSync("./test/data/pubspec.lock", { encoding: "utf-8" }),
  );
  const root_list = ret_val.rootList;
  let dep_list = ret_val.pkgList;
  assert.deepStrictEqual(dep_list.length, 28);
  assert.deepStrictEqual(dep_list[0], {
    name: "async",
    version: "2.11.0",
    _integrity:
      "sha256-947bfcf187f74dbc5e146c9eb9c0f10c9f8b30743e341481c1e2ed3ecc18c20c",
    "bom-ref": "pkg:pub/async@2.11.0",
    scope: "required",
    properties: [],
  });
  assert.deepStrictEqual(root_list.length, 3);
  assert.deepStrictEqual(root_list[0], {
    name: "flare_flutter",
    version: "3.0.2",
    _integrity:
      "sha256-99d63c60f00fac81249ce6410ee015d7b125c63d8278a30da81edf3317a1f6a0",
    "bom-ref": "pkg:pub/flare_flutter@3.0.2",
    scope: "required",
    properties: [],
  });
  dep_list = parsePubYamlData(
    readFileSync("./test/data/pubspec.yaml", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 1);
  assert.deepStrictEqual(dep_list[0], {
    name: "awesome_dialog",
    version: "2.2.1",
    description:
      "Flutter package to show beautiful dialogs(INFO,QUESTION,WARNING,SUCCESS,ERROR) with animations as simply as possible.",
    homepage: {
      url: "https://github.com/marcos930807/awesomeDialogs",
    },
    "bom-ref": "pkg:pub/awesome_dialog@2.2.1",
    purl: "pkg:pub/awesome_dialog@2.2.1",
  });
});

it("parse cabal freeze", () => {
  assert.deepStrictEqual(parseCabalData(null), []);
  let dep_list = parseCabalData(
    readFileSync("./test/data/cabal.project.freeze", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 24);
  assert.deepStrictEqual(dep_list[0], {
    name: "ansi-terminal",
    version: "0.11.3",
  });
  dep_list = parseCabalData(
    readFileSync("./test/data/cabal-2.project.freeze", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 366);
  assert.deepStrictEqual(dep_list[0], {
    name: "Cabal",
    version: "3.2.1.0",
  });
});

it("parse conan data", () => {
  let conanLockData = parseConanLockData(null);
  assert.deepStrictEqual(conanLockData.pkgList.length, 0);
  assert.deepStrictEqual(Object.keys(conanLockData.dependencies).length, 0);
  assert.deepStrictEqual(conanLockData.parentComponentDependencies.length, 0);
  conanLockData = parseConanLockData(
    readFileSync("./test/data/conan-v1.lock", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(conanLockData.pkgList.length, 3);
  assert.deepStrictEqual(conanLockData.pkgList[0], {
    name: "zstd",
    version: "1.4.4",
    "bom-ref": "pkg:conan/zstd@1.4.4",
    purl: "pkg:conan/zstd@1.4.4",
  });
  assert.deepStrictEqual(Object.keys(conanLockData.dependencies).length, 0);
  assert.deepStrictEqual(conanLockData.parentComponentDependencies, [
    "pkg:conan/zstd@1.4.4",
    "pkg:conan/jerryscript@2.2.0",
    "pkg:conan/wolfssl@4.4.0",
  ]);

  conanLockData = parseConanLockData(
    readFileSync("./test/data/conan-v1-for-reference.lock", {
      encoding: "utf-8",
    }),
  );
  assert.deepStrictEqual(Object.keys(conanLockData.pkgList).length, 7);
  assert.deepStrictEqual(conanLockData.pkgList[0], {
    name: "grpc",
    version: "1.50.1",
    "bom-ref": "pkg:conan/grpc@1.50.1",
    purl: "pkg:conan/grpc@1.50.1",
  });
  assert.deepStrictEqual(Object.keys(conanLockData.dependencies).length, 3);
  assert.deepStrictEqual(conanLockData.dependencies["pkg:conan/grpc@1.50.1"], [
    "pkg:conan/abseil@20230802.1",
    "pkg:conan/protobuf@3.21.12",
    "pkg:conan/c-ares@1.34.1",
    "pkg:conan/openssl@3.3.2",
    "pkg:conan/re2@20230301",
    "pkg:conan/zlib@1.3.1",
  ]);
  assert.deepStrictEqual(
    conanLockData.dependencies["pkg:conan/protobuf@3.21.12"],
    ["pkg:conan/zlib@1.3.1"],
  );
  assert.deepStrictEqual(
    conanLockData.dependencies["pkg:conan/openssl@3.3.2"],
    ["pkg:conan/zlib@1.3.1"],
  );
  assert.deepStrictEqual(conanLockData.parentComponentDependencies.length, 0);

  conanLockData = parseConanLockData(
    readFileSync("./test/data/conan-v1-with-nested-deps.lock", {
      encoding: "utf-8",
    }),
  );
  assert.deepStrictEqual(conanLockData.pkgList.length, 9);
  assert.deepStrictEqual(conanLockData.pkgList[0], {
    name: "grpc",
    version: "1.50.1",
    "bom-ref": "pkg:conan/grpc@1.50.1",
    purl: "pkg:conan/grpc@1.50.1",
  });
  assert.deepStrictEqual(conanLockData.pkgList[1], {
    name: "abseil",
    version: "20230802.1",
    "bom-ref": "pkg:conan/abseil@20230802.1",
    purl: "pkg:conan/abseil@20230802.1",
  });
  assert.deepStrictEqual(conanLockData.pkgList[2], {
    name: "protobuf",
    version: "3.21.12",
    "bom-ref": "pkg:conan/protobuf@3.21.12",
    purl: "pkg:conan/protobuf@3.21.12",
  });
  assert.deepStrictEqual(conanLockData.pkgList[3], {
    name: "zlib",
    version: "1.3.1",
    "bom-ref": "pkg:conan/zlib@1.3.1",
    purl: "pkg:conan/zlib@1.3.1",
  });
  assert.deepStrictEqual(conanLockData.pkgList[5], {
    name: "openssl",
    version: "3.3.2",
    "bom-ref": "pkg:conan/openssl@3.3.2",
    purl: "pkg:conan/openssl@3.3.2",
  });
  assert.deepStrictEqual(conanLockData.pkgList[8], {
    name: "gtest",
    version: "1.13.0",
    "bom-ref": "pkg:conan/gtest@1.13.0",
    purl: "pkg:conan/gtest@1.13.0",
  });
  assert.deepStrictEqual(Object.keys(conanLockData.dependencies).length, 3);
  assert.deepStrictEqual(conanLockData.dependencies["pkg:conan/grpc@1.50.1"], [
    "pkg:conan/abseil@20230802.1",
    "pkg:conan/protobuf@3.21.12",
    "pkg:conan/c-ares@1.34.1",
    "pkg:conan/openssl@3.3.2",
    "pkg:conan/re2@20230301",
    "pkg:conan/zlib@1.3.1",
  ]);
  assert.deepStrictEqual(
    conanLockData.dependencies["pkg:conan/protobuf@3.21.12"],
    ["pkg:conan/zlib@1.3.1"],
  );
  assert.deepStrictEqual(
    conanLockData.dependencies["pkg:conan/openssl@3.3.2"],
    ["pkg:conan/zlib@1.3.1"],
  );
  assert.deepStrictEqual(conanLockData.parentComponentDependencies.length, 3);
  assert.deepStrictEqual(
    conanLockData.parentComponentDependencies[0],
    "pkg:conan/grpc@1.50.1",
  );
  assert.deepStrictEqual(
    conanLockData.parentComponentDependencies[1],
    "pkg:conan/rapidjson@1.1.0",
  );
  assert.deepStrictEqual(
    conanLockData.parentComponentDependencies[2],
    "pkg:conan/gtest@1.13.0",
  );

  conanLockData = parseConanLockData(
    readFileSync("./test/data/conan-v2.lock", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(conanLockData.pkgList.length, 2);
  assert.deepStrictEqual(conanLockData.pkgList[0], {
    name: "opensta",
    version: "4.0.0",
    "bom-ref": "pkg:conan/opensta@4.0.0?rrev=765a7eed989e624c762a73291d712b14",
    purl: "pkg:conan/opensta@4.0.0?rrev=765a7eed989e624c762a73291d712b14",
  });
  assert.deepStrictEqual(Object.keys(conanLockData.dependencies).length, 0);
  assert.deepStrictEqual(conanLockData.parentComponentDependencies.length, 0);
  let dep_list = parseConanData(
    readFileSync("./test/data/conanfile.txt", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 3);
  assert.deepStrictEqual(dep_list[0], {
    name: "zstd",
    version: "1.4.4",
    "bom-ref": "pkg:conan/zstd@1.4.4",
    purl: "pkg:conan/zstd@1.4.4",
    scope: "required",
  });
  dep_list = parseConanData(
    readFileSync("./test/data/cmakes/conanfile.txt", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 1);
  assert.deepStrictEqual(dep_list[0], {
    name: "qr-code-generator",
    version: "1.8.0",
    "bom-ref": "pkg:conan/qr-code-generator@1.8.0",
    purl: "pkg:conan/qr-code-generator@1.8.0",
    scope: "required",
  });
  dep_list = parseConanData(
    readFileSync("./test/data/cmakes/conanfile1.txt", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 43);
  assert.deepStrictEqual(dep_list[0], {
    "bom-ref":
      "pkg:conan/7-Zip@19.00?channel=stable&rrev=bb67aa9bc0da3feddc68ca9f334f4c8b&user=iw",
    name: "7-Zip",
    purl: "pkg:conan/7-Zip@19.00?channel=stable&rrev=bb67aa9bc0da3feddc68ca9f334f4c8b&user=iw",
    scope: "required",
    version: "19.00",
  });
});

it("parse collider lock data", () => {
  let colliderLockData = parseColliderLockData(null);
  assert.deepStrictEqual(colliderLockData.pkgList.length, 0);
  assert.deepStrictEqual(Object.keys(colliderLockData.dependencies).length, 0);
  assert.deepStrictEqual(
    colliderLockData.parentComponentDependencies.length,
    0,
  );

  colliderLockData = parseColliderLockData(
    readFileSync("./test/data/collider.lock", { encoding: "utf-8" }),
    "./test/data/collider.lock",
  );
  assert.deepStrictEqual(colliderLockData.pkgList.length, 3);
  assert.deepStrictEqual(colliderLockData.pkgList[0], {
    name: "fmt",
    version: "11.0.2",
    "bom-ref": "pkg:generic/fmt@11.0.2",
    externalReferences: [
      {
        type: "distribution",
        url: "https://packages.example.com/collider/v2/",
      },
    ],
    hashes: [
      {
        alg: "SHA-256",
        content:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    ],
    properties: [
      { name: "internal:SrcFile", value: "./test/data/collider.lock" },
      { name: "cdx:collider:dependencyKind", value: "direct" },
      {
        name: "cdx:collider:wrapHash",
        value:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      { name: "cdx:collider:hasWrapHash", value: "true" },
      {
        name: "cdx:collider:origin",
        value: "https://packages.example.com/collider/v2/",
      },
      { name: "cdx:collider:originScheme", value: "https" },
      { name: "cdx:collider:originHost", value: "packages.example.com" },
    ],
    purl: "pkg:generic/fmt@11.0.2",
    scope: "required",
  });
  assert.deepStrictEqual(colliderLockData.pkgList[1], {
    name: "spdlog",
    version: "1.15.0",
    "bom-ref": "pkg:generic/spdlog@1.15.0",
    externalReferences: [
      {
        type: "distribution",
        url: "https://packages.example.com/collider/v2/",
      },
    ],
    hashes: [
      {
        alg: "SHA-256",
        content:
          "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    ],
    properties: [
      { name: "internal:SrcFile", value: "./test/data/collider.lock" },
      { name: "cdx:collider:dependencyKind", value: "direct" },
      {
        name: "cdx:collider:wrapHash",
        value:
          "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
      { name: "cdx:collider:hasWrapHash", value: "true" },
      {
        name: "cdx:collider:origin",
        value: "https://packages.example.com/collider/v2/",
      },
      { name: "cdx:collider:originScheme", value: "https" },
      { name: "cdx:collider:originHost", value: "packages.example.com" },
    ],
    purl: "pkg:generic/spdlog@1.15.0",
    scope: "required",
  });
  assert.deepStrictEqual(colliderLockData.pkgList[2], {
    name: "fast_float",
    version: "8.0.2",
    "bom-ref": "pkg:generic/fast_float@8.0.2",
    externalReferences: [
      {
        type: "distribution",
        url: "https://wrapdb.mesonbuild.com/v2/",
      },
    ],
    hashes: [
      {
        alg: "SHA-256",
        content:
          "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      },
    ],
    properties: [
      { name: "internal:SrcFile", value: "./test/data/collider.lock" },
      { name: "cdx:collider:dependencyKind", value: "transitive" },
      {
        name: "cdx:collider:wrapHash",
        value:
          "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      },
      { name: "cdx:collider:hasWrapHash", value: "true" },
      {
        name: "cdx:collider:origin",
        value: "https://wrapdb.mesonbuild.com/v2/",
      },
      { name: "cdx:collider:originScheme", value: "https" },
      { name: "cdx:collider:originHost", value: "wrapdb.mesonbuild.com" },
    ],
    purl: "pkg:generic/fast_float@8.0.2",
  });
  assert.deepStrictEqual(colliderLockData.dependencies, {
    "pkg:generic/fmt@11.0.2": [],
    "pkg:generic/spdlog@1.15.0": [],
    "pkg:generic/fast_float@8.0.2": [],
  });
  assert.deepStrictEqual(colliderLockData.parentComponentDependencies, [
    "pkg:generic/fmt@11.0.2",
    "pkg:generic/spdlog@1.15.0",
  ]);
});

it("parse collider lock data sanitizes origin metadata and tracks invalid wrap hashes", () => {
  const colliderLockData = parseColliderLockData(
    JSON.stringify({
      version: 1,
      dependencies: {
        "unsafe-origin": {
          version: "1.0.0",
          wrap_hash:
            "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
          origin: "https://user:pass@example.com/private/v2/?token=secret#frag",
        },
      },
      packages: {
        malformed: {
          version: "2.0.0",
          wrap_hash: "not-a-sha256",
          origin: "http://mirror.example.com/collider/v2/?sig=123",
        },
        "bad-origin": {
          version: "3.0.0",
          wrap_hash:
            "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          origin: "://not a url",
        },
      },
    }),
    "/repo/collider.lock",
  );
  assert.strictEqual(colliderLockData.pkgList.length, 3);
  const unsafeOrigin = colliderLockData.pkgList.find(
    (pkg) => pkg.name === "unsafe-origin",
  );
  const malformed = colliderLockData.pkgList.find(
    (pkg) => pkg.name === "malformed",
  );
  const badOrigin = colliderLockData.pkgList.find(
    (pkg) => pkg.name === "bad-origin",
  );
  assert.deepStrictEqual(
    unsafeOrigin.properties.find(
      (property) => property.name === "cdx:collider:origin",
    )?.value,
    "https://example.com/private/v2/",
  );
  assert.deepStrictEqual(
    unsafeOrigin.properties.find(
      (property) => property.name === "cdx:collider:originSanitized",
    )?.value,
    "true",
  );
  assert.deepStrictEqual(unsafeOrigin.externalReferences, [
    {
      type: "distribution",
      url: "https://example.com/private/v2/",
    },
  ]);
  assert.deepStrictEqual(
    malformed.properties.find(
      (property) => property.name === "cdx:collider:hasWrapHash",
    )?.value,
    "false",
  );
  assert.deepStrictEqual(
    malformed.properties.find(
      (property) => property.name === "cdx:collider:wrapHashInvalid",
    )?.value,
    "true",
  );
  assert.deepStrictEqual(
    malformed.properties.find(
      (property) => property.name === "cdx:collider:origin",
    )?.value,
    "http://mirror.example.com/collider/v2/",
  );
  assert.ok(!malformed.hashes);
  assert.ok(
    !badOrigin.properties.some(
      (property) => property.name === "cdx:collider:origin",
    ),
  );
  assert.ok(!badOrigin.externalReferences);
});

it("parse conan data where packages use custom user/channel", () => {
  const conanLockData = parseConanLockData(
    readFileSync("./test/data/conan.with_custom_pkg_user_channel.lock", {
      encoding: "utf-8",
    }),
  );
  assert.deepStrictEqual(conanLockData.pkgList.length, 4);
  assert.deepStrictEqual(conanLockData.pkgList[0], {
    name: "libcurl",
    version: "8.1.2",
    "bom-ref":
      "pkg:conan/libcurl@8.1.2?channel=stable&rrev=25215c550633ef0224152bc2c0556698&user=internal",
    purl: "pkg:conan/libcurl@8.1.2?channel=stable&rrev=25215c550633ef0224152bc2c0556698&user=internal",
  });
  assert.deepStrictEqual(conanLockData.pkgList[1], {
    name: "openssl",
    version: "3.1.0",
    "bom-ref":
      "pkg:conan/openssl@3.1.0?channel=stable&rrev=c9c6ab43aa40bafacf8b37c5948cdb1f&user=internal",
    purl: "pkg:conan/openssl@3.1.0?channel=stable&rrev=c9c6ab43aa40bafacf8b37c5948cdb1f&user=internal",
  });
  assert.deepStrictEqual(conanLockData.pkgList[2], {
    name: "zlib",
    version: "1.2.13",
    "bom-ref":
      "pkg:conan/zlib@1.2.13?channel=stable&rrev=aee6a56ff7927dc7261c55eb2db4fc5b&user=internal",
    purl: "pkg:conan/zlib@1.2.13?channel=stable&rrev=aee6a56ff7927dc7261c55eb2db4fc5b&user=internal",
  });
  assert.deepStrictEqual(conanLockData.pkgList[3], {
    name: "fmt",
    version: "10.0.0",
    purl: "pkg:conan/fmt@10.0.0?channel=stable&rrev=79e7cc169695bc058fb606f20df6bb10&user=internal",
    "bom-ref":
      "pkg:conan/fmt@10.0.0?channel=stable&rrev=79e7cc169695bc058fb606f20df6bb10&user=internal",
  });

  const dep_list = parseConanData(
    readFileSync("./test/data/conanfile.with_custom_pkg_user_channel.txt", {
      encoding: "utf-8",
    }),
  );
  assert.deepStrictEqual(dep_list.length, 2);
  assert.deepStrictEqual(dep_list[0], {
    name: "libcurl",
    version: "8.1.2",
    "bom-ref": "pkg:conan/libcurl@8.1.2?channel=stable&user=internal",
    purl: "pkg:conan/libcurl@8.1.2?channel=stable&user=internal",
    scope: "required",
  });
  assert.deepStrictEqual(dep_list[1], {
    name: "fmt",
    version: "10.0.0",
    purl: "pkg:conan/fmt@10.0.0?channel=stable&user=internal",
    "bom-ref": "pkg:conan/fmt@10.0.0?channel=stable&user=internal",
    scope: "optional",
  });
});

it("parse mix lock data", () => {
  assert.deepStrictEqual(parseMixLockData(null), []);
  let dep_list = parseMixLockData(
    readFileSync("./test/data/mix.lock", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 16);
  assert.deepStrictEqual(dep_list[0], {
    name: "absinthe",
    version: "1.7.0",
  });
  dep_list = parseMixLockData(
    readFileSync("./test/data/mix.lock.1", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 23);
  assert.deepStrictEqual(dep_list[0], {
    name: "bunt",
    version: "0.2.0",
  });
});

// biome-ignore-start lint/suspicious/noTemplateCurlyInString: fp
it("parse github actions workflow data", () => {
  assert.deepStrictEqual(parseGitHubWorkflowData(null), []);
  let dep_list = parseGitHubWorkflowData("./.github/workflows/nodejs.yml");
  assert.ok(dep_list.length);
  const firstAction = dep_list[0];
  assert.deepStrictEqual(firstAction["bom-ref"], firstAction.purl);
  assert.deepStrictEqual(firstAction.type, "application");
  assert.deepStrictEqual(firstAction.group, "actions");
  assert.deepStrictEqual(firstAction.name, "checkout");
  assert.ok(firstAction.version);
  assert.ok(firstAction.purl);
  assert.deepStrictEqual(firstAction.scope, "required");
  assert.deepStrictEqual(firstAction.evidence?.identity?.[0]?.field, "purl");
  assert.deepStrictEqual(
    firstAction.evidence?.identity?.[0]?.methods?.[0]?.value,
    "./.github/workflows/nodejs.yml",
  );
  const firstActionProps = Object.fromEntries(
    firstAction.properties.map((prop) => [prop.name, prop.value]),
  );
  assert.deepStrictEqual(
    firstActionProps["internal:SrcFile"],
    "./.github/workflows/nodejs.yml",
  );
  assert.deepStrictEqual(
    firstActionProps["cdx:github:workflow:name"],
    "Node CI",
  );
  assert.deepStrictEqual(
    firstActionProps["cdx:github:workflow:file"],
    "./.github/workflows/nodejs.yml",
  );
  assert.deepStrictEqual(
    firstActionProps["cdx:github:job:name"],
    "read-node-versions",
  );
  assert.deepStrictEqual(
    firstActionProps["cdx:github:job:runner"],
    "ubuntu-latest",
  );
  assert.deepStrictEqual(
    firstActionProps["cdx:github:action:versionPinningType"],
    "sha",
  );
  assert.deepStrictEqual(
    firstActionProps["cdx:github:action:isShaPinned"],
    "true",
  );
  assert.deepStrictEqual(firstActionProps["cdx:actions:isOfficial"], "true");
  assert.deepStrictEqual(firstActionProps["cdx:actions:isVerified"], "false");
  assert.deepStrictEqual(
    firstActionProps["cdx:github:checkout:persistCredentials"],
    "false",
  );
  assert.deepStrictEqual(
    firstActionProps["cdx:github:workflow:triggers"],
    "pull_request,merge_group,push,workflow_dispatch",
  );
  assert.deepStrictEqual(
    firstActionProps["cdx:github:workflow:hasPullRequestTrigger"],
    "true",
  );
  assert.deepStrictEqual(
    firstActionProps["cdx:github:workflow:hasWorkflowDispatchTrigger"],
    "true",
  );
  dep_list = parseGitHubWorkflowData("./test/data/github-actions-tj.yaml");
  assert.deepStrictEqual(dep_list.length, 4);
  dep_list = parseGitHubWorkflowData("./.github/workflows/repotests.yml");
  assert.ok(dep_list.length > 0);
  assert.ok(
    dep_list.every((component) =>
      component.properties?.some(
        (property) =>
          property.name === "cdx:github:workflow:file" &&
          property.value === "./.github/workflows/repotests.yml",
      ),
    ),
  );
  assert.ok(
    dep_list.some((component) =>
      component.properties?.some(
        (property) =>
          property.name === "cdx:github:checkout:repository" &&
          property.value === "AppThreat/vulnerability-db",
      ),
    ),
  );
});

// biome-ignore-end lint/suspicious/noTemplateCurlyInString: fp

it("parse github actions workflow data preserves cargo run steps for audit correlation", () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "cdxgen-gha-utils-"));
  const workflowFile = path.join(tmpDir, "cargo.yml");
  writeFileSync(
    workflowFile,
    [
      "name: Cargo CI",
      "on: push",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: dtolnay/rust-toolchain@stable",
      "      - run: cargo build --workspace && cargo test --workspace",
    ].join("\n"),
  );
  try {
    const depList = parseGitHubWorkflowData(workflowFile);
    assert.ok(
      depList.some((component) =>
        component.properties?.some(
          (property) =>
            property.name === "cdx:github:step:usesCargo" &&
            property.value === "true",
        ),
      ),
    );
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

it("parseComposerLock keeps only valid author emails", () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "cdxgen-composer-authors-"));
  try {
    const lockFile = join(tmpDir, "composer.lock");
    writeFileSync(
      lockFile,
      JSON.stringify({
        packages: [
          {
            name: "acme/demo",
            version: "1.0.0",
            authors: [
              { name: "Alice", email: "alice@example.com" },
              { name: "Bob", email: "bob at example dot com" },
              { email: "nobody@" },
              { homepage: "https://example.com" },
              { name: "Carol", email: " carol@例え.テスト " },
            ],
          },
        ],
        "packages-dev": [],
      }),
    );
    const retMap = parseComposerLock(lockFile);
    // organizationalContact.email is an idn-email: an invalid address is
    // dropped, and an author left with nothing is dropped too.
    assert.deepStrictEqual(retMap.pkgList[0].authors, [
      { name: "Alice", email: "alice@example.com" },
      { name: "Bob" },
      { name: "Carol", email: "carol@例え.テスト" },
    ]);
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

it("parseComposerLock", () => {
  let retMap = parseComposerLock("./test/data/composer.lock");
  assert.deepStrictEqual(retMap.pkgList.length, 1);
  assert.deepStrictEqual(retMap.dependenciesList.length, 1);
  assert.deepStrictEqual(retMap.pkgList[0], {
    group: "quickbooks",
    name: "v3-php-sdk",
    scope: "required",
    tags: ["api", "http", "quickbooks", "rest", "smallbusiness"],
    version: "v4.0.6.1",
    authors: [
      {
        email: "Hao_Lu@intuit.com",
        name: "hlu2",
      },
    ],
    distribution: {
      url: "https://api.github.com/repos/intuit/QuickBooks-V3-PHP-SDK/zipball/fe42e409bcdc431614f1cfc80cfc4191b926f3ed",
    },
    purl: "pkg:composer/quickbooks/v3-php-sdk@v4.0.6.1",
    "bom-ref": "pkg:composer/quickbooks/v3-php-sdk@v4.0.6.1",
    repository: {
      type: "git",
      url: "https://github.com/intuit/QuickBooks-V3-PHP-SDK.git",
      reference: "fe42e409bcdc431614f1cfc80cfc4191b926f3ed",
    },
    license: ["Apache-2.0"],
    description: "The Official PHP SDK for QuickBooks Online Accounting API",
    properties: [
      {
        name: "internal:SrcFile",
        value: "./test/data/composer.lock",
      },
      {
        name: "internal:Namespaces",
        value: "QuickBooksOnline\\API\\",
      },
      { name: "cdx:composer:require:php", value: ">=5.6.0" },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/data/composer.lock",
          },
        ],
      },
    },
  });

  retMap = parseComposerLock("./test/data/composer-2.lock");
  assert.deepStrictEqual(retMap.pkgList.length, 73);
  assert.deepStrictEqual(retMap.dependenciesList.length, 73);
  assert.deepStrictEqual(retMap.pkgList[0], {
    group: "amphp",
    name: "amp",
    scope: "required",
    version: "v2.4.4",
    purl: "pkg:composer/amphp/amp@v2.4.4",
    "bom-ref": "pkg:composer/amphp/amp@v2.4.4",
    authors: [
      {
        email: "rdlowrey@php.net",
        name: "Daniel Lowrey",
      },
      {
        email: "aaron@trowski.com",
        name: "Aaron Piotrowski",
      },
      {
        email: "bobwei9@hotmail.com",
        name: "Bob Weinand",
      },
      {
        email: "me@kelunik.com",
        name: "Niklas Keller",
      },
    ],
    repository: {
      type: "git",
      url: "https://github.com/amphp/amp.git",
      reference: "1e58d53e4af390efc7813e36cd215bd82cba4b06",
    },
    distribution: {
      url: "https://api.github.com/repos/amphp/amp/zipball/1e58d53e4af390efc7813e36cd215bd82cba4b06",
    },
    license: ["MIT"],
    description: "A non-blocking concurrency framework for PHP applications.",
    tags: [
      "async",
      "asynchronous",
      "awaitable",
      "concurrency",
      "event",
      "event-loop",
      "future",
      "non-blocking",
      "promise",
    ],
    properties: [
      {
        name: "internal:SrcFile",
        value: "./test/data/composer-2.lock",
      },
      {
        name: "internal:Namespaces",
        value: "Amp\\",
      },
      { name: "cdx:composer:require:php", value: ">=7" },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/data/composer-2.lock",
          },
        ],
      },
    },
  });

  retMap = parseComposerLock("./test/data/composer-3.lock");
  assert.deepStrictEqual(retMap.pkgList.length, 62);
  assert.deepStrictEqual(retMap.dependenciesList.length, 62);
  assert.deepStrictEqual(retMap.pkgList[0], {
    group: "amphp",
    name: "amp",
    version: "v2.6.2",
    purl: "pkg:composer/amphp/amp@v2.6.2",
    "bom-ref": "pkg:composer/amphp/amp@v2.6.2",
    authors: [
      {
        email: "rdlowrey@php.net",
        name: "Daniel Lowrey",
      },
      {
        email: "aaron@trowski.com",
        name: "Aaron Piotrowski",
      },
      {
        email: "bobwei9@hotmail.com",
        name: "Bob Weinand",
      },
      {
        email: "me@kelunik.com",
        name: "Niklas Keller",
      },
    ],
    repository: {
      type: "git",
      url: "https://github.com/amphp/amp.git",
      reference: "9d5100cebffa729aaffecd3ad25dc5aeea4f13bb",
    },
    license: ["MIT"],
    description: "A non-blocking concurrency framework for PHP applications.",
    distribution: {
      url: "https://api.github.com/repos/amphp/amp/zipball/9d5100cebffa729aaffecd3ad25dc5aeea4f13bb",
    },
    tags: [
      "async",
      "asynchronous",
      "awaitable",
      "concurrency",
      "event",
      "event-loop",
      "future",
      "non-blocking",
      "promise",
    ],
    scope: "required",
    properties: [
      { name: "internal:SrcFile", value: "./test/data/composer-3.lock" },
      {
        name: "internal:Namespaces",
        value: "Amp\\",
      },
      { name: "cdx:composer:require:php", value: ">=7.1" },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/data/composer-3.lock",
          },
        ],
      },
    },
  });
  retMap = parseComposerLock("./test/data/composer-4.lock");
  assert.deepStrictEqual(retMap.pkgList.length, 50);
  assert.deepStrictEqual(retMap.dependenciesList.length, 50);
  assert.deepStrictEqual(retMap.pkgList[0], {
    group: "apache",
    name: "log4php",
    purl: "pkg:composer/apache/log4php@2.3.0",
    "bom-ref": "pkg:composer/apache/log4php@2.3.0",
    version: "2.3.0",
    repository: {
      type: "git",
      url: "https://git-wip-us.apache.org/repos/asf/logging-log4php.git",
      reference: "8c6df2481cd68d0d211d38f700406c5f0a9de0c2",
    },
    license: ["Apache-2.0"],
    description: "A versatile logging framework for PHP",
    scope: "required",
    tags: ["log", "logging", "php"],
    properties: [
      { name: "internal:SrcFile", value: "./test/data/composer-4.lock" },
      { name: "cdx:composer:require:php", value: ">=5.2.7" },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            confidence: 1,
            technique: "manifest-analysis",
            value: "./test/data/composer-4.lock",
          },
        ],
      },
    },
  });
  assert.deepStrictEqual(retMap.dependenciesList[1], {
    ref: "pkg:composer/doctrine/annotations@v1.2.1",
    dependsOn: ["pkg:composer/doctrine/lexer@v1.0"],
  });

  // Platform requirements (php, ext-*) must not appear in rootList
  const platformRootRequires = {
    php: "^7.1.3|^8",
    "ext-SimpleXML": "*",
    "ext-dom": "*",
    "amphp/amp": "^2.1",
    "amphp/byte-stream": "^1.5",
  };
  retMap = parseComposerLock(
    "./test/data/composer-2.lock",
    platformRootRequires,
  );
  assert.ok(
    !retMap.rootList.some((p) => p.name === "php"),
    "php must not be in rootList",
  );
  assert.ok(
    !retMap.rootList.some((p) => p.name?.startsWith("ext-")),
    "ext-* must not be in rootList",
  );
  // Regular packages that are in rootRequires should still be in rootList
  // Note: apkg.name is basename(pkg.name), so "amphp/amp" → name "amp"
  assert.ok(
    retMap.rootList.some((p) => p.name === "amp"),
    "amphp/amp should be in rootList",
  );
});

it("parseComposerJson", () => {
  let retMap = parseComposerJson("./test/data/composer.json");
  assert.deepStrictEqual(Object.keys(retMap.rootRequires).length, 1);

  retMap = parseComposerJson("./test/data/composer-2.json");
  assert.deepStrictEqual(Object.keys(retMap.rootRequires).length, 31);
});

const composerProps = (pkg) =>
  pkg.properties.filter((prop) => prop.name.startsWith("cdx:composer:"));
const findComposerPkg = (retMap, fullName) =>
  retMap.pkgList.find((pkg) => `${pkg.group}/${pkg.name}` === fullName);

it("parseComposerLock keeps the platform data of the lock as properties", () => {
  const { rootRequires } = parseComposerJson(
    "./test/data/composer-platform.json",
  );
  const retMap = parseComposerLock(
    "./test/data/composer-platform.lock",
    rootRequires,
  );
  // None of these are versions of anything: they are what the project asks
  // of PHP, and what Composer was told to assume.
  assert.deepStrictEqual(retMap.platformProperties, [
    { name: "cdx:composer:platform:ext-zip", value: "*" },
    { name: "cdx:composer:platform:php", value: "^8.1" },
    { name: "cdx:composer:platformDev:ext-xdebug", value: "*" },
    { name: "cdx:composer:platformOverride:php", value: "8.1.27" },
  ]);
  assert.deepStrictEqual(composerProps(findComposerPkg(retMap, "psr/log")), [
    { name: "cdx:composer:require:php", value: ">=8.0.0" },
  ]);
  assert.deepStrictEqual(
    composerProps(findComposerPkg(retMap, "acme/archive")),
    [
      { name: "cdx:composer:require:ext-zip", value: "*" },
      { name: "cdx:composer:require:hhvm", value: ">=4.0" },
      { name: "cdx:composer:require:lib-libxml", value: ">=2.7.0" },
      { name: "cdx:composer:require:php", value: "^8.1" },
    ],
  );
  // packages-dev are locked packages too.
  assert.deepStrictEqual(
    composerProps(findComposerPkg(retMap, "acme/test-kit")),
    [
      { name: "cdx:composer:require:ext-dom", value: "*" },
      { name: "cdx:composer:require:ext-json", value: "*" },
      { name: "cdx:composer:require:php", value: "^8.1" },
    ],
  );
});

it("parseComposerLock turns no platform requirement into a component or an edge", () => {
  const { rootRequires } = parseComposerJson(
    "./test/data/composer-platform.json",
  );
  const retMap = parseComposerLock(
    "./test/data/composer-platform.lock",
    rootRequires,
  );
  assert.deepStrictEqual(
    retMap.pkgList.map((pkg) => pkg.purl),
    [
      "pkg:composer/acme/archive@2.1.0",
      "pkg:composer/psr/log@3.0.2",
      "pkg:composer/acme/test-kit@1.0.0",
    ],
  );
  // psr/log requires nothing but PHP; that requirement is a property now and
  // the graph still shows no edge for it.
  assert.deepStrictEqual(retMap.dependenciesList, [
    {
      ref: "pkg:composer/acme/archive@2.1.0",
      dependsOn: ["pkg:composer/psr/log@3.0.2"],
    },
    { ref: "pkg:composer/psr/log@3.0.2", dependsOn: [] },
    {
      ref: "pkg:composer/acme/test-kit@1.0.0",
      dependsOn: ["pkg:composer/psr/log@3.0.2"],
    },
  ]);
  assert.deepStrictEqual(
    retMap.rootList.map((pkg) => pkg["bom-ref"]),
    [
      "pkg:composer/acme/archive@2.1.0",
      "pkg:composer/psr/log@3.0.2",
      "pkg:composer/acme/test-kit@1.0.0",
    ],
  );
});

it("parseComposerLock leaves the components and dependencies of the existing locks as they were", () => {
  // Digests of the pre-change output, with the cdx:composer: properties left
  // out: the new properties are the only difference an existing lock may show.
  const digest = (retMap) =>
    createHash("sha256")
      .update(
        JSON.stringify({
          pkgList: retMap.pkgList.map((pkg) => ({
            ...pkg,
            properties: pkg.properties.filter(
              (prop) => !prop.name.startsWith("cdx:composer:"),
            ),
          })),
          dependenciesList: retMap.dependenciesList,
          rootList: retMap.rootList.map((pkg) => pkg["bom-ref"]),
        }),
      )
      .digest("hex");
  const expected = [
    [
      "composer.lock",
      "composer.json",
      "c4ed34ea104dad6627ca923f2fa966db4e6b9e2baf19a2c9f37ccedef5456092",
    ],
    [
      "composer-2.lock",
      "composer-2.json",
      "3b3ea4bf1dbb9beeaa6c950a9d968cad75784c3471264a6a513c30e4b9f4f7f2",
    ],
    [
      "composer-3.lock",
      undefined,
      "7f43511658a71f6c72546ff728b9a4144e73651015235f0a62fde2f4dc25b61a",
    ],
    [
      "composer-4.lock",
      undefined,
      "05bca570181a6946000ddb745e09b4a1677058dce573e0e31f0208bdbb8eafdf",
    ],
  ];
  for (const [lock, json, sha256] of expected) {
    const rootRequires = json
      ? parseComposerJson(`./test/data/${json}`).rootRequires
      : undefined;
    assert.strictEqual(
      digest(parseComposerLock(`./test/data/${lock}`, rootRequires)),
      sha256,
      lock,
    );
  }
});

it("parseComposerLock records the platform requirements of the existing locks", () => {
  let retMap = parseComposerLock("./test/data/composer-2.lock");
  assert.deepStrictEqual(retMap.platformProperties, [
    { name: "cdx:composer:platform:ext-dom", value: "*" },
    { name: "cdx:composer:platform:ext-json", value: "*" },
    { name: "cdx:composer:platform:ext-libxml", value: "*" },
    { name: "cdx:composer:platform:ext-simplexml", value: "*" },
    { name: "cdx:composer:platform:ext-tokenizer", value: "*" },
    { name: "cdx:composer:platform:php", value: "^7.1.3|^8" },
    { name: "cdx:composer:platformDev:ext-curl", value: "*" },
  ]);
  assert.deepStrictEqual(composerProps(retMap.pkgList[0]), [
    { name: "cdx:composer:require:php", value: ">=7" },
  ]);
  // Older Composer writes an empty section as [] rather than {}.
  retMap = parseComposerLock("./test/data/composer.lock");
  assert.deepStrictEqual(retMap.platformProperties, []);
  assert.deepStrictEqual(composerProps(retMap.pkgList[0]), [
    { name: "cdx:composer:require:php", value: ">=5.6.0" },
  ]);
});

it("parseComposerLock keeps platform values as plain strings and skips what is not one", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "cdxgen-composer-platform-"));
  try {
    const lockFile = join(tmpDir, "composer.lock");
    writeFileSync(
      lockFile,
      JSON.stringify({
        packages: [
          {
            name: "acme/demo",
            version: "1.0.0",
            require: {
              php: ">=8.0",
              "php-64bit": "*",
              "ext-json": "*",
              "lib-curl": ">=7.0",
              // not platform requirements, so not properties
              "acme/other": "^1.0",
              "composer-plugin-api": "^2.0",
              // not a name Composer allows
              "ext-bad name": "*",
              "ext-newline": "8.0\n9.0",
              "ext-long": `>=${"1".repeat(300)}`,
              "ext-object": { nested: true },
              "ext-empty": " ",
            },
          },
          { name: "acme/none", version: "1.0.0", require: [] },
          { name: "acme/odd", version: "1.0.0", require: "php" },
        ],
        "packages-dev": [],
        platform: [],
        "platform-dev": {
          "ext-curl": "*",
          "bad key": "x",
          "ext-x": { nested: true },
          "ext-y": "",
        },
        "platform-overrides": {
          "ext-foo": false,
          php: "8.1.27",
          "lib-bar": null,
          "ext-baz": 7,
        },
      }),
    );
    const retMap = parseComposerLock(lockFile);
    assert.deepStrictEqual(retMap.platformProperties, [
      { name: "cdx:composer:platformDev:ext-curl", value: "*" },
      { name: "cdx:composer:platformOverride:ext-foo", value: "false" },
      { name: "cdx:composer:platformOverride:php", value: "8.1.27" },
    ]);
    assert.deepStrictEqual(
      composerProps(findComposerPkg(retMap, "acme/demo")),
      [
        { name: "cdx:composer:require:ext-json", value: "*" },
        { name: "cdx:composer:require:lib-curl", value: ">=7.0" },
        { name: "cdx:composer:require:php", value: ">=8.0" },
        { name: "cdx:composer:require:php-64bit", value: "*" },
      ],
    );
    assert.deepStrictEqual(
      composerProps(findComposerPkg(retMap, "acme/none")),
      [],
    );
    assert.deepStrictEqual(
      composerProps(findComposerPkg(retMap, "acme/odd")),
      [],
    );
    assert.deepStrictEqual(retMap.dependenciesList, [
      { ref: "pkg:composer/acme/demo@1.0.0", dependsOn: [] },
      { ref: "pkg:composer/acme/none@1.0.0", dependsOn: [] },
      { ref: "pkg:composer/acme/odd@1.0.0", dependsOn: [] },
    ]);
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

it("parseComposerLock keeps at most 128 platform entries per map", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "cdxgen-composer-platform-"));
  try {
    const many = (prefix) =>
      Object.fromEntries(
        Array.from({ length: 5000 }, (_, index) => [
          `ext-${prefix}${String(index).padStart(4, "0")}`,
          "*",
        ]),
      );
    const lockFile = join(tmpDir, "composer.lock");
    writeFileSync(
      lockFile,
      JSON.stringify({
        packages: [
          {
            name: "acme/demo",
            version: "1.0.0",
            require: { php: ">=8.0", ...many("r") },
          },
        ],
        "packages-dev": [],
        platform: many("p"),
        "platform-dev": many("d"),
        "platform-overrides": { php: "8.1.27" },
      }),
    );
    const retMap = parseComposerLock(lockFile);
    const named = (prefix) =>
      retMap.platformProperties.filter((prop) => prop.name.startsWith(prefix));
    assert.strictEqual(named("cdx:composer:platform:").length, 128);
    assert.strictEqual(named("cdx:composer:platformDev:").length, 128);
    // A map under the cap is whole, and the cap keeps the first names in order.
    assert.deepStrictEqual(named("cdx:composer:platformOverride:"), [
      { name: "cdx:composer:platformOverride:php", value: "8.1.27" },
    ]);
    assert.strictEqual(
      named("cdx:composer:platform:")[0].name,
      "cdx:composer:platform:ext-p0000",
    );
    // ext-* sorts before php, but the cap never costs a package its PHP
    // requirement, and what is kept stays in name order.
    const demo = composerProps(findComposerPkg(retMap, "acme/demo"));
    assert.strictEqual(demo.length, 128);
    assert.deepStrictEqual(demo.at(-1), {
      name: "cdx:composer:require:php",
      value: ">=8.0",
    });
    assert.strictEqual(demo[0].name, "cdx:composer:require:ext-r0000");
    assert.strictEqual(demo.at(-2).name, "cdx:composer:require:ext-r0126");
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

it("parse helm charts", () => {
  let dep_list = parseHelmYamlData(
    readFileSync("./test/data/Chart.yaml", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 3);
  assert.deepStrictEqual(dep_list[0], {
    name: "prometheus",
    version: "16.0.0",
    description: "Prometheus is a monitoring system and time series database.",
    homepage: {
      url: "https://prometheus.io/",
    },
  });
  dep_list = parseHelmYamlData(
    readFileSync("./test/data/prometheus-community-index.yaml", {
      encoding: "utf-8",
    }),
  );
  assert.deepStrictEqual(dep_list.length, 1836);
  assert.deepStrictEqual(dep_list[0], {
    name: "alertmanager",
    version: "0.22.0",
    description:
      "The Alertmanager handles alerts sent by client applications such as the Prometheus server.",
    homepage: { url: "https://prometheus.io/" },
    _integrity:
      "sha256-c8ece226669d90fa56a3424fa789b80a10de2cd458cd93141b8e445e26c6054d",
    repository: { url: "https://github.com/prometheus/alertmanager" },
  });
});

it("parse container spec like files", () => {
  let dep_list = parseContainerSpecData(
    readFileSync("./test/data/docker-compose.yml", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 4);
  dep_list = parseContainerSpecData(
    readFileSync("./test/data/docker-compose-ng.yml", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 8);
  assert.deepStrictEqual(dep_list[0], {
    service: "frontend",
  });
  dep_list = parseContainerSpecData(
    readFileSync("./test/data/docker-compose-cr.yml", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 14);
  assert.deepStrictEqual(dep_list[0], {
    service: "crapi-identity",
  });
  dep_list = parseContainerSpecData(
    readFileSync("./test/data/tekton-task.yml", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 2);
  assert.deepStrictEqual(dep_list[0], {
    image:
      "docker.io/amazon/aws-cli:2.0.52@sha256:1506cec98a7101c935176d440a14302ea528b8f92fcaf4a6f1ea2d7ecef7edc4",
  });
  dep_list = parseContainerSpecData(
    readFileSync("./test/data/postgrescluster.yaml", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 6);
  assert.deepStrictEqual(dep_list[0], {
    image:
      "registry.developers.crunchydata.com/crunchydata/crunchy-postgres:ubi8-14.5-1",
  });
  dep_list = parseContainerSpecData(
    readFileSync("./test/data/deployment.yaml", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 2);
  assert.deepStrictEqual(dep_list[0], {
    image: "node-typescript-example",
  });
  dep_list = parseContainerSpecData(
    readFileSync("./test/data/skaffold.yaml", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 6);
  assert.deepStrictEqual(dep_list[0], {
    image: "leeroy-web",
  });
  dep_list = parseContainerSpecData(
    readFileSync("./test/data/skaffold-ms.yaml", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 22);
  assert.deepStrictEqual(dep_list[0], {
    image: "emailservice",
  });
  dep_list = parseContainerSpecData(
    readFileSync("./test/data/emailservice.yaml", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 2);
  assert.deepStrictEqual(dep_list[0], {
    image: "emailservice",
  });
  dep_list = parseContainerSpecData(
    readFileSync("./test/data/redis.yaml", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 2);
  assert.deepStrictEqual(dep_list[0], {
    image: "redis:alpine",
  });
  dep_list = parseContainerSpecData(
    readFileSync("./test/data/adservice.yaml", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 2);
  assert.deepStrictEqual(dep_list[0], {
    image: "gcr.io/google-samples/microservices-demo/adservice:v0.4.1",
  });
  dep_list = parseContainerSpecData(
    readFileSync("./test/data/kustomization.yaml", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 22);
  assert.deepStrictEqual(dep_list[0], {
    image: "gcr.io/google-samples/microservices-demo/adservice",
  });
  dep_list = parseContainerSpecData(
    readFileSync("./test/data/service.yaml", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 0);
});

it("parse containerfiles / dockerfiles", () => {
  const dep_list = parseContainerFile(
    readFileSync("./test/data/Dockerfile", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 7);
  assert.deepStrictEqual(dep_list[0], {
    image: "hello-world",
  });
  assert.deepStrictEqual(dep_list[1], {
    image: "hello-world:latest",
  });
  assert.deepStrictEqual(dep_list[2], {
    image: "hello-world@sha256:1234567890abcdef",
  });
  assert.deepStrictEqual(dep_list[3], {
    image: "hello-world:latest@sha256:1234567890abcdef",
  });
  assert.deepStrictEqual(dep_list[4], {
    image: "docker.io/hello-world@sha256:1234567890abcdef",
  });
  assert.deepStrictEqual(dep_list[5], {
    image: "docker.io/hello-world:latest@sha256:1234567890abcdef",
  });
  assert.deepStrictEqual(dep_list[6], {
    image: "docker.io/hello-world:latest",
  });
});

it("parse bitbucket-pipelines", () => {
  const dep_list = parseBitbucketPipelinesFile(
    readFileSync("./test/data/bitbucket-pipelines.yml", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 5);
  assert.deepStrictEqual(dep_list[0], {
    image: "node:16",
  });
  assert.deepStrictEqual(dep_list[1], {
    image: "node:18",
  });
  assert.deepStrictEqual(dep_list[2], {
    image: "some.private.org/docker/library/node:20",
  });
  assert.deepStrictEqual(dep_list[3], {
    image: "atlassian/aws/s3-deploy:0.2.2",
  });
  assert.deepStrictEqual(dep_list[4], {
    image: "some.private.org/docker/library/some-pipe:1.0.0",
  });
});

it("parse cloudbuild data", () => {
  assert.deepStrictEqual(parseCloudBuildData(null), []);
  const dep_list = parseCloudBuildData(
    readFileSync("./test/data/cloudbuild.yaml", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 1);
  assert.deepStrictEqual(dep_list[0], {
    group: "gcr.io/k8s-skaffold",
    name: "skaffold",
    version: "v2.0.1",
  });
});

it("parse privado files", () => {
  const servList = parsePrivadoFile("./test/data/privado.json");
  assert.deepStrictEqual(servList.length, 1);
  assert.deepStrictEqual(servList[0].data.length, 11);
  assert.deepStrictEqual(servList[0].endpoints.length, 17);
  assert.deepStrictEqual(servList[0].properties.length, 5);
});

it("parse openapi spec files", () => {
  let aservice = parseOpenapiSpecData(
    readFileSync("./test/data/openapi/openapi-spec.json", {
      encoding: "utf-8",
    }),
  );
  assert.deepStrictEqual(aservice.length, 1);
  assert.deepStrictEqual(aservice[0], {
    "bom-ref": "urn:service:OWASP-crAPI-API:1-oas3",
    name: "OWASP-crAPI-API",
    description: "",
    version: "1-oas3",
    endpoints: [
      "http://localhost:8888/identity/api/auth/signup",
      "http://localhost:8888/identity/api/auth/login",
      "http://localhost:8888/identity/api/auth/forget-password",
      "http://localhost:8888/identity/api/auth/v3/check-otp",
      "http://localhost:8888/identity/api/auth/v2/check-otp",
      "http://localhost:8888/identity/api/auth/v4.0/user/login-with-token",
      "http://localhost:8888/identity/api/auth/v2.7/user/login-with-token",
      "http://localhost:8888/identity/api/v2/user/reset-password",
      "http://localhost:8888/identity/api/v2/user/change-email",
      "http://localhost:8888/identity/api/v2/user/verify-email-token",
      "http://localhost:8888/identity/api/v2/user/dashboard",
      "http://localhost:8888/identity/api/v2/user/pictures",
      "http://localhost:8888/identity/api/v2/user/videos",
      "http://localhost:8888/identity/api/v2/user/videos/{video_id}",
      "http://localhost:8888/identity/api/v2/user/videos/convert_video",
      "http://localhost:8888/identity/api/v2/admin/videos/{video_id}",
      "http://localhost:8888/identity/api/v2/vehicle/vehicles",
      "http://localhost:8888/identity/api/v2/vehicle/add_vehicle",
      "http://localhost:8888/identity/api/v2/vehicle/{vehicleId}/location",
      "http://localhost:8888/identity/api/v2/vehicle/resend_email",
      "http://localhost:8888/community/api/v2/community/posts/{postId}",
      "http://localhost:8888/community/api/v2/community/posts",
      "http://localhost:8888/community/api/v2/community/posts/{postId}/comment",
      "http://localhost:8888/community/api/v2/community/posts/recent",
      "http://localhost:8888/community/api/v2/coupon/new-coupon",
      "http://localhost:8888/community/api/v2/coupon/validate-coupon",
      "http://localhost:8888/workshop/api/shop/products",
      "http://localhost:8888/workshop/api/shop/orders",
      "http://localhost:8888/workshop/api/shop/orders/{order_id}",
      "http://localhost:8888/workshop/api/shop/orders/all",
      "http://localhost:8888/workshop/api/shop/orders/return_order",
      "http://localhost:8888/workshop/api/shop/apply_coupon",
      "http://localhost:8888/workshop/api/shop/return_qr_code",
      "http://localhost:8888/workshop/api/mechanic/",
      "http://localhost:8888/workshop/api/merchant/contact_mechanic",
      "http://localhost:8888/workshop/api/mechanic/receive_report",
      "http://localhost:8888/workshop/api/mechanic/mechanic_report",
      "http://localhost:8888/workshop/api/mechanic/service_requests",
      "http://localhost:8888/workshop/api/mechanic/signup",
    ],
    authenticated: true,
  });
  aservice = parseOpenapiSpecData(
    readFileSync("./test/data/openapi/openapi-oai.yaml", {
      encoding: "utf-8",
    }),
  );
  assert.deepStrictEqual(aservice.length, 1);
  assert.deepStrictEqual(aservice[0], {
    "bom-ref": "urn:service:OpenAI-API:1.1.0",
    name: "OpenAI-API",
    description: "",
    version: "1.1.0",
    endpoints: [
      "https://api.openai.com/v1/engines",
      "https://api.openai.com/v1/engines/{engine_id}",
      "https://api.openai.com/v1/completions",
      "https://api.openai.com/v1/edits",
      "https://api.openai.com/v1/images/generations",
      "https://api.openai.com/v1/images/edits",
      "https://api.openai.com/v1/images/variations",
      "https://api.openai.com/v1/embeddings",
      "https://api.openai.com/v1/engines/{engine_id}/search",
      "https://api.openai.com/v1/files",
      "https://api.openai.com/v1/files/{file_id}",
      "https://api.openai.com/v1/files/{file_id}/content",
      "https://api.openai.com/v1/answers",
      "https://api.openai.com/v1/classifications",
      "https://api.openai.com/v1/fine-tunes",
      "https://api.openai.com/v1/fine-tunes/{fine_tune_id}",
      "https://api.openai.com/v1/fine-tunes/{fine_tune_id}/cancel",
      "https://api.openai.com/v1/fine-tunes/{fine_tune_id}/events",
      "https://api.openai.com/v1/models",
      "https://api.openai.com/v1/models/{model}",
      "https://api.openai.com/v1/moderations",
    ],
    authenticated: false,
  });
});

it("parse swift deps files", () => {
  assert.deepStrictEqual(
    parseSwiftJsonTree(null, "./test/data/swift-deps.json"),
    {},
  );
  let retData = parseSwiftJsonTree(
    readFileSync("./test/data/swift-deps.json", { encoding: "utf-8" }),
    "./test/data/swift-deps.json",
  );
  assert.deepStrictEqual(retData.rootList.length, 1);
  assert.deepStrictEqual(retData.pkgList.length, 5);
  // A local swift package has no remote URL and therefore no swift namespace,
  // so no valid purl can be built. The `purl` field must be absent rather than
  // holding the bare name — CycloneDX requires it to be a real Package URL.
  assert.deepStrictEqual("purl" in retData.rootList[0], false);
  assert.deepStrictEqual(retData.rootList[0], {
    name: "swift-markdown",
    group: "",
    type: "application",
    version: "unspecified",
    properties: [
      {
        name: "internal:SrcPath",
        value: "/Volumes/Work/sandbox/swift-markdown",
      },
      { name: "internal:SrcFile", value: "./test/data/swift-deps.json" },
    ],
    "bom-ref": "swift-markdown",
  });
  assert.deepStrictEqual(retData.pkgList[1], {
    "bom-ref": "pkg:swift/github.com/apple/swift-cmark@unspecified",
    group: "github.com/apple",
    name: "swift-cmark",
    properties: [
      {
        name: "cdx:swift:packageName",
        value: "cmark-gfm",
      },
    ],
    purl: "pkg:swift/github.com/apple/swift-cmark@unspecified",
    repository: {
      url: "https://github.com/apple/swift-cmark.git",
    },
    version: "unspecified",
  });
  assert.deepStrictEqual(retData.dependenciesList.length, 5);
  assert.deepStrictEqual(retData.dependenciesList[0], {
    ref: "pkg:swift/github.com/apple/swift-cmark@unspecified",
    dependsOn: [],
  });
  assert.deepStrictEqual(
    retData.dependenciesList[retData.dependenciesList.length - 1],
    {
      ref: "swift-markdown",
      dependsOn: [
        "pkg:swift/github.com/apple/swift-argument-parser@1.0.3",
        "pkg:swift/github.com/apple/swift-cmark@unspecified",
        "pkg:swift/github.com/apple/swift-docc-plugin@1.1.0",
      ],
    },
  );
  retData = parseSwiftJsonTree(
    readFileSync("./test/data/swift-deps1.json", { encoding: "utf-8" }),
    "./test/data/swift-deps.json",
  );
  assert.deepStrictEqual(retData.rootList.length, 1);
  assert.deepStrictEqual(retData.pkgList.length, 5);
  // Local swift package: no namespace, so no purl. See the swift-markdown case.
  assert.deepStrictEqual("purl" in retData.rootList[0], false);
  assert.deepStrictEqual(retData.rootList[0], {
    name: "swift-certificates",
    group: "",
    version: "unspecified",
    type: "application",
    properties: [
      {
        name: "internal:SrcPath",
        value: "/Volumes/Work/sandbox/swift-certificates",
      },
      { name: "internal:SrcFile", value: "./test/data/swift-deps.json" },
    ],
    "bom-ref": "swift-certificates",
  });
  assert.deepStrictEqual(retData.pkgList[1], {
    "bom-ref": "pkg:swift/github.com/apple/swift-crypto@2.4.0",
    group: "github.com/apple",
    name: "swift-crypto",
    purl: "pkg:swift/github.com/apple/swift-crypto@2.4.0",
    repository: {
      url: "https://github.com/apple/swift-crypto.git",
    },
    version: "2.4.0",
  });
  assert.deepStrictEqual(retData.dependenciesList, [
    {
      ref: "pkg:swift/github.com/apple/swift-docc-symbolkit@1.0.0",
      dependsOn: [],
    },
    {
      ref: "pkg:swift/github.com/apple/swift-docc-plugin@1.1.0",
      dependsOn: ["pkg:swift/github.com/apple/swift-docc-symbolkit@1.0.0"],
    },
    {
      ref: "pkg:swift/github.com/apple/swift-asn1@0.7.0",
      dependsOn: ["pkg:swift/github.com/apple/swift-docc-plugin@1.1.0"],
    },
    {
      ref: "pkg:swift/github.com/apple/swift-crypto@2.4.0",
      dependsOn: ["pkg:swift/github.com/apple/swift-asn1@0.7.0"],
    },
    {
      ref: "swift-certificates",
      dependsOn: ["pkg:swift/github.com/apple/swift-crypto@2.4.0"],
    },
  ]);
  let pkgList = parseSwiftResolved("./test/data/Package.resolved");
  assert.deepStrictEqual(pkgList.length, 6);
  assert.deepStrictEqual(pkgList[0], {
    name: "swift-argument-parser",
    group: "github.com/apple",
    version: "1.0.3",
    purl: "pkg:swift/github.com/apple/swift-argument-parser@1.0.3",
    properties: [
      { name: "internal:SrcFile", value: "./test/data/Package.resolved" },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/data/Package.resolved",
          },
        ],
      },
    },
    "bom-ref": "pkg:swift/github.com/apple/swift-argument-parser@1.0.3",
    repository: { url: "https://github.com/apple/swift-argument-parser" },
  });
  pkgList = parseSwiftResolved("./test/data/Package2.resolved");
  assert.deepStrictEqual(pkgList.length, 7);
  assert.deepStrictEqual(pkgList[0], {
    name: "swift-argument-parser",
    group: "github.com/apple",
    version: "1.2.2",
    purl: "pkg:swift/github.com/apple/swift-argument-parser@1.2.2",
    properties: [
      { name: "internal:SrcFile", value: "./test/data/Package2.resolved" },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/data/Package2.resolved",
          },
        ],
      },
    },
    "bom-ref": "pkg:swift/github.com/apple/swift-argument-parser@1.2.2",
    repository: { url: "https://github.com/apple/swift-argument-parser.git" },
  });
  assert.deepStrictEqual(pkgList[4], {
    name: "swift-http-server",
    group: "github.com/swift",
    version: "0.7.4",
    purl: "pkg:swift/github.com/swift/swift-http-server@0.7.4",
    properties: [
      { name: "internal:SrcFile", value: "./test/data/Package2.resolved" },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/data/Package2.resolved",
          },
        ],
      },
    },
    "bom-ref": "pkg:swift/github.com/swift/swift-http-server@0.7.4",
    repository: {
      url: "git@github.com:swift/swift-http-server.git",
    },
  });
  assert.deepStrictEqual(pkgList[5], {
    name: "swift-http-server",
    group: "bitbucket.org/swift",
    version: "0.7.4",
    purl: "pkg:swift/bitbucket.org/swift/swift-http-server@0.7.4",
    properties: [
      { name: "internal:SrcFile", value: "./test/data/Package2.resolved" },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/data/Package2.resolved",
          },
        ],
      },
    },
    "bom-ref": "pkg:swift/bitbucket.org/swift/swift-http-server@0.7.4",
    repository: {
      url: "ssh://git@bitbucket.org:7999/swift/swift-http-server.git",
    },
  });
});

const readSwiftScopeFixture = (name) =>
  JSON.parse(
    readFileSync(`./test/data/swift-scope/${name}.json`, { encoding: "utf-8" }),
  );

it("classifySwiftDependencyScopes follows targets and the package graph", () => {
  // scope-lab: swift-collections reaches production only through the local
  // Core target, LocalKit is a path dependency, and swift-snapshot-testing is
  // used by a test-support library target (TestSupport) and the tests
  const scopes = classifySwiftDependencyScopes(
    readSwiftScopeFixture("dump-scope-lab"),
    readSwiftScopeFixture("tree-scope-lab"),
  );
  // The snapshot-testing packages, including what it pulls in, are test-only
  assert.deepStrictEqual(Array.from(scopes.optionalRefs).sort(), [
    "pkg:swift/github.com/pointfreeco/swift-custom-dump@1.7.3",
    "pkg:swift/github.com/pointfreeco/swift-snapshot-testing@1.19.6",
    "pkg:swift/github.com/pointfreeco/xctest-dynamic-overlay@1.13.1",
    "pkg:swift/github.com/swiftlang/swift-syntax@604.0.0",
  ]);
  assert.deepStrictEqual(Array.from(scopes.requiredRefs).sort(), [
    "LocalKit",
    "pkg:swift/github.com/apple/swift-argument-parser@1.8.2",
    "pkg:swift/github.com/apple/swift-collections@1.7.1",
  ]);
  // Names cover components whose Package.resolved purl differs from the graph
  assert.ok(scopes.optionalNames.has("swift-snapshot-testing"));
  assert.ok(scopes.requiredNames.has("swift-collections"));
  assert.ok(!scopes.optionalNames.has("swift-collections"));
});

it("collectSwiftProductionTargets follows products and target dependencies", () => {
  assert.deepStrictEqual(
    Array.from(
      collectSwiftProductionTargets(readSwiftScopeFixture("dump-scope-lab")),
    ).sort(),
    ["app", "core"],
  );
  // Library products, the executable, and what they depend on
  assert.deepStrictEqual(
    Array.from(
      collectSwiftProductionTargets(readSwiftScopeFixture("dump-Carthage")),
    ).sort(),
    ["carthage", "carthagekit", "xcdbld"],
  );
  assert.strictEqual(collectSwiftProductionTargets(undefined).size, 0);
});

it("classifySwiftDependencyScopes handles byName products of old manifests", () => {
  // Carthage (tools-version 4.2) references every product by name; only its
  // test targets use Quick and Nimble
  const dumpJson = readSwiftScopeFixture("dump-Carthage");
  // Without the dependency graph, the direct test-only packages are known
  const direct = classifySwiftDependencyScopes(dumpJson);
  assert.strictEqual(direct.optionalRefs.size, 0);
  assert.deepStrictEqual(Array.from(direct.optionalNames).sort(), [
    "nimble",
    "quick",
  ]);
  assert.ok(direct.requiredNames.has("reactiveswift"));
  // With the graph they stay required: ReactiveSwift, ReactiveTask, and
  // Commandant declare Quick and Nimble as package dependencies (manifests
  // older than 5.2 have no target-based resolution), so nothing proves that
  // the production packages do not need them
  const scopes = classifySwiftDependencyScopes(
    dumpJson,
    readSwiftScopeFixture("tree-Carthage"),
  );
  assert.strictEqual(scopes.optionalRefs.size, 0);
  assert.ok(scopes.requiredRefs.has("pkg:swift/github.com/Quick/Quick@2.2.1"));
  assert.ok(scopes.requiredNames.has("nimble"));
});

it("classifySwiftDependencyScopes stays conservative", () => {
  const tree = {
    name: "app",
    dependencies: [
      {
        identity: "swift-argument-parser",
        name: "swift-argument-parser",
        url: "https://github.com/apple/swift-argument-parser",
        version: "1.5.0",
        dependencies: [],
      },
      {
        identity: "yams",
        name: "Yams",
        url: "https://github.com/jpsim/Yams",
        version: "5.1.0",
        dependencies: [],
      },
    ],
  };
  // A production byName reference that names no local target and no package
  // cannot be attributed, so nothing is scoped optional
  let scopes = classifySwiftDependencyScopes(
    {
      name: "app",
      targets: [
        {
          name: "app",
          type: "executable",
          dependencies: [{ byName: ["SomeProduct", null] }],
        },
        {
          name: "appTests",
          type: "test",
          dependencies: [
            {
              product: ["ArgumentParser", "swift-argument-parser", null, null],
            },
          ],
        },
      ],
    },
    tree,
  );
  assert.strictEqual(scopes.optionalRefs.size, 0);
  // A package used by production and tests stays required, and a declared
  // package no target uses is not scoped optional
  scopes = classifySwiftDependencyScopes(
    {
      name: "app",
      targets: [
        {
          name: "app",
          type: "executable",
          dependencies: [
            {
              product: ["ArgumentParser", "swift-argument-parser", null, null],
            },
          ],
        },
        {
          name: "appTests",
          type: "test",
          dependencies: [
            { target: ["app", null] },
            {
              product: ["ArgumentParser", "swift-argument-parser", null, null],
            },
          ],
        },
      ],
    },
    tree,
  );
  assert.strictEqual(scopes.optionalRefs.size, 0);
  assert.deepStrictEqual(Array.from(scopes.requiredRefs).sort(), [
    "pkg:swift/github.com/apple/swift-argument-parser@1.5.0",
    "pkg:swift/github.com/jpsim/Yams@5.1.0",
  ]);
  // A package reachable from a production dependency stays required even when
  // the tests use it directly
  scopes = classifySwiftDependencyScopes(
    {
      name: "app",
      targets: [
        {
          name: "app",
          type: "executable",
          dependencies: [
            {
              product: ["ArgumentParser", "swift-argument-parser", null, null],
            },
          ],
        },
        {
          name: "appTests",
          type: "test",
          dependencies: [{ product: ["Yams", "yams", null, null] }],
        },
      ],
    },
    {
      name: "app",
      dependencies: [
        {
          ...tree.dependencies[0],
          dependencies: [tree.dependencies[1]],
        },
        tree.dependencies[1],
      ],
    },
  );
  assert.strictEqual(scopes.optionalRefs.size, 0);
  assert.deepStrictEqual(
    classifySwiftDependencyScopes(undefined, undefined).optionalRefs.size,
    0,
  );
  // The object form of the target type is accepted as well
  assert.strictEqual(isSwiftTestTarget({ type: "test" }), true);
  assert.strictEqual(isSwiftTestTarget({ type: "executable" }), false);
  assert.strictEqual(isSwiftTestTarget({ type: { test: true } }), true);
  assert.strictEqual(isSwiftTestTarget(undefined), false);
});

it("classifySwiftDependencyScopes scopes test-only plugins optional", () => {
  const dumpJson = {
    name: "app",
    targets: [
      {
        name: "app",
        type: "executable",
        dependencies: [
          { product: ["ArgumentParser", "swift-argument-parser", null, null] },
        ],
        pluginUsages: [{ plugin: ["SwiftLintBuildToolPlugin", "swiftlint"] }],
      },
      {
        name: "appTests",
        type: "test",
        dependencies: [{ target: ["app", null] }],
        pluginUsages: [
          { plugin: ["SnapshotPlugin", "snapshot-plugin"] },
          // A plugin of the root package itself names no package
          { plugin: ["LocalPlugin", null] },
        ],
      },
    ],
  };
  const tree = {
    name: "app",
    dependencies: [
      {
        identity: "swift-argument-parser",
        name: "swift-argument-parser",
        url: "https://github.com/apple/swift-argument-parser",
        version: "1.5.0",
        dependencies: [],
      },
      {
        identity: "swiftlint",
        name: "SwiftLint",
        url: "https://github.com/realm/SwiftLint",
        version: "0.57.0",
        dependencies: [],
      },
      {
        identity: "snapshot-plugin",
        name: "snapshot-plugin",
        url: "https://github.com/example/snapshot-plugin",
        version: "1.0.0",
        dependencies: [],
      },
    ],
  };
  const scopes = classifySwiftDependencyScopes(dumpJson, tree);
  assert.deepStrictEqual(Array.from(scopes.optionalRefs), [
    "pkg:swift/github.com/example/snapshot-plugin@1.0.0",
  ]);
  assert.deepStrictEqual(Array.from(scopes.requiredRefs).sort(), [
    "pkg:swift/github.com/apple/swift-argument-parser@1.5.0",
    "pkg:swift/github.com/realm/SwiftLint@0.57.0",
  ]);
  // Command output handed over as text is parsed
  const fromText = classifySwiftDependencyScopes(
    JSON.stringify(dumpJson),
    JSON.stringify(tree),
  );
  assert.deepStrictEqual(
    Array.from(fromText.optionalRefs),
    Array.from(scopes.optionalRefs),
  );
  assert.strictEqual(
    classifySwiftDependencyScopes("not json", "{").optionalRefs.size,
    0,
  );
});

it("parseDot tests", () => {
  const retMap = parseCmakeDotFile("./test/data/tslite.dot", "conan");
  assert.deepStrictEqual(retMap.parentComponent, {
    "bom-ref": "pkg:conan/tensorflow-lite",
    group: "",
    name: "tensorflow-lite",
    purl: "pkg:conan/tensorflow-lite",
    type: "application",
    version: "",
  });
  assert.deepStrictEqual(retMap.pkgList.length, 283);
  assert.deepStrictEqual(retMap.dependenciesList.length, 247);
});


it("parseCmakeLikeFile reads the parent name and version from a project() call", () => {
  const dir = mkdtempSync(join(tmpdir(), "cdxgen-cmake-project-"));
  const parseContents = (contents) => {
    const cmakeListFile = join(dir, "CMakeLists.txt");
    writeFileSync(cmakeListFile, `${contents}\n`);
    return parseCmakeLikeFile(cmakeListFile, "generic");
  };
  try {
    // The project() call spans several lines.
    let retMap = parseContents(
      [
        "cmake_minimum_required(VERSION 3.15)",
        "project(MyProject",
        "    VERSION 2.1.3)",
      ].join("\n"),
    );
    assert.equal(retMap.parentComponent.name, "MyProject");
    assert.equal(retMap.parentComponent.version, "2.1.3");
    // The same call on one line.
    retMap = parseContents("project(MyProject VERSION 2.1.3 LANGUAGES C CXX)");
    assert.equal(retMap.parentComponent.name, "MyProject");
    assert.equal(retMap.parentComponent.version, "2.1.3");
    // Command names and keywords are case-insensitive.
    retMap = parseContents(
      ["PROJECT(Upper", "  version 1.0", "  LANGUAGES CXX", ")"].join("\n"),
    );
    assert.equal(retMap.parentComponent.name, "Upper");
    assert.equal(retMap.parentComponent.version, "1.0");
    // A set() value is substituted into the version.
    retMap = parseContents(
      [
        "set(MY_VERSION 3.4.5)",
        "project(P",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: CMake variable reference
        " VERSION ${MY_VERSION})",
      ].join("\n"),
    );
    assert.equal(retMap.parentComponent.name, "P");
    assert.equal(retMap.parentComponent.version, "3.4.5");
    // A ${VAR} that no set() defines is left empty rather than emitted.
    retMap = parseContents(
      [
        "project(Q",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: CMake variable reference
        " VERSION ${X})",
      ].join("\n"),
    );
    assert.equal(retMap.parentComponent.name, "Q");
    assert.equal(retMap.parentComponent.version, "");
    // A comment between the arguments does not break the parse.
    retMap = parseContents(
      [
        "project(Commented",
        "  # the version follows the VERSION keyword",
        "  VERSION 5.6.7)",
      ].join("\n"),
    );
    assert.equal(retMap.parentComponent.name, "Commented");
    assert.equal(retMap.parentComponent.version, "5.6.7");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("parseCmakeLikeFile limits the CLI version fallback to the scan-root project", () => {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-native-root-version-"));
  const nested = join(root, "dependency");
  mkdirSync(nested);
  const options = { sourceRoot: root, projectVersion: "scan-release" };
  try {
    for (const [filename, unversioned, versioned] of [
      ["CMakeLists.txt", "project(Dependency)", "project(Dependency VERSION 2.3.4)"],
      ["meson.build", "project('Dependency')", "project('Dependency', version : '2.3.4')"],
    ]) {
      const rootFile = join(root, filename);
      const nestedFile = join(nested, filename);
      writeFileSync(rootFile, unversioned);
      writeFileSync(nestedFile, unversioned);
      assert.equal(parseCmakeLikeFile(rootFile, "generic", options).parentComponent.version, "scan-release");
      const dependency = parseCmakeLikeFile(nestedFile, "generic", options).parentComponent;
      assert.equal(dependency.version, "");
      assert.equal(dependency.purl, "pkg:generic/Dependency");
      writeFileSync(nestedFile, versioned);
      assert.equal(parseCmakeLikeFile(nestedFile, "generic", options).parentComponent.version, "2.3.4");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("parseCmakeLikeFile find_package name tests", () => {
  const retMap = parseCmakeLikeFile(
    "./test/data/cmakes/find-package-names.cmake",
    "generic",
  );
  // ZLIB is a package name, PTHREADPOOL_LIB is the cache variable that
  // find_library writes to, and `${SOME_VARIABLE}` never resolves to a name.
  assert.deepStrictEqual(
    retMap.pkgList.map((pkg) => [pkg.name, pkg.version]),
    [
      ["ZLIB", ""],
      ["Boost", ""],
      ["pthreadpool", ""],
      ["m", ""],
    ],
  );
  assert.ok(retMap.pkgList.find((p) => p.name === "Boost").properties.some(
    (p) => p.name === "cdx:cmake:versionRequirements" && p.value === "1.54",
  ));
});

it("parseCmakeLikeFile reads mixed-case commands and configure-time downloads", () => {
  const retMap = parseCmakeLikeFile(
    "./test/data/cmakes/fetch-deps/CMakeLists.txt",
    "generic",
  );
  assert.deepStrictEqual(
    retMap.parentComponent.purl,
    "pkg:generic/fetchdemo@0.3.0",
  );
  const byName = Object.fromEntries(retMap.pkgList.filter((p) => p.properties.some((prop) => prop.name === "cdx:cmake:depKind")).map((p) => [p.name, p]));
  for (const [name, purl] of [
    ["googletest", "pkg:github/google/googletest@v1.14.0"],
    ["json", "pkg:github/nlohmann/json@v3.11.3"],
    ["libfoo", "pkg:generic/libfoo@2.1?download_url=https:%2F%2Fdownloads.example.org%2Flibfoo-2.1.tar.gz"],
    ["fmt", "pkg:github/fmtlib/fmt@10.2.1"],
  ]) assert.equal(byName[name].purl, purl);
  for (const name of ["ZLIB", "foo"]) {
    assert.ok(retMap.pkgList.some((p) => p.name === name && !p.version));
  }
  assert.ok(!retMap.pkgList.some((p) => p.name === "fmt" && !p.version));
  assert.ok(byName.fmt.properties.some((p) => p.name === "cdx:build:requirement" &&
    JSON.parse(p.value).role === "software" && JSON.parse(p.value).providerCandidates.some((candidate) => candidate.ref === byName.fmt["bom-ref"] && candidate.selected === false)));
  assert.deepStrictEqual(byName.json.hashes, [
    {
      alg: "SHA-256",
      content:
        "0d8ef5af7f9794e3263480193c491549b2ba6cc74bb018906202ada498a79406",
    },
  ]);
  // the query string (a token here) never reaches the BOM
  assert.ok(!JSON.stringify(byName.libfoo).includes("SECRET"));
  // a SHA512 that is not 128 hex digits is not a hash
  assert.strictEqual(byName.libfoo.hashes, undefined);
  assert.ok(byName.googletest.properties.some((p) => p.name === "cdx:cmake:gitRef" && p.value === "v1.14.0"));
  assert.deepStrictEqual(byName.libfoo.properties[0], {
    name: "cdx:cmake:depKind",
    value: "external-project",
  });
  assert.deepStrictEqual(byName.fmt.properties[0], {
    name: "cdx:cmake:depKind",
    value: "cpm",
  });
});

it("parseCmakeLikeFile keeps WrapDB alternatives separate from the requested package", () => {
  const { pkgList } = parseCmakeLikeFile("./test/data/cmakes/fetch-deps/CMakeLists.txt", "generic");
  const zlib = pkgList.find((p) => p.name === "ZLIB");
  assert.ok(!zlib.version && !zlib.hashes && !zlib.externalReferences);
  const requirements = zlib.properties.filter((p) => p.name === "cdx:build:requirement").map((p) => JSON.parse(p.value));
  assert.ok(requirements.some((r) => r.requestedName === "ZLIB" && r.providerCandidates.some((c) => c.name === "zlib" && !c.selected)));
});

it("parseCmakeLikeFile reads an ExternalProject archive and an upper-case project", () => {
  const retMap = parseCmakeLikeFile(
    "./test/data/cmakes/DownloadPThreadPool.cmake",
    "generic",
  );
  assert.deepStrictEqual(retMap.parentComponent.name, "pthreadpool-download");
  assert.deepStrictEqual(retMap.pkgList.length, 1);
  assert.deepStrictEqual(
    retMap.pkgList[0].purl,
    "pkg:github/maratyszcza/pthreadpool@4fe0e1e183925bf8cfa6aae24237e724a96479b8",
  );
  assert.deepStrictEqual(retMap.pkgList[0].hashes[0].alg, "SHA-256");
});

it("parseCUsageSlice reads every well-formed slice around malformed ones", () => {
  const usageData = parseCUsageSlice({
    objectSlices: [
      { fileName: "src/a.c", fullName: "process_record", code: "", usages: [] },
      // an include slice without a file name used to throw and end the walk
      { fullName: "zlib.h", code: "#include <zlib.h>", usages: [] },
      { fullName: "nocode", usages: [] },
      null,
      {
        fileName: "zlib.h",
        fullName: "zlib_user",
        code: "",
        usages: [
          {
            invokedCalls: [
              { resolvedMethod: "deflate" },
              { resolvedMethod: undefined },
              { resolvedMethod: "s->field" },
            ],
          },
        ],
      },
      { fileName: "src/b.c", fullName: "later_function", code: "" },
    ],
  });
  assert.deepStrictEqual(
    Object.fromEntries(
      Object.entries(usageData).map(([k, v]) => [k, Array.from(v)]),
    ),
    {
      "src/a.c": ["process_record"],
      "zlib.h": ["zlib_user", "deflate"],
      "src/b.c": ["later_function"],
    },
  );
});

it("parseMakeDFile tests", () => {
  const pkgFilesMap = parseMakeDFile("test/data/zstd_sys-dc50c4de2e4e7df8.d");
  assert.deepStrictEqual(pkgFilesMap, {
    zstd_sys: [
      ".cargo/registry/src/index.crates.io-hash/zstd-sys-2.0.10+zstd.1.5.6/src/lib.rs",
      ".cargo/registry/src/index.crates.io-hash/zstd-sys-2.0.10+zstd.1.5.6/src/bindings_zstd.rs",
      ".cargo/registry/src/index.crates.io-hash/zstd-sys-2.0.10+zstd.1.5.6/src/bindings_zdict.rs",
    ],
  });
});

it("parse flake.nix file", () => {
  const result = parseFlakeNix("./test/data/test-flake.nix");
  assert.ok(result.pkgList);
  assert.ok(result.dependencies);
  assert.deepStrictEqual(result.pkgList.length, 3);

  // Check nixpkgs input
  const nixpkgs = result.pkgList.find((pkg) => pkg.name === "nixpkgs");
  assert.ok(nixpkgs);
  assert.deepStrictEqual(nixpkgs.version, "latest");
  assert.deepStrictEqual(nixpkgs.purl, "pkg:generic/nixpkgs@latest");
  assert.deepStrictEqual(nixpkgs["bom-ref"], "pkg:generic/nixpkgs@latest");
  assert.deepStrictEqual(nixpkgs.scope, "required");
  assert.deepStrictEqual(nixpkgs.description, "Nix flake input: nixpkgs");
  assert.ok(nixpkgs.properties);

  // Check properties
  const srcFileProperty = nixpkgs.properties.find(
    (p) => p.name === "internal:SrcFile",
  );
  assert.deepStrictEqual(srcFileProperty.value, "./test/data/test-flake.nix");

  const urlProperty = nixpkgs.properties.find(
    (p) => p.name === "cdx:nix:input_url",
  );
  assert.deepStrictEqual(
    urlProperty.value,
    "github:NixOS/nixpkgs/release-23.11",
  );

  const proposedTypeProperty = nixpkgs.properties.find(
    (p) => p.name === "cdx:purl:proposedType",
  );
  assert.deepStrictEqual(proposedTypeProperty.value, "nix");

  // Check flake-utils input
  const flakeUtils = result.pkgList.find((pkg) => pkg.name === "flake-utils");
  assert.ok(flakeUtils);
  assert.deepStrictEqual(flakeUtils.version, "latest");

  // Check rust-overlay input
  const rustOverlay = result.pkgList.find((pkg) => pkg.name === "rust-overlay");
  assert.ok(rustOverlay);
  assert.deepStrictEqual(rustOverlay.version, "latest");

  const rustOverlayUrlProperty = rustOverlay.properties.find(
    (p) => p.name === "cdx:nix:input_url",
  );
  assert.deepStrictEqual(
    rustOverlayUrlProperty.value,
    "github:oxalica/rust-overlay",
  );

  // Check evidence
  assert.ok(nixpkgs.evidence);
  assert.deepStrictEqual(nixpkgs.evidence.identity.field, "purl");
  assert.deepStrictEqual(nixpkgs.evidence.identity.confidence, 0.8);
  assert.deepStrictEqual(
    nixpkgs.evidence.identity.methods[0].technique,
    "manifest-analysis",
  );
});

it("parse flake.lock file", () => {
  const result = parseFlakeLock("./test/data/test-flake.lock");
  assert.ok(result.pkgList);
  assert.ok(result.dependencies);
  assert.deepStrictEqual(result.pkgList.length, 4);

  // Check nixpkgs package. nix is not a registered purl type, so deps are
  // identified as generic packages with a vcs_url qualifier and a
  // cdx:purl:proposedType=nix property.
  const nixpkgs = result.pkgList.find((pkg) => pkg.name === "nixpkgs");
  assert.ok(nixpkgs);
  assert.deepStrictEqual(nixpkgs.version, "bd645e8"); // Short commit hash
  assert.deepStrictEqual(
    nixpkgs.purl,
    "pkg:generic/nixpkgs@bd645e8?vcs_url=https:%2F%2Fgithub.com%2FNixOS%2Fnixpkgs",
  );
  assert.deepStrictEqual(
    nixpkgs["bom-ref"],
    "pkg:generic/nixpkgs@bd645e8?vcs_url=https://github.com/NixOS/nixpkgs",
  );
  assert.deepStrictEqual(nixpkgs.scope, "required");
  assert.deepStrictEqual(nixpkgs.description, "Nix flake dependency: nixpkgs");

  // Check properties for nixpkgs
  const nixpkgsProperties = nixpkgs.properties;
  assert.ok(nixpkgsProperties);

  const srcFileProperty = nixpkgsProperties.find(
    (p) => p.name === "internal:SrcFile",
  );
  assert.deepStrictEqual(srcFileProperty.value, "./test/data/test-flake.lock");

  const narHashProperty = nixpkgsProperties.find(
    (p) => p.name === "cdx:nix:nar_hash",
  );
  assert.deepStrictEqual(
    narHashProperty.value,
    "sha256-RtDKd8Mynhe5CFnVT8s0/0yqtWFMM9LmCzXv/YKxnq4=",
  );

  const lastModifiedProperty = nixpkgsProperties.find(
    (p) => p.name === "cdx:nix:last_modified",
  );
  assert.deepStrictEqual(lastModifiedProperty.value, "1704194953");

  const revisionProperty = nixpkgsProperties.find(
    (p) => p.name === "cdx:nix:revision",
  );
  assert.deepStrictEqual(
    revisionProperty.value,
    "bd645e8668ec6612439a9ee7e71f7eac4099d4f6",
  );

  const vcsUrlProperty = nixpkgsProperties.find(
    (p) => p.name === "cdx:nix:vcs_url",
  );
  assert.deepStrictEqual(
    vcsUrlProperty.value,
    "https://github.com/NixOS/nixpkgs",
  );

  const downloadUrlProperty = nixpkgsProperties.find(
    (p) => p.name === "cdx:nix:download_url",
  );
  assert.deepStrictEqual(
    downloadUrlProperty.value,
    "https://github.com/NixOS/nixpkgs/archive/bd645e8668ec6612439a9ee7e71f7eac4099d4f6.tar.gz",
  );

  const proposedTypeProperty = nixpkgsProperties.find(
    (p) => p.name === "cdx:purl:proposedType",
  );
  assert.deepStrictEqual(proposedTypeProperty.value, "nix");

  // Check flake-utils package
  const flakeUtils = result.pkgList.find((pkg) => pkg.name === "flake-utils");
  assert.ok(flakeUtils);
  assert.deepStrictEqual(flakeUtils.version, "1ef2e67");

  // Check rust-overlay package
  const rustOverlay = result.pkgList.find((pkg) => pkg.name === "rust-overlay");
  assert.ok(rustOverlay);
  assert.deepStrictEqual(rustOverlay.version, "9a8a835");

  // Check systems package
  const systems = result.pkgList.find((pkg) => pkg.name === "systems");
  assert.ok(systems);
  assert.deepStrictEqual(systems.version, "da67096");

  // The parser no longer synthesises a dangling root dependency edge; it returns
  // the root's direct inputs as bom-refs for createNixBom to attach to the real
  // parent component.
  assert.deepStrictEqual(result.dependencies.length, 0);
  assert.ok(result.rootInputs);
  assert.deepStrictEqual(result.rootInputs.length, 3); // flake-utils, nixpkgs, rust-overlay

  // Every emitted purl must use a registered type — no pkg:nix/ squatting.
  for (const pkg of result.pkgList) {
    assert.ok(
      pkg.purl.startsWith("pkg:generic/"),
      `${pkg.name} purl must be generic, got ${pkg.purl}`,
    );
  }

  // Check evidence
  assert.ok(nixpkgs.evidence);
  assert.deepStrictEqual(nixpkgs.evidence.identity.field, "purl");
  assert.deepStrictEqual(nixpkgs.evidence.identity.confidence, 1.0);
  assert.deepStrictEqual(
    nixpkgs.evidence.identity.methods[0].technique,
    "manifest-analysis",
  );
});

it("parse flake.nix file with missing file", () => {
  const result = parseFlakeNix("./test/data/missing-flake.nix");
  assert.ok(result.pkgList);
  assert.ok(result.dependencies);
  assert.deepStrictEqual(result.pkgList.length, 0);
  assert.deepStrictEqual(result.dependencies.length, 0);
});

it("parse flake.lock file with missing file", () => {
  const result = parseFlakeLock("./test/data/missing-flake.lock");
  assert.ok(result.pkgList);
  assert.ok(result.dependencies);
  assert.deepStrictEqual(result.pkgList.length, 0);
  assert.deepStrictEqual(result.dependencies.length, 0);
  assert.deepStrictEqual(result.rootInputs.length, 0);
});

// Restored from the retired lib/helpers/core-misc-a.poku.js, which was
// deleted along with its module during the v13 layer reorganisation even though
// the functions under test only moved.

import { readFileSync as _cocoaReadFileSync } from "node:fs";
import _cocoaProcess from "node:process";

import { parse as _cocoaLoadYaml } from "yaml";

import {
  buildObjectForCocoaPod,
  parseCocoaDependency,
  parsePodfileLock,
  parsePodfileTargets,
} from "./parsers-misc.js";

it("parsePodfileLock tests", async () => {
  assert.deepStrictEqual(
    (
      await parsePodfileLock(
        _cocoaLoadYaml(_cocoaReadFileSync("./test/Podfile.lock", "utf-8")),
      )
    ).size,
    6,
  );

  _cocoaProcess.env.COCOA_MERGE_SUBSPECS = false;
  assert.deepStrictEqual(
    (
      await parsePodfileLock(
        _cocoaLoadYaml(_cocoaReadFileSync("./test/Podfile.lock", "utf-8")),
      )
    ).size,
    16,
  );
  _cocoaProcess.env.COCOA_MERGE_SUBSPECS = true;
});

it("parsePodfileTargets tests", () => {
  const targetDependencies = new Map();
  parsePodfileTargets(
    JSON.parse(_cocoaReadFileSync("./test/Podfile.json", "utf-8"))[
      "target_definitions"
    ][0],
    targetDependencies,
  );
  assert.deepStrictEqual(targetDependencies.size, 5);
  assert.deepStrictEqual(targetDependencies.has("Pods"), true);
});

it("parseCocoaDependency tests", () => {
  let dependency = parseCocoaDependency("Alamofire (3.0.0)");
  assert.deepStrictEqual(dependency.name, "Alamofire");
  assert.deepStrictEqual(dependency.version, "3.0.0");

  dependency = parseCocoaDependency("boost/graph-includes (= 1.59.0)", false);
  assert.deepStrictEqual(dependency.name, "boost/graph-includes");
  assert.deepStrictEqual(dependency.version, undefined);
});

it("buildObjectForCocoaPod tests", async () => {
  assert.deepStrictEqual(
    await buildObjectForCocoaPod(parseCocoaDependency("Alamofire (3.0.0)")),
    {
      name: "Alamofire",
      version: "3.0.0",
      type: "library",
      purl: "pkg:cocoapods/Alamofire@3.0.0",
      "bom-ref": "pkg:cocoapods/Alamofire@3.0.0",
    },
  );

  assert.deepStrictEqual(
    await buildObjectForCocoaPod(
      parseCocoaDependency("boost/graph-includes (= 1.59.0)"),
    ),
    {
      name: "boost/graph-includes",
      version: "= 1.59.0",
      type: "library",
      properties: [
        {
          name: "cdx:pods:Subspec",
          value: "graph-includes",
        },
      ],
      purl: "pkg:cocoapods/boost@%3D%201.59.0#graph-includes",
      "bom-ref": "pkg:cocoapods/boost@= 1.59.0#graph-includes",
    },
  );
});

it("parse xmake requires lock", () => {
  const pkgList = parseXmakeRequiresLock(
    "./test/data/xmake-smoke/xmake-requires.lock",
  );
  assert.strictEqual(pkgList.length, 3);
  // zlib is resolved for two configurations at the same version, so it is one
  // component listing both.
  const zlib = pkgList.find((p) => p.name === "zlib");
  assert.strictEqual(zlib.version, "1.3.1");
  assert.strictEqual(zlib.purl, "pkg:generic/xmake/zlib@1.3.1");
  assert.strictEqual(
    zlib.properties.find((p) => p.name === "cdx:purl:proposedType").value,
    "xmake",
  );
  assert.strictEqual(
    zlib.properties.find((p) => p.name === "cdx:xmake:configurations").value,
    "linux|x86_64, macosx|arm64",
  );
  // The requirement key carries the requested range before the config hash;
  // the resolved version is the one the entry records.
  const fmt = pkgList.find((p) => p.name === "fmt");
  assert.strictEqual(fmt.version, "11.0.2");
  // A system package xmake did not resolve is inventoried without a version.
  const opengl = pkgList.find((p) => p.name === "opengl");
  assert.strictEqual(opengl.version, undefined);
  assert.strictEqual(opengl.purl, "pkg:generic/xmake/opengl");
  assert.deepStrictEqual(
    parseXmakeRequiresLock("./test/data/xmake-smoke/missing.lock"),
    [],
  );
});

it("parseSwiftResolved escapes build metadata and keeps pins after a local one", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-swift-resolved-"));
  try {
    const resolvedFile = path.join(tempDir, "Package.resolved");
    writeFileSync(
      resolvedFile,
      JSON.stringify({
        originHash: "0",
        version: 3,
        pins: [
          {
            identity: "meta",
            kind: "remoteSourceControl",
            location: "https://github.com/example/meta.git",
            state: { revision: "abc", version: "1.0.0+build.7" },
          },
          {
            identity: "local-kit",
            kind: "localSourceControl",
            location: "/work/local-kit",
            state: { revision: "def", version: "0.1.0" },
          },
          {
            identity: "swift-log",
            kind: "remoteSourceControl",
            location: "https://github.com/apple/swift-log.git",
            state: { revision: "123", version: "1.5.3" },
          },
        ],
      }),
    );
    const pkgList = parseSwiftResolved(resolvedFile);
    // A pin without a remote URL used to abort the loop, dropping swift-log.
    assert.deepStrictEqual(
      pkgList.map((p) => p.name),
      ["meta", "local-kit", "swift-log"],
    );
    const [meta, local] = pkgList;
    assert.strictEqual(meta.version, "1.0.0+build.7");
    assert.strictEqual(
      meta.purl,
      "pkg:swift/github.com/example/meta@1.0.0%2Bbuild.7",
    );
    assert.strictEqual(
      meta["bom-ref"],
      "pkg:swift/github.com/example/meta@1.0.0+build.7",
    );
    // A local checkout has no swift namespace, so it has no purl.
    assert.strictEqual(local.purl, undefined);
    assert.strictEqual(local.version, "0.1.0");
    assert.strictEqual(local["bom-ref"], "library:local-kit:0.1.0");
    assert.strictEqual(local.evidence.identity.field, "name");
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

it("parseSwiftJsonTreeObject keeps the purl escaped", () => {
  const pkgList = [];
  const dependenciesList = [];
  parseSwiftJsonTreeObject(
    pkgList,
    dependenciesList,
    {
      name: "meta",
      url: "https://github.com/example/meta.git",
      version: "1.0.0+build.7",
      path: "/tmp/meta",
      dependencies: [],
    },
    "Package.swift",
  );
  assert.strictEqual(
    pkgList[0].purl,
    "pkg:swift/github.com/example/meta@1.0.0%2Bbuild.7",
  );
  assert.strictEqual(
    pkgList[0]["bom-ref"],
    "pkg:swift/github.com/example/meta@1.0.0+build.7",
  );
});

it("parse flake.nix skips an oversized inputs block instead of backtracking", () => {
  // A 64 KB identifier run defeats every `.url` continuation, which the
  // pre-fix name-run regex rescanned quadratically (~4 s per 64 KB).
  const pathological = `{\n  inputs = {\n    ${"a".repeat(64 * 1024)}:\n  };\n  outputs = ...;\n}\n`;
  const flakeDir = mkdtempSync(join(tmpdir(), "cdxgen-flake-redos-"));
  const flakeFile = join(flakeDir, "flake.nix");
  try {
    writeFileSync(flakeFile, pathological);
    const start = Date.now();
    const result = parseFlakeNix(flakeFile);
    const elapsed = Date.now() - start;
    assert.ok(result.pkgList);
    assert.deepStrictEqual(result.pkgList.length, 0);
    assert.ok(
      elapsed < 2000,
      `oversized inputs block must be skipped quickly, took ${elapsed}ms`,
    );
  } finally {
    rmSync(flakeDir, { recursive: true, force: true });
  }
});

it("parse flake.nix still finds url and nested inputs below the cap", () => {
  const flakeDir = mkdtempSync(join(tmpdir(), "cdxgen-flake-ok-"));
  const flakeFile = join(flakeDir, "flake.nix");
  try {
    writeFileSync(
      flakeFile,
      [
        "{",
        "  inputs = {",
        '    nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.05";',
        "    flake-utils = {",
        '      url = "github:numtide/flake-utils";',
        "    };",
        "  };",
        "  outputs = { self, nixpkgs, flake-utils }: {};",
        "}",
        "",
      ].join("\n"),
    );
    const result = parseFlakeNix(flakeFile);
    const names = result.pkgList.map((pkg) => pkg.name).sort();
    assert.deepStrictEqual(names, ["flake-utils", "nixpkgs"]);
  } finally {
    rmSync(flakeDir, { recursive: true, force: true });
  }
});

function withMesonWrapRecipe(name, body, check) {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-wrap-patch-"));
  try {
    mkdirSync(join(root, "subprojects"));
    writeFileSync(join(root, "subprojects", `${name}.wrap`), body);
    const file = join(root, "meson.build");
    writeFileSync(file, `project('Consumer')
if want_dependency
  dependency('requested', version: '>= 0.1', fallback: ['${name}', 'dep'])
endif
`);
    const parsed = parseCmakeLikeFile(file, "generic", { sourceRoot: root });
    const requirement = parsed.requirements.find((entry) => entry.requestedName === "requested");
    const candidate = requirement.providerCandidates.find((entry) => entry.kind === "local-wrap");
    assert.equal(requirement.line, 3);
    assert.equal(requirement.constraints, ">= 0.1");
    assert.deepEqual(requirement.conditions, ["if want_dependency"]);
    assert.equal(candidate.selected, false);
    const sourceComponent = parsed.pkgList.find((component) => component["bom-ref"] === candidate.ref);
    if (candidate.source.url) assert.ok(sourceComponent?.version);
    else assert.ok(!candidate.ref);
    const declarations = parsed.requirements.filter((entry) => entry.command === "meson-wrap");
    assert.equal(declarations.length, 1);
    assert.equal(declarations[0].file, `subprojects/${name}.wrap`);
    assert.deepEqual(declarations[0].source, candidate.source);
    assert.ok(declarations[0].providerCandidates.every((entry) => entry.selected === false && entry.ref === candidate.ref));
    check(candidate.source);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it("Meson preserves declared libarchive source fallback and separate patch archive facts", () => {
  withMesonWrapRecipe("libarchive", `[wrap-file]
directory = libarchive-3.7.2
source_url = https://github.com/libarchive/libarchive/releases/download/v3.7.2/libarchive-3.7.2.tar.xz
source_filename = libarchive-3.7.2.tar.xz
source_hash = 04357661e6717b6941682cde02ad741ae4819c67a260593dfb2431861b251acb
patch_filename = libarchive_3.7.2-3_patch.zip
patch_url = https://wrapdb.mesonbuild.com/v2/libarchive_3.7.2-3/get_patch
patch_hash = 1cec0d1d80257ed4b18bea0d7f1aef9f02f5b6a80e269eee7457ece32f53f5ca
source_fallback_url = https://github.com/mesonbuild/wrapdb/releases/download/libarchive_3.7.2-3/libarchive-3.7.2.tar.xz
wrapdb_version = 3.7.2-3
[provide]
dependency_names = libarchive, archive-alias
`, (source) => {
    assert.equal(source.fallbackUrl, "https://github.com/mesonbuild/wrapdb/releases/download/libarchive_3.7.2-3/libarchive-3.7.2.tar.xz");
    assert.deepEqual(source.hashes, [{ alg: "SHA-256", content: "04357661e6717b6941682cde02ad741ae4819c67a260593dfb2431861b251acb" }]);
    assert.deepEqual(source.patch, {
      filename: "libarchive_3.7.2-3_patch.zip",
      url: "https://wrapdb.mesonbuild.com/v2/libarchive_3.7.2-3/get_patch",
      hashes: [{ alg: "SHA-256", content: "1cec0d1d80257ed4b18bea0d7f1aef9f02f5b6a80e269eee7457ece32f53f5ca" }],
    });
  });
});

it("Meson preserves declared Rust patch directories and ordered local diff paths without reading them", () => {
  withMesonWrapRecipe("rustix-1-rs", `[wrap-file]
directory = rustix-1.1.4
source_url = https://static.crates.io/crates/rustix/1.1.4/download
source_filename = rustix-1.1.4.tar.gz
source_hash = b6fe4565b9518b83ef4f91bb47ce29620ca828bd32cb7e408f0062e9930ba190
patch_directory = rustix-1-rs
diff_files = rustix-1-rs/0001-rustix-add-ioctl-wrappers.patch, rustix-1-rs/0002-rustix-improve-for-musl-build-without-linux-raw-sys.patch, rustix-1-rs/0003-rustix-enable-rustix-thread-futex-without-linux-raw-.patch
`, (source) => {
    assert.deepEqual(source.patch, { directory: "rustix-1-rs", diffFiles: [
      "rustix-1-rs/0001-rustix-add-ioctl-wrappers.patch",
      "rustix-1-rs/0002-rustix-improve-for-musl-build-without-linux-raw-sys.patch",
      "rustix-1-rs/0003-rustix-enable-rustix-thread-futex-without-linux-raw-.patch",
    ] });
  });
});

it("Meson patch metadata rejects unsafe URLs and malformed hashes while preserving literal local paths", () => {
  withMesonWrapRecipe("unsafe", `[wrap-file]
source_fallback_url = file:///private/source.tar.gz
patch_filename = local.zip
patch_url = javascript:alert(1)
patch_hash = not-a-sha256
patch_fallback_url = https://user:secret@example.org/patch.zip?token=secret#fragment
patch_directory = ../unread-directory
diff_files = ../unread.patch, fixes/second.patch
unknown_credential = do-not-publish
`, (source) => {
    assert.equal(source.fallbackUrl, undefined);
    assert.deepEqual(source.patch, { filename: "local.zip",
      fallbackUrl: "https://example.org/patch.zip", directory: "../unread-directory",
      diffFiles: ["../unread.patch", "fixes/second.patch"] });
    assert.ok(!JSON.stringify(source).includes("secret"));
    assert.ok(!JSON.stringify(source).includes("do-not-publish"));
  });
});

it("Meson requirements preserve every unselected local wrap archive and consumer context", () => {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-wrap-sources-"));
  try {
    const subprojects = join(root, "subprojects");
    const nested = join(root, "independent");
    mkdirSync(subprojects);
    mkdirSync(join(nested, "subprojects"), { recursive: true });
    const file = join(root, "meson.build");
    writeFileSync(file, "project('consumer')\nif use_archive\n  dependency('rust-log', version: '>= 0.1', fallback: ['log-source', 'dep'])\nendif\ndependency('malformed')\n");
    const hashes = ["A".repeat(64), "b".repeat(64)];
    for (const [index, recipe] of ["log-source", "log-copy"].entries()) {
      writeFileSync(join(subprojects, `${recipe}.wrap`), `[wrap-file]\ndirectory = log-0.4.27\nsource_url = https://example.org/log-0.4.27.tar.gz\nsource_filename = log-0.4.27.tar.gz\nsource_hash = ${hashes[index]}\n${index ? "[provide]\ndependency_names = rust-log\n" : ""}`);
    }
    writeFileSync(join(subprojects, "malformed.wrap"), "[wrap-file]\nsource_url = https://user:secret@example.org/malformed.tar.gz?token=secret#fragment\nsource_hash = not-a-sha256\n");
    writeFileSync(join(nested, "meson.build"), "project('independent')\ndependency('rust-log')\n");
    writeFileSync(join(nested, "subprojects", "log-source.wrap"), "[wrap-git]\nurl = https://example.org/other.git\nrevision = feature-branch\n[provide]\ndependency_names = rust-log\n");
    const cache = new Map();
    const parsed = parseCmakeLikeFile(file, "generic", { sourceRoot: root, mesonWrapCache: cache });
    const requirement = parsed.requirements.find((entry) => entry.requestedName === "rust-log");
    assert.equal(requirement.file, "meson.build");
    assert.equal(requirement.line, 3);
    assert.equal(requirement.constraints, ">= 0.1");
    assert.deepEqual(requirement.conditions, ["if use_archive"]);
    const candidates = requirement.providerCandidates.filter((candidate) => candidate.kind === "local-wrap");
    assert.equal(candidates.length, 2);
    assert.deepEqual(candidates.map((candidate) => candidate.source), [
      { file: "subprojects/log-copy.wrap", line: 1, type: "wrap-file", directory: "log-0.4.27",
        url: "https://example.org/log-0.4.27.tar.gz", filename: "log-0.4.27.tar.gz",
        hashes: [{ alg: "SHA-256", content: hashes[1] }], identity: { version: "0.4.27", kind: "release" },
        provides: { dependency_names: "rust-log" } },
      { file: "subprojects/log-source.wrap", line: 1, type: "wrap-file", directory: "log-0.4.27",
        url: "https://example.org/log-0.4.27.tar.gz", filename: "log-0.4.27.tar.gz",
        hashes: [{ alg: "SHA-256", content: hashes[0].toLowerCase() }], identity: { version: "0.4.27", kind: "release" } },
    ]);
    assert.ok(candidates.every((candidate) => candidate.selected === false));
    assert.equal(parsed.pkgList.filter((component) => component.version === "0.4.27").length, 2);
    assert.ok(!parsed.pkgList.some((component) => component.name === "rust-log" && !component.version));
    assert.ok(candidates.every((candidate) => parsed.pkgList.some((component) => component["bom-ref"] === candidate.ref)));
    const malformed = parsed.requirements.find((entry) => entry.requestedName === "malformed")
      .providerCandidates.find((candidate) => candidate.kind === "local-wrap");
    assert.equal(malformed.source.url, "https://example.org/malformed.tar.gz");
    assert.equal(malformed.source.hashes, undefined);
    const independent = parseCmakeLikeFile(join(nested, "meson.build"), "generic", { sourceRoot: root, mesonWrapCache: cache });
    const own = independent.requirements[0].providerCandidates.filter((candidate) => candidate.kind === "local-wrap");
    assert.equal(own.length, 1);
    assert.deepEqual(own[0].source, { file: "independent/subprojects/log-source.wrap",
      line: 1, type: "wrap-git", url: "https://example.org/other.git", reference: "feature-branch",
      provides: { dependency_names: "rust-log" } });
    assert.equal(own[0].selected, false);
    assert.equal(own[0].declaredVersion, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("CMake keeps missing local source declarations without inventing a provider", () => {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-missing-source-"));
  try {
    const file = join(root, "CMakeLists.txt");
    writeFileSync(file, `project(Consumer)
function(fetch_optional)
  set(optional_source "\${CMAKE_CURRENT_LIST_DIR}/missing-source")
  FetchContent_Declare(optional SOURCE_DIR \${optional_source})
  FetchContent_MakeAvailable(optional)
endfunction()
`);
    const parsed = parseCmakeLikeFile(file, "generic", { sourceRoot: root });
    assert.equal(parsed.pkgList.length, 0);
    assert.equal(parsed.parentComponent.name, "Consumer");
    const declaration = parsed.requirements.find((requirement) => requirement.role === "source-declaration");
    assert.ok(declaration);
    assert.equal(declaration.requestedName, "optional");
    assert.equal(declaration.file, "CMakeLists.txt");
    assert.equal(declaration.line, 4);
    assert.deepEqual(declaration.conditions, ["function(fetch_optional)"]);
    assert.deepEqual(declaration.providerCandidates, []);
    assert.equal(declaration.source.sourceDir, join(root, "missing-source"));
    assert.equal(declaration.source.madeAvailable, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("Meson preserves unused wrap declarations once per actual recipe file", () => {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-unused-wrap-"));
  try {
    mkdirSync(join(root, "subprojects"));
    writeFileSync(join(root, "meson.build"), "project('Consumer')\n");
    writeFileSync(join(root, "subprojects", "unused.wrap"), "# declared source only\n[wrap-file]\ndirectory = unused-2.3.4\nsource_url = https://example.org/unused-2.3.4.tar.gz\nsource_hash = " + "c".repeat(64) + "\n[provide]\ndependency_names = first-alias, second-alias\n");
    const parsed = parseCmakeLikeFile(join(root, "meson.build"), "generic", { sourceRoot: root });
    assert.equal(parsed.pkgList.length, 1);
    assert.equal(parsed.pkgList[0].version, "2.3.4");
    const declarations = parsed.requirements.filter((requirement) => requirement.command === "meson-wrap");
    assert.equal(declarations.length, 1);
    assert.equal(declarations[0].role, "source-declaration");
    assert.equal(declarations[0].file, "subprojects/unused.wrap");
    assert.equal(declarations[0].line, 2);
    assert.equal(declarations[0].source.url, "https://example.org/unused-2.3.4.tar.gz");
    assert.deepEqual(declarations[0].source.hashes, [{ alg: "SHA-256", content: "c".repeat(64) }]);
    assert.deepEqual(declarations[0].source.provides, { dependency_names: "first-alias, second-alias" });
    assert.deepEqual(declarations[0].conditions, []);
    assert.ok(declarations[0].providerCandidates.every((candidate) => candidate.kind === "local-wrap" && candidate.selected === false && candidate.ref === parsed.pkgList[0]["bom-ref"]));
    mkdirSync(join(root, "consumer"));
    writeFileSync(join(root, "consumer", "meson.build"), "dependency('first-alias')\n");
    const child = parseCmakeLikeFile(join(root, "consumer", "meson.build"), "generic", { sourceRoot: root });
    assert.equal(child.requirements.filter((requirement) => requirement.command === "meson-wrap").length, 0,
      "the owning project declares a recipe once, not once per nested consumer");
    assert.ok(child.requirements[0].providerCandidates.some((candidate) => candidate.source?.file === "subprojects/unused.wrap"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("Meson requirements retain raw call arguments and complete nonliteral constraints", () => {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-meson-arguments-"));
  try {
    const file = join(root, "meson.build");
    writeFileSync(file, `project('Consumer')
if feature_enabled
  dependency('concat', version : '>=' + _drm_ver, modules: ['one,two', helper('three,four')])
endif
dependency('literal', version: '>= 1.2')
dependency('variable', version: required_version)
dependency('list', version: ['>= 1.0', '< 4.0'], fallback: ['demo', 'dep'])
`);
    const parsed = parseCmakeLikeFile(file, "generic", { sourceRoot: root });
    const concat = parsed.requirements.find((requirement) => requirement.requestedName === "concat");
    assert.equal(concat.file, "meson.build");
    assert.equal(concat.line, 3);
    assert.deepEqual(concat.conditions, ["if feature_enabled"]);
    assert.equal(concat.constraints, "'>=' + _drm_ver");
    assert.deepEqual(concat.arguments, ["'concat'", "version : '>=' + _drm_ver", "modules: ['one,two', helper('three,four')]"]);
    const literal = parsed.requirements.find((requirement) => requirement.requestedName === "literal");
    assert.equal(literal.constraints, ">= 1.2");
    assert.deepEqual(literal.arguments, ["'literal'", "version: '>= 1.2'"]);
    const variable = parsed.requirements.find((requirement) => requirement.requestedName === "variable");
    assert.equal(variable.constraints, "required_version");
    assert.deepEqual(variable.arguments, ["'variable'", "version: required_version"]);
    const list = parsed.requirements.find((requirement) => requirement.requestedName === "list");
    assert.equal(list.constraints, "['>= 1.0', '< 4.0']");
    assert.deepEqual(list.arguments, ["'list'", "version: ['>= 1.0', '< 4.0']", "fallback: ['demo', 'dep']"]);
    assert.ok(parsed.pkgList.every((component) => !component.version));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("keeps enclosing CMake guards distinct from evaluated and budget-truncated contexts", () => {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-cmake-evaluation-contexts-"));
  try {
    const file = join(root, "CMakeLists.txt");
    const variables = Array.from({ length: 8 }, (_, index) => `VERSION_${index}`);
    const branches = variables.map((variable, index) =>
      `if(BRANCH_${index})\nset(${variable} ${index})\nendif()`).join("\n");
    writeFileSync(file, `${branches}
project(Fixture VERSION ${variables.map((variable) => `\${${variable}}`).join(".")})
find_program(FORMAT format)
if(ENABLE_COVERAGE)
  find_program(COVERAGE coverage)
endif()
`);
    const parsed = parseCmakeLikeFile(file, "generic", { sourceRoot: root });
    const matching = parsed.requirements.filter((entry) => ["format", "coverage"].includes(entry.requestedName));
    assert.deepEqual(matching.map((entry) => entry.requestedName), ["format", "coverage"]);
    const [format, coverage] = matching;
    assert.deepEqual(format.enclosingConditions, []);
    assert.deepEqual(coverage.enclosingConditions, ["if(ENABLE_COVERAGE)"]);
    for (const entry of matching) {
      assert.equal(entry.evaluationCoverage, "truncated");
      assert.ok(entry.evaluationContexts.some((context) => context.includes("analysis-budget-exhausted")));
      assert.deepEqual(entry.arguments, entry.declaredArguments);
      const component = parsed.pkgList.find((candidate) => candidate.name === entry.requestedName);
      const property = component.properties.find((candidate) => candidate.name === "cdx:build:requirement");
      assert.deepEqual(JSON.parse(property.value), entry);
    }
    assert.ok(coverage.conditions.includes("if(ENABLE_COVERAGE)"));
    writeFileSync(file, `project(Fixture)
if(ENABLE_TOOL)
  find_program(TOOL tool)
endif()
`);
    const tool = parseCmakeLikeFile(file, "generic", { sourceRoot: root }).requirements.find((entry) => entry.requestedName === "tool");
    assert.equal(tool.enclosingConditions, undefined); // Identical lexical guards need no duplicate field.
    assert.deepEqual(tool.evaluationContexts, [["if(ENABLE_TOOL)"]]);
    assert.equal(tool.evaluationCoverage, undefined);
    writeFileSync(file, `project(Fixture)
if(ENABLE_TOOL)
  set(PROGRAM first-tool)
else()
  set(PROGRAM second-tool)
endif()
find_program(TOOL \${PROGRAM})
`);
    const alternatives = parseCmakeLikeFile(file, "generic", { sourceRoot: root }).requirements;
    assert.deepEqual(alternatives.map((entry) => [entry.requestedName, entry.enclosingConditions, entry.evaluationContexts]), [
      ["first-tool", [], [["if(ENABLE_TOOL)"]]],
      ["second-tool", [], [["if(ENABLE_TOOL)/else()"]]],
    ]);
    assert.ok(alternatives.every((entry) => entry.evaluationCoverage === undefined));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("retains CMake CONFIG aliases and diagnostic-only builtin searches", () => {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-cmake-discovery-roles-"));
  try {
    const file = join(root, "CMakeLists.txt");
    writeFileSync(file, `project(consumer)
set(config_names pkg-one pkg-two)
find_package(pkg CONFIG QUIET NAMES \${config_names} COMPONENTS Core OPTIONAL_COMPONENTS Extra)
find_path(HEADER_ROOT NAMES pkg/header.h pkg/legacy.h HINTS \${ROOT})
find_program(OS_VER ver)
if(OS_VER)
  execute_process(COMMAND \${OS_VER} OUTPUT_VARIABLE os_version OUTPUT_STRIP_TRAILING_WHITESPACE)
  set(diagnostic "\${diagnostic}; \${os_version}")
endif()
message(STATUS "Operating system: \${diagnostic}")
find_program(EXTERNAL_VER NAMES ver other-version-tool)
add_custom_target(run COMMAND \${EXTERNAL_VER})
`);
    const parsed = parseCmakeLikeFile(file, "generic", { sourceRoot: root });
    const config = parsed.requirements.find((requirement) => requirement.requestedName === "pkg");
    assert.deepEqual(config.alternatives, ["pkg-one", "pkg-two"]);
    assert.deepEqual(config.declaredArguments, ["pkg", "CONFIG", "QUIET", "NAMES", "${config_names}", "COMPONENTS", "Core", "OPTIONAL_COMPONENTS", "Extra"]);
    const header = parsed.requirements.find((requirement) => requirement.destination === "HEADER_ROOT");
    assert.deepEqual(header.alternatives, ["pkg/header.h", "pkg/legacy.h"]);
    assert.equal(header.role, "file-search");
    const diagnostic = parsed.requirements.find((requirement) => requirement.destination === "OS_VER");
    assert.equal(diagnostic.line, 5);
    assert.equal(diagnostic.role, "diagnostic-probe");
    assert.deepEqual(diagnostic.capability, { platform: "windows", shell: "cmd.exe", builtin: "ver", status: "potential" });
    assert.equal(parsed.requirements.find((requirement) => requirement.destination === "EXTERNAL_VER").role, "tool");
    const verComponents = parsed.pkgList.filter((component) => component.name === "ver");
    assert.equal(verComponents.length, 1);
    assert.ok(verComponents[0].properties.some((property) => property.value.includes('"destination":"EXTERNAL_VER"')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("records conditional compatible config fallbacks without conflating independent package identities", () => {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-cmake-config-fallback-"));
  try {
    const file = join(root, "CMakeLists.txt");
    writeFileSync(file, `set(HAVE_DEP FALSE)
find_package(prefixed QUIET CONFIG)
if(prefixed_FOUND)
  if(TARGET prefixed::sdk)
    set(DEP_TARGET prefixed::sdk)
    set(HAVE_DEP TRUE)
  endif()
endif()
if(NOT HAVE_DEP)
  find_package(original QUIET CONFIG)
  if(original_FOUND)
    if(TARGET original::sdk)
      set(DEP_TARGET original::sdk)
      set(HAVE_DEP TRUE)
    endif()
  endif()
endif()
`);
    const parsed = parseCmakeLikeFile(file, "generic", { sourceRoot: root });
    const before = parsed.requirements.find((entry) => entry.requestedName === "prefixed");
    assert.equal(before.role, "software");
    assert.deepEqual(before.configProbe, { expectedTargets: ["prefixed::sdk"],
      fallbacks: [{ requestedName: "original", line: 10, condition: "if(NOT HAVE_DEP)" }] });
    assert.ok(!before.providerCandidates.some((candidate) => candidate.name === "original"));
    const fallback = parsed.requirements.find((entry) => entry.requestedName === "original");
    assert.equal(fallback.line, 10);
    assert.deepEqual(fallback.conditions, ["if(NOT HAVE_DEP)"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("Meson preserves guarded versions, module edits and an explicit fallback variable", () => {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-meson-guarded-"));
  try {
    const file = join(root, "meson.build");
    mkdirSync(join(root, "subprojects"));
    writeFileSync(join(root, "VERSION"), "27.0.0-devel\n");
    writeFileSync(join(root, "subprojects", "engine-sdk.wrap"),
      "[wrap-file]\ndirectory = engine-sdk\nsource_url = https://github.com/example/engine/releases/download/v5.1/engine-sdk.zip\nsource_hash = " + "a".repeat(64));
    writeFileSync(file, `project('consumer', version: files('VERSION'))
modules = ['core']
if with_driver
  minimum = '>= 18.0.0'
  modules += ['driver']
elif with_renderer
  minimum = '>= 15.0.0'
else
  minimum = '>= 8.0.0'
  modules += 'portable'
endif
dependency('engine',
  method: host_machine.system() == 'windows' ? 'auto' : 'config-tool',
  version: minimum,
  modules: modules,
  fallback: allow_fallback ? ['engine-sdk', 'dep_engine_sdk'] : [])
dependency('engine', fallback: ['missing', 'dep_missing'])
`);
    const parsed = parseCmakeLikeFile(file, "generic", { sourceRoot: root });
    assert.equal(parsed.parentComponent.version, "27.0.0-devel");
    assert.ok(parsed.parentComponent.properties.some((property) => property.name === "cdx:version:source" && property.value === join(root, "VERSION")));
    const [dep, missing] = parsed.requirements.filter((requirement) => requirement.requestedName === "engine");
    assert.equal(dep.line, 12);
    assert.equal(dep.constraints, "minimum");
    assert.deepEqual(dep.mesonOptions.version.alternatives, [
      { value: ">= 18.0.0", conditions: ["if with_driver"] },
      { value: ">= 15.0.0", conditions: ["if with_driver/elif with_renderer"] },
      { value: ">= 8.0.0", conditions: ["if with_driver/elif with_renderer/else"] },
    ]);
    assert.deepEqual(dep.mesonOptions.method.alternatives, [
      { value: "auto", conditions: ["host_machine.system() == 'windows'"] },
      { value: "config-tool", conditions: ["not (host_machine.system() == 'windows')"] },
    ]);
    assert.deepEqual(dep.mesonOptions.modules.appends, [
      { value: ["driver"], conditions: ["if with_driver"] },
      { value: "portable", conditions: ["if with_driver/elif with_renderer/else"] },
    ]);
    const fallback = dep.providerCandidates.find((candidate) => candidate.kind === "local-wrap");
    assert.equal(fallback.name, "engine-sdk");
    assert.equal(fallback.dependencyVariable, "dep_engine_sdk");
    assert.deepEqual(fallback.conditions, ["allow_fallback"]);
    assert.equal(fallback.selected, false);
    assert.ok(!missing.providerCandidates.some((candidate) => candidate.kind === "local-wrap"));
    assert.ok(parsed.pkgList.some((component) => component.name === "engine" && !component.version));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("Meson project expressions never become literal component releases", () => {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-meson-version-expression-"));
  try {
    const file = join(root, "meson.build");
    for (const expression of ["files('VERSION').strip()", "unknown_version", "'1.2.3' + suffix", "compute(version: '9.9.9')"]) {
      writeFileSync(file, `project('consumer', version : ${expression})\n`);
      const parsed = parseCmakeLikeFile(file, "generic", { sourceRoot: root });
      assert.equal(parsed.parentComponent.name, "consumer");
      assert.ok(!parsed.parentComponent.version, expression);
      assert.equal(parsed.parentComponent.purl, "pkg:generic/consumer");
    }
    writeFileSync(file, "project('consumer', version : '1.2.3')\n");
    assert.equal(parseCmakeLikeFile(file, "generic", { sourceRoot: root }).parentComponent.version, "1.2.3");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("readMesonWraps() reads the version a wrap pins and what it provides", () => {
  const dir = mkdtempSync(join(tmpdir(), "cdxgen-wraps-"));
  try {
    writeFileSync(
      join(dir, "google-brotli.wrap"),
      readFileSync(
        join(
          "test",
          "data",
          "brotli-exposure",
          "meson-wrap",
          "subprojects",
          "google-brotli.wrap",
        ),
      ),
    );
    writeFileSync(
      join(dir, "zstd.wrap"),
      "[wrap-file]\ndirectory = zstd-1.5.6\nsource_filename = zstd-1.5.6.tar.gz\n\n[provide]\nlibzstd = libzstd_dep\n",
    );
    writeFileSync(
      join(dir, "fmt.wrap"),
      "[wrap-git]\nurl = https://github.com/fmtlib/fmt.git\nrevision = v11.0.2\n\n[provide]\ndependency_names = fmt\n",
    );
    writeFileSync(
      join(dir, "head.wrap"),
      "[wrap-git]\nurl = https://example.com/head.git\nrevision = head\n",
    );
    writeFileSync(join(dir, "notes.txt"), "not a wrap");
    const wraps = readMesonWraps(dir);
    assert.deepStrictEqual(wraps.get("libbrotlidec").map(({ declaredSource: _declaredSource, ...versionFacts }) => versionFacts), [{
      wrap: "google-brotli",
      version: "1.1.0",
      source: "wrapdb_version",
      revision: "3",
    }]);
    assert.strictEqual(
      wraps.get("brotli")?.[0].version,
      "1.1.0",
      "program names count",
    );
    assert.deepStrictEqual(wraps.get("libzstd").map(({ declaredSource: _declaredSource, ...versionFacts }) => versionFacts), [{
      wrap: "zstd",
      version: "1.5.6",
      source: "directory",
    }]);
    assert.strictEqual(wraps.get("fmt")?.[0].version, "11.0.2");
    assert.strictEqual(wraps.get("fmt")?.[0].source, "revision");
    assert.strictEqual(wraps.get("head")?.[0].version, undefined, "a branch name remains an unversioned provider candidate");
    assert.strictEqual(readMesonWraps(join(dir, "missing")).size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("readMesonWraps() and parseVcpkgManifest() do not block on a FIFO", async () => {
  if (process.platform === "win32") {
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "cdxgen-fifo-"));
  try {
    const { execFileSync } = await import("node:child_process");
    mkdirSync(join(dir, "subprojects"));
    execFileSync("mkfifo", [join(dir, "subprojects", "zlib.wrap")]);
    execFileSync("mkfifo", [join(dir, "vcpkg.json")]);
    assert.strictEqual(readMesonWraps(join(dir, "subprojects")).size, 0);
    const { parseVcpkgManifest } = await import("./cppEvidence.js");
    assert.deepStrictEqual(parseVcpkgManifest(dir), {
      parentComponent: undefined,
      pkgList: [],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("CMake uses explicit external download metadata for latest installers and ISA data", () => {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-cmake-downloads-"));
  const cache = mkdtempSync(join(tmpdir(), "cdxgen-cmake-download-cache-"));
  try {
    const installer = "https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-Linux-x86_64.sh";
    const isa = "https://gpuopen.com/download/machine-readable-isa/latest";
    const timemory = "https://github.com/ROCm/timemory/releases/download/timemory-timem%2Fv0.0.4/timemory-timem-1.0.0-Linux.sh";
    mkdirSync(join(cache, "downloads"));
    mkdirSync(join(cache, "download-artifacts"));
    const artifactBytes = Buffer.from("bounded original artifact fixture\n");
    const sha256 = createHash("sha256").update(artifactBytes).digest("hex");
    writeFileSync(join(cache, "download-artifacts", sha256), artifactBytes);
    for (const [url, metadata] of [
      [installer, { name: "Miniforge3", type: "application", releaseTag: "26.9.4-1", artifactVersion: "26.9.4-1",
        artifactVersionSource: "Installer header # VER", resolvedUrl: "https://github.com/conda-forge/miniforge/releases/download/26.9.4-1/Miniforge3-Linux-x86_64.sh" }],
      [isa, { name: "AMD GPU machine-readable ISA", type: "data", resolvedUrl: "https://gpuopen.com/download/AMD_GPU_MR_ISA_XML_2026_08_06.zip" }],
      [timemory, { name: "timemory-timem", type: "application", releaseTag: "timemory-timem/v0.0.4",
        artifactVersion: "1.0.0", artifactVersionSource: "CPack installer version header", resolvedUrl: timemory }],
    ]) {
      writeFileSync(join(cache, "downloads", `${nativeDownloadCacheKey(url)}.json`), JSON.stringify({
        schema: 1, url, observedAt: "2026-11-04T12:00:00.000Z", sha256, bytes: artifactBytes.length, artifact: `download-artifacts/${sha256}`,
        evidence: ["Inspected artifact metadata and SHA256"], ...metadata,
      }));
    }
    const file = join(root, "CMakeLists.txt");
    writeFileSync(file, `project(consumer)\nfile(DOWNLOAD ${installer} installer.sh)\nfile(DOWNLOAD ${isa} isa.zip)\nfile(DOWNLOAD ${timemory} timemory.sh)\n`);
    const uncached = parseCmakeLikeFile(file, "generic", { sourceRoot: root });
    assert.equal(uncached.pkgList.filter((component) => !component.version).length, 2);
    const parsed = parseCmakeLikeFile(file, "generic", { sourceRoot: root, nativeSourceCache: cache });
    const app = parsed.pkgList.find((component) => component.name === "Miniforge3");
    assert.equal(app.version, "26.9.4-1");
    assert.equal(app.type, "application");
    assert.ok(app.purl.includes("@26.9.4-1"));
    assert.deepEqual(app.hashes, [{ alg: "SHA-256", content: sha256 }]);
    const timem = parsed.pkgList.find((component) => component.name === "timemory-timem");
    assert.equal(timem.version, "1.0.0");
    assert.ok(timem.purl.includes("@1.0.0"));
    assert.ok(timem.properties.some((property) => property.name === "cdx:download:releaseTag" && property.value === "timemory-timem/v0.0.4"));
    const data = parsed.pkgList.find((component) => component.name === "AMD GPU machine-readable ISA");
    assert.equal(data.type, "data");
    assert.equal(data.version, `sha256:${sha256}`);
    assert.ok(data.properties.some((property) => property.name === "cdx:version:kind" && property.value === "artifact-revision"));
    const requirement = parsed.requirements.find((entry) => entry.source.url === isa);
    assert.equal(requirement.role, "data-artifact");
    assert.equal(requirement.line, 3);
    assert.ok(requirement.providerCandidates.some((candidate) => candidate.ref === data["bom-ref"]));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
});
