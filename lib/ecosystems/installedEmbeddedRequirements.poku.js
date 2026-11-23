import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { strict as assert, describe, test } from "poku";

import { collectEmbeddedSboms } from "./pep770.js";

describe("installed embedded requirements", () => {
  test("uses same-environment METADATA, preserves inactive/foreign requirements, rebases edges", async () => {
    const root = mkdtempSync(join(tmpdir(), "cdxgen-embedded-installed-"));
    try {
      const site = join(root, "lib", "python3.14", "site-packages");
      const owner = join(site, "owner-1.0.dist-info", "METADATA");
      const dep = join(site, "dep-2.3.dist-info", "METADATA");
      const foreign = join(root, "other-env", "foreign-7.0.dist-info", "METADATA");
      for (const file of [owner, dep, foreign]) mkdirSync(dirname(file), { recursive: true });
      writeFileSync(join(root, "pyvenv.cfg"), "version = 3.14.8\n");
      writeFileSync(owner, "Name: owner\nVersion: 1.0\nRequires-Dist: dep>=2,<3\nRequires-Dist: foreign>=1\n\n");
      writeFileSync(dep, "Name: dep\nVersion: 2.3\n\n");
      writeFileSync(foreign, "Name: foreign\nVersion: 7.0\n\n");
      const sboms = join(dirname(owner), "sboms");
      mkdirSync(sboms);
      const reference = "requires-dist:dep>=2,<3";
      writeFileSync(join(sboms, "bom.json"), JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.6", version: 1, metadata: { component: { type: "library", name: "owner", "bom-ref": "owner" } }, components: [{ type: "library", name: "dep", purl: "pkg:pypi/dep", "bom-ref": reference }, { type: "library", name: "foreign", purl: "pkg:pypi/foreign", "bom-ref": "requires-dist:foreign>=1" }], dependencies: [{ ref: "owner", dependsOn: [reference] }] }));
      const result = await collectEmbeddedSboms({ metadataFiles: [owner, dep, foreign] });
      assert.equal(result.components.find((c) => c.name === "dep").version, "2.3");
      assert.ok(!result.components.find((c) => c.name === "foreign").version);
      assert.deepEqual(result.dependencies[0].dependsOn, ["pkg:pypi/dep@2.3"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("never substitutes a different owner requirement for the embedded constraint", async () => {
    const root = mkdtempSync(join(tmpdir(), "cdxgen-embedded-constraint-"));
    try {
      const site = join(root, "site-packages");
      const owner = join(site, "owner-1.0.dist-info", "METADATA");
      const dependency = join(site, "dep-2.3.dist-info", "METADATA");
      for (const file of [owner, dependency]) mkdirSync(dirname(file), { recursive: true });
      writeFileSync(owner, "Name: owner\nVersion: 1.0\nRequires-Dist: dep>=2,<3\n\n");
      writeFileSync(dependency, "Name: dep\nVersion: 2.3\n\n");
      const sboms = join(dirname(owner), "sboms");
      mkdirSync(sboms);
      const ref = "requires-dist:dep>=9";
      writeFileSync(join(sboms, "bom.json"), JSON.stringify({
        bomFormat: "CycloneDX", specVersion: "1.6", version: 1,
        components: [{ type: "library", name: "dep", purl: "pkg:pypi/dep", "bom-ref": ref }],
        dependencies: [{ ref, dependsOn: [] }],
      }));
      const result = await collectEmbeddedSboms({ metadataFiles: [owner, dependency] });
      assert.ok(!result.components[0].version);
      assert.equal(result.components[0]["bom-ref"], ref);
      assert.equal(result.dependencies[0].ref, ref);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("removes only proven inactive installed placeholders and preserves owner requirement provenance", async () => {
    const root = mkdtempSync(join(tmpdir(), "cdxgen-marker-"));
    try {
      const owner = join(root, "lib", "python3.14", "site-packages", "owner-1.dist-info", "METADATA");
      mkdirSync(join(dirname(owner), "sboms"), { recursive: true });
      writeFileSync(join(root, "pyvenv.cfg"), "version = 3.14.8\n");
      const inactive = "typing-extensions>=4; python_version < '3.11'";
      const unknown = "other>=1; implementation_name == 'unknown'";
      writeFileSync(owner, `Name: owner\nVersion: 1\nRequires-Dist: ${inactive}\nRequires-Dist: ${unknown}\n\n`);
      const inactiveRef = `requires-dist:${inactive}`;
      const unknownRef = `requires-dist:${unknown}`;
      writeFileSync(join(dirname(owner), "sboms", "bom.json"), JSON.stringify({
        bomFormat: "CycloneDX", specVersion: "1.6", version: 1,
        metadata: { component: { type: "library", name: "owner", "bom-ref": "owner" } },
        components: [
          { type: "library", name: "typing-extensions", purl: "pkg:pypi/typing-extensions", "bom-ref": inactiveRef, properties: [{ name: "owner:environment-marker", value: "python_version < '3.11'" }] },
          { type: "library", name: "other", purl: "pkg:pypi/other", "bom-ref": unknownRef },
        ],
        dependencies: [{ ref: "owner", dependsOn: [inactiveRef, unknownRef], provides: [inactiveRef] }, { ref: inactiveRef, dependsOn: [] }],
      }));
      const result = await collectEmbeddedSboms({ metadataFiles: [owner] });
      assert.ok(!result.components.some((c) => c["bom-ref"] === inactiveRef));
      assert.ok(result.components.some((c) => c["bom-ref"] === unknownRef));
      assert.deepEqual(result.dependencies, [{ ref: "pkg:pypi/owner@1", dependsOn: [unknownRef], provides: [] }]);
      const provenance = result.components.find((c) => c["bom-ref"] === "pkg:pypi/owner@1");
      const fact = JSON.parse(provenance.properties.find((p) => p.name === "cdx:pypi:inactiveRequirement").value);
      assert.equal(fact.requirement, inactive);
      assert.equal(fact.pythonVersion, "3.14");
      assert.equal(fact.component["bom-ref"], inactiveRef);
      assert.equal(fact.component.properties.find((p) => p.name === "owner:environment-marker").value, "python_version < '3.11'");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("keeps source requirements, missing-environment markers, and a placeholder used by another component", async () => {
    for (const mode of ["source", "unknown", "used-elsewhere"]) {
      const root = mkdtempSync(join(tmpdir(), "cdxgen-marker-scope-"));
      try {
        const site = mode === "source" ? join(root, "unpacked-wheel") : join(root, "lib", "python3.14", "site-packages");
        const owner = join(site, "owner-1.dist-info", "METADATA");
        const sboms = join(dirname(owner), "sboms");
        mkdirSync(sboms, { recursive: true });
        if (mode !== "unknown") writeFileSync(join(root, "pyvenv.cfg"), "version = 3.14.8\n");
        const requirement = "dep>=1; python_version < '3.11'";
        const ref = `requires-dist:${requirement}`;
        writeFileSync(owner, `Name: owner\nVersion: 1\nRequires-Dist: ${requirement}\n\n`);
        writeFileSync(join(sboms, "bom.json"), JSON.stringify({
          bomFormat: "CycloneDX", specVersion: "1.6", version: 1,
          metadata: { component: { type: "library", name: "owner", "bom-ref": "owner" } },
          components: [{ type: "library", name: "dep", purl: "pkg:pypi/dep", "bom-ref": ref }],
          dependencies: [{ ref: mode === "used-elsewhere" ? "another-component" : "owner", dependsOn: [ref] }],
        }));
        const result = await collectEmbeddedSboms({ metadataFiles: [owner] });
        assert.ok(result.components.some((c) => c["bom-ref"] === ref), mode);
        assert.deepEqual(result.dependencies[0].dependsOn, [ref], mode);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  });
  test("resolves an active marker only from the same installed site and remaps all graph positions", async () => {
    const root = mkdtempSync(join(tmpdir(), "cdxgen-active-marker-"));
    try {
      const site = join(root, "lib", "python3.14", "site-packages");
      const owner = join(site, "owner-1.dist-info", "METADATA");
      const dep = join(site, "dep-2.dist-info", "METADATA");
      mkdirSync(join(dirname(owner), "sboms"), { recursive: true });
      mkdirSync(dirname(dep), { recursive: true });
      writeFileSync(join(root, "pyvenv.cfg"), "version = 3.14.8\n");
      const requirement = "dep>=1; python_version >= '3.11'";
      const ref = `requires-dist:${requirement}`;
      writeFileSync(owner, `Name: owner\nVersion: 1\nRequires-Dist: ${requirement}\n\n`);
      writeFileSync(dep, "Name: dep\nVersion: 2\n\n");
      writeFileSync(join(dirname(owner), "sboms", "bom.json"), JSON.stringify({
        bomFormat: "CycloneDX", specVersion: "1.6", version: 1,
        metadata: { component: { type: "library", name: "owner", "bom-ref": "owner" } },
        components: [{ type: "library", name: "dep", purl: "pkg:pypi/dep", "bom-ref": ref }],
        dependencies: [{ ref: "owner", dependsOn: [ref], provides: [ref] }, { ref, dependsOn: [] }],
      }));
      const result = await collectEmbeddedSboms({ metadataFiles: [owner, dep] });
      assert.equal(result.components[0].version, "2");
      assert.deepEqual(result.dependencies, [{ ref: "pkg:pypi/owner@1", dependsOn: ["pkg:pypi/dep@2"], provides: ["pkg:pypi/dep@2"] }, { ref: "pkg:pypi/dep@2", dependsOn: [] }]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("retains independently referenced descendants when removing an inactive conditional parent", async () => {
    for (const edge of ["dependsOn", "provides"]) {
      const root = mkdtempSync(join(tmpdir(), "cdxgen-marker-children-"));
      try {
        const owner = join(root, "lib", "python3.14", "site-packages", "owner-1.dist-info", "METADATA");
        mkdirSync(join(dirname(owner), "sboms"), { recursive: true });
        writeFileSync(join(root, "pyvenv.cfg"), "version = 3.14.8\n");
        const requirement = "dep>=1; python_version < '3.11'";
        const ref = `requires-dist:${requirement}`;
        const child = { type: "library", name: "child", version: "2", purl: "pkg:generic/child@2", "bom-ref": "child" };
        writeFileSync(owner, `Name: owner\nVersion: 1\nRequires-Dist: ${requirement}\n\n`);
        writeFileSync(join(dirname(owner), "sboms", "bom.json"), JSON.stringify({
          bomFormat: "CycloneDX", specVersion: "1.6", version: 1,
          metadata: { component: { type: "library", name: "owner", "bom-ref": "owner" } },
          components: [
            { type: "library", name: "dep", purl: "pkg:pypi/dep", "bom-ref": ref, components: [{ type: "library", name: "container", "bom-ref": "container", components: [child] }] },
            { type: "library", name: "consumer", "bom-ref": "consumer" },
          ],
          dependencies: [{ ref: "owner", dependsOn: [ref] }, { ref: "consumer", [edge]: ["child"] }, { ref: "child", dependsOn: [] }],
        }));
        const result = await collectEmbeddedSboms({ metadataFiles: [owner] });
        assert.ok(!result.components.some((component) => component["bom-ref"] === ref));
        assert.deepEqual(result.components.find((component) => component["bom-ref"] === "child"), child, edge);
        assert.deepEqual(result.dependencies.find((dependency) => dependency.ref === "consumer")[edge], ["child"]);
        const refs = new Set(result.components.map((component) => component["bom-ref"]));
        assert.ok(result.dependencies.every((dependency) => [dependency.ref, ...(dependency.dependsOn || []), ...(dependency.provides || [])].every((reference) => refs.has(reference))));
        const provenance = result.components.find((component) => component["bom-ref"] === "pkg:pypi/owner@1");
        assert.equal(JSON.parse(provenance.properties.find((property) => property.name === "cdx:pypi:inactiveRequirement").value).component.components[0].components[0]["bom-ref"], "child");
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  });
  test("does not borrow an enclosing environment version for extracted or mismatched installed sites", async () => {
    for (const layout of [["extracted", "lib", "python3.10", "site-packages"], ["lib", "python3.10", "site-packages"]]) {
      const root = mkdtempSync(join(tmpdir(), "cdxgen-marker-foreign-site-"));
      try {
        const owner = join(root, ...layout, "owner-1.dist-info", "METADATA");
        mkdirSync(join(dirname(owner), "sboms"), { recursive: true });
        writeFileSync(join(root, "pyvenv.cfg"), "version = 3.14.8\n");
        const requirement = "dep>=1; python_version < '3.11'";
        const ref = `requires-dist:${requirement}`;
        writeFileSync(owner, `Name: owner\nVersion: 1\nRequires-Dist: ${requirement}\n\n`);
        writeFileSync(join(dirname(owner), "sboms", "bom.json"), JSON.stringify({
          bomFormat: "CycloneDX", specVersion: "1.6", version: 1,
          metadata: { component: { type: "library", name: "owner", "bom-ref": "owner" } },
          components: [{ type: "library", name: "dep", purl: "pkg:pypi/dep", "bom-ref": ref }],
          dependencies: [{ ref: "owner", dependsOn: [ref] }],
        }));
        const result = await collectEmbeddedSboms({ metadataFiles: [owner] });
        assert.ok(result.components.some((component) => component["bom-ref"] === ref));
        assert.deepEqual(result.dependencies[0].dependsOn, [ref]);
        assert.ok(!result.components.some((component) => component.properties?.some((property) => property.name === "cdx:pypi:inactiveRequirement")));
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  });
  test("recognizes the canonical carrying distribution edge without an embedded metadata root", async () => {
    const root = mkdtempSync(join(tmpdir(), "cdxgen-marker-canonical-owner-"));
    try {
      const owner = join(root, "lib", "python3.14", "site-packages", "owner-1.dist-info", "METADATA");
      mkdirSync(join(dirname(owner), "sboms"), { recursive: true });
      writeFileSync(join(root, "pyvenv.cfg"), "version = 3.14.8\n");
      const requirement = "dep>=1; python_version < '3.11'";
      const ref = `requires-dist:${requirement}`;
      const ownerRef = "pkg:pypi/owner@1";
      writeFileSync(owner, `Name: owner\nVersion: 1\nRequires-Dist: ${requirement}\n\n`);
      writeFileSync(join(dirname(owner), "sboms", "bom.json"), JSON.stringify({
        bomFormat: "CycloneDX", specVersion: "1.6", version: 1,
        components: [
          { type: "library", name: "owner", version: "1", purl: ownerRef, "bom-ref": ownerRef },
          { type: "library", name: "dep", purl: "pkg:pypi/dep", "bom-ref": ref },
        ],
        dependencies: [{ ref: ownerRef, dependsOn: [ref], provides: [ref] }],
      }));
      const result = await collectEmbeddedSboms({ metadataFiles: [owner] });
      assert.ok(!result.components.some((component) => component["bom-ref"] === ref));
      assert.deepEqual(result.dependencies, [{ ref: ownerRef, dependsOn: [], provides: [] }]);
      assert.equal(result.components.filter((component) => component["bom-ref"] === ownerRef).length, 1);
      assert.equal(JSON.parse(result.components[0].properties.find((property) => property.name === "cdx:pypi:inactiveRequirement").value).requirement, requirement);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
