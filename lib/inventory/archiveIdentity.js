/**
 * Read an identity explicitly encoded in a download location. This is the
 * declared source/archive pin, not evidence that a conditional download ran.
 * Query parameters, timestamps and a bare checksum do not name releases.
 */
export function archiveIdentity(location) {
  let url;
  try { url = new URL(location); } catch { return undefined; }
  if (!["https:", "http:", "ftp:"].includes(url.protocol)) return undefined;
  const parts = url.pathname.split("/").filter(Boolean);
  const filename = parts.at(-1) || "";
  const stem = filename.replace(/\.(tar\.gz|tar\.bz2|tar\.xz|tgz|zip|tar)$/i, "");
  const isGitArchive = parts.includes("+archive") || parts.includes("archive");
  if (isGitArchive && /^[0-9a-f]{40,64}$/i.test(stem)) {
    return { version: stem, kind: "source-revision" };
  }
  // Some binary archives are indexed by the immutable build revision in their
  // parent directory rather than in the filename. Do not call that a release.
  const parent = parts.at(-2);
  if (/^[0-9a-f]{40,64}$/i.test(parent || "")) {
    return { version: parent, kind: "archive-revision" };
  }
  if (stem.startsWith("sqlite-amalgamation-") && /^\d{7}$/.test(stem.slice("sqlite-amalgamation-".length))) {
    const encoded = stem.slice("sqlite-amalgamation-".length);
    const values = [encoded[0], encoded.slice(1, 3), encoded.slice(3, 5), encoded.slice(5, 7)].map(Number);
    if (!values[3]) values.pop();
    return { version: values.join("."), kind: "release" };
  }
  const lastDash = stem.lastIndexOf("-");
  const suffix = stem.slice(lastDash + 1).replace(/^v(?=\d)/, "");
  if (/^\d+(?:\.\d+)+(?:[+_~][0-9A-Za-z.]+)?$/.test(suffix)) {
    return { version: suffix, kind: "release" };
  }
  if (lastDash > 0 && /^[0-9a-f]{7,64}$/i.test(suffix) && /[a-f]/i.test(suffix)) {
    return { version: suffix, kind: "source-revision" };
  }
  return undefined;
}
