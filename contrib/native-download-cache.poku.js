import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert, test } from "poku";
import { cacheNativeDownload, inspectInstallerHeader, githubReleaseIdentity } from "./native-download-cache.js";
import { nativeDownloadIdentity } from "../lib/ecosystems/nativeDownloadSources.js";

test("constructor release comes from installer metadata, not constructor version", () => {
  assert.deepEqual(inspectInstallerHeader("# Created by constructor 3.17.3\n# NAME: Miniforge3\n# VER: 26.9.4-1\n# PLAT: linux-64\n"), {
    name: "Miniforge3", version: "26.9.4-1", source: "constructor installer NAME/VER header",
  });
});
test("CPack package version remains distinct from the enclosing release tag", () => {
  assert.deepEqual(inspectInstallerHeader('echo "timemory-timem Installer Version: 1.0.0, Copyright (c) Example"'), {
    name: "timemory-timem", version: "1.0.0", source: "CPack installer version header",
  });
  assert.deepEqual(githubReleaseIdentity("https://github.com/ROCm/timemory/releases/download/timemory-timem%2Fv0.0.4/timemory-timem-1.0.0-Linux.sh"), {
    repository: "https://github.com/ROCm/timemory", tag: "timemory-timem/v0.0.4", name: "timemory",
  });
});
test("floating labels and filenames alone do not establish artifact versions", () => {
  assert.equal(githubReleaseIdentity("https://github.com/example/project/releases/latest/download/setup-9.0.sh"), undefined);
  assert.equal(githubReleaseIdentity("https://github.com/example/project/releases/download/latest/setup-9.0.sh"), undefined);
  assert.equal(inspectInstallerHeader("# install setup-9.0.sh\n"), undefined);
});

await test("rejects cache descendants that redirect acquisition into the source tree", async () => {
  for (const child of ["downloads", "download-artifacts"]) {
    const root = mkdtempSync(join(tmpdir(), "cdxgen-download-boundary-"));
    const source = join(root, "source");
    const cache = join(root, "cache");
    mkdirSync(source); mkdirSync(cache);
    symlinkSync(source, join(cache, child), "dir");
    try {
      await assert.rejects(cacheNativeDownload({ url: "https://example.invalid/unreachable", cache, sourceRoot: source }), /must not be symlinks/);
      assert.deepEqual(readdirSync(source), [], "no acquisition directory or artifact may be created in source");
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

await test("latest GitHub assets retain the concrete release before a signed CDN redirect", async () => {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-download-redirects-")); const source = join(root, "source"); mkdirSync(source);
  const url = "https://github.com/acme/tool/releases/latest/download/setup.sh";
  const releaseUrl = "https://github.com/acme/tool/releases/download/v2.4.6/setup.sh";
  const transportUrl = "https://release-assets.githubusercontent.com/asset?token=opaque";
  const original = globalThis.fetch; const seen = [];
  try {
    globalThis.fetch = async (location) => {
      seen.push(String(location));
      if (String(location) === url) return new Response(null, { status: 302, headers: { location: releaseUrl } });
      if (String(location) === releaseUrl) return new Response(null, { status: 302, headers: { location: transportUrl } });
      assert.equal(String(location), transportUrl);
      return new Response("#!/bin/sh\n# NAME: tool\n# VER: 2.4.6\n");
    };
    const cache = join(root, "cache");
    const result = await cacheNativeDownload({ url, cache, sourceRoot: source });
    assert.deepEqual(seen, [url, releaseUrl, transportUrl]);
    assert.equal(result.releaseTag, "v2.4.6");
    assert.equal(result.resolvedUrl, releaseUrl);
    assert.equal(result.transportUrl, transportUrl.split("?")[0], "signed transport credentials must not enter retained provenance");
    assert.deepEqual(result.redirectChain, [url, releaseUrl, transportUrl.split("?")[0]]);
    globalThis.fetch = () => { throw new Error("passive identity must not fetch"); };
    const identity = nativeDownloadIdentity(url, cache, source);
    assert.equal(identity.releaseTag, "v2.4.6");
    assert.equal(identity.version, "2.4.6");
  } finally { globalThis.fetch = original; rmSync(root, { recursive: true, force: true }); }
});
