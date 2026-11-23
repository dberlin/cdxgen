import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, readSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openRegularFile, readRegularTextFile } from "../lib/core/boundedFile.js";
import { nativeProviderCacheWriter } from "./native-provider-cache.js";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function windowsGitReleaseAsset(release) {
  const version = /^v(\d+(?:\.\d+)+\.windows\.\d+)$/.exec(release?.tag_name || "")?.[1];
  if (!version || release.draft || release.prerelease) return undefined;
  const filename = `MinGit-${version.replace(".windows.", ".")}-64-bit.zip`;
  const asset = release.assets?.find((item) => item.name === filename && item.size > 0 && item.size <= 64 * 1024 * 1024 && /^sha256:[a-f0-9]{64}$/i.test(item.digest || ""));
  return asset ? { version, asset } : undefined;
}

async function fetchBytes(url, maxBytes, deadline) {
  let current = new URL(url); let fromGitHub = false;
  for (let count = 0; count < 6; count++) {
    const trusted = current.hostname === "api.github.com" && current.pathname.startsWith("/repos/git-for-windows/git/releases/") ||
      current.hostname === "github.com" && current.pathname.startsWith("/git-for-windows/git/releases/download/") ||
      current.hostname === "release-assets.githubusercontent.com" && fromGitHub;
    if (!trusted || current.protocol !== "https:" || current.username || current.password) throw new Error("Unapproved Windows Git metadata URL");
    const remaining = Math.min(45000, deadline - Date.now());
    if (remaining <= 0) throw new Error("Windows Git acquisition deadline exceeded");
    const response = await fetch(current, { redirect: "manual", credentials: "omit", signal: AbortSignal.timeout(remaining), headers: { Accept: "application/vnd.github+json" } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = response.headers.get("location"); await response.body?.cancel();
      if (!next) throw new Error("Missing artifact redirect"); fromGitHub = current.hostname === "github.com"; current = new URL(next, current); continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Windows Git HTTP ${response.status}`); }
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.byteLength; if (size > maxBytes) throw new Error("Windows Git metadata size limit exceeded"); chunks.push(chunk); }
    return Buffer.concat(chunks);
  }
  throw new Error("Too many Windows Git redirects");
}

function binary(path, root) {
  const opened = openRegularFile(path, root); if (!opened) return undefined;
  try {
    if (opened.size > 64 * 1024 * 1024) return undefined;
    const bytes = Buffer.alloc(opened.size); let offset = 0;
    while (offset < bytes.length) { const count = readSync(opened.fd, bytes, offset, bytes.length - offset, offset); if (!count) break; offset += count; }
    return offset === bytes.length ? bytes : undefined;
  } finally { closeSync(opened.fd); }
}

async function main(args) {
  const options = new Map();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--fetch") options.set(args[i], true);
    else if (["--output", "--source-root", "--release"].includes(args[i]) && args[i + 1]) options.set(args[i], args[++i]);
    else throw new Error(`Unknown argument ${args[i]}`);
  }
  if (!options.get("--output")) throw new Error("Usage: bun contrib/native-windows-git-provider-cache.js --output external-cache [--source-root source] [--release vX.Y.Z.windows.N] [--fetch]");
  const output = resolve(options.get("--output")); const writer = nativeProviderCacheWriter(output, options.get("--source-root"));
  const deadline = Date.now() + 5 * 60 * 1000;
  const tag = options.get("--release");
  if (tag && !/^v\d+(?:\.\d+)+\.windows\.\d+$/.test(tag)) throw new Error("Windows Git release must be a concrete release tag");
  const url = `https://api.github.com/repos/git-for-windows/git/releases/${tag ? `tags/${tag}` : "latest"}`;
  let releaseText = readRegularTextFile(join(output, "release.json"), 2 * 1024 * 1024, output);
  if ((!releaseText || tag && JSON.parse(releaseText).tag_name !== tag) && options.has("--fetch")) releaseText = (await fetchBytes(url, 2 * 1024 * 1024, deadline)).toString("utf8");
  if (!releaseText) throw new Error("Missing frozen release metadata; explicit --fetch required");
  const release = JSON.parse(releaseText); const selected = windowsGitReleaseAsset(release);
  if (!selected || tag && release.tag_name !== tag) throw new Error("No concrete hash-identified Windows Git package for the release");
  const { version, asset } = selected;
  writer.write("release.json", releaseText);
  let archive = binary(join(output, asset.name), output);
  if (!archive && options.has("--fetch")) archive = await fetchBytes(asset.browser_download_url, 64 * 1024 * 1024, deadline);
  if (!archive || hash(archive) !== asset.digest.slice(7).toLowerCase()) throw new Error("Missing Windows Git package or SHA256 mismatch");
  writer.write(asset.name, archive);
  const list = execFileSync("/usr/bin/unzip", ["-Z1", join(output, asset.name)], { cwd: tmpdir(), env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, encoding: "utf8", timeout: 10000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  const paths = list.split(/\r?\n/).filter(Boolean);
  const executables = paths.filter((path) => /(?:^|\/)(?:cmd|bin)\/git\.exe$/i.test(path) && !path.split("/").includes(".."));
  if (!executables.length) throw new Error("Verified package does not actually contain Git executables");
  const fileList = `${JSON.stringify({ package: asset.name, version, sha256: hash(archive), files: paths }, null, 2)}\n`;
  writer.write("files.json", fileList);
  const snapshot = `${JSON.stringify({ schema: 1, name: "git-for-windows", versionKind: "release", version, platform: "win32", arch: "x64",
    repository: "https://github.com/git-for-windows/git", exports: [{ kind: "tool", name: "git" }],
    conditions: ["available-package-not-installed", ...executables.map((path) => `executable:${path}`)],
    evidence: [{ path: "release.json", sha256: hash(releaseText) }, { path: "files.json", sha256: hash(fileList) }] }, null, 2)}\n`;
  writer.write("snapshot.json", snapshot);
  writer.write("native-provider-metadata.json", `${JSON.stringify({ schema: 1, providers: [{ metadata: { path: "snapshot.json", format: "provider-snapshot", sha256: hash(snapshot) } }] }, null, 2)}\n`);
  console.log(JSON.stringify({ manifest: join(output, "native-provider-metadata.json"), version, packageSha256: hash(archive), executables, selected: false }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
