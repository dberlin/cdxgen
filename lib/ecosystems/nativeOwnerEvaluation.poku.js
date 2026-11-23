import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { strict as assert, test } from "poku";
import { openNativeOwnerCache } from "./nativeOwnerCache.js";
import { collectNativeProviders, resolveNativeRequirements } from "./nativeProviderIndex.js";
import { loadNativeExternalMetadata } from "./nativeExternalMetadata.js";

const hash = (text) => createHash("sha256").update(text).digest("hex");
test("persistent owner hits keep ordered exports and reauthenticate while stale inputs re-evaluate", () => {
  const scratch = mkdtempSync(join(process.env.HOME, "cdxgen-owner-replay-"));
  const scanRoot = join(scratch, "source"), root = join(scratch, "owner-cache");
  const owner = join(scanRoot, "vendor");
  const paths = [];
  const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); return path; };
  const manifest = (path, text) => paths.push(put(join(scanRoot, path), text));
  try {
    mkdirSync(root, { mode: 0o700 });
    manifest("vendor/CMakeLists.txt", `project(Probe VERSION 2.1)
include(first.cmake)
if(ENABLE_X)
  add_library(OptionProbe STATIC x.c)
endif()
install(DIRECTORY optional/ DESTINATION include FILES_MATCHING PATTERN "*.h")
`);
    manifest("vendor/first.cmake", "include(second.cmake)\n");
    const second = join(owner, "modules/second.cmake");
    manifest("vendor/modules/second.cmake", "add_library(Original STATIC probe.c)\n");
    const unchangedClock = new Date("2024-01-01T00:00:00Z");
    utimesSync(second, unchangedClock, unchangedClock);
    const originalStat = statSync(second);
    const flag = `foreach(a IN ITEMS ${Array.from({ length: 64 }, (_, i) => i).join(" ")})`;
    const work = `${flag}\n${flag}\nset(LOCAL_NOISE \${a})\nendforeach()\nendforeach()\n`;
    for (let file = 0; file < 32; file++) manifest(`vendor/sub${file}/CMakeLists.txt`, work);
    manifest("aside/CMakeLists.txt", "project(Aside VERSION 1.2)\n");
    manifest("vendor/leaf/CMakeLists.txt", "project(FormerBoundary)\nadd_library(Reassigned STATIC source.c)\n");
    const leaf = join(owner, "leaf");
    const aside = join(scanRoot, "aside");
    for (const directory of ["vendor", "aside"]) {
      manifest(`${directory}/FindShared.cmake`, "find_library(SHARED_LIB NAMES external-alone)\nfind_package_handle_standard_args(Shared REQUIRED_VARS SHARED_LIB)\n");
    }
    const original = JSON.stringify({ name: "ExternalOwner", version: "4.2", exports: [{ kind: "library", name: "external-alone", source: "/metadata/libexternal.so" }] });
    const receipt = put(join(scratch, "auth/origin.json"), original);
    const body = JSON.stringify({ schema: 1, versionKind: "release", ...JSON.parse(original), evidence: [{ path: "origin.json", sha256: hash(original) }] });
    put(join(scratch, "auth/body.json"), body);
    const authManifest = put(join(scratch, "auth/providers.json"), JSON.stringify({ schema: 1, providers: [{ metadata: { path: "body.json", format: "provider-snapshot", sha256: hash(body) } }] }));
    const [claim] = loadNativeExternalMetadata({ nativeProviderMetadata: authManifest });
    assert.ok(claim);
    const external = { name: claim.name, version: claim.version, "bom-ref": "external-versioned", properties: [
      { name: "cdx:native:providerIdentity", value: hash(JSON.stringify(claim)) },
      { name: "cdx:native:providerEvidence", value: JSON.stringify(claim) },
      { name: "cdx:native:providerExports", value: JSON.stringify(claim.exports) },
    ] };
    const request = { role: "software", command: "find_library", requestedName: "external-alone", file: "root/CMakeLists.txt", line: 1, conditions: [], providerCandidates: [] };
    const store = openNativeOwnerCache(root, scanRoot);
    let storedKey;
    const measured = { read: store.read, write(key, value) { storedKey = key; return store.write(key, value); } };
    const scan = (enable = "OFF", cached = true) => {
      const variables = new Map([["ENABLE_X", enable]]);
      const facts = [
        { directory: owner, component: { name: "Probe", version: "2.1", "bom-ref": "probe-versioned" }, variables },
        { directory: aside, component: { name: "Aside", version: "1.2", "bom-ref": "aside-versioned" } },
        { directory: owner, component: { name: "Probe", version: "2.1", "bom-ref": "probe-alias" }, variables, contextKey: "alias-context" },
        { directory: leaf, component: { name: "DeclaredTool", version: "3", "bom-ref": "declared-tool" }, declaredExports: [] },
      ];
      const events = [];
      const index = collectNativeProviders(facts, { scanRoot, nativeSourceManifests: paths, availableProviders: [external, external],
        ...(cached ? { nativeOwnerEvaluationCache: { store: measured, semantics: "fixture-build-v1", onDecision: (event) => events.push(event.decision) } } : {}),
      });
      return { comparable: { index, resolution: resolveNativeRequirements([request], index) }, events };
    };
    const cold = scan();
    assert.deepEqual(cold.events, ["miss", "stored"]);
    const warm = scan();
    assert.deepEqual(warm.events, ["hit"]);
    assert.deepEqual(warm.comparable, cold.comparable);
    assert.deepEqual(warm.comparable, scan("OFF", false).comparable);
    assert.deepEqual(warm.comparable.index.providers.slice(0, 3).map(({ ref }) => ref), ["probe-versioned", "aside-versioned", "probe-alias"]);
    assert.deepEqual(warm.comparable.index.findModules.map(({ directory }) => directory), [owner, aside, owner]);
    const exports = (result) => result.comparable.index.providers[0].exports.map(({ name }) => name);
    assert.ok(exports(warm).includes("Original"));
    assert.ok(warm.comparable.index.byExport.has("library:external-alone"));
    rmSync(receipt);
    const revoked = scan();
    assert.deepEqual(revoked.events, ["hit"]);
    assert.equal(revoked.comparable.index.byExport.has("library:external-alone"), false);
    assert.deepEqual(revoked.comparable, scan("OFF", false).comparable);
    put(second, "add_library(Modified STATIC probe.c)\n");
    utimesSync(second, unchangedClock, unchangedClock);
    const changedStat = statSync(second);
    assert.equal(changedStat.mtimeMs, originalStat.mtimeMs);
    assert.equal(changedStat.size, originalStat.size);
    const modified = scan();
    assert.deepEqual(modified.events, ["miss", "stored"]);
    assert.ok(exports(modified).includes("Modified"));
    // Deliberately retain the same manifest inventory: the missing candidate
    // must itself be a witness, independent of discovery-key invalidation.
    put(join(owner, "second.cmake"), "add_library(Override STATIC probe.c)\n");
    const appeared = scan();
    assert.deepEqual(appeared.events, ["miss", "stored"]);
    assert.ok(exports(appeared).includes("Override"));
    assert.equal(exports(appeared).includes("Modified"), false);
    put(join(owner, "optional/api.h"), "/* exported */\n");
    const listing = scan();
    assert.deepEqual(listing.events, ["miss", "stored"]);
    assert.ok(exports(listing).includes("api.h"));
    const option = scan("ON");
    assert.deepEqual(option.events, ["miss", "stored"]);
    assert.ok(exports(option).includes("OptionProbe"));
    manifest("vendor/sub0/CMakeLists.txt", "project(Separate VERSION 2)\n");
    const boundary = scan("ON");
    assert.deepEqual(boundary.events, ["miss", "stored"]);
    assert.deepEqual(boundary.comparable, scan("ON", false).comparable);
    assert.equal(exports(boundary).includes("Reassigned"), false);
    // The language tool fact keeps this directory independent. Removing the
    // project command changes assignment without changing directory membership.
    put(join(leaf, "CMakeLists.txt"), "add_library(Reassigned STATIC source.c)\n");
    const repartitioned = scan("ON");
    assert.deepEqual(repartitioned.events, ["miss", "stored"]);
    assert.ok(exports(repartitioned).includes("Reassigned"));
    assert.deepEqual(repartitioned.comparable, scan("ON", false).comparable);
    const malformed = store.read(storedKey);
    malformed.effect.effects.findDefinitions.push(null);
    assert.equal(store.write(storedKey, malformed), true); // valid wire, invalid effect
    const repaired = scan("ON");
    assert.deepEqual(repaired.events, ["miss", "stored"]);
    assert.deepEqual(repaired.comparable, repartitioned.comparable);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
