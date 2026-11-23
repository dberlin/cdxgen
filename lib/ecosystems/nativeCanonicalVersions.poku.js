import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "poku";

import { buildBomNSData } from "../cli/bomAssembly.js";
import { nativeComponentInstanceRef, trimComponents } from "../inventory/depsUtils.js";

import { canonicalizeNativeComponents, enrichNativeConanRecipeIdentities } from "./nativeCanonicalVersions.js";

const repo = "https://github.com/nlohmann/json";
const sha256 = "4b92eb0c06d10683f7447ce9406cb97cd4b453be18d7279320f7b2f025c10187";
const prop = (name, value) => ({ name, value });
const values = (component, name) => (component.properties || []).filter((p) => p.name === name).map((p) => p.value);
const source = (version, directory, repository = repo, name = "nlohmann_json") => ({
  type: "library", name, version,
  purl: `pkg:generic/${name}@${version}?vcs_url=${encodeURIComponent(repository)}#${directory}`,
  "bom-ref": `${name}:${directory}:${version}`,
  properties: [prop("cdx:cmake:subprojectDir", directory), prop("cdx:version:kind", "declared-version")],
  evidence: { identity: [{ field: "purl", confidence: 0.8, methods: [{ technique: "source-code-analysis", confidence: 0.8, value: `${directory}/CMakeLists.txt:7` }] }] },
});
const languageOwner = (ecosystem, directory, tool, versionSource) => {
  const manifest = `${directory}/${ecosystem === "cargo" ? "Cargo.toml" : "pyproject.toml"}`;
  const purl = `pkg:${ecosystem}/widget@1.2.3`;
  const sourceInstance = createHash("sha256").update(manifest).digest("hex").slice(0, 24);
  const ref = `${purl}#native-source-${sourceInstance}`;
  return {
    type: "library", name: "widget", version: "1.2.3", purl, "bom-ref": ref,
    properties: [prop("SrcPath", manifest), prop("cdx:version:kind", "source-project"),
      prop("cdx:native:sourceInstance", sourceInstance),
      prop("cdx:version:source", versionSource || manifest),
      prop("cdx:build:requirement", JSON.stringify({ requestedName: tool, role: "tool",
        providerCandidates: [{ ref, selected: false, exports: [{ kind: "tool", name: tool }] }] }))],
  };
};
const tag = (version) => ({
  type: "library", name: "nlohmann_json", version,
  purl: `pkg:github/nlohmann/json@${version}`, "bom-ref": `tag:${version}`,
  properties: [prop("cdx:version:kind", "source-tag"), prop("cdx:cmake:gitRef", version)],
});

describe("canonical native package releases", () => {
  it("unions repeated owned sources and evidenced tag spellings, not different releases", () => {
    const a = source("3.12.0", "copy/a");
    const b = source("3.12.0", "copy/b");
    a.properties.push(prop("cdx:version:sourceRevision", "a".repeat(40)));
    b.properties.push(prop("cdx:version:sourceRevision", "b".repeat(40)));
    const input = [a, b, tag("v3.12.0"), source("3.11.3", "copy/c"), tag("v3.11.3"), source("3.7.3", "copy/d")];
    const result = canonicalizeNativeComponents(input, []);
    assert.equal(result.pkgList.length, 3);
    assert.deepEqual(result.pkgList.map((c) => c.version).sort(), ["3.11.3", "3.12.0", "3.7.3"]);
    const release = result.pkgList.find((c) => c.version === "3.12.0");
    assert.deepEqual(values(release, "cdx:cmake:subprojectDir").sort(), ["copy/a", "copy/b"]);
    assert.deepEqual(values(release, "cdx:version:sourceRevision").sort(), ["a".repeat(40), "b".repeat(40)]);
    const occurrences = values(release, "cdx:native:canonicalOccurrence").map(JSON.parse);
    assert.deepEqual(values(occurrences.find((c) => c.purl.endsWith("#copy/a")), "cdx:version:sourceRevision"), ["a".repeat(40)]);
    assert.deepEqual(values(occurrences.find((c) => c.purl.endsWith("#copy/b")), "cdx:version:sourceRevision"), ["b".repeat(40)]);
    assert.ok(values(release, "cdx:cmake:gitRef").includes("v3.12.0"));
    assert.equal(release.evidence.identity.length, 2);
    for (const c of input.slice(0, 3)) assert.equal(typeof result.remap.get(c["bom-ref"])?.[0], "string");
    assert.deepEqual(result.remap.get(a["bom-ref"]), result.remap.get("tag:v3.12.0"));
    assert.equal(input[2].version, "v3.12.0", "the caller's input is not mutated");
  });

  it("uses actual recipe distribution metadata to join Conan, GitHub and owned releases", () => {
    const conan = (version, hash) => ({
      type: "library", name: "nlohmann_json", version,
      purl: `pkg:conan/nlohmann_json@${version}`, "bom-ref": `conan:${version}`,
      externalReferences: [{ type: "distribution", url: `${repo}/archive/v${version}.tar.gz` }],
      hashes: [{ alg: "SHA-256", content: hash }],
    });
    const downloaded = tag("v3.12.0");
    downloaded.hashes = [{ alg: "SHA-256", content: sha256 }];
    const result = canonicalizeNativeComponents([
      conan("3.12.0", sha256), conan("3.7.3", "249548F4867417D66AE46B338DFE0A2805F3323E81C9E9B83C89F3ADBFDE6F31"),
      source("3.12.0", "a"), source("3.12.0", "b"), downloaded,
      source("3.11.3", "c"), tag("v3.11.3"),
    ], []);
    assert.deepEqual(result.pkgList.map((c) => c.version).sort(), ["3.11.3", "3.12.0", "3.7.3"]);
    assert.equal(result.pkgList.find((c) => c.version === "3.12.0").hashes.length, 1);
  });

  it("preserves requirement identities, nested candidate refs, every edge and parent refs", () => {
    const a = source("3.12.0", "a");
    const b = source("3.12.0", "b");
    a.properties.push(prop("cdx:cmake:sourceProjectRef", "pkg:generic/nlohmann_json@3.12.0#a"));
    const record = { id: "stable-requirement", file: "consumer/CMakeLists.txt", line: 12, ordinal: 4,
      requestedName: "nlohmann_json", constraints: ">=3.2", conditions: ["if(ENABLE_JSON)"],
      providerCandidates: [{ ref: a["bom-ref"], selected: false, sourceDir: "a" }, { ref: b["bom-ref"], selected: true, sourceDir: "b" }],
      bindings: [{ providerRefs: [a["bom-ref"], b["bom-ref"]], compatibility: "satisfied" }],
      sourceRefs: [a.purl],
    };
    a.properties.push(prop("cdx:build:requirement", JSON.stringify(record)));
    b.properties.push(prop("cdx:build:requirement", JSON.stringify({ ...record, id: "second-requirement" })));
    const parent = { name: "root", "bom-ref": "root", components: [a, b],
      properties: [prop("cdx:cmake:sourceProjectRef", b["bom-ref"])] };
    const dependencies = [
      { ref: "root", dependsOn: [a["bom-ref"], b["bom-ref"]], provides: [b["bom-ref"]] },
      { ref: a["bom-ref"], dependsOn: ["child-a"], provides: ["export-a"] },
      { ref: b["bom-ref"], dependsOn: ["child-b"], provides: ["export-b"], properties: [prop("condition", "WIN32")] },
    ];
    const result = canonicalizeNativeComponents([a, b], dependencies, parent);
    const ref = result.pkgList[0]["bom-ref"];
    assert.deepEqual(result.dependencies.find((d) => d.ref === "root").dependsOn, [ref]);
    assert.deepEqual(result.dependencies.find((d) => d.ref === ref).dependsOn, ["child-a", "child-b"]);
    assert.deepEqual(result.dependencies.find((d) => d.ref === ref).provides, ["export-a", "export-b"]);
    assert.equal(result.dependencies.find((d) => d.ref === ref).properties[0].value, "WIN32");
    const requirements = values(result.pkgList[0], "cdx:build:requirement").map(JSON.parse);
    assert.deepEqual(requirements.map((r) => r.id).sort(), ["second-requirement", "stable-requirement"]);
    assert.deepEqual(requirements[0].providerCandidates.map((c) => c.ref), [ref, ref]);
    assert.deepEqual(requirements[0].providerCandidates.map((c) => c.selected), [false, true]);
    assert.deepEqual(requirements[0].bindings[0].providerRefs, [ref]);
    assert.deepEqual(requirements[0].sourceRefs, [ref], "encoded purl aliases are remapped too");
    assert.deepEqual(requirements[0].conditions, ["if(ENABLE_JSON)"]);
    assert.equal(result.parentComponent.components.length, 1);
    assert.equal(values(result.parentComponent, "cdx:cmake:sourceProjectRef")[0], ref);
    assert.deepEqual(values(result.pkgList[0], "cdx:cmake:sourceProjectRef"), [ref]);
    assert.equal(result.remap.get("root"), undefined);
    assert.equal(result.remap.get("child-a"), undefined);
    assert.equal(record.providerCandidates[1].ref, b["bom-ref"]);
  });

  it("retains exact repeated JSON evidence unless live refs or duplicate live entries change", () => {
    const a = source("3.12.0", "a");
    const b = source("3.12.0", "b");
    const unchanged = ' { "ref": "opaque", "materials": [{"sha256":"same","url":"same"}] } ';
    const historical = JSON.stringify({ "bom-ref": b["bom-ref"] });
    const changed = ` {"bindings":[{"providerRefs":["${a["bom-ref"]}","${b["bom-ref"]}","external"]}],"note":"${b["bom-ref"]}"} `;
    const sharedProperties = [
      prop("cdx:evidence:json", unchanged), prop("cdx:evidence:json", unchanged),
      prop("cdx:build:requirement", changed), prop("cdx:native:canonicalOccurrence", historical),
      { name: "cdx:evidence:json", value: unchanged, extra: true },
    ];
    const consumer = { name: "consumer", "bom-ref": "consumer", properties: sharedProperties };
    const unknown = { name: "unknown", "bom-ref": "unknown", properties: sharedProperties };
    const result = canonicalizeNativeComponents([a, b, consumer, unknown],
      [{ ref: "consumer", dependsOn: [a["bom-ref"], b["bom-ref"], "external", "external"] }]);
    const ref = result.pkgList.find((component) => component.name === "nlohmann_json")["bom-ref"];
    const rewritten = result.pkgList.find((component) => component.name === "consumer").properties;
    assert.deepEqual(rewritten, [
      prop("cdx:evidence:json", unchanged),
      prop("cdx:build:requirement", JSON.stringify({ bindings: [{ providerRefs: [ref, "external"] }], note: b["bom-ref"] })),
      prop("cdx:native:canonicalOccurrence", historical),
      { name: "cdx:evidence:json", value: unchanged, extra: true },
    ]);
    assert.deepEqual(result.pkgList.find((component) => component.name === "unknown").properties, rewritten);
    assert.deepEqual(result.dependencies[0].dependsOn, [ref, "external"]);
    assert.equal(sharedProperties[2].value, changed);
  });

  it("keeps repeated serialized evidence local to a canonical ref map", () => {
    const a = source("3.12.0", "a");
    const b = source("3.12.0", "b");
    a["bom-ref"] = b["bom-ref"] = "shared";
    b.properties.push(prop("cdx:source:dirty", "true"));
    const notes = "retained provenance".repeat(256);
    const evidence = ` { "providerCandidates": [{"ref":"shared","selected":false}], "notes": "${notes}" } `;
    const unchanged = ` { "ref": "elsewhere", "notes": "${notes}" } `;
    const malformed = ` { "notes": "${notes}",`;
    const holders = ["first", "second"].map((ref) => ({
      name: ref, "bom-ref": ref,
      properties: [prop("cdx:build:requirement", evidence), prop("cdx:evidence:json", unchanged),
        prop("cdx:evidence:json", malformed), prop("cdx:native:canonicalOccurrence", evidence)],
    }));
    const edges = [{ ref: "first", dependsOn: ["shared"] }];
    const ambiguous = canonicalizeNativeComponents([a, b, ...holders], edges);
    const refs = ambiguous.remap.get("shared");
    assert.equal(refs.length, 2);
    assert.deepEqual(ambiguous.dependencies[0].dependsOn, refs);
    const expected = JSON.stringify({ providerCandidates: refs.map((ref) => ({ ref, selected: false })), notes });
    for (const holder of ambiguous.pkgList.slice(2)) {
      assert.deepEqual(holder.properties.map((property) => property.value), [expected, unchanged, malformed, evidence]);
    }
    const unambiguous = canonicalizeNativeComponents([a, ...holders], edges);
    for (const holder of unambiguous.pkgList.slice(1)) {
      assert.deepEqual(holder.properties.map((property) => property.value), [evidence, unchanged, malformed, evidence]);
    }
    assert.equal(holders[0].properties[0].value, evidence);
  });

  it("expands a shared incoming ref rather than dropping a divergent artifact or its edges", () => {
    const a = source("3.12.0", "a");
    const b = source("3.12.0", "b");
    a["bom-ref"] = b["bom-ref"] = "shared";
    b.properties.push(prop("cdx:source:dirty", "true"));
    const consumer = { name: "consumer", "bom-ref": "consumer", properties: [prop("cdx:build:requirement", JSON.stringify({
      id: "ambiguous-input-ref", providerCandidates: [{ ref: "shared", selected: false }],
    }))] };
    const result = canonicalizeNativeComponents([a, b, consumer], [
      { ref: "consumer", dependsOn: ["shared"] }, { ref: "shared", dependsOn: ["child"] },
    ], { name: "root", "bom-ref": "root", components: [a, b] });
    const variants = result.pkgList.filter((c) => c.name === "nlohmann_json").map((c) => c["bom-ref"]);
    assert.equal(new Set(variants).size, 2);
    assert.deepEqual(result.remap.get("shared"), variants);
    assert.deepEqual(result.dependencies.find((d) => d.ref === "consumer").dependsOn, variants);
    for (const ref of variants) assert.deepEqual(result.dependencies.find((d) => d.ref === ref).dependsOn, ["child"]);
    const record = JSON.parse(values(result.pkgList.find((c) => c.name === "consumer"), "cdx:build:requirement")[0]);
    assert.deepEqual(record.providerCandidates.map((c) => c.ref), variants);
    assert.equal(result.parentComponent.components.length, 2);
  });

  it("retains repeated patched/hash-divergent artifacts through CLI trim and strict BOM hierarchy assembly", () => {
    for (const divergence of ["patches", "hashes"]) {
      const input = ["clean/a", "clean/b", "other/a", "other/b"].map((dir) => source("3.12.0", dir));
      for (const [index, component] of input.entries()) {
        if (divergence === "patches" && index > 1) component.pedigree = {
          patches: [{ type: "unofficial", diff: { url: "https://example.test/fix.patch" } }],
        };
        if (divergence === "hashes") component.hashes = [{ alg: "SHA-256", content: (index < 2 ? "1" : "2").repeat(64) }];
      }
      input[0].properties.push(prop("cdx:build:requirement", JSON.stringify({ id: "artifact-consumer",
        providerCandidates: input.map((component) => ({ ref: component["bom-ref"], selected: false })) })));
      const parent = { name: "artifact-root", version: "1.0.0", type: "application", "bom-ref": "application:artifact-root:1.0.0" };
      const out = canonicalizeNativeComponents(input, [
        { ref: parent["bom-ref"], dependsOn: input.map((component) => component["bom-ref"]) },
        ...input.map((component) => ({ ref: component["bom-ref"], dependsOn: [] })),
      ], parent);
      assert.equal(out.pkgList.length, 2);
      assert.equal(new Set(out.pkgList.map((component) => component.purl)).size, 1, "artifacts still share real upstream package coordinates");
      for (const component of out.pkgList) assert.equal(nativeComponentInstanceRef(component), component["bom-ref"]);
      const discarded = new Map();
      const trimmed = trimComponents(out.pkgList, discarded);
      assert.equal(trimmed.length, 2);
      assert.equal(discarded.size, 0);
      const { bomJson } = buildBomNSData({ specVersion: 1.7 }, trimmed, "generic", {
        src: ".", parentComponent: { ...out.parentComponent, components: structuredClone(trimmed) }, dependencies: out.dependencies,
      });
      const declared = new Map();
      const visit = (component) => {
        if (component.name === "nlohmann_json") declared.set(component["bom-ref"], component);
        for (const child of component.components || []) visit(child);
      };
      for (const component of bomJson.components || []) visit(component);
      visit(bomJson.metadata.component);
      assert.equal(declared.size, 2);
      const graph = bomJson.dependencies.find((entry) => entry.ref === parent["bom-ref"]);
      assert.deepEqual([...graph.dependsOn].sort(), [...declared.keys()].sort());
      for (const component of declared.values()) for (const record of values(component, "cdx:build:requirement").map(JSON.parse)) {
        assert.ok(record.providerCandidates.every((candidate) => declared.has(candidate.ref)));
      }
    }
  });

  it("keeps three dimension-only artifacts sharing one incoming ref unique throughout graph and parent rewriting", () => {
    const input = ["x86_64", "aarch64", "ppc64le"].map((arch) => {
      const component = source("3.12.0", `platform/${arch}`);
      component.purl = component.purl.replace("#", `&arch=${arch}#`);
      component["bom-ref"] = "shared";
      return component;
    });
    const parent = { name: "root", type: "application", version: "1", "bom-ref": "root", components: input };
    const out = canonicalizeNativeComponents(input, [{ ref: "root", dependsOn: ["shared"] }, { ref: "shared", dependsOn: [] }], parent);
    const refs = out.pkgList.map((component) => component["bom-ref"]);
    assert.equal(new Set(refs).size, 3);
    assert.deepEqual(out.remap.get("shared"), refs);
    assert.deepEqual(out.dependencies.find((entry) => entry.ref === "root").dependsOn, refs);
    assert.equal(out.parentComponent.components.length, 3);
    assert.equal(trimComponents(out.pkgList).length, 3);
    for (const ref of refs) assert.ok(out.dependencies.some((entry) => entry.ref === ref));
  });

  it("keeps same-version source tools in each owning language manifest and graph", () => {
    for (const ecosystem of ["cargo", "pypi"]) {
      const a = languageOwner(ecosystem, "/source/workspace/a", "tool-a",
        ecosystem === "cargo" ? "/source/workspace/Cargo.toml" : undefined);
      const b = languageOwner(ecosystem, "/source/b", "tool-b");
      const result = canonicalizeNativeComponents([a, b], [
        { ref: "consumer-a", dependsOn: [a["bom-ref"]] },
        { ref: "consumer-b", dependsOn: [b["bom-ref"]] },
        { ref: a["bom-ref"], dependsOn: ["helper-a"] },
        { ref: b["bom-ref"], dependsOn: ["helper-b"] },
      ]);
      assert.equal(result.pkgList.length, 2);
      assert.equal(trimComponents(structuredClone(result.pkgList)).length, 2);
      for (const [index, letter] of ["a", "b"].entries()) {
        const component = result.pkgList[index];
        const ref = component["bom-ref"];
        assert.equal(component.purl, a.purl);
        assert.equal(nativeComponentInstanceRef(component), ref);
        const [requirement] = values(component, "cdx:build:requirement").map(JSON.parse);
        assert.equal(requirement.requestedName, `tool-${letter}`);
        assert.deepEqual(requirement.providerCandidates, [{ ref, selected: false, exports: [{ kind: "tool", name: `tool-${letter}` }] }]);
        assert.deepEqual(result.dependencies.find((edge) => edge.ref === `consumer-${letter}`).dependsOn, [ref]);
        assert.deepEqual(result.dependencies.find((edge) => edge.ref === ref).dependsOn, [`helper-${letter}`]);
      }
      const repeated = canonicalizeNativeComponents(result.pkgList, result.dependencies);
      assert.deepEqual(repeated.pkgList, result.pkgList);
      assert.deepEqual(repeated.dependencies, result.dependencies);
      assert.equal(repeated.remap.size, 0);
    }
  });

  it("does not treat an exact wheel coordinate as a source-tool alias", () => {
    const source = languageOwner("pypi", "/source/python", "tool-source");
    source.externalReferences = [{ type: "vcs", url: "https://github.com/example/widget" }];
    const sameOwner = languageOwner("pypi", "/source/python", "tool-repeat");
    sameOwner.externalReferences = source.externalReferences;
    const wheel = { type: "library", name: source.name, version: source.version, purl: source.purl, "bom-ref": source.purl,
      hashes: [{ alg: "SHA-256", content: "a".repeat(64) }],
      externalReferences: [{ type: "vcs", url: "https://github.com/example/widget" }] };
    const result = canonicalizeNativeComponents([source, sameOwner, wheel], [
      { ref: "source-consumer", dependsOn: [source["bom-ref"]] },
      { ref: "wheel-consumer", dependsOn: [wheel["bom-ref"]] },
      { ref: wheel["bom-ref"], dependsOn: ["wheel-runtime"] },
    ]);
    assert.equal(result.pkgList.length, 2, "a repeated manifest merges, but a wheel remains separate");
    assert.deepEqual(result.pkgList.map((component) => component.purl), [source.purl, wheel.purl]);
    const [owner, wheelOutput] = result.pkgList;
    assert.equal(wheelOutput["bom-ref"], wheel.purl);
    assert.equal(owner.hashes, undefined);
    assert.equal(values(owner, "cdx:build:requirement").length, 2);
    assert.deepEqual(result.dependencies, [
      { ref: "source-consumer", dependsOn: [owner["bom-ref"]] },
      { ref: "wheel-consumer", dependsOn: [wheel.purl] },
      { ref: wheel.purl, dependsOn: ["wheel-runtime"] },
    ]);
    assert.deepEqual(canonicalizeNativeComponents(result.pkgList, result.dependencies).pkgList, result.pkgList);
    assert.equal(trimComponents([structuredClone(owner), wheel]).length, 2);
  });

  it("does not promote unrelated or mismatched source-looking refs to manifest identity", () => {
    const real = languageOwner("pypi", "/source/real", "tool-real");
    const arbitrary = { ...structuredClone(real), "bom-ref": "elsewhere#native-source-" + real["bom-ref"].split("-").at(-1) };
    const unrelated = "pkg:generic/widget@1.2.3";
    real.properties.push(prop("cdx:cmake:sourceProjectRef", unrelated));
    const mismatched = languageOwner("pypi", "/source/unrelated", "tool-arbitrary");
    mismatched.properties[0] = prop("SrcPath", "/source/real/pyproject.toml");
    const registry = { type: "library", name: real.name, version: real.version, purl: real.purl, "bom-ref": real.purl };
    const result = canonicalizeNativeComponents([arbitrary, mismatched, registry, real], [{ ref: "consumer", dependsOn: [unrelated] }]);
    assert.equal(result.pkgList.length, 2);
    const owner = result.pkgList.find((component) => nativeComponentInstanceRef(component));
    assert.deepEqual(values(owner, "cdx:build:requirement").map((value) => JSON.parse(value).requestedName), ["tool-real"]);
    assert.deepEqual(result.remap.get(arbitrary["bom-ref"]), [registry["bom-ref"]]);
    assert.deepEqual(result.remap.get(mismatched["bom-ref"]), [registry["bom-ref"]]);
    assert.equal(result.remap.has(unrelated), false);
    assert.deepEqual(result.dependencies, [{ ref: "consumer", dependsOn: [unrelated] }]);
  });

  it("never joins unrelated generic sources, forks or repository subpackages by name/version", () => {
    const generic = (ref, dir) => ({ name: "utility", version: "1.0", purl: "pkg:generic/utility@1.0", "bom-ref": ref,
      properties: [prop("cdx:cmake:sourceDir", dir)] });
    const subpackage = source("3.12.0", "real-subpackage");
    subpackage.properties = [];
    const result = canonicalizeNativeComponents([
      generic("generic-a", "one"), generic("generic-b", "two"),
      source("3.12.0", "a"), source("3.12.0", "b", "https://github.com/fork/json"), subpackage,
    ], []);
    assert.equal(result.pkgList.length, 5);
    const repeated = canonicalizeNativeComponents(result.pkgList, result.dependencies);
    assert.deepEqual(repeated.pkgList, result.pkgList, "validated local artifact refs remain stable on another pass");
  });

  it("consolidates case aliases of the exact same CMake source archive without erasing other archives or patched bytes", () => {
    const url = "https://example.org/lib-1.2.3.tar.gz";
    const archive = (name, index, sourceUrl = url) => {
      const ref = `archive-${index}`;
      return { name, version: "1.2.3", purl: `pkg:generic/${name}@1.2.3?download_url=${encodeURIComponent(sourceUrl)}`,
        "bom-ref": ref, externalReferences: [{ type: "distribution", url: sourceUrl }], properties: [
          prop("cdx:cmake:depKind", "fetch"), prop("cdx:cmake:resolvedVia", "cmake-lists"),
          prop("cdx:build:requirement", JSON.stringify({ id: `declaration-${index}`, requestedName: name,
            role: "source-declaration", providerCandidates: [{ ref, selected: false }] })),
        ] };
    };
    for (const names of [["Example", "example"], ["example", "Example"]]) {
      const input = names.map((name, index) => archive(name, index));
      const out = canonicalizeNativeComponents(input, [{ ref: "root", dependsOn: input.map((component) => component["bom-ref"]) }]);
      assert.equal(out.pkgList.length, 1);
      assert.equal(out.pkgList[0].name, names[0], "the established first declaration owns the display spelling");
      assert.deepEqual(out.dependencies[0].dependsOn, [out.pkgList[0]["bom-ref"]]);
      const declarations = values(out.pkgList[0], "cdx:build:requirement").map(JSON.parse);
      assert.deepEqual(declarations.map((record) => record.requestedName), names);
      assert.ok(declarations.every((record) => record.providerCandidates[0].ref === out.pkgList[0]["bom-ref"]));
      assert.equal(trimComponents(out.pkgList).length, 1);
      assert.deepEqual(canonicalizeNativeComponents(out.pkgList, out.dependencies).pkgList, out.pkgList);
    }
    assert.equal(canonicalizeNativeComponents([archive("Example", 0), archive("example", 1, "https://other.test/lib-1.2.3.tar.gz")], []).pkgList.length, 2);
    assert.equal(canonicalizeNativeComponents([archive("alpha", 0), archive("beta", 1)], []).pkgList.length, 2);
    const divergent = [archive("Example", 0), archive("example", 1)];
    divergent[0].hashes = [{ alg: "SHA-256", content: "1".repeat(64) }];
    divergent[1].hashes = [{ alg: "SHA-256", content: "2".repeat(64) }];
    const kept = canonicalizeNativeComponents(divergent, []);
    assert.equal(kept.pkgList.length, 2);
    assert.equal(trimComponents(kept.pkgList).length, 2);
  });

  it("uses owned package/export identity to join repository names without crossing fork or monorepo scope", () => {
    const owned = source("3.12.0", "owned", repo, "json");
    owned.properties.push(prop("cdx:native:packageIdentity", JSON.stringify({ schema: 1, name: "nlohmann_json",
      source: "owned/CMakeLists.txt:7", exportSource: "owned/CMakeLists.txt:184", repository: repo })));
    const repeated = source("3.12.0", "repeated", repo, "json");
    const fork = source("3.12.0", "fork", "https://github.com/other/json", "json");
    const result = canonicalizeNativeComponents([owned, repeated, tag("v3.12.0"), fork], []);
    assert.equal(result.pkgList.length, 2);
    const release = result.pkgList.find((component) => values(component, "cdx:native:packageIdentity").length);
    assert.equal(JSON.parse(JSON.parse(values(release, "cdx:native:canonicalRelease")[0]).package).name, "nlohmann_json");
    assert.ok(values(release, "cdx:cmake:gitRef").includes("v3.12.0"));
    const ownedProject = (directory, name) => {
      const component = source("3.12.0", directory, repo, "json");
      component.properties.push(prop("cdx:native:packageIdentity", JSON.stringify({ schema: 1, name,
        source: `${directory}/CMakeLists.txt:1`, exportSource: `${directory}/CMakeLists.txt:8`, repository: repo })));
      return component;
    };
    assert.equal(canonicalizeNativeComponents([ownedProject("one", "package_a"), ownedProject("two", "package_b"),
      source("3.12.0", "unknown", repo, "json")], []).pkgList.length, 3);
  });

  it("requires upstream evidence before joining a Conan package to a same-name source", () => {
    const conan = { name: "private_json", version: "3.12.0", purl: "pkg:conan/private_json@3.12.0", "bom-ref": "conan-private" };
    const owned = source("3.12.0", "private", repo, "private_json");
    const result = canonicalizeNativeComponents([conan, owned], []);
    assert.equal(result.pkgList.length, 2);
  });

  it("retains evidenced patches, dirty contents, platform qualifiers and conflicting artifact hashes", () => {
    const clean = source("3.12.0", "clean");
    const patched = source("3.12.0", "patched");
    patched.pedigree = { patches: [{ type: "unofficial", diff: { url: "https://example.test/fix.patch" } }] };
    const dirty = source("3.12.0", "dirty");
    dirty.properties.push(prop("cdx:source:dirty", "true"));
    const linux = source("3.12.0", "linux");
    linux.purl = linux.purl.replace("#", "&arch=x86_64&os=linux#");
    const windows = source("3.12.0", "windows");
    windows.purl = windows.purl.replace("#", "&arch=x86_64&os=windows#");
    const first = source("3.12.0", "archive-1");
    first.hashes = [{ alg: "SHA-256", content: "1".repeat(64) }];
    const second = source("3.12.0", "archive-2");
    second.hashes = [{ alg: "SHA-256", content: "2".repeat(64) }];
    const result = canonicalizeNativeComponents([clean, patched, dirty, linux, windows, first, second], []);
    assert.equal(result.pkgList.length, 7);
    assert.equal(new Set(result.pkgList.map((c) => c["bom-ref"])).size, 7);
    assert.notEqual(result.pkgList.find((c) => values(c, "cdx:cmake:subprojectDir").includes("archive-1"))["bom-ref"],
      result.pkgList.find((c) => values(c, "cdx:cmake:subprojectDir").includes("archive-2"))["bom-ref"]);
  });

  it("retains platform artifacts while counting their common release only once", () => {
    const linux = source("3.12.0", "linux");
    linux.purl = linux.purl.replace("#", "&arch=x86_64&os=linux#");
    const windows = source("3.12.0", "windows");
    windows.purl = windows.purl.replace("#", "&arch=x86_64&os=windows#");
    const result = canonicalizeNativeComponents([linux, windows], []);
    assert.equal(result.pkgList.length, 2);
    assert.equal(new Set(result.pkgList.flatMap((c) => values(c, "cdx:native:canonicalRelease"))).size, 1);
  });

  it("keeps distinct release assets separate even when their platform is not in a purl qualifier", () => {
    const asset = (name) => ({ name: "nlohmann_json", version: "3.12.0", "bom-ref": name,
      purl: `pkg:generic/nlohmann_json@3.12.0#${name}`,
      properties: [prop("cdx:cmake:sourceDir", name)],
      externalReferences: [{ type: "distribution", url: `${repo}/releases/download/v3.12.0/${name}.tar.gz` }],
    });
    const result = canonicalizeNativeComponents([asset("linux"), asset("windows"), source("3.12.0", "source")], []);
    assert.equal(result.pkgList.length, 3);
    assert.equal(new Set(result.pkgList.flatMap((c) => values(c, "cdx:native:canonicalRelease"))).size, 1);
  });

  const archiveRepository = "https://github.com/example/vector";
  const upstreamArchive = `${archiveRepository}/releases/download/v1.2.3/source.tar.xz`;
  const mirrorArchive = "https://some-mirror.test/vector-1.2.3.tar.gz";
  const archiveDigest = "1".repeat(64);
  const ownedArchive = (url, upstream = false) => {
    const name = upstream ? "vector" : "build-vector-sources";
    const purl = upstream ? "pkg:github/example/vector" : `pkg:generic/${name}`;
    const version = upstream ? "v1.2.3" : "1.2.3";
    return {
      type: "library", name, version, "bom-ref": name,
      purl: `${purl}@${version}?download_url=${encodeURIComponent(url)}`,
      externalReferences: [{ type: "distribution", url }, { type: "vcs", url: archiveRepository }],
      properties: [prop("cdx:cmake:depKind", "fetch"), prop("cdx:native:archiveIdentityEvidence", JSON.stringify({
        url, archive: { sha256: archiveDigest, bytes: 120, path: `archive-artifacts/${archiveDigest}.archive` },
        observedAt: "2026-01-01T00:00:00.000Z",
        fields: [
          { field: "project.name", value: "VectorLib" }, { field: "project.version", value: "1.2.3" },
          { field: "header.version", value: "1.2.3" }, { field: "repository", value: archiveRepository },
        ],
      }))],
    };
  };

  it("joins differently named archive declarations only when the exact source bytes are evidenced on both URLs", () => {
    const mirror = ownedArchive(mirrorArchive);
    mirror.hashes = [{ alg: "SHA-256", content: archiveDigest }];
    const upstream = ownedArchive(upstreamArchive, true);
    const input = [mirror, upstream];
    const edges = [{ ref: "root", dependsOn: input.map((c) => c["bom-ref"]) }];
    const result = canonicalizeNativeComponents(input, edges);
    assert.equal(result.pkgList.length, 1);
    const [artifact] = result.pkgList;
    assert.equal(artifact.name, "vector");
    assert.equal(artifact.version, "1.2.3");
    assert.deepEqual(artifact.hashes, mirror.hashes);
    assert.deepEqual(new Set(artifact.externalReferences.filter((ref) => ref.type === "distribution").map((ref) => ref.url)),
      new Set([mirrorArchive, upstreamArchive]));
    assert.equal(values(artifact, "cdx:native:canonicalOccurrence").length, 2);
    assert.deepEqual(result.dependencies[0].dependsOn, [artifact["bom-ref"]]);
    assert.deepEqual(canonicalizeNativeComponents(result.pkgList, result.dependencies).pkgList, result.pkgList);
    assert.deepEqual(canonicalizeNativeComponents(input.toReversed(), edges).pkgList[0], artifact);
  });

  it("keeps different release assets, misbound evidence, and variants of matching archive bytes separate", () => {
    const upstream = ownedArchive(upstreamArchive, true);
    for (const [reason, change] of [
      ["no byte evidence", (c) => c.properties.pop()],
      ["evidence for the wrong URL", (_c, proof) => { proof.url = upstreamArchive; }],
      ["different archive bytes", (_c, proof) => { proof.archive.sha256 = "2".repeat(64); }],
      ["conflicting declared hash", (c) => { c.hashes = [{ alg: "SHA-256", content: "2".repeat(64) }]; }],
      ["unverified non-SHA-256 pin", (c) => { c.hashes = [{ alg: "SHA-512", content: "2".repeat(128) }]; }],
      ["unverified second URL", (c) => c.externalReferences.push({ type: "distribution", url: `${archiveRepository}/releases/download/v1.2.3/other.tar.xz` })],
      ["different repository", (c) => { c.externalReferences[1].url = `${archiveRepository}-fork`; }],
      ["different platform", (c) => { c.purl += "&arch=aarch64"; }],
      ["patched source", (c) => { c.properties.unshift(prop("cdx:source:dirty", "true")); }],
    ]) {
      const mirror = ownedArchive(mirrorArchive);
      const evidence = mirror.properties.at(-1);
      const proof = JSON.parse(evidence.value);
      change(mirror, proof);
      evidence.value = JSON.stringify(proof);
      assert.equal(canonicalizeNativeComponents([mirror, upstream]).pkgList.length, 2, reason);
    }
  });

  it("does not normalize arbitrary v-prefixed identifiers or source revisions into releases", () => {
    const custom = source("vbuild42", "custom");
    const numeric = source("v1.2.3", "numeric");
    const revision = source("a".repeat(40), "revision");
    revision.properties.push(prop("cdx:version:kind", "source-revision"));
    const plain = source("1.2.3", "plain");
    const result = canonicalizeNativeComponents([custom, numeric, revision, plain], []);
    assert.equal(result.pkgList.length, 4);
    assert.ok(result.pkgList.some((c) => c.version === "v1.2.3"));
    assert.ok(result.pkgList.some((c) => c.version === "vbuild42"));
  });

  it("preserves malformed metadata and every scalar/array provenance value without mutating input", () => {
    const a = source("3.12.0", "a");
    const b = source("3.12.0", "b");
    a.description = "first description";
    b.description = "second description";
    b.properties.push(prop("cdx:build:requirement", "{invalid JSON"));
    a.licenses = [{ license: { id: "MIT" } }];
    b.licenses = [{ license: { id: "BSD-3-Clause" } }];
    const result = canonicalizeNativeComponents([a, b], []);
    assert.equal(result.pkgList[0].licenses.length, 2);
    assert.ok(values(result.pkgList[0], "cdx:build:requirement").includes("{invalid JSON"));
    const occurrences = values(result.pkgList[0], "cdx:native:canonicalOccurrence").map(JSON.parse);
    assert.deepEqual(occurrences.map((c) => c.description).sort(), ["first description", "second description"]);
    const twice = canonicalizeNativeComponents(result.pkgList, result.dependencies);
    assert.deepEqual(twice.pkgList, result.pkgList);
    assert.deepEqual(twice.dependencies, result.dependencies);
  });

  it("preserves canonical refs and nested provenance across large repeated requirements", () => {
    const a = source("3.12.0", "a");
    const b = source("3.12.0", "b");
    const requirement = prop("cdx:build:requirement", JSON.stringify({
      providerCandidates: [{ ref: a["bom-ref"] }, { ref: b["bom-ref"] }],
      detail: "x".repeat(8192),
    }));
    a.properties.push(requirement);
    b.properties.push(requirement);
    b.components = [{ name: "internal", "bom-ref": "internal", properties: [requirement] }];
    const parent = { name: "root", "bom-ref": "root", components: [a, b], properties: [requirement] };
    const dependencies = [{ ref: "root", dependsOn: [a["bom-ref"], b["bom-ref"]] }];
    const [canonical] = canonicalizeNativeComponents([a, b], dependencies, parent).pkgList;
    assert.equal(canonical.version, "3.12.0");
    assert.deepEqual(values(canonical, requirement.name).map((value) => JSON.parse(value).providerCandidates),
      [[{ ref: canonical["bom-ref"] }, { ref: canonical["bom-ref"] }]]);
    assert.ok(values(canonical, "cdx:native:canonicalOccurrence").map(JSON.parse)
      .some((occurrence) => occurrence.components?.[0]?.properties[0].value === requirement.value));
  });

  it("preserves shared live and historical child requirements without changing identity", () => {
    const release = () => ({ type: "library", name: "widget", version: "1.0.0",
      purl: "pkg:conan/widget@1.0.0", "bom-ref": "shared" });
    const requirement = prop("cdx:build:requirement", "{}");
    const child = () => ({ type: "library", name: "helper", "bom-ref": "helper", properties: [{ ...requirement }] });
    const a = release();
    const b = release();
    const live = child();
    a.components = [live];
    a.pedigree = { ancestors: [live] };
    b.pedigree = { ancestors: [child()] };
    const result = canonicalizeNativeComponents([a, b], [{ ref: "consumer", dependsOn: ["shared"] }]);
    assert.equal(result.pkgList.length, 1);
    const [canonical] = result.pkgList;
    assert.deepEqual(result.remap.get("shared") || ["shared"], [canonical["bom-ref"]]);
    assert.deepEqual(result.dependencies[0].dependsOn, [canonical["bom-ref"]]);
    assert.deepEqual(live.properties, [requirement]);
    const [snapshot] = values(canonical, "cdx:native:canonicalOccurrence").map(JSON.parse);
    assert.deepEqual(snapshot.pedigree.ancestors[0].properties, [requirement]);
  });

  it("deduplicates equal nested requirements regardless of wrapper field order", () => {
    const a = source("3.12.0", "a");
    const b = source("3.12.0", "b");
    const name = "cdx:build:requirement";
    a.components = [{ type: "library", name: "helper", properties: [prop(name, "{}")] }];
    b.components = [{ type: "library", name: "helper", properties: [{ value: "{}", name }] }];
    const [canonical] = canonicalizeNativeComponents([a, b]).pkgList;
    assert.equal(canonical.components.length, 1);
    assert.deepEqual(Object.keys(canonical.components[0].properties[0]), ["value", "name"]);
  });

  it("leaves unresolved and versionless records visible without unnecessary identity mappings", () => {
    const unresolved = { name: "missing", "bom-ref": "missing", properties: [prop("cdx:build:requirement", JSON.stringify({ id: "missing-call", providerCandidates: [] }))] };
    const result = canonicalizeNativeComponents([unresolved], [{ ref: "root", dependsOn: ["missing"] }]);
    assert.equal(result.pkgList.length, 1);
    assert.equal(result.pkgList[0].version, undefined);
    assert.equal(result.remap.size, 0);
    assert.deepEqual(result.dependencies[0].dependsOn, ["missing"]);
  });

  it("keeps unresolved occurrences mergeable by ordinary downstream requirement deduplication", () => {
    for (const names of [["missing", "missing"], ["Missing", "missing"]]) {
      const input = names.map((name, index) => ({ name, purl: `pkg:generic/${name}`, "bom-ref": `requirement-${index}`,
        properties: [prop("cdx:build:requirement", JSON.stringify({ id: `call-${index}`, file: `consumer-${index}/meson.build`,
          providerCandidates: [{ name: `provider-${index}`, selected: false }] }))] }));
      const out = canonicalizeNativeComponents(input, []);
      assert.ok(out.pkgList.every((component) => nativeComponentInstanceRef(component) === undefined));
      assert.ok(out.pkgList.every((component) => values(component, "cdx:native:canonicalArtifact").length === 0));
      const trimmed = trimComponents(out.pkgList);
      assert.equal(trimmed.length, 1);
      assert.equal(trimmed[0].version, undefined);
      assert.equal(values(trimmed[0], "cdx:native:canonicalRelease").length, 0);
      const records = values(trimmed[0], "cdx:build:requirement").map(JSON.parse);
      assert.deepEqual(records.map((record) => record.id).sort(), ["call-0", "call-1"]);
      assert.deepEqual(records.map((record) => record.providerCandidates[0].name).sort(), ["provider-0", "provider-1"]);
    }
  });

  it("consolidates files owned by the same exact installed package, not borrowed consumer sources", () => {
    const installed = (file, arch = "x86_64", packageManager = "rpm") => ({
      name: "glibc", version: "2.43-9.fc44", purl: "pkg:generic/glibc@2.43-9.fc44",
      "bom-ref": `installed:${file}:${arch}:${packageManager}`,
      properties: [
        prop("cdx:native:providerIdentity", `identity-${file}`),
        prop("cdx:cmake:sourceDir", `consumer/${file}`),
        prop("cdx:native:providerEvidence", JSON.stringify({ kind: "installed-package-file", packageManager,
          packageName: "glibc", name: "glibc", version: "2.43-9.fc44", arch, platform: "linux",
          providedFilePath: `/usr/lib64/${file}`, libraryPath: `/usr/lib64/${file}` })),
      ],
    });
    const a = installed("libpthread.so");
    const b = installed("libdl.so");
    const arm = installed("libpthread.so", "aarch64");
    const result = canonicalizeNativeComponents([a, b, arm], []);
    assert.equal(result.pkgList.length, 2);
    const joined = result.pkgList.find((c) => values(c, "cdx:native:providerEvidence").length === 2);
    assert.deepEqual(values(joined, "cdx:native:providerEvidence").map(JSON.parse).map((p) => p.providedFilePath).sort(),
      ["/usr/lib64/libdl.so", "/usr/lib64/libpthread.so"]);
    assert.equal(values(joined, "cdx:native:providerIdentity").length, 2);
    assert.deepEqual(result.remap.get(a["bom-ref"]) || [a["bom-ref"]], result.remap.get(b["bom-ref"]) || [b["bom-ref"]]);
    assert.equal(new Set(result.pkgList.flatMap((c) => values(c, "cdx:native:canonicalRelease"))).size, 1);
    assert.equal(canonicalizeNativeComponents([a, installed("libdl.so", "x86_64", "dpkg")], []).pkgList.length, 2);
  });

  it("coalesces byte-identical signed Debian sightings, not different artifacts of one release", () => {
    const purl = "pkg:generic/signed-tools@1.2.3";
    const owner = (id, tool, sha256, suite) => {
      const exports = [{ kind: "tool", name: tool, file: `/usr/bin/${tool}` }];
      return {
        name: "signed-tools", version: "1.2.3", purl, "bom-ref": id,
        properties: [
          prop("cdx:native:providerEvidence", JSON.stringify({ kind: "package-manifest", packageManager: "dpkg",
            packageName: "signed-tools", version: "1.2.3", arch: "x64", platform: "linux", exports,
            ...(suite ? { packageFilename: "pool/main/s/signed-tools/signed-tools_1.2.3_amd64.deb", packageSha256: sha256,
              repositoryEvidence: { release: `https://example.org/dists/${suite}/InRelease`, releaseSha256: "c".repeat(64) } } : {}) })),
          prop("cdx:native:providerExports", JSON.stringify(exports)),
        ],
      };
    };
    const a = owner("signed-a", "first", "a".repeat(64), "one");
    const repeatedA = owner("signed-a-again", "second", "a".repeat(64), "two");
    const b = owner("signed-b", "different", "b".repeat(64), "two");
    const metadata = owner("metadata-only", "observed", undefined, undefined);
    const edges = [{ ref: "first-consumer", dependsOn: [a["bom-ref"], repeatedA["bom-ref"]] },
      { ref: "second-consumer", dependsOn: [b["bom-ref"]] }, { ref: "third-consumer", dependsOn: [metadata["bom-ref"]] }];
    const result = canonicalizeNativeComponents([a, repeatedA, b, metadata], edges);
    const { pkgList } = result;
    assert.equal(pkgList.length, 3);
    assert.equal(trimComponents(pkgList).length, 3);
    assert.equal(new Set(pkgList.map((component) => nativeComponentInstanceRef(component)).filter(Boolean)).size, 3);
    assert.equal(new Set(pkgList.flatMap((component) => values(component, "cdx:native:canonicalRelease"))).size, 1);
    const component = (consumer) => {
      const { dependsOn } = result.dependencies.find(({ ref }) => ref === consumer);
      assert.equal(dependsOn.length, 1);
      return pkgList.find((entry) => entry["bom-ref"] === dependsOn[0]);
    };
    const tools = (entry) => values(entry, "cdx:native:providerExports").flatMap(JSON.parse).map(({ name }) => name).sort();
    assert.deepEqual(tools(component("first-consumer")), ["first", "second"]);
    assert.deepEqual(tools(component("second-consumer")), ["different"]);
    assert.deepEqual(tools(component("third-consumer")), ["observed"]);
    assert.equal(values(component("first-consumer"), "cdx:native:providerEvidence").length, 2);
  });

  it("retains recipe revisions as artifact provenance without counting extra upstream releases", () => {
    const recipe = (portVersion) => ({ name: "fixture", version: "1.2.3",
      purl: "pkg:generic/fixture@1.2.3", "bom-ref": `vcpkg:${portVersion}`,
      properties: [prop("cdx:native:providerEvidence", JSON.stringify({ kind: "vcpkg-recipe",
        packageName: "fixture", name: "fixture", version: "1.2.3", portVersion,
        artifacts: [{ sha512: "a".repeat(128), revision: "v1.2.3" }] }))],
    });
    const result = canonicalizeNativeComponents([recipe(0), recipe(1)], []);
    assert.equal(result.pkgList.length, 2);
    assert.equal(new Set(result.pkgList.flatMap((c) => values(c, "cdx:native:canonicalRelease"))).size, 1);
  });

  it("loads exact offline recipe bytes, retains checksum provenance, and rejects altered metadata", () => {
    const cache = mkdtempSync(join(tmpdir(), "cdx-canonical-recipes-"));
    try {
      mkdirSync(join(cache, "conan"));
      const name = "fixture_json";
      const config = 'versions:\n  "3.12.0":\n    folder: all\n';
      const data = `sources:\n  "3.12.0":\n    url: "${repo}/archive/v3.12.0.tar.gz"\n    sha256: "${sha256}"\n`;
      const files = [
        { path: `recipes/${name}/config.yml`, content: config },
        { path: `recipes/${name}/all/conandata.yml`, content: data },
        { path: `recipes/${name}/all/conanfile.py`, content: "from conan import ConanFile\n" },
      ].map((file) => ({ ...file, sha256: createHash("sha256").update(file.content).digest("hex") }));
      const record = { schema: 1, repository: "https://github.com/conan-io/conan-center-index", revision: "a".repeat(40), package: name, files };
      const path = join(cache, "conan", `${name}.json`);
      writeFileSync(path, JSON.stringify(record));
      const component = { name, version: "3.12.0", "bom-ref": "conan-fixture", purl: `pkg:conan/${name}@3.12.0` };
      const enriched = enrichNativeConanRecipeIdentities([component], cache)[0];
      assert.equal(enriched.externalReferences[0].url, "https://github.com/nlohmann/json/archive/v3.12.0.tar.gz");
      assert.equal(enriched.externalReferences[0].hashes[0].content, sha256);
      const evidence = JSON.parse(values(enriched, "cdx:native:recipeEvidence")[0]);
      assert.equal(evidence.revision, "a".repeat(40));
      assert.equal(evidence.files.length, 3);
      assert.equal(component.externalReferences, undefined);
      const owned = source("3.12.0", "owned", repo, name);
      assert.equal(canonicalizeNativeComponents([enriched, owned], []).pkgList.length, 1);
      assert.equal(enrichNativeConanRecipeIdentities([{ ...component, version: "9.9.9" }], cache)[0].externalReferences, undefined);
      record.files[1].content += "\n# changed without updating its digest\n";
      writeFileSync(path, JSON.stringify(record));
      assert.equal(enrichNativeConanRecipeIdentities([component], cache)[0].externalReferences, undefined);
      assert.equal(enrichNativeConanRecipeIdentities([component], join(cache, "absent"))[0], component);
    } finally { rmSync(cache, { recursive: true, force: true }); }
  });
});
