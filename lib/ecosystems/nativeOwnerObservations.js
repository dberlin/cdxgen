import { createHash } from "node:crypto";
import { closeSync, lstatSync, opendirSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { openRegularFile } from "../core/boundedFile.js";

const MAX_METADATA = 512 * 1024;
const MAX_OBSERVATIONS = 4096;
const MAX_LISTING_ROWS = 65536;
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_PATH = 4096;
const PREFIX = 256;
const KINDS = new Set(["text", "directory", "realpath", "payload", "mode"]);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const absent = (error) => error?.code === "ENOENT" || error?.code === "ENOTDIR";
const unsupported = Symbol("unsupported owner observation");

function permits(root, file) {
  if (typeof file !== "string" || file.length > MAX_PATH || file.includes("\0") || !isAbsolute(file) || resolve(file) !== file) return false;
  const path = relative(root, file);
  return !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
}

// The evaluator already requires an operator-provided immutable view for this
// opt-in. Noncanonical paths and unclassified IO failures are not receipts.
function material(root, file, prefix, budget) {
  const stat = lstatSync(file);
  if (!stat.isFile() || realpathSync(file) !== file) return unsupported;
  if (!prefix && stat.size > MAX_METADATA) return { signature: "oversize", value: undefined };
  const length = prefix ? Math.min(PREFIX, stat.size) : stat.size;
  if ((budget.bytes += length) > MAX_SOURCE_BYTES) return unsupported;
  const opened = openRegularFile(file, root);
  if (!opened) return unsupported;
  try {
    if (stat.size !== opened.size) return unsupported;
    const buffer = Buffer.allocUnsafe(length);
    for (let offset = 0; offset < buffer.length;) {
      const length = readSync(opened.fd, buffer, offset, buffer.length - offset, offset);
      if (!length) return unsupported;
      offset += length;
    }
    return { signature: hash(buffer), value: buffer.toString("utf8") };
  } finally { closeSync(opened.fd); }
}

function listing(entries) {
  if (entries.length > MAX_LISTING_ROWS) return unsupported;
  const listing = [];
  for (const entry of entries) {
    const type = entry.isFile() ? "file" : entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : undefined;
    if (!type) return unsupported;
    listing.push([type, entry.name]);
  }
  return hash(JSON.stringify(listing));
}

function observe(root, owner, kind, file, budget) {
  if (!permits(root, file) || kind === "payload" && !permits(owner, file)) return unsupported;
  try {
    if (kind === "text" || kind === "payload") return material(kind === "text" ? root : owner, file, kind === "payload", budget);
    if (realpathSync(file) !== file) return unsupported;
    if (kind === "realpath") return { signature: true, value: file };
    if (kind === "mode") {
      const stat = lstatSync(file);
      const bits = stat.mode & 0o111;
      return stat.isFile() ? { signature: bits, value: bits } : unsupported;
    }
    if (kind !== "directory") return unsupported;
    const entries = [];
    const directory = opendirSync(file);
    try {
      for (let entry; (entry = directory.readSync());) {
        if (++budget.rows > MAX_LISTING_ROWS) return unsupported;
        entries.push(entry);
      }
    } finally { directory.closeSync(); }
    const signature = listing(entries);
    return signature === unsupported ? unsupported : { signature, value: signature };
  } catch (error) {
    return absent(error) ? { signature: null, value: undefined } : unsupported;
  }
}

export function canonicalOwnerScanRoot(root) {
  try { return realpathSync(root) === root; } catch { return false; }
}

export function captureOwnerReads(root, owner) {
  const seen = new Set();
  const reads = [];
  const budget = { rows: 0, bytes: 0 };
  let reason;
  function capture(kind, file, value) {
    if (reason) return;
    const id = `${kind}\0${file}`;
    if (seen.has(id)) return;
    if (reads.length >= MAX_OBSERVATIONS) { reason = "observation-budget"; return; }
    seen.add(id);
    const observed = observe(root, owner, kind, file, budget);
    if (observed === unsupported || observed.value !== value) { reason = `unobserved-${kind}`; return; }
    reads.push([kind, file, observed.signature]);
  }
  return {
    capture,
    directory(file, entries, error) {
      if (reason) return;
      if (error && !absent(error)) { reason = "unobserved-directory"; return; }
      capture("directory", file, entries === undefined ? undefined : listing(entries));
    },
    block(cause) { reason ||= cause; },
    get reason() { return reason; },
    get reads() { return reads; },
  };
}

// Return only scratch metadata additions. Checking a stale record cannot
// modify the real collector's memo, even if several prefixes matched.
export function validateOwnerReads(root, owner, reads, files, sourceTexts) {
  if (!Array.isArray(reads) || !reads.length || reads.length > MAX_OBSERVATIONS) return undefined;
  const metadata = new Map();
  const seen = new Set();
  const budget = { rows: 0, bytes: 0 };
  for (const row of reads) {
    if (!Array.isArray(row) || row.length !== 3) return undefined;
    const [kind, file, signature] = row;
    if (!KINDS.has(kind) || !permits(root, file)) return undefined;
    const id = `${kind}\0${file}`;
    if (seen.has(id)) return undefined;
    seen.add(id);
    const observed = observe(root, owner, kind, file, budget);
    if (observed === unsupported || signature !== observed.signature) return undefined;
    if (kind === "text") {
      if (files.has(file) ? files.get(file) !== observed.value : sourceTexts?.has(file) && sourceTexts.get(file) !== observed.value) return undefined;
      if (!files.has(file)) metadata.set(file, observed.value);
    }
  }
  return metadata;
}
