import { strict as assert, test } from "poku";
import { mergeNativeProviderResolutions } from "./nativeProviderResolution.js";

const requirement = (line) => ({ name: "cdx:build:requirement", value: JSON.stringify({ requestedName: "widget", command: "find_library", role: "software", file: "CMakeLists.txt", line, constraints: "" }) });
const original = (lines) => ({ name: "widget", "bom-ref": "request:widget", properties: [{ name: "SrcPath", value: "CMakeLists.txt" }, ...lines.map(requirement)] });
const provider = (ref, version, lines) => ({ name: "widget", version, "bom-ref": ref, properties: lines.map(requirement) });
const pass = (pkgList, refs) => ({ pkgList, dependencies: [], remap: new Map([["request:widget", refs]]) });

test("retains both checked-out and external alternatives for the same occurrence", () => {
  const request = original([3]);
  const source = provider("source:widget", "1.0", [3]);
  const external = provider("external:widget", "2.0", [3]);
  const result = mergeNativeProviderResolutions([request], [{ ref: "consumer", dependsOn: [request["bom-ref"]], provides: [request["bom-ref"]] }], [pass([external], [external["bom-ref"]]), pass([source], [source["bom-ref"]])]);
  assert.deepEqual(new Set(result.pkgList.map((component) => component["bom-ref"])), new Set(["source:widget", "external:widget"]));
  assert.deepEqual(new Set(result.dependencies[0].dependsOn), new Set(["source:widget", "external:widget"]));
  assert.deepEqual(new Set(result.dependencies[0].provides), new Set(["source:widget", "external:widget"]));
  assert.deepEqual(new Set(result.remap.get(request["bom-ref"])), new Set(["source:widget", "external:widget"]));
});

test("complementary partial passes resolve every occurrence without losing either provider", () => {
  const request = original([3, 7]);
  const external = provider("external:widget", "2.0", [3]);
  const source = provider("source:widget", "1.0", [7]);
  const result = mergeNativeProviderResolutions([request], [{ ref: "consumer", dependsOn: [request["bom-ref"]] }], [
    pass([original([7]), external], [request["bom-ref"], external["bom-ref"]]),
    pass([original([3]), source], [request["bom-ref"], source["bom-ref"]]),
  ]);
  assert.equal(result.pkgList.some((component) => !component.version), false);
  assert.deepEqual(new Set(result.dependencies[0].dependsOn), new Set(["external:widget", "source:widget"]));
});

test("retains only occurrences unresolved by both passes and their original provenance", () => {
  const request = original([3, 7, 11]);
  const external = provider("external:widget", "2.0", [3]);
  const source = provider("source:widget", "1.0", [7]);
  const result = mergeNativeProviderResolutions([request], [{ ref: "consumer", dependsOn: [request["bom-ref"]] }], [
    pass([original([7, 11]), external], [request["bom-ref"], external["bom-ref"]]),
    pass([original([3, 11]), source], [request["bom-ref"], source["bom-ref"]]),
  ]);
  const unbound = result.pkgList.find((component) => component["bom-ref"] === request["bom-ref"]);
  assert.deepEqual(unbound.properties.filter((p) => p.name === "cdx:build:requirement").map((p) => JSON.parse(p.value).line), [11]);
  assert.equal(unbound.properties.find((p) => p.name === "SrcPath").value, "CMakeLists.txt");
  assert.deepEqual(new Set(result.dependencies[0].dependsOn), new Set(["request:widget", "external:widget", "source:widget"]));
});

test("leaves conflicting artifact identities to canonicalization instead of merging by shared ref", () => {
  const linux = { ...provider("shared", "1.0", []), properties: [{ name: "platform", value: "linux" }] };
  const windows = { ...provider("shared", "1.0", []), properties: [{ name: "platform", value: "windows" }] };
  const result = mergeNativeProviderResolutions([], [], [{ pkgList: [linux, windows], dependencies: [], remap: new Map() }, { pkgList: [linux], dependencies: [], remap: new Map() }]);
  assert.deepEqual(result.pkgList, [linux, windows]);
});

test("keeps opaque unresolved records and malformed requirement metadata visible", () => {
  const component = { name: "unknown", "bom-ref": "unknown", properties: [{ name: "cdx:build:requirement", value: "invalid" }] };
  const result = mergeNativeProviderResolutions([component], [], [{ pkgList: [component], dependencies: [], remap: new Map() }]);
  assert.deepEqual(result.pkgList, [component]);
  assert.equal(result.remap.size, 0);
});

test("adding an alternative does not give it an existing source provider's private dependencies", () => {
  const source = provider("source:widget", "1.0", [3]);
  const external = provider("external:widget", "2.0", [3]);
  const dependencies = [{ ref: "consumer", dependsOn: ["source:widget"] }, { ref: "source:widget", dependsOn: ["source-only-helper"] }];
  const result = mergeNativeProviderResolutions([], dependencies, [
    { pkgList: [source, external], dependencies: [{ ref: "external:widget", dependsOn: [] }], remap: new Map([["source:widget", ["source:widget", "external:widget"]]]) },
    { pkgList: [source], dependencies, refMap: new Map() },
  ]);
  assert.deepEqual(new Set(result.dependencies.find((edge) => edge.ref === "consumer").dependsOn), new Set(["source:widget", "external:widget"]));
  assert.deepEqual(result.dependencies.find((edge) => edge.ref === "source:widget").dependsOn, ["source-only-helper"]);
  assert.deepEqual(result.dependencies.find((edge) => edge.ref === "external:widget").dependsOn, []);
  assert.equal(result.remap.has("source:widget"), false, "an existing source identity must not be rewritten as an unrelated alternative's identity");
});
