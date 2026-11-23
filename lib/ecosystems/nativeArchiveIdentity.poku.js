import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "poku";
import { create as createTar } from "tar";
import { acquireNativeArchiveIdentity, nativeArchiveIdentityEvidence } from "./nativeArchiveIdentity.js";
import { nativeDownloadCacheKey } from "./nativeDownloadSources.js";

const url = "https://mirror.example.org/arbitrary-package.tar.gz";
const manifest = "project(VectorThing VERSION 1.2.3 LANGUAGES CXX)\n";
const banner = "// VectorThing version 1.2.3\n// https://github.com/example/vector-thing\n#ifndef VECTOR_THING_HPP\n#define VECTOR_THING_HPP\n#endif\n";

async function fixture(check) {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-archive-owned-"));
  const cache = mkdtempSync(join(tmpdir(), "cdxgen-archive-evidence-"));
  try {
    const archive = join(cache, "artifact.tar.gz");
    const build = async (files, gzip = true) => {
      rmSync(join(root, "package"), { recursive: true, force: true });
      for (const [path, content] of Object.entries(files)) {
        const target = join(root, "package", path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
      }
      await createTar({ cwd: root, file: archive, gzip }, ["package"]);
      return archive;
    };
    await check({ root, cache, archive, build });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
}

test("archive-owned project and matching public header bind generic mirror identity", () => fixture(async ({ root, cache, archive, build }) => {
  await build({ "CMakeLists.txt": manifest, "include/vector_thing.hpp": banner });
  const acquired = await acquireNativeArchiveIdentity(archive, url, cache, root);
  assert.equal(acquired.repository, "https://github.com/example/vector-thing");
  assert.equal(acquired.version, "1.2.3");
  const passive = nativeArchiveIdentityEvidence(url, cache, root);
  assert.equal(passive.repository, acquired.repository);
  assert.equal(passive.version, "1.2.3");
  assert.equal(acquired.evidence.url, url);
  assert.equal(passive.evidence.url, url);
  assert.match(passive.evidence.archive.sha256, /^[0-9a-f]{64}$/);
  assert.ok(passive.evidence.fields.some((field) => field.path === "package/CMakeLists.txt" && field.field === "project.version"));
  assert.ok(passive.evidence.fields.some((field) => field.path === "package/include/vector_thing.hpp" && field.field === "repository"));
}));

test("archive identity does not borrow vendored headers, issue links, or mismatched versions", () => fixture(async ({ root, cache, archive, build }) => {
  for (const files of [
    { "CMakeLists.txt": manifest, "vendor/include/vector_thing.hpp": banner },
    { "CMakeLists.txt": manifest, "include/vector_thing.hpp": banner.replace("1.2.3", "9.9.9") },
    { "CMakeLists.txt": `${manifest}# https://github.com/example/vector-thing/issues/123\n`, "include/vector_thing.hpp": "// VectorThing version 1.2.3\n" },
    { "CMakeLists.txt": manifest, "include/dependency.hpp": banner },
    { "CMakeLists.txt": `if(FALSE)\n${manifest}endif()\n`, "include/vector_thing.hpp": banner },
    { "CMakeLists.txt": manifest, "include/vector_thing.hpp": banner,
      "single_include/vector_thing.hpp": banner.replace("example/vector-thing", "other/fork") },
  ]) {
    await build(files);
    assert.equal(await acquireNativeArchiveIdentity(archive, url, cache, root), undefined);
  }
}));

test("archive compression is detected from magic rather than a misleading mirror suffix", () => fixture(async ({ root, cache, archive, build }) => {
  await build({ "CMakeLists.txt": manifest, "include/vector_thing.hpp": banner }, false);
  const compressed = execFileSync("xz", ["--compress", "--stdout", archive], { timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
  writeFileSync(archive, compressed);
  assert.equal((await acquireNativeArchiveIdentity(archive, url, cache, root)).version, "1.2.3");
  assert.equal(nativeArchiveIdentityEvidence(url, cache, root).repository, "https://github.com/example/vector-thing");
}));

test("passive archive evidence rejects tampered metadata, changed archive bytes, and in-source caches", () => fixture(async ({ root, cache, archive, build }) => {
  await build({ "CMakeLists.txt": manifest, "include/vector_thing.hpp": banner });
  await acquireNativeArchiveIdentity(archive, url, cache, root);
  const recordPath = join(cache, "archive-identities", `${nativeDownloadCacheKey(url)}.json`);
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  const original = JSON.stringify(record);
  record.files[0].content += "\n# altered";
  writeFileSync(recordPath, JSON.stringify(record));
  assert.equal(nativeArchiveIdentityEvidence(url, cache, root), undefined);
  writeFileSync(recordPath, original);
  writeFileSync(join(cache, record.archive.path), "changed artifact");
  assert.equal(nativeArchiveIdentityEvidence(url, cache, root), undefined);
  assert.equal(nativeArchiveIdentityEvidence(url, cache, cache), undefined);
}));

test("explicit archive acquisition requires a source boundary and never creates in-source cache paths", () => fixture(async ({ root, cache, archive, build }) => {
  await build({ "CMakeLists.txt": manifest, "include/vector_thing.hpp": banner });
  const forbidden = join(root, "forbidden-cache");
  assert.equal(await acquireNativeArchiveIdentity(archive, url, forbidden, root), undefined);
  assert.equal(existsSync(forbidden), false);
  assert.equal(await acquireNativeArchiveIdentity(archive, url, root, root), undefined);
  assert.equal(existsSync(join(root, "archive-artifacts")), false);
  assert.equal(await acquireNativeArchiveIdentity(archive, url, cache), undefined);
  assert.equal(existsSync(join(cache, "archive-artifacts")), false);
}));

for (const redirected of ["archive-artifacts", "archive-identities"]) {
  test(`archive acquisition rejects an ancestor cache with ${redirected} redirected into its source tree`, () => fixture(async ({ cache, archive, build }) => {
    await build({ "CMakeLists.txt": manifest, "include/vector_thing.hpp": banner });
    const source = join(cache, "source");
    mkdirSync(source);
    symlinkSync(source, join(cache, redirected), "dir");
    assert.equal(await acquireNativeArchiveIdentity(archive, url, cache, source), undefined);
    assert.deepEqual(readdirSync(source), [], "source tree must remain untouched");
    assert.equal(nativeArchiveIdentityEvidence(url, cache, source), undefined);
  }));
}

test("archive acquisition never executes a source-relative PATH codec or forwards credentials", () => fixture(async ({ root, cache, archive, build }) => {
  await build({ "CMakeLists.txt": manifest, "include/vector_thing.hpp": banner }, false);
  writeFileSync(archive, execFileSync("xz", ["--compress", "--stdout", archive], { timeout: 15000, maxBuffer: 4 * 1024 * 1024 }));
  mkdirSync(join(root, "bin"));
  const marker = join(root, "codec-credential-leak");
  writeFileSync(join(root, "bin", "xz"), `#!/bin/sh\nprintf '%s' "$CDXGEN_FAKE_CREDENTIAL" > "${marker}"\nexit 1\n`, { mode: 0o755 });
  const cli = fileURLToPath(new URL("../../contrib/native-archive-identity-cache.js", import.meta.url));
  const result = execFileSync(process.execPath, [cli, "--archive", archive, "--url", url, "--cache", cache, "--source-root", root], {
    cwd: root, env: { ...process.env, PATH: "./bin", CDXGEN_FAKE_CREDENTIAL: "must-not-leak" },
    encoding: "utf8", timeout: 20000, maxBuffer: 1024 * 1024,
  });
  assert.equal(JSON.parse(result).version, "1.2.3");
  assert.equal(existsSync(marker), false);
}));
