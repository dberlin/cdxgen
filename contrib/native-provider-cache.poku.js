import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "poku";

import { nativeProviderCacheWriter, selectNativeProviderRecipes } from "./native-provider-cache.js";

describe("explicit external provider acquisition", () => {
  it("selects actual catalog releases for declared exports, including a constrained older alternative", () => {
    const catalog = {
      "fixture-recipe": { dependency_names: ["fixture-pc"], versions: ["3.2.0-2", "3.2.0-1", "2.7.4-3"] },
      "unrelated": { dependency_names: ["other"], versions: ["99.0-1"] },
    };
    const requirements = [{ requestedName: "fixture-pc", command: "dependency", constraints: "<3.0", providerCandidates: [] }];
    const selected = selectNativeProviderRecipes(catalog, requirements);
    assert.deepEqual(selected.map((x) => [x.name, x.recipeVersion]), [["fixture-recipe", "3.2.0-2"], ["fixture-recipe", "2.7.4-3"]]);
    assert.equal(selected[0].selected, false);
  });

  it("does not guess unrelated CMake identities or fabricate an unavailable required version", () => {
    const catalog = { fixture: { dependency_names: ["fixture"], versions: ["1.0.0-1"] } };
    assert.deepEqual(selectNativeProviderRecipes(catalog, [{ requestedName: "FixtureSDK", command: "find_package", constraints: "", providerCandidates: [] }]), []);
    const selected = selectNativeProviderRecipes(catalog, [{ requestedName: "FixtureSDK", command: "find_package", constraints: ">=9.0", providerCandidates: [{ kind: "wrapdb-catalog", name: "fixture", selected: false }] }]);
    assert.deepEqual(selected.map((x) => x.recipeVersion), ["1.0.0-1"]);
  });

  it("refuses descendant directory and destination-file symlinks before any cache write", () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "cdx-provider-cache-boundary-"));
    try {
      const source = join(root, "source"); mkdirSync(source);
      const output = join(root, "cache"); mkdirSync(output);
      const sentinel = join(source, "sentinel"); writeFileSync(sentinel, "original");
      const writer = nativeProviderCacheWriter(output, source);
      symlinkSync(source, join(output, "recipes"), "dir");
      assert.throws(() => writer.mkdir("recipes/nested"));
      assert.throws(() => writer.write("recipes/sentinel", "changed"));
      assert.throws(() => writer.file("recipes/stream.part"));
      symlinkSync(sentinel, join(output, "releases.json"));
      assert.throws(() => writer.write("releases.json", "changed"));
      assert.throws(() => writer.file("releases.json"));
      assert.equal(readFileSync(sentinel, "utf8"), "original");
      const linkedRoot = join(root, "linked-root"); symlinkSync(source, linkedRoot, "dir");
      assert.throws(() => nativeProviderCacheWriter(linkedRoot, source));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
