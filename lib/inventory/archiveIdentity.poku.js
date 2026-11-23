import { strict as assert, describe, test } from "poku";

import { archiveIdentity } from "./archiveIdentity.js";

describe("archive identity", () => {
  test("reads a release archive and SQLite's encoded upstream release", () => {
    assert.deepEqual(archiveIdentity("https://example.org/libexample-3.7.2.tar.xz"), { version: "3.7.2", kind: "release" });
    assert.deepEqual(archiveIdentity("https://sqlite.org/2026/sqlite-amalgamation-3510300.zip"), { version: "3.51.3", kind: "release" });
  });
  test("labels a pinned archive revision without inventing a release", () => {
    const revision = "24e3075e68ebe17c0b529bb24bfda819db5e2f3b";
    assert.deepEqual(archiveIdentity(`https://android.googlesource.com/platform/tools/apksig/+archive/${revision}.tar.gz`), { version: revision, kind: "source-revision" });
  });
  test("does not infer versions from checksums, dates or arbitrary URL queries", () => {
    assert.equal(archiveIdentity("https://example.org/2026/source.zip?version=2.4.0"), undefined);
    assert.equal(archiveIdentity("https://example.org/latest.tar.gz"), undefined);
  });
});
