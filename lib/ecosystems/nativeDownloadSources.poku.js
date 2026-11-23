import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "poku";
import { nativeDownloadCacheKey, nativeDownloadIdentity } from "./nativeDownloadSources.js";

function fixture(check) {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-download-root-"));
  const cache = mkdtempSync(join(tmpdir(), "cdxgen-download-cache-"));
  try {
    mkdirSync(join(cache, "downloads"));
    const artifactBytes = Buffer.from("# installer metadata\n");
    const sha256 = createHash("sha256").update(artifactBytes).digest("hex");
    mkdirSync(join(cache, "download-artifacts"));
    writeFileSync(join(cache, "download-artifacts", sha256), artifactBytes);
    const url = "https://github.com/vendor/tool/releases/latest/download/tool.sh";
    const record = { schema: 1, url, resolvedUrl: "https://github.com/vendor/tool/releases/download/26.1.0/tool.sh",
      observedAt: "2026-11-04T12:00:00.000Z", sha256, bytes: artifactBytes.length, artifact: `download-artifacts/${sha256}`, name: "tool", type: "application",
      releaseTag: "26.1.0", evidence: ["GitHub release redirect and asset SHA256"] };
    const save = (value) => writeFileSync(join(cache, "downloads", `${nativeDownloadCacheKey(url)}.json`), JSON.stringify(value));
    save(record);
    check({ root, cache, url, record, save });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
}

test("cached latest downloads use concrete release metadata without networking", () => fixture(({ root, cache, url, record }) => {
  const identity = nativeDownloadIdentity(url, cache, root);
  assert.equal(identity.version, "26.1.0");
  assert.equal(identity.kind, "release-artifact");
  assert.equal(identity.sha256, record.sha256);
  assert.equal(nativeDownloadIdentity(url, undefined, root), undefined);
}));

test("download metadata cannot claim latest or unrelated release redirects as a version", () => fixture(({ root, cache, url, record, save }) => {
  for (const bad of [
    { ...record, releaseTag: "latest" },
    { ...record, url: "https://example.org/other" },
    { ...record, releaseTag: "26.2.0" },
    { ...record, sha256: "invalid" },
    { ...record, observedAt: "not-a-time" },
    { ...record, evidence: [] },
  ]) {
    save(bad);
    assert.equal(nativeDownloadIdentity(url, cache, root), undefined);
  }
}));

test("cached ISA generator data retains artifact identity without a software version", () => fixture(({ root, cache, url, record, save }) => {
  save({ ...record, type: "data", name: "machine-readable-isa", releaseTag: undefined,
    resolvedUrl: "https://gpuopen.com/downloads/isa-spec-2026.zip", evidence: ["Archive contains ISA XML descriptions consumed by --xml_dir"] });
  const identity = nativeDownloadIdentity(url, cache, root);
  assert.equal(identity.type, "data");
  assert.equal(identity.version, undefined);
  assert.equal(identity.sha256, record.sha256);
}));

test("inspected installer version takes precedence over its containing release tag", () => fixture(({ root, cache, url, record, save }) => {
  save({ ...record, releaseTag: "timemory-timem/v0.0.4",
    resolvedUrl: "https://github.com/vendor/tool/releases/download/timemory-timem%2Fv0.0.4/tool.sh",
    artifactVersion: "1.0.0", artifactVersionSource: "CPack installer header" });
  const identity = nativeDownloadIdentity(url, cache, root);
  assert.equal(identity.version, "1.0.0");
  assert.equal(identity.artifactVersion, "1.0.0");
  assert.equal(identity.releaseTag, "timemory-timem/v0.0.4");
}));

test("download metadata cache must remain outside the scanned source tree", () => fixture(({ root, url, record }) => {
  const cache = join(root, "cache");
  mkdirSync(join(cache, "downloads"), { recursive: true });
  writeFileSync(join(cache, "downloads", `${nativeDownloadCacheKey(url)}.json`), JSON.stringify(record));
  assert.equal(nativeDownloadIdentity(url, cache, root), undefined);
}));

test("passive download identity rejects corrupted artifact bytes and mismatching declared hashes", () => fixture(({ root, cache, url, record }) => {
  assert.ok(nativeDownloadIdentity(url, cache, root, `SHA256=${record.sha256}`));
  assert.equal(nativeDownloadIdentity(url, cache, root, `SHA256=${"a".repeat(64)}`), undefined);
  assert.equal(nativeDownloadIdentity(url, cache, root, `SHA256=${record.sha256}=extra`), undefined);
  writeFileSync(join(cache, record.artifact), "changed bytes");
  assert.equal(nativeDownloadIdentity(url, cache, root), undefined);
}));
