import { strict as assert, describe, it, test } from "poku";
import { dedupeBom } from "../cli/bomAssembly.js";
import { validateBom } from "../validator/bomValidator.js";

import { dedupeHierarchyComponents, mergeComponentDeclaration } from "./componentDeclarations.js";

const component = (name, extra = {}) => ({ type: "library", name, version: "1", purl: `pkg:generic/${name}@1`, "bom-ref": `pkg:generic/${name}@1`, ...extra });

describe("component declaration ownership", () => {
  it("defines workspace members once while preserving source hierarchy and graph", async () => {
    const ref = "pkg:npm/example-member@1.0.0";
    const member = { type: "application", name: "example-member", version: "1.0.0", purl: ref, "bom-ref": ref,
      licenses: [{ license: { id: "MIT" } }], authors: [{ name: "Maintainer" }], components: [{ type: "library", name: "nested", "bom-ref": "nested" }] };
    const parent = { type: "application", name: "source", version: "1", "bom-ref": "source", components: [member] };
    const lock = { type: "library", name: "example-member", version: "1.0.0", purl: ref, "bom-ref": ref,
      properties: [{ name: "internal:SrcFile", value: "package-lock.json" }] };
    const edges = [{ ref: "source", dependsOn: [ref] }, { ref, dependsOn: ["nested"] }, { ref: "nested", dependsOn: [] }];
    const result = dedupeBom({ specVersion: 1.7 }, [lock], parent, edges);
    assert.deepStrictEqual(result.bomJson.components, []);
    assert.strictEqual(result.bomJson.metadata.component.components[0].type, "application");
    assert.deepStrictEqual(result.bomJson.dependencies, edges);
    assert.strictEqual(result.bomJson.metadata.component.components[0].properties[0].value, "package-lock.json");
    assert.strictEqual(await validateBom(result.bomJson), true);
  });

  test("merges overlapping descendants under the same logical hierarchy owner", () => {
    for (const metadata of [true, false]) {
      const leaf = component("leaf", { tags: ["source"], components: [component("deep", { tags: ["source"] })] });
      const member = component("member", { type: "application", components: [leaf] });
      const root = component("root", { components: [member] });
      const copy = component("member", { tags: ["locked"], components: [
        component("leaf", { tags: ["locked"], properties: [{ name: "lock", value: "path" }], components: [component("deep", { tags: ["locked"] })] }),
        component("extra"),
      ] });
      const edges = [{ ref: root["bom-ref"], dependsOn: [member["bom-ref"]] }, { ref: member["bom-ref"], dependsOn: [leaf["bom-ref"]] }];
      const result = dedupeBom({ specVersion: 1.7 }, metadata ? [copy] : [copy, root], metadata ? root : undefined, edges);
      const retainedRoot = metadata ? result.bomJson.metadata.component : result.bomJson.components.find((p) => p.name === "root");
      const retained = retainedRoot.components[0];
      assert.equal(retained.type, "application");
      assert.deepEqual(retained.components.map((c) => c.name), ["leaf", "extra"]);
      assert.deepEqual(new Set(retained.components[0].tags), new Set(["source", "locked"]));
      assert.deepEqual(new Set(retained.components[0].components[0].tags), new Set(["source", "locked"]));
      assert.equal(retained.components[0].properties[0].value, "path");
      assert.deepEqual(result.bomJson.dependencies, edges);
    }
  });

  test("accepts identical sightings but rejects genuinely different owners and cycles", () => {
    const leaf = component("leaf");
    const member = component("member", { components: [leaf] });
    assert.deepEqual(dedupeHierarchyComponents([member, member], component("root", { components: [member] })), []);
    assert.throws(() => dedupeHierarchyComponents([
      component("one", { components: [component("leaf")] }),
      component("two", { components: [component("leaf")] }),
    ]), /multiple hierarchy owners/);
    assert.throws(() => dedupeHierarchyComponents([component("same", { components: [component("same")] })]), /cycle/);
    const cyclic = component("cycle");
    cyclic.components = [cyclic];
    assert.throws(() => dedupeHierarchyComponents([cyclic]), /cycle/);
    assert.throws(() => dedupeHierarchyComponents([component("member", { components: [component("leaf", { version: "2" })] })],
      component("root", { components: [component("member", { components: [component("leaf")] })] })), /Conflicting/);
  });

  test("retains manifest hierarchy and combines complementary lock evidence", () => {
    const child = component("member", { type: "application", licenses: [{ license: { id: "MIT" } }], authors: [{ name: "Author" }], externalReferences: [{ type: "vcs", url: "https://example.com/repo" }], tags: ["source"], components: [component("nested")] });
    const parent = component("root", { components: [child] });
    const lock = component("member", { properties: [{ name: "lock", value: "path" }], evidence: { identity: [{ field: "purl", confidence: 1, methods: [{ technique: "manifest-analysis", confidence: 1, value: "lock" }] }] }, tags: ["locked"], components: [component("extra")] });
    assert.deepEqual(dedupeHierarchyComponents([lock], parent), []);
    assert.equal(parent.components[0], child);
    assert.equal(child.type, "application");
    assert.equal(child.licenses[0].license.id, "MIT");
    assert.equal(child.authors[0].name, "Author");
    assert.equal(child.externalReferences[0].url, "https://example.com/repo");
    assert.equal(child.evidence.identity[0].methods[0].value, "lock");
    assert.deepEqual(child.tags, ["source", "locked"]);
    assert.deepEqual(child.components.map((c) => c.name), ["nested", "extra"]);
    assert.equal(child.properties[0].value, "path");
  });

  test("preserves source inventory nested below a top-level source root", () => {
    const member = component("member");
    const root = component("source", { components: [member] });
    assert.deepEqual(dedupeHierarchyComponents([component("member"), root]), [root]);
  });

  test("refuses conflicting identities and containment cycles", () => {
    assert.throws(() => mergeComponentDeclaration(component("same"), component("other", { "bom-ref": "pkg:generic/same@1" })), /Conflicting/);
    const target = component("same");
    assert.throws(() => mergeComponentDeclaration(target, component("same", { components: [component("container", { components: [target] })] })), /cycle/);
    assert.ok(!target.components);
  });

  test("retains license-expression precedence and complementary evidence", () => {
    const target = component("same", { licenses: [{ expression: "MIT OR Apache-2.0" }], evidence: { occurrences: [{ location: "a" }] } });
    mergeComponentDeclaration(target, component("same", { licenses: [{ license: { id: "MIT" } }], evidence: { occurrences: [{ location: "b" }] }, externalReferences: [{ type: "website", url: "https://example.com" }] }));
    assert.deepEqual(target.licenses, [{ expression: "MIT OR Apache-2.0" }]);
    assert.deepEqual(target.evidence.occurrences, [{ location: "a" }, { location: "b" }]);
    assert.equal(target.externalReferences.length, 1);
  });
});
