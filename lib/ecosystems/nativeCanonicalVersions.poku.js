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
