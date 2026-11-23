import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { strict as assert, test } from "poku";
import { createCppBom } from "./nativeBom.js";
import { applyOperatorToolingChoice } from "./cliOptions.js";
import { acquireNativeEvidence, materializeNativeAcquisitions, nativeAcquisitionBlockers, nativeAcquisitionRequests } from "./nativeAcquisition.js";
import { acquireNativeAppleProviders } from "../../contrib/native-apple-provider-cache.js";
import { acquireNativeCudaProviders } from "../../contrib/native-cuda-provider-cache.js";
import { acquireNativeProviders } from "../../contrib/native-provider-cache.js";
import { acquireNativeRpmProviders } from "../../contrib/native-rpm-provider-cache.js";
import { nativeDownloadCacheKey } from "../ecosystems/nativeDownloadSources.js";
import { acquireNativeSourceObjects } from "../../contrib/native-source-cache.js";
import { parseCmakeLikeFile } from "../ecosystems/parsers-misc.js";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function tarFile(name, text) {
  const bytes = Buffer.from(text); const header = Buffer.alloc(512);
  header.write(name); header.write("0000644\0", 100); header.write("0000000\0", 108); header.write("0000000\0", 116);
  header.write(`${bytes.length.toString(8).padStart(11, "0")}\0`, 124); header.write("00000000000\0", 136);
  header.fill(32, 148, 156); header[156] = 48; header.write("ustar\0", 257);
  header.write(`${header.reduce((a, b) => a + b, 0).toString(8).padStart(6, "0")}\0 `, 148);
  return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
}

test("project configuration cannot grant acquisition or redirect its cache", () => {
  const options = { nativeAcquire: true, nativeSourceCache: "/project/cache", nativeAcquireHosts: "evil.invalid", nativeRpmRepositories: "fedora=https://evil.invalid/" };
  applyOperatorToolingChoice(options, { argv: [], env: {} });
  assert.equal(options.nativeAcquire, false);
  assert.equal(options.nativeSourceCache, undefined);
  assert.equal(options.nativeAcquireHosts, undefined);
  assert.equal(options.nativeRpmRepositories, undefined);
});

test("requests retain exact original selectors, hashes and independent occurrences", () => {
  const requirements = [1, 2].map((line) => ({ role: "source-declaration", requestedName: "widget", file: "CMakeLists.txt", line,
    command: "fetch-content", conditions: ["if(WIN32)"], source: { gitRepository: "https://github.com/acme/widget", gitTag: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", urlHash: `SHA256=${"a".repeat(64)}` } }));
  const requests = nativeAcquisitionRequests(requirements);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].selector, requirements[0].source.gitTag);
  assert.deepEqual(requests[0].occurrences.map((r) => r.line), [1, 2]);
  assert.equal(requests[0].declaration.urlHash, requirements[0].source.urlHash);
});

await test("normal C++ discovery cold acquires a declared archive and reuses it offline without inventories", async () => {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-normal-acquire-")); const source = join(root, "source"); const cache = join(root, "cache");
  mkdirSync(source);
  const archive = gzipSync(Buffer.concat([
    tarFile("widget/CMakeLists.txt", "project(widget VERSION 2.4.6)\n"),
    tarFile("widget/include/widget.hpp", "// widget version 2.4.6\n// https://github.com/acme/widget\n"), Buffer.alloc(1024),
  ]));
  const url = "https://example.org/widget-2.4.6.tar.gz";
  writeFileSync(join(source, "CMakeLists.txt"), `project(Consumer)\nFetchContent_Declare(widget URL ${url} URL_HASH SHA256=${sha(archive)})\n`);
  const options = { multiProject: true, createMultiXBom: true, installDeps: false, introspect: false, nativeVersionProbes: false, deep: false,
    specVersion: 1.7, nativeSourceCache: cache, nativeAcquire: true, nativeAcquireHosts: "example.org" };
  const original = globalThis.fetch; let calls = 0;
  try {
    globalThis.fetch = async (location) => { calls++; assert.equal(String(location), url); return new Response(archive); };
    const cold = (await createCppBom(source, options)).bomJson;
    assert.equal(calls, 1);
    const widget = cold.components.find((c) => c.name === "widget");
    assert.equal(widget.version, "2.4.6");
    assert.ok(widget.properties.some((p) => p.name === "cdx:native:archiveIdentityEvidence"));
    globalThis.fetch = () => { throw new Error("warm scan must not fetch"); };
    const warm = (await createCppBom(source, { ...options, nativeAcquire: false })).bomJson;
    assert.equal(warm.components.find((c) => c.name === "widget").purl, widget.purl);
    assert.deepEqual(warm.dependencies, cold.dependencies);
    assert.deepEqual(readdirSync(source), ["CMakeLists.txt"]);
  } finally { globalThis.fetch = original; rmSync(root, { recursive: true, force: true }); }
});

await test("dry-run and offline paths retain named acquisition blockers without cache writes", async () => {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-acquire-offline-")); const source = join(root, "source"); mkdirSync(source);
  writeFileSync(join(source, "CMakeLists.txt"), "project(Consumer)\nFetchContent_Declare(widget GIT_REPOSITORY https://github.com/acme/widget GIT_TAG missing-exact-tag)\n");
  const original = globalThis.fetch;
  try {
    globalThis.fetch = () => { throw new Error("network forbidden"); };
    for (const options of [{ nativeAcquire: false }, { nativeAcquire: true, dryRun: true }]) {
      const bom = (await createCppBom(source, { multiProject: true, createMultiXBom: true, installDeps: false, deep: false, specVersion: 1.7,
        nativeSourceCache: join(root, "cache"), ...options })).bomJson;
      assert.ok(bom.metadata.component.properties.some((p) => p.name === "cdx:native:acquisition" && JSON.parse(p.value).selector === "missing-exact-tag"));
    }
    assert.deepEqual(readdirSync(root), ["source"]);
  } finally { globalThis.fetch = original; rmSync(root, { recursive: true, force: true }); }
});

await test("an unapproved redirect and a declared hash mismatch never become acquired evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-acquire-redirect-")); const source = join(root, "source"); mkdirSync(source);
  writeFileSync(join(source, "CMakeLists.txt"), `project(Consumer)\nFetchContent_Declare(widget URL https://example.org/widget-2.4.6.tar.gz URL_HASH SHA256=${"a".repeat(64)})\n`);
  const original = globalThis.fetch;
  try {
    for (const response of [() => new Response(null, { status: 302, headers: { location: "https://unapproved.invalid/widget.tar.gz" } }), () => new Response("wrong bytes")]) {
      let calls = 0; globalThis.fetch = async () => { calls++; return response(); };
      const bom = (await createCppBom(source, { multiProject: true, createMultiXBom: true, installDeps: false, deep: false, specVersion: 1.7,
        nativeSourceCache: join(root, "cache"), nativeAcquire: true, nativeAcquireHosts: "example.org" })).bomJson;
      assert.equal(calls, 1);
      assert.ok(bom.metadata.component.properties.some((p) => p.name === "cdx:native:acquisition" && JSON.parse(p.value).status === "blocked"));
      assert.ok(!bom.components.some((c) => c.properties?.some((p) => p.name === "cdx:native:archiveIdentityEvidence")));
    }
  } finally { globalThis.fetch = original; rmSync(root, { recursive: true, force: true }); }
});

await test("nested scans protect every enclosing checkout before cache writes or network", async () => {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-enclosing-source-"));
  const outer = join(root, "outer"); const inner = join(outer, "packages", "inner"); const scan = join(inner, "cmake");
  mkdirSync(join(outer, ".git"), { recursive: true }); mkdirSync(join(inner, ".git"), { recursive: true }); mkdirSync(scan);
  const alias = join(root, "source-alias"); symlinkSync(outer, alias, "dir");
  const archive = gzipSync(Buffer.concat([tarFile("widget/CMakeLists.txt", "project(widget VERSION 2.4.6)\n"), Buffer.alloc(1024)]));
  const requirements = [{ requestedName: "widget", file: "CMakeLists.txt", line: 1, command: "fetch-content", role: "source-declaration",
    conditions: [], providerCandidates: [], source: { name: "widget", kind: "fetch-content", url: "https://example.org/widget.tar.gz", urlHash: `SHA256=${sha(archive)}` } }];
  const original = globalThis.fetch; let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; return new Response(archive); };
    for (const cache of [join(outer, "cache"), join(inner, "cache"), join(alias, "cache")]) {
      const result = await acquireNativeEvidence(requirements, scan, { nativeAcquire: true, nativeSourceCache: cache, nativeAcquireHosts: "example.org" });
      assert.equal(calls, 0, "protected checkouts must be rejected before any network");
      assert.ok(!existsSync(cache), "not even a cache directory may be written inside a protected checkout");
      assert.ok(result.diagnostics.some((entry) => entry.status === "blocked" && /outside source/.test(entry.prerequisite)));
    }
    assert.deepEqual(readdirSync(outer).sort(), [".git", "packages"]);
    assert.deepEqual(readdirSync(inner).sort(), [".git", "cmake"]);
    const result = await acquireNativeEvidence(requirements, scan, { nativeAcquire: true, nativeSourceCache: join(root, "external-cache"), nativeAcquireHosts: "example.org" });
    assert.equal(calls, 1);
    assert.ok(result.diagnostics.some((entry) => entry.status === "acquired"));
    assert.ok(existsSync(join(root, "external-cache", "downloads")));
    assert.equal(result.diagnostics[0].occurrences[0].file, "CMakeLists.txt", "request paths remain relative to the scan, not the outer boundary");
    assert.deepEqual(readdirSync(outer).sort(), [".git", "packages"]);
    assert.deepEqual(readdirSync(inner).sort(), [".git", "cmake"]);
  } finally { globalThis.fetch = original; rmSync(root, { recursive: true, force: true }); }
});

await test("partial SDK contexts replay blockers offline and retry only missing material when authorized", async () => {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-partial-sdk-")); const source = join(root, "source"); mkdirSync(source);
  const revision = "a".repeat(40); const sdkTree = "b".repeat(40); const rootTree = "c".repeat(40);
  const blob = (text) => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex");
  const stub = (name) => `--- !tapi-tbd\ntargets: [arm64-macos]\ninstall-name: /System/Library/Frameworks/${name}.framework/${name}\ncurrent-version: 2.4.6\n`;
  const settings = JSON.stringify({ CanonicalName: "macosx15.0", Version: "15.0" });
  const tree = { tree: [{ type: "blob", path: "SDKSettings.json", sha: blob(settings) },
    ...["QuartzCore", "Metal"].map((name) => ({ type: "blob", path: `System/Library/Frameworks/${name}.framework/${name}.tbd`, sha: blob(stub(name)) }))] };
  const requirements = [{ requestedName: "appleframeworks", role: "software", command: "dependency", file: "meson.build", line: 2,
    arguments: ["'appleframeworks'", "modules: ['QuartzCore', 'Metal']"], conditions: [], providerCandidates: [] }];
  const options = { nativeAcquire: true, nativeSourceCache: join(root, "cache"), nativeAppleSdks: `acme/sdks@${revision}:MacOSX.sdk` };
  const original = globalThis.fetch; const seen = []; let unavailable = true;
  try {
    const respond = async (location) => {
      const url = String(location); seen.push(url);
      if (url.endsWith(`/git/commits/${revision}`)) return new Response(JSON.stringify({ sha: revision, tree: { sha: rootTree } }));
      if (url.endsWith(`/git/trees/${rootTree}`)) return new Response(JSON.stringify({ tree: [{ type: "tree", path: "MacOSX.sdk", sha: sdkTree }] }));
      if (url.endsWith(`/git/trees/${sdkTree}?recursive=1`)) return new Response(JSON.stringify(tree));
      if (url.endsWith("/SDKSettings.json")) return new Response(settings);
      if (url.endsWith("/QuartzCore.tbd")) return unavailable ? new Response(null, { status: 503 }) : new Response(stub("QuartzCore"));
      if (url.endsWith("/Metal.tbd")) return new Response(stub("Metal"));
      throw new Error(`Unexpected SDK request ${url}`);
    };
    globalThis.fetch = respond;
    const cold = await acquireNativeEvidence(requirements, source, options);
    const partial = cold.diagnostics.find((entry) => entry.family === "apple-sdk");
    assert.equal(partial.status, "partial");
    assert.ok(partial.blockers.some((entry) => entry.name === "QuartzCore"));
    const requests = seen.length;
    globalThis.fetch = () => { throw new Error("offline partial context must not fetch"); };
    const offline = await acquireNativeEvidence(requirements, source, { ...options, nativeAcquire: false });
    assert.deepEqual(offline.diagnostics.find((entry) => entry.family === "apple-sdk").blockers, partial.blockers);
    assert.equal(offline.diagnostics.find((entry) => entry.family === "apple-sdk").status, "partial");
    assert.deepEqual(offline.options.nativeProviderMetadata, cold.options.nativeProviderMetadata);
    unavailable = false; globalThis.fetch = respond;
    const retry = await acquireNativeEvidence(requirements, source, options);
    assert.equal(retry.diagnostics.find((entry) => entry.family === "apple-sdk").status, "acquired");
    assert.deepEqual(seen.slice(requests), [`https://raw.githubusercontent.com/acme/sdks/${revision}/MacOSX.sdk/System/Library/Frameworks/QuartzCore.framework/QuartzCore.tbd`]);
  } finally { globalThis.fetch = original; rmSync(root, { recursive: true, force: true }); }
});

await test("partial declared artifacts replay offline but are reinterpreted on authorized retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-partial-source-")); const source = join(root, "source"); mkdirSync(source);
  const url = "https://example.org/opaque-artifact";
  const requirements = [{ requestedName: "opaque", role: "source-declaration", command: "file-download", file: "CMakeLists.txt", line: 1,
    conditions: [], providerCandidates: [], source: { url } }];
  const options = { nativeAcquire: true, nativeSourceCache: join(root, "cache"), nativeAcquireHosts: "example.org" };
  const original = globalThis.fetch; let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; return new Response("original opaque artifact"); };
    const cold = await acquireNativeEvidence(requirements, source, options);
    assert.equal(cold.diagnostics[0].status, "partial");
    const recordFile = join(options.nativeSourceCache, "downloads", `${nativeDownloadCacheKey(url)}.json`);
    const record = JSON.parse(readFileSync(recordFile, "utf8")); record.observedAt = "2000-01-01T00:00:00.000Z"; writeFileSync(recordFile, JSON.stringify(record));
    const offline = await acquireNativeEvidence(requirements, source, { ...options, nativeAcquire: false });
    assert.equal(offline.diagnostics[0].status, "partial");
    assert.equal(offline.diagnostics[0].prerequisite, cold.diagnostics[0].prerequisite);
    assert.equal(JSON.parse(readFileSync(recordFile, "utf8")).observedAt, record.observedAt);
    const retry = await acquireNativeEvidence(requirements, source, options);
    assert.equal(retry.diagnostics[0].status, "partial");
    assert.notEqual(JSON.parse(readFileSync(recordFile, "utf8")).observedAt, record.observedAt);
    assert.equal(calls, 1, "immutable original bytes are reused during metadata retry");
  } finally { globalThis.fetch = original; rmSync(root, { recursive: true, force: true }); }
});

await test("rejected registry metadata and missing SDK identities remain named partial outcomes", async () => {
  assert.deepEqual(nativeAcquisitionBlockers({ missingIdentities: ["NVML"] }).map((entry) => entry.requestedName), ["NVML"]);
  const root = mkdtempSync(join(tmpdir(), "cdxgen-rejected-provider-")); const source = join(root, "source"); mkdirSync(source);
  const revision = "d".repeat(40);
  const requirements = [{ requestedName: "widget", role: "software", command: "find_package", conditions: [], providerCandidates: [] }];
  const options = { nativeAcquire: true, nativeSourceCache: join(root, "cache"), nativeRegistryRevision: revision };
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (location) => {
      const url = String(location);
      if (url.endsWith("/releases.json")) return new Response("{}");
      if (url.endsWith("/versions/baseline.json")) return new Response(JSON.stringify({ default: { widget: { baseline: "1.0.0", "port-version": 0 } } }));
      if (url.includes("/git/trees/")) return new Response(JSON.stringify({ tree: [] }));
      if (url.endsWith("/widget/vcpkg.json")) return new Response(JSON.stringify({ name: "widget", version: "1.0.0" }));
      if (url.endsWith("/widget/portfile.cmake")) return new Response("set(NO_AUTHENTICATED_EXPORT 1)\n");
      if (url.endsWith("/widget/usage")) return new Response(null, { status: 404 });
      throw new Error(`Unexpected registry request ${url}`);
    };
    const cold = await acquireNativeEvidence(requirements, source, options);
    const diagnostic = cold.diagnostics.find((entry) => entry.family === "registry");
    assert.equal(diagnostic.status, "partial");
    assert.ok(diagnostic.blockers.some((entry) => entry.name === "widget" && /Recipe lacks/.test(entry.prerequisite)));
    globalThis.fetch = () => { throw new Error("offline rejected metadata must not fetch"); };
    const offline = await acquireNativeEvidence(requirements, source, { ...options, nativeAcquire: false });
    assert.deepEqual(offline.diagnostics.find((entry) => entry.family === "registry").blockers, diagnostic.blockers);
    assert.equal(offline.diagnostics.find((entry) => entry.family === "registry").status, "partial");
  } finally { globalThis.fetch = original; rmSync(root, { recursive: true, force: true }); }
});

await test("exhausted absolute producer deadlines start neither network nor subprocesses", async () => {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-exhausted-acquire-")); const source = join(root, "source"); mkdirSync(source);
  const original = globalThis.fetch; const spawn = globalThis.Bun?.spawn; let calls = 0; let processes = 0;
  try {
    globalThis.fetch = () => { calls++; throw new Error("network started after deadline"); };
    if (spawn) globalThis.Bun.spawn = () => { processes++; throw new Error("subprocess started after deadline"); };
    const common = { requirements: [], output: join(root, "cache"), sourceRoot: source, fetch: true, deadline: Date.now() - 1 };
    for (const run of [
      () => acquireNativeProviders(common),
      () => acquireNativeRpmProviders({ ...common, repositories: ["fedora=https://example.org/releases/44/"] }),
      () => acquireNativeAppleProviders({ ...common, specifications: [`acme/sdks@${"a".repeat(40)}:MacOSX.sdk`] }),
      () => acquireNativeCudaProviders({ ...common, cudaRelease: "12.3.0", platforms: "linux-x86_64" }),
    ]) await assert.rejects(run(), /deadline/i);
    assert.equal(calls, 0); assert.equal(processes, 0);
    assert.ok(!existsSync(common.output));
  } finally { globalThis.fetch = original; if (spawn) globalThis.Bun.spawn = spawn; rmSync(root, { recursive: true, force: true }); }
});

await test("normal orchestration shares one absolute deadline across producer families", async () => {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-shared-acquire-deadline-")); const source = join(root, "source"); mkdirSync(source);
  const original = globalThis.fetch; const now = Date.now; const spawn = globalThis.Bun?.spawn; let calls = 0; let processes = 0;
  try {
    const started = now();
    globalThis.fetch = async () => { calls++; Date.now = () => started + 300001; return new Response("{}"); };
    if (spawn) globalThis.Bun.spawn = () => { processes++; throw new Error("subprocess started after shared deadline"); };
    const result = await acquireNativeEvidence([{ requestedName: "widget", command: "find_package", role: "software", providerCandidates: [] }], source, {
      nativeAcquire: true, nativeSourceCache: join(root, "cache"), nativeRegistryRevision: "a".repeat(40),
      nativeRpmRepositories: "fedora=https://example.org/releases/44/", nativeAppleSdks: `acme/sdks@${"a".repeat(40)}:MacOSX.sdk`,
      nativeCudaRelease: "12.3.0", nativeCudaPlatforms: "linux-x86_64",
    });
    assert.equal(calls, 1); assert.equal(processes, 0);
    for (const family of ["registry", "rpm", "apple-sdk", "cuda"]) {
      const diagnostic = result.diagnostics.find((entry) => entry.family === family);
      assert.equal(diagnostic.status, "blocked");
      assert.match(diagnostic.prerequisite, /deadline/i);
    }
  } finally { Date.now = now; globalThis.fetch = original; if (spawn) globalThis.Bun.spawn = spawn; rmSync(root, { recursive: true, force: true }); }
});

await test("cold nonnumeric wrap tags replace declared-exact consumer occurrences without deleting genuine owners", async () => {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-cold-wrap-owner-")); const source = join(root, "consumer"); const upstream = join(root, "upstream"); const cache = join(root, "cache");
  mkdirSync(join(source, "subprojects"), { recursive: true }); mkdirSync(upstream);
  const git = (...args) => execFileSync("/usr/bin/git", args, { encoding: "utf8", cwd: root, env: {
    PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
  } });
  try {
    writeFileSync(join(upstream, "CMakeLists.txt"), "project(widget VERSION 2.4.6)\n");
    git("init", "--quiet", upstream); git("-C", upstream, "add", "CMakeLists.txt");
    git("-C", upstream, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "commit", "--quiet", "-m", "Exact source fixture");
    git("-C", upstream, "tag", "stable-release");
    const manifest = join(source, "meson.build");
    writeFileSync(manifest, "project('Consumer')\nif get_option('enable_widget')\n  dependency('widget', version: '== 2.4.6', fallback: ['widget', 'widget_dep'])\nelse\n  dependency('widget', version: '== 9.0', fallback: ['widget', 'widget_dep'])\nendif\n");
    writeFileSync(join(source, "subprojects", "widget.wrap"), "[wrap-git]\nurl = https://github.com/acme/widget.git\nrevision = stable-release\n");
    const options = { sourceRoot: source, nativeSourceCache: cache };
    const cold = parseCmakeLikeFile(manifest, "generic", options);
    const declaration = cold.requirements.find((entry) => entry.role === "source-declaration");
    assert.ok(declaration && declaration.providerCandidates.every((entry) => !entry.ref));
    const requests = nativeAcquisitionRequests(cold.requirements);
    const acquired = await acquireNativeSourceObjects({ declarations: requests.map((entry) => entry.declaration), sourceRoot: source, cache, gitDir: join(upstream, ".git") });
    assert.ok(acquired.every((entry) => entry.status === "acquired"));
    const owners = new Map(cold.requirements.map((entry) => [entry, { ownerRef: cold.parentComponent["bom-ref"], materializeRequirement: cold.materializeRequirement }]));
    const consumer = cold.requirements.find((entry) => entry.role === "software");
    const genuine = { name: "independent-widget", version: "2.4.6", type: "library", "bom-ref": "independent-owner",
      properties: [{ name: "cdx:version:kind", value: "release" }, { name: "cdx:build:consumerScope", value: "independently-evidenced-owner" },
        { name: "cdx:build:requirement", value: JSON.stringify(consumer) }] };
    const graph = cold.dependenciesList.map((edge) => ({ ...edge, dependsOn: [...edge.dependsOn, genuine["bom-ref"]] }));
    const result = materializeNativeAcquisitions([...cold.pkgList, genuine], graph, cold.requirements, source, options, new Set(requests.map((entry) => entry.key)), owners);
    const owner = result.pkgList.find((entry) => entry.name === "widget" && entry.version === "2.4.6");
    assert.ok(owner);
    assert.ok(declaration.providerCandidates.some((entry) => entry.ref === owner["bom-ref"]));
    assert.ok(result.dependencies.find((entry) => entry.ref === cold.parentComponent["bom-ref"]).dependsOn.includes(owner["bom-ref"]));
    const warm = parseCmakeLikeFile(manifest, "generic", options);
    const identities = (components) => components.map((entry) => [entry.name, entry.version, entry["bom-ref"]]).sort((a, b) => a[2].localeCompare(b[2]));
    assert.deepEqual(identities(result.pkgList), identities([...warm.pkgList, genuine]));
    assert.ok(result.pkgList.includes(genuine), "independently evidenced versioned software must not be treated as a declared-exact placeholder");
    const incompatible = result.pkgList.find((entry) => entry.name === "widget" && entry.version === "9.0");
    assert.ok(incompatible, "only the compatible declared-exact occurrence may be removed");
    const incompatibleRequirement = incompatible.properties.filter((entry) => entry.name === "cdx:build:requirement").map((entry) => JSON.parse(entry.value))[0];
    assert.deepEqual(incompatibleRequirement.conditions, cold.requirements.find((entry) => entry.constraints === "== 9.0").conditions);
    assert.ok(incompatibleRequirement.conditions.length);
    const expectedGraph = warm.dependenciesList.map((edge) => ({ ...edge, dependsOn: [...edge.dependsOn, genuine["bom-ref"]].sort() }));
    assert.deepEqual(result.dependencies.map((edge) => ({ ...edge, dependsOn: [...edge.dependsOn].sort() })), expectedGraph);
    const refs = new Set([cold.parentComponent["bom-ref"], ...result.pkgList.map((entry) => entry["bom-ref"])]);
    for (const edge of result.dependencies) for (const ref of [edge.ref, ...edge.dependsOn]) assert.ok(refs.has(ref));
    for (const requirement of cold.requirements) for (const candidate of requirement.providerCandidates || []) if (candidate.ref) assert.ok(refs.has(candidate.ref));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test("an immutable Git revision that authenticates below the constraint restores the warm consumer placeholder", async () => {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-excluded-git-owner-")); const source = join(root, "consumer"); const upstream = join(root, "upstream"); const cache = join(root, "cache");
  mkdirSync(join(source, "subprojects"), { recursive: true }); mkdirSync(upstream);
  const git = (...args) => execFileSync("/usr/bin/git", args, { encoding: "utf8", cwd: root, env: {
    PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
  } });
  try {
    writeFileSync(join(upstream, "CMakeLists.txt"), "project(widget VERSION 1.0.0)\n");
    git("init", "--quiet", upstream); git("-C", upstream, "add", "CMakeLists.txt");
    git("-C", upstream, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "commit", "--quiet", "-m", "Exact source fixture");
    const revision = git("-C", upstream, "rev-parse", "HEAD").trim();
    const manifest = join(source, "meson.build");
    writeFileSync(manifest, "project('Consumer')\nif get_option('enable_widget')\n  dependency('widget', version: '>= 2.0', fallback: ['widget', 'widget_dep'])\nendif\n");
    writeFileSync(join(source, "subprojects", "widget.wrap"), `[wrap-git]\nurl = https://github.com/acme/widget.git\nrevision = ${revision}\n`);
    const options = { sourceRoot: source, nativeSourceCache: cache };
    const cold = parseCmakeLikeFile(manifest, "generic", options);
    assert.deepEqual(cold.pkgList.map((entry) => entry.version), [revision], "the uninspected revision initially has no comparable numeric release");
    const requests = nativeAcquisitionRequests(cold.requirements);
    const acquired = await acquireNativeSourceObjects({ declarations: requests.map((entry) => entry.declaration), sourceRoot: source, cache, gitDir: join(upstream, ".git") });
    assert.ok(acquired.every((entry) => entry.status === "acquired"));
    const owners = new Map(cold.requirements.map((entry) => [entry, { ownerRef: cold.parentComponent["bom-ref"], materializeRequirement: cold.materializeRequirement }]));
    const result = materializeNativeAcquisitions(cold.pkgList, cold.dependenciesList, cold.requirements, source, options, new Set(requests.map((entry) => entry.key)), owners);
    const warm = parseCmakeLikeFile(manifest, "generic", options);
    assert.deepEqual(result.pkgList.map((entry) => [entry.name, entry.version, entry["bom-ref"]]), warm.pkgList.map((entry) => [entry.name, entry.version, entry["bom-ref"]]));
    assert.deepEqual(result.dependencies, warm.dependenciesList);
    assert.equal(typeof cold.materializeRequirement, "function");
    assert.ok(!Object.keys(cold).includes("materializeRequirement"), "generation-scoped construction callbacks must not enter serialized parser facts");
    const owner = result.pkgList.find((entry) => entry.version === "1.0.0");
    const placeholder = result.pkgList.find((entry) => !entry.version);
    assert.ok(owner && placeholder);
    const requirementsOf = (component) => component.properties.filter((entry) => entry.name === "cdx:build:requirement").map((entry) => JSON.parse(entry.value));
    assert.ok(!requirementsOf(owner).some((entry) => entry.constraints === ">= 2.0"), "excluded consumer occurrences must not remain attached to the newly inspected source owner");
    assert.ok(requirementsOf(placeholder).some((entry) => entry.constraints === ">= 2.0" && entry.providerCandidates.some((candidate) => candidate.ref === owner["bom-ref"])));
    const restored = requirementsOf(placeholder).find((entry) => entry.constraints === ">= 2.0");
    assert.deepEqual(restored.conditions, cold.requirements.find((entry) => entry.constraints === ">= 2.0").conditions);
    assert.ok(restored.conditions.length, "restoration must preserve the original unevaluated guard");
    assert.ok(owner.properties.some((entry) => entry.name === "cdx:source:revision" && entry.value === revision));
    const refs = new Set([cold.parentComponent["bom-ref"], ...result.pkgList.map((entry) => entry["bom-ref"])]);
    for (const edge of result.dependencies) for (const ref of [edge.ref, ...edge.dependsOn]) assert.ok(refs.has(ref));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test("mixed cached and cold immutable wraps classify the complete retained source alternative set", async () => {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-mixed-wrap-owners-")); const source = join(root, "consumer"); const cache = join(root, "cache");
  mkdirSync(join(source, "subprojects"), { recursive: true });
  const git = (...args) => execFileSync("/usr/bin/git", args, { encoding: "utf8", cwd: root, env: {
    PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
  } });
  try {
    const fixtures = [];
    for (const [name, version] of [["good", "2.4.6"], ["pending", "1.0.0"]]) {
      const upstream = join(root, name); mkdirSync(upstream);
      writeFileSync(join(upstream, "CMakeLists.txt"), `project(widget VERSION ${version})\n`);
      git("init", "--quiet", upstream); git("-C", upstream, "add", "CMakeLists.txt");
      git("-C", upstream, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "commit", "--quiet", "-m", "Exact source fixture");
      const revision = git("-C", upstream, "rev-parse", "HEAD").trim();
      writeFileSync(join(source, "subprojects", `${name}.wrap`), `[wrap-git]\nurl = https://github.com/acme/${name}.git\nrevision = ${revision}\n[provide]\ndependency_names = widget\n`);
      fixtures.push({ name, upstream, revision });
    }
    const manifest = join(source, "meson.build");
    writeFileSync(manifest, "project('Consumer')\nif get_option('enable_widget')\n  dependency('widget', version: '>= 2.0')\nendif\n");
    const options = { sourceRoot: source, nativeSourceCache: cache };
    const uncached = parseCmakeLikeFile(manifest, "generic", options);
    const goodRequest = nativeAcquisitionRequests(uncached.requirements).find((entry) => entry.declaration.gitRepository.endsWith("/good.git"));
    const cached = await acquireNativeSourceObjects({ declarations: [goodRequest.declaration], sourceRoot: source, cache, gitDir: join(fixtures[0].upstream, ".git") });
    assert.ok(cached.every((entry) => entry.status === "acquired"));
    const cold = parseCmakeLikeFile(manifest, "generic", options);
    assert.deepEqual(cold.pkgList.map((entry) => entry.version).sort(), ["2.4.6", fixtures[1].revision].sort());
    const pending = nativeAcquisitionRequests(cold.requirements).find((entry) => entry.declaration.gitRepository.endsWith("/pending.git"));
    const acquired = await acquireNativeSourceObjects({ declarations: [pending.declaration], sourceRoot: source, cache, gitDir: join(fixtures[1].upstream, ".git") });
    assert.ok(acquired.every((entry) => entry.status === "acquired"));
    const owners = new Map(cold.requirements.map((entry) => [entry, { ownerRef: cold.parentComponent["bom-ref"], materializeRequirement: cold.materializeRequirement }]));
    const result = materializeNativeAcquisitions(cold.pkgList, cold.dependenciesList, cold.requirements, source, options, new Set([pending.key]), owners);
    const warm = parseCmakeLikeFile(manifest, "generic", options);
    const identities = (components) => components.map((entry) => [entry.name, entry.version, entry["bom-ref"]]).sort((a, b) => a[2].localeCompare(b[2]));
    assert.deepEqual(identities(result.pkgList), identities(warm.pkgList), "an unchanged compatible source must prevent a cold-only unknown consumer");
    assert.deepEqual(result.dependencies.map((edge) => ({ ...edge, dependsOn: [...edge.dependsOn].sort() })), warm.dependenciesList.map((edge) => ({ ...edge, dependsOn: [...edge.dependsOn].sort() })));
    assert.deepEqual(result.pkgList.map((entry) => entry.version).sort(), ["1.0.0", "2.4.6"]);
    const requirementsOf = (component) => component.properties.filter((entry) => entry.name === "cdx:build:requirement").map((entry) => JSON.parse(entry.value));
    const compatible = result.pkgList.find((entry) => entry.version === "2.4.6");
    const excluded = result.pkgList.find((entry) => entry.version === "1.0.0");
    const consumer = requirementsOf(compatible).find((entry) => entry.constraints === ">= 2.0");
    assert.ok(consumer, "the unchanged authenticated source retains its consumer occurrence");
    assert.deepEqual(consumer.conditions, cold.requirements.find((entry) => entry.constraints === ">= 2.0").conditions);
    assert.ok(consumer.conditions.length);
    assert.ok(!requirementsOf(excluded).some((entry) => entry.constraints === ">= 2.0"));
    const refs = new Set([cold.parentComponent["bom-ref"], ...result.pkgList.map((entry) => entry["bom-ref"])]);
    for (const edge of result.dependencies) for (const ref of [edge.ref, ...edge.dependsOn]) assert.ok(refs.has(ref));
    for (const requirement of [...cold.requirements, ...result.pkgList.flatMap(requirementsOf)]) {
      for (const candidate of requirement.providerCandidates || []) if (candidate.ref) assert.ok(refs.has(candidate.ref), "retained and serialized candidate references must follow acquired identity remaps");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test("a fresh warm parse retains unrelated provider receipts when an authenticated wrap reference changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-stable-provider-receipt-")); const source = join(root, "source"); const cache = join(root, "cache");
  mkdirSync(join(source, "subprojects"), { recursive: true });
  const archive = gzipSync(Buffer.concat([tarFile("widget/CMakeLists.txt", "project(widget VERSION 2.4.6)\n"), Buffer.alloc(1024)]));
  writeFileSync(join(source, "meson.build"), "project('Consumer')\ndependency('widget', fallback: ['widget', 'widget_dep'])\ndependency('zlib')\n");
  writeFileSync(join(source, "subprojects", "widget.wrap"), `[wrap-file]\nsource_url = https://example.org/widget.tar.gz\nsource_filename = widget.tar.gz\nsource_hash = ${sha(archive)}\n`);
  const options = { multiProject: true, createMultiXBom: true, installDeps: false, introspect: false, nativeVersionProbes: false, deep: false, specVersion: 1.7,
    nativeSourceCache: cache, nativeProviderMetadata: [], nativeAcquire: true, nativeAcquireHosts: "example.org,wrapdb.mesonbuild.com" };
  const recipe = `[wrap-file]\nwrapdb_version = 1.2.13-1\nsource_url = https://example.org/zlib-1.2.13.tar.gz\nsource_hash = ${"a".repeat(64)}\n[provide]\ndependency_names = zlib\n`;
  const original = globalThis.fetch; const seen = [];
  try {
    globalThis.fetch = async (location) => {
      const url = String(location); seen.push(url);
      if (url === "https://example.org/widget.tar.gz") return new Response(archive);
      if (url === "https://wrapdb.mesonbuild.com/v2/releases.json") return new Response(JSON.stringify({ zlib: { dependency_names: ["zlib"], versions: ["1.2.13-1"] } }));
      if (url === "https://wrapdb.mesonbuild.com/v2/zlib_1.2.13-1/zlib.wrap") return new Response(recipe);
      throw new Error(`Unexpected provider request ${url}`);
    };
    const coldFacts = parseCmakeLikeFile(join(source, "meson.build"), "generic", { sourceRoot: source, nativeSourceCache: cache });
    const coldRef = coldFacts.requirements.find((entry) => entry.requestedName === "widget" && entry.role === "software").providerCandidates[0].ref;
    const cold = (await createCppBom(source, options)).bomJson;
    assert.ok(cold.components.some((entry) => entry.name === "zlib" && entry.version === "1.2.13"));
    const warmFacts = parseCmakeLikeFile(join(source, "meson.build"), "generic", { sourceRoot: source, nativeSourceCache: cache });
    const warmRef = warmFacts.requirements.find((entry) => entry.requestedName === "widget" && entry.role === "software").providerCandidates[0].ref;
    assert.notEqual(coldRef, warmRef, "the fixture must exercise a real discovery-dependent candidate reference");
    const calls = seen.length; globalThis.fetch = () => { throw new Error("fresh offline scan must retain the acquired unrelated context"); };
    const warm = (await createCppBom(source, { ...options, nativeAcquire: false })).bomJson;
    assert.equal(seen.length, calls);
    assert.ok(warm.components.some((entry) => entry.name === "zlib" && entry.version === "1.2.13"));
    const properties = [...(warm.metadata.properties || []), ...(warm.metadata.component?.properties || [])];
    assert.ok(properties.some((entry) => entry.name === "cdx:native:acquisition" && JSON.parse(entry.value).family === "registry" && JSON.parse(entry.value).status === "cached"));
  } finally { globalThis.fetch = original; rmSync(root, { recursive: true, force: true }); }
});
