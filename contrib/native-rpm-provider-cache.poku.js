import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "poku";

import { nativeProviderExecutionContext } from "./native-provider-process.js";
import { acquireNativeRpmMetadata, assertRpmCacheDirectory, nativeRpmCapabilities, nativeRpmFilePatterns, parseNativeRpmQuery } from "./native-rpm-provider-cache.js";

await describe("official RPM metadata acquisition", async () => {
  it("derives file-provider queries from discovery commands without package-name or version guesses", () => {
    const patterns = nativeRpmFilePatterns([
      { requestedName: "example", command: "find_library", alternatives: ["example", "example-compat", "libexact.so.3", "../escape"] },
      { requestedName: "libexact.a", command: "find_library" },
      { requestedName: "ExampleSDK", command: "find_package" },
      { requestedName: "example-pc", command: "dependency", constraints: ">=9.1" },
      { requestedName: "${DYNAMIC}", command: "find_library" },
      { requestedName: "NotAnExport", command: "fetch" },
    ]);
    assert.deepEqual(patterns, [
      "*/ExampleSDKConfig.cmake", "*/example-pc.pc", "*/examplesdk-config.cmake",
      "*/libexact.a", "*/libexact.so.3", "*/libexample-compat.a", "*/libexample-compat.so", "*/libexample.a", "*/libexample.so",
    ]);
  });

  it("queries literal header basenames and complete platform library filenames without fabricating suffixes", () => {
    const requirements = [
      { requestedName: "api/header.h", command: "find_path", alternatives: ["api/header.h", "header_alt.hpp", "../escape.h", "${ROOT}/hidden.h"] },
      { requestedName: "api/header.h", command: "find_file" },
      { requestedName: "libexact.dylib", command: "find_library" },
      { requestedName: "example.lib", command: "find_library" },
      { requestedName: "example.dll", command: "find_library" },
      { requestedName: "config.cmake", command: "find_file" },
    ];
    assert.deepEqual(nativeRpmFilePatterns(requirements), [
      "*/example.dll", "*/example.lib", "*/header.h", "*/header_alt.hpp", "*/libexact.dylib",
    ]);
    assert.deepEqual(nativeRpmCapabilities(requirements), []);
  });

  it("uses exact indexed virtual capabilities without inventing SONAME major versions or static provides", () => {
    assert.deepEqual(nativeRpmCapabilities([
      { requestedName: "example", command: "find_library", alternatives: ["example-compat", "libalternate.a", "${DYNAMIC}"] },
      { requestedName: "libexact.so.3", command: "find_library" },
      { requestedName: "libstatic.a", command: "find_library" },
      { requestedName: "ExampleSDK", command: "find_package" },
      { requestedName: "example-pc", command: "dependency" },
    ]), ["cmake(ExampleSDK)", "cmake(examplesdk)", "libexact.so.3()(64bit)", "libexample-compat.so()(64bit)", "libexample.so()(64bit)", "pkgconfig(example-pc)"]);
  });

  it("queries indexed file ownership for literal find_program names and stops at search controls", () => {
    const requirements = [
      { requestedName: "schema-gen", command: "find_program", alternatives: ["schema-gen", "schema-alt", "../escape", "${UNKNOWN}"], arguments: ["GEN", "NAMES", "schema-gen", "schema-alt", "../escape", "${UNKNOWN}", "HINTS", "not-a-name"] },
      { requestedName: "pkgtool", command: "find_program", arguments: ["PKG", "pkgtool", "/other/bin"] },
    ];
    const paths = ["/usr/bin/pkgtool", "/usr/bin/schema-alt", "/usr/bin/schema-gen", "/usr/libexec/pkgtool", "/usr/libexec/schema-alt",
      "/usr/libexec/schema-gen", "/usr/sbin/pkgtool", "/usr/sbin/schema-alt", "/usr/sbin/schema-gen"];
    assert.deepEqual(nativeRpmFilePatterns(requirements), paths);
    assert.deepEqual(nativeRpmCapabilities(requirements), paths);
  });

  it("preserves independent RPM EVR and complete newline-separated file ownership", () => {
    const us = "\u001f";
    const raw = ["owner-devel", "2", "7.4.1", "9.fc44", "x86_64", "updates", "/usr/lib64/libapi.so\n/usr/lib64/pkgconfig/api.pc\n/usr/share/doc/owner/read me.txt"].join(us) + "\u001e\n";
    assert.deepEqual(parseNativeRpmQuery(raw), [{
      name: "owner-devel", epoch: "2", version: "7.4.1", release: "9.fc44", arch: "x86_64", repoid: "updates",
      files: ["/usr/lib64/libapi.so", "/usr/lib64/pkgconfig/api.pc", "/usr/share/doc/owner/read me.txt"],
    }]);
    assert.throws(() => parseNativeRpmQuery(raw.replace("updates", "untrusted-repo")));
    assert.throws(() => parseNativeRpmQuery(raw.replace("/usr/lib64/libapi.so", "/usr/../escape.so")));
    assert.throws(() => parseNativeRpmQuery(raw.replace("\u001e", "")));
  });

  it("ignores source PATH executables and strips ambient credentials from DNF execution", () => {
    const directory = mkdtempSync(join(tmpdir(), "rpm-provider-execution-"));
    const source = join(directory, "source");
    const cache = join(directory, "cache");
    const previousPath = process.env.PATH;
    const previousCredential = process.env.AWS_SECRET_ACCESS_KEY;
    try {
      mkdirSync(join(source, "bin"), { recursive: true });
      mkdirSync(cache);
      for (const command of ["dnf", "tar", "unzip"]) writeFileSync(join(source, "bin", command), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
      process.env.PATH = `./bin:${join(source, "bin")}:${previousPath || ""}`;
      process.env.AWS_SECRET_ACCESS_KEY = "must-not-reach-dnf";
      const context = nativeProviderExecutionContext(source, cache, ["dnf", "tar", "unzip"]);
      for (const executable of Object.values(context.executables)) {
        assert.ok(executable.startsWith("/"));
        assert.equal(executable.startsWith(source), false);
      }
      assert.equal(context.cwd, cache);
      assert.equal(context.env.AWS_SECRET_ACCESS_KEY, undefined);
      assert.equal(context.env.PATH.includes(source), false);
      assert.equal(context.env.PATH.split(":").some((path) => !path.startsWith("/")), false);
      assert.deepEqual(Object.keys(context.env).sort(), ["HOME", "LANG", "LC_ALL", "PATH", "TMPDIR", "XDG_CACHE_HOME"]);
    } finally {
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
      if (previousCredential === undefined) delete process.env.AWS_SECRET_ACCESS_KEY; else process.env.AWS_SECRET_ACCESS_KEY = previousCredential;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects preexisting cache descendant symlinks before DNF writes through them", () => {
    const directory = mkdtempSync(join(tmpdir(), "rpm-provider-paths-"));
    try {
      mkdirSync(join(directory, "cache"));
      mkdirSync(join(directory, "outside"));
      symlinkSync(join(directory, "outside"), join(directory, "cache", "dnf-state"));
      assert.throws(() => assertRpmCacheDirectory(join(directory, "cache")));
      rmSync(join(directory, "cache", "dnf-state"));
      symlinkSync(join(directory, "missing"), join(directory, "cache", "dnf-state"));
      assert.throws(() => assertRpmCacheDirectory(join(directory, "cache")));
      rmSync(join(directory, "cache", "dnf-state"));
      assertRpmCacheDirectory(join(directory, "cache"));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  await it("cold acquires original RPM indexes with repomd checksums and reuses them without network", async () => {
    const directory = mkdtempSync(join(tmpdir(), "rpm-cold-metadata-")); const source = join(directory, "source"); mkdirSync(source);
    const primary = Buffer.from("actual compressed primary bytes"); const filelists = Buffer.from("actual compressed filelist bytes");
    const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
    const repomd = `<repomd>${[["primary", primary], ["filelists", filelists]].map(([type, bytes]) =>
      `<data type="${type}"><checksum type="sha256">${sha(bytes)}</checksum><location href="repodata/${type}.xml.gz"/></data>`).join("")}</repomd>`;
    const original = globalThis.fetch; const seen = [];
    try {
      globalThis.fetch = async (url) => {
        seen.push(String(url));
        return new Response(String(url).endsWith("repomd.xml") ? repomd : String(url).endsWith("primary.xml.gz") ? primary : filelists);
      };
      const options = { repositories: ["fedora=https://example.org/releases/44/"], output: join(directory, "cache"), sourceRoot: source, allowedHosts: "example.org" };
      const cold = await acquireNativeRpmMetadata({ ...options, fetch: true });
      assert.equal(seen.length, 3);
      assert.equal(cold[0].indexes.length, 2);
      assert.equal(cold[0].repomdSha256, sha(repomd));
      globalThis.fetch = () => { throw new Error("warm metadata must not fetch"); };
      const warm = await acquireNativeRpmMetadata({ ...options, fetch: false });
      assert.deepEqual(warm, cold);
    } finally { globalThis.fetch = original; rmSync(directory, { recursive: true, force: true }); }
  });

  await it("rejects forged cold RPM index bytes rather than relying on a cacheonly repository query", async () => {
    const directory = mkdtempSync(join(tmpdir(), "rpm-cold-checksum-")); const source = join(directory, "source"); mkdirSync(source);
    const original = globalThis.fetch;
    try {
      globalThis.fetch = async (url) => new Response(String(url).endsWith("repomd.xml") ?
        `<repomd><data type="primary"><checksum type="sha256">${"a".repeat(64)}</checksum><location href="repodata/primary.xml.gz"/></data></repomd>` : "forged");
      await assert.rejects(acquireNativeRpmMetadata({ repositories: ["fedora=https://example.org/releases/44/"], output: join(directory, "cache"),
        sourceRoot: source, allowedHosts: "example.org", fetch: true }), /checksum mismatch/);
    } finally { globalThis.fetch = original; rmSync(directory, { recursive: true, force: true }); }
  });
});
