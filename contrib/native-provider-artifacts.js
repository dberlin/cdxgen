import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, readSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

import { openRegularFile } from "../lib/core/boundedFile.js";
import { nativeRegistryRecipeFacts } from "../lib/ecosystems/nativeRegistryMetadata.js";
import { parseCmakeCommands } from "../lib/parsers/cmakeLists.js";
import { fetchNativeAcquisitionBytes, nativeAcquisitionRemaining } from "./native-acquisition-policy.js";

const hash = (bytes, algorithm = "sha256") => createHash(algorithm).update(bytes).digest("hex");
const value = (args, key) => { const at = args.indexOf(key); return at < 0 ? undefined : args[at + 1]; };
const literal = (text) => typeof text === "string" && !/[\s$@]/.test(text);

export function nativeProviderArtifactUrls(artifact) {
  const args = artifact.arguments;
  const repo = value(args, "REPO"); const ref = artifact.revision;
  if (artifact.command === "vcpkg_from_github" && /^[\w.+-]+\/[\w.+-]+$/.test(repo || "") && literal(ref)) return [`https://github.com/${repo}/archive/${encodeURIComponent(ref)}.tar.gz`];
  if (artifact.command === "vcpkg_from_gitlab" && /^[\w.+/-]+$/.test(repo || "") && literal(ref)) {
    const host = value(args, "GITLAB_URL") || "https://gitlab.com";
    return [`${host}/${repo}/-/archive/${encodeURIComponent(ref)}/${repo.split("/").at(-1)}-${ref.replaceAll("/", "-")}.tar.gz`];
  }
  if (artifact.command === "vcpkg_from_sourceforge" && /^[\w.+-]+\/[\w.+/-]+$/.test(repo || "") && literal(ref)) {
    const filename = value(args, "FILENAME");
    if (literal(filename)) return [`https://sourceforge.net/projects/${repo.split("/")[0]}/files/${repo.split("/").slice(1).join("/")}/${ref}/${filename}/download`];
  }
  if (artifact.command === "vcpkg_download_distfile" && !/LICENSE|COPYRIGHT/i.test(args[0] || "")) {
    const at = args.indexOf("URLS"); const urls = [];
    for (const arg of args.slice(at + 1)) { if (!/^https:\/\//.test(arg)) break; if (literal(arg)) urls.push(arg); }
    return at >= 0 ? urls.slice(0, 3) : [];
  }
  return [];
}

async function download(url, deadline, allowedHosts) {
  return (await fetchNativeAcquisitionBytes(url, { deadline, allowedHosts })).bytes;
}

/** Download only hash-identified source archives, then list/read metadata to
 * stdout. Never extract to a source directory or execute any source/build code. */
export async function acquireNativeProviderSourceMetadata({ record, recipe, usage, files, recipePath, output, writer, fetch: network, deadline, allowedHosts }) {
  const facts = nativeRegistryRecipeFacts(record, recipe, files, recipePath);
  const metadata = []; const failures = [];
  const wantedHeaders = new Set(parseCmakeCommands(usage || "").filter((c) => c.name === "find_path").flatMap((c) => c.args.slice(1).filter((a) => /^[A-Za-z0-9_.+-]+\.(?:h|hpp)$/.test(a))));
  const command = (binary, args, maxBuffer) => {
    const timeout = nativeAcquisitionRemaining(deadline);
    return execFileSync(binary, args, { cwd: tmpdir(), env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, encoding: "utf8", timeout, maxBuffer, stdio: ["ignore", "pipe", "pipe"] });
  };
  for (const artifact of facts.artifacts.slice(0, 4)) {
    if (!/^[a-f0-9]{128}$/i.test(artifact.sha512 || "")) continue;
    const urls = nativeProviderArtifactUrls(artifact);
    if (!urls.length) continue;
    const suffix = /\.zip(?:\/download)?$/.test(urls[0]) ? ".zip" : ".tar";
    const archivePath = `source-artifacts/${artifact.sha512}${suffix}`;
    let bytes;
    try {
      // A bounded regular-file binary read; the archive is never interpreted
      // before its complete original recipe SHA512 has matched.
      const opened = openRegularFile(join(output, archivePath), output);
      if (opened) {
        try {
          if (opened.size <= 64 * 1024 * 1024) {
            const buffer = Buffer.alloc(opened.size); let offset = 0;
            while (offset < buffer.length) { const count = readSync(opened.fd, buffer, offset, buffer.length - offset, offset); if (!count) break; offset += count; }
            if (offset === buffer.length) bytes = buffer;
          }
        } finally { closeSync(opened.fd); }
      }
      if (!bytes && network) {
        let last;
        for (const url of urls) {
          try { const candidate = await download(url, deadline, allowedHosts); if (hash(candidate, "sha512") !== artifact.sha512.toLowerCase()) throw new Error("Source archive SHA512 mismatch"); bytes = candidate; break; }
          catch (error) { last = error; }
        }
        if (!bytes) throw last || new Error("No source artifact available");
      }
      if (!bytes) throw new Error("Missing hash-identified source archive; explicit --fetch required");
      if (hash(bytes, "sha512") !== artifact.sha512.toLowerCase()) throw new Error("Source archive SHA512 mismatch");
      writer.write(archivePath, bytes);
      const archive = join(output, archivePath);
      const listing = suffix === ".zip" ? command("/usr/bin/unzip", ["-Z1", archive], 8 * 1024 * 1024) : command("/usr/bin/tar", ["-tf", archive], 8 * 1024 * 1024);
      const members = listing.split(/\r?\n/).filter((path) => path && !path.startsWith("/") && !path.split("/").includes("..") && !/[\x00-\x1f*?\[\]]/.test(path));
      const selected = members.filter((path) => !/(?:^|\/)(?:tests?|examples?|third[-_]party|subprojects)(?:\/|$)/i.test(path) &&
        (/\.pc\.in$/.test(path) || wantedHeaders.has(basename(path)) || ["CMakeLists.txt", "meson.build"].includes(basename(path))))
        .sort((a, b) => Number(!a.endsWith(".pc.in")) - Number(!b.endsWith(".pc.in")) || a.split("/").length - b.split("/").length).slice(0, 64);
      for (const member of selected) {
        const content = suffix === ".zip" ? command("/usr/bin/unzip", ["-p", archive, member], 1024 * 1024) : command("/usr/bin/tar", ["-xOf", archive, "--", member], 1024 * 1024);
        if (!content) continue;
        const path = `source-metadata/${artifact.sha512}/${member}`;
        writer.write(path, content);
        metadata.push({ content, descriptor: { path, sha256: hash(content) } });
      }
      const evidence = JSON.stringify({ schema: 1, archivePath, sourceSha512: artifact.sha512, acquisitionUrls: urls, members }, null, 2);
      const path = `source-metadata/${artifact.sha512}/archive-manifest.json`;
      writer.write(path, `${evidence}\n`);
      metadata.push({ content: `${evidence}\n`, descriptor: { path, sha256: hash(`${evidence}\n`) } });
    } catch (error) { failures.push({ name: record.name, sourceSha512: artifact.sha512, urls, prerequisite: String(error.message).split("\n")[0] }); }
  }
  return { metadata, failures };
}
