import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test } from "poku";

import { resolveNativeProviderAlternatives } from "./nativeProviderResolution.js";
import { nativeFinderReceiptEntry, readNativeScopedReceipts } from "./nativeScopedReceipts.js";

const sha = (text) => createHash("sha256").update(text).digest("hex");

test("an exact configured receipt resolves a versioned owner without promising installed material", () => {
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), "scoped-receipt-"));
  try {
    const root = join(scratch, "source");
    const bundle = join(scratch, "bundle");
    const captured = join(scratch, "captured");
    for (const path of [root, bundle, captured]) mkdirSync(path);
    const source = "if(ILP64)\nfind_package(Math64 CONFIG REQUIRED)\nendif()\n";
    const sourceFile = join(root, "CMakeLists.txt");
    writeFileSync(sourceFile, source);
    const material = "add_library(Math64::Math IMPORTED INTERFACE)\n";
    const configFile = join(bundle, "Math64Config.cmake");
    writeFileSync(configFile, material);
    const manifest = join(bundle, "capture.json");
    const occurrence = { file: "CMakeLists.txt", line: 2, ordinal: 1, requestedName: "Math64", command: "find_package",
      role: "software", constraints: "", arguments: ["Math64", "CONFIG", "REQUIRED"], conditions: ["if(ILP64)"],
      evaluationContexts: [["if(ILP64)"]] };
    const record = { occurrence, sourceInputs: [], sourceSha256: sha(source),
      owner: { name: "Math", repository: "https://example.org/math", revision: "0123456789012345678901234567890123456789" },
      lookup: { kind: "configured-package", root: captured, configuration: sha(material) },
      output: { name: "Math64", target: "Math64::Math", file: "Math64Config.cmake", capturedFile: join(captured, "Math64Config.cmake") },
      evidence: [{ file: "Math64Config.cmake", sha256: sha(material) }],
    };
    const capture = (records) => {
      const text = JSON.stringify({ format: "native-scoped-receipts-v1", sourceRoot: root, records });
      writeFileSync(manifest, text);
      return `${sha(text)}:${manifest}`;
    };
    const valid = capture([record]);
    assert.equal(readNativeScopedReceipts(valid, root)[0].owner.name, "Math");
    assert.deepEqual(readNativeScopedReceipts(`${"0".repeat(64)}:${manifest}`, root), []);
    assert.deepEqual(readNativeScopedReceipts(valid, bundle), []);
    const ref = "pkg:generic/Math64";
    const property = "cdx:build:requirement";
    const run = (request, nativeScopedReceipt = valid) => resolveNativeProviderAlternatives([
      { name: "Math64", "bom-ref": ref, properties: [{ name: property, value: JSON.stringify({ ...request, providerCandidates: [] }) }] },
    ], [{ ref: "consumer", dependsOn: [ref] }], root, { nativeScopedReceipt });
    const actual = run(occurrence);
    assert(!actual.pkgList.some((component) => component["bom-ref"] === ref));
    const owner = actual.pkgList.find((component) => component.name === "Math");
    assert.equal(owner.version, record.owner.revision);
    assert.deepEqual(actual.remap.get(ref), [owner["bom-ref"]]);
    assert.deepEqual(actual.dependencies.find((entry) => entry.ref === "consumer").dependsOn, [owner["bom-ref"]]);
    const requirement = JSON.parse(owner.properties.find((entry) => entry.name === property).value);
    assert.deepEqual(requirement.evaluationContexts, occurrence.evaluationContexts);
    const [candidate] = requirement.providerCandidates;
    assert.equal(candidate.compatibility, "unknown");
    assert.equal(candidate.selected, false);
    assert.equal(candidate.exports[0].materialUnknown, true);
    assert.equal(candidate.exports[0].configuredReceipt.output.target, "Math64::Math");
    for (const other of [{ ...occurrence, line: 3 }, { ...occurrence, evaluationContexts: [["if(LP64)"]] },
      { ...occurrence, arguments: ["Math64", "MODULE", "REQUIRED"] }]) {
      const result = run(other);
      assert(result.pkgList.some((component) => component["bom-ref"] === ref && !component.version));
      assert(!result.pkgList.some((component) => component.name === "Math"));
    }
    writeFileSync(sourceFile, `${source}# changed\n`);
    assert.deepEqual(readNativeScopedReceipts(valid, root), []);
    writeFileSync(sourceFile, source);
    writeFileSync(configFile, `${material}# tampered\n`);
    assert.deepEqual(readNativeScopedReceipts(valid, root), []);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a finder receipt scopes an authenticated owner and keeps its interface version separate", () => {
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), "finder-receipt-"));
  try {
    const root = join(scratch, "source");
    const bundle = join(scratch, "bundle");
    mkdirSync(root);
    mkdirSync(bundle);
    const source = "if(OPTIONAL)\nfind_package(Backend MODULE REQUIRED)\nendif()\n";
    writeFileSync(join(root, "CMakeLists.txt"), source);
    const member = "#define BACKEND_API 2\n";
    writeFileSync(join(bundle, "backend.h"), member);
    const snapshot = JSON.stringify({ schema: 1, name: "public-backend", versionKind: "release", version: "7.4",
      exports: [{ kind: "header-file", name: "backend.h" }],
      evidence: [{ path: "backend.h", sha256: sha(member) }] });
    writeFileSync(join(bundle, "snapshot.json"), snapshot);
    const metadata = join(bundle, "metadata.json");
    writeFileSync(metadata, JSON.stringify({ schema: 1, providers: [{
      metadata: { format: "provider-snapshot", path: "snapshot.json", sha256: sha(snapshot) },
    }] }));
    const occurrence = { file: "CMakeLists.txt", line: 2, ordinal: 1, requestedName: "Backend", command: "find_package",
      role: "software", arguments: ["Backend", "MODULE", "REQUIRED"], conditions: ["if(OPTIONAL)"] };
    const record = { occurrence, sourceSha256: sha(source), sourceInputs: [],
      owner: { name: "public-backend", version: "7.4", metadataSha256: sha(snapshot) },
      lookup: { kind: "finder-owner" },
      output: { name: "Backend", member: "backend.h", interfaceVersion: "2" },
      evidence: [{ file: "snapshot.json", sha256: sha(snapshot) }, { file: "backend.h", sha256: sha(member) }] };
    const capture = (claim) => {
      const text = JSON.stringify({ format: "native-scoped-receipts-v1", sourceRoot: root, records: [claim] });
      const path = join(bundle, "capture.json");
      writeFileSync(path, text);
      return `${sha(text)}:${path}`;
    };
    const ref = "pkg:generic/Backend";
    const property = "cdx:build:requirement";
    const run = (request, receipt) => resolveNativeProviderAlternatives([
      { name: "Backend", "bom-ref": ref, properties: [{ name: property, value: JSON.stringify({ ...request, providerCandidates: [] }) }] },
    ], [{ ref: "consumer", dependsOn: [ref] }], root, { nativeScopedReceipt: receipt, nativeProviderMetadata: metadata });
    const valid = capture(record);
    const result = run(occurrence, valid);
    const owner = result.pkgList.find((component) => component.name === "public-backend" &&
      component.properties?.some((entry) => entry.name === property));
    assert.equal(owner?.version, "7.4");
    const [candidate] = JSON.parse(owner.properties.find((entry) => entry.name === property).value).providerCandidates;
    assert.equal(candidate.selected, false);
    assert.equal(candidate.compatibility, "unknown");
    assert.equal(candidate.exports[0].interfaceVersion, "2");
    assert.equal(candidate.exports[0].finderReceipt.output.member, "backend.h");
    assert(!result.pkgList.some((component) => component["bom-ref"] === ref));
    for (const request of [{ ...occurrence, line: 3 }, { ...occurrence, conditions: ["if(OTHER)"] }]) {
      assert(run(request, valid).pkgList.some((component) => component["bom-ref"] === ref));
    }
    for (const claim of [{ ...record, owner: { ...record.owner, version: "9.0" } },
      { ...record, output: { ...record.output, member: "missing.h" } }]) {
      assert(run(occurrence, capture(claim)).pkgList.some((component) => component["bom-ref"] === ref));
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a program-owner receipt retains a concrete non-default executable as an unselected PATH alternative", () => {
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), "program-receipt-"));
  try {
    const root = join(scratch, "source");
    const bundle = join(scratch, "bundle");
    mkdirSync(root); mkdirSync(bundle);
    const source = "if(DOCS)\nfind_program(GEN generator DOC \"generator\")\nendif()\n";
    writeFileSync(join(root, "CMakeLists.txt"), source);
    const artifact = "authenticated material";
    writeFileSync(join(bundle, "archive"), artifact);
    const occurrence = { file: "CMakeLists.txt", line: 2, ordinal: 1, requestedName: "generator", command: "find_program",
      role: "tool", arguments: ["GEN", "generator", "DOC", "generator"], conditions: ["if(DOCS)"] };
    const owner = { name: "tools", version: "1.2", metadataSha256: sha("metadata") };
    const output = { name: "generator", mode: "program", member: "/usr/lib/owner/bin/generator" };
    const record = { occurrence, sourceSha256: sha(source), sourceInputs: [], owner,
      lookup: { kind: "finder-owner" }, output, evidence: [{ file: "archive", sha256: sha(artifact) }] };
    const capture = (claim) => {
      const text = JSON.stringify({ format: "native-scoped-receipts-v1", sourceRoot: root, records: [claim] });
      const path = join(bundle, "capture.json");
      writeFileSync(path, text);
      return readNativeScopedReceipts(`${sha(text)}:${path}`, root);
    };
    const [receipt] = capture(record);
    const provider = { ...owner, repositoryEvidence: {}, packageSha256: sha(artifact),
      exports: [{ kind: "tool", name: "generator", file: output.member }] };
    const entry = nativeFinderReceiptEntry(receipt, provider);
    assert.equal(entry.kind, "tool");
    assert.equal(entry.file, output.member);
    assert.equal(entry.executableUnknown, true);
    assert.equal(entry.predicateStatus, "unknown");
    assert.equal(nativeFinderReceiptEntry(receipt, { ...provider, packageSha256: sha("other") }), undefined);
    assert.equal(nativeFinderReceiptEntry(receipt, { ...provider, exports: [{ ...provider.exports[0], file: "/unrelated/generator" }] }), undefined);
    for (const args of [["GEN", "generator", "NO_DEFAULT_PATH"], ["GEN", "generator", "PATHS", "/wrong"], ["GEN", "unrelated"]]) {
      assert.deepEqual(capture({ ...record, occurrence: { ...occurrence, arguments: args } }), []);
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("a restricted install plan binds only its exact guarded output and never claims installation", () => {
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), "install-plan-receipt-"));
  try {
    const root = join(scratch, "source");
    const bundle = join(scratch, "bundle");
    mkdirSync(root); mkdirSync(bundle);
    const bin = join(root, "external", "output", "bin");
    const source = `if(TESTS)\nfind_program(TOOL NAMES old-tool PATHS ${bin} NO_DEFAULT_PATH)\nendif()\n`;
    writeFileSync(join(root, "CMakeLists.txt"), source);
    const plan = "configured install plan";
    writeFileSync(join(bundle, "plan.json"), plan);
    const occurrence = { file: "CMakeLists.txt", line: 2, ordinal: 1, requestedName: "old-tool", command: "find_program",
      role: "tool", arguments: ["TOOL", "NAMES", "old-tool", "PATHS", bin, "NO_DEFAULT_PATH"], conditions: ["if(TESTS)"],
      evaluationContexts: [["if(TESTS)"]] };
    const record = { occurrence, sourceSha256: sha(source), sourceInputs: [],
      owner: { name: "tools", repository: "https://example.org/tools.git", revision: "1".repeat(40) },
      lookup: { kind: "restricted-install-plan", root: bin, configuration: sha(plan) },
      output: { name: "old-tool", file: "plan.json", capturedFile: join(bin, "old-tool"), target: "new-tool::@deadcafe",
        alias: { kind: "relative-symlink", target: "new-tool", sourceLine: 23 } },
      evidence: [{ file: "plan.json", sha256: sha(plan) }] };
    const capture = (claim) => {
      const text = JSON.stringify({ format: "native-scoped-receipts-v1", sourceRoot: root, records: [claim] });
      const path = join(bundle, "capture.json");
      writeFileSync(path, text);
      return `${sha(text)}:${path}`;
    };
    const ref = "pkg:generic/old-tool";
    const run = (request, nativeScopedReceipt) => resolveNativeProviderAlternatives([
      { name: "old-tool", "bom-ref": ref, properties: [{ name: "cdx:build:requirement", value: JSON.stringify(request) }] },
    ], [], root, { nativeScopedReceipt });
    const valid = capture(record);
    const actual = run(occurrence, valid);
    const owner = actual.pkgList.find((component) => component.name === "tools");
    assert.equal(owner.version, record.owner.revision);
    const requirement = JSON.parse(owner.properties.find((entry) => entry.name === "cdx:build:requirement").value);
    const [candidate] = requirement.providerCandidates;
    assert.equal(candidate.compatibility, "unknown");
    assert.equal(candidate.selected, false);
    assert.equal(candidate.exports[0].file, record.output.capturedFile);
    assert.equal(candidate.exports[0].executableUnknown, true);
    assert.deepEqual(candidate.exports[0].configuredReceipt.output.alias, record.output.alias);
    for (const request of [{ ...occurrence, line: 4 }, { ...occurrence, evaluationContexts: [["not(TESTS)"]] },
      { ...occurrence, arguments: occurrence.arguments.slice(0, -1) }]) {
      assert(!run(request, valid).pkgList.some((component) => component.name === "tools"));
    }
    for (const claim of [{ ...record, lookup: { ...record.lookup, root: root } },
      { ...record, output: { ...record.output, capturedFile: join(root, "old-tool") } },
      { ...record, output: { ...record.output, alias: { ...record.output.alias, target: "../outside" } } }]) {
      assert.deepEqual(readNativeScopedReceipts(capture(claim), root), []);
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("a local Meson fallback receipt preserves the fallback branch separately from the consumer guard", () => {
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), "meson-receipt-"));
  try {
    const root = join(scratch, "source"), bundle = join(scratch, "bundle");
    mkdirSync(root); mkdirSync(bundle);
    const source = "dependency('sdk', fallback: enable ? ['sdk-wrap', 'dep_sdk'] : [])";
    const wrap = "subprojects/sdk-wrap.wrap";
    mkdirSync(join(root, "subprojects", "packagefiles", "sdk-wrap"), { recursive: true });
    const patch = "subprojects/packagefiles/sdk-wrap/meson.build";
    writeFileSync(join(root, "meson.build"), source);
    writeFileSync(join(root, wrap), "[wrap-file]\n");
    writeFileSync(join(root, patch), "dep_sdk = declare_dependency()\n");
    writeFileSync(join(bundle, "metadata.json"), "snapshot");
    const occurrence = { file: "meson.build", line: 1, ordinal: 0, requestedName: "sdk", command: "dependency", role: "software",
      arguments: ["'sdk'", "fallback: enable ? ['sdk-wrap', 'dep_sdk'] : []"], conditions: ["if with_sdk"],
      mesonOptions: { fallback: { alternatives: [{ value: ["sdk-wrap", "dep_sdk"], conditions: ["enable"] },
        { value: [], conditions: ["not (enable)"] }] } } };
    const owner = { name: "sdk-owner", version: "1.2", metadataSha256: sha("snapshot") };
    const record = { occurrence, sourceSha256: sha(source), sourceInputs: [{ file: wrap, sha256: sha("[wrap-file]\n") },
      { file: patch, sha256: sha("dep_sdk = declare_dependency()\n") }], owner, lookup: { kind: "finder-owner" },
      output: { name: "sdk", mode: "meson-fallback", member: "sdk", wrap, patch, dependencyVariable: "dep_sdk" },
      evidence: [{ file: "metadata.json", sha256: owner.metadataSha256 }] };
    const capture = (claim) => {
      const text = JSON.stringify({ format: "native-scoped-receipts-v1", sourceRoot: root, records: [claim] });
      const path = join(bundle, "capture.json");
      writeFileSync(path, text);
      return readNativeScopedReceipts(`${sha(text)}:${path}`, root);
    };
    const [receipt] = capture(record);
    const provider = { ...owner, kind: "provider-snapshot", exports: [{ kind: "library", name: "sdk", sourceDeclared: true }] };
    const entry = nativeFinderReceiptEntry(receipt, provider);
    assert.equal(entry.kind, "meson");
    assert.deepEqual(entry.conditions, ["if with_sdk", "enable"]);
    assert.equal(entry.dependencyVariable, "dep_sdk");
    assert.equal(entry.materialUnknown, true);
    assert.equal(nativeFinderReceiptEntry(receipt, { ...provider, exports: [{ kind: "library", name: "sdk" }] }), undefined);
    assert.deepEqual(capture({ ...record, output: { ...record.output, dependencyVariable: "other" } }), []);
    assert.deepEqual(capture({ ...record, sourceInputs: record.sourceInputs.slice(0, 1) }), []);
    assert.deepEqual(capture({ ...record, occurrence: { ...occurrence, mesonOptions: { fallback: { alternatives: [{ value: [], conditions: [] }] } } } }), []);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("Meson dependency receipts expose only the exact occurrence, not a generic lookup interface", () => {
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), "meson-receipt-"));
  try {
    const root = join(scratch, "source");
    const bundle = join(scratch, "bundle");
    mkdirSync(root);
    mkdirSync(bundle);
    const source = "if use_backend\n  dep = dependency('backend')\nendif\n";
    writeFileSync(join(root, "meson.build"), source);
    const material = 'cc_library { name: "libbackend" }\n';
    writeFileSync(join(bundle, "Android.bp"), material);
    const snapshot = JSON.stringify({ schema: 1, name: "android-backend", versionKind: "release", version: "10.0",
      platform: "android", exports: [{ kind: "library", name: "libbackend", sourceDeclared: true },
        { kind: "library", name: "libunrelated", sourceDeclared: true }],
      evidence: [{ path: "Android.bp", sha256: sha(material) }] });
    writeFileSync(join(bundle, "snapshot.json"), snapshot);
    const metadata = join(bundle, "metadata.json");
    writeFileSync(metadata, JSON.stringify({ schema: 1, providers: [{
      metadata: { format: "provider-snapshot", path: "snapshot.json", sha256: sha(snapshot) },
    }] }));
    const occurrence = { file: "meson.build", line: 2, ordinal: 1, requestedName: "backend", command: "dependency",
      role: "software", arguments: ["'backend'"], conditions: ["if use_backend"] };
    const record = { occurrence, sourceSha256: sha(source), sourceInputs: [],
      owner: { name: "android-backend", version: "10.0", metadataSha256: sha(snapshot) },
      lookup: { kind: "finder-owner" }, output: { name: "backend", mode: "meson-dependency", member: "libbackend" },
      evidence: [{ file: "snapshot.json", sha256: sha(snapshot) }, { file: "Android.bp", sha256: sha(material) }] };
    const capture = (claim) => {
      const text = JSON.stringify({ format: "native-scoped-receipts-v1", sourceRoot: root, records: [claim] });
      const path = join(bundle, "capture.json");
      writeFileSync(path, text);
      return `${sha(text)}:${path}`;
    };
    const ref = "pkg:generic/backend";
    const property = "cdx:build:requirement";
    const run = (request, receipt) => resolveNativeProviderAlternatives([
      { name: "backend", "bom-ref": ref, properties: [{ name: property, value: JSON.stringify({ ...request, providerCandidates: [] }) }] },
    ], [{ ref: "consumer", dependsOn: [ref] }], root, { nativeScopedReceipt: receipt, nativeProviderMetadata: metadata });
    const selector = capture(record);
    const result = run(occurrence, selector);
    const owner = result.pkgList.find((component) => component.name === "android-backend" &&
      component.properties?.some((entry) => entry.name === property));
    assert.equal(owner?.version, "10.0");
    const [candidate] = JSON.parse(owner.properties.find((entry) => entry.name === property).value).providerCandidates;
    assert.equal(candidate.selected, false);
    assert.equal(candidate.compatibility, "unknown");
    assert.equal(candidate.exports[0].kind, "meson");
    assert.equal(candidate.exports[0].materialUnknown, true);
    assert.equal(candidate.exports[0].finderReceipt.material.sourceDeclared, true);
    for (const request of [{ ...occurrence, line: 3 }, { ...occurrence, conditions: ["if other_backend"] },
      { ...occurrence, arguments: ["'backend'", "method : 'pkg-config'"] }]) {
      assert(run(request, selector).pkgList.some((component) => component["bom-ref"] === ref));
    }
    for (const output of [{ ...record.output, member: "libunrelated" }, { ...record.output, interfaceVersion: "10.0" }]) {
      assert(run(occurrence, capture({ ...record, output })).pkgList.some((component) => component["bom-ref"] === ref));
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
