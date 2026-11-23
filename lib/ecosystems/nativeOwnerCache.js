import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { hashRegularFile } from "../core/boundedFile.js";

export const nativeOwnerCacheDirectory = Symbol("operator-provided native owner cache directory");

function toolFingerprint() {
  // These are the source-evaluation modules, not the fresh intake/auth tail.
  // Their effect-producing helpers depend only on builtins and witnessed
  // source data. Expand this list if the evaluation seam gains another input.
  const toolRoot = fileURLToPath(new URL("../../", import.meta.url));
  const sources = ["./nativeProviderIndex.js", "./nativeOwnerCache.js", "./nativeOwnerObservations.js",
    "./nativeRegistryMetadata.js", "./nativeExternalMetadata.js", "../parsers/cmakeLists.js", "../core/boundedFile.js"];
  const build = createHash("sha256");
  for (const source of sources) {
    const file = fileURLToPath(new URL(source, import.meta.url));
    const sha = hashRegularFile(file, 4 * 1024 * 1024, toolRoot);
    if (!sha) return undefined;
    build.update(sha);
  }
  return build.digest("hex");
}

// Late pathname hashes alone could label already-loaded evaluator code as a
// new installation. Check the opted-in launch's observed bytes again before
// admitting writes. As with source, the operator must keep the tool fixed
// for the duration of the scan.
const launchSemantics = process.argv.slice(2, process.argv.indexOf("--") < 0 ? undefined : process.argv.indexOf("--"))
  .some((arg) => /^--(?:native-owner-evaluation-cache|nativeOwnerEvaluationCache)(?:=|$)/.test(arg)) ? toolFingerprint() : undefined;

export function prepareNativeOwnerCache(directory, scanRoot, onDecision, protectedPaths) {
  if (!launchSemantics || toolFingerprint() !== launchSemantics) return undefined;
  const store = openNativeOwnerCache(directory, scanRoot, protectedPaths);
  return store ? { store, semantics: launchSemantics, onDecision } : undefined;
}

/** Domain keys use the same lossless ordered value types as the store. */
export function nativeOwnerDigest(value) {
  try { return sha256(JSON.stringify(graph(value, false))).toString("hex"); }
  catch { return undefined; }
}
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_NODES = 200000;
const MAX_EDGES = 400000;
const MAX_DEPTH = 64;
const MAGIC = "COE2";
const HEADER = 40;
const SLOTS = 64;
const sha256 = (value) => createHash("sha256").update(value).digest();
const cacheKey = /^[a-f0-9]{64}$/;

function invalid() { throw new Error("Invalid owner evaluation cache record"); }
function graph(value, decoding) {
  const refs = new Map();
  const active = new Set();
  const heights = [];
  const referenceHeight = (atom) => Array.isArray(atom) && atom[0] === 2 ? heights[atom[1]] : 0;
  function height(row) {
    const [type, entries] = row;
    let largest = 0;
    for (const atom of entries) {
      if (type === "array" || type === "set") largest = Math.max(largest, 1 + referenceHeight(atom));
      else {
        largest = Math.max(largest, 1 + referenceHeight(atom[1]));
        if (type === "map") largest = Math.max(largest, 1 + referenceHeight(atom[0]));
      }
    }
    return largest;
  }
  const nodes = decoding ? value?.[1] : [];
  const strings = decoding ? value?.[2] : [];
  if (!Array.isArray(nodes) || nodes.length > MAX_NODES || !Array.isArray(strings) || strings.length > MAX_EDGES ||
    decoding && (!Array.isArray(value) || value.length !== 3 || !strings.every((item) => typeof item === "string"))) invalid();
  // Repeated long source paths and branch guards dwarf their unique bytes in
  // LLVM. An explicit string table keeps large records under the same cap.
  const stringIds = decoding ? undefined : new Map();
  let edges = 0;
  let bytes = 0;
  const string = (s) => {
    if (decoding) {
      if (!Number.isInteger(s) || s < 0 || s >= strings.length) invalid();
      return strings[s];
    }
    if (typeof s !== "string") invalid();
    if (stringIds.has(s)) return stringIds.get(s);
    if ((bytes += Buffer.byteLength(s)) > MAX_BYTES || strings.length >= MAX_EDGES) invalid();
    const id = strings.length;
    strings.push(s);
    stringIds.set(s, id);
    return id;
  };
  function node(input, depth) {
    if (depth > MAX_DEPTH || ++edges > MAX_EDGES) invalid();
    if (input === null || typeof input === "boolean") return input;
    if (!decoding && typeof input === "string") return [3, string(input)];
    if (typeof input === "number") {
      if (!Number.isFinite(input) || decoding && Object.is(input, -0)) invalid();
      return Object.is(input, -0) ? [1] : input;
    }
    if (decoding) {
      if (!Array.isArray(input)) invalid();
      if (input.length === 1 && input[0] === 0) return undefined;
      if (input.length === 1 && input[0] === 1) return -0;
      const id = input[1];
      if (input.length === 2 && input[0] === 3) return string(id);
      if (input.length !== 2 || input[0] !== 2 || !Number.isInteger(id) || id < 0 || id >= nodes.length || active.has(id)) invalid();
      if (refs.has(id)) {
        if (depth + heights[id] > MAX_DEPTH) invalid();
        return refs.get(id);
      }
      const row = nodes[id];
      if (!Array.isArray(row) || row.length !== 2 || !Array.isArray(row[1])) invalid();
      const [type, items] = row;
      active.add(id);
      let output;
      if (type === "array") output = items.map((item) => node(item, depth + 1));
      else if (type === "set") {
        output = new Set(items.map((item) => node(item, depth + 1)));
        if (output.size !== items.length) invalid();
      } else if (type === "map" || type === "object") {
        output = type === "map" ? new Map() : {};
        for (const item of items) {
          if (!Array.isArray(item) || item.length !== 2) invalid();
          if (type === "map") {
            const key = node(item[0], depth + 1);
            if (output.has(key)) invalid();
            output.set(key, node(item[1], depth + 1));
          } else {
            const key = string(item[0]);
            if (Object.hasOwn(output, key)) invalid();
            Object.defineProperty(output, key, { value: node(item[1], depth + 1), enumerable: true, writable: true, configurable: true });
          }
        }
      } else invalid();
      heights[id] = height(row);
      refs.set(id, output);
      active.delete(id);
      return output;
    }
    if (input === undefined) return [0];
    if (typeof input !== "object" || active.has(input)) invalid();
    if (refs.has(input)) {
      const id = refs.get(input);
      if (depth + heights[id] > MAX_DEPTH) invalid();
      return [2, id];
    }
    if (nodes.length >= MAX_NODES) invalid();
    const id = nodes.length;
    const proto = Object.getPrototypeOf(input);
    refs.set(input, id);
    nodes.push(null);
    active.add(input);
    if (proto === Map.prototype) nodes[id] = ["map", Array.from(Map.prototype.entries.call(input), ([key, val]) => [node(key, depth + 1), node(val, depth + 1)])];
    else if (proto === Set.prototype) nodes[id] = ["set", Array.from(Set.prototype.values.call(input), (val) => node(val, depth + 1))];
    else if (proto === Array.prototype) {
      if (input.length > MAX_EDGES - edges || Reflect.ownKeys(input).length !== input.length + 1) invalid();
      nodes[id] = ["array", Array.from({ length: input.length }, (_item, index) => node(ownValue(input, index), depth + 1))];
    } else if (proto === Object.prototype) {
      nodes[id] = ["object", Reflect.ownKeys(input).map((key) => [string(key), node(ownValue(input, key), depth + 1)])];
    } else invalid();
    heights[id] = height(nodes[id]);
    active.delete(input);
    return [2, id];
  }
  if (decoding) {
    const result = node(value[0], 0);
    if (refs.size !== nodes.length) invalid();
    return result;
  }
  return [node(value, 0), nodes, strings];
}

function ownValue(input, key) {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) invalid();
  return descriptor.value;
}

function contains(parent, child) {
  const path = relative(parent, child);
  return path === "" || !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
}

const overlap = (first, second) => contains(first, second) || contains(second, first);
// Conservative across case-folding filesystems and Unicode path normalization.
const folded = (path) => path.normalize("NFC").toLowerCase();

function containsInode(path, target) {
  for (;;) {
    try {
      const stat = lstatSync(path, { bigint: true });
      if (stat.dev === target.dev && stat.ino === target.ino) return true;
    } catch (error) { if (error?.code !== "ENOENT") throw error; }
    const parent = dirname(path);
    if (parent === path) return false;
    path = parent;
  }
}

function mountsInNamespace() {
  const fd = openSync("/proc/self/mountinfo", constants.O_RDONLY);
  try {
    const input = Buffer.allocUnsafe(1024 * 1024);
    let length = 0;
    while (length < input.length) {
      const read = readSync(fd, input, length, input.length - length, null);
      if (!read) break;
      length += read;
    }
    if (length === input.length) return undefined;
    const unescape = (path) => path.replace(/\\([0-7]{3})/g, (_whole, code) => String.fromCharCode(Number.parseInt(code, 8)));
    const mounts = input.toString("utf8", 0, length).trimEnd().split("\n").map((line) => {
      const [, , device, root, at] = line.split(" ", 5);
      return { device, root: unescape(root), at: unescape(at) };
    });
    return mounts.sort((first, second) => second.at.length - first.at.length);
  } finally { closeSync(fd); }
}

function overlapsMounted(root, protectedPaths) {
  const mounts = mountsInNamespace();
  if (!mounts?.length) return true;
  const identities = (path) => {
    const parents = mounts.filter(({ at }) => contains(at, path));
    if (!parents.length) return undefined;
    // If mounts are stacked at the same pathname, reject overlap with any
    // possible visible projection rather than betting on mount-ID ordering.
    return [...parents.filter(({ at }) => at === parents[0].at).map(({ device, root, at }) => [device, join(root, relative(at, path))]),
      ...mounts.filter(({ at }) => contains(path, at)).map(({ device, root }) => [device, root])];
  };
  const cache = identities(root);
  if (!cache) return true;
  return protectedPaths.some((path) => {
    const protectedIds = identities(path);
    return !protectedIds || cache.some(([device, file]) =>
      protectedIds.some(([inputDevice, input]) => device === inputDevice && overlap(folded(file), folded(input))));
  });
}

function readSlot(path, uid) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o777) !== 0o600 || stat.size < HEADER || stat.size > MAX_BYTES) return;
      if (!stat.nlink) continue; // Atomic replacement after open; retry once.
      if (stat.nlink !== 1) return;
      const buffer = Buffer.allocUnsafe(stat.size + 1);
      let at = 0;
      while (at < buffer.length) {
        const length = readSync(fd, buffer, at, buffer.length - at, at);
        if (!length) break;
        at += length;
      }
      if (at !== stat.size || buffer.toString("ascii", 0, 4) !== MAGIC || buffer.readUInt32BE(4) !== stat.size - HEADER) return;
      const body = buffer.subarray(HEADER, stat.size);
      if (!sha256(body).equals(buffer.subarray(8, HEADER))) return;
      return graph(JSON.parse(body.toString("utf8")), true);
    } catch { return undefined; }
    finally { if (fd !== undefined) closeSync(fd); }
  }
}

/** Use an existing private directory. No cache writes are admitted under the scan tree. */
export function openNativeOwnerCache(root, scanRoot, protectedPaths = []) {
  if (process.platform !== "linux" || typeof root !== "string" || !isAbsolute(root) ||
    !constants.O_NOFOLLOW || !constants.O_NONBLOCK || typeof process.getuid !== "function") return undefined;
  const uid = process.getuid();
  root = resolve(root);
  scanRoot = resolve(scanRoot);
  try {
    const confined = [resolve(scanRoot), realpathSync(scanRoot)];
    for (const input of protectedPaths) if (typeof input === "string" && input) {
      const path = resolve(input);
      confined.push(path);
      try { confined.push(realpathSync(path)); } catch (error) { if (error?.code !== "ENOENT") return undefined; }
    }
    const rootInode = lstatSync(root, { bigint: true });
    if (confined.some((source) => {
      if (overlap(folded(source), folded(root)) || containsInode(source, rootInode)) return true;
      try { return containsInode(root, lstatSync(source, { bigint: true })); }
      catch (error) { if (error?.code !== "ENOENT") throw error; return false; }
    }) || overlapsMounted(root, confined)) return undefined;
    for (let path = root; ; path = dirname(path)) {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || (path === root ? stat.uid !== uid || (stat.mode & 0o777) !== 0o700 :
        stat.uid !== 0 && stat.uid !== uid || (stat.mode & 0o022))) return undefined;
      if (dirname(path) === path) break;
    }
  } catch { return undefined; }
  const slot = (key) => join(root, `owner-${Number.parseInt(key.slice(0, 2), 16) % SLOTS}`);
  return {
    read(key) {
      if (typeof key !== "string" || !cacheKey.test(key)) return undefined;
      const result = readSlot(slot(key), uid);
      return Array.isArray(result) && result.length === 2 && result[0] === key ? result[1] : undefined;
    },
    write(key, record) {
      if (typeof key !== "string" || !cacheKey.test(key)) return false;
      const path = slot(key);
      const temporary = `${path}.tmp`;
      let fd;
      let created = false;
      try {
        const body = Buffer.from(JSON.stringify(graph([key, record], false)));
        if (body.length + HEADER > MAX_BYTES) return false;
        const header = Buffer.allocUnsafe(HEADER);
        header.write(MAGIC, 0, 4, "ascii");
        header.writeUInt32BE(body.length, 4);
        sha256(body).copy(header, 8);
        fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        created = true;
        // Fixed slots never replace arbitrary existing files, even when the
        // operator pointed the cache at a private directory containing data.
        try {
          lstatSync(path);
          const previous = readSlot(path, uid);
          if (!Array.isArray(previous) || previous.length !== 2 || !cacheKey.test(previous[0])) return false;
        } catch (error) { if (error?.code !== "ENOENT") return false; }
        writeFileSync(fd, header);
        writeFileSync(fd, body);
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        renameSync(temporary, path);
        created = false;
        return true;
      } catch { return false; }
      finally {
        if (fd !== undefined) try { closeSync(fd); } catch { /* Cache maintenance is optional. */ }
        if (created) try { unlinkSync(temporary); } catch { /* Do not remove another writer's file. */ }
      }
    },
  };
}
