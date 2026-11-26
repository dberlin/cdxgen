import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { posix } from "node:path";

import { nativeAcquisitionRemaining } from "./native-acquisition-policy.js";

const amdXrtArchive = "https://ppa.launchpadcontent.net/amd-team/xrt/ubuntu";
const xrtOwners = new Map([["xclbinutil", "libxrt-utils"], ["xrt-smi", "libxrt-utils"], ["aiebu-asm", "libxrt-utils-npu"]]);

/** Route only known package candidates from AMD's sparse archive. Actual
 * file membership must still be proved; a bundled tool keeps its DEB owner
 * without inheriting that package's version as its upstream version. */
export function nativeXrtDebPrograms(root, component, plan) {
  if (root === amdXrtArchive && component === "main") return plan.programs.filter((name) => xrtOwners.has(name));
}

export function nativeXrtDebOwner(program) {
  return xrtOwners.get(program);
}

const tarCompression = new Map([["tar", []], ["gz", ["-z"]], ["xz", ["-J"]], ["zst", ["--zstd"]]]);
const archiveError = () => new Error("Invalid Debian archive headers or member layout");

function debMembers(bytes) {
  if (bytes.toString("ascii", 0, 8) !== "!<arch>\n") throw archiveError();
  const members = new Map();
  for (let at = 8; at < bytes.length;) {
    const header = bytes.toString("ascii", at, at + 60);
    if (header.length !== 60 || !header.endsWith("`\n") || !/^\s*\d+\s*$/.test(header.slice(48, 58))) throw archiveError();
    const name = header.slice(0, 16).trim().replace(/\/$/, "");
    const size = Number(header.slice(48, 58));
    const start = at + 60; const end = start + size;
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(name) || members.has(name) || end > bytes.length || size % 2 && bytes[end] !== 0x0a) throw archiveError();
    members.set(name, bytes.subarray(start, end));
    if (members.size > 16) throw archiveError();
    at = end + size % 2;
  }
  if (members.get("debian-binary")?.toString("ascii") !== "2.0\n") throw archiveError();
  return members;
}

/** `bytes` have already matched size and SHA256 from the signed Packages
 * index. Only trusted tar reads member metadata or one control file to stdout. */
export function nativeDebArtifactMatches(bytes, expected, plan, deadline) {
  const members = debMembers(bytes);
  const tar = (part, args, maximum) => {
    const entries = [...members.keys()].filter((key) => key === `${part}.tar` || key.startsWith(`${part}.tar.`));
    if (entries.length !== 1) throw archiveError();
    const key = entries[0];
    const codec = tarCompression.get(key.split(".").at(-1));
    if (!codec) throw archiveError();
    return execFileSync("/usr/bin/tar", [...codec, ...args], { input: members.get(key), cwd: tmpdir(), encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", TZ: "UTC" }, timeout: nativeAcquisitionRemaining(deadline, 5000),
      maxBuffer: maximum, stdio: ["pipe", "pipe", "pipe"] });
  };
  const controlMembers = tar("control", ["-tf", "-"], 64 * 1024).split("\n").filter((path) => /^(?:\.\/)?control$/.test(path));
  if (controlMembers.length !== 1) throw archiveError();
  const control = tar("control", ["-xOf", "-", "--", controlMembers[0]], 64 * 1024);
  for (const key of ["Package", "Architecture", "Version"]) {
    const fields = [...control.matchAll(new RegExp(`^${key}: ([^\\s]+)$`, "gm"))];
    if (fields.length !== 1 || fields[0][1] !== expected[key]) throw new Error(`Debian artifact ${key} disagrees with signed Packages index`);
  }
  const found = new Map();
  const listing = tar("data", ["--quoting-style=escape", "--numeric-owner", "-tvf", "-"], 2 * 1024 * 1024);
  for (const line of listing.split("\n")) {
    const entry = /^(\S+)\s+\d+\/\d+\s+\d+\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+(?:\.\/)?([A-Za-z0-9_.+@/-]+)(?:$| -> ([A-Za-z0-9_.+@/-]+)$| link to [A-Za-z0-9_.+@/-]+$)/.exec(line);
    if (!entry) continue;
    const [, mode, path, link] = entry;
    if (path.split("/").some((part) => !part || part === "." || part === "..")) continue;
    found.set(path, found.has(path) ? undefined : { mode, link });
  }
  const regular = (path) => {
    const seen = new Set();
    while (path && !seen.has(path) && seen.size < 32) {
      seen.add(path);
      const member = found.get(path);
      if (member?.mode.startsWith("-")) return true;
      if (!member?.mode.startsWith("l") || !member.link || posix.isAbsolute(member.link)) return false;
      path = posix.normalize(posix.join(posix.dirname(path), member.link));
      if (path === ".." || path.startsWith("../")) return false;
    }
    return false;
  };
  const programs = new Set(plan.programs);
  const files = new Set(plan.files);
  const matches = new Map();
  for (const [path, member] of found) {
    const name = /(?:^|\/)(?:bin|sbin|libexec)\/(.+)$/.exec(path)?.[1];
    const leaf = posix.basename(path);
    const keys = [];
    if (programs.has(name) && member?.mode.startsWith("-") && /[xst]/.test(member.mode)) keys.push(name);
    if (files.has(leaf) && (!/\.(?:h|hpp|hxx)$/.test(leaf) || /(?:^|\/)include\//.test(path)) && regular(path)) keys.push(leaf);
    if (keys.length) matches.set(`/${path}`, keys);
  }
  return matches;
}
