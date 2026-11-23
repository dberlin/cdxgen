import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { strict as assert, test } from "poku";

import { acquireNativeEvidence } from "../lib/cli/nativeAcquisition.js";
import { loadNativeExternalMetadata } from "../lib/ecosystems/nativeExternalMetadata.js";

const sha = (value) => createHash("sha256").update(value).digest("hex");

if (process.platform === "linux" && existsSync("/usr/bin/gpg") && existsSync("/usr/bin/gpgv")) await test("Debian package owners require both signed indexes and exact executable inventory", async () => {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-signed-deb-"));
  const source = join(root, "source"); const cache = join(root, "cache");
  const keydir = join(root, "keys"); const keyring = join(root, "trusted.gpg");
  mkdirSync(source); mkdirSync(keydir, { mode: 0o700 });
  const gpg = (args, input) => execFileSync("/usr/bin/gpg", ["--homedir", keydir, "--batch", "--no-tty", ...args], { input, stdio: ["pipe", "pipe", "pipe"] });
  const original = globalThis.fetch;
  try {
    gpg(["--pinentry-mode", "loopback", "--passphrase", "", "--quick-generate-key", "Fixture <fixture@example.invalid>", "ed25519", "sign", "0"]);
    writeFileSync(keyring, gpg(["--export"]));
    const owner = "Package: actual-owner\nVersion: 2:3.1-4\nArchitecture: amd64\nFilename: pool/main/a/actual-owner_3.1-4_amd64.deb\nSHA256: " + "a".repeat(64) + "\n";
    const shell = owner.replaceAll("actual-owner", "find-me").replace("2:3.1-4", "99.9");
    const contents = gzipSync("usr/bin/find-me\tutils/actual-owner\nusr/share/doc/find-me/find-me utils/find-me\nusr/libexec/helpers/real.cmd utils/actual-owner\nusr/bin/exe-only.exe utils/actual-owner\nusr/bin/history utils/ambiguous-owner\n");
    const ambiguous = owner.replaceAll("actual-owner", "ambiguous-owner");
    const packages = gzipSync(`${shell}\n${owner}\n${ambiguous}\n${ambiguous.replace("2:3.1-4", "3:4.0-1")}\n`);
    const allControl = owner.replaceAll("actual-owner", "neutral-owner").replaceAll("amd64", "all");
    const local = new Map([["main/Contents-amd64.gz", contents], ["main/binary-amd64/Packages.gz", packages],
      ["main/Contents-all.gz", gzipSync("usr/bin/neutral-command utils/neutral-owner\n")],
      ["main/binary-all/Packages.gz", gzipSync(allControl)]]);
    const text = "Suite: sandbox\nCodename: sandbox\nSHA256:\n" + [...local].map(([path, bytes]) => ` ${sha(bytes)} ${bytes.length} ${path}\n`).join("");
    const release = gpg(["--clearsign"], text);
    const base = "https://example.org/debian/dists/sandbox/";
    let tamper = true; const seen = [];
    const respond = globalThis.fetch = async (url) => {
      const path = String(url).slice(base.length); seen.push(path);
      if (path === "InRelease") return new Response(release);
      assert.ok(local.has(path));
      return new Response(tamper && path.endsWith("Packages.gz") ? Buffer.from(packages).fill(0) : local.get(path));
    };
    const requirements = [{ role: "tool", command: "find_program", requestedName: "find-me", file: "CMakeLists.txt", line: 2,
      arguments: ["TOOL", "NAMES", "find-me", "helpers/real.cmd", "neutral-command", "history", "exe-only", "exe-only.exe", "../unsafe", "PATHS", "/local/wrong"] }];
    const options = { nativeSourceCache: cache, nativeDebRepositories: `https://example.org/debian|sandbox|main|amd64|${keyring}`,
      nativeAcquire: true, nativeAcquireHosts: "example.org" };
    const rejected = await acquireNativeEvidence(requirements, source, options);
    assert.deepEqual(loadNativeExternalMetadata(rejected.options), []);
    assert.ok(rejected.diagnostics.find((entry) => entry.family === "deb")?.blockers.some((entry) => /hash or size mismatch/.test(entry.prerequisite)));
    tamper = false;
    const cold = await acquireNativeEvidence(requirements, source, options);
    const acquired = cold.diagnostics.find((entry) => entry.family === "deb");
    assert.equal(acquired?.status, "partial");
    assert.ok(acquired.blockers.some((entry) => entry.requestedName === "history" && /ambiguous package/.test(entry.prerequisite)));
    assert.ok(acquired.blockers.some((entry) => entry.requestedName === "exe-only"));
    assert.equal(seen.length, 6, "a partial retry only downloads absent indexes");
    const providers = loadNativeExternalMetadata(cold.options);
    const provider = providers.find((entry) => entry.name === "actual-owner");
    assert.equal(provider.version, "2:3.1-4");
    assert.equal(provider.packageSha256, "a".repeat(64));
    assert.deepEqual(providers.find((entry) => entry.name === "neutral-owner")?.exports.map((entry) => entry.name), ["neutral-command"]);
    assert.deepEqual(provider.exports.map((entry) => [entry.name, entry.file]), [
      ["exe-only.exe", "/usr/bin/exe-only.exe"],
      ["find-me", "/usr/bin/find-me"], ["helpers/real.cmd", "/usr/libexec/helpers/real.cmd"],
    ]);
    globalThis.fetch = () => { throw new Error("offline must not fetch"); };
    const warm = await acquireNativeEvidence(requirements, source, { ...options, nativeAcquire: false });
    assert.equal(warm.diagnostics.find((entry) => entry.family === "deb")?.status, "partial");
    assert.deepEqual(loadNativeExternalMetadata(warm.options), providers);
    const descriptor = readdirSync(join(cache, "acquisitions")).find((name) => name.endsWith(".deb-replay.json"));
    assert.ok(descriptor, "cold acquisition emits an explicit replay selector");
    const replayOptions = { ...options, nativeAcquire: false, nativeSourceCache: undefined,
      nativeDebReplay: [join(cache, "acquisitions", descriptor)] };
    const expandedRequirements = [
      { ...requirements[0], arguments: ["TOOL", "NAMES", "find-me", "exe-only", "exe-only.exe"] },
      { role: "tool", command: "find_program", requestedName: "unrelated", file: "subdir/CMakeLists.txt", line: 9 },
    ];
    const focused = await acquireNativeEvidence(expandedRequirements, source, replayOptions);
    assert.deepEqual(loadNativeExternalMetadata(focused.options).map(({ name, version, exports }) =>
      [name, version, exports.map((entry) => [entry.name, entry.file])]),
      [["actual-owner", "2:3.1-4", [["exe-only.exe", "/usr/bin/exe-only.exe"], ["find-me", "/usr/bin/find-me"]]]]);
    const focusedDiagnostic = focused.diagnostics.find((e) => e.family === "deb-replay");
    assert.ok(focusedDiagnostic?.blockers.some((entry) => entry.requestedName === "exe-only"));
    const noOverlap = await acquireNativeEvidence([{ ...requirements[0], arguments: ["TOOL", "NAMES", "unrelated"] }], source, replayOptions);
    assert.deepEqual(loadNativeExternalMetadata(noOverlap.options), []);
    for (const configured of [undefined, options.nativeDebRepositories.replace("|sandbox|", "|other|"),
      options.nativeDebRepositories.replace("|amd64|", "|arm64|")]) {
      const mismatch = await acquireNativeEvidence(expandedRequirements, source, { ...replayOptions, nativeDebRepositories: configured });
      assert.deepEqual(loadNativeExternalMetadata(mismatch.options), []);
    }
    // Updating unsigned cache digests cannot manufacture a signed owner.
    const receiptPath = join(cache, "acquisitions", descriptor.replace(".deb-replay.json", ".json"));
    const receiptText = readFileSync(receiptPath, "utf8");
    const receipt = JSON.parse(receiptText);
    const manifestPath = join(cache, receipt.manifests[0].path);
    const manifestText = readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(manifestText);
    const entry = manifest.providers.find(({ metadata }) => join(cache, "deb", metadata.path) === provider.metadataPath);
    const controlText = readFileSync(provider.metadataPath, "utf8");
    const forgedControl = controlText.replace("Version: 2:3.1-4", "Version: 999.0");
    entry.metadata.sha256 = sha(forgedControl);
    const forgedManifest = JSON.stringify(manifest);
    receipt.manifests[0].sha256 = sha(forgedManifest);
    writeFileSync(provider.metadataPath, forgedControl);
    writeFileSync(manifestPath, forgedManifest);
    writeFileSync(receiptPath, JSON.stringify(receipt));
    const forged = await acquireNativeEvidence(expandedRequirements, source, replayOptions);
    assert.deepEqual(loadNativeExternalMetadata(forged.options), []);
    writeFileSync(receiptPath, receiptText);
    writeFileSync(manifestPath, manifestText);
    writeFileSync(provider.metadataPath, controlText);
    writeFileSync(join(cache, "deb", provider.repositoryEvidence.packages.path), "changed index");
    const changed = await acquireNativeEvidence(requirements, source, { ...options, nativeAcquire: false });
    assert.deepEqual(loadNativeExternalMetadata(changed.options), []);
    assert.ok(changed.diagnostics.find((entry) => entry.family === "deb")?.blockers.some((entry) => /failed authentication/.test(entry.prerequisite)));
    const changedFocused = await acquireNativeEvidence(expandedRequirements, source, replayOptions);
    assert.deepEqual(loadNativeExternalMetadata(changedFocused.options), []);
    globalThis.fetch = respond;
    const recovered = await acquireNativeEvidence(requirements, source, options);
    assert.deepEqual(loadNativeExternalMetadata(recovered.options), providers);
    assert.deepEqual(seen.slice(6), ["main/binary-amd64/Packages.gz"]);
    writeFileSync(keyring, "a different trust anchor at the same path");
    const changedKey = await acquireNativeEvidence(requirements, source, { ...options, nativeAcquire: false });
    assert.deepEqual(loadNativeExternalMetadata(changedKey.options), []);
    const changedFocusedKey = await acquireNativeEvidence(expandedRequirements, source, replayOptions);
    assert.deepEqual(loadNativeExternalMetadata(changedFocusedKey.options), []);
  } finally { globalThis.fetch = original; rmSync(root, { recursive: true, force: true }); }
});
