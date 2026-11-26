import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test } from "poku";

import { resolveNativeProviderAlternatives } from "./nativeProviderResolution.js";
import { readNativeScopedReceipts } from "./nativeScopedReceipts.js";

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
