import assert from "node:assert/strict";
import { test } from "poku";
import { createNativeRequirementEvidenceIndex, packNativeRequirementEvidence } from "./nativeRequirementEvidence.js";

const inline = (value) => ({ name: "cdx:build:requirement", value });
const link = (value) => ({ name: "cdx:build:requirementLink", value });
const header = (value = "1") => ({ name: "cdx:build:requirementTable", value });
const row = (id, value) => ({ name: `cdx:build:requirementTable:${id}`, value });

test("factors only repeated exact JSON strings and restores property order and bytes", () => {
  const original = ' { "requestedName" : "a\\u002fb", "providerCandidates": [ { "name": "é" } ] } \n';
  const distinct = '{"requestedName":"a/b","providerCandidates":[{"name":"é"}]}';
  const second = '{"requestedName":"bin","quote":"\\\""}';
  const firstId = "sha256:8e74c3bb201ed209b666eb317d0cd24552fd39378185e5c7c4505db635aefeeb";
  const secondId = "sha256:e7e17a774175e1480385a5320c16723cc22350a7ef287aef62219bbe2c22eb89";
  const shared = inline(original);
  const before = [
    { properties: [{ name: "unrelated", value: "true" }, shared, inline(second), inline(distinct)] },
    { properties: [inline(second), inline(original), shared] },
  ];
  const source = JSON.stringify(before.map(({ properties }) => properties));
  const packed = packNativeRequirementEvidence((function* () { yield* before; yield before[0]; })());
  assert.deepEqual(packed, {
    tableProperties: [header(), row(firstId, original), row(secondId, second)], packedAttachments: 5, uniqueValues: 2,
  });
  assert.deepEqual(before[0].properties, [{ name: "unrelated", value: "true" }, link(firstId), link(secondId), inline(distinct)]);
  assert.deepEqual(before[1].properties, [link(secondId), link(firstId), link(firstId)]);
  assert.equal(shared.value, original, "replace the attachment slot, not the shared original property object");
  const received = JSON.parse(JSON.stringify({ metadata: { properties: packed.tableProperties }, holders: before }));
  const index = createNativeRequirementEvidenceIndex(received.metadata.properties);
  assert.equal(JSON.stringify(received.holders.map(({ properties }) => index.expandProperties(properties))), source);
});

test("leaves legacy, malformed and unusual attachment properties untouched", () => {
  const text = '{"requestedName":"tool"}';
  const distinct = '{"requestedName":"another"}';
  const unusual = { ...inline(text), extra: "keep" };
  const reversed = { value: text, name: "cdx:build:requirement" };
  const properties = [inline("{invalid"), inline("{invalid"), inline("[]"), inline("[]"), inline(null),
    inline(distinct), unusual, reversed, inline(text), inline('{"x":"\ud800"}'), inline('{"x":"\ud800"}')];
  const original = [...properties];
  const packed = packNativeRequirementEvidence([{ properties }, {}, null]);
  assert.deepEqual(packed, { tableProperties: [], packedAttachments: 0, uniqueValues: 0 });
  assert.ok(properties.every((property, index) => property === original[index]));
  const legacy = createNativeRequirementEvidenceIndex();
  assert.equal(legacy.expandProperties(properties), properties);
  assert.equal(legacy.resolveProperty(unusual), unusual);
  assert.equal(legacy.resolveProperty(reversed), reversed);
});

test("accepts matching merged fragments but rejects conflicting, malformed or dangling evidence", () => {
  const raw = '{"requestedName":"tool"}';
  const id = "sha256:dc2453d9e70c2ae7d89d4072bae68ed37f692dc221dc905a09173279cc9205d0";
  const missing = `sha256:${"a".repeat(64)}`;
  assert.throws(() => createNativeRequirementEvidenceIndex([header("2"), row(id, raw)]), /schema/i);
  assert.throws(() => createNativeRequirementEvidenceIndex([row(id, raw)]), /schema/i);
  assert.throws(() => createNativeRequirementEvidenceIndex([header(), header("2")]), /schema/i);
  assert.throws(() => createNativeRequirementEvidenceIndex([header(), row("r01", raw)]), /invalid/i);
  assert.throws(() => createNativeRequirementEvidenceIndex([header(), row(id, "not JSON")]), /invalid/i);
  assert.throws(() => createNativeRequirementEvidenceIndex([header(), row(id, "{}")]), /digest/i);
  assert.throws(() => createNativeRequirementEvidenceIndex([header(), row(id, raw), row(id, "{}")]), /conflict/i);
  const index = createNativeRequirementEvidenceIndex([
    { name: "some-legacy-property", value: "ignored" }, header(), row(id, raw), header(), row(id, raw),
  ]);
  assert.deepEqual(index.resolveProperty(link(id)), inline(raw));
  assert.throws(() => index.resolveProperty(link(missing)), /missing/i);
  assert.throws(() => index.resolveProperty({ ...link(id), extra: "unsupported" }), /invalid/i);
  assert.throws(() => index.expandProperties([link("pkg:generic/tool")]), /invalid/i);
  assert.throws(() => createNativeRequirementEvidenceIndex().resolveProperty(link(id)), /missing/i);
});

test("does not repack or partially change an already linked inventory", () => {
  const properties = [inline('{}'), inline('{}'), link("r1")];
  const original = [...properties];
  assert.throws(() => packNativeRequirementEvidence([{ properties }]), /already linked/i);
  assert.deepEqual(properties, original);
});
