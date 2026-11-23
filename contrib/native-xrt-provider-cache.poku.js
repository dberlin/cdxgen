import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { strict as assert, test } from "poku";

import { acquireNativeEvidence } from "../lib/cli/nativeAcquisition.js";
import { loadNativeExternalMetadata } from "../lib/ecosystems/nativeExternalMetadata.js";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const tools = ["/usr/bin/ar", "/usr/bin/gpg", "/usr/bin/gpgv", "/usr/bin/tar"];

if (process.platform === "linux" && tools.every(existsSync)) await test("AMD's signed PPA without Contents resolves exact executable archive members and replays offline", async () => {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-signed-xrt-"));
  const source = join(root, "source"); const cache = join(root, "cache");
  const keydir = join(root, "keys"); const keyring = join(root, "trusted.gpg");
  const data = join(root, "data"); const metadata = join(root, "control");
  const original = globalThis.fetch;
  try {
    mkdirSync(source); mkdirSync(keydir, { mode: 0o700 }); mkdirSync(metadata);
    mkdirSync(join(data, "usr", "bin"), { recursive: true });
    mkdirSync(join(data, "usr", "share", "doc"), { recursive: true });
    writeFileSync(join(data, "usr", "bin", "xrt-smi"), "do not run this", { mode: 0o755 });
    writeFileSync(join(data, "usr", "bin", "xclbinutil"), "do not run this", { mode: 0o755 });
    writeFileSync(join(data, "usr", "bin", "aie-hsaco"), "not executable");
    writeFileSync(join(data, "usr", "share", "doc", "aiebu-asm"), "not a program", { mode: 0o755 });
    writeFileSync(join(root, "debian-binary"), "2.0\n");
    const control = "Package: libxrt-utils\nSource: xrt\nVersion: 1:8.7-3\nArchitecture: amd64\n";
    writeFileSync(join(metadata, "control"), control);
    execFileSync("/usr/bin/tar", ["-czf", join(root, "control.tar.gz"), "-C", metadata, "./control"]);
    execFileSync("/usr/bin/tar", ["-czf", join(root, "data.tar.gz"), "-C", data, "."]);
    execFileSync("/usr/bin/ar", ["q", "package.deb", "debian-binary", "control.tar.gz", "data.tar.gz"],
      { cwd: root, stdio: ["ignore", "ignore", "pipe"] });
    const bytes = readFileSync(join(root, "package.deb"));
    const filename = "pool/main/x/xrt/libxrt-utils_8.7-3_amd64.deb";
    const packages = gzipSync(`${control}Filename: ${filename}\nSize: ${bytes.length}\nSHA256: ${sha(bytes)}\n\n`);
    const runGpg = (args, input) => execFileSync("/usr/bin/gpg", ["--homedir", keydir, "--batch", "--no-tty", ...args],
      { input, stdio: ["pipe", "pipe", "pipe"] });
    runGpg(["--pinentry-mode", "loopback", "--passphrase", "", "--quick-generate-key", "Fixture <fixture@example.invalid>", "ed25519", "sign", "0"]);
    writeFileSync(keyring, runGpg(["--export"]));
    const index = "main/binary-amd64/Packages.gz";
    const release = runGpg(["--clearsign"], `Suite: noble\nCodename: noble\nSHA256:\n ${sha(packages)} ${packages.length} ${index}\n`);
    const base = "https://ppa.launchpadcontent.net/amd-team/xrt/ubuntu";
    const responses = new Map([[`${base}/dists/noble/InRelease`, release], [`${base}/dists/noble/${index}`, packages], [`${base}/${filename}`, bytes]]);
    const fetched = [];
    globalThis.fetch = async (url) => {
      const key = String(url); fetched.push(key);
      return responses.has(key) ? new Response(responses.get(key)) : new Response(null, { status: 404 });
    };
    const requirements = ["xrt-smi", "xclbinutil", "aiebu-asm", "aie-hsaco"].map((requestedName, n) => ({
      role: "tool", command: "find_program", requestedName, file: "CMakeLists.txt", line: n + 1,
      arguments: ["TOOL", requestedName], conditions: ["if(AIE_KERNEL_TOOLCHAIN)"],
    }));
    const options = { nativeSourceCache: cache, nativeDebRepositories: `${base}|noble|main|amd64|${keyring}`,
      nativeAcquire: true, nativeAcquireHosts: "ppa.launchpadcontent.net" };
    const cold = await acquireNativeEvidence(requirements, source, options);
    const providers = loadNativeExternalMetadata(cold.options);
    assert.equal(providers.length, 1);
    const [xrt] = providers;
    assert.equal(xrt.name, "libxrt-utils");
    assert.equal(xrt.version, "1:8.7-3");
    assert.equal(xrt.arch, "x64");
    assert.equal(xrt.packageSha256, sha(bytes));
    assert.deepEqual(xrt.exports.map(({ name, file }) => [name, file]), [["xclbinutil", "/usr/bin/xclbinutil"], ["xrt-smi", "/usr/bin/xrt-smi"]]);
    assert.deepEqual(fetched, [...responses.keys()]);
    const debEvidence = xrt.repositoryEvidence.artifact;
    assert.equal(debEvidence.url, `${base}/${filename}`);
    globalThis.fetch = () => { throw new Error("offline replay fetched"); };
    const warm = await acquireNativeEvidence(requirements, source, { ...options, nativeAcquire: false });
    assert.deepEqual(loadNativeExternalMetadata(warm.options), providers);
    writeFileSync(join(cache, "deb", debEvidence.path), Buffer.alloc(bytes.length));
    const changed = await acquireNativeEvidence(requirements, source, { ...options, nativeAcquire: false });
    assert.deepEqual(loadNativeExternalMetadata(changed.options), []);
    const unrelated = await acquireNativeEvidence(requirements.slice(2), source, options);
    assert.deepEqual(loadNativeExternalMetadata(unrelated.options), []);
  } finally { globalThis.fetch = original; rmSync(root, { recursive: true, force: true }); }
});
